const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const selfsigned = require('selfsigned');
const ops = require('./ops.js');
const cores = require('./core-manager.js');
const profiles = require('./profiles.js');
const diagnostics = require('./diagnostics.js');
const managementUi = require('./management-page.js');
const diagnosticsUi = require('./diagnostics-page.js');
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
let publicServer = null;
let aliasServer = null;
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
function serveHttps(port) {
  return new Promise((resolve, reject) => {
    const server = https.createServer(tlsOptions, handlePublic);
    server.on('upgrade', handleUpgrade);
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      server.on('error', (error) => log('public_listen_error', { port, code: error.code }));
      resolve(server);
    });
  });
}

async function applyPublicPort(port, callback) {
  try {
    if (port === publicPort) { callback(null); return; }
    const next = await serveHttps(port);
    const retiring = [publicServer, aliasServer].filter(Boolean);
    publicPort = port;
    publicServer = next;
    aliasServer = null;
    if (port !== manifestPort) {
      try { aliasServer = await serveHttps(manifestPort); }
      catch (error) { log('alias_listen_failed', { port: manifestPort, code: error.code }); }
    }
    for (const server of retiring) server.close();
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
const reportKeys = new Map();
const guideCsrf = new Map();
const gatewayDshPrefix = '/app/dsh-fnos/dsh';
const gatewayManagePrefix = '/app/dsh-fnos/manage';
const pluginUrlCompat = fs.readFileSync(require.resolve('./plugin-url-compat.js'));
const cookieName = '__Host-fnos_dsh';
const log = diagnostics.logger(dataDir, 'gateway');
const networkDebug = createNetworkDebug(dataDir, currentState, log, executeNetworkDebugCommand);

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
    ...(/^dsh-[a-z0-9-]{1,63}$/.test(firstSegment) ? { pluginRoute: firstSegment } : {})
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of tickets) if (value.expires < now) tickets.delete(key);
  for (const [key, value] of sessions) if (value.expires < now) sessions.delete(key);
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
  const session = sessions.get(value);
  if (!session || session.expires < Date.now()) { sessions.delete(value); return null; }
  return session;
}

