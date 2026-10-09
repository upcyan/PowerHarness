const http = require('node:http');
const sseProxy = require('./sse-proxy');
const unavailablePage = require('./unavailable-page');
const wsUpgrade = require('./ws-upgrade');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const selfsigned = require('selfsigned');
const ops = require('./ops.js');
const cores = require('./core-manager.js');
const profiles = require('./profiles.js');
const diagnostics = require('./diagnostics.js');
const managementUi = require('./management-page.js');
const diagnosticsUi = require('./diagnostics-page.js');
const automaticBackups = require('./automatic-backup-policy.js');
const actions = require('./actions.js');   // action 白名单的唯一来源（见该文件头注释）
let yamlModule = null;
try { yamlModule = require('yaml'); } catch { /* NODE_PATH 未含 runtime 时降级 */ }
// 上游 4xx 日志聚合（0.3.61）：插件缺失时同一路由每 60s 刷一条 404，一小时
// 就是 60 条同质噪音。同 key（方法+路径+状态）5 分钟内只记首条。
const httpErrorLogAt = new Map();
const network = require('./network.js');
const grants = require('./grants.js');
const dockerAccess = require('./docker-access.js');
const pluginPaths = require('./plugin-paths.js');
const { createNetworkDebug } = require('./network-debug.js');
const debugCommands = require('./network-debug-commands.js');

const dataDir = process.env.FNOS_DATA_DIR;
const guideSocket = process.env.GUIDE_SOCKET;
const manifestPort = Number(process.env.FNOS_PORT || 3080);
let upstreamPort = Number(process.env.DSH_PORT || 3081);
let publicPort = ops.portSettings(dataDir).publicPort || manifestPort;
// 早期捕获器（0.3.62）：注入到代理的 DSH 页面 <head> 最前，必须在客户端任何
// 模块加载之前执行 —— 框架常在 import 时就 console.error.bind(console) 捕获原引用，
// 父页面事后包装完全看不到（实测：slot 重复注册的 componentDidCatch 日志父页全盲、
// 客户端覆盖 win.onerror 后未捕获错误也盲）。捕获优先实时回调父页 __dshIframeLog，
// 钩子还没装上时排队 __dshEarlyLogs，由父页 attach 时倒出。
const earlyCaptureScript = require('./connection-diagnostics').script + `<script>(function(){
  if (window.__dshEarlyCapture) return;
  window.__dshEarlyCapture = true;
  var q = window.__dshEarlyLogs = window.__dshEarlyLogs || [];
  var push = function (kind, parts) {
    try {
      var text = Array.prototype.map.call(parts, function (p) {
        if (p instanceof Error) return p.stack || p.message;
        if (p && typeof p === 'object' && (p.stack || p.message)) return p.stack || p.message;   // 跨 bundle 的 Error 过不了 instanceof
        if (typeof p === 'string') return p;
        try { return JSON.stringify(p); } catch (e) { return String(p); }
      }).join(' ');
      var delivered = false;
      try {
        if (window.parent && window.parent.__dshIframeLog) { window.parent.__dshIframeLog(kind, text); delivered = true; }
      } catch (e) {}
      if (!delivered) { q.push([kind, text]); if (q.length > 120) q.splice(0, q.length - 120); }
    } catch (e) {}
  };
  ['log','info','warn','error'].forEach(function (k) {
    var orig = console[k] ? console[k].bind(console) : function () {};
    console[k] = function () { push(k, arguments); orig.apply(null, arguments); };
  });
  window.addEventListener('error', function (ev) { push('error', ['未捕获错误:', ev.message, ev.filename ? ev.filename + ':' + ev.lineno + ':' + ev.colno : '']); });
  window.addEventListener('unhandledrejection', function (ev) { push('error', ['未处理的 Promise 拒绝:', ev.reason]); });
})();</script>`;
let publicServer = null;
let aliasServer = null;
let guideServer = null;   // 模块级（0.3.62）：main().catch 的失败清理要引用它
let tlsOptions = null;
process.on('message', (message) => {
  if (message?.type === 'core-port' && Number.isInteger(message.port) && message.port >= 1024 && message.port <= 65535) upstreamPort = message.port;
  else if (message?.type === 'public-port' && Number.isInteger(message.port) && message.port >= 1024 && message.port <= 65535) {
    applyPublicPort(message.port, (error) => {
      if (process.send) process.send({ type: 'public-port-result', id: message.id, ok: !error, error: error?.message || null });
    });
  }
});

// Bind the effective public port; when it differs from the manifest port,
// also try to keep a compatibility listener on the manifest port so fnOS
// port checks and existing bookmarks keep working (best effort).
// Bind the effective public port; when it differs from the manifest port,
// also try to keep a compatibility listener on the manifest port so fnOS
// port checks and existing bookmarks keep working (best effort).
//
// 启动期绑定重试（0.3.61，P4）：supervisor 在 gateway 退出后 1 秒就重启，
// 而旧进程的监听套接字可能仍处于 TIME_WAIT / 尚未释放 —— 此时 bind 抛
// EADDRINUSE，main() 直接 reject ⇒ 进程 exit(1) ⇒ supervisor 再重启……形成
// 「重启太快反而反复失败」的竞态（uncaughtException 兜底覆盖不到 Promise rejection）。
// 这里对 EADDRINUSE 做有限退避重试（共 ~4.6 秒），跨越那个关闭窗口。
function serveHttps(port) {
  const maxAttempts = 6;
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const server = https.createServer(tlsOptions, handlePublic);
      server.on('upgrade', handleUpgrade);
      const onError = (error) => {
        server.removeListener('listening', onListening);
        server.close(() => {});
        if (error.code === 'EADDRINUSE' && n < maxAttempts) {
          const delay = 150 * n;
          log('public_listen_retry', { port, attempt: n, delayMs: delay, code: error.code });
          setTimeout(() => attempt(n + 1), delay);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        server.on('error', (error) => log('public_listen_error', { port, code: error.code }));
        resolve(server);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    };
    attempt(1);
  });
}

async function applyPublicPort(port, callback) {
  try {
    if (port === publicPort) { callback(null); return; }
    if (port === manifestPort) {
      // Moving back to the manifest port: the compatibility listener already
      // holds it, so promote that one instead of rebinding over ourselves —
      // binding first would race the listener we are about to retire.
      const retiring = publicServer;
      publicPort = port;
      publicServer = aliasServer;
      aliasServer = null;
      retiring?.close();
      log('public_port_changed', { port, manifestPort, alias: false });
      callback(null);
      return;
    }
    // Custom port: bind it first, then retire the old public listener. The
    // compatibility listener on the manifest port (if one exists) keeps
    // serving untouched; only create one when there is none to keep.
    const next = await serveHttps(port);
    const retiring = publicServer;
    const keptAlias = aliasServer;
    publicPort = port;
    publicServer = next;
    aliasServer = keptAlias ?? null;
    retiring?.close();
    if (!keptAlias) {
      try { aliasServer = await serveHttps(manifestPort); }
      catch (error) { log('alias_listen_failed', { port: manifestPort, code: error.code }); }
    }
    log('public_port_changed', { port, manifestPort, alias: Boolean(aliasServer) });
    callback(null);
  } catch (error) {
    log('public_port_change_failed', { port, code: error.code });
    callback(error);
  }
}

function portInfo() {
  return { manifestPort, publicPort, customized: publicPort !== manifestPort };
}
if (!dataDir || !guideSocket || !Number.isInteger(manifestPort)) throw new Error('Invalid gateway environment');

const tickets = new Map();
const sessions = new Map();
// ── 会话持久化（P3-a，0.3.61）─────────────────────────────────────────────
// 问题：`sessions` 原本是纯内存 Map，**gateway 一重启就清空全部登录态**——
// 用户表现为「突然要重新登录」，而 gateway 因崩溃/升级重启并非罕见。
//
// 设计取舍（安全优先）：
//   · **原始 session 值（cookie 里的凭据）永不落盘** —— 落盘的是它的 SHA-256。
//     攻击者拿到文件也无法反推 cookie 值，更无法用它登录。
//   · CSRF 令牌同样只存哈希（校验时对请求头里的明文求哈希再比对）。
//   · fnosHost / nasIp / expires / entryUntil 是来源校验与生命周期信息，明文存。
//   · 文件权限 0600，位于 dataDir（已是 0700）。
//   · 写入用「临时文件 + rename」原子替换，避免半截文件；失败只记日志不影响服务。
//
// 校验语义完全不变：cookieSession 仍要求「cookie 值 → 记录存在且未过期」，
// 只是记录来自磁盘而非内存。重启后仍在有效期内的会话**无缝继续**。
const sessionsFile = ops.dataPath(dataDir, 'gateway-sessions.json');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// 管理页 CSRF 票据的有效期（0.3.62）：原先与 cookie 会话同为 12 小时。
// 但 P3-a 为了扛住 SIGTERM 把会话**持久化到了磁盘**，于是票据被窃取后的可用
// 窗口也变成 12 小时。管理页的票据只服务于「点按钮→提交表单」这一瞬，没必要
// 活那么久：缩短到 2 小时，并在每次成功使用时滑动续期（用过就再给 2 小时），
// 既压缩了暴露窗口，也不会让正在操作的管理员莫名其妙被登出。
const GUIDE_TTL_MS = 2 * 60 * 60 * 1000;
function sessionKey(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function sessionTokenKey(token) { return createHash('sha256').update(String(token)).digest('hex'); }
// CSRF 校验（P3-a）：本次进程内新建的会话留有明文 `csrf`，从磁盘恢复的只有
// `csrfKey`（哈希）。两种都要能过 —— 否则重启后虽然登录态保住了，却**任何写操作
// 都会 403**（那等于没修）。恒定时间比较避免时序侧信道。
function csrfMatches(session, presented) {
  if (!session || typeof presented !== 'string' || !presented) return false;
  const crypto = require('node:crypto');
  // ⚠ 两条通道的表示必须一致才可比：明文通道比「明文」，哈希通道比「哈希」。
  // （我第一版把 presented 的**明文** Buffer 去和 64 字节的哈希 hex 比，
  //  长度不等 → 恒 false，表现为「重启后登录态在、但任何写操作都 403」。）
  const expected = typeof session.csrf === 'string' ? session.csrf : null;
  // 0.3.73：恢复后的会话在**首次渲染**时才签发新 token（见 sessionCsrfToken），
  // 旧页面手里的上一代 token 必须继续有效到过期，否则「登录态还在、页面一刷新
  // 所有按钮 403」。因此哈希通道要同时接受当前代与上一代。
  const expectedKeys = csrfKeysOf(session);
  if (expected) {
    const a = Buffer.from(expected);
    const b = Buffer.from(presented);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  const presentedKey = Buffer.from(sessionTokenKey(presented));
  for (const expectedKey of expectedKeys) {
    const a = Buffer.from(expectedKey);
    if (a.length === presentedKey.length && crypto.timingSafeEqual(a, presentedKey)) return true;
  }
  return false;
}

function csrfKeysOf(session) {
  const keys = [session?.csrfKey, session?.csrfKeyPrev, ...(Array.isArray(session?.csrfKeys) ? session.csrfKeys : [])];
  return [...new Set(keys.filter(key => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key)))];
}

// 公共CSRF明文不落盘，所有仍有效页面的哈希保留到cookie会话到期。
// 达到64代时拒绝继续轮换，提示重新从fnOS取得新会话；不静默废弃旧页令牌。
function sessionCsrfToken(session) {
  if (!session) return '';
  if (typeof session.csrf === 'string' && session.csrf) return session.csrf;
  const keys = csrfKeysOf(session);
  if (keys.length >= 64) throw new Error('会话CSRF代数达到安全上限，请从fnOS桌面重新打开应用');
  const token = randomBytes(32).toString('base64url');
  session.csrfKeyPrev = session.csrfKey || null;
  session.csrf = token;
  session.csrfKey = sessionTokenKey(token);
  session.csrfKeys = [...keys, session.csrfKey];
  schedulePersist();
  return token;
}
let sessionLedgerLoaded = false;
let sessionPersistTimer = null;

function loadPersistedSessions() {
  try {
    const rows = loadSessionRows();
    sessionLedgerLoaded = true;
    if (!rows.length) return;
    const now = Date.now();
    let restored = 0;
    let guideRestored = 0;
    for (const row of rows) {
      if (!row || typeof row.key !== 'string' || !Number.isFinite(row.expires) || row.expires <= now) continue;
      // guide（管理页）会话还原到 guideCsrf（0.3.66）：页面还开着时 gateway 重启，
      // 原先会因会话丢失让后续点击全部失败。csrf 原值随行落盘（0600 文件），
      // 恢复后 guideCsrf 以原 csrf 为键，页面上的隐藏字段即可继续用。
      if (row.kind === 'guide') {
        if (typeof row.csrf === 'string' && row.csrf) {
          guideCsrf.set(row.csrf, {
            csrf: row.csrf, expires: row.expires, user: row.user || '',
            nasIp: row.nasIp || null, fnosHost: row.fnosHost || null,
            mobileShell: row.mobileShell === true, persisted: true
          });
          guideRestored += 1;
        }
        continue;
      }
      sessions.set(row.key, {
        expires: row.expires,
        entryUntil: Number.isFinite(row.entryUntil) ? row.entryUntil : 0,
        csrfKey: typeof row.csrfKey === 'string' ? row.csrfKey : null,
        csrfKeyPrev: typeof row.csrfKeyPrev === 'string' ? row.csrfKeyPrev : null,
        csrfKeys: csrfKeysOf(row).slice(0, 64),
        fnosHost: row.fnosHost,
        nasIp: row.nasIp,
        mobileShell: row.mobileShell === true,
        // 还原到内存后，cookieSession 按哈希键查表（键即磁盘上的 key）；
        // cookieKey 冗余记录该键，供 cookieSession 做一致性校验。
        cookieKey: row.key,
        persisted: true,
      });
      restored += 1;
    }
    if (restored || guideRestored) log('sessions_restored', { count: restored, guide: guideRestored });
  } catch (error) { log('sessions_load_failed', { message: String(error.message || error).slice(0, 200) }); }
}

function persistSessions() {
  try {
    const now = Date.now();
    const byKey = new Map();
    // ① 先并入磁盘上**仍然有效**的会话。**这一步是必需的**：
    //    退出钩子（SIGTERM）会在内存为空时被调用，若直接覆盖写盘，
    //    会把磁盘上已有的有效登录态抹掉 —— 实测 rows 从 1 变 0、
    //    新进程 restored=0，"持久化"反而变成"每次退出都清空"。
    for (const row of sessionLedgerLoaded ? [] : loadSessionRows()) {
      if (row?.kind === 'guide') continue;
      if (!row || typeof row.key !== 'string' || !Number.isFinite(row.expires) || row.expires <= now) continue;
      byKey.set(row.key, row);
    }
    // ② 内存中的会话覆盖同键（更新鲜）
    for (const [key, value] of sessions) {
      if (!value || value.expires <= now) continue;
      // 内存键在本进程内新建时是**原始值**，恢复后是哈希 —— 落盘一律转哈希，
      // 保证磁盘上永远不出现原始凭据。已是 64 位 hex 的键不重复哈希。
      const diskKey = /^[0-9a-f]{64}$/.test(key) ? key : sessionKey(key);
      byKey.set(diskKey, { key: diskKey, expires: value.expires, entryUntil: value.entryUntil || 0, csrfKey: value.csrfKey || null, csrfKeyPrev: value.csrfKeyPrev || null, csrfKeys: csrfKeysOf(value), fnosHost: value.fnosHost, nasIp: value.nasIp, mobileShell: value.mobileShell === true });
    }
    // guide（管理页）会话一并持久化（0.3.66）：它存在独立的 guideCsrf Map 里，
    // 原先不在持久化范围内 ⇒ **gateway 重启后管理页会话全丢**，而用户页面还开着，
    // 再点任何按钮都 session_missing → 前端判为"操作失败"（10-02 实测：
    // 用户 20:57 点「重启」失败，正是我 20:06 重启 gateway 清空了会话）。
    // 用 kind 字段区分两类会话，恢复时各归其位。
    const guideRows = [];
    for (const [key, value] of guideCsrf) {
      if (!value || value.expires <= now) continue;
      guideRows.push({ kind: 'guide', key: sessionKey(key), expires: value.expires,
        csrf: value.csrf, user: value.user || '', nasIp: value.nasIp || null,
        fnosHost: value.fnosHost || null, mobileShell: value.mobileShell === true });
    }
    // 磁盘上的 guide 行同样先并入（与 sessions 同理：SIGTERM 时内存可能已空）
    for (const row of sessionLedgerLoaded ? [] : loadSessionRows()) {
      if (row && row.kind === 'guide' && typeof row.key === 'string' && Number.isFinite(row.expires) && row.expires > now) {
        if (!guideRows.some((x) => x.key === row.key)) guideRows.push(row);
      }
    }
    const payload = JSON.stringify({ savedAt: new Date().toISOString(), sessions: [...byKey.values(), ...guideRows] }, null, 2);
    const tmp = sessionsFile + `.pending-${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`;
    let created = false;
    try {
      fs.writeFileSync(tmp, payload, { mode: 0o600, flag: 'wx' }); created = true;
      fs.chmodSync(tmp, 0o600); // fnOS ACL may otherwise defeat the creation mode.
      fs.renameSync(tmp, sessionsFile);
    } catch (error) {
      if (created && path.resolve(tmp).startsWith(path.resolve(sessionsFile) + '.pending-')) {
        try { fs.unlinkSync(tmp); } catch {}
      }
      throw error;
    }
  } catch (error) { log('sessions_persist_failed', { message: String(error.message || error).slice(0, 200) }); }
}

// 读磁盘会话：仅ENOENT当空，损坏/不可读必须保留现场。
function loadSessionRows() {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    if (!Array.isArray(raw?.sessions)) throw new Error('Invalid session ledger shape');
    return raw.sessions;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error; // 无法读取/损坏时不把它当空账本覆盖。
  }
}

// 合批写入：会话变更是低频事件，1 秒去抖足够，避免频繁 IO。
function schedulePersist() {
  if (sessionPersistTimer) return;
  sessionPersistTimer = setTimeout(() => { sessionPersistTimer = null; persistSessions(); }, 1000);
  if (sessionPersistTimer.unref) sessionPersistTimer.unref();
}
const reportKeys = new Map();
const guideCsrf = new Map();
const gatewayDshPrefix = '/app/dsh-fnos/dsh';
const gatewayManagePrefix = '/app/dsh-fnos/manage';
const pluginUrlCompat = fs.readFileSync(require.resolve('./plugin-url-compat.js'));
const cookieName = '__Host-fnos_dsh';
const log = diagnostics.logger(dataDir, 'gateway');
// P2 防御（0.3.61）：代理回调里的未捕获异常曾以 exit(1) 杀死 gateway（10-01
// 两次抓栈：ERR_HTTP_HEADERS_SENT @ SSE 分支 687/859），每次都清空全部会话。
// 已知触发点已在 SSE 分支加 headersSent 守卫；这里是兜底——记录完整栈后
// 继续服务，可用性优先。
// P3-a：优雅退出前把内存会话刷盘（正常关闭时 12 小时登录态不该丢）。
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { try { persistSessions(); } catch { /* 尽力而为 */ } process.exit(0); });
}
process.on('uncaughtException', (error) => {
  log('uncaught_exception', { message: String((error && error.stack) || error).slice(0, 2000) });
});
const networkDebug = createNetworkDebug(dataDir, currentState, log, executeNetworkDebugCommand);
// P3-a：进程启动即恢复未过期会话，让「gateway 重启」对已登录用户透明。
loadPersistedSessions();

function upstreamErrorDetails(request, upstreamPath, status, route) {
  let pathname;
  try { pathname = new URL(upstreamPath, 'http://localhost').pathname; }
  catch { pathname = String(upstreamPath).split('?', 1)[0]; }
  const firstSegment = pathname.split('/')[1] || '';
  return {
    status,
    method: request.method,
    route,
    upstreamPort,
    pathHash: createHash('sha256').update(pathname).digest('hex').slice(0, 16),
    // 可读路径（0.3.63）：原先只记 hash，80 次慢性 404 无法定位到底是哪个资源。
    // 查询串可能含 token/票据，只截路径本身并限制长度。
    path: pathname.slice(0, 160),
    ...(/^dsh-[a-z0-9-]{1,63}$/.test(firstSegment) ? { pluginRoute: firstSegment } : {})
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of tickets) if (value.expires < now) tickets.delete(key);
  let sessionsPruned = 0;
  for (const [key, value] of sessions) if (value.expires < now) { sessions.delete(key); sessionsPruned += 1; }
  if (sessionsPruned) schedulePersist();   // P3-a：清理结果要落盘，否则重启后又回来
  for (const [key, value] of reportKeys) if (value.expires < now) reportKeys.delete(key);
  for (const [key, value] of guideCsrf) if (value.expires < now) guideCsrf.delete(key);
}, 60_000).unref();

function send(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

function framePolicy(session) {
  // The fnOS mobile WebView can have an opaque or changing parent origin.
  // Only sessions created by the administrator guide can use this exception.
  if (session?.mobileShell) return '';
  const host = session?.fnosHost;
  if (!host) return "frame-ancestors 'none'";
  const ip = session.nasIp;
  const origins = new Set([`http://${host}`, `https://${host}`, `http://${ip}:5666`, `https://${ip}:5667`]);
  return `frame-ancestors ${[...origins].join(' ')}`;
}

function frameHeaders(upstream, session) {
  const headers = { ...upstream };
  delete headers['x-frame-options'];
  const appendFramePolicy = (policy) => {
    const directives = String(policy).split(';').map((item) => item.trim()).filter((item) => item && !/^frame-ancestors(?:\s|$)/i.test(item));
    if (framePolicy(session)) directives.push(framePolicy(session));
    return directives.join('; ');
  };
  const policy = headers['content-security-policy'];
  headers['content-security-policy'] = Array.isArray(policy) ? policy.map(appendFramePolicy) : appendFramePolicy(policy || '');
  if (headers['set-cookie']) {
    const cookies = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']];
    headers['set-cookie'] = cookies.map((cookie) => {
      const attributes = String(cookie).split(';').map((item) => item.trim());
      const safe = attributes.filter((item, index) => index === 0 || !/^(?:domain|samesite|secure|partitioned)(?:=|$)/i.test(item));
      return `${safe.join('; ')}; Secure; SameSite=None; Partitioned`;
    });
  }
  return headers;
}

function dshPath() {
  const record = ops.readJson(ops.dataPath(dataDir, 'launch.json'), null);
  const value = record?.path;
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : null;
}

function cookieSession(request) {
  const raw = String(request.headers.cookie || '').split(';').map((part) => part.trim());
  const value = raw.find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!value) return null;
  // ⚠ 0.3.73 修复（A09）：**永远先哈希再查表**。
  //
  // 原实现先把 cookie 原值当键查一次，查不到再拿它的哈希查一次。而恢复会话时
  // Map 的键**就是落盘的哈希**（见 loadPersistedSessions）⇒ 于是"落盘的哈希本身"
  // 也能作为 cookie 直接登录：会话文件一旦泄漏，里面的 64 位 hex 就是可用的
  // bearer 凭据，与"磁盘上只有哈希所以不可直接使用"的设计意图相反。
  //
  // 新契约：磁盘上的键（哈希）**只是索引**，不是凭据；只有能算出该哈希的原始
  // cookie 才能通过校验。进程内新建的会话同样以哈希为键（见 startTicket），
  // 因此这里只需一条查找路径。
  const key = sessionKey(value);
  const session = sessions.get(key);
  if (!session || session.expires < Date.now()) { if (session) { sessions.delete(key); schedulePersist(); } return null; }
  // 严格比较：内存里绝不该出现原值键（防御性，防止将来又写回原值键）。
  if (session.cookieKey && session.cookieKey !== key) return null;
  return session;
}

function currentState() { return ops.readJson(ops.dataPath(dataDir, 'state.json'), { mode: 'starting' }); }
function available() { return ['ready', 'rollback'].includes(currentState().mode); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function managementPage(request, response, session) {
  const nonce = randomBytes(16).toString('base64');
  // 0.3.73（A10）：确保渲染前会话手里有可用的 CSRF 明文。从磁盘恢复的会话只有
  // 哈希，此前直接渲染 session.csrf 会得到空字符串 ⇒ 重启后新开页面所有写操作 403。
  sessionCsrfToken(session);
  const aiCatalog = await aiModelCatalog().catch(() => null);
  const aiInfo = aiCatalog ? require('./diagnostic-models').publicProviders(aiCatalog) : [];
  const body = managementUi.render(dataDir, currentState(), session, request.url, dshPath(), nonce, networkDebug.status(), await dockerAccess.inspect(dataDir), portInfo(), aiInfo);
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; ${framePolicy(session)}`.trim(), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(body);
}
function logsPage(request, response, session) {
  const url = new URL(request.url, 'https://fnos.invalid');
  const source = url.searchParams.get('source') || 'gateway';
  if (!diagnosticsUi.sources.some(([id]) => id === source)) return send(response, 400, 'Invalid log source');
  const download = url.searchParams.get('download') === '1';
  const content = diagnostics.read(dataDir, source, download ? 2000 : 200, !download);
  if (download) {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${source}-diagnostics.log"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return response.end(content);
  }
  const nonce = randomBytes(16).toString('base64');
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; ${framePolicy(session)}`.trim(), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(diagnosticsUi.render('/__fnos/logs', source, content, nonce, '/__fnos/?view=logs'));
}

function guideLogsPage(request, response) {
  const url = new URL(request.url, 'http://fnos.invalid');
  const source = url.searchParams.get('source') || 'gateway';
  if (!diagnosticsUi.sources.some(([id]) => id === source)) return send(response, 400, 'Invalid log source');
  const download = url.searchParams.get('download') === '1';
  const content = diagnostics.read(dataDir, source, download ? 2000 : 200, !download);
  if (download) {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${source}-diagnostics.log"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return response.end(content);
  }
  const nonce = randomBytes(16).toString('base64');
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'`, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(diagnosticsUi.render('/app/dsh-fnos/diagnostics', source, content, nonce));
}
const pendingCommands = new Map();
process.on('message', (message) => {
  if (message?.type !== 'command-result') return;
  const pending = pendingCommands.get(message.id);
  if (pending) { pendingCommands.delete(message.id); pending(message); }
});
function command(action, params) {
  return new Promise((resolve, reject) => {
    if (!process.send) { reject(new Error('管理服务未连接')); return; }
    const id = randomBytes(12).toString('hex');
    const timer = setTimeout(() => { pendingCommands.delete(id); reject(new Error('操作超时')); }, 15 * 60_000);
    pendingCommands.set(id, (message) => { clearTimeout(timer); message.ok ? resolve(message.result) : reject(new Error(message.error)); });
    process.send({ type: 'command', id, action, backupId: params.get('backupId'), version: params.get('version'), registry: params.get('registry'), profile: params.get('profile'), packageName: params.get('packageName'), dockerMode: params.get('dockerMode'), corePort: params.get('corePort'), publicPort: params.get('publicPort'), dailyLimit: params.get('dailyLimit'), manualLimit: params.get('manualLimit'), upgradeLimit: params.get('upgradeLimit'), dailyMode: params.get('dailyMode'), content: params.get('content'), patchRevision: params.get('patchRevision'), backupName: params.get('backupName'), confirmLegacyProfile: params.get('confirmLegacyProfile'), restartRequestId: params.get('restartRequestId'), commandText: params.get('command') });
  });
}

function probePluginRoute(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: upstreamPort, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': 2 }, timeout: 5_000, signal: AbortSignal.timeout(10_000) }, (reply) => {
      let responseBytes = 0;
      reply.on('data', (chunk) => { responseBytes += chunk.length; if (responseBytes > 64 * 1024) reply.destroy(new Error('DSH 路由探测响应过大')); });
      reply.on('end', () => resolve({ status: reply.statusCode, contentType: String(reply.headers['content-type'] || '').slice(0, 100), responseBytes }));
      reply.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('DSH 路由探测超时')));
    request.on('error', reject);
    request.end('{}');
  });
}

function executeNetworkDebugCommand(input) {
  const selected = debugCommands.validate(input);
  if (selected.action === 'probe-plugin-route') return probePluginRoute(selected.path);
  const params = new URLSearchParams(selected.params);
  return command(selected.action, params);
}

// 本地插件包导入：浏览器把 .tgz 以 base64 上传，落盘后走与在线安装完全相同的
// install-plugin 链（校验/启动验证/失败回滚）。独立于表单 action 端点，因为
// base64 体积远超表单 256KB 上限。
const PLUGIN_IMPORT_BODY_MAX = 96 * 1024 * 1024;

// —— AI 诊断对话：管理页（网关侧）直连已配置的模型 provider —— //
// 模型配置来自 cordis.patch.yml 的 llm-pi-ai（诊断模式下该条目被刻意保留），
// API key 来自 .credentials.yaml 的 refs（按 provider 的 apiKeyEnv 引用）。
// 该通道不经过 core：core 起不来（诊断场景）时面板依然可用。
function credentialsRefs() {
  try {
    const file = ops.dataPath(dataDir, 'dsh-home', '.credentials.yaml');
    if (!fs.existsSync(file) || !yamlModule) return {};
    return yamlModule.parse(fs.readFileSync(file, 'utf8'))?.refs || {};
  } catch { return {}; }
}

async function aiModelCatalog() {
  return require('./diagnostic-models').readCatalog(dataDir, yamlModule, process.env.FNOS_APP_DIR);
}

// 模型 provider 请求（0.3.73 / A08 修复）。
//
// 原实现有三处确定性缺陷：
//   ① TLS 用 `rejectUnauthorized: false` —— 全局关闭证书校验；
//   ② 响应体无大小上限、无 res 'error' 收尾；
//   ③ Authorization 头写死 `Bearer ${apiKey}`，而 apiKey 一定是字符串（调用方
//      未传时为 undefined ⇒ 头变成 "Bearer undefined"）。
// 另外调用点曾把 apiKey 塞进 JSON 正文（见 aiChat），使密钥出现在请求体里。
function postJson(endpoint, body, apiKey, options) {
  return require('./diagnostic-request').postJson(endpoint, body, apiKey, options);
}