function currentState() { return ops.readJson(ops.dataPath(dataDir, 'state.json'), { mode: 'starting' }); }
function available() { return ['ready', 'rollback'].includes(currentState().mode); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function managementPage(request, response, session) {
  const nonce = randomBytes(16).toString('base64');
  const body = managementUi.render(dataDir, currentState(), session, request.url, dshPath(), nonce, networkDebug.status(), await dockerAccess.inspect(dataDir), portInfo());
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; ${framePolicy(session)}`.trim(), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
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
    process.send({ type: 'command', id, action, backupId: params.get('backupId'), version: params.get('version'), registry: params.get('registry'), profile: params.get('profile'), packageName: params.get('packageName'), dockerMode: params.get('dockerMode'), corePort: params.get('corePort'), publicPort: params.get('publicPort'), dailyLimit: params.get('dailyLimit'), manualLimit: params.get('manualLimit'), upgradeLimit: params.get('upgradeLimit'), dailyMode: params.get('dailyMode') });
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

async function managementAction(request, response, session, guide = false) {
  if (request.method !== 'POST') return send(response, 405, 'Method not allowed');
  let body = '';
  for await (const chunk of request) { body += chunk; if (body.length > 4096) return send(response, 413, 'Request too large'); }
  const params = new URLSearchParams(body);
  if (guide) {
    const token = params.get('csrf');
    const record = token && guideCsrf.get(token);
    if (!record || record.expires < Date.now() || record.user !== String(request.headers['x-trim-userid'] || '')) return send(response, 403, 'Invalid CSRF token');
    session = record;
  }
  if (params.get('csrf') !== session.csrf) return send(response, 403, 'Invalid CSRF token');
  const action = params.get('action');
  if (!['backup', 'restore', 'retry', 'safe-mode', 'check-update', 'install-core', 'switch-core', 'set-registry', 'set-backup-settings', 'set-docker-mode', 'set-core-port', 'set-public-port', 'create-profile', 'switch-profile', 'install-plugin', 'disable-plugin', 'enable-plugin', 'uninstall-plugin', 'use-bundled', 'probe-workspace', 'start-network-debug', 'stop-network-debug', 'allow-plugin-path', 'dismiss-plugin-path', 'revoke-plugin-path'].includes(action)) return send(response, 400, 'Unknown action');
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
    } else {
      const result = await command(action, params);
      notice = result?.warning || '操作已完成';
    }
    log('admin_action_succeeded', { action });
  }
  catch (error) { notice = `操作失败：${error.message}`; log('admin_action_failed', { action }); }
  const view = managementUi.selectedView(params.get('view'));
  response.writeHead(303, { Location: `${guide ? gatewayManagePrefix + '/' : '/__fnos/'}?view=${view}&notice=${encodeURIComponent(notice)}`, 'Cache-Control': 'no-store' });
  response.end();
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return request.headers['sec-fetch-site'] !== 'cross-site';
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
  return request.headers['sec-fetch-dest'] === 'iframe' && ['/', '/__fnos/'].includes(request.url);
}

function managementNavigation(request) {
  if (request.method !== 'GET' || !request.url.startsWith('/__fnos/')) return false;
  if (request.headers.origin && request.headers.origin !== 'null') return false;
  if (request.headers['sec-fetch-mode'] && request.headers['sec-fetch-mode'] !== 'navigate') return false;
  return !request.headers['sec-fetch-dest'] || ['document', 'iframe'].includes(request.headers['sec-fetch-dest']);
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
  sessions.set(session, { expires: Date.now() + 12 * 60 * 60 * 1000, entryUntil: Date.now() + 60_000, csrf: randomBytes(32).toString('base64url'), fnosHost: record.fnosHost, nasIp: record.ip, mobileShell: record.mobileShell });
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

function handlePublic(request, response) {
  // A credential-free pixel lets the fnOS mobile shell check whether its own
  // WebView can reach the separate HTTPS port before navigating an iframe.
  if (request.method === 'GET' && request.url.startsWith('/_fnos/reachability.svg?')) {
    const pixel = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
    response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': Buffer.byteLength(pixel), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    return response.end(pixel);
  }
  if (request.url === '/_fnos/diagnostic') return browserDiagnostic(request, response);
  if (request.url.startsWith('/__fnos/action')) {
    const session = cookieSession(request);
    if (!session) { log('session_missing'); return send(response, 401, '请从 fnOS 桌面图标打开 DeepSeek Harness。'); }
    return managementAction(request, response, session);
  }
  if (!sameOrigin(request) && !entryNavigation(request) && !(cookieSession(request) && managementNavigation(request))) {
    log('origin_denied', { method: request.method, area: request.url.startsWith('/__fnos/') ? 'management' : 'dsh', origin: request.headers.origin === 'null' ? 'opaque' : request.headers.origin ? 'cross' : 'absent', fetchSite: String(request.headers['sec-fetch-site'] || '').slice(0, 24) });
    return send(response, 403, 'Origin denied');
  }
  if (request.url.startsWith('/_fnos/start?')) return startTicket(request, response);
  const session = cookieSession(request);
  if (!session) { log('session_missing'); return send(response, 401, '请从 fnOS 桌面图标打开 DeepSeek Harness。'); }
  if (request.url.startsWith('/__fnos/')) {
    if (request.url.startsWith('/__fnos/action')) return managementAction(request, response, session);
    if (request.url.startsWith('/__fnos/logs')) return request.method === 'GET' ? logsPage(request, response, session) : send(response, 405, 'Method not allowed');
    if (request.method === 'GET') return managementPage(request, response, session).catch(() => send(response, 500, '应用设置暂时无法加载'));
    return send(response, 405, 'Method not allowed');
  }
  if (!available()) {
    if (request.method !== 'GET' || !['/', '/index.html'].includes(request.url)) return send(response, 503, 'DSH 核心暂不可用');
    const nonce = randomBytes(16).toString('base64');
    const unavailableState = currentState();
    const reason = unavailableState?.error ? String(unavailableState.error).slice(0, 500) : '';
    const statusText = { starting: '正在启动', maintenance: '维护中（可能正在自动重启）', safe: '启动失败或已停止' }[unavailableState?.mode] || '未就绪';
    response.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; ${framePolicy(session)}`.trim(), 'X-Content-Type-Options': 'nosniff' });
    return response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 暂不可用</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#1c2333;font:16px system-ui,sans-serif}.card{max-width:520px;margin:20px;padding:28px;background:white;border:1px solid #e1e7f0;border-radius:14px}h1{font-size:22px}p{line-height:1.6}.reason{margin-top:14px;padding:12px;background:#fdf2f2;border:1px solid #fecaca;border-radius:8px;font:13px/1.5 ui-monospace,monospace;word-break:break-all}.status{display:inline-block;margin:0 0 8px;padding:2px 10px;border-radius:99px;background:#eef2f7;font-size:13px}button,a{display:inline-block;margin:6px 8px 0 0;padding:10px 14px;border:0;border-radius:8px;background:#175cd3;color:white;font:inherit;text-decoration:none;cursor:pointer}</style></head><body><main class="card"><h1>DSH 核心暂不可用</h1><span class="status">${escapeHtml(statusText)}</span><p>页面每 5 秒自动检查一次。也可以立即刷新，或进入应用设置修复插件与配置。</p>${reason ? `<p class="reason">${escapeHtml(reason)}</p>` : ''}<button id="refresh" type="button">立即刷新</button><a href="/__fnos/?view=runtime">应用设置</a></main><script nonce="${nonce}">document.getElementById('refresh').onclick=()=>location.reload();setTimeout(()=>location.reload(),5000)</script></body></html>`);
  }
  const upstream = http.request({
    host: '127.0.0.1', port: upstreamPort, method: request.method,
    path: request.url, headers: upstreamHeaders(request)
  }, (reply) => {
    if (reply.statusCode >= 400) log('upstream_http_error', upstreamErrorDetails(request, request.url, reply.statusCode, 'public'));
    response.writeHead(reply.statusCode, frameHeaders(reply.headers, session));
    reply.pipe(response);
  });
  upstream.on('error', () => {
    log('upstream_error');
    if (!response.headersSent) send(response, 502, 'dsh 未就绪。');
    else response.destroy();
  });
  request.pipe(upstream);
}