function aiChat(request, response, session, guide = false) {
  if (request.method !== 'POST') return send(response, 405, 'Method not allowed');
  let body = '';
  request.on('data', (chunk) => { body += chunk; if (body.length > 2 * 1024 * 1024) request.destroy(); });
  request.on('error', () => send(response, 400, JSON.stringify({ ok: false, error: '连接中断' })));
  request.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch { return send(response, 400, JSON.stringify({ ok: false, error: '请求体不是合法 JSON' })); }
    if (guide) {
      const record = String(payload.csrf || '') && guideCsrf.get(String(payload.csrf || ''));
      if (!record || record.expires < Date.now() || record.user !== String(request.headers['x-trim-userid'] || '')) return send(response, 403, JSON.stringify({ ok: false, error: 'Invalid CSRF token' }));
    } else if (!csrfMatches(session, String(payload.csrf || ''))) {
      return send(response, 403, JSON.stringify({ ok: false, error: 'Invalid CSRF token' }));
    }
    const message = String(payload.message || '').trim();
    const controller = new AbortController();
    response.once('close', () => { if (!response.writableFinished) controller.abort(); });
    if (!message) return send(response, 200, JSON.stringify({ ok: false, error: '消息为空' }));
    try {
      const catalog = await aiModelCatalog();
      const models = require('./diagnostic-models');
      const providerId = String(payload.provider || '') || catalog.defaultProvider;
      const { spec, model } = models.chooseModel(catalog, providerId, String(payload.model || ''));
      const endpoint = models.endpointFor(model, String(payload.baseURL || '').trim());
      const apiKey = models.managedKey(dataDir, yamlModule, spec.apiKeyEnv, payload.apiKey, catalog.customCredentialSource);
      const messages = models.diagnosticMessages(currentState(), payload.history, message, model);
      const maxField = model.compat?.maxTokensField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens';
      const chat = await postJson(endpoint, { model: model.id, messages, stream: false, [maxField]: 2048 }, apiKey, { signal: controller.signal });
      const redact = () => '上游错误详情未回显，避免泄露凭据';
      // 上游错误要可读（此前只有 raw / 空对象，管理员看不出 401 还是 404），
      // 且错误正文同样脱敏后截断。
      if (chat.status && (chat.status < 200 || chat.status >= 300)) {
        const detail = JSON.stringify(chat.data ?? {}).slice(0, 300);
        return send(response, 200, JSON.stringify({ ok: false, error: `模型端点返回 HTTP ${chat.status}：${redact(detail)}` }));
      }
      const reply = chat?.data?.choices?.[0]?.message?.content;
      if (!reply) return send(response, 200, JSON.stringify({ ok: false, error: `模型返回异常：${redact(JSON.stringify(chat?.data ?? chat).slice(0, 300))}` }));
      return send(response, 200, JSON.stringify({ ok: true, reply, model: model.id }));
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      return send(response, 200, JSON.stringify({ ok: false, error: error?.diagnosticSafe ? error.message : '诊断请求失败：请检查模型配置、API-key、网络与证书。原始配置和日志不会自动外发。' }));
    }
  });
}
function pluginImport(request, response, session, guide = false) {
  if (request.method !== 'POST') return send(response, 405, 'Method not allowed');
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > PLUGIN_IMPORT_BODY_MAX) { request.destroy(); body = ''; }
  });
  request.on('error', () => send(response, 400, JSON.stringify({ ok: false, error: '连接中断' })));
  request.on('end', () => {
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch { return send(response, 400, JSON.stringify({ ok: false, error: '请求体不是合法 JSON' })); }
    if (guide) {
      const token = String(payload.csrf || '');
      const record = token && guideCsrf.get(token);
      if (!record || record.expires < Date.now() || record.user !== String(request.headers['x-trim-userid'] || '')) return send(response, 403, JSON.stringify({ ok: false, error: 'Invalid CSRF token' }));
    } else if (!csrfMatches(session, String(payload.csrf || ''))) {
      return send(response, 403, JSON.stringify({ ok: false, error: 'Invalid CSRF token' }));
    }
    const name = String(payload.filename || '');
    if (!/^[A-Za-z0-9._-]+\.tgz$/.test(name) && !/^[A-Za-z0-9._-]+\.tar\.gz$/.test(name)) {
      return send(response, 400, JSON.stringify({ ok: false, error: '文件名仅允许字母数字点横线下划线，且以 .tgz/.tar.gz 结尾' }));
    }
    let raw;
    try { raw = Buffer.from(String(payload.contentBase64 || ''), 'base64'); } catch { raw = Buffer.alloc(0); }
    if (!raw.length) return send(response, 400, JSON.stringify({ ok: false, error: '文件内容为空' }));
    if (raw.length > 64 * 1024 * 1024) return send(response, 413, JSON.stringify({ ok: false, error: '文件超过 64MB 上限' }));
    const uploadsDir = ops.dataPath(dataDir, 'plugin-uploads');
    try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch (error) { return send(response, 500, JSON.stringify({ ok: false, error: `上传目录创建失败：${error.message}` })); }
    const saved = path.join(uploadsDir, `${Date.now()}-${name}`);
    try { fs.writeFileSync(saved, raw); } catch (error) { return send(response, 500, JSON.stringify({ ok: false, error: `写入失败：${error.message}` })); }
    log('plugin_import_saved', { path: saved, bytes: raw.length });
    // 走与在线安装完全相同的链：校验、启动验证、失败回滚（supervisor installPlugin）。
    command('install-plugin', new URLSearchParams({ packageName: saved, view: 'plugins' }))
      .then((result) => {
        log('plugin_import_installed', { path: saved });
        send(response, 200, JSON.stringify({ ok: true, notice: (result && result.warning) ? `${result.warning}` : `已从本地文件导入并安装 ${name}` }));
      })
      .catch((error) => {
        try { fs.rmSync(saved, { force: true }); } catch { /* 清理失败忽略 */ }
        log('plugin_import_failed', { error: error.message });
        send(response, 200, JSON.stringify({ ok: false, error: `导入安装失败：${error.message}` }));
      });
  });
}

async function managementAction(request, response, session, guide = false) {
  if (request.method !== 'POST') return send(response, 405, 'Method not allowed');
  let body = '';
  for await (const chunk of request) { body += chunk; if (body.length > 262144) return send(response, 413, 'Request too large'); }
  const params = new URLSearchParams(body);
  if (guide) {
    const token = params.get('csrf');
    const record = token && guideCsrf.get(token);
    if (!record || record.expires < Date.now() || record.user !== String(request.headers['x-trim-userid'] || '')) return send(response, 403, 'Invalid CSRF token');
    // 滑动续期：票据活着且在正常使用时延长，长期闲置则自然过期。
    record.expires = Date.now() + GUIDE_TTL_MS;
    session = record;
  }
  if (!csrfMatches(session, String(params.get('csrf') || ''))) return send(response, 403, 'Invalid CSRF token');
  const action = params.get('action');
  if (action === 'save-patch-config' && (!/^(?:[a-f0-9]{64}|missing)$/.test(params.get('patchRevision') || '') || !params.get('profile'))) return send(response, 400, '配置页面版本缺失或过旧，请刷新后再保存');
  if (!actions.isGatewayAction(action)) return send(response, 400, 'Unknown action');
  log('admin_action', { action });
  let notice;
  try {
    if (['allow-plugin-path', 'dismiss-plugin-path', 'revoke-plugin-path'].includes(action)) {
      pluginPaths.change(dataDir, action.split('-')[0], params.get('path'));
      notice = action === 'allow-plugin-path' ? '插件路径已放行，请返回并强制刷新 DSH' : action === 'revoke-plugin-path' ? '插件路径放行已撤销，请强制刷新 DSH' : '已忽略此候选路径';
    } else if (action === 'probe-workspace') {
      grants.probeWorkspace(params.get('workspacePath'));
      notice = '工作区目录可读写，可以在 DSH 中使用';
    } else if (action === 'start-network-debug') {
      const selected = await networkDebug.start(session.nasIp, { minutes: params.get('minutes') || undefined, mode: params.get('mode') || undefined });
      notice = `临时网络调试已切换为${selected.mode === 'command' ? '指令模式' : '只读模式'}，${selected.minutes} 分钟后自动关闭；端口和 Token 已更新`;
    } else if (action === 'stop-network-debug') {
      networkDebug.stop();
      notice = '临时网络调试已关闭';
    } else if (action === 'save-patch-config') {
      await command('save-patch-config', params);
      notice = 'cordis.patch.yml 已保存；DSH 会自动热加载，若页面异常请查看诊断日志';
    } else if (action === 'disable-patch-config') {
      await command('disable-patch-config', params);
      notice = '已禁用全部自定义 patch 条目（原内容已备份，可在配置文件页恢复）';
    } else if (action === 'restore-patch-config') {
      await command('restore-patch-config', params);
      notice = '已从备份恢复 cordis.patch.yml';
    } else if (action === 'heal-patch-layer') {
      // safe mode 一键修复：patch 层解析不出数组 → 备份后重置为合法空层。
      // 由 supervisor 侧执行（它拥有写配置与重启 core 的全部上下文）。
      await command('heal-patch-layer', params);
      notice = 'patch 配置已重置（原文件已备份）；DSH 正在重启';
    } else if (action === 'disable-third-party-plugins') {
      // safe mode 第三恢复按钮：禁用全部第三方插件后重启（supervisor 侧合并 patch 层）
      await command('disable-third-party-plugins', params);
      notice = '已禁用全部第三方插件；DSH 正在重启（恢复见配置文件页的备份恢复）';
    } else if (action === 'dedupe-patch-layer') {
      // safe mode 一键修复：删除用户层里的重复插件声明（保留第一份）。
      await command('dedupe-patch-layer', params);
      notice = '重复声明已清理；DSH 正在重启';
    } else if (action === 'enter-diagnosis') {
      const result = await command('enter-diagnosis', params);
      notice = result?.warning || result?.note || '只读诊断状态已更新；本次没有修改 patch 或启动重启';
    } else if (action === 'exit-diagnosis') {
      const result = await command('exit-diagnosis', params);
      notice = result?.warning || result?.note || '旧诊断配置恢复已处理，请核对当前运行状态';
    } else {
      const result = await command(action, params);
      notice = result?.warning || result?.notice || '操作已完成';
    }
    log('admin_action_succeeded', { action });
  }
  catch (error) { notice = `操作失败：${error.message}`; log('admin_action_failed', { action }); }
  const view = managementUi.selectedView(params.get('view'));
  response.writeHead(303, { Location: `${guide ? gatewayManagePrefix + '/' : '/__fnos/'}?view=${view}&notice=${encodeURIComponent(notice)}`, 'Cache-Control': 'no-store' });
  response.end();
}

// 0.3.60：判定源换成浏览器元数据头。Sec-Fetch-Site 由浏览器生成、反代/中继
// 转发时只保留不改写 —— fnOS 升级若改了反代行为（比如把 Host 改写成回环地址），
// 依赖 Host 头的同源比较会把全部远程 API 误拒成 origin_denied，而 fetch-site
// 不受影响。安全等价：CSRF 主向量（跨站 XHR）浏览器如实填 cross-site → 显式拒；
// 伪造该头的客户端过得了这层也过不了会话检查（无 cookie → 401），
// 真防线是会话，origin 只是纵深。Origin/Host 比较保留为无 fetch-site 时的回退。
function sameOrigin(request) {
  const site = request.headers['sec-fetch-site'];
  if (site === 'same-origin') return true;
  const origin = request.headers.origin;
  if (site === 'cross-site') return false;
  if (!origin) return site !== 'cross-site';
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.host === request.headers.host;
  } catch { return false; }
}

function entryNavigation(request) {
  if (request.method !== 'GET' || request.headers.origin) return false;
  if (request.headers['sec-fetch-mode'] && request.headers['sec-fetch-mode'] !== 'navigate') return false;
  if (request.headers['sec-fetch-dest'] && !['document', 'iframe'].includes(request.headers['sec-fetch-dest'])) return false;
  const session = cookieSession(request);
  if (request.url.startsWith('/_fnos/start?')) return true;
  if (!session) return false;
  if (session.entryUntil > Date.now()) return true;
  // Compare the path only: the frame re-navigates to the entry URL it was
  // handed (`/?token=…`) and the refresh button appends `?__fnos_refresh=…`,
  // so after the 60-second grace window no full-URL comparison ever matches
  // and every reload turned into 403 Origin denied. Authorization above is
  // unchanged: same valid session, same GET/navigate/iframe restrictions.
  return request.headers['sec-fetch-dest'] === 'iframe' && ['/', '/__fnos/'].includes(request.url.split('?')[0]);
}

function managementNavigation(request) {
  if (request.method !== 'GET' || !request.url.startsWith('/__fnos/')) return false;
  if (request.headers.origin && request.headers.origin !== 'null') return false;
  if (request.headers['sec-fetch-mode'] && request.headers['sec-fetch-mode'] !== 'navigate') return false;
  return !request.headers['sec-fetch-dest'] || ['document', 'iframe'].includes(request.headers['sec-fetch-dest']);
}

// ── 会话投递失败的真实原因透出（0.3.62）───────────────────────────────
// 现象：发**图片**时界面只显示「prompt rejected (session/agent-busy)」，
// 与「忙」毫无关系，用户无法判断该怎么办。
//
// 真因（实测定位）：`dsh-api-session-controller` 的 prompt 准入里，任何
// **未被识别**的异常都会被兜底包成
//     new RemoteError("session/agent-busy", "prompt rejected", { reason: String(error) })
// 真实错误就在 `details.reason`，但前端只渲染 code + message。
// 本例真实 reason 是附件落盘时沿路径**逐级 fsync 祖先目录**（直到文件系统根）
// 撞上 fnOS 的 `/vol1`（权限位 d---------、ACL 仅 --x，无读）：
//     EACCES: permission denied, open '/vol1'
//
// 本函数把 `details.reason` 并入 message，让界面直接显示根因。**只改响应正文的
// 附加字段，不改状态码、不改语义**；非该错误码 / 非 JSON / 结构不符一律原样返回 null。
function surfaceRemoteFailure(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  const error = parsed && typeof parsed === 'object' ? parsed.error : null;
  if (!error || typeof error !== 'object' || error.code !== 'session/agent-busy') return null;
  const details = error.details && typeof error.details === 'object' ? error.details : {};
  const reason = details.reason === undefined ? '' : String(details.reason);
  if (!reason) return null;
  error.message = String(error.message || '') + ' — 实际原因: ' + reason.slice(0, 400);
  error.details = { ...details, reason };
  return JSON.stringify(parsed);
}

function upstreamHeaders(request) {
  const headers = { ...request.headers, host: `127.0.0.1:${upstreamPort}` };
  if (headers.origin) headers.origin = `http://127.0.0.1:${upstreamPort}`;
  if (headers.referer) headers.referer = `http://127.0.0.1:${upstreamPort}/`;
  delete headers['x-forwarded-for'];
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];
  return headers;
}

function startTicket(request, response) {
  const url = new URL(request.url, 'https://fnos.invalid');
  const ticket = url.searchParams.get('ticket');
  const record = ticket && tickets.get(ticket);
  if (ticket) tickets.delete(ticket);
  if (!record || record.expires < Date.now() || record.route !== 'direct' || record.ip !== network.hostIp(network.fnosHost(request.headers.host))) { log('ticket_rejected'); return send(response, 403, '进入凭据无效，请从 fnOS 桌面重新打开。'); }
  const path = available() ? dshPath() : null;
  const session = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  // P3-a：内存键用**原始值**（本次进程内最快），同时记录哈希键用于落盘；
  // csrf 明文只回给客户端，磁盘上只留哈希。
  // 0.3.73（A09）：内存键**统一为哈希**（cookieKey 只作一致性冗余）。原实现用
  // 原始 cookie 作键，导致落盘索引与内存索引两套语义，且恢复路径不得不接受
  // "哈希当 cookie"；现在只有一条路径：cookie → sha256 → 查表。
  const sessionKeyHash = sessionKey(session);
  sessions.set(sessionKeyHash, { expires: Date.now() + SESSION_TTL_MS, entryUntil: Date.now() + 60_000, csrf, csrfKey: sessionTokenKey(csrf), cookieKey: sessionKeyHash, fnosHost: record.fnosHost, nasIp: record.ip, mobileShell: record.mobileShell });
  schedulePersist();
  log('ticket_accepted', { fnosHost: record.fnosHost });
  response.writeHead(302, {
    Location: path || '/__fnos/',
    'Set-Cookie': `${cookieName}=${session}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=None; Partitioned`,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer'
  });
  response.end();
}

async function browserDiagnostic(request, response) {
  if (request.method !== 'POST') return send(response, 405, 'Method not allowed');
  if (!String(request.headers['content-type'] || '').startsWith('text/plain')) return send(response, 415, 'Text report required');
  let body = '';
  for await (const chunk of request) { body += chunk; if (body.length > 2048) return send(response, 413, 'Report too large'); }
  let value;
  try { value = JSON.parse(body); } catch { return send(response, 400, 'Invalid report'); }
  const key = typeof value.key === 'string' ? value.key : '';
  const record = reportKeys.get(key);
  if (!record || record.expires < Date.now()) return send(response, 403, 'Invalid report key');
  let details;
  try { details = diagnostics.browserReport(value); } catch { return send(response, 400, 'Invalid report'); }
  reportKeys.delete(key);
  log('browser_frame_report', details);
  response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  response.end();
}