function handleUpgrade(request, socket, head) {
  if (!sameOrigin(request) || !cookieSession(request) || !available()) { socket.destroy(); return; }
  const upstream = http.request({
    host: '127.0.0.1', port: upstreamPort, method: 'GET',
    path: request.url, headers: upstreamHeaders(request)
  });
  upstream.on('upgrade', (reply, upstreamSocket, upstreamHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n`);
    if (head.length) upstreamSocket.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    socket.pipe(upstreamSocket).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  upstream.on('response', () => socket.destroy());
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
    const reason = escapeHtml(String(currentState().error || '').slice(0, 500));
    response.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'`, 'X-Content-Type-Options': 'nosniff' });
    return response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 暂不可用</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#1c2333;font:16px system-ui,sans-serif}.card{max-width:520px;margin:20px;padding:28px;background:white;border:1px solid #e1e7f0;border-radius:14px}p{line-height:1.6}.reason{padding:12px;background:#fdf2f2;word-break:break-all}button,a{display:inline-block;margin:6px 8px 0 0;padding:10px 14px;border:0;border-radius:8px;background:#175cd3;color:white;font:inherit;text-decoration:none;cursor:pointer}</style></head><body><main class="card"><h1>DSH 核心暂不可用</h1><p>页面每 5 秒自动检查一次。</p>${reason ? `<p class="reason">${reason}</p>` : ''}<button id="refresh" type="button">立即刷新</button><a href="${gatewayManagePrefix}/?view=runtime">应用设置</a></main><script nonce="${nonce}">document.getElementById('refresh').onclick=()=>location.reload();setTimeout(()=>location.reload(),5000)</script></body></html>`);
  }
  const headers = upstreamHeaders(request);
  headers['accept-encoding'] = 'identity';
  const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, method: request.method, path: localPath, headers }, (reply) => {
    if (reply.statusCode >= 400) log('upstream_http_error', upstreamErrorDetails(request, localPath, reply.statusCode, 'gateway'));
    const forwarded = gatewayProxyHeaders(reply);
    if (request.method === 'GET' && reply.statusCode === 200 && /^text\/html(?:;|$)/i.test(String(reply.headers['content-type'] || ''))) {
      let body = '';
      reply.setEncoding('utf8');
      reply.on('data', (chunk) => { body += chunk; if (body.length > 2 * 1024 * 1024) reply.destroy(new Error('DSH page too large')); });
      reply.on('end', () => {
        body = body.replace(/<base\s+href="\/"\s*\/?\s*>/i, `<base href="${gatewayDshPrefix}/">`)
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
          .replace(/<head(?:\s[^>]*)?>/i, (open) => `${open}<script src="${gatewayDshPrefix}/__fnos-plugin-url-compat.js"><\/script>`);
        delete forwarded['content-length'];
        delete forwarded['transfer-encoding'];
        response.writeHead(reply.statusCode, forwarded);
        response.end(body);
      });
      reply.on('error', () => { if (!response.headersSent) send(response, 502, 'DSH 页面加载失败'); else response.destroy(); });
      return;
    }
    response.writeHead(reply.statusCode, forwarded);
    reply.pipe(response);
  });
  upstream.on('error', () => { if (!response.headersSent) send(response, 502, 'DSH 核心未就绪'); else response.destroy(); });
  request.pipe(upstream);
}