// 会话失效提示页（0.3.61）：仅用于入口路径的 GET 导航（见 handlePublic 的
// origin_denied 分支）。内容静态、不含任何数据；仍回 403 保持「未授权」语义，
// 只把裸文本换成可操作的指引，避免宿主壳陷入不可读的重载循环。
function sessionExpiredPage(response) {
  const nonce = randomBytes(16).toString('base64');
  response.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'`, 'X-Content-Type-Options': 'nosniff' });
  return response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>会话已失效</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#1c2333;font:16px system-ui,sans-serif}.card{max-width:520px;margin:20px;padding:28px;background:white;border:1px solid #e1e7f0;border-radius:14px}h1{font-size:22px}p{line-height:1.6}button{display:inline-block;margin-top:8px;padding:10px 14px;border:0;border-radius:8px;background:#175cd3;color:white;font:inherit;cursor:pointer}</style></head><body><main class="card"><h1>会话已失效</h1><p>应用网关重启过，登录状态未保留。请回到 fnOS 桌面，重新点击应用图标打开。</p><button id="recheck" type="button">已重新进入，再试一次</button></main><script nonce="${nonce}">document.getElementById('recheck').onclick=()=>location.reload();</script></body></html>`);
}

function handlePublic(request, response) {
  // A credential-free pixel lets the fnOS mobile shell check whether its own
  // WebView can reach the separate HTTPS port before navigating an iframe.
  if (request.method === 'GET' && request.url.startsWith('/_fnos/reachability.svg?')) {
    const pixel = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
    response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': Buffer.byteLength(pixel), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    return response.end(pixel);
  }
  if (request.url === '/_fnos/diagnostic') return browserDiagnostic(request, response);
  if (request.url === '/__fnos/plugin-import') {
    const session = cookieSession(request);
    if (!session) return send(response, 401, JSON.stringify({ ok: false, error: '请从 fnOS 桌面图标打开 DeepSeek Harness。' }));
    return pluginImport(request, response, session);
  }
  // 轻量状态端点（0.3.61）：管理页在「重启 DSH」后轮询这里，直到核心真正就绪
  // 才跳转，这样状态徽标能走完「运行中 → 重启中 → 运行中」，不必手动刷新。
  // 返回 JSON（体积远小于整页），未就绪时用 503 让前端一眼判定。
  if (request.url.startsWith('/__fnos/state')) {
    const session = cookieSession(request);
    if (!session) return send(response, 401, JSON.stringify({ ok: false, error: '请从 fnOS 桌面图标打开 DeepSeek Harness。' }));
    const current = currentState();
    const ready = available();
    const body = JSON.stringify({ ok: ready, mode: current?.mode || 'unknown', error: current?.error || null, activeVersion: current?.activeVersion || null, operation: current?.operation || null, automaticBackupDeferred: automaticBackups.publicDeferrals(current?.automaticBackupDeferred), bootId: current?.bootId || null, restartReceipt: current?.restartReceipt || null, updatedAt: current?.updatedAt || null });
    response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return response.end(body);
  }
  if (request.url === '/__fnos/ai-chat') {
    const session = cookieSession(request);
    if (!session) return send(response, 401, JSON.stringify({ ok: false, error: '请从 fnOS 桌面图标打开 DeepSeek Harness。' }));
    return aiChat(request, response, session);
  }
  if (request.url.startsWith('/__fnos/action')) {
    const session = cookieSession(request);
    if (!session) { log('session_missing'); return send(response, 401, '请从 fnOS 桌面图标打开 DeepSeek Harness。'); }
    return managementAction(request, response, session);
  }
  // 诊断包（0.3.62）：直连模式同样需要会话，避免未授权下载日志。
  if (request.method === 'GET' && request.url === '/__fnos/diagnostics-pack') {
    const session = cookieSession(request);
    if (!session) { log('session_missing'); return send(response, 401, '请从 fnOS 桌面图标打开 DeepSeek Harness。'); }
    return diagnosticsPack(request, response);
  }
  if (!sameOrigin(request) && !entryNavigation(request) && !(cookieSession(request) && managementNavigation(request))) {
    const denial = { method: request.method, area: request.url.startsWith('/__fnos/') ? 'management' : 'dsh', origin: request.headers.origin === 'null' ? 'opaque' : request.headers.origin ? 'cross' : 'absent', fetchSite: String(request.headers['sec-fetch-site'] || '').slice(0, 24), host: String(request.headers.host || '').slice(0, 60), originHost: '' };
    try { if (request.headers.origin && request.headers.origin !== 'null') denial.originHost = new URL(request.headers.origin).host; } catch { /* leave empty */ }
    log('origin_denied', denial);
    // fnOS 升级改反代行为的专用信号：来源明明是同站（fetch-site 非 cross-site）
    // 却因 origin.host ≠ Host 被拒 —— 中间层改写了 Host 头。
    if (denial.originHost && denial.host && denial.originHost !== denial.host && denial.fetchSite !== 'cross-site') {
      log('host_header_rewritten', { originHost: denial.originHost, host: denial.host, path: request.url.slice(0, 80) });
    }
    // 0.3.61 v2：无会话 GET 导航**一律**回提示页（不再限定入口路径）。
    // 宿主壳可能直接加载深层路由，限定入口路径会让深路径仍拿到裸 403，
    // 壳再次陷入无法理解的「Origin denied」重载循环。
    // 安全性不变：无会话的跨站 GET 本来就拿不到任何数据；
    // API / POST / 带 Origin 的 fetch 仍然维持裸 403。
    // 判定「这是一次人在浏览器里的导航」——缺省必须是**导航**，不能把「缺少
    // sec-fetch-* 头」当成导航（老浏览器/爬虫/跨站脚本都不发这些头，若一律当
    // 导航，跨站 POST/API 也会拿到 HTML 提示页，弱化安全语义）。
    // 因此：只认 GET，且必须没有请求体语义、且（显式 navigate，或既无 mode 也无
    // dest 但带 Referer/Document 类信号的匿名导航）。
    const navMode = String(request.headers['sec-fetch-mode'] || '');
    const navDest = String(request.headers['sec-fetch-dest'] || '');
    const isNavigation = request.method === 'GET'
      // fetch/XHR 即使路径像页面也不是导航：显式排除它们的 mode/dest。
      && navMode !== 'cors' && navMode !== 'no-cors' && navMode !== 'same-origin'
      && navDest !== 'empty'
      // 显式导航，或老浏览器（无 sec-fetch-* 但 Accept 里有 text/html）。
      && (navMode === 'navigate' || navDest === 'document' || navDest === 'iframe'
          || (!navMode && !navDest && (request.headers.accept || '').includes('text/html')));
    if (isNavigation) {
      return sessionExpiredPage(response);
    }
    return send(response, 403, 'Origin denied');
  }
  if (request.url.startsWith('/_fnos/start?')) return startTicket(request, response);
  const session = cookieSession(request);
  if (!session) { log('session_missing'); return send(response, 401, '请从 fnOS 桌面图标打开 DeepSeek Harness。'); }
  if (request.url.startsWith('/__fnos/')) {
    if (request.method === 'GET' && request.url.split('?')[0] === '/__fnos/preflight') return recoveryChecksResponse(response);
    if (request.url.startsWith('/__fnos/action')) return managementAction(request, response, session);
    if (request.url.startsWith('/__fnos/logs')) return request.method === 'GET' ? logsPage(request, response, session) : send(response, 405, 'Method not allowed');
    if (request.method === 'GET') return managementPage(request, response, session).catch((error) => managementFallbackPage(response, error, session));
    return send(response, 405, 'Method not allowed');
  }
  if (!available()) {
    if (request.method !== 'GET' || !['/', '/index.html'].includes(request.url)) return send(response, 503, 'DSH 核心暂不可用');
    const nonce = randomBytes(16).toString('base64');
    const unavailableState = currentState();
    response.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; ${framePolicy(session)}`.trim(), 'X-Content-Type-Options': 'nosniff' });
    return response.end(unavailablePage.render(unavailableState, { nonce, settingsUrl: '/__fnos/?view=runtime' }));
  }
  const lifetime = sseProxy.createProxyLifetime(request, response);
  const upstream = http.request({
    host: '127.0.0.1', port: upstreamPort, method: request.method,
    path: request.url, headers: upstreamHeaders(request)
  }, (reply) => {
    if (!lifetime.acceptReply(reply)) return;
    if (reply.statusCode >= 400) {
      const errKey = reply.statusCode + ':' + request.method + ':' + request.url;
      const now = Date.now();
      if (now - (httpErrorLogAt.get(errKey) || 0) > 300000) { httpErrorLogAt.set(errKey, now); log('upstream_http_error', upstreamErrorDetails(request, request.url, reply.statusCode, 'public')); }
    }
    // 会话投递失败的真实原因透出（0.3.62）：用户从 fnOS 桌面进入走的是
    // gateway 路由（route=gateway → handlePublic），因此拦截必须放在**这里**，
    // 而不是 proxyGuideDsh。见 surfaceRemoteFailure 的说明。
    if (reply.statusCode >= 400 && /application\/json/i.test(String(reply.headers['content-type'] || ''))) {
      let body = '';
      reply.setEncoding('utf8');
      reply.on('data', (chunk) => { body += chunk; if (body.length > 512 * 1024) reply.destroy(new Error('DSH error body too large')); });
      reply.on('error', () => { if (response.destroyed || response.writableEnded) return; if (!response.headersSent) send(response, 502, 'DSH 响应读取失败'); else response.destroy(); });
      reply.on('end', () => {
        if (response.destroyed || response.writableEnded) return;
        const patched = surfaceRemoteFailure(body);
        const headers = frameHeaders(reply.headers, session);
        if (patched === null) { if (!response.headersSent) response.writeHead(reply.statusCode, headers); response.end(body); return; }
        delete headers['content-length'];
        delete headers['transfer-encoding'];
        if (!response.headersSent) response.writeHead(reply.statusCode, headers);
        response.end(patched);
      });
      return;
    }
    if (String(reply.headers['content-type'] || '').toLowerCase().includes('text/event-stream')) {
      sseProxy.pipeSse({ reply, response, lifetime, headers: frameHeaders(reply.headers, session), log, label: request.url.split('?')[0].slice(0, 60) });
      return;
    }
    response.writeHead(reply.statusCode, frameHeaders(reply.headers, session));
    reply.pipe(response);
  });
  // --- TCP keepalive (方案 B) ---
  // 网关 → core 段也开内核级 keepalive：fn Connect 类中继常见"不发 FIN/RST 只
  // 静默"的半开连接，应用层事件永不触发；内核 keepalive 让 OS 在保活探测失败
  // 后真正报错，'error'/'close' 才能及时清理。
  lifetime.attachRequest(upstream);
  upstream.setNoDelay(true);
  upstream.setSocketKeepAlive(true, 30_000);
  upstream.on('error', (error) => {
    // 2026-09-29 排查上传失败时发现这里 details 为空，导致 ECONNRESET /
    // ECONNREFUSED / 超时无法区分。错误码是定位断点侧别的关键证据。
    if (response.destroyed || response.writableEnded || lifetime.closed) return;
    log('upstream_error', { code: error.code || 'unknown', message: String(error.message || '').slice(0, 120) });
    if (!response.headersSent) send(response, 502, 'dsh 未就绪。');
    else response.destroy();
  });
  request.pipe(upstream);
}

// Bridge an upgraded WebSocket pair. Both directions must tear down together:
// the browser's WS library only learns about a broken link through its `close`
// event, and the core's session must not dangle on a dead upstream. Without
// this propagation one network hiccup froze the session until a manual reload.
// TCP keepalive additionally lets the kernel notice half-open connections that
// fn Connect relays tend to produce (no FIN/RST, just silence).
function pipeUpgradeSockets(socket, upstreamSocket) {
  const teardown = () => { upstreamSocket.destroy(); socket.destroy(); };
  // 'end' matters as much as 'close': a relay that drops the link delivers EOF
  // to one side while that side's socket is still technically writable, so a
  // close-only listener never fires and the other direction keeps hanging.
  for (const event of ['error', 'close', 'end']) {
    socket.on(event, teardown);
    upstreamSocket.on(event, teardown);
  }
  socket.setKeepAlive(true, 15_000);
  upstreamSocket.setKeepAlive(true, 15_000);
  socket.pipe(upstreamSocket).pipe(socket);
}

function handleUpgrade(request, socket, head) {
  if (!sameOrigin(request) || !cookieSession(request) || !available()) { socket.destroy(); return; }
  const upstream = http.request({
    host: '127.0.0.1', port: upstreamPort, method: 'GET',
    path: request.url, headers: upstreamHeaders(request)
  });
  wsUpgrade.forwardUpgrade(socket, upstream, head, pipeUpgradeSockets);
  upstream.end();
}

function gatewayProxyHeaders(reply) {
  const headers = frameHeaders(reply.headers, { mobileShell: true });
  if (headers.location?.startsWith('/') && !headers.location.startsWith('//') &&
      headers.location !== gatewayDshPrefix && !headers.location.startsWith(`${gatewayDshPrefix}/`)) {
    headers.location = gatewayDshPrefix + headers.location;
  }
  if (headers['set-cookie']) {
    const values = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']];
    headers['set-cookie'] = values.map((value) => `${String(value).split(';').map((part) => part.trim()).filter((part, index) => index === 0 || !/^(?:path|domain|samesite|secure|partitioned)(?:=|$)/i.test(part)).join('; ')}; Path=${gatewayDshPrefix}/; SameSite=Lax`);
  }
  return headers;
}

function proxyGuideDsh(request, response) {
  const localPath = request.url.slice(gatewayDshPrefix.length) || '/';
  if (localPath === '/__fnos-plugin-url-compat.js') {
    if (request.method !== 'GET') return send(response, 405, 'Method not allowed');
    const rules = Buffer.from(`globalThis.__FNOS_URL_RULES__=${JSON.stringify({ builtins: pluginPaths.builtins, approved: pluginPaths.snapshot(dataDir).approved })};\n`);
    const script = Buffer.concat([rules, pluginUrlCompat]);
    response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Length': script.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return response.end(script);
  }
  if (localPath === '/__fnos-plugin-url-denied') return send(response, 403, '插件 URL 尚未放行。请到应用设置 → 核心与扩展 → 插件 URL 放行。');
  if (localPath === '/__fnos-plugin-url-candidate') {
    if (request.method !== 'POST' || !/^application\/json(?:;|$)/i.test(String(request.headers['content-type'] || ''))) return send(response, 405, 'JSON POST required');
    return (async () => {
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 256) return send(response, 413, 'Report too large'); }
      let value;
      try { value = JSON.parse(body); } catch { return send(response, 400, 'Invalid report'); }
      if (!pluginPaths.firstSegment(value?.path) || pluginPaths.firstSegment(value.path) !== value.path) return send(response, 400, 'Invalid plugin path');
      pluginPaths.observe(dataDir, value.path);
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
    })().catch(() => send(response, 500, 'Report failed'));
  }
  if (request.method === 'GET' && localPath.startsWith('/start?')) {
    const ticket = new URL(request.url, 'http://fnos.invalid').searchParams.get('ticket');
    const record = ticket && tickets.get(ticket);
    if (ticket) tickets.delete(ticket);
    if (!record || record.expires < Date.now() || record.route !== 'gateway') return send(response, 403, '进入凭据无效，请从 fnOS 桌面重新打开。');
    log('ticket_accepted', { fnosHost: record.fnosHost, route: 'gateway' });
    response.writeHead(302, { Location: gatewayDshPrefix + (available() ? dshPath() || '/' : '/'), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return response.end();
  }
  if (!available()) {
    if (request.method !== 'GET' || !['/', '/index.html'].includes(localPath)) return send(response, 503, 'DSH 核心暂不可用');
    const nonce = randomBytes(16).toString('base64');
    const unavailableState = currentState();
    response.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'`, 'X-Content-Type-Options': 'nosniff' });
    return response.end(unavailablePage.render(unavailableState, { nonce, settingsUrl: `${gatewayManagePrefix}/?view=runtime` }));
  }
  const headers = upstreamHeaders(request);
  headers['accept-encoding'] = 'identity';
  const lifetime = sseProxy.createProxyLifetime(request, response);
  const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, method: request.method, path: localPath, headers }, (reply) => {
    if (!lifetime.acceptReply(reply)) return;
    if (reply.statusCode >= 400) {
      const gwKey = 'gw:' + reply.statusCode + ':' + localPath;
      const now = Date.now();
      if (now - (httpErrorLogAt.get(gwKey) || 0) > 300000) { httpErrorLogAt.set(gwKey, now); log('upstream_http_error', upstreamErrorDetails(request, localPath, reply.statusCode, 'gateway')); }
    }
    const forwarded = gatewayProxyHeaders(reply);
    if (request.method === 'GET' && reply.statusCode === 200 && /^text\/html(?:;|$)/i.test(String(reply.headers['content-type'] || ''))) {
      let body = '';
      reply.setEncoding('utf8');
      reply.on('data', (chunk) => { body += chunk; if (body.length > 2 * 1024 * 1024) reply.destroy(new Error('DSH page too large')); });
      reply.on('end', () => {
        if (response.destroyed || response.writableEnded) return;
        // The core injects a *document-relative* base (`<base href="./">`); an
        // older one emitted the root form (`<base href="/">`). Match both and
        // pin the prefix explicitly: relying on `./` resolving against the
        // document URL only works while that URL keeps its trailing slash.
        body = body.replace(/<base\s+href="(?:\.\/|\/)"\s*\/?\s*>/i, `<base href="${gatewayDshPrefix}/">`)
          .replace(/\b(src|href|action|poster)=(['"])(\/(?!\/|app\/|_fnos\/|__fnos\/)[^'"]*)\2/gi,
            (_match, attribute, quote, url) => {
              const pathname = new URL(url, 'http://fnos.invalid').pathname;
              if (!pluginPaths.allowed(dataDir, pathname)) {
                try { pluginPaths.observe(dataDir, pathname); }
                catch (error) { log('plugin_path_observe_failed', { code: error.code || 'unknown' }); }
                return `${attribute}=${quote}${gatewayDshPrefix}/__fnos-plugin-url-denied${quote}`;
              }
              return `${attribute}=${quote}${gatewayDshPrefix}${url}${quote}`;
            })
          .replace(/<head(?:\s[^>]*)?>/i, (open) => `${open}<script src="${gatewayDshPrefix}/__fnos-plugin-url-compat.js"><\/script>${earlyCaptureScript}`);
        delete forwarded['content-length'];
        delete forwarded['transfer-encoding'];
        response.writeHead(reply.statusCode, forwarded);
        response.end(body);
      });
      reply.on('error', () => { if (response.destroyed || response.writableEnded) return; if (!response.headersSent) send(response, 502, 'DSH 页面加载失败'); else response.destroy(); });
      return;
    }
    // ── 会话投递失败的真实原因透出（0.3.62）─────────────────────────────
    // 现象：发**图片**时界面只显示「prompt rejected (session/agent-busy)」，
    // 与「忙」毫无关系，用户完全无法判断该怎么办。
    //
    // 真因（已实测定位）：`dsh-api-session-controller` 的 prompt 准入里，
    // 任何**未被识别**的异常都会被兜底包成
    //     new RemoteError("session/agent-busy", "prompt rejected", { reason: String(error) })
    // 真实错误就在 `details.reason` 里，但前端只渲染 code + message。
    //
    // 本例的真实 reason 是附件落盘时的
    //     EACCES: permission denied, open '/vol1'
    // ——`dsh-attachment-local` 为了崩溃安全，会沿目标路径**逐级 fsync 祖先目录**
    // 直到文件系统根；fnOS 的 `/vol1` 权限位是 `d---------`、ACL 只有 `--x`
    // （无读），于是 `open('/vol1', O_RDONLY)` 失败。
    //
    // 这里把 `details.reason`、`details.sessionId` 等附加到响应 JSON 的 error 上，
    // 让界面/排障能直接看到根因，而不是被 code 误导。**只改响应正文的附加字段，
    // 不改状态码、不改语义**；解析失败或结构不符时原样透传。
    if (reply.statusCode >= 400 && /application\/json/i.test(String(reply.headers['content-type'] || ''))) {
      let body = '';
      reply.setEncoding('utf8');
      reply.on('data', (chunk) => { body += chunk; if (body.length > 512 * 1024) reply.destroy(new Error('DSH error body too large')); });
      reply.on('error', () => { if (response.destroyed || response.writableEnded) return; if (!response.headersSent) send(response, 502, 'DSH 响应读取失败'); else response.destroy(); });
      reply.on('end', () => {
        if (response.destroyed || response.writableEnded) return;
        const patched = surfaceRemoteFailure(body);
        if (patched === null) { if (!response.headersSent) response.writeHead(reply.statusCode, forwarded); response.end(body); return; }
        const next = { ...forwarded };
        delete next['content-length'];
        delete next['transfer-encoding'];
        if (!response.headersSent) response.writeHead(reply.statusCode, next);
        response.end(patched);
      });
      return;
    }
    if (String(reply.headers['content-type'] || '').toLowerCase().includes('text/event-stream')) {
      sseProxy.pipeSse({ reply, response, lifetime, headers: forwarded, log, label: localPath.split('?')[0].slice(0, 60) });
      return;
    }
    response.writeHead(reply.statusCode, forwarded);
    reply.pipe(response);
  });
  lifetime.attachRequest(upstream);
  upstream.setNoDelay(true);
  upstream.setSocketKeepAlive(true, 30_000);
  upstream.on('error', () => { if (response.destroyed || response.writableEnded || lifetime.closed) return; if (!response.headersSent) send(response, 502, 'DSH 核心未就绪'); else response.destroy(); });
  request.pipe(upstream);
}

function upgradeGuideDsh(request, socket, head) {
  if (request.headers['x-trim-isadmin'] !== 'true' || !request.url.startsWith(`${gatewayDshPrefix}/`) || !available()) return socket.destroy();
  const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, method: 'GET', path: request.url.slice(gatewayDshPrefix.length), headers: upstreamHeaders(request) });
  wsUpgrade.forwardUpgrade(socket, upstream, head, pipeUpgradeSockets);
  upstream.end();
}

async function guideManagementPage(request, response) {
  const csrf = randomBytes(32).toString('base64url');
  const session = { csrf, nasIp: network.nasIpv4(network.fnosHost(request.headers.host), os.networkInterfaces(), undefined, process.env.FNOS_NAS_IPV4), user: String(request.headers['x-trim-userid'] || ''), expires: Date.now() + GUIDE_TTL_MS };
  guideCsrf.set(csrf, session);
  // 建会话后**立即排程落盘**（0.3.66）：原先只在 SIGTERM 时持久化，于是
  // gateway 被 kill -9 或异常退出时，刚建立的管理页会话没进磁盘 ⇒ 页面还开着
  // 却已 session_missing。schedulePersist 做 1 秒合并，避免频繁写盘。
  try { schedulePersist(); } catch { /* 尽力而为 */ }
  const nonce = randomBytes(16).toString('base64');
  const localUrl = request.url.replace(gatewayManagePrefix, '/__fnos');
  const aiCatalog = await aiModelCatalog().catch(() => null);
  const aiInfo = aiCatalog ? require('./diagnostic-models').publicProviders(aiCatalog) : [];
  let body = managementUi.render(dataDir, currentState(), session, localUrl, `${gatewayDshPrefix}/`, nonce, networkDebug.status(), await dockerAccess.inspect(dataDir), null, aiInfo);
  // 用户文件内容（patch 编辑器、只读根配置）可能本身就含 "/__fnos/"——那是
  // 文件内容，不属于入口路径改写；否则显示即被改写，一次保存就把用户配置写坏。
  // 先抽出这两块用户数据，改写完结构路径后再原样放回。内容均已经过 escapeHtml，
  // 不会包含字面 </textarea> 或 </pre>，非贪婪匹配是安全的。
  const userData = [];
  body = body.replace(/<textarea[^>]*>[\s\S]*?<\/textarea>|<pre class="patch-readonly">[\s\S]*?<\/pre>/g,
    (match) => {
      userData.push(match);
      return `\u0000USERDATA${userData.length - 1}\u0000`;
    });
  body = body.replaceAll('/__fnos/', `${gatewayManagePrefix}/`);
  body = body.replace(/\u0000USERDATA(\d+)\u0000/g, (_, index) => userData[Number(index)]);
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'`, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(body);
}