function upgradeGuideDsh(request, socket, head) {
  if (request.headers['x-trim-isadmin'] !== 'true' || !request.url.startsWith(`${gatewayDshPrefix}/`) || !available()) return socket.destroy();
  const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, method: 'GET', path: request.url.slice(gatewayDshPrefix.length), headers: upstreamHeaders(request) });
  upstream.on('upgrade', (reply, upstreamSocket, upstreamHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n`);
    if (head.length) upstreamSocket.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    socket.pipe(upstreamSocket).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  upstream.on('response', () => socket.destroy());
  upstream.end();
}

async function guideManagementPage(request, response) {
  const csrf = randomBytes(32).toString('base64url');
  const session = { csrf, nasIp: network.nasIpv4(network.fnosHost(request.headers.host), os.networkInterfaces(), undefined, process.env.FNOS_NAS_IPV4), user: String(request.headers['x-trim-userid'] || ''), expires: Date.now() + 12 * 60 * 60_000 };
  guideCsrf.set(csrf, session);
  const nonce = randomBytes(16).toString('base64');
  const localUrl = request.url.replace(gatewayManagePrefix, '/__fnos');
  const body = managementUi.render(dataDir, currentState(), session, localUrl, `${gatewayDshPrefix}/`, nonce, networkDebug.status(), await dockerAccess.inspect(dataDir)).replaceAll('/__fnos/', `${gatewayManagePrefix}/`);
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'`, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(body);
}

function handleGuide(request, response) {
  if (request.headers['x-trim-isadmin'] !== 'true') { log('guide_denied'); return send(response, 403, '仅 fnOS 管理员可打开。'); }
  if (request.url.startsWith(`${gatewayDshPrefix}/`)) return proxyGuideDsh(request, response);
  if (request.url === `${gatewayManagePrefix}/action`) return managementAction(request, response, null, true);
  if (request.method === 'GET' && request.url.startsWith(`${gatewayManagePrefix}/logs`)) {
    const source = new URL(request.url, 'http://fnos.invalid').searchParams.get('source') || 'gateway';
    const url = request.url.replace(gatewayManagePrefix, '/app/dsh-fnos');
    request.url = url.replace('/app/dsh-fnos/logs', '/app/dsh-fnos/diagnostics');
    return guideLogsPage(request, response);
  }
  if (request.method === 'GET' && request.url.startsWith(`${gatewayManagePrefix}/`)) return guideManagementPage(request, response).catch(() => send(response, 500, '应用设置暂时无法加载'));
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
  const reportKey = randomBytes(32).toString('base64url');
  reportKeys.set(reportKey, { fnosHost, expires: Date.now() + 12 * 60 * 60_000 });
  const autoReportKey = randomBytes(32).toString('base64url');
  reportKeys.set(autoReportKey, { fnosHost, expires: Date.now() + 60_000 });
  const probeReportKey = randomBytes(32).toString('base64url');
  if (mobileShell && !gatewayMode) reportKeys.set(probeReportKey, { fnosHost, expires: Date.now() + 60_000 });
  log('guide_opened', { fnosHost, mobileShell, route: gatewayMode ? 'gateway' : 'direct' });
  const appOrigin = ip ? `https://${ip}:${publicPort}` : '';
  const contentBase = gatewayMode ? gatewayDshPrefix : appOrigin;
  const scriptNonce = randomBytes(16).toString('base64url');
  const frameUrl = gatewayMode ? `${gatewayDshPrefix}/start?ticket=${ticket}` : `${appOrigin}/_fnos/start?ticket=${ticket}`;
  const frameAttributes = !gatewayMode && mobileShell ? `src="about:blank" data-entry="${frameUrl}" hidden` : `src="${frameUrl}"`;
  const connectionState = !gatewayMode && mobileShell ? '<main id="connection-state" class="connection-state" role="status"><h1>正在检查应用连接…</h1><p>正在确认手机能否访问 NAS 上的 DSH 服务。</p></main>' : '';
  let body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeepSeek Harness</title><style>*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0}body{display:flex;flex-direction:column;background:#101828;color:#fff;font:14px system-ui,sans-serif}header{min-height:48px;padding:7px 14px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #344054}strong{white-space:nowrap}nav{margin-left:auto;display:flex;gap:8px}a{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:5px 12px;border:1px solid #475467;border-radius:7px;color:#fff;text-decoration:none;white-space:nowrap}a:hover,a:focus-visible{background:#344054}a.settings{order:10;background:#175cd3;border-color:#175cd3}a.settings:hover,a.settings:focus-visible{background:#1248a4}[hidden]{display:none!important}iframe{flex:1;width:100%;min-height:0;border:0;background:#fff}.connection-state{flex:1;display:grid;align-content:center;justify-items:center;padding:24px;text-align:center;background:#f5f7fb;color:#1c2333}.connection-state h1{font-size:20px;margin:0 0 12px}.connection-state p{max-width:420px;line-height:1.6;margin:0 0 12px}.connection-state a,.connection-state button{margin:5px;padding:9px 14px;color:#fff;background:#175cd3;border:0;border-radius:8px;text-decoration:none;font:inherit}</style></head><body><header><strong>DeepSeek Harness</strong><nav aria-label="应用导航"><a id="dsh-nav" ${mobileShell && !gatewayMode ? 'hidden' : ''} href="${contentBase}/" target="dsh-frame">刷新 DSH</a><a id="settings-nav" ${mobileShell && !gatewayMode ? 'hidden' : ''} class="settings" href="${gatewayMode ? gatewayManagePrefix : `${appOrigin}/__fnos`}/" target="dsh-frame">应用设置</a></nav></header>${connectionState}<iframe name="dsh-frame" title="DeepSeek Harness 内容" ${frameAttributes} allow="clipboard-read; clipboard-write"></iframe></body></html>`;
  body = body.replace('>刷新 DSH</a>', '>强制刷新 DSH</a>')
    .replace('</head>', '<style>dialog.refresh-confirm{max-width:min(92vw,420px);padding:24px;border:1px solid #475467;border-radius:12px;background:#1d2939;color:#fff;box-shadow:0 20px 60px #0008}dialog.refresh-confirm::backdrop{background:#0009}dialog.refresh-confirm h2{margin:0 0 10px;font-size:20px}dialog.refresh-confirm p{line-height:1.6}dialog.refresh-confirm form{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}dialog.refresh-confirm button{padding:9px 16px;border:1px solid #667085;border-radius:7px;background:#344054;color:#fff;font:inherit;cursor:pointer}dialog.refresh-confirm button.confirm{background:#175cd3;border-color:#175cd3}</style></head>')
    .replace('</iframe></body>', '</iframe><dialog id="refresh-confirm" class="refresh-confirm" aria-labelledby="refresh-title"><h2 id="refresh-title">强制刷新 DSH？</h2><p>将重新加载 DSH 页面。当前未保存的输入可能丢失；DSH 核心不会重启。</p><form method="dialog"><button id="refresh-cancel" value="cancel">取消</button><button id="refresh-accept" class="confirm" value="refresh">强制刷新</button></form></dialog></body>');
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
  function setView(view) { activeView = view; dshNav.textContent = view === 'dsh' ? '强制刷新 DSH' : '返回 DSH'; }
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
  logsNav.addEventListener('click', () => setView('settings'));
  window.addEventListener('message', (event) => {
    if (event.source !== document.querySelector('iframe[name="dsh-frame"]').contentWindow || event.origin !== ${gatewayMode ? 'location.origin' : `'${appOrigin}'`}) return;
    if (event.data?.type === 'dsh-fnos-view' && ['dsh', 'settings'].includes(event.data.view)) setView(event.data.view);
  });
  </script>`;
  const connectionScript = mobileShell && !gatewayMode ? `<script nonce="${scriptNonce}">
  const connectionState = document.getElementById('connection-state');
  const frame = document.querySelector('iframe[name="dsh-frame"]');
  const probe = new Image();
  let settled = false;
  const failure = () => {
    if (settled) return;
    settled = true;
    probe.onload = probe.onerror = null;
    void sendDiagnostic('${probeReportKey}', 'probe', 'unreachable').catch(() => {});
    connectionState.innerHTML = '<h1>手机无法连接到 DSH</h1><p>DSH 内页使用 NAS 的局域网地址和独立端口。通过飞牛远程连接时，手机通常无法访问该地址。</p><p>请连接 NAS 所在局域网或可访问该局域网的 VPN 后重试。若已连接局域网，请先在浏览器中接受应用 HTTPS 证书。</p><p><a href="${appOrigin}/" target="_blank" rel="noopener noreferrer">打开 DSH 地址</a><button type="button" id="connection-retry">重新检查</button></p>';
    document.getElementById('connection-retry').onclick = () => location.reload();
  };
  const timer = setTimeout(failure, 6000);
  document.getElementById('logs-nav').addEventListener('click', () => {
    settled = true;
    clearTimeout(timer);
    connectionState.hidden = true;
    frame.hidden = false;
  });
  probe.onload = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    void sendDiagnostic('${probeReportKey}', 'probe', 'reachable').catch(() => {});
    connectionState.hidden = true;
    document.getElementById('dsh-nav').hidden = false;
    document.getElementById('settings-nav').hidden = false;
    frame.hidden = false;
    frame.src = frame.dataset.entry;
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
  response.end(body.replace('</nav>', '<button id="diagnose" type="button">记录诊断</button><a id="logs-nav" href="/app/dsh-fnos/diagnostics" target="dsh-frame">诊断日志</a></nav>').replace('</body>', `${clientScript}${navScript}${connectionScript}</body>`).replace('</style>', 'button{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:5px 12px;border:1px solid #475467;border-radius:7px;color:#fff;background:transparent;font:inherit;cursor:pointer}button:hover,button:focus-visible{background:#344054}@property --edge-angle{syntax:"<angle>";inherits:false;initial-value:0deg}button.is-working{position:relative;isolation:isolate;box-shadow:0 0 0 1px #77cfff,0 0 9px #4ebdff55}button.is-working::after{content:"";position:absolute;inset:-2px;border-radius:inherit;padding:2px;background:conic-gradient(from var(--edge-angle),transparent 0deg 250deg,#50baff 295deg,#f3fcff 324deg,#75d2ff 340deg,transparent 360deg);-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:edge-sweep 1.35s linear infinite;pointer-events:none}@keyframes edge-sweep{to{--edge-angle:360deg}}@media(prefers-reduced-motion:reduce){button.is-working::after{animation:none;background:#84d6ff}}@media(max-width:420px){header{padding:6px;gap:5px}strong{display:none}nav{gap:4px}a,button{padding:5px 7px;font-size:12px}}</style>'));
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
  const guideServer = http.createServer(handleGuide);
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
  });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