// ── 诊断包导出（0.3.62）────────────────────────────────────────────────
// 分级排障的最后一级出口：把状态、环境、三份日志与最近一次启动报告打成一个
// tar，交给外部排查（也服务"远程调试"场景——用户只需下载一个文件）。
// 刻意**不含**凭据文件；日志沿用 diagnostics 既有的脱敏输出。
// 手工拼 ustar 而不引依赖：内容全是小文本，格式足够简单可控。
// 管理页渲染失败的兜底页（0.3.62）。
// 旧实现只 send(response, 500, '应用设置暂时无法加载') —— 一句纯文本，管理员
// **拿不到任何可排查的信息**。10-02 的 P15 事故正是如此：渲染因
// `ReferenceError: action is not defined` 抛错，界面只说"暂时无法加载"，
// 而同期 core 可能是好的，故障点其实在页面代码里。
// 这里至少给出：错误摘要、日志入口、以及不依赖管理页的恢复路径。
function managementFallbackPage(response, error, session) {
  const message = String((error && error.message) || error || '未知错误').slice(0, 400);
  const stack = String((error && error.stack) || '').split('\n').slice(0, 6).join('\n');
  const nonce = randomBytes(16).toString('base64');
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>设置页加载失败</title><style>`
    + `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#1c2333;font:15px/1.6 system-ui,sans-serif}`
    + `.card{max-width:640px;margin:20px;padding:26px;background:#fff;border:1px solid #e1e7f0;border-radius:14px}`
    + `h1{font-size:20px;margin:0 0 10px}.reason{padding:12px;background:#fdf2f2;border:1px solid #fecaca;border-radius:8px;font:13px/1.5 ui-monospace,monospace;word-break:break-all;white-space:pre-wrap}`
    + `.hint{color:#667085;font-size:13px}a{display:inline-block;margin:6px 8px 0 0;padding:9px 14px;border-radius:8px;background:#175cd3;color:#fff;text-decoration:none}`
    + `</style></head><body><main class="card"><h1>应用设置页加载失败</h1>`
    + `<p>DSH 核心可能仍然是好的 —— 出问题的是<b>设置页自身的渲染</b>。下面是具体错误：</p>`
    + `<p class="reason">${escapeHtml(message)}</p>`
    + (stack ? `<details><summary class="hint">堆栈（前 6 行）</summary><p class="reason">${escapeHtml(stack)}</p></details>` : '')
    + `<p class="hint">可尝试：刷新重试；或到「诊断日志」查看应用运行日志；或用下方的导出包交给外部排查。</p>`
    + `<p><a href="${gatewayDshPrefix}/">打开 DSH</a>`
    + `<a href="${gatewayManagePrefix}/logs?source=gateway">诊断日志</a>`
    + `<a href="${gatewayManagePrefix}/diagnostics-pack">导出诊断包</a></p>`
    + `</main></body></html>`;
  log('management_render_failed', { message });
  response.writeHead(500, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'`,
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

function diagnosticsPack(request, response) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parts = [];
  const push = (name, body) => parts.push({ name, buf: Buffer.from(String(body), 'utf8') });
  const snapshot = currentState();
  push('state.json', JSON.stringify(snapshot, null, 2));
  push('environment.txt', [
    `generated: ${new Date().toISOString()}`,
    `node: ${process.version}`,
    `platform: ${process.platform} ${process.arch}`,
    `appDir: ${__dirname}`,
    `dataDir: ${dataDir}`,
    `corePort: ${upstreamPort}`,
    `mode: ${snapshot.mode}`,
    `error: ${snapshot.error || '(none)'}`
  ].join('\n') + '\n');
  for (const [id, label] of diagnosticsUi.sources) {
    try { push(`${id}.log`, diagnostics.read(dataDir, id, 5000, false)); }
    catch (error) { push(`${id}.log`, `(读取失败: ${error.message})\n`); }
  }
  try {
    const reportDir = require('node:path').join(dataDir, 'startup-reports');
    if (require('node:fs').existsSync(reportDir)) {
      const newest = require('node:fs').readdirSync(reportDir).sort().pop();
      if (newest) push('startup-report.txt', require('node:fs').readFileSync(require('node:path').join(reportDir, newest), 'utf8'));
    }
  } catch { /* 启动报告是可选项 */ }

  const blocks = [];
  for (const part of parts) {
    const header = Buffer.alloc(512);
    const put = (offset, length, value) => header.write(String(value).slice(0, length).padEnd(length, '\0'), offset, length, 'utf8');
    put(0, 100, `dsh-diagnostics/${part.name}`);
    put(100, 8, '0000644\0');
    put(108, 8, '0000000\0');
    put(116, 8, '0000000\0');
    put(124, 12, part.buf.length.toString(8).padStart(11, '0') + '\0');
    put(136, 12, Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0');
    header.write('        ', 148, 8, 'utf8');
    header.write('0', 156, 1, 'utf8');
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
    blocks.push(header);
    const body = Buffer.alloc(Math.ceil(part.buf.length / 512) * 512);
    part.buf.copy(body);
    blocks.push(body);
  }
  blocks.push(Buffer.alloc(1024));
  const archive = Buffer.concat(blocks);
  response.writeHead(200, {
    'Content-Type': 'application/x-tar',
    'Content-Disposition': `attachment; filename="dsh-diagnostics-${stamp}.tar"`,
    'Content-Length': archive.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  log('diagnostics_pack', { bytes: archive.length, files: parts.length });
  response.end(archive);
}

function recoveryChecksResponse(response) {
  const info = require('./recovery-checks').inspect(dataDir, yamlModule);
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(info));
}
function handleGuide(request, response) {
  if (request.headers['x-trim-isadmin'] !== 'true') { log('guide_denied'); return send(response, 403, '仅 fnOS 管理员可打开。'); }
  if (request.method === 'GET' && request.url.split('?')[0] === `${gatewayManagePrefix}/preflight`) return recoveryChecksResponse(response);
  if (request.url.startsWith(`${gatewayDshPrefix}/`)) return proxyGuideDsh(request, response);
  if (request.method === 'GET' && request.url.split('?')[0] === `${gatewayManagePrefix}/state`) {
    const state = currentState();
    const ready = available();
    // ⚠ 0.3.73（A12）：把 operation（维护中的操作文案/进度）一并返回。
    // 原实现只给 mode，前端因此无法在维护期间更新"正在做什么"，
    // 横幅只能停在第一次渲染的文案上。
    response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return response.end(JSON.stringify({
      ok: ready,
      mode: state?.mode || 'unknown',
      operation: state?.operation && typeof state.operation === 'object' ? state.operation : null,
      automaticBackupDeferred: automaticBackups.publicDeferrals(state?.automaticBackupDeferred),
      bootId: state?.bootId || null,
      restartReceipt: state?.restartReceipt || null,
      updatedAt: state?.updatedAt || null,
      error: typeof state?.error === 'string' ? state.error.slice(0, 500) : null,
    }));
  }
  if (request.url === `${gatewayManagePrefix}/plugin-import`) return pluginImport(request, response, null, true);
  if (request.url === `${gatewayManagePrefix}/ai-chat`) return aiChat(request, response, null, true);
  if (request.url === `${gatewayManagePrefix}/action`) return managementAction(request, response, null, true);
  // 诊断包导出（0.3.62）：分级排障的最后一级出口。
  if (request.method === 'GET' && request.url === `${gatewayManagePrefix}/diagnostics-pack`) return diagnosticsPack(request, response);
  if (request.method === 'GET' && request.url.startsWith(`${gatewayManagePrefix}/logs`)) {
    const source = new URL(request.url, 'http://fnos.invalid').searchParams.get('source') || 'gateway';
    const url = request.url.replace(gatewayManagePrefix, '/app/dsh-fnos');
    request.url = url.replace('/app/dsh-fnos/logs', '/app/dsh-fnos/diagnostics');
    return guideLogsPage(request, response);
  }
  if (request.method === 'GET' && request.url.startsWith(`${gatewayManagePrefix}/`)) return guideManagementPage(request, response).catch((error) => managementFallbackPage(response, error, null));
  if (request.url === '/app/dsh-fnos/diagnostic') return browserDiagnostic(request, response);
  if (request.method === 'GET' && request.url.startsWith('/app/dsh-fnos/diagnostics')) return guideLogsPage(request, response);
  if (request.method !== 'GET' || !['/app/dsh-fnos', '/app/dsh-fnos/'].includes(request.url)) return send(response, 404, 'Not found');
  const fnosHost = network.fnosHost(request.headers.host);
  const ip = network.nasIpv4(fnosHost, os.networkInterfaces(), undefined, process.env.FNOS_NAS_IPV4);
  const mobileShell = /^localhost(?::\d+)?$/.test(fnosHost) || /Android|iPhone|iPad|Mobile/i.test(String(request.headers['user-agent'] || '')) || request.headers['sec-ch-ua-mobile'] === '?1';
  const gatewayMode = mobileShell || !network.hostIp(fnosHost);
  if (!fnosHost || (!ip && !gatewayMode)) { log('guide_invalid_host', { hasAddress: Boolean(ip), hasHost: Boolean(fnosHost) }); return send(response, 400, '无法确定 NAS 地址。请检查 NAS 网络设置后重试。'); }
  const ticket = randomBytes(32).toString('base64url');
  tickets.set(ticket, { ip, fnosHost, mobileShell, route: gatewayMode ? 'gateway' : 'direct', expires: Date.now() + 60_000 });
  // 降级票（0.3.62）：direct 模式下主 iframe 走 https://<ip>:3080（自签证书），
  // 若浏览器不信任该证书，iframe 与探测图**都会** ERR_CERT_AUTHORITY_INVALID，
  // 用户看到「无法加载 DSH 页面」。此时正确做法不是让用户去放行证书（fnOS 桌面
  // 是 HTTP 源，两个源的证书例外不共享，用户很难自己搞定），而是**自动切到
  // gateway 路由** —— `/app/dsh-fnos/dsh/` 由 fnOS 的 nginx 以同源 HTTP 反代到
  // guide socket，**完全不需要证书**。这里预先签一张 gateway 票备用。
  const gatewayTicket = !gatewayMode ? randomBytes(32).toString('base64url') : null;
  if (gatewayTicket) tickets.set(gatewayTicket, { ip, fnosHost, mobileShell, route: 'gateway', expires: Date.now() + 60_000 });
  const reportKey = randomBytes(32).toString('base64url');
  reportKeys.set(reportKey, { fnosHost, expires: Date.now() + 12 * 60 * 60_000 });
  const autoReportKey = randomBytes(32).toString('base64url');
  reportKeys.set(autoReportKey, { fnosHost, expires: Date.now() + 60_000 });
  const probeReportKey = randomBytes(32).toString('base64url');
  // Probe results are only ever reported from a direct-mode page; the condition
  // used to require mobileShell as well, which is impossible (mobileShell forces
  // gatewayMode), so the key was never registered and any report was rejected.
  if (!gatewayMode) reportKeys.set(probeReportKey, { fnosHost, expires: Date.now() + 60_000 });
  log('guide_opened', { fnosHost, mobileShell, route: gatewayMode ? 'gateway' : 'direct' });
  const appOrigin = ip ? `https://${ip}:${publicPort}` : '';
  const contentBase = gatewayMode ? gatewayDshPrefix : appOrigin;
  const scriptNonce = randomBytes(16).toString('base64url');
  const frameUrl = gatewayMode ? `${gatewayDshPrefix}/start?ticket=${ticket}` : `${appOrigin}/_fnos/start?ticket=${ticket}`;
  // Direct mode mounts the iframe immediately, so the page works even if the
  // script below never runs. The probe alongside it only decides whether to
  // swap in the guidance panel on failure; gating the mount on it would make
  // the happy path depend on JavaScript and add a round trip for nothing.
  const frameAttributes = `src="${frameUrl}"`;
  // Hidden until the side-band probe fails. Direct mode reaches the iframe
  // through https://<nas-ip>:3080, whose self-signed certificate cannot be
  // accepted from inside an iframe (the browser offers no "proceed" button
  // there) — the white screen users hit on a fresh NAS. Only desktop + IPv4
  // lands here: mobileShell forces gatewayMode, and domains have no hostIp.
  const connectionState = !gatewayMode ? `<main id="connection-state" class="connection-state" role="status" hidden><h1>无法加载 DSH 页面</h1><p>通常是浏览器尚未接受本机自签证书：从桌面图标进入时，证书提示位于 iframe 内，浏览器不允许在那里放行。</p><p>先在新标签页打开应用地址，在证书提示页点「高级 → 继续前往」，再回来点「重新检查」。若已信任仍失败，请检查 NAS 连通性与防火墙是否放行 ${publicPort} 端口。</p><p><a href="${appOrigin}/" target="_blank" rel="noopener noreferrer">打开应用地址</a><button type="button" id="connection-retry">重新检查</button></p></main>` : '';
  // 控制台悬浮窗的 DOM。**直接作为模板字符串常量**，不再用 body.replace 注入 ——
  // replace 依赖精确匹配，模板一改（比如插入 consoleScript）目标串就失配，
  // 面板会静默消失且没有任何报错。这里同时也把"强制刷新"确认框一并收进来，
  // 它们原本就都挂在 </iframe> 之后。

const consolePanelHtml = `<section id="boot-status" hidden role="status" aria-live="polite"><div class="bs-card"><div class="bs-spin" aria-hidden="true"></div><h2 id="bs-title">正在准备</h2><p id="bs-text">正在获取应用状态…</p><p id="bs-hint" class="bs-hint">维护耗时受数据量和磁盘速度影响，暂无法准确预计完成时间。DSH 服务可能暂时不可用；完成后会自动尝试恢复，请等待，无需重复操作。</p></div></section><section id="console-panel" hidden aria-label="页面控制台"><div id="console-head"><span>控制台</span><label class="cbx" title="只显示未识别的错误"><input type="checkbox" id="console-only-unknown">仅未知</label><button type="button" id="console-snapshot">记录卡顿现场</button><button type="button" id="console-copy">复制</button><button type="button" id="console-clear">清空</button><button type="button" id="console-close">关闭</button><span class="count" id="console-count">0</span></div><div id="console-toast" role="status" aria-live="polite" hidden></div><textarea id="console-snapshot-text" aria-label="独立连接诊断，可长按复制" style="min-height:120px;width:100%;box-sizing:border-box" hidden readonly></textarea><div id="console-log" role="log" aria-live="polite"><div id="console-empty">暂未捕获到日志。页面加载时与 iframe 内的错误会自动出现在这里。</div></div></section><dialog id="refresh-confirm" class="refresh-confirm" aria-labelledby="refresh-title"><h2 id="refresh-title">强制刷新 DSH？</h2><p>将重新加载 DSH 页面。当前未保存的输入可能丢失；DSH 核心不会重启。</p><form method="dialog"><button id="refresh-cancel" value="cancel">取消</button><button id="refresh-accept" class="confirm" value="refresh">强制刷新</button></form></dialog>`;

  // 手机版控制台悬浮窗（0.3.62）。
  // 起因：fnOS 手机版没有开发者工具，页面出错时用户完全无从取证（我们只能靠猜）。
  // 这里在外壳页提供一个控制台：捕获**本页**与 **iframe 内**的错误与 console
  // 输出，就地展示、可清空。
  //
  // 可行性：gatewayMode 下 iframe 与外壳**同源**（同一 host:port 的子路径），
  // 因此能读 contentWindow 并挂钩其 onerror / console。direct 模式是跨源
  // （https://<ip>:3080 对 http://<ip>:5666），拿不到，届时只显示本页日志。
  const consoleScript = `<script nonce="${scriptNonce}">
  (() => {
    const panel = document.getElementById('console-panel');
    const logBox = document.getElementById('console-log');
    const counter = document.getElementById('console-count');
    const openButton = document.getElementById('console-open');
    if (!panel || !logBox || !openButton) return;
    const MAX_ROWS = 300;
    var bootstrapHintFn = null;   // 引导失效提示（frame 声明后再赋值，避免 TDZ）
    // 日志分类（0.3.63，用户反馈）：控制台每天刷出上游已知的良性噪声
    // （引导时序、ResizeObserver 抑制警告、隧道重连 502 等），把真正的未知错误
    // 淹没。按特征打标：known=已知/上游/无害，界面灰显、可筛选、复制可只带未知。
    var KNOWN_PATTERNS = [
      { re: 'without inject', tag: '上游引导时序' },
      { re: 'Failed to load plugins', tag: '上游引导时序' },
      { re: 'ResizeObserver loop', tag: '浏览器抑制警告' },
      { re: 'connection lost, retry', tag: '连接重连中' },
      { re: 'already has an entry for key', tag: '上游槽位重复注册' },
      { re: 'slot entry crashed', tag: '上游槽位异常' },
      { re: 'HTTP 502', tag: '重启窗口内请求失败' },
      { re: 'usage persist open failed', tag: '上游存储未注册' },
      { re: 'Failed to load resource', tag: '资源加载失败' }
    ];
    var filterUnknownOnly = false;
    function classify(text) {
      for (var i = 0; i < KNOWN_PATTERNS.length; i++) if (text.indexOf(KNOWN_PATTERNS[i].re) >= 0) return KNOWN_PATTERNS[i];
      return null;
    }
    function countRows() {
      var total = 0, unknown = 0;
      var all = logBox.querySelectorAll('.row');
      for (var i = 0; i < all.length; i++) { total++; if (all[i].dataset.known === '0') unknown++; }
      return { total: total, unknown: unknown };
    }
    function updateCounter() {
      var c = countRows();
      counter.textContent = filterUnknownOnly ? (c.unknown + ' 未知') : (c.total + (c.unknown ? ' · ' + c.unknown + ' 未知' : ''));
      if (dropped) counter.textContent += ' · 已截断 ' + dropped + ' 条';
    }
    function applyFilter() {
      var all = logBox.querySelectorAll('.row');
      for (var i = 0; i < all.length; i++) all[i].hidden = filterUnknownOnly && all[i].dataset.known === '1';
      updateCounter();
    }
    window.__dshIframeLog = (kind, text) => render(kind, [text]);   // 早期捕获器的实时出口
    let rows = 0;
    const stamp = () => new Date().toISOString();
    // 批量渲染（0.3.62 性能）：插件 1.5s 级轮询会产生密集日志，逐条建 DOM +
    // scrollTop 赋值（强制同步排版）会在键盘切换的瞬间撞上重排峰值。改为
    // rAF 合并 —— 一帧内多条日志只排版一次；自动滚动仅在用户本就位于底部时
    // 执行（顺带解决"上翻查看时被拽回底部"）。
    const queue = [];
    const MAX_MESSAGE = 4096, MAX_QUEUE = 300, FLUSH_BATCH = 50;
    // 代表记录总数也受 DOM 上限约束，后台 rAF 暂停时照样聚合。
    const records = new Set(), aggregates = new Map();
    let dropped = 0;
    let flushQueued = false, flushGeneration = 0;
    let stick = true;
    function evict(item) {
      records.delete(item);
      if (item.key !== null) aggregates.delete(item.key);
      const pending = queue.indexOf(item);
      if (pending >= 0) queue.splice(pending, 1);
      item.queued = false;
      if (item.row) { delete item.row.__consoleRecord; item.row.remove(); item.row = null; rows -= 1; }
      dropped += item.count;
    }
    function scheduleFlush() {
      if (flushQueued) return;
      flushQueued = true;
      const generation = flushGeneration;
      requestAnimationFrame(() => { if (generation === flushGeneration) flushLogs(); });
    }
    logBox.addEventListener('scroll', () => { stick = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 24; }, { passive: true });
    function flushLogs() {
      flushQueued = false;
      if (!queue.length) return;
      const empty = document.getElementById('console-empty'); if (empty) empty.remove();
      const batch = queue.splice(0, FLUSH_BATCH);
      for (const item of batch) {
        item.queued = false;
        if (!records.has(item)) continue;
        if (!item.row) {
          const known = classify(item.text), row = document.createElement('div');
          row.className = 'row ' + item.kind + (known ? ' known' : ' unknown');
          row.dataset.known = known ? '1' : '0';
          row.dataset.severity = item.kind === 'error' ? 'error' : item.kind === 'warn' ? 'warning' : 'info';
          row.dataset.resolved = '0'; // recognized does not establish recovery.
          row.hidden = filterUnknownOnly && !!known;
          const time = document.createElement('span'); time.className = 't'; row.appendChild(time);
          const text = document.createElement('span'); text.textContent = item.text; row.appendChild(text);
          if (known) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = known.tag; row.appendChild(tag); }
          if (bootstrapHintFn) bootstrapHintFn(item.text);
          while (rows >= MAX_ROWS && logBox.firstChild) {
            const oldest = logBox.firstChild;
            if (oldest.__consoleRecord) evict(oldest.__consoleRecord);
            else { oldest.remove(); rows -= 1; dropped += 1; }
          }
          row.__consoleRecord = item;
          item.row = row;
          logBox.appendChild(row); rows += 1;
        }
        const row = item.row;
        row.dataset.first = item.first; row.dataset.last = item.last; row.dataset.count = String(item.count);
        row.querySelector('.t').textContent = item.first + (item.count > 1 ? ' → ' + item.last + ' ×' + item.count : ' ×1');
      }
      updateCounter();
      if (stick) logBox.scrollTop = logBox.scrollHeight;
      if (queue.length) scheduleFlush();
    }
    function render(kind, parts) {
      const text = parts.map(part => {
        if (part instanceof Error) return String(part.stack || part.message).slice(0, MAX_MESSAGE);
        if (typeof part === 'string') return part.slice(0, MAX_MESSAGE);
        try { return JSON.stringify(part).slice(0, MAX_MESSAGE); } catch { return String(part).slice(0, MAX_MESSAGE); }
      }).join(' ').slice(0, MAX_MESSAGE);
      const key = kind === 'error' || kind === 'warn' ? JSON.stringify([kind, text]) : null;
      const now = stamp();
      let item = key === null ? null : aggregates.get(key);
      if (item) { item.count += 1; item.last = now; }
      else {
        while (records.size >= MAX_ROWS) evict(records.values().next().value);
        item = { kind, text, key, first: now, last: now, count: 1, row: null, queued: false };
        records.add(item);
        if (key !== null) aggregates.set(key, item);
      }
      if (!item.queued) {
        if (queue.length >= MAX_QUEUE) evict(queue[0]);
        item.queued = true;
        queue.push(item);
      }
      scheduleFlush();
    }
    // 面板未打开时也照常收集 —— 用户点开时能看到之前发生的事。
    // 「仅未知」说明（0.3.64，用户反馈）：勾选时弹一次说明这是干什么的 ——
    // 首次勾选才弹（localStorage 记住），之后不再打扰；3.5 秒自动淡出。
    var onlyUnknownToastShown = false;
    function showOnlyUnknownToast() {
      var t = document.getElementById('console-toast');
      if (!t) return;
      t.innerHTML = '<strong>仅未知</strong>：只显示控制台<strong>没认出</strong>的日志。'
        + '本面板内置了已知问题的特征库（上游引导时序、浏览器抑制警告、隧道重连 502 '
        + '等），这些会被灰显并打上中文标签。勾选后它们被隐藏，'
        + '<strong>「复制」保留未恢复的error，即使它命中已知特征</strong>；已知不代表无害。';
      t.hidden = false;
      clearTimeout(t.__timer);
      t.__timer = setTimeout(function () { t.hidden = true; }, 6000);
    }
    document.getElementById('console-only-unknown').addEventListener('change', (e) => {
      filterUnknownOnly = e.target.checked;
      applyFilter();
      if (!filterUnknownOnly) logBox.scrollTop = logBox.scrollHeight;
      if (filterUnknownOnly && !onlyUnknownToastShown) {
        onlyUnknownToastShown = true;
        try { if (localStorage.getItem('dsh-console-only-unknown-seen') !== '1') { showOnlyUnknownToast(); localStorage.setItem('dsh-console-only-unknown-seen', '1'); } } catch { showOnlyUnknownToast(); }
      }
    });
    document.getElementById('console-clear').addEventListener('click', () => {
      for (const item of records) { if (item.row) delete item.row.__consoleRecord; item.row = null; item.queued = false; }
      records.clear(); aggregates.clear();
      logBox.textContent = '';
      queue.length = 0; dropped = 0;
      flushGeneration += 1; flushQueued = false;
      rows = 0;
      counter.textContent = '0';
      const empty = document.createElement('div');
      empty.id = 'console-empty';
      empty.textContent = '已清空。';
      logBox.appendChild(empty);
      updateCounter();
    });
    // 复制全部日志（0.3.62）：手机版没有开发者工具，用户要把日志发给排查方。
    // navigator.clipboard 只在 secure context 可用；我们走的是自签证书 HTTPS，
    // 用户未信任证书时它是 undefined —— 必须有 execCommand 降级，最后再把
    // 文本挂到 window 上兜底（用户可长按日志区手动选）。
    document.getElementById('console-snapshot').addEventListener('click', async () => {
      const btn = document.getElementById('console-snapshot');
      if (btn.disabled) return;
      btn.disabled = true;
      const report = { sampledAt: new Date().toISOString(), shell: { online: navigator.onLine, visibility: document.visibilityState } };
      try {
        const win = document.querySelector('iframe[name="dsh-frame"]').contentWindow;
        report.connection = typeof win.__dshConnectionSnapshot === 'function' ? win.__dshConnectionSnapshot() : { unavailable: '捕获器未安装，请刷新后复现' };
      } catch { report.connection = { unavailable: '跨源或 iframe 不可访问' }; }
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 5000);
      try {
        const statePath = location.pathname.startsWith('/app/dsh-fnos') ? '/app/dsh-fnos/manage/state' : '/__fnos/state';
        const res = await fetch(statePath + '?t=' + Date.now(), { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
        report.gateway = { status: res.status };
        if (res.status === 200 || res.status === 503) {
          const info = await res.json();
          report.gateway.mode = info.mode;
          report.gateway.coreAvailable = info.ok;
        }
      } catch { report.gateway = { unavailable: '状态请求失败或超时（不等于核心已停）' }; }
      finally { clearTimeout(timer); }
      const text = JSON.stringify(report, null, 2);
      const output = document.getElementById('console-snapshot-text');
      output.value = text; output.hidden = false;
      window.__dshConnectionReport = text;
      try { await navigator.clipboard.writeText(text); btn.textContent = '现场已复制'; }
      catch { btn.textContent = '现场已记录，请长按下方复制'; }
      btn.disabled = false;
    });
    document.getElementById('console-copy').addEventListener('click', async () => {
      const btn = document.getElementById('console-copy');
      // 从代表记录复制（含尚未渲染的项）；已知未恢复 error 不随筛选丢失。
      const lines = dropped ? ['[控制台容量截断：' + dropped + ' 条]'] : [];
      let skipped = 0;
      records.forEach((item) => {
        const known = classify(item.text);
        const resolved = item.row && item.row.dataset.resolved === '1';
        if (filterUnknownOnly && known && !(item.kind === 'error' && !resolved)) { skipped += 1; return; }
        lines.push('[first=' + item.first + ' last=' + item.last + ' count=' + item.count + ' kind=' + item.kind + '] ' + item.text + (known ? '  [' + known.tag + ']' : ''));
      });
      const text = lines.join('\\n') || (records.size ? '' : logBox.textContent.trim());
      const done = () => {
        btn.textContent = skipped > 0 ? '已复制（略过 ' + skipped + ' 条已知）' : '已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1800);
      };
      try {
        await navigator.clipboard.writeText(text);
        done();
      } catch {
        let ok = false;
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          ok = document.execCommand('copy');
          ta.remove();
        } catch { ok = false; }
        if (ok) { done(); }
        else {
          window.__dshConsoleText = text;   // 最后的兜底：手动取用
          btn.textContent = '请长按日志区手动复制';
          setTimeout(() => { btn.textContent = '复制'; }, 2500);
        }
      }
    });
    document.getElementById('console-close').addEventListener('click', () => {
      panel.hidden = true;
      openButton.setAttribute('aria-expanded', 'false');
    });
    openButton.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      openButton.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
      if (!panel.hidden) logBox.scrollTop = logBox.scrollHeight;
    });
    // ① 外壳页自身
    window.addEventListener('error', (event) => render('error', ['未捕获错误:', event.message, event.filename ? event.filename + ':' + event.lineno : '']));
    window.addEventListener('unhandledrejection', (event) => render('error', ['未处理的 Promise 拒绝:', event.reason]));
    for (const kind of ['log', 'info', 'warn', 'error']) {
      const original = console[kind].bind(console);
      console[kind] = (...parts) => { render(kind, parts); original(...parts); };
    }
    // ② iframe 内（仅同源可读；跨源时静默跳过）
    const frame = document.querySelector('iframe[name="dsh-frame"]');
    function attach() {
      let win = null;
      try { win = frame.contentWindow; } catch { win = null; }
      if (!win) return;
      try {
        // 用 onerror 而非 addEventListener：子页面每次导航都会重置监听，
        // onerror 在每次 load 后重新绑定，避免"刷新一次之后就不记录了"。
        if (win.__dshEarlyCapture) {
          // 网关已在该页面 <head> 最前装了捕获器：console 在客户端模块引用前就被
          // 包装（框架 import 时 bind 的也是我们的包装），error/rejection 用
          // addEventListener（客户端覆盖 onerror 影响不到）。这里只把钩子安装前
          // 积压的日志倒进面板，之后的日志经 __dshIframeLog 实时到达。
          const q = win.__dshEarlyLogs;
          if (q && q.length) { const items = q.splice(0, q.length); for (const item of items) render(item[0], [item[1]]); }
          render('info', ['已连接到 iframe 控制台。']);
          return;
        }
        // 旧路径兜底（早期捕获没装上时）。注意两个已知盲区：
        //   · win.onerror 可被页面自身覆盖（改用 addEventListener，无法被赋值冲掉）
        //   · 框架在 import 时捕获的原 console 引用，事后包装看不到
        win.addEventListener('error', (event) => render('error', ['iframe 未捕获错误:', event.message, event.filename ? event.filename + ':' + event.lineno : '']));
        const legacyOnError = (message, source, line, column, error) => {
          render('error', ['iframe 未捕获错误:', message, source ? source + ':' + line + ':' + column : '', error && error.stack ? error.stack : '']);
          return false;
        };
        win.onerror = legacyOnError;
        win.addEventListener('unhandledrejection', (event) => render('error', ['iframe 未处理的拒绝:', event.reason]));
        if (win.console && !win.console.__dshWrapped && !win.__dshEarlyCapture) {
          const wrapped = {};
          for (const kind of ['log', 'info', 'warn', 'error']) {
            const original = (win.console[kind] || win.console.log).bind(win.console);
            wrapped[kind] = (...parts) => { render(kind, parts); original(...parts); };
          }
          win.console.log = wrapped.log; win.console.info = wrapped.info;
          win.console.warn = wrapped.warn; win.console.error = wrapped.error;
          win.console.__dshWrapped = true;
        }
        render('info', ['已连接到 iframe 控制台。']);
      } catch (error) {
        // 区分「真跨源」与「时机/其它异常」——原先一律说跨源，误导排查。
        // 判据：读取 location.origin 是否抛 SecurityError。同源页在加载中也能读。
        let crossOrigin = false;
        try { void win.location.origin; } catch { crossOrigin = true; }
        if (crossOrigin) {
          render('warn', ['iframe 与外壳不同源，无法读取其内部错误（只显示本页日志）。']);
          return;
        }
        // 同源却失败 ⇒ 多为 iframe 尚未导航完成（首次 load 前的空白文档没有
        // __dshEarlyCapture，且 addEventListener 可能作用于被替换的 document）。
        // 这不是故障：load 事件会再次 attach。用 info 级别避免误报成警告。
        render('info', ['iframe 尚未就绪，稍后会自动重试挂载。']);
        // 保留原始原因，便于排查（不显示给用户，但留在日志里）
        if (error && error.message) render('info', ['挂载失败原因：' + error.message]);
      }
    }
    var bootstrapHintShown = false;
    bootstrapHintFn = (text) => {
      if (bootstrapHintShown) return;
      if (text.indexOf('without inject') < 0 && text.indexOf('Failed to load plugins') < 0) return;
      bootstrapHintShown = true;
      const row = document.createElement('div');
      row.className = 'row hint';
      const msg = document.createElement('span');
      msg.textContent = '启动时出现过会话注入错误（上游已知行为，通常会自动恢复）。若界面异常，可强制刷新。';
      row.appendChild(msg);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '强制刷新 DSH';
      b.addEventListener('click', () => {
        try { frame.contentWindow.location.reload(); }
        catch { location.reload(); }
      });
      row.appendChild(b);
      logBox.appendChild(row);
      rows += 1;
      counter.textContent = String(rows);
      logBox.scrollTop = logBox.scrollHeight;
    };
    // 就绪提示只输出一次（0.3.64）：attach 在 load 与首帧各调一次，
    // 加上重试会让「已连接到 iframe 控制台」刷屏。
    var attachedOnce = false;
    var pendingNoticeShown = false;
    frame.addEventListener('load', () => { attachedOnce = false; try { attach(); } catch { /* 忽略 */ } });
    attach();
    render('info', ['控制台已就绪。']);
    // 维护态提示（0.3.62，用户反馈）：gateway 模式原先没有任何状态显示 ——
    // 核心重启/维护期间用户只看到 iframe 白屏或报错，不知道程序在做什么。
    // 这里轮询 /__fnos/state（网关侧接口，不经过 core，核心停了也能答），
    // 非 ready 时盖一层说明「正在做什么 + 已用时 + 预计」，就绪自动撤除。
    (() => {
      const overlay = document.getElementById('boot-status');
      const title = document.getElementById('bs-title');
      const text = document.getElementById('bs-text');
      if (!overlay) return;
      let shown = false, startedAt = null;
      const apply = (info) => {
        if (!info || typeof info.mode !== 'string') return;
        const op = info.operation && typeof info.operation === 'object' ? info.operation : null;
        if (info.mode === 'ready' || info.mode === 'rollback') {
          if (shown) { overlay.hidden = true; shown = false; }
          return;
        }
        const label = { starting: '正在启动核心', maintenance: '自动维护模式，请等待', safe: '安全模式' }[info.mode] || info.mode;
        title.textContent = label;
        let line = op && op.text ? op.text : (info.error ? String(info.error) : '正在准备服务…');
        if (info.mode !== 'maintenance' && op && op.etaSeconds) line += '（预计约 ' + op.etaSeconds + ' 秒）';
        const opStart = op && op.startedAt ? Date.parse(op.startedAt) : NaN;
        if (Number.isFinite(opStart)) line += ' · 已用 ' + Math.max(0, Math.round((Date.now() - opStart) / 1000)) + ' 秒';
        else if (startedAt) line += ' · 本页已等待 ' + Math.max(0, Math.round((Date.now() - startedAt) / 1000)) + ' 秒';
        text.textContent = line;
        if (!shown) { overlay.hidden = false; shown = true; }
      };
      const tick = async () => {
        try {
          const statePath = location.pathname.startsWith('/app/dsh-fnos') ? '${gatewayManagePrefix}/state' : '/__fnos/state';
          const r = await fetch(statePath + '?t=' + Date.now(), { cache: 'no-store', credentials: 'same-origin' });
          if (!r.ok && r.status !== 503) { startedAt = startedAt || Date.now(); return; }
          const info = await r.json().catch(() => null);
          if (info && info.mode && info.mode !== 'ready') startedAt = startedAt || Date.now();
          if (info && info.mode === 'ready') startedAt = null;
          apply(info);
        } catch { startedAt = startedAt || Date.now(); }
      };
      tick();
      setInterval(tick, 3000);
    })();
    // 导航「更多」下拉（0.3.62）：开合、点外关闭、选中后收起；
    // 「诊断」= 记录 frame report（#diagnose 既有绑定）+ 跳转日志页。
    const navMore = document.getElementById('nav-more');
    const navMenu = document.getElementById('nav-menu');
    if (navMore && navMenu) {
      const setMenu = (open) => { navMenu.hidden = !open; navMore.setAttribute('aria-expanded', String(open)); };
      navMore.addEventListener('click', (e) => { e.stopPropagation(); setMenu(navMenu.hidden); });
      document.addEventListener('click', (e) => { if (!navMenu.hidden && !navMenu.contains(e.target) && e.target !== navMore) setMenu(false); });
      navMenu.addEventListener('click', (e) => { if (e.target.closest('a,button')) setMenu(false); });
    }
    const diagBtn = document.getElementById('diagnose');
    if (diagBtn) diagBtn.addEventListener('click', () => { try { frame.contentWindow.location.href = '/app/dsh-fnos/diagnostics'; } catch {} });
  })();
  </script>`;
  let body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-visual"><title>DeepSeek Harness</title><style>*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0}body{display:flex;flex-direction:column;background:#101828;color:#fff;font:14px system-ui,sans-serif}header{min-height:48px;padding:7px 14px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #344054}strong{white-space:nowrap}nav{margin-left:auto;display:flex;gap:8px}a{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:5px 12px;border:1px solid #475467;border-radius:7px;color:#fff;text-decoration:none;white-space:nowrap}a:hover,a:focus-visible{background:#344054}a.settings{order:10;background:#175cd3;border-color:#175cd3}a.settings:hover,a.settings:focus-visible{background:#1248a4}nav button{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:5px 12px;border:1px solid #475467;border-radius:7px;background:transparent;color:#fff;font:inherit;white-space:nowrap;cursor:pointer}nav button:hover,nav button:focus-visible{background:#344054}[hidden]{display:none!important}iframe{flex:1;width:100%;min-height:0;border:0;background:#fff}.connection-state{flex:1;display:grid;align-content:center;justify-items:center;padding:24px;text-align:center;background:#f5f7fb;color:#1c2333}.connection-state h1{font-size:20px;margin:0 0 12px}.connection-state p{max-width:420px;line-height:1.6;margin:0 0 12px}.connection-state a,.connection-state button{margin:5px;padding:9px 14px;color:#fff;background:#175cd3;border:0;border-radius:8px;text-decoration:none;font:inherit}</style></head><body><header><strong>DeepSeek Harness</strong><nav aria-label="应用导航"><button type="button" id="console-open" aria-haspopup="dialog" aria-expanded="false">控制台</button><a id="dsh-nav"  href="${contentBase}/" target="dsh-frame">刷新 DSH</a><a id="settings-nav"  class="settings" href="${gatewayMode ? gatewayManagePrefix : `${appOrigin}/__fnos`}/" target="dsh-frame">应用设置</a></nav></header>${connectionState}<iframe name="dsh-frame" title="DeepSeek Harness 内容" ${frameAttributes} allow="clipboard-read; clipboard-write"></iframe>${consoleScript}</body></html>`;
  body = body.replace('>刷新 DSH</a>', '>强制刷新 DSH</a>')
    .replace('</head>', '<style>dialog.refresh-confirm{max-width:min(92vw,420px);padding:24px;border:1px solid #475467;border-radius:12px;background:#1d2939;color:#fff;box-shadow:0 20px 60px #0008}dialog.refresh-confirm::backdrop{background:#0009}dialog.refresh-confirm h2{margin:0 0 10px;font-size:20px}dialog.refresh-confirm p{line-height:1.6}dialog.refresh-confirm form{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}dialog.refresh-confirm button{padding:9px 16px;border:1px solid #667085;border-radius:7px;background:#344054;color:#fff;font:inherit;cursor:pointer}dialog.refresh-confirm button.confirm{background:#175cd3;border-color:#175cd3}</style></head>')
    .replace('</head>', '<style>#console-panel{position:fixed;left:0;right:0;bottom:0;max-height:60vh;display:flex;flex-direction:column;background:#0b1220f7;color:#e4e7ec;border-top:1px solid #344054;z-index:60}#console-panel[hidden]{display:none}#boot-status{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#101828f2;color:#e4e7ec;z-index:90;padding:24px}#boot-status[hidden]{display:none}#boot-status .bs-card{max-width:340px;text-align:center}#boot-status h2{font-size:17px;margin:14px 0 8px}#boot-status p{margin:0;font-size:13px;line-height:1.6;color:#98a2b3}#boot-status .bs-hint{margin-top:12px;font-size:12px;color:#667085}#boot-status .bs-spin{width:30px;height:30px;margin:0 auto;border:3px solid #344054;border-top-color:#4ebdff;border-radius:50%;animation:bs-spin .9s linear infinite}@keyframes bs-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){#boot-status .bs-spin{animation:none}}#console-log .row.known{opacity:.55}#console-log .row .tag{display:inline-block;margin-left:6px;padding:1px 6px;border:1px solid #475467;border-radius:5px;font-size:11px;color:#98a2b3;white-space:nowrap}#console-head .cbx{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#98a2b3;cursor:pointer;user-select:none}#console-head .cbx input{accent-color:#4ebdff;margin:0}#console-toast{position:absolute;left:12px;right:12px;bottom:12px;padding:10px 12px;background:#1d2939;border:1px solid #475467;border-radius:10px;box-shadow:0 12px 30px #000a;font-size:12px;line-height:1.6;color:#e4e7ec;z-index:5}#console-toast[hidden]{display:none}#console-toast strong{color:#4ebdff}#console-panel{position:relative}#console-log .row.hint{color:#98a2b3;display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-top:1px dashed #344054;padding-top:6px;margin-top:6px}#console-log .row.hint button{padding:2px 10px;border:1px solid #475467;border-radius:6px;background:transparent;color:#e4e7ec;font:inherit;cursor:pointer}header{position:relative}.nav-more{position:relative;display:flex}#nav-more{display:inline-flex;align-items:center;justify-content:center;min-height:32px;min-width:48px;padding:5px 10px;border:1px solid #475467;border-radius:7px;background:transparent;color:#fff;font-size:13px;cursor:pointer}#nav-menu{position:absolute;top:calc(100% + 6px);right:0;min-width:180px;background:#1d2939;border:1px solid #475467;border-radius:10px;padding:6px;display:flex;flex-direction:column;gap:4px;box-shadow:0 14px 34px #000a;z-index:70}#nav-menu[hidden]{display:none}#nav-menu a,#nav-menu button{display:block;width:100%;text-align:left;min-height:38px;padding:9px 12px;border:0;border-radius:7px;background:transparent;color:#fff;font-size:13px;text-decoration:none;white-space:nowrap;cursor:pointer}#nav-menu a:hover,#nav-menu button:hover,#nav-menu a:focus-visible,#nav-menu button:focus-visible{background:#344054}nav a,nav button{font-size:13px!important}#console-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #344054;font-weight:600}#console-head .count{margin-left:auto;font-weight:400;color:#98a2b3;font-size:12px}#console-head button{padding:5px 10px;border:1px solid #475467;border-radius:6px;background:transparent;color:#e4e7ec;font:inherit;cursor:pointer}#console-head button:hover{background:#344054}#console-log{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;margin:0;padding:8px 12px 16px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}#console-log .row{padding:4px 0;border-bottom:1px solid #1d2939}#console-log .row.error{color:#fda29b}#console-log .row.warn{color:#fec84b}#console-log .row.info{color:#84caff}#console-log .row.log{color:#d0d5dd}#console-log .t{color:#667085;margin-right:6px}#console-empty{color:#667085;padding:12px 0}</style></head>')
      // ⚠ 面板**必须**注入在 consoleScript 之前（0.3.62 修复）。
      // 脚本第一件事就是 getElementById('console-panel'/'console-log')，
      // 拿不到就 `if (!panel || ...) return` 静默退出 —— 表现为「按钮点了没反应」。
      // 早先注入到 </body> 前（页面末尾），脚本先执行时面板还不存在，正是此故。
      .replace('allow="clipboard-read; clipboard-write"></iframe>', 'allow="clipboard-read; clipboard-write"></iframe>' + consolePanelHtml);
  const clientScript = `<script nonce="${scriptNonce}">
  const button = document.getElementById('diagnose');
  function diagnosticReport(key, trigger, connection) {
    let referrerOrigin = null;
    try { referrerOrigin = new URL(document.referrer).origin; } catch {}
    return { key, trigger, connection, ancestors: location.ancestorOrigins ? Array.from(location.ancestorOrigins) : [], referrerOrigin, platform: /Android/i.test(navigator.userAgent) ? 'android' : /iPhone|iPad/i.test(navigator.userAgent) ? 'ios' : 'other' };
  }
  async function sendDiagnostic(key, trigger, connection) {
    return fetch('/app/dsh-fnos/diagnostic', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(diagnosticReport(key, trigger, connection)), credentials: 'same-origin' });
  }
  setTimeout(() => { void sendDiagnostic('${autoReportKey}', 'auto').catch(() => {}); }, 350);
  button.addEventListener('click', async () => {
    button.disabled = true; button.textContent = '记录中'; button.classList.add('is-working'); button.setAttribute('aria-busy', 'true');
    try {
      const reply = await sendDiagnostic('${reportKey}', 'manual');
      button.textContent = reply.ok ? '诊断已记录' : '诊断失败 (' + reply.status + ')';
      if (!reply.ok) button.disabled = false;
    } catch { button.textContent = '诊断请求失败'; button.disabled = false; }
    finally { button.classList.remove('is-working'); button.removeAttribute('aria-busy'); }
  });
  </script>`;
  const navScript = `<script nonce="${scriptNonce}">
  const dshNav = document.getElementById('dsh-nav');
  const settingsNav = document.getElementById('settings-nav');
  const logsNav = document.getElementById('logs-nav');
  const refreshConfirm = document.getElementById('refresh-confirm');
  let activeView = 'dsh';
  function setView(view) {
    // Cancel a pending/failed connectivity probe and bring the frame back:
    // every view switch navigates the frame, so a stale failure state must not
    // keep it hidden (the hook exists only in direct mode).
    window.__dshNavigation?.();
    activeView = view; dshNav.textContent = view === 'dsh' ? '强制刷新 DSH' : '返回 DSH';
  }
  function hardRefreshDsh() {
    const frame = document.querySelector('iframe[name="dsh-frame"]');
    const url = new URL(dshNav.href, location.href);
    url.searchParams.set('__fnos_refresh', Date.now().toString(36));
    frame.src = url.href;
    setView('dsh');
  }
  dshNav.addEventListener('click', (event) => {
    if (activeView !== 'dsh') { setView('dsh'); return; }
    event.preventDefault();
    if (typeof refreshConfirm.showModal === 'function') refreshConfirm.showModal();
    else if (window.confirm('强制刷新 DSH？未保存的输入可能丢失。')) hardRefreshDsh();
  });
  document.getElementById('refresh-accept').addEventListener('click', hardRefreshDsh);
  settingsNav.addEventListener('click', () => setView('settings'));
  if (logsNav) logsNav.addEventListener('click', () => setView('settings'));   // 元素已并入「更多」菜单（0.3.62）
  window.addEventListener('message', (event) => {
    if (event.source !== document.querySelector('iframe[name="dsh-frame"]').contentWindow || event.origin !== ${gatewayMode ? 'location.origin' : `'${appOrigin}'`}) return;
    if (event.data?.type === 'dsh-fnos-view' && ['dsh', 'settings'].includes(event.data.view)) setView(event.data.view);
  });
  </script>`;
  const connectionScript = !gatewayMode ? `<script nonce="${scriptNonce}">
  const connectionState = document.getElementById('connection-state');
  const frame = document.querySelector('iframe[name="dsh-frame"]');
  const probe = new Image();
  let settled = false;
  // 自动降级（0.3.62）：direct 模式的 iframe 指向 https://<ip>:3080（自签证书）。
  // 浏览器不信任该证书时（控制台 ERR_CERT_AUTHORITY_INVALID），iframe 与探测图
  // 同时失败。**不要**让用户去自己放行证书——fnOS 桌面是 http://<ip>:5666 源，
  // 与 https://<ip>:3080 不是同一个源，证书例外不共享，用户几乎不可能自己搞定。
  // 改用 gateway 路由：由 nginx 以**同源 HTTP** 反代，不需要任何证书。
  // 只有在降级也失败时才显示指引面板。
  let triedFallback = false;
  // ⚠ timer 必须在 failure **之前**声明：failure 内部引用它，若声明在后会形成
  // TDZ（Cannot access 'timer' before initialization）——今天在 supervisor 的
  // 看门狗里踩过同一个坑。这里显式前置。注意：这段在模板字符串里，
  // 注释中不能出现反引号，否则会提前闭合模板。
  let timer = null;
  // 降级路径的独立计时器（A20）：必须持有句柄，成功加载时才能取消。
  let fallbackTimer = null;
  const failure = () => {
    if (settled) return;
    if (!triedFallback) {
      triedFallback = true;
      // 保留探测结果上报（连接不可达），便于日志区分「证书问题」与「网络不通」
      void sendDiagnostic('${probeReportKey}', 'probe', 'unreachable').catch(() => {});
      // 换到 gateway 路由重挂 iframe；新票已在服务端签好，与 direct 票分开。
      // ⚠ 0.3.73（A20）：降级计时器必须**存句柄**并置 settled。
      // 原实现只 clearTimeout(timer)，清的却是已经触发过的旧计时器（无效），
      // 新建的 6 秒计时器没人持有，也从不把 settled 置真 ⇒ 即使 gateway 路由
      // 已经成功加载，6 秒后仍会把 iframe 隐藏、显示"连接失败"面板。
      frame.onload = () => {
        if (settled) return;
        // 同源降级的HTTP错误/登录页也会load；只有DSH注入的boot文档才算连接恢复。
        let isDshDocument = false;
        try { isDshDocument = Boolean(frame.contentWindow && frame.contentWindow.__DSH_BOOT__); } catch {}
        if (!isDshDocument) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(fallbackTimer);
        frame.onload = null;
        frame.hidden = false;
        connectionState.hidden = true;
      };
      frame.src = '${gatewayDshPrefix}/start?ticket=${gatewayTicket || ''}';
      // 给降级留出足够时间；仍失败才显示面板。
      fallbackTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        frame.hidden = true;
        connectionState.hidden = false;
      }, 6000);
      return;
    }
    settled = true;
    probe.onload = probe.onerror = null;
    // Swap to the guidance panel before reporting: a failed diagnostic
    // report must never be what keeps the visitor staring at a blank frame.
    frame.hidden = true;
    connectionState.hidden = false;
    void sendDiagnostic('${probeReportKey}', 'probe', 'unreachable').catch(() => {});
  };
  timer = setTimeout(failure, 6000);
  // Any view switch must cancel a pending probe and restore the frame: once
  // the visitor navigates somewhere else, a late failure must never hide the
  // content they asked for, and a panel left over from an earlier failure must
  // not cover a page that now loads fine.
  window.__dshNavigation = () => {
    settled = true;
    clearTimeout(timer);
    clearTimeout(fallbackTimer);
    frame.onload = null;
    connectionState.hidden = true;
    frame.hidden = false;
  };
  document.getElementById('connection-retry').onclick = () => location.reload();
  probe.onload = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    void sendDiagnostic('${probeReportKey}', 'probe', 'reachable').catch(() => {});
    // The frame is already mounted and must not be assigned again: the
    // ticket it carries is single-use, a second request gets 403.
  };
  probe.onerror = failure;
  probe.src = '${appOrigin}/_fnos/reachability.svg?check=' + Date.now();
  </script>` : '';
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; img-src ${appOrigin || "'self'"}; frame-src 'self'${appOrigin ? ` ${appOrigin}` : ''}; base-uri 'none'; form-action 'none'`
  });
  response.end(body.replace('<nav aria-label="应用导航"><button type="button" id="console-open"', '<nav aria-label="应用导航"><div class="nav-more"><button type="button" id="nav-more" aria-haspopup="true" aria-expanded="false">更多 ▾</button><div id="nav-menu" hidden><button type="button" id="console-open"').replace('</button><a id="dsh-nav"', '</button><button type="button" id="diagnose">诊断（记录并查看）</button></div></div><a id="dsh-nav"').replace('</body>', `${clientScript}${navScript}${connectionScript}</body>`).replace('</style>', 'button{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:5px 12px;border:1px solid #475467;border-radius:7px;color:#fff;background:transparent;font:inherit;cursor:pointer}button:hover,button:focus-visible{background:#344054}button.is-working{position:relative;isolation:isolate;box-shadow:0 0 0 1px #77cfff,0 0 9px #4ebdff55}button.is-working::after{content:"";position:absolute;inset:-2px;border-radius:inherit;padding:2px;background:conic-gradient(from 0deg,transparent 0deg 250deg,#50baff 295deg,#f3fcff 324deg,#75d2ff 340deg,transparent 360deg);-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:edge-spin 1.35s linear infinite;pointer-events:none}@keyframes edge-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){button.is-working::after{animation:none;background:#84d6ff}}@media(max-width:420px){header{padding:6px;gap:5px}strong{display:none}nav{gap:4px}a,button{padding:5px 7px;font-size:12px}}</style>'));
}

async function main() {
  const keyFile = `${dataDir}/tls.key`;
  const certFile = `${dataDir}/tls.crt`;
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    const ips = Object.values(os.networkInterfaces()).flat().filter((item) => item && item.family === 'IPv4' && !item.internal).map((item) => item.address);
    const cert = await selfsigned.generate([{ name: 'commonName', value: 'DeepSeek Harness fnOS' }], {
      days: 3650, keySize: 2048, algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: ips.map((ip) => ({ type: 7, ip })) }]
    });
    fs.writeFileSync(keyFile, cert.private, { mode: 0o600 });
    fs.writeFileSync(certFile, cert.cert, { mode: 0o600 });
  }
  tlsOptions = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  try {
    publicServer = await serveHttps(publicPort);
    if (publicPort !== manifestPort) {
      try { aliasServer = await serveHttps(manifestPort); }
      catch (error) { log('alias_listen_failed', { port: manifestPort, code: error.code }); }
    }
    console.log(`fnOS HTTPS gateway on ${publicPort}${aliasServer ? ` (alias ${manifestPort})` : ''}`);
  } catch (error) {
    console.error(`cannot listen on ${publicPort}: ${error.code}; falling back to manifest port ${manifestPort}`);
    publicPort = manifestPort;
    ops.savePorts(dataDir, { publicPort: null });
    publicServer = await serveHttps(publicPort);
    console.log(`fnOS HTTPS gateway on ${publicPort}`);
  }
  try { fs.unlinkSync(guideSocket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  guideServer = http.createServer(handleGuide);
  guideServer.on('upgrade', upgradeGuideDsh);
  guideServer.listen(guideSocket, () => {
    if (process.platform !== 'win32') fs.chmodSync(guideSocket, 0o660);
    console.log(`fnOS guide socket ready: ${guideSocket}`);
  });
  process.on('SIGTERM', () => {
    networkDebug.stop();
    publicServer?.close();
    aliasServer?.close();
    guideServer.close(() => fs.rmSync(guideSocket, { force: true }));
    // Closing listeners alone does not end this process: the IPC channel to
    // the supervisor stays open, so the process lingers and the supervisor —
    // which only restarts a child that has exited — never does. Detach and
    // exit once the listeners are down, with a hard deadline in case a live
    // connection would otherwise hold the process open.
    const finish = () => {
      process.removeListener('disconnect', finish);
      process.exit(0);
    };
    process.once('disconnect', finish);
    if (process.connected) process.disconnect();
    setTimeout(finish, 3_000).unref();
  });
}

// 启动失败必须**真正退出**（0.3.62，P13）。
//
// 旧写法只设 `process.exitCode = 1` —— 它只是"下次自然退出时的返回码"，
// **不会结束进程**。而 main() 失败前可能已经建好了部分句柄（guide socket、
// 未关闭的 server、定时器……），事件循环因此不会排空，进程就活了下来：
// 表现为**两个 gateway 同时存在**（一个服务中、一个僵尸），
// 而僵尸仍占着 3080 ⇒ 应用中心点「启用」报**端口被占用**（10-02 实测踩到）。
//
// 正确做法：设置返回码后显式 exit，并给日志一点刷盘时间。
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  // 先尝试优雅关闭已知句柄，再强制退出；避免 exit 打断未 flush 的 stdout。
  for (const srv of [publicServer, aliasServer, guideServer]) { try { srv?.close?.(); } catch { /* 未成功监听时不存在 */ } }
  const force = setTimeout(() => process.exit(1), 1500);
  force.unref?.();
  // 若事件循环能自然排空，让 Node 自己干净退出；否则 1.5 秒后兜底强杀。
});