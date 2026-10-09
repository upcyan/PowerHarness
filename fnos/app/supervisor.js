const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, fork } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const ops = require('./ops.js');
const configCoordination = require('./config-coordination.js');
const actions = require('./actions.js');   // action 白名单的唯一来源（见该文件头注释）
const cores = require('./core-manager.js');
const profiles = require('./profiles.js');
const plugins = require('./plugins.js');
const bundledPlugins = require('./bundled-plugins.js');
const terminal = require('./terminal.js');
const diagnostics = require('./diagnostics.js');
const grants = require('./grants.js');
const dockerAccess = require('./docker-access.js');
const portOwner = require('./port-owner.js');

const appDir = process.env.FNOS_APP_DIR;
const dataDir = process.env.FNOS_DATA_DIR;
const configDir = process.env.FNOS_CONFIG_DIR;
const guideSocket = process.env.GUIDE_SOCKET;
const manifestPortEnv = Number(process.env.FNOS_PORT || 3080);
const portReplies = new Map();
function effectivePublicPort() { return ops.portSettings(dataDir).publicPort || manifestPortEnv; }
let corePort = ops.portSettings(dataDir).corePort;
if (!appDir || !dataDir || !guideSocket) throw new Error('Missing fnOS application paths');

// ── PATH 兜底：把 runtime 的 .bin 放到本进程 PATH 最前（0.3.61）─────────────
// 根因：fnOS 应用启动 supervisor 时的 PATH 是
//   /var/apps/nodejs_v24/target/bin:/usr/local/bin:...
// 而 `/var/apps/nodejs_v24/target/bin/pnpm` 是 **corepack 的 shim**——它没有固定
// 版本，在 packageManager 字段缺失时会去**下载 pnpm 12.8.1**（实测复现）。
//
// 我们自有的 spawn 点（runDshPlugin / bundled-plugins / terminal.js / startDsh）
// 都显式设了 PATH 前缀，所以它们没事。但 **gateway 继承 supervisor 的环境、
// supervisor 自身也从未补过这个前缀** —— 凡是这两个进程里 spawn 裸 `pnpm`
// 的场景（含 DSH 内部某些代码路径）都会命中 corepack：
//   · corepack 用 pnpm 12.8.1 → 把 storeDir: .../store/v11 写进 .modules.yaml
//   · 应用侧用 pnpm 10.34.5   → 算出 .../store/v11/v10 ≠ 记录值
//   → 之后每次插件操作都 ERR_PNPM_UNEXPECTED_STORE（实测：卸载 preset-switch 失败）
//
// 这里改 `process.env.PATH` 本身（不只是个别 spawn 的 env），让**本进程与所有
// 子进程**（含 gateway、以及 gateway 再拉起的任何东西）都优先解析到 runtime 自带的
// pnpm 10.34.5，从源头消除版本混用。幂等：已在最前时不重复添加。
const runtimeBins = path.join(appDir, 'runtime', 'node_modules', '.bin');
if (fs.existsSync(runtimeBins)) {
  const segments = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (segments[0] !== runtimeBins) {
    process.env.PATH = [runtimeBins, ...segments.filter((s) => s !== runtimeBins)].join(path.delimiter);
  }
}

const stateFile = ops.dataPath(dataDir, 'state.json');
const logFile = ops.dataPath(dataDir, 'dsh.log');
const gatewayLog = ops.dataPath(dataDir, 'gateway.log');
const eventLog = diagnostics.logger(dataDir, 'supervisor');

// 启动失败的线索提取（0.3.61）：把 core 日志里真正指向根因的行挑出来并附处置
// 建议，供管理页渲染诊断卡——10-01 的 90 秒超时正是靠
// 「disabling profile plugin row」与「pending (waiting for service)」两类线索定位的。
function collectStartupHints(redactedText) {
  const hints = [];
  const push = (kind, text, advice) => { if (!hints.some((item) => item.text === text)) hints.push({ kind, text, advice }); };
  for (const match of redactedText.matchAll(/skipping profile bundle "([^"]+)"/g)) {
    push('incompatible', '跳过插件包：' + match[1], '该插件与当前核心版本不兼容：可在插件管理授予版本豁免，或卸载/更新它');
  }
  for (const match of redactedText.matchAll(/disabling profile plugin row "([^"]+)"/g)) {
    push('disabled-row', '核心行被禁用：' + match[1], '声明版本与实际解析到的包不一致（典型原因：旧版核心包遮蔽了回退层）');
  }
  for (const match of redactedText.matchAll(/pending \(waiting for service: ([^)]+)\)/g)) {
    push('pending', '等待服务：' + match[1], '依赖的服务没就绪，通常由上面被禁用的行引起，会让启动永不完结（表现为超时）');
  }
  const port = redactedText.match(/listen EADDRINUSE[^\n]*/);
  if (port) push('port', '端口被占用：' + port[0].slice(0, 80), '残留进程占用内部端口：可重启 FPK 清理，或在运行控制里更换端口');
  for (const match of redactedText.matchAll(/Cannot find package '([^']+)'/g)) {
    push('missing-package', '缺少依赖包：' + match[1], '按锁文件重建插件文件（插件管理 → 一键修复），或授予版本豁免');
  }
  const dup = redactedText.match(/duplicate loader entry id:\s*([A-Za-z0-9._-]{1,80})/);
  if (dup) push('duplicate', '加载项重复：' + dup[1], '可在本页一键清理重复声明');
  const incompat = redactedText.match(/is incompatible with dsh ([0-9][^\s:]*)/);
  if (incompat) push('version', '存在与 dsh ' + incompat[1] + ' 不兼容的声明', '可授予 exact-version 豁免后继续使用（需自担风险）');
  return hints.slice(0, 8);
}

// 启动异常结构化落盘（0.3.61）：state.error 只有一行，管理员看不出卡在哪一步。
// 把失败类型、等待时长、线索与 core 最后输出写到 startup-reports/last-failure.json
// （dataDir 根，回滚不覆盖），供管理页渲染诊断卡。
function recordStartupDiagnosis(reason, extra = {}) {
  try {
    const logFile = ops.dataPath(dataDir, 'dsh.log');
    const raw = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const redacted = diagnostics.redactDsh(raw);
    const dir = ops.dataPath(dataDir, 'startup-reports');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload = {
      at: new Date().toISOString(),
      reason,
      message: extra.message || '',
      waitedMs: typeof extra.waitedMs === 'number' ? extra.waitedMs : null,
      coreDir: extra.coreDir || activeDir || null,
      profile: extra.profile || profiles.selected(dataDir),
      runtimeVersion: state.activeVersion || ops.dshVersion(appDir) || null,
      hints: collectStartupHints(redacted),
      tail: redacted.split(/\r?\n/).filter((line) => line.trim()).slice(-60),
    };
    ops.writeJson(path.join(dir, 'last-failure.json'), payload);
    return payload;
  } catch (error) { log('record startup diagnosis failed: ' + error.message); return null; }
}

function archiveStartupLogs(reason, directory, profileName, extra = {}) {
  try {
    const archived = diagnostics.archiveDshLogs(dataDir, reason, { profile: profileName, coreDir: directory, ...extra });
    if (archived.dir) eventLog('dsh_startup_logs_archived', { reason, dir: archived.dir, files: archived.copied.length });
  } catch (error) { log('startup log archive failed: ' + error.message); }
  recordStartupDiagnosis(reason, { ...extra, coreDir: directory, profile: profileName });
}

const restartTracker = require('./restart-tracker').createRestartTracker(dataDir);
let state = { mode: 'starting', bootId: restartTracker.bootId, restartReceipt: restartTracker.snapshot(), bundledVersion: ops.dshVersion(appDir), activeVersion: null, error: null, updatedAt: new Date().toISOString() };
let dsh = null;
let coreStopConfirmed = false;
const automaticBackups = require('./automatic-backup-policy.js');
let gateway = null;
let activeDir = appDir;
let stopping = false;
let shuttingDown = false;
let gatewayRestartTimer = null;
const startupCancels = new WeakMap();
let expectedDshStop = false;
let cleanExitRestarts = 0;
let cleanExitTimer = null;
let cleanExitGeneration = 0;
const cleanExitRestartLimit = 3;
const cleanExitRestartDelay = 5_000;
const cleanExitResetAfter = 10 * 60_000;
let operation = Promise.resolve();
let dailyTimer;
let sessionTimer;
let updateTimer;
// Set when an operation changed data and the core then refused to start, so
// the administrator can decide whether to roll the data back. Automatic
// rollback used to run here instead, which destroyed newer work whenever the
// failure was transient (a slow first render, a rejected npm call that had
// written nothing). See docs/design.md.
let pendingRestore = null;

// 维护态说明（0.3.62，用户反馈）：原先 14 处 `publish({ mode: 'maintenance',
// error: null })` 只让界面显示「维护中」——用户不知道程序在做什么、要等多久。
// 现在每次进入维护态都带上**在做什么 + 预计耗时**，界面据此显示明确文案。
//
// 用法：publishMaintenance('正在安装插件 dsh-foo（含依赖解析）', 60);
//   · 第二参数是预计秒数（用于「约需 X 秒」与进度条估算），可省略。
//   · 维护结束后由 publish({ mode: 'ready' }) 自动清除（见 publish 的清理逻辑）。
function publishMaintenance(text, etaSeconds) {
  const previous = state.operation && state.operation.startedAt ? state.operation.startedAt : null;
  publish({
    mode: 'maintenance',
    error: null,
    operation: {
      text: String(text || '正在执行维护操作'),
      etaSeconds: Number.isFinite(etaSeconds) ? etaSeconds : null,
      startedAt: previous || new Date().toISOString()   // 连续操作时保留起始时间
    }
  });
}

function publish(patch) {
  const previousMode = state.mode;
  // pendingRestore lives in a module variable but must always be mirrored into
  // the published state: the management page renders the banner from
  // state.json, and a publish that forgot the field would silently hide a
  // decision the administrator still owes an answer to.
  const merged = { ...state, ...patch, pendingRestore, updatedAt: new Date().toISOString() };
  // 离开维护态即清除操作说明（避免"已就绪却仍显示正在安装插件"的残留）
  if (Object.hasOwn(patch, 'mode') && patch.mode !== 'maintenance') merged.operation = null;
  else if (patch.mode === 'maintenance' && !Object.hasOwn(patch, 'operation')) merged.operation = state.operation || null;
  try { restartTracker.observe(merged.mode); } catch (error) { log('Restart confirmation unavailable: ' + error.message); }
  merged.bootId = restartTracker.bootId;
  merged.restartReceipt = restartTracker.snapshot();
  state = merged;
  ops.writeJson(stateFile, state);
  if (state.mode !== previousMode || Object.hasOwn(patch, 'activeVersion')) eventLog('state_changed', { mode: state.mode, version: state.activeVersion || null });
}

// 控制台日志加时间戳（0.3.61，P8-c）：此前无时间戳，事后无法判断「某次重启/失败
// 发生在何时」，只能靠文件 mtime 反推。格式与 dsh.log 的行时间戳保持一致（本地时
// 间 HH:MM:SS），便于两个日志并排对账。
function log(message) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  console.log(`[${stamp}] [supervisor] ${message}`);
}
function exited(child) { return child.exitCode !== null || child.signalCode !== null; }
function readyMode() { return activeDir === ops.dataPath(dataDir, 'last-good') ? 'rollback' : 'ready'; }

// Record a rollback the administrator has to approve. The mode is left to the
// caller: when DSH is demonstrably running again on the previous core, forcing
// safe mode would disable file and command operations for no reason, so the
// caller passes 'rollback' or 'ready' instead.
function raisePendingRestore({ snapshotId, reason, action, version, mode = 'safe' }) {
  pendingRestore = { snapshotId, reason, action: action || null, version: version || null, createdAt: new Date().toISOString() };
  publish({ mode, pendingRestore, activeVersion: version || state.activeVersion, error: reason });
  eventLog('pending_restore', { snapshotId, action: action || null });
  log(`awaiting administrator decision before restoring ${snapshotId}: ${reason}`);
}
function clearPendingRestore() {
  if (!pendingRestore) return;
  pendingRestore = null;
  publish({ pendingRestore: null });
}
function requestLocal(pathname, cookie = '') {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: corePort, path: pathname, headers: cookie ? { Cookie: cookie } : {}, timeout: 5000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; if (body.length > 1_000_000) request.destroy(new Error('Web response too large')); });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('timeout', () => request.destroy(new Error('Web health check timed out')));
    request.on('error', reject);
  });
}
async function probeWebOnce() {
  const launch = ops.readJson(ops.dataPath(dataDir, 'launch.json'));
  if (!launch?.path) throw new Error('Missing dsh launch URL');
  const first = await requestLocal(launch.path);
  if (![200, 302, 303].includes(first.status)) throw new Error(`dsh login check returned ${first.status}`);
  const cookie = (first.headers['set-cookie'] || []).map((item) => item.split(';')[0]).join('; ');
  const page = await requestLocal('/', cookie);
  if (page.status !== 200 || !/<html[\s>]/i.test(page.body)) throw new Error(`dsh Web UI check returned ${page.status}`);
}

// A freshly started core can need a moment before its first request succeeds:
// routes mount as plugins load, and a cold page render can outlast one 5s
// timeout. Treating a single slow response as a dead core used to trigger a
// full data rollback, so retry a few times before declaring failure. A core
// that really failed still fails every attempt, just a few seconds later.
const probeWebAttempts = 5;
const probeWebRetryDelay = 2_000;
async function probeWeb() {
  let lastError;
  for (let attempt = 1; attempt <= probeWebAttempts; attempt += 1) {
    try { await probeWebOnce(); return; }
    catch (error) {
      lastError = error;
      if (attempt === probeWebAttempts) break;
      log(`Web health check attempt ${attempt}/${probeWebAttempts} failed: ${error.message}; retrying`);
      await new Promise((resolve) => setTimeout(resolve, probeWebRetryDelay));
    }
  }
  throw lastError;
}
function updateSettings() {
  const value = ops.readJson(ops.dataPath(dataDir, 'update-settings.json'), {});
  return { registry: cores.registryUrl(value.registry), autoUpdate: value.autoUpdate === true };
}

// After a failed change, the data on disk is very often still perfectly
// usable: npm refuses a dependency tree before writing anything, a network
// hiccup clears, a plugin only conflicts with itself. Starting the core as it
// stands costs one boot and tells us which case we are in. Only a core that
// genuinely cannot start justifies offering a rollback -- rolling back first
// throws away every session and setting written since the snapshot, to undo a
// change that may have written nothing at all.
//
// Returns true when the current data boots, false when it does not. Never
// throws: the caller decides what a false result means.
async function startsAsIs() {
  try {
    await stopDsh();
    await startDsh(activeDir);
    await probeWeb();
    return true;
  } catch (error) {
    log(`current data still does not start: ${error.message}`);
    try { await stopDsh(); } catch {}
    return false;
  }
}

// 仅规范化继承的Git配置；常驻core/gateway不得注入安装SSH改写。
const gitEnv = require('./git-transport.js');

function spawnDsh(directory, profileName = profiles.selected(dataDir), createProfile = false, { startupTimeoutMs = 90_000, attempt = 1 } = {}) {
  coreStopConfirmed = false;
  return new Promise((resolve, reject) => {
    if (stopping || shuttingDown) return reject(new Error('应用正在停止，不再启动核心'));
    let adapter;
    try { adapter = cores.adapterFor(directory, corePort); }
    catch (error) { reject(error); return; }
    const bin = adapter.bin;
    if (!fs.existsSync(bin)) { reject(new Error('dsh runtime is missing')); return; }
    try { profiles.validateName(profileName); } catch (error) { reject(error); return; }
    if (profileName !== 'web' && adapter.args[0] !== 'web') { reject(new Error('Selected dsh core does not support Web profile switching')); return; }
    fs.rmSync(ops.dataPath(dataDir, 'launch.json'), { force: true });
    diagnostics.startDshLog(dataDir, path.basename(directory) + ':' + profileName);
    const output = (chunk) => diagnostics.appendDsh(dataDir, chunk);
    let settled = false;
    let startupComplete = false;
    let readinessPending = false;
    let pending = '';
    let launchUrl = null;
    startupStderr = '';
    const registry = updateSettings().registry;
    const args = profileName === 'web' ? adapter.args : [
      '--profile', profileName,
      ...(createProfile ? ['--from-default-profile', 'web'] : []),
      ...adapter.args.slice(1)
    ];
    expectedDshStop = false;
    const workspace = ops.dataPath(dataDir, 'workspace');
    try { grants.syncShortcuts(dataDir); }
    catch (error) { log(`authorized directory shortcuts unavailable: ${error.message}`); }
    const localBins = path.join(appDir, 'runtime', 'node_modules', '.bin');
    const dshEnv = gitEnv.normalizeGitParentEnv(process.env);
    delete dshEnv.DOCKER_HOST;
    delete dshEnv.DOCKER_CONTEXT;
    const child = spawn(process.execPath, ['--require', portOwner.instancePreload(dataDir), '--require', path.join(__dirname, 'workspace-home.cjs'), bin, ...args], {
      cwd: workspace,
      env: { ...dshEnv, ...dockerAccess.dshEnvironment(dataDir), DSH_HOME: dshHome || ops.dataPath(dataDir, 'dsh-home'), FNOS_WORKSPACE_HOME: workspace,
        PATH: `${localBins}${path.delimiter}${process.env.PATH || ''}`,
        // The core's own plugin management (the market's update flow) runs
        // pnpm inside this process: it must see the same store the profile was
        // built with, or every update fails with ERR_PNPM_UNEXPECTED_STORE.
        PNPM_HOME: ops.dataPath(dataDir, 'pnpm-home'), npm_config_store_dir: plugins.runtimeStoreDir(dataDir, profileName),
        // corepack 兜底（0.3.62）：PATH 里若有 corepack shim 排在真 pnpm 之前，
        // corepack 会先去下载它自己锁定的 pnpm 版本，并把下载缓存写到
        // `$HOME/.cache/node/corepack`。本应用以 dsh_fnos 运行且 HOME 可能为空，
        // 于是退化成 `EACCES: mkdir '/home/dsh_fnos/.cache/node/corepack/v1'`。
        // 把两个变量都指到我们自己的数据目录：即便命中 shim 也不会因权限失败，
        // 而且不会污染别的应用的家目录。
        COREPACK_HOME: ops.dataPath(dataDir, 'corepack-home'), HOME: ops.dataPath(dataDir, 'home'),
        npm_config_cache: ops.dataPath(dataDir, 'npm-cache'), NO_COLOR: '1', NPM_CONFIG_REGISTRY: registry, npm_config_registry: registry },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    dsh = child;
    // 定时器句柄先声明（下方 fail 会引用它们；若声明晚于 fail 会形成 TDZ）。
    let idleTimer = null;
    let timeout = null;
    let readinessTimer = null;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(idleTimer);
      clearTimeout(readinessTimer);
      startupCancels.delete(child);
      reject(error);
    };
    startupCancels.set(child, () => fail(new Error('核心启动已取消')));
    // 启动看门狗（0.3.61 根治，替换「固定墙钟」）：
    // 旧实现是「90 秒内没打出就绪行就杀进程」，但冷启动（NAS 重启后冷缓存 + IO
    // 风暴）下核心可能数十秒零输出——实测 15:49 那次日志仅 63 字节、被 SIGKILL，
    // 而紧接着手动重试 36 秒就绪（第一次的读取暖了页缓存）。固定墙钟把「冷启动慢」
    // 误判成「启动故障」。
    // 新判据分两类，兼顾「不误杀」与「能发现真卡死」：
    //   · **有输出即续期** —— 只要核心还在打印（说明它在推进），就重置空转计时；
    //   · **空转上限** —— 连续 idleTimeoutMs 无任何输出才判失败（默认 90 秒，冷启动
    //     期间也不会误杀，因为模块加载会持续输出）；
    //   · **总上限** —— 无论是否有输出，超过 maxStartupMs 仍未就绪即失败，避免
    //     「一直缓慢输出但永不就绪」无限等待（如 12 条 pending 那种情形）。
    const idleTimeoutMs = startupTimeoutMs;
    // 硬上限：无论是否有输出都不超过 10 分钟（防止「缓慢输出但永不就绪」无限等待）。
    const maxStartupMs = startupTimeoutMs;
    let lastOutputAt = Date.now();
    const armIdleTimer = () => {
      if (startupComplete || settled || stopping || shuttingDown) return;    // 就绪后看门狗退役（0.3.62）
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const idleSec = Math.round((Date.now() - lastOutputAt) / 1000);
        const message = `dsh startup stalled: no output for ${idleSec} seconds`;
        archiveStartupLogs('startup-stalled', directory, profileName, { message, idleMs: idleSec * 1000, attempt });
        child.kill('SIGTERM');
        const stallFailure = new Error(message);
        stallFailure.startupTimeout = true;
        fail(stallFailure);
      }, idleTimeoutMs);
    };
    armIdleTimer();
    timeout = setTimeout(() => {
      const message = `dsh startup timed out after ${Math.round(maxStartupMs / 1000)} seconds (hard limit, still producing output: ${Math.round((Date.now() - lastOutputAt) / 1000)}s ago)`;
      archiveStartupLogs('startup-timeout', directory, profileName, { message, waitedMs: maxStartupMs, attempt });
      child.kill('SIGTERM');
      const timeoutFailure = new Error(message);
      timeoutFailure.startupTimeout = true;
      fail(timeoutFailure);
    }, maxStartupMs);
    // 有输出就续期 + 记录最后一次输出时间（供硬上限的报错信息使用）。
    //
    // ⚠ 只在**尚未就绪**时续期（0.3.62 修复）。旧实现无条件 armIdleTimer()，
    // 于是就绪之后 core 的**任何一次普通输出**都会重新武装看门狗，而服务正常运行
    // 时本就长时间安静 —— 90 秒后就被判成"启动卡死"并 SIGTERM 杀掉。
    // 实测 10-02 的连环误杀：04:37:45 就绪 → 04:42:44 auto-continue 打印一行
    // → 04:44:18 「no output for 93 seconds」→ 杀 core → 维护中 → 自动重启。
    // 这与"启动看门狗"的语义相反：它只该管**启动阶段**。
    const noteOutput = () => {
      lastOutputAt = Date.now();
      if (!startupComplete && !settled && !stopping && !shuttingDown) armIdleTimer();
    };
    child.stdout.on('data', (chunk) => {
      noteOutput();
      output(chunk);
      pending += chunk.toString();
      if (pending.includes('\n')) {
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        const readyLine = lines.find((line) => line.startsWith(adapter.readyPrefix));
        if (!settled && !readinessPending && readyLine) {
          launchUrl = readyLine.slice(adapter.readyPrefix.length).trim().split(/\s+/)[0];
          readinessPending = true;
          readinessTimer = setTimeout(() => {
            if (settled || stopping || shuttingDown) return;
            if (exited(child)) fail(new Error(`dsh exited after readiness: ${child.exitCode ?? child.signalCode}`));
            else {
              try {
                const url = new URL(launchUrl);
                if (url.hostname !== '127.0.0.1' || url.port !== String(corePort)) throw new Error('Unexpected dsh URL');
                ops.writeJson(ops.dataPath(dataDir, 'launch.json'), { path: `${url.pathname}${url.search}${url.hash}` });
              } catch (error) { fail(error); return; }
              settled = true; startupComplete = true; startupCancels.delete(child); clearTimeout(timeout); clearTimeout(idleTimer); clearTimeout(readinessTimer); resolve(child);
            }
          }, 2000);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      noteOutput();
      output(chunk);
      startupStderr = (startupStderr + chunk.toString()).slice(-4096);
    });
    child.on('error', fail);
    child.on('exit', (code, signal) => {
      eventLog('dsh_exited', { code: code ?? null, signal: signal ?? null, expected: expectedDshStop || stopping });
      if (!settled) {
        const duplicate = startupStderr.match(/duplicate loader entry id:\s*([A-Za-z0-9._-]{1,80})/);
        const diagnosis = diagnoseStartupFailure(startupStderr);
        const fallback = duplicate ? `DSH 插件加载项重复：${duplicate[1]}` : `dsh exited during startup (${code ?? signal})`;
        archiveStartupLogs('startup-failed', directory, profileName, { message: diagnosis || fallback, exitCode: code ?? null, signal: signal ?? null });
        fail(new Error(diagnosis ? `dsh 启动失败：${diagnosis}` : fallback));
      }
      else if (startupComplete && !expectedDshStop && !stopping) handleUnexpectedExit(code, signal);
    });
  });
}

// 0.3.60：启动失败时把完整诊断写成独立报告文件（对照上游桌面版 fatal-recovery
// 的 writeReport 语义：报告先落盘，界面只给路径与摘要）。材料取自手头变量，
// 绝不阻塞 boot 收尾；报告含错误全文、stderr 尾部 64KB 与完整日志指引。
let startupStderr = '';
function writeStartupReport(errorText) {
  try {
    const dir = ops.dataPath(dataDir, 'startup-reports');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `report-${stamp}.txt`);
    const body = [
      `time: ${new Date().toISOString()}`,
      `core: active=${state.activeVersion || "?"} bundled=${state.bundledVersion || "?"}`,
      `mode at failure: ${state.mode}`,
      '',
      '--- error ---',
      String(errorText || '').slice(0, 8000),
      '',
      '--- dsh startup stderr (tail) ---',
      startupStderr.slice(-65536),
      '',
      '--- full logs ---',
      `dsh: ${ops.dataPath(dataDir, 'dsh.log')}`,
      `data dir: ${dataDir}`,
      '',
    ].join('\n');
    fs.writeFileSync(file, body, { mode: 0o600 });
    return file;
  } catch (error) {
    log(`startup report write failed: ${error.message}`);
    return null;
  }
}


// A DSH descendant may inherit the listening socket after the original Node
// process exits. Match the actual socket inode and this installation's private
// environment before terminating any process.
function probePortBusy(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (response) => { response.resume(); resolve(true); });
    request.on('timeout', () => request.destroy());
    request.on('error', (error) => resolve(error.code !== 'ECONNREFUSED'));
  });
}

function staleCoreIdentities() { return portOwner.ownedProcesses(dataDir, appDir).filter(identity => identity.role === 'core'); }
function staleCorePids() { return staleCoreIdentities().map(identity => identity.pid); }

async function releaseOwnedCorePort() {
  const identities = staleCoreIdentities();
  if (!identities.length) return;
  log('terminating owned core leftovers: ' + identities.map(identity => identity.pid).join(', '));
  for (const identity of identities) portOwner.signalOwned(identity, 'SIGTERM', dataDir, appDir);
  for (let i = 0; i < 20; i++) {
    if (!identities.some(identity => portOwner.identityMatches(identity, dataDir, appDir))) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  for (const identity of identities) portOwner.signalOwned(identity, 'SIGKILL', dataDir, appDir);
  for (let i = 0; i < 20; i++) {
    if (!identities.some(identity => portOwner.identityMatches(identity, dataDir, appDir))) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('本应用core进程尚未完成回收，拒绝继续启动');
}

async function reclaimCorePort() {
  if (!(await probePortBusy(corePort))) return;
  const pids = staleCorePids();
  if (!pids.length) throw new Error(`端口 127.0.0.1:${corePort} 已被占用（EADDRINUSE），但无法核实占用进程属于本应用，因此不会自动结束它。请在 NAS 上检查端口持有者，或在应用设置 → 运行控制中修改内部端口`);
  await releaseOwnedCorePort();
  for (let i = 0; i < 8; i++) { await new Promise((resolve) => setTimeout(resolve, 250)); if (!(await probePortBusy(corePort))) return; }
  throw new Error(`端口 127.0.0.1:${corePort} 被残留 dsh 进程占用且无法释放。可在应用设置 → 运行控制中修改内部端口，或在 NAS 上手动结束残留进程`);
}

function probeBindable(port) {
  return new Promise((resolve) => {
    const server = require('node:net').createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
  });
}

function askGatewayPublicPort(port) {
  return new Promise((resolve, reject) => {
    if (!gateway?.connected) { reject(new Error('网关未连接，请稍后重试')); return; }
    const id = randomBytes(8).toString('hex');
    const timer = setTimeout(() => { portReplies.delete(id); reject(new Error('网关未响应端口切换')); }, 30_000);
    portReplies.set(id, (error) => { clearTimeout(timer); error ? reject(error) : resolve(); });
    gateway.send({ type: 'public-port', id, port });
  });
}

async function startDsh(directory, profileName = profiles.selected(dataDir), createProfile = false) {
  return configCoordination.withDataLock(dataDir, () => startDshLocked(directory, profileName, createProfile));
}
async function startDshLocked(directory, profileName, createProfile) {
  if (stopping || shuttingDown) throw new Error('应用正在停止，不再启动核心');
  // Must run before EVERY core start, not once during boot: the core itself
  // rewrites this file (profile init writes `[]`, dshmarket appends patch rows
  // later), so the broken shape appears *after* boot-time checks. Starting with
  // a bare `[]` plus appended rows makes dsh refuse to load the profile at all.
  normalizeProfilePatch(profileName);
  // 解析卫生（0.3.61，见 MEMORY 二十六）：先归档遮蔽回退层的旧版核心包，再同步
  // 回退层（缺链/旧链 → 指向运行 runtime）。两者任一出问题都会让核心自身的行被
  // 判不兼容而禁用 → 消费者永久 pending → 启动永不就绪（90 秒超时）。
  try {
    const profileDir = profiles.directory(dataDir, profileName);
    const shadowed = ops.quarantineShadowedCorePackages(directory, path.join(profileDir, 'node_modules'));
    if (shadowed.moved.length) log('quarantined shadowed core packages: ' + shadowed.moved.join(', ') + ' -> ' + shadowed.dir);
    const sync = ops.syncFallbackLayer(directory, dataDir);
    if (sync.added || sync.removed) log('fallback layer synced: +' + sync.added + ' -' + sync.removed + ' (total ' + sync.total + ')');
    // 版本豁免重放（0.3.61）：豁免文件在 dsh-home 内，回滚会清空它；这里按 dataDir
    // 根的期望清单自动补齐（10-01 的 codebuddy/codex-auth 豁免正是这样丢的）。
    const exemptions = ops.syncExemptions(dataDir, profileDir);
    if (exemptions.added.length) log('version exemptions restored: ' + exemptions.added.join('; '));
    // 会话库完整性（0.3.61，P6 防护）：一个损坏的 Zstandard 会话日志会让核心
    // **整个起不来**（09-30 实测：loader 的 workspace 行 apply 失败）。启动前扫描，
    // 损坏的自动隔离到 sessions-corrupt-<ts>/（保留现场供上报上游），让其余数据
    // 照常启动。扫描失败/超时都不得阻塞启动。
    try {
      const corrupt = ops.scanCorruptSessions(dataDir, { quarantine: true });
      if (corrupt.corrupt.length) {
        log('corrupt session logs quarantined: ' + corrupt.quarantined + '/' + corrupt.corrupt.length
          + ' (scanned ' + corrupt.scanned + ') -> ' + corrupt.dir);
        eventLog('sessions_quarantined', { scanned: corrupt.scanned, corrupt: corrupt.corrupt.length, quarantined: corrupt.quarantined, dir: corrupt.dir });
      }
    } catch (error) { log('session integrity scan skipped: ' + error.message); }
    // 装载一致性（0.3.61）：patch 声明了、包也装了、却没登记进 bundles 的插件——它的
    // 客户端模块不会被装载，表现为「核心正常但浏览器 boot 报 did not activate」。
    // 启动前自动登记（只做加法，不碰已有条目），下次启动即可正常装载。
    const wiring = ops.diagnosePluginWiring(dataDir, profileName, patchYamlModule());
    if (!wiring.ok) {
      const repaired = ops.repairPluginWiring(dataDir, profileName, patchYamlModule());
      if (repaired.fixed.length) log('plugin wiring repaired (registered in bundles): ' + repaired.fixed.join(', '));
      for (const issue of wiring.issues) {
        if (!issue.fixable) log('plugin wiring issue [' + issue.kind + ']: ' + issue.detail);
      }
    }
    // 设置健康（0.3.61）：10-01 的「保存失败：设置服务不可用（settings 未装配）」
    // 是四层缺陷叠加，其中前三层**全是静默失败**（describe() 直接跳过该命名空间，
    // 设置页不出现，保存只报一句误导性的「未装配」）。这里在启动前把可自动判定的
    // 两层（① inject 回调参数在闭包外被引用、② patch id 与 SETTINGS_NS 不一致）
    // 记进日志 —— 不阻断启动，但让它在日志里可见，不必等用户报「保存不了」。
    try {
      const settingsDiag = ops.diagnosePluginSettings(dataDir, profileName);
      if (settingsDiag.issues.length) {
        for (const issue of settingsDiag.issues) {
          log('plugin settings issue [' + issue.layer + '] ' + issue.id + ': ' + issue.detail);
        }
        eventLog('plugin_settings_issues', { checked: settingsDiag.checked, issues: settingsDiag.issues });
      } else if (settingsDiag.checked) {
        log('plugin settings health ok (' + settingsDiag.checked + ' plugins checked)');
      }
    } catch (error) { log('plugin settings diagnosis skipped: ' + error.message); }
    // 断链自愈（P7，0.3.61）：回退层与 pnpm-store 的软链在升级/迁移后会指向已被
    // 替换的快照，留下大批断链（10-01 实测 77 + 31 个）。断链本身不致命，但会
    // 掩盖真实缺失、并随每次升级累积。这里启动时清理（只删软链本身，清单留档）。
    try {
      const links = ops.scanBrokenSymlinks(dataDir, { quarantine: true });
      if (links.quarantined) {
        log('broken symlinks cleaned: ' + links.quarantined + ' (list: ' + links.dir + ')');
        eventLog('broken_symlinks_cleaned', { quarantined: links.quarantined, dir: links.dir });
      }
    } catch (error) { log('broken symlink scan skipped: ' + error.message); }
  } catch (error) { log('module resolution hygiene failed: ' + error.message); }
  await reclaimCorePort();
  try {
    configCoordination.assertNoProfileLocks(ops.dataPath(dataDir, 'dsh-home'));
    return await spawnDsh(directory, profileName, createProfile);
  } catch (error) {
    if (!error?.startupTimeout || stopping) throw error;
    // 冷启动加时（0.3.61）：10-01 15:49（NAS 重启后首拉）核心 90 秒零输出被看门狗
    // 击杀，而紧接着的手动重试 36 秒就绪——第一次失败的读取恰好暖了缓存。与其把
    // 冷启动误判成故障送进 safe mode，不如自动加时重试一次；仍超时才按原语义失败。
    log('dsh startup timed out; retrying once with a 180 seconds budget (cold start)');
    eventLog('dsh_startup_retry', { firstWaitedMs: 90_000, retryTimeoutMs: 180_000 });
    await stopDsh();
    await reclaimCorePort();
    configCoordination.assertNoProfileLocks(ops.dataPath(dataDir, 'dsh-home'));
    return spawnDsh(directory, profileName, createProfile, { startupTimeoutMs: 180_000, attempt: 2 });
  }
}

function cancelSelfRestart() {
  cleanExitGeneration += 1;
  clearTimeout(cleanExitTimer);
  cleanExitTimer = null;
  cleanExitRestarts = 0;
}

// 子进程"彻底结束"的判定（0.3.73 / A06）。
//
// 原实现只等 'exit'。但**spawn 本身失败**时（EAGAIN/ENOENT/EMFILE 等），Node 只发
// 'error' + 'close'，**从不发 'exit'** ⇒ `exited(child)` 永远为 false（exitCode 与
// signalCode 都是 null），于是：
//   · 10 秒超时后 `child.kill('SIGKILL')` 返回 false（进程根本没建起来）；
//   · 代码却仍 `await exitPromise` —— 等到天荒地老；
//   · boot() 的 catch 卡在 stopDsh，**管理网关永不启动**，safe 模式也进不去。
//
// 现在：把 exit / close / error 三件事都当作"结束"，并给整体一个硬截止时间。
// 超时后不再无限等待（记录事件），让调用方继续收尾 —— 卡死比残留更难排查。
function settleAfterExit(child, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let timer = null, finished = false;
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      resolve(reason);
    };
    const onExit = () => finish('exit');
    const onClose = () => finish('close');
    const onError = () => { if (!child.pid || child.exitCode != null || child.signalCode != null) finish('spawn-error'); };
    // spawn系统错误可能没有exit；有PID的kill错误不代表进程已经退出。
    if (child.exitCode != null || child.signalCode != null) return finish('already-exited');
    if (!child.pid) return finish('not-spawned');
    child.once('exit', onExit);
    child.once('close', onClose);
    child.once('error', onError);
    timer = setTimeout(() => finish('timeout'), timeoutMs);
  });
}

async function stopDsh() {
  coreStopConfirmed = false;
  cancelSelfRestart();
  if (!dsh) { await releaseOwnedCorePort(); coreStopConfirmed = true; return; }
  if (exited(dsh)) { dsh = null; await releaseOwnedCorePort(); coreStopConfirmed = true; return; }
  expectedDshStop = true;
  const child = dsh;
  startupCancels.get(child)?.();
  const gracefulWait = settleAfterExit(child, { timeoutMs: 10_000 });
  child.kill('SIGTERM');
  const graceful = await gracefulWait;
  if (!exited(child)) {
    // kill 可能返回 false（进程已消失或从未建起）：仍然走有界等待，不再无条件 await。
    const forcedWait = settleAfterExit(child, { timeoutMs: 5_000 });
    child.kill('SIGKILL');
    const forced = await forcedWait;
    if (!exited(child) && child.pid) throw new Error(`dsh未确认退出，保留句柄并停止本次操作（last=${forced}, graceful=${graceful}）`);
  }
  dsh = null;
  await releaseOwnedCorePort();
  coreStopConfirmed = true;
}

async function stopGateway() {
  clearTimeout(gatewayRestartTimer);
  const child = gateway;
  if (!child) return;
  let wait = settleAfterExit(child, { timeoutMs: 10000 });
  child.kill('SIGTERM');
  await wait;
  if (!exited(child) && child.pid) {
    wait = settleAfterExit(child, { timeoutMs: 5000 });
    child.kill('SIGKILL');
    await wait;
    if (!exited(child)) throw new Error('网关未确认退出，保留句柄并拒绝替换进程镜像');
  }
  if (gateway === child) gateway = null;
}

// Extract the actionable root-cause line from dsh startup stderr so the
// management UI can show why the core failed instead of a generic message.
function diagnoseStartupFailure(stderrText) {
  const text = diagnostics.redactDsh(String(stderrText || ''));
  const duplicate = text.match(/duplicate loader entry id:\s*([A-Za-z0-9._-]{1,80})/);
  if (duplicate) return `插件加载项重复：${duplicate[1]}`;
  const busyPort = text.match(/listen EADDRINUSE[^\n]*/);
  if (busyPort) return `端口被占用：${busyPort[0]}。请重启 FPK 清理残留进程，或在应用设置 → 运行控制中修改内部端口`;
  const missingExport = text.match(/module '([^']+)' does not provide an export named '([^']+)'/);
  if (missingExport) return `插件/依赖版本不兼容：${missingExport[1]} 缺少导出 ${missingExport[2]}（多为插件依赖与核心版本不匹配）`;
  const cannotFind = text.match(/Cannot find package '([^']+)'(.*)/);
  if (cannotFind) return `缺少依赖包：${cannotFind[1]}${cannotFind[2] ? diagnostics.redactDsh(cannotFind[2]) : ''}`;
  const syntax = text.match(/SyntaxError: (.+)/);
  if (syntax) return `代码加载错误：${diagnostics.redactDsh(syntax[1])}`;
  const errLine = text.split(/\r?\n/).filter((line) => /^(?:Error|SyntaxError|TypeError|ReferenceError):/.test(line.trim())).pop();
  if (errLine) return diagnostics.redactDsh(errLine.trim()).slice(0, 500);
  return null;
}

// dsh exits cleanly (code 0) on self-restarts such as live plugin patch reloads.
// Restart it automatically with backoff; only fall to safe mode when it keeps
// exiting on its own within the reset window.
function handleUnexpectedExit(code, signal) {
  if (code === 0 && !stopping) {
    cleanExitRestarts += 1;
    if (cleanExitRestarts > cleanExitRestartLimit) {
      cleanExitRestarts = 0;
      publish({ mode: 'safe', error: 'dsh 在短时间内多次自行退出（exit 0），已停止自动重启。请检查插件或查看诊断日志。' });
      log('dsh self-exit restart limit reached; safe mode is active');
      return;
    }
    eventLog('dsh_self_restart', { attempt: cleanExitRestarts });
    publishMaintenance(`核心意外退出，正在自动重启（第 ${cleanExitRestarts}/${cleanExitRestartLimit} 次）`, 20);
    clearTimeout(cleanExitTimer);
    const generation = cleanExitGeneration;
    cleanExitTimer = setTimeout(() => {
      operation = operation.catch(() => {}).then(async () => {
        if (generation !== cleanExitGeneration || stopping) return;
        try {
          await startDsh(activeDir);
          await probeWeb();
          publish({ mode: readyMode(), error: null });
          log('dsh restarted automatically after clean exit');
          clearTimeout(cleanExitTimer);
          cleanExitTimer = setTimeout(() => { cleanExitRestarts = 0; }, cleanExitResetAfter);
          cleanExitTimer.unref?.();
        } catch (error) {
          await stopDsh();
          publish({ mode: 'safe', error: error.message });
          log(`dsh auto-restart failed: ${error.message}`);
        }
      });
    }, cleanExitRestartDelay);
    return;
  }
  publish({ mode: 'safe', error: `dsh stopped unexpectedly (${code ?? signal})` });
  log('dsh exited; safe mode is active');
}

// 等待网关公开端口空闲（0.3.61，P4）：用 bind 探测代替「猜固定延时」——
// 旧进程的监听套接字真正释放后 bind 才会成功。最多等 ~5 秒，超时不阻塞重启
// （由 gateway 自身的 EADDRINUSE 重试兜底）。
// 注意：公开面是 HTTPS，不能用 probePortBusy（HTTP 探测）代替 bind 探测。
function waitForGatewayPortFree(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const net = require('node:net');
    const port = effectivePublicPort();
    const deadline = Date.now() + timeoutMs;
    const probe = () => {
      const server = net.createServer();
      let settled = false;
      const done = (free) => {
        if (settled) return;
        settled = true;
        server.close(() => {});
        if (free) { resolve(true); return; }
        if (Date.now() >= deadline) { log('gateway port still busy after wait; restarting anyway'); resolve(false); return; }
        setTimeout(probe, 250);
      };
      server.once('error', () => done(false));
      server.once('listening', () => done(true));
      try { server.listen(port, '0.0.0.0'); } catch { done(false); }
    };
    probe();
  });
}
function startGateway() {
  if (stopping || shuttingDown || (gateway && !exited(gateway))) return;
  // 轮转而不是清空（0.3.61）：gateway 崩溃的栈写在上一份 gateway.log 里，启动即
  // 清空正好销毁唯一现场——10-01 两次无征兆退出因此无据可查。保留 10 代并写分隔行。
  if (fs.existsSync(gatewayLog) && fs.statSync(gatewayLog).size > 0) {
    fs.rmSync(`${gatewayLog}.10`, { force: true });
    for (let index = 9; index >= 1; index -= 1) {
      if (fs.existsSync(`${gatewayLog}.${index}`)) fs.renameSync(`${gatewayLog}.${index}`, `${gatewayLog}.${index + 1}`);
    }
    fs.renameSync(gatewayLog, `${gatewayLog}.1`);
  }
  const fd = fs.openSync(gatewayLog, 'a', 0o600);
  fs.writeSync(fd, `=== gateway start ${new Date().toISOString()} ===\n`);
  gateway = fork(path.join(appDir, 'gateway.js'), [], {
    // PATH 显式前置 runtime/.bin（0.3.61）：与 startDsh 对齐。gateway 是管理页的
    // 后端，用户点「安装/卸载插件」时它承载的操作会 spawn pnpm；若它继承到的 PATH
    // 里没有 runtime/.bin，就会命中 corepack shim → pnpm 12.8.1 → 写坏
    // .modules.yaml 的 storeDir → 之后所有插件操作 ERR_PNPM_UNEXPECTED_STORE。
    // 虽然本进程已在启动时补过 PATH（见文件顶部），这里再显式一层，
    // 防止 gateway 被以别的方式拉起时又丢掉。
    env: { ...gitEnv.normalizeGitParentEnv(process.env),
      PATH: `${path.join(appDir, 'runtime', 'node_modules', '.bin')}${path.delimiter}${process.env.PATH || ''}`,
      // 同 spawnDsh：corepack 兜底，避免 `$HOME/.cache/node/corepack` 不可写。
      COREPACK_HOME: ops.dataPath(dataDir, 'corepack-home'), HOME: ops.dataPath(dataDir, 'home'),
      FNOS_APP_DIR: appDir, FNOS_DATA_DIR: dataDir, DSH_HOME: dshHome || ops.dataPath(dataDir, 'dsh-home'), GUIDE_SOCKET: guideSocket, DSH_PORT: String(corePort), NODE_PATH: path.join(appDir, 'runtime', 'node_modules') },
    execArgv: [...process.execArgv, '--require', portOwner.instancePreload(dataDir)],
    stdio: ['ignore', fd, fd, 'ipc']
  });
  fs.closeSync(fd);
  const startedGateway = gateway;
  gateway.on('message', (message) => {
    if (message?.type === 'public-port-result') {
      const reply = portReplies.get(message.id);
      if (reply) { portReplies.delete(message.id); reply(message.ok ? null : new Error(message.error || '端口切换失败')); }
      return;
    }
    if (stopping || shuttingDown || message?.type !== 'command' || !actions.isSupervisorAction(message.action)) return;
    operation = operation.catch(() => {}).then(() => runCommand(message));
  });
  gateway.on('exit', (code, signal) => {
    // 退出原因只有这里能持久化（gateway.log 随重启轮转，supervisor 控制台无处落盘）：
    // signal=SIGKILL 基本可判定被 OOM 或外部杀掉，code≠0 是进程自身崩溃。
    eventLog('gateway_exited', { code: code ?? null, signal: signal ?? null, expected: stopping });
    if (!stopping && !shuttingDown && gateway === startedGateway) {
      gateway = null;
      log(`gateway exited (${code}); supervisor will restart it`);
      // P4（0.3.61）：固定 1 秒重启可能撞上旧进程尚未释放监听套接字的窗口，
      // 于是新 gateway 直接 EADDRINUSE 退出、再被重启……形成竞态。这里在重启前
      // 轮询等待端口真正空闲（最多 ~5 秒），与 gateway 内部的 EADDRINUSE 重试
      // 形成双保险。等待失败也照常重启（让 gateway 自己的重试兜底）。
      waitForGatewayPortFree().finally(() => { if (!stopping && !shuttingDown && !gateway) gatewayRestartTimer = setTimeout(startGateway, 1000); });
    }
  });
}

async function waitForGatewayControl(timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && !shuttingDown) {
    if (!gateway || exited(gateway)) throw new Error('网关在恢复期间退出');
    try {
      await new Promise((resolve, reject) => {
        const req = http.get({ socketPath: guideSocket, path: '/app/dsh-fnos/manage/state', headers: { host: 'localhost', 'x-trim-isadmin': 'true', 'x-trim-userid': 'supervisor' }, timeout: 1000 }, res => {
          res.resume(); res.on('end', () => res.statusCode === 200 || res.statusCode === 503 ? resolve() : reject(new Error('控制面响应异常'))); res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('控制面探测超时'))); req.on('error', reject);
      });
      return;
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error('网关控制面未恢复');
}

async function checkUpdate() {
  const settings = updateSettings();
  const response = await fetch(new URL('@deepseek-ai%2fdsh', settings.registry), {
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
  const metadata = await response.json();
  const result = {
    checkedAt: new Date().toISOString(),
    bundledVersion: state.bundledVersion,
    activeVersion: state.activeVersion,
    registry: settings.registry,
    latest: metadata['dist-tags']?.latest ?? null,
    next: metadata['dist-tags']?.next ?? null
  };
  ops.writeJson(ops.dataPath(dataDir, 'update.json'), result);
  return result;
}

function deferAutomaticBackup(source, reason) {
  const previous = state.automaticBackupDeferred || {};
  if (previous[source]?.reason !== reason) {
    const entry = { reason, at: new Date().toISOString() };
    publish({ automaticBackupDeferred: { ...previous, [source]: entry } });
    log(`automatic ${source} backup deferred: ${automaticBackups.reasonText(reason)}; use manual backup if needed`);
    eventLog('automatic_backup_deferred', { source, reason });
  }
  return { skipped: 'automatic-deferred', reason, source };
}
function clearAutomaticBackupDeferred(source = null) {
  if (!state.automaticBackupDeferred) return;
  const next = { ...state.automaticBackupDeferred };
  if (source) delete next[source];
  else for (const key of Object.keys(next)) delete next[key];
  if (Object.keys(next).length === Object.keys(state.automaticBackupDeferred).length) return;
  publish({ automaticBackupDeferred: Object.keys(next).length ? next : null });
}
async function backup(kind, { automatic = kind === 'daily', source = kind === 'daily' ? 'daily' : 'session' } = {}) {
  const settings = ops.backupSettings(dataDir);
  if (kind === 'daily' && settings.dailyMode === 'updates') {
    clearAutomaticBackupDeferred('daily');
    return { skipped: 'updates-only' };
  }
  if (automatic) {
    const decision = automaticBackups.decide({ mode: state.mode,
      coreHandlePresent: Boolean(dsh), coreStopConfirmed, restartPending: Boolean(cleanExitTimer),
      stopping, shuttingDown, cliActive: plugins.cliOperationStatus().length > 0 });
    if (!decision.allowed) return deferAutomaticBackup(source, decision.reason);
  }
  const wasSafe = state.mode === 'safe';
  if (plugins.cliOperationStatus().length) {
    const error = Object.assign(new Error('备份未执行：仍有管理CLI尚未确认退出，不能与安装器并发复制数据；请勿重复操作'), { code: 'ERR_CLI_UNCONFIRMED' });
    publish({ error: error.message });
    throw error;
  }
  if (!wasSafe) publishMaintenance('创建配置备份（期间暂停 DSH 服务，完成后自动重新启动）');
  // safe is a UI/recovery state, not proof of process death (e.g. a failed stop).
  // Never copy files or advance the archive ledger until stop is confirmed.
  try {
    // Automatic backups only copy after an already-confirmed safe-mode stop.
    // They must not signal, cancel a restart, or stop an orphan core.
    if (!automatic) await stopDsh();
    if (plugins.cliOperationStatus().length) throw Object.assign(new Error('停止期间出现未确认退出的管理CLI，拒绝并发备份'), { code: 'ERR_CLI_UNCONFIRMED' });
  }
  catch (error) {
    publish({ mode: 'safe', error: `备份未执行：无法确认核心停止，未创建快照或更新存档账本，不会继续启动核心：${error.message}` });
    throw error;
  }
  let snapshot, backupError, restartError;
  try {
    const lastDaily = kind === 'daily' ? ops.listBackups(dataDir).find((item) => item.kind === 'daily') : null;
    if (kind === 'daily' && settings.dailyMode === 'changed' && lastDaily?.fingerprint === ops.snapshotFingerprint(dataDir, configDir)) snapshot = { skipped: 'unchanged' };
    else snapshot = ops.createSnapshot(dataDir, configDir, kind, state.activeVersion);
    if (snapshot && !snapshot.skipped) {
      clearAutomaticBackupDeferred();
      try { ops.markSessionsArchived(dataDir, { snapshotId: snapshot.id }); } catch (error) { log('session archive mark failed: ' + error.message); }
    } else if (automatic && snapshot?.skipped) {
      clearAutomaticBackupDeferred(source);
    }
    if (wasSafe) publish({ mode: 'safe', lastBackup: snapshot?.createdAt ?? state.lastBackup });
  } catch (error) {
    backupError = error;
    if (wasSafe) publish({ mode: 'safe', error: `备份失败，已保留原数据与存档账本：${error.message}` });
  } finally {
    if (!wasSafe && !stopping && !shuttingDown) {
      try {
        await startDsh(activeDir);
        await probeWeb();
        publish({ mode: readyMode(), error: backupError ? `备份失败，核心已恢复运行：${backupError.message}` : null, lastBackup: snapshot?.createdAt ?? state.lastBackup });
      } catch (error) {
        let stopError;
        try { await stopDsh(); } catch (failure) { stopError = failure; }
        const message = `${backupError ? `备份失败：${backupError.message}；` : ''}${snapshot?.id ? '备份已创建，但' : '备份后'}核心恢复失败：${error.message}${stopError ? `；且停止未确认：${stopError.message}` : ''}`;
        restartError = Object.assign(new Error(message), { cause: error, snapshotId: snapshot?.id ?? null, backupError, stopError });
        publish({ mode: 'safe', error: message, lastBackup: snapshot?.createdAt ?? state.lastBackup });
      }
    }
  }
  if (backupError && restartError) throw Object.assign(new Error(restartError.message), { cause: backupError, backupError, restartError, snapshotId: snapshot?.id ?? null });
  if (backupError) throw backupError;
  if (restartError) throw restartError;
  return snapshot;
}

async function switchProfile(name, create = false) {
  const selected = create ? profiles.create(dataDir, name) : profiles.validateName(name);
  if (!create && !profiles.list(dataDir).includes(selected)) throw new Error('dsh profile does not exist');
  const previous = profiles.selected(dataDir);
  if (!create && previous === selected) return { name: selected };
  publishMaintenance(`正在切换到配置档 ${selected}（切换前自动备份）`, 40);
  await stopDsh();
  const snapshot = ops.createSnapshot(dataDir, configDir, 'pre-upgrade', state.activeVersion);
  try {
    await startDsh(activeDir, selected, create);
    await probeWeb();
    ops.writeJson(ops.dataPath(dataDir, 'profile-selection.json'), { name: selected });
    publish({ mode: readyMode(), lastBackup: snapshot.createdAt, error: null });
    return { name: selected };
  } catch (error) {
    await stopDsh();
    ops.restoreSnapshot(dataDir, configDir, snapshot.id);
    try { await startDsh(activeDir, previous); publish({ mode: readyMode(), error: `Profile switch failed: ${error.message}` }); }
    catch (rollbackError) { await stopDsh(); publish({ mode: 'safe', error: `Profile switch rollback failed: ${rollbackError.message}` }); }
    throw error;
  }
}

async function installPlugin(spec) {
  const profile = profiles.selected(dataDir);
  const registry = updateSettings().registry;
  publishMaintenance(`正在安装插件 ${spec}（含依赖解析，可能需要下载）`, 120);
  await stopDsh();
  const snapshot = ops.createSnapshot(dataDir, configDir, 'pre-upgrade', state.activeVersion);
  try {
    const result = await plugins.install(dataDir, profile, spec, registry);
    await startDsh(activeDir);
    await probeWeb();
    clearPendingRestore();
    publish({ mode: readyMode(), lastBackup: snapshot.createdAt, error: null });
    return result;
  } catch (error) {
    // Try the data as it stands before offering to roll it back: a refused
    // install usually leaves the tree untouched, and the snapshot is older
    // than everything the user has done since.
    if (await startsAsIs()) {
      publish({ mode: readyMode(), lastBackup: snapshot.createdAt, error: `插件安装失败：${error.message}（当前数据仍可启动，未回滚）` });
      throw error;
    }
    deferRollback(snapshot, `插件安装失败，且当前数据无法启动：${error.message}`, 'install-plugin');
    throw error;
  }
}

// Enable/disable rewrites one array in the profile manifest and nothing else,
// so the undo is the toggle itself. Building a full snapshot here (and rolling
// the whole data directory back on failure) both wasted the pre-upgrade
// retention budget and could discard hours of sessions to revert a one-word
// change.
async function setPluginEnabled(action, name, label, profile, wasSafe) {
  const wasEnabled = plugins.list(dataDir, profile).some((item) => item.name === name && item.enabled);
  // 预检（0.3.61）：停 core 之前先验证插件文件在位——否则校验失败会把运行中
  // 的 core 打进 safe mode（曾致全部第三方插件掉线的事故链一环）。
  if (action === 'enable-plugin') {
    const installedManifest = ops.readJson(path.join(profiles.directory(dataDir, profile), 'node_modules', ...name.split('/'), 'package.json'));
    if (installedManifest?.name !== name) {
      publish({ mode: readyMode(), error: '插件 ' + name + ' 文件缺失（node_modules 不完整），无法启用' });
      throw new Error('Installed plugin files are missing');
    }
  }
  // Validate package/AST binding and precise restore feasibility while the
  // existing core is still running. Unsupported input must not cause downtime.
  plugins.setEnabled(dataDir, profile, name, action === 'enable-plugin', { preflightOnly: true });
  publishMaintenance('正在更改插件启用状态（会重启核心生效）');
  try { await stopDsh(); }
  catch (error) {
    publish({ mode: 'safe', error: `插件${label}未执行：无法确认核心停止，已保留配置，不会继续写入或拉起核心：${error.message}` });
    throw error;
  }
  let changed = false;
  try {
    plugins.setEnabled(dataDir, profile, name, action === 'enable-plugin');
    changed = true;
    await startDsh(activeDir);
    await probeWeb();
    clearPendingRestore();
    publish({ mode: readyMode(), error: null });
    return { name, enabled: action === 'enable-plugin' };
  } catch (error) {
    if (configCoordination.isUnconfirmed(error)) {
      publish({ mode: 'safe', error: `插件${label}事务恢复未确认，已保留证据；不继续改写或重启核心：${error.message}` });
      throw error;
    }
    try { await stopDsh(); }
    catch (stopError) {
      publish({ mode: 'safe', error: `插件${label}失败，且无法确认核心停止；已保留当前配置，不继续恢复或重启：${error.message}；${stopError.message}` });
      throw stopError;
    }
    // In safe mode the administrator is deliberately disabling plugins to
    // find the one that breaks startup, so a still-broken core keeps the
    // change instead of undoing it.
    if (changed && wasSafe && action === 'disable-plugin') {
      const warning = `插件已${label}，DSH 仍未启动：${error.message}`;
      publish({ mode: 'safe', error: warning });
      return { name, enabled: false, warning };
    }
    try {
      plugins.setEnabled(dataDir, profile, name, wasEnabled);
      await startDsh(activeDir);
      await probeWeb();
      publish({ mode: readyMode(), error: `插件${label}失败：${error.message}（已恢复原状态）` });
      return { name, enabled: wasEnabled, warning: `插件${label}失败，已恢复原状态` };
    } catch (restoreError) {
      if (configCoordination.isUnconfirmed(restoreError)) {
        publish({ mode: 'safe', error: `插件${label}恢复事务未确认，保留证据且不继续重启：${restoreError.message}` });
        throw restoreError;
      }
      try { await stopDsh(); } catch {}
      publish({ mode: 'safe', error: `插件${label}失败：${error.message}，且恢复原状态后 DSH 仍无法启动` });
      throw error;
    }
  }
}

// Uninstall rewrites installed files and the lockfile, so it does keep a
// snapshot -- but only as an offer. The data is started as it stands first;
// the snapshot is applied only if the administrator approves it.
async function uninstallPlugin(name, label, profile) {
  publishMaintenance(`正在卸载插件 ${name}（会重写依赖清单）`);
  try { await stopDsh(); }
  catch (error) {
    publish({ mode: 'safe', error: `插件卸载未执行：无法确认核心停止，已保留数据，不继续卸载或重启：${error.message}` });
    throw error;
  }
  let snapshot;
  try { snapshot = ops.createSnapshot(dataDir, configDir, 'pre-upgrade', state.activeVersion); }
  catch (error) {
    const running = await startsAsIs();
    publish({ mode: running ? readyMode() : 'safe', error: `插件卸载未执行：操作前备份失败，已保留原数据；${running ? '核心已恢复运行' : '核心仍未启动，请查看日志'}：${error.message}` });
    throw error;
  }
  let result;
  try {
    result = await plugins.uninstall(dataDir, profile, name, updateSettings().registry);
  } catch (error) {
    if (configCoordination.isUnconfirmed(error)) {
      publish({ mode: 'safe', lastBackup: snapshot.createdAt, error: `插件卸载执行/恢复未确认，已保留当前数据与操作前备份；不继续改写或并发启动核心，请勿重复操作：${error.message}` });
      throw error;
    }
    if (await startsAsIs()) {
      publish({ mode: readyMode(), lastBackup: snapshot.createdAt, error: `插件${label}失败：${error.message}（当前数据仍可启动，未回滚）` });
      throw error;
    }
    deferRollback(snapshot, `插件${label}失败，且当前数据无法启动：${error.message}`, 'uninstall-plugin');
    throw error;
  }
  if (await startsAsIs()) {
    const cleaned = Array.isArray(result?.cleaned) && result.cleaned.length ? `，并清理了${result.cleaned.join('、')}` : '';
    clearPendingRestore();
    const warning = result?.removedBy === 'manual' ? (result.degradeNote || `仅从配置层摘除 ${name}；node_modules 文件仍保留，未完成文件清理`) : null;
    publish({ mode: readyMode(), lastBackup: snapshot.createdAt, error: null, notice: warning || `已卸载 ${name}${cleaned}` });
    return { ...result, cleaned, notice: warning || `已卸载 ${name}${cleaned}`, ...(warning ? { warning } : {}) };
  }
  const reason = `插件已${label}，但 DSH 未能启动`;
  deferRollback(snapshot, reason, 'uninstall-plugin');
  return { ...result, pendingRestore: true, warning: `${reason}。可在下方选择是否恢复到操作前的快照。` };
}

async function managePlugin(action, spec) {
  const wasSafe = state.mode === 'safe';
  const profile = profiles.selected(dataDir);
  const { name, requestedVersion } = plugins.parseSpec(spec);
  const installed = plugins.list(dataDir, profile).find((item) => item.name === name);
  if (requestedVersion || !installed) throw new Error('Plugin is not installed in this profile');
  if (installed.enablementError) throw new Error(`插件启用状态记录损坏，已拒绝操作且未停服；请从备份页恢复配置：${installed.enablementError}`);
  const label = action === 'enable-plugin' ? '启用' : '禁用';
  return action === 'uninstall-plugin'
    ? uninstallPlugin(name, '卸载', profile)
    : setPluginEnabled(action, name, label, profile, wasSafe);
}

// Hold a rollback for approval instead of applying it. The snapshot stays on
// disk, safe mode keeps the management page reachable, and the administrator
// decides from the pending-restore banner.
function deferRollback(snapshot, reason, action) {
  raisePendingRestore({ snapshotId: snapshot.id, reason, action, version: state.activeVersion });
}

async function installCore(version) {
  const selectedVersion = String(version || '');
  const settings = updateSettings();
  const directory = await cores.installCore(dataDir, appDir, selectedVersion, settings.registry);
  const previousDir = activeDir;
  publishMaintenance(`正在安装 DSH 核心 ${selectedVersion}（含下载与校验）`, 180);
  await stopDsh();
  let snapshot;
  try {
    snapshot = ops.createSnapshot(dataDir, configDir, 'pre-upgrade', state.activeVersion);
    await startDsh(directory);
    await probeWeb();
    cores.selectCore(dataDir, selectedVersion);
    activeDir = directory;
    clearPendingRestore();
    publish({ mode: 'ready', activeVersion: selectedVersion, lastBackup: snapshot.createdAt, error: null });
    try { ops.promoteRuntime(directory, dataDir); }
    catch (error) { log(`last-good runtime copy failed: ${error.message}`); publish({ error: `Rollback copy failed: ${error.message}` }); }
    // 升级后按新 runtime 重建回退层（0.3.61 任务 C）：新核心新增的包必须立刻可被
    // profile 解析，否则新核心自身的行会缺服务（hook/启动路径失效）。
    try {
      const sync = ops.syncFallbackLayer(directory, dataDir);
      if (sync.added || sync.removed) log('fallback layer synced after upgrade: +' + sync.added + ' -' + sync.removed + ' (total ' + sync.total + ')');
    } catch (error) { log('fallback layer sync failed: ' + error.message); }
    return { version: selectedVersion };
  } catch (error) {
    await stopDsh();
    activeDir = previousDir;
    if (stopping) throw error;
    // A new core that cannot start is the one case where the previous core is
    // known good, so fall back to it -- but the data rollback that used to
    // accompany it is now the administrator's call.
    try {
      await startDsh(previousDir);
      const reason = `dsh ${selectedVersion} 启动失败：${error.message}`;
      if (snapshot) {
        raisePendingRestore({
          snapshotId: snapshot.id,
          reason: `${reason}。已回到上一个核心 ${ops.dshVersion(previousDir)}，是否同时恢复数据？`,
          action: 'install-core', version: ops.dshVersion(previousDir), mode: readyMode()
        });
      } else publish({ mode: readyMode(), error: reason });
    } catch (rollbackError) {
      await stopDsh();
      const reason = `Core update and rollback failed: ${rollbackError.message}`;
      if (snapshot) raisePendingRestore({ snapshotId: snapshot.id, reason, action: 'install-core' });
      else publish({ mode: 'safe', error: reason });
    }
    throw error;
  }
}

async function runCommand(message) {
    // patch 层修复后的标准重启链（heal / dedupe / disable-third-party 共用）：
    // 换当前 core → 拉起 → 探活 → 刷新状态；失败落回 safe mode 并带上修复语境。
    async function restartCoreAfterPatchFix(label) {
      await stopDsh();
      publish({ mode: 'starting', error: null });
      try {
        activeDir = cores.selectedCore(dataDir, appDir);
        await startDsh(activeDir);
        await probeWeb();
        publish({ mode: readyMode(), activeVersion: ops.dshVersion(activeDir) });
        try { ops.promoteRuntime(activeDir, dataDir); } catch (error) { log(`last-good runtime copy failed: ${error.message}`); }
        return state;
      } catch (error) {
        publish({ mode: 'safe', error: error.message });
        return { warning: `${label}已执行，但重启仍失败：${error.message}` };
      }
    }
    // 收集"全部第三方插件"的 loader entry id 候选（对照上游桌面版 fatal-recovery
    // 的 disablePlugins：禁插件本体，覆盖 bundles 层与包名两个 id 形态）。
    // @deepseek-ai/* 属于核心，绝不纳入；不存在的 id 行对 loader 无害。
    function thirdPartyEntryIds() {
      const manifest = ops.readJson(path.join(profiles.directory(dataDir, profiles.selected(dataDir)), 'package.json'), {}) || {};
      const names = new Set();
      for (const name of Object.keys(manifest.dependencies || {})) if (!name.startsWith('@deepseek-ai/')) names.add(name);
      for (const name of (manifest?.dsh?.profile?.bundles || [])) if (!name.startsWith('@deepseek-ai/')) names.add(name);
      const ids = [];
      for (const name of names) {
        ids.push(name);
        const base = name.includes('/') ? name.split('/').pop() : null;
        if (base) ids.push(base);
      }
      return [...new Set(ids)];
    }
  let result;
  eventLog('operation_started', { action: message.action });
  try {
    if (message.action === 'check-update') result = await checkUpdate();
    else if (message.action === 'install-core') result = await installCore(message.version);
    else if (message.action === 'switch-core') {
      if (!cores.listCores(dataDir).includes(message.version)) throw new Error('Selected dsh version is not installed');
      result = await installCore(message.version);
    }
    else if (message.action === 'create-profile') result = await switchProfile(message.profile, true);
    else if (message.action === 'switch-profile') result = await switchProfile(message.profile);
    else if (message.action === 'install-plugin') result = await installPlugin(message.packageName);
    else if (['disable-plugin', 'enable-plugin', 'uninstall-plugin'].includes(message.action)) result = await managePlugin(message.action, message.packageName);
    else if (message.action === 'set-backup-settings') {
      result = ops.saveBackupSettings(dataDir, {
        daily: message.dailyLimit, manual: message.manualLimit,
        'pre-upgrade': message.upgradeLimit, dailyMode: message.dailyMode,
        sessionMode: message.sessionMode, sessionInterval: message.sessionInterval
      });
      // 策略改动立即生效：重排定时器；切到 auto 就马上检查一次，不必等下次启动。
      if (result.dailyMode === 'updates') clearAutomaticBackupDeferred('daily');
      if (result.sessionMode === 'manual') clearAutomaticBackupDeferred('session');
      scheduleSessionCheck();
      if (result.sessionMode === 'auto') maybeAutoArchiveSessions();
    }
    else if (message.action === 'set-registry') {
      const registry = cores.registryUrl(message.registry);
      ops.writeJson(ops.dataPath(dataDir, 'update-settings.json'), { ...updateSettings(), registry });
      checkUpdate().catch((error) => log(`update check failed: ${error.message}`));
      result = { registry };
    }
    else if (message.action === 'set-docker-mode') {
      const next = String(message.dockerMode || '');
      if (!['system', 'rootless'].includes(next)) throw new Error('无效的 Docker 连接模式');
      if (next === 'rootless' && !(await dockerAccess.probe()).ready) throw new Error('尚未检测到应用用户的 Rootless Docker 守护进程');
      const previous = dockerAccess.selected(dataDir);
      if (next !== previous) {
        dockerAccess.save(dataDir, next);
        if (['ready', 'rollback'].includes(state.mode)) {
          await stopDsh();
      publishMaintenance('正在切换 Docker 访问设置', 30);
          try {
            await startDsh(activeDir);
            await probeWeb();
            publish({ mode: readyMode(), error: null });
          } catch (error) {
            await stopDsh();
            dockerAccess.save(dataDir, previous);
            try { await startDsh(activeDir); publish({ mode: readyMode(), error: `Docker 连接切换失败：${error.message}` }); }
            catch (rollbackError) { publish({ mode: 'safe', error: `Docker 连接回滚失败：${rollbackError.message}` }); }
            throw error;
          }
        }
      }
      result = { mode: next };
    }
    else if (message.action === 'set-core-port') {
      const next = Number(message.corePort);
      if (!Number.isInteger(next) || next < 1024 || next > 65535) throw new Error('端口号必须是 1024–65535 的整数');
      if (next === effectivePublicPort()) throw new Error(`内部端口不能与公网入口端口 ${effectivePublicPort()} 相同`);
      const previous = corePort;
      if (next !== previous) {
        const shouldRestart = ['ready', 'rollback'].includes(state.mode);
      if (shouldRestart) publishMaintenance(`正在切换内部端口到 ${next}（需重启核心）`, 30);
        await stopDsh();
        ops.savePorts(dataDir, { corePort: next });
        corePort = next;
        if (shouldRestart) {
          try {
            await startDsh(activeDir);
            await probeWeb();
            publish({ mode: readyMode(), error: null });
          } catch (error) {
            await stopDsh();
            corePort = previous;
            ops.savePorts(dataDir, { corePort: previous });
            try { await startDsh(activeDir); await probeWeb(); publish({ mode: readyMode(), error: `端口切换失败：${error.message}（已恢复端口 ${previous}）` }); }
            catch (rollbackError) { await stopDsh(); publish({ mode: 'safe', error: `端口切换回滚失败：${rollbackError.message}` }); }
            throw error;
          }
        }
      }
      gateway?.send({ type: 'core-port', port: corePort });
      result = { corePort: corePort };
    }
    else if (message.action === 'set-public-port') {
      const next = Number(message.publicPort);
      if (!Number.isInteger(next) || next < 1024 || next > 65535) throw new Error('端口号必须是 1024–65535 的整数');
      if (next === corePort) throw new Error(`公网入口端口不能与内部核心端口 ${corePort} 相同`);
      const previous = ops.portSettings(dataDir).publicPort;
      const effectiveNext = next === manifestPortEnv ? null : next;
      if (effectiveNext === previous) { result = { publicPort: next }; }
      else {
        if (effectiveNext !== null && !(await probeBindable(effectiveNext))) throw new Error(`端口 ${effectiveNext} 已被占用，请换一个端口`);
        ops.savePorts(dataDir, { publicPort: effectiveNext });
        try { await askGatewayPublicPort(next); }
        catch (error) {
          ops.savePorts(dataDir, { publicPort: previous ?? null });
          throw new Error(`网关切换端口失败：${error.message}（设置已恢复）`);
        }
        result = { publicPort: next };
      }
    }
    else if (message.action === 'backup') result = await backup('manual');
    else if (message.action === 'safe-mode') { await stopDsh(); publish({ mode: 'safe', error: 'Safe mode selected by administrator' }); result = state; }
    else if (message.action === 'use-bundled') {
      const previousDir = activeDir;
      await stopDsh();
          publishMaintenance('正在切换到内置核心版本', 60);
      let snapshot;
      try {
        snapshot = ops.createSnapshot(dataDir, configDir, 'pre-upgrade', state.activeVersion);
        await startDsh(appDir);
        await probeWeb();
        cores.clearSelection(dataDir);
        activeDir = appDir;
        publish({ mode: 'ready', activeVersion: ops.dshVersion(appDir), lastBackup: snapshot.createdAt });
        result = state;
      } catch (error) {
        await stopDsh();
        if (snapshot) {
          try { ops.restoreSnapshot(dataDir, configDir, snapshot.id); }
          catch (restoreError) { error = new Error(`${error.message}; data restore failed: ${restoreError.message}`); }
        }
        activeDir = previousDir;
        publish({ mode: 'safe', error: `Bundled core failed: ${error.message}` });
        throw error;
      }
    }
    else if (message.action === 'save-patch-config') {
      const selected = profiles.selected(dataDir);
      if (message.profile !== selected || !/^(?:[a-f0-9]{64}|missing)$/.test(message.patchRevision || '')) throw Object.assign(new Error('配置页面版本或配置档已变化，请刷新后再保存'), { code: 'ERR_CONFIG_CONFLICT' });
      result = ops.writePatchConfig(dataDir, String(message.content ?? ''), patchYamlModule(), selected, { expectedRevision: message.patchRevision });
    }
    else if (message.action === 'disable-patch-config') result = ops.disablePatchConfig(dataDir, patchYamlModule());
    else if (message.action === 'disable-third-party-plugins') {
      // safe mode 的第三恢复按钮（上游 desktop fatal-recovery 同款）：把全部第三方
      // 插件的 loader entry 置 disabled 后重启。文本级合并保留注释与用户条目；
      // 恢复方式：配置文件页的备份恢复下拉，或 dsh-fix 重置整层。
      const profileName = profiles.selected(dataDir);
      const file = path.join(profiles.directory(dataDir, profileName), 'cordis.patch.yml');
      const snapshotText = configCoordination.snapshot(file);
      const text = snapshotText ?? '';
      const expectedRevision = configCoordination.revision(snapshotText);
      // 现内容可能语法损坏（正是需要 safe mode 的场景）——禁用合并会因
      // writePatchConfig 校验失败而整个操作失败（曾 15ms 即失败）。降级：以
      // 最新可解析备份为基底执行禁用，保住用户配置。
      const health = ops.diagnosePatchLayer(text, patchYamlModule());
      let baseText = text;
      let baseNote = '';
      if (!health.ok) {
        const base = ops.newestValidPatchBackup(dataDir, patchYamlModule(), profileName);
        if (!base) {
          result = { warning: 'patch 配置语法损坏且无可用备份，请改用「重置 patch 配置」' };
          return result;
        }
        baseText = base.text;
        baseNote = '（原配置语法损坏，已基于备份 ' + base.name + ' 重建后禁用）';
      }
      const ids = thirdPartyEntryIds();
      const merged = ops.disablePatchEntries(baseText, ids);
      if (!merged.changed) {
        result = { warning: '未发现可禁用的第三方插件条目（可能已全部禁用）' };
      } else {
        ops.backupPatchConfig(dataDir, file, profileName);
        ops.writePatchConfig(dataDir, merged.text, patchYamlModule(), profileName, { expectedRevision });
        normalizeProfilePatch(profileName);
        log(`third-party plugins disabled: ${merged.applied.join(', ')}`);
        result = await restartCoreAfterPatchFix('已禁用全部第三方插件' + baseNote);
      }
    }
    else if (message.action === 'enter-diagnosis') {
      const diagnosis = require('./diagnosis-mode').enter(dataDir);
      result = { ...state, diagnosis, note: '已打开只读 AI 辅助诊断；未修改配置、未重启核心。' };
    }
    else if (message.action === 'exit-diagnosis') {
      const recovery = require('./diagnosis-mode').exit(dataDir, patchYamlModule());
      result = recovery.needsRestart
        ? await restartCoreAfterPatchFix('旧诊断模式的原配置已恢复')
        : { ...state, diagnosis: recovery.diagnosis, note: recovery.restored ? '原配置档已恢复，当前其他配置档未重启。' : '已关闭只读诊断，未修改配置。' };
    }
    else if (message.action === 'heal-patch-layer') {
      // safe mode 一键修复：无论现内容是什么，先备份再重置为合法空层，随后
      // 按 retry 路径重启 core。注意禁用 action 的重启语义：写完配置必须
      // normalize（含双文档检查）并真正拉起 core，否则管理员看到"已重置"
      // 却仍停在 safe mode。
      const profileName = profiles.selected(dataDir);
      const file = path.join(profiles.directory(dataDir, profileName), 'cordis.patch.yml');
      const expectedRevision = configCoordination.revision(configCoordination.snapshot(file));
      ops.backupPatchConfig(dataDir, file, profileName);
      // 修复顺序（0.3.61）：① 最新可解析备份（保留用户配置） ② 兜底清空。
      // 直接清空曾导致一次事故：备份目录里有 16 条的完好备份，heal 却把配置
      // 降成 2 条，插件配置全部丢失（见 MEMORY 二十二·补）。
      const healBackup = ops.newestValidPatchBackup(dataDir, patchYamlModule(), profileName);
      if (healBackup && healBackup.entries > 0) {
        ops.writePatchConfig(dataDir, healBackup.text, patchYamlModule(), profileName, { expectedRevision });
        normalizeProfilePatch(profileName);
        log('heal restored ' + healBackup.entries + ' entries from ' + healBackup.name);
        result = await restartCoreAfterPatchFix('已从备份 ' + healBackup.name + ' 恢复 ' + healBackup.entries + ' 个条目（保留用户配置；原文件已留底）');
      } else {
        ops.writePatchConfig(dataDir, ops.PATCH_EMPTY, patchYamlModule(), profileName, { expectedRevision });
        normalizeProfilePatch(profileName);
        result = await restartCoreAfterPatchFix('已重置 patch 配置（无可用的历史备份）');
      }
    }
    else if (message.action === 'dedupe-patch-layer') {
      // safe mode 一键修复：解析 patch 层，删除同 id 的重复声明（保留第一份），
      // 随后重启 core。若解析失败则退化为 heal（整体重置）。
      const profileName = profiles.selected(dataDir);
      const file = path.join(profiles.directory(dataDir, profileName), 'cordis.patch.yml');
      const snapshotText = configCoordination.snapshot(file);
      const text = snapshotText ?? '';
      const expectedRevision = configCoordination.revision(snapshotText);
      const dup = ops.findDuplicatePatchIds(text, patchYamlModule());
      if (dup) {
        ops.backupPatchConfig(dataDir, file, profileName);
        const next = ops.dedupePatchEntriesText(text, dup.duplicateIds);
        if (next !== null) ops.writePatchConfig(dataDir, next, patchYamlModule(), profileName, { expectedRevision });
      } else {
        // 检测不到重复（可能文件已坏）→ 退化为整体重置
        ops.writePatchConfig(dataDir, ops.PATCH_EMPTY, patchYamlModule(), profileName, { expectedRevision });
      }
      normalizeProfilePatch(profileName);
      result = await restartCoreAfterPatchFix('已清理重复声明');
    }
    else if (message.action === 'restore-patch-config') {
      // 与 heal/disable 同语义（0.3.61）：恢复后 normalize 并真正重启 core。
      // insert 类条目只有重启才生效；此前只写文件曾让管理员误判恢复失败。
      const profileName = profiles.selected(dataDir);
      // 恢复旧 (profile, backup) 组合由调用方显式声明；历史无来源备份必须由
      // 管理员在界面上勾选确认，绝不按当前选择自动推断。
      result = ops.restorePatchConfig(dataDir, String(message.backupName ?? ''), patchYamlModule(), profileName, {
        confirmLegacyProfile: String(message.confirmLegacyProfile ?? '') === 'true',
      });
      normalizeProfilePatch(profileName);
      result = await restartCoreAfterPatchFix('已恢复 patch 备份 ' + String(message.backupName ?? ''));
    }
    else if (message.action === 'snapshot-sessions') {
      // 会话存档检查（0.3.61）：设置页点「检查会话存档」时调用。有未存档的更新
      // 就建一份 manual 快照并把存档点后移；没有更新则直接返回，不建快照。
      const checked = await checkSessionArchive({ force: true });
      result = {
        ...checked,
        notice: checked.snapshotId
          ? '已为 ' + (checked.before?.added || 0) + ' 个新会话、' + (checked.before?.grown || 0) + ' 个有更新的会话建立快照（' + Math.round((checked.before?.pendingBytes || 0) / 1024) + ' KB）。'
          : '会话存档已是最新（' + checked.count + ' 个会话，无需新建快照）。',
      };
    }
    else if (message.action === 'sync-module-resolution') {
      // 解析卫生一键修复（0.3.61）：按当前核心目录重建回退层 + 归档遮蔽回退层的
      // 旧版核心包。只动 profile 的解析路径，不需要停 core；重启后生效。
      const coreDir = activeDir || appDir;
      const profileDir = profiles.directory(dataDir, profiles.selected(dataDir));
      let shadowed = { moved: [], dir: null };
      try { shadowed = ops.quarantineShadowedCorePackages(coreDir, path.join(profileDir, 'node_modules')); }
      catch (error) { log('quarantine failed: ' + error.message); }
      let sync = { added: 0, removed: 0, total: 0 };
      try { sync = ops.syncFallbackLayer(coreDir, dataDir); }
      catch (error) { log('fallback sync failed: ' + error.message); }
      result = { ...sync, shadowed: shadowed.moved, shadowedDir: shadowed.dir,
        notice: '已同步模块解析层：回退层修正 ' + sync.added + ' 项、清理断链 ' + sync.removed + ' 项（共 ' + sync.total + '），归档遮蔽包 ' + shadowed.moved.length + ' 个。核心重启后生效。' };
    }
    else if (message.action === 'restore-exemptions') {
      // 重建版本豁免（0.3.61）：豁免文件在 dsh-home 内，数据回滚会清空它。这里按
      // dataDir 根的期望清单（desired-exemptions.json）重新施加。
      const profileDir = profiles.directory(dataDir, profiles.selected(dataDir));
      const restored = ops.syncExemptions(dataDir, profileDir);
      result = { ...restored, notice: restored.added.length
        ? '已重建 ' + restored.added.length + ' 项版本豁免：' + restored.added.join('；') + '（核心重启后生效）'
        : '豁免已是最新，无需重建（当前期望清单 ' + restored.desired.length + ' 项）' };
    }
    else if (message.action === 'repair-plugin-wiring') {
      // 装载脱节修复（0.3.61）：把「已安装 + 被 patch 声明 + 未登记 bundles」的插件
      // 登记进 bundles，然后重启核心使其客户端模块被装载。
      const profileName = profiles.selected(dataDir);
      const repaired = ops.repairPluginWiring(dataDir, profileName, patchYamlModule());
      if (!repaired.fixed.length) {
        result = { ...repaired, notice: '没有需要登记的插件（可能已在启动时自动登记）。' };
      } else {
            publishMaintenance('正在修复插件登记（会重启核心生效）', 40);
        await stopDsh();
        try {
          await startDsh(activeDir);
          await probeWeb();
          clearPendingRestore();
          publish({ mode: readyMode(), error: null });
          result = { ...repaired, notice: '已登记 ' + repaired.fixed.length + ' 个插件到装载清单并重启：' + repaired.fixed.join('、') };
        } catch (error) {
          await stopDsh();
          publish({ mode: 'safe', error: error.message });
          throw error;
        }
      }
    }
    else if (message.action === 'repair-plugin-files') {
      // 插件文件健康修复（0.3.61）：node_modules 被半途失败的 pnpm 操作清空后
      // 的一键恢复——停 core → 按锁文件重建（官方 CLI install）→ 重启。
          publishMaintenance('正在按锁文件重建插件文件（可能需要下载）', 120);
      await stopDsh();
      let repair;
      try {
        repair = await plugins.repairPluginFiles(dataDir, profiles.selected(dataDir), updateSettings().registry);
      } catch (error) {
        if (configCoordination.isUnconfirmed(error)) {
          publish({ mode: 'safe', error: `插件重建结果未确认，保留锁与证据，不继续启动核心：${error.message}` });
          throw error;
        }
        repair = { ok: false, text: String(error.message || error), missing: [] };
      }
      try {
        await startDsh(activeDir);
        await probeWeb();
        clearPendingRestore();
        publish({ mode: readyMode(), error: repair.ok ? null : '插件目录重建未完全成功，详见 plugin-install.log' });
        result = { ...repair, notice: repair.ok ? '已按锁文件重建插件目录并重启' : '插件目录重建未完全成功，详见 plugin-install.log' };
      } catch (error) {
        await stopDsh();
        publish({ mode: 'safe', error: error.message });
        throw error;
      }
    }
    else if (message.action === 'run-terminal-command') result = await terminal.run(dataDir, profiles.selected(dataDir), String(message.commandText ?? ''), ops.dataPath(dataDir, 'plugin-install.log'), plugins);
    else if (message.action === 'restart-all') {
      const requestId = message.restartRequestId || randomBytes(16).toString('hex');
      if (!restartTracker.accept(requestId)) return state;
      const previousMode = state.mode;
      const restoreCore = Boolean(dsh && !exited(dsh));
      stopping = true; // 主动停网关时不得走崩溃respawn。
      clearTimeout(gatewayRestartTimer);
      clearTimeout(sessionTimer); clearInterval(sessionTimer);
      clearTimeout(dailyTimer);
      try {
        publishMaintenance('正在完全重启程序', 90);
        await stopDsh();
        await stopGateway();
        if (shuttingDown) throw new Error('应用已收到停止请求，取消替换进程镜像');
        if (!await waitForGatewayPortFree(8000)) throw new Error('网关监听尚未释放，拒绝execve');
        if (!await probeBindable(corePort)) throw new Error('核心监听尚未释放，拒绝execve');
        process.execve(process.execPath, [process.execPath, ...process.execArgv, __filename], gitEnv.normalizeGitParentEnv(process.env));
        throw new Error('execve returned without replacing the process image');
      } catch (error) {
        try { restartTracker.fail(); } catch (receiptError) { log('Restart failure receipt unavailable: ' + receiptError.message); }
        log('restart-all failed: ' + error.message);
        if (!shuttingDown) {
          stopping = false;
          try {
            startGateway();
            await waitForGatewayControl();
            if (restoreCore && (!dsh || exited(dsh))) { await startDsh(activeDir); await probeWeb(); }
            publish({ mode: restoreCore ? readyMode() : previousMode, error: '完全重启失败，已恢复原服务：' + error.message });
            scheduleDaily(); scheduleSessionCheck();
            eventLog('restart_all_recovered', { reason: error.message });
          } catch (recoveryError) {
            stopping = true;
            publish({ mode: 'safe', error: '完全重启及恢复均失败：' + recoveryError.message });
            eventLog('restart_all_recovery_failed', { reason: recoveryError.message });
            try { await stopDsh(); await stopGateway(); } catch (cleanupError) { log('restart cleanup failed: ' + cleanupError.message); }
            process.exitCode = 1;
            setImmediate(() => process.exit(1)); // 不留下活着却失去控制面的守护进程。
          }
        }
        throw error;
      }
    }
    else if (message.action === 'retry') {
      await stopDsh();
      publish({ mode: 'starting', error: null });
      try {
        activeDir = cores.selectedCore(dataDir, appDir);
        await startDsh(activeDir);
        await probeWeb();
        publish({ mode: readyMode(), activeVersion: ops.dshVersion(activeDir) });
        try { ops.promoteRuntime(activeDir, dataDir); } catch (error) { log(`last-good runtime copy failed: ${error.message}`); }
        result = state;
      } catch (error) { await stopDsh(); publish({ mode: 'safe', error: error.message }); throw error; }
    } else if (message.action === 'restore') {
      await stopDsh();
      const backupId = String(message.backupId || '');
          publishMaintenance(`正在恢复备份 ${backupId}（会覆盖当前数据）`, 90);
      // Restoring overwrites the live data and then deletes the copy it
      // displaced, so a mis-click had no way back. Take a safety snapshot of
      // what is about to be replaced, and tell the administrator its id.
      const safety = ops.createSnapshot(dataDir, configDir, 'manual', state.activeVersion);
      try {
        result = ops.restoreSnapshot(dataDir, configDir, backupId);
        await startDsh(activeDir);
        await probeWeb();
        clearPendingRestore();
        publish({ mode: readyMode(), lastBackup: safety.createdAt, error: null });
        result = { ...result, safetyBackupId: safety.id, notice: `已恢复到 ${result.createdAt} 的备份。恢复前的数据已另存为 ${safety.id}，如需退回可在下方恢复它。` };
      } catch (error) {
        await stopDsh();
        publish({ mode: 'safe', error: `Backup restore failed: ${error.message}` });
        throw error;
      }
    }
    else if (message.action === 'confirm-restore') {
      if (!pendingRestore) throw new Error('当前没有待确认的恢复');
      const target = pendingRestore;
          publishMaintenance('正在应用待确认的恢复（会覆盖当前数据）', 90);
      await stopDsh();
      try {
        result = ops.restoreSnapshot(dataDir, configDir, target.snapshotId);
        await startDsh(activeDir);
        await probeWeb();
        clearPendingRestore();
        publish({ mode: readyMode(), lastBackup: target.createdAt, error: null });
        // 告知管理员「回滚之外还保住了什么」（0.3.61）：会话合并与豁免重放的结果，
        // 以及被覆盖数据的完整归档位置 —— 恢复不再等于静默丢弃。
        const kept = [];
        if (result.sessionsRestored && (result.sessionsRestored.added || result.sessionsRestored.updated)) {
          kept.push(`会话补回 ${result.sessionsRestored.added} 个、更新 ${result.sessionsRestored.updated} 个`);
        }
        if (result.exemptionsRestored?.length) kept.push(`版本豁免重放 ${result.exemptionsRestored.length} 项`);
        result = {
          ...result,
          restored: true,
          notice: '已按确认恢复到操作前的快照。'
            + (kept.length ? '回滚前的数据已另行保全：' + kept.join('；') + '。' : '')
            + (result.preRestoreArchive ? '被覆盖的完整数据已归档到 ' + result.preRestoreArchive + '，需要时可人工找回。' : '')
        };
      } catch (error) {
        await stopDsh();
        publish({ mode: 'safe', error: `恢复失败：${error.message}`, pendingRestore: target });
        throw error;
      }
    }
    else if (message.action === 'dismiss-restore') {
      if (!pendingRestore) throw new Error('当前没有待确认的恢复');
      const target = pendingRestore;
      // Keep the snapshot: declining a rollback must not also destroy the
      // only copy of the state the administrator just chose to leave behind.
      clearPendingRestore();
      publish({ mode: 'safe', error: `已放弃回滚。快照 ${target.snapshotId} 仍保留在“备份与恢复”中，可随时手动恢复。` });
      result = { dismissed: true, snapshotId: target.snapshotId };
    }
    eventLog('operation_succeeded', { action: message.action });
    if (gateway?.connected) gateway.send({ type: 'command-result', id: message.id, ok: true, result });
  } catch (error) {
    eventLog('operation_failed', { action: message.action, code: error.code || 'failed' });
    if (gateway?.connected) gateway.send({ type: 'command-result', id: message.id, ok: false, error: error.message });
  }
}

// 会话存档检查（0.3.61）。三种策略共用这一个入口：
//   · auto   启动后检查会话；核心运行/停止未确认时保守延期；
//   · timer  由 scheduleSessionCheck 按周期调用；
//   · manual 只在设置页点按钮时（force=true 允许无更新也复检）。
// 返回 { skipped, reason, ...status } 形式，便于日志与 UI 复用。
//
// ⚠ 0.3.73 修复（R25，集成测试实测根因）：原先的 pending 判据是
//   `!status.known || status.added || status.grown`
// 而 sessionArchiveStatus 在**没有账本时即使零会话**也返回 known:false ⇒
// 全新数据目录的第一次 ready 之后必然触发一次完整快照：发布 maintenance、
// **停掉刚起来的 core**、备份、再启动。可观测后果是「首次启动核心被无谓重启
// 一次」，测试侧表现为启动计数 3 而不是 2，且依赖"核心自行退出"的竞态用例
// 根本没跑到它要验证的路径（首次核心是被快照流程 SIGTERM 的）。
//
// 新判据区分三种"没有账本"的语义：
//   · baselineEmpty（扫描完整且 0 会话）→ 只初始化空基线账本，**不备份、不停核心**；
//   · 扫描不完整 → 不下结论，明确延期并在日志/事件里报告原因；
//   · 有会话但无账本 → 仅在允许快照时建立真实存档，延期不得推进账本。
async function checkSessionArchive({ force = false } = {}) {
  const status = ops.sessionArchiveStatus(dataDir);
  // 扫描不完整：宁可延期，也不要把没读到的会话误记成已存档。
  if (!status.complete) {
    log(`session archive deferred: 会话目录未能完整读取（${(status.scanErrors || []).length} 处错误）`);
    eventLog('session_archive_scan_incomplete', { errors: (status.scanErrors || []).slice(0, 5), count: status.count });
    if (!force) deferAutomaticBackup('session', 'scan-incomplete');
    return { ...status, snapshotId: null, skipped: 'scan-incomplete' };
  }
  // 空基线：只落一个"当前确实为空"的账本，完全不触碰核心。
  if (!status.known && status.baselineEmpty && !force) {
    ops.initEmptySessionArchive(dataDir);
    clearAutomaticBackupDeferred('session');
    log('session archive baseline initialized (0 sessions; core left running)');
    eventLog('session_archive_baseline', { count: 0 });
    return { ...ops.sessionArchiveStatus(dataDir), snapshotId: null, skipped: 'baseline-initialized' };
  }
  const pending = !status.known || status.added || status.grown;
  if (!pending) {
    clearAutomaticBackupDeferred('session');
    return { ...status, snapshotId: null, skipped: 'up-to-date' };
  }
  const created = await backup('manual', { automatic: !force, source: 'session' });
  const after = ops.sessionArchiveStatus(dataDir);
  return {
    ...after,
    before: { added: status.added, grown: status.grown, pendingBytes: status.pendingBytes },
    snapshotId: created?.id || null,
    skipped: created?.skipped || null,
    reason: created?.reason || null,
  };
}

// 定时检查（0.3.61）：周期来自 backupSettings.sessionInterval（分钟）。每次唤醒后
// 重读设置，因此改周期立即生效，无需重启应用。模式不是 timer 时不再续期。
function scheduleSessionCheck() {
  clearTimeout(sessionTimer);
  sessionTimer = null;
  const settings = (() => { try { return ops.backupSettings(dataDir); } catch { return null; } })();
  if (!settings || settings.sessionMode !== 'timer') return;
  const intervalMs = settings.sessionInterval * 60 * 1000;
  sessionTimer = setTimeout(() => {
    operation = operation.catch(() => {}).then(async () => {
      try {
        const result = await checkSessionArchive();
        if (result.skipped) log('session archive check: ' + result.skipped);
        else log('session archive snapshot created: +' + (result.before?.added || 0) + ' new, ~' + (result.before?.grown || 0) + ' grown');
      } catch (error) { log('session archive check failed: ' + error.message); }
      scheduleSessionCheck();
    });
  }, intervalMs);
}

// 自动模式（0.3.61）：在核心启动就绪后检查一次。放在启动后而不是启动前，是因为
// 启动前的快照会把「正在写入的会话」一并固化，且此时 core 尚未运行、数据更干净。
function maybeAutoArchiveSessions() {
  let settings;
  try { settings = ops.backupSettings(dataDir); } catch { return; }
  if (settings.sessionMode !== 'auto') return;
  operation = operation.catch(() => {}).then(async () => {
    try {
      const result = await checkSessionArchive();
      if (result.skipped) log('session archive (auto): ' + result.skipped);
      else log('session archive (auto) snapshot created: +' + (result.before?.added || 0) + ' new, ~' + (result.before?.grown || 0) + ' grown');
    } catch (error) { log('session archive (auto) failed: ' + error.message); }
  });
}
function scheduleDaily() {
  clearTimeout(dailyTimer);
  const next = new Date();
  next.setHours(3, 0, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  dailyTimer = setTimeout(() => {
    operation = operation.catch(() => {}).then(async () => {
      try { const result = await backup('daily'); log(result?.skipped ? `daily backup skipped: ${result.skipped}` : 'daily backup completed'); }
      catch (error) { log(`daily backup failed: ${error.message}`); }
      scheduleDaily();
    });
  }, next.getTime() - Date.now());
}

// Add the plugins this FPK ships to a profile that does not have them yet.
//
// Only runs against a profile that still looks untouched (nothing but core
// bundles), so an administrator who removed or replaced one keeps their
// choice across upgrades. When something was added, the core is restarted so
// the new bundles actually load -- a bundle only takes effect at boot.
async function seedBundledPlugins() {
  const profile = profiles.selected(dataDir);
  const entries = bundledPlugins.available(appDir);
  if (!entries.length) return;
  // The persisted seed record decides, not the profile's current shape: an
  // administrator who removed every plugin must not get them all reinstalled,
  // while a first pass that failed halfway must finish on this boot.
  const state = ops.readJson(ops.dataPath(dataDir, 'bundled-plugins-state.json'), { seeded: false });
  if (state.seeded) return;
  if (!bundledPlugins.isFreshProfile(dataDir, profile)) {
    // An older install that already carries user plugins has nothing to seed;
    // record that so this check does not run on every boot either.
    ops.writeJson(ops.dataPath(dataDir, 'bundled-plugins-state.json'), { seeded: true, results: { legacy: 'profile-already-customized' } });
    log('profile already carries user plugins; skipping bundled seed');
    return;
  }
  const logFile = ops.dataPath(dataDir, 'plugin-install.log');
  let summary;
  try {
    summary = await bundledPlugins.seed({ appDir, dataDir, profile, logFile });
  } catch (error) {
    if (configCoordination.isUnconfirmed(error)) {
      publish({ mode: 'safe', error: `内置插件安装结果未确认，已保留锁与证据：${error.message}` });
      throw error;
    }
    // A confirmed missing optional plugin need not prevent startup.
    log(`bundled plugin seed failed: ${error.message}`);
    return;
  }
  if (summary.installed?.length) {
    log(`bundled plugins installed: ${summary.installed.join(', ')}`);
    try {
      await stopDsh();
      await startDsh(activeDir);
      await probeWeb();
      // The core touches the patch layer while it boots (dshmarket appends its
      // rows), i.e. *after* the normalization that startDsh already ran. Run it
      // once more so a fresh install never leaves a file that only breaks on the
      // NEXT restart (that is exactly how the first-install bug hid).
      normalizeProfilePatch(profile);
      log('restarted so the bundled plugins load');
    } catch (error) {
      await stopDsh();
      publish({ mode: 'safe', error: `内置插件安装后 DSH 未能启动：${error.message}` });
      log(`restart after bundled seed failed: ${error.message}`);
      return;
    }
  }
  if (summary.failed?.length) log(`bundled plugins not installed: ${summary.failed.join('; ')}`);
  if (summary.installed?.length || summary.failed?.length) publish({ error: null });
}

// The `yaml` package ships inside the bundled runtime; loading it is best
  // effort — without it the patch editor still saves (syntax checks skipped).
  function patchYamlModule() {
    try { return require(path.join(appDir, 'runtime', 'node_modules', 'yaml')); }
    catch { return null; }
  }

// ── DSH_HOME 符号链接旁路（0.3.62）──────────────────────────────────────
// 症状：发**图片**报 `prompt rejected (session/agent-busy)`；发文字正常。
// 真因（已实测）：dsh-attachment-local 落盘时会沿目标路径**逐级 fsync 祖先目录**
// 直到文件系统根，其中一步是 `open(dir, O_RDONLY)`——它需要**读**权限：
//
//     stageImmutableObject → ensureDurableHome(<DSH_HOME>)
//       → ensureDurableDirectory(<DSH_HOME>, parse(home).root /* 恒为 "/" */)
//         → while (level !== '/') syncDirectory(dirname(level))
//           → open('/vol1', O_RDONLY) → EACCES
//
// fnOS 的卷根 `/vol1` 带私有 xattr `user.is_trimacl="1"`，它**压制 POSIX ACL**：
// 实测该目录 ACL 已给 `user:dsh_fnos:r-x`（mask::r-x），`access(X_OK)` 通过而
// `access(R_OK)` 仍 EACCES —— 连 root 的 setfacl 也改不动（已验证）。
//
// 关键：`ensureDurableHome` 用 `node:path` 的 `resolve`（纯字符串，**不解析符号
// 链接**），而 `ensureDurableDirectory` 按**路径比较**定边界。因此把 DSH_HOME
// 指向一个**位于 /vol1 之外**的符号链接，fsync 链就变成
//     /opt/dsh/home → /opt/dsh → /opt → /
// **不含 /vol1**，而真实数据仍落在 ZFS 池里（零迁移）。
//
// 实测验证：链接路径与真实路径下 DSH 的配置输出 md5 完全相同、core 完整启动、
// 附件端到端落盘 + sha256 校验通过。
//
// 若 /opt/dsh 不可用（未创建/不可写/链接目标异常），**静默回退**到真实路径——
// 宁可回到"发图失败"的已知坏状态，也不要让 core 起不来。
// spawnDsh 在 boot() 之外，无法看到 boot 的局部变量 —— 用模块级变量传递。
let dshHome = null;

function resolveDshHomePath() {
  const real = ops.dataPath(dataDir, 'dsh-home');
  const bridgeDir = '/opt/dsh';
  const bridge = path.join(bridgeDir, 'home');
  try {
    if (!fs.statSync(bridgeDir).isDirectory()) return real;
    fs.accessSync(bridgeDir, fs.constants.W_OK);
    const current = fs.lstatSync(bridge, { throwIfNoEntry: false });
    if (current === undefined) {
      fs.symlinkSync(real, bridge, 'dir');
    } else if (!current.isSymbolicLink()) {
      log(`DSH_HOME bridge is not a symlink: ${bridge} — falling back to ${real}`);
      return real;
    } else if (fs.readlinkSync(bridge) !== real) {
      fs.unlinkSync(bridge);
      fs.symlinkSync(real, bridge, 'dir');
    }
    // 链接目标必须真的可达，否则 core 会在启动阶段报 ENOENT。
    fs.accessSync(bridge, fs.constants.R_OK | fs.constants.X_OK);
    return bridge;
  } catch (error) {
    log(`DSH_HOME bridge unavailable: ${error.code || error.message} — falling back to ${real}`);
    return real;
  }
}

// Ancestor directories dsh fsyncs when storing an attachment, from the
// attachment root up to the filesystem root. A missing +x on any of them turns
// every upload into "EACCES: permission denied, open '/volN'" — a message that
// points at the volume root rather than at the permission that is actually wrong.
//
// ⚠ 0.3.62 更正：`open(dir, 'r')` 要的是**读**权限，而旧的自修逻辑加的是
// **穿越位 x**（`mode | 0o111`），两者不是一回事 —— 缺 r 时加 x 重试必然再失败。
// 实测 fnOS 的 `/vol1` 正是这种情形：ACL 已给 `user:dsh_fnos:r-x`、`access(X_OK)`
// 通过，但 `access(R_OK)` 仍 EACCES（卷根带私有 xattr `user.is_trimacl="1"`，
// 压制 POSIX ACL，连 root 的 setfacl 也改不动）。因此这里要分别给出可操作的结论。
function checkVolumeTraversal(home) {
  const chain = [];
  let level = home;
  const stop = path.parse(home).root;
  while (level !== stop) {
    level = path.dirname(level);
    chain.push(level);
    if (chain.length > 16) break;   // 防御：异常路径深度
  }
  for (const dir of chain) {
    try {
      const fd = fs.openSync(dir, 'r');
      fs.closeSync(fd);
      continue;
    } catch (error) {
      if (error.code !== 'EACCES') continue;
      // 区分两种 EACCES：缺穿越位（可用 chmod +x 修）还是缺读位（多半修不动）。
      let traversable = false;
      try { fs.accessSync(dir, fs.constants.X_OK); traversable = true; } catch { /* 穿越位也没有 */ }
      if (!traversable) {
        try {
          const mode = fs.statSync(dir).mode & 0o7777;
          fs.chmodSync(dir, mode | 0o111);
          const fd = fs.openSync(dir, 'r');
          fs.closeSync(fd);
          log(`volume traversal repaired: ${dir} (was 0${mode.toString(8)}, added +x and gained read)`);
          continue;
        } catch { /* not ours to fix */ }
        log(`volume traversal blocked: ${dir} lacks +x for this user — attachment uploads will fail with EACCES; fix with chmod o+x or setfacl`);
        continue;
      }
      // 穿越位有、读位没有：chmod 帮不上（可能是卷根的私有 ACL 层，如 fnOS 的
      // user.is_trimacl）。此时**唯一可行的修法**是把 DSH_HOME 旁路到卷根之外
      // （见 resolveDshHomePath），让 dsh 的祖先 fsync 链不再经过这里。
      // 卷根 = 该路径的父目录就是文件系统根；这类目录通常已被 fnOS 私有 ACL 锁定。
      const isVolumeRoot = path.dirname(dir) === path.parse(dir).root;
      if (isVolumeRoot) {
        log(`volume root not readable: ${dir} (traversable but no read) — dsh fsyncs every ancestor when storing an attachment, so uploads will fail with EACCES until DSH_HOME is bridged outside this volume (see /opt/dsh/home)`);
      } else {
        log(`volume ancestor not readable: ${dir} — attachment uploads will fail with EACCES; fix with setfacl -m u:<user>:rx ${dir}`);
      }
    }
  }
  checkAttachmentStore();
}

// ⚠ 0.3.58：patch 层 preflight 自愈。core 启动对 cordis.patch.yml 的硬性要求
// 只有一条不变式：YAML 解析结果必须是数组。历史上三种确定性病灶都能让 core
// 拒绝启动并跌进 safe mode：
//   A) 双文档：裸 [] 行后面还有条目（normalizeEmptyPatchArray，0.3.49 场景）；
//   B) 解析为 null：纯注释 / 空文件（0.3.49-0.3.57 的 "# []" PATCH_EMPTY 写出的
//      形态、或 dshmarket 清理后的中间态）；
//   C) 重复条目：同一 id 声明多次（插件包自带 bundle patch + 用户层誊写副本，
//      core 报 "duplicate loader entry id: X" → 0.3.57 的 preset-switch 事故）。
// A/B/C 都是确定性可修的：修复前先把原文件拷到 patch-backups/ 留底，再写入
// 修复文本。无法解析（真语法错误）不猜内容，留给管理页的一键重置。
// yamlModule 从 runtime 动态解析——supervisor 自身不打包 yaml 依赖。
function normalizeProfilePatch(profileName) {
  try {
    const profile = profiles.validateName(profileName || profiles.selected(dataDir));
    const file = path.join(profiles.directory(dataDir, profile), 'cordis.patch.yml');
    if (!fs.existsSync(file)) return;
    const original = fs.readFileSync(file, 'utf8');
    let text = original;
    const fixes = [];

    // 统一使用 runtime 的 yaml AST 接口：js-yaml 没有 parseDocument，
    // 会让 diagnosePatchLayer 一律 fail-closed ⇒ 自愈永远不触发。
    const yamlModule = patchYamlModule();

    // A) 双文档（裸 [] + 条目）
    const normalized = ops.normalizeEmptyPatchArray(text);
    if (normalized !== null) { text = normalized; fixes.push('双文档（裸 [] + 条目）归一化'); }

    // B) 解析级病灶（null / 非数组）
    const health = ops.diagnosePatchLayer(text, yamlModule);
    if (health.ok === false && health.fixable) {
      const repaired = ops.repairPatchLayerText(text);
      if (repaired !== null) { text = repaired; fixes.push(`补写空数组占位（${health.reason}）`); }
    }

    // C) 重复条目（仅在解析成功为数组后检测）
    const dup = ops.findDuplicatePatchIds(text, yamlModule);
    if (dup) {
      const deduped = ops.dedupePatchEntriesText(text, dup.duplicateIds);
      if (deduped !== null) { text = deduped; fixes.push(`移除重复条目：${dup.duplicateIds.join(', ')}`); }
    }

    if (text === original) return;
    // The shared transaction validates the result, attributes a unique backup
    // to this profile, then commits via an exclusive random sibling temp file.
    // A failed backup must never be logged-and-ignored before changing config.
    ops.writePatchConfig(dataDir, text, yamlModule, profile, { expectedRevision: configCoordination.revision(original) });
    log(`patch layer self-healed before core start: ${fixes.join('; ')}`);
    publish({ notice: `启动前已自动修复 cordis.patch.yml：${fixes.join('；')}` });
  } catch (error) {
    log(`patch layer normalization failed: ${error.message}`);
    if (configCoordination.isUnconfirmed(error)) throw error;
  }
}

// dsh stores uploads below DSH_HOME/attachments/v1 and creates this tree itself
// on first use (mode 0700). If the tree is missing, has lost its permissions, or
// sits on a read-only mount, every upload fails — and the surfaced error is the
// open() that failed, not the cause. Creating the tree ahead of time costs one
// mkdir and turns a confusing upload failure into a startup log line.
const ATTACHMENT_SUBDIRS = ['objects', 'tmp', 'files', 'file-objects', 'request-images'];
function checkAttachmentStore() {
  const root = ops.dataPath(dataDir, 'dsh-home', 'attachments', 'v1');
  try {
    // The version root's parent (attachments/) is created by dsh too; -p covers both.
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    log(`attachment store unavailable: cannot create ${root} (${error.code || error.message}) — uploads will fail`);
    return;
  }
  let repaired = [];
  for (const name of ['.', ...ATTACHMENT_SUBDIRS]) {
    const dir = name === '.' ? root : path.join(root, name);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Directories dsh creates are private (0700). Loosening is never right here,
      // but a tree that arrived world-writable (e.g. hand-created during a repair)
      // is tightened back so the store matches dsh's own invariant.
      const mode = fs.statSync(dir).mode & 0o7777;
      if (mode !== 0o700) { fs.chmodSync(dir, 0o700); repaired.push(`${dir}:0${mode.toString(8)}→0700`); }
    } catch (error) {
      log(`attachment store directory failed: ${dir} (${error.code || error.message})`);
      return;
    }
  }
  // A write probe is the only check that also covers read-only mounts and ACLs.
  const probe = path.join(root, 'tmp', `.probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, '', { mode: 0o600 });
    fs.rmSync(probe, { force: true });
  } catch (error) {
    log(`attachment store is not writable: ${probe} (${error.code || error.message}) — uploads will fail`);
    return;
  }
  if (repaired.length) log(`attachment store permissions repaired: ${repaired.join(', ')}`);
}

async function boot() {
  process.umask(0o077);
  // 自建 pidfile（0.3.70，P22 根治）。
  //
  // cmd/main 的 running() 只认 supervisor.pid。而 `restart-all` 走的是
  // process.execve（原地替换镜像），它在替换前会删掉 pidfile，**新镜像不会
  // 重建** —— 于是「完全重启」之后 pidfile 永久缺失，cmd/main 判定"没在运行"。
  // 后果（P22 实测）：应用中心若把状态记成「已停用」，点「启用」时平台端口
  // 预检撞上仍在正常服务的自家 gateway(3080) → 报"端口被占用" → start 脚本
  // 根本跑不到 → 状态永远停在「停用」，形成死锁。
  // 这里在 boot 起点无条件重建，使 pidfile 始终反映真实进程。
  try {
    const pidFile = ops.dataPath(dataDir, 'supervisor.pid');
    const tmp = `${pidFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${process.pid}\n`, { mode: 0o600 });
    fs.renameSync(tmp, pidFile);
  } catch { /* 尽力而为：pidfile 只是 cmd/main 的判据，写不了不该阻断启动 */ }
  // 端口设置损坏告警（0.3.73 / A16）：portSettings 现在容忍坏 JSON 并退回默认端口，
  // 但必须让管理员看见"你的端口自定义没生效"。放在这里是因为模块初始化阶段还没有
  // 任何日志/事件设施可用（旧实现正是在那里直接抛错退出，连 safe 页都进不去）。
  try {
    const portIssue = ops.portSettings(dataDir).corrupted;
    if (portIssue) {
      log(`port-settings.json is corrupted (${portIssue}) — falling back to default ports (core ${corePort}). 修复该文件或删除它以重新自定义端口。`);
      eventLog('port_settings_corrupted', { message: portIssue, corePort });
    }
  } catch { /* 告警本身不得影响启动 */ }
  // This error text is what the administrator sees in safe mode, so it names
  // the app-centre package to install rather than stating a bare requirement.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) throw new Error(`本机的 Node.js 运行时过旧（v${process.versions.node}），无法运行 DSH。请在 fnOS 应用中心安装或升级「Node.js v24」（nodejs_v24）后重启本应用。`);
  if (nodeMajor < 24) throw new Error(`本机的 Node.js 运行时版本过低（v${process.versions.node}，本应用按 v24 打包）。请在 fnOS 应用中心升级「Node.js v24」（nodejs_v24）后重启本应用。`);
  for (const name of [dataDir, ops.dataPath(dataDir, 'dsh-home'), ops.dataPath(dataDir, 'workspace')]) fs.mkdirSync(name, { recursive: true, mode: 0o700 });
  // DSH_HOME 可能被旁路到 /vol1 之外的符号链接（见 resolveDshHomePath）：
  // 真实目录必须先存在，链接才建得出来。结果存到模块级变量供 spawnDsh 使用。
  dshHome = resolveDshHomePath();
  // corepack / HOME 兜底目录（见 spawnDsh 的 env 注释）。
  for (const name of ['corepack-home', 'home']) fs.mkdirSync(ops.dataPath(dataDir, name), { recursive: true, mode: 0o700 });
  if (stopping || shuttingDown) return;
  // A decision deferred before a restart is still owed to the administrator,
  // so reload it from the persisted state. Without this the banner would
  // survive (the page reads state.json) but approving it would fail.
  const persisted = ops.readJson(stateFile, null);
  if (persisted?.pendingRestore?.snapshotId) {
    pendingRestore = persisted.pendingRestore;
    log(`restored pending rollback decision for ${pendingRestore.snapshotId}`);
  }
  publish({ mode: 'starting', error: null });
  startGateway();
  const portError = ops.portSettings(dataDir).corrupted;
  if (portError) { publish({ mode: 'safe', error: '端口配置损坏，已保留原文件；请修复配置后重试：' + portError }); return; }
  // dsh 保存附件时会对其所有祖先目录（一直到卷根）做 fsync，以保证断电后
  // 目录项不丢。若卷根丢了穿越位（曾出现 /vol1 变成 d--------- 的误操作），
  // 附件上传会在 open('/vol1') 处 EACCES —— 报错信息完全指不到真正原因
  // （用户以为选了未授权目录）。启动时检查并尝试自修，修不了就明确记录。
  checkVolumeTraversal(dshHome || ops.dataPath(dataDir, 'dsh-home'));
  publish(state);
  const bundled = ops.dshVersion(appDir);
  activeDir = cores.selectedCore(dataDir, appDir);
  const desiredVersion = ops.dshVersion(activeDir);
  publish({ activeVersion: desiredVersion });
  const lastGood = ops.dataPath(dataDir, 'last-good');
  const previousVersion = ops.dshVersion(lastGood);
  let preUpgrade = null;
  if (previousVersion && previousVersion !== desiredVersion) {
    // A user-initiated application/core upgrade still gets its safety snapshot,
    // but do not copy while an old orphan core may still own the data.
    await stopDsh();
    preUpgrade = ops.createSnapshot(dataDir, configDir, 'pre-upgrade', previousVersion);
    log(`pre-upgrade snapshot ${preUpgrade.id}`);
  } else if (!ops.listBackups(dataDir).length) {
    // No tracked child at boot is not proof that an old core is gone.
    // Do not take a first automatic snapshot before stop ownership is known.
    deferAutomaticBackup('daily', 'core-stop-unconfirmed');
  }
  try {
    await startDsh(activeDir);
    publish({ mode: 'ready', activeVersion: desiredVersion, error: null });
    try { ops.promoteRuntime(activeDir, dataDir); }
    catch (error) { log(`last-good runtime copy failed: ${error.message}`); publish({ error: `Rollback copy failed: ${error.message}` }); }
    // The profile now exists (the core creates it from the official web
    // template on first start), so the plugins this FPK ships can be added.
    // Doing it after that first start keeps the profile's bundles exactly what
    // the template says, instead of the smaller default set `dsh plugin add`
    // would initialise a missing profile with.
    await seedBundledPlugins();
  } catch (error) {
    log(`bundled dsh failed: ${error.message}`);
    await stopDsh();
    // Rolling the data back here used to be automatic, which meant a core
    // that failed for an unrelated reason (a slow boot, a port still held)
    // silently replaced the user's sessions and settings with an older copy.
    // Instead: fall back to the last-good core, which is the part that is
    // actually known to work, and ask before touching the data.
    if (preUpgrade && previousVersion) {
      try {
        activeDir = lastGood;
        await startDsh(lastGood);
        raisePendingRestore({
          snapshotId: preUpgrade.id,
          reason: `新核心 ${desiredVersion} 启动失败：${error.message}。已回到 ${previousVersion}，是否把数据也恢复到升级前？`,
          action: 'boot-rollback', version: previousVersion, mode: 'rollback'
        });
      } catch (rollbackError) {
        await stopDsh();
        raisePendingRestore({
          snapshotId: preUpgrade.id,
          reason: `新核心启动失败，回退 ${previousVersion} 也失败：${rollbackError.message}`,
          action: 'boot-rollback', version: previousVersion
        });
      }
    } else publish({ mode: 'safe', error: `dsh startup failed: ${error.message}` });
  }
  if (stopping || shuttingDown) return;
  startGateway();
  scheduleDaily();
  scheduleSessionCheck();
  checkUpdate().catch((error) => log(`update check failed: ${error.message}`));
  updateTimer = setInterval(() => checkUpdate().catch((error) => log(`update check failed: ${error.message}`)), 24 * 60 * 60 * 1000);
  // 自动模式：核心就绪后检查一次会话存档（默认策略，见 ops.defaultBackupSettings）。
  if (state.mode === 'ready') maybeAutoArchiveSessions();
  if (state.mode === 'safe' && state.error) {
    const reportPath = writeStartupReport(state.error);
    if (reportPath) { publish({ reportPath }); log(`startup report written: ${reportPath}`); }
  }
  log(`boot completed in ${state.mode} mode`);
}

// ── 进程级兜底（0.3.62）────────────────────────────────────────────────
// supervisor 是整套系统的守护者：它一退出，core 与 gateway 都失去托管，而
// **没有任何 per-app 守护会把它拉起来**（已确认 fnOS 只在系统启动时拉起应用，
// 运行期退出无人管）。因此这里必须比子进程更保守 —— 任何未捕获异常都记录并
// 继续服务，而不是让进程消失。
//
// gateway 早有同类兜底（它的崩溃曾表现为「网关慢性 exit(1)」）；supervisor
// 一直缺失，属最高危的健壮性缺口：一个渲染/IO 层的偶发异常就能让整套应用
// 静默停摆，且管理员在界面上得不到任何线索。
process.on('uncaughtException', (error) => {
  const detail = String((error && error.stack) || error);
  eventLog('supervisor_uncaught_exception', { message: detail.slice(0, 800) });
  log(`uncaught exception (continuing): ${detail.split('\n')[0]}`);
});
process.on('unhandledRejection', (reason) => {
  const detail = String((reason && reason.stack) || reason);
  eventLog('supervisor_unhandled_rejection', { message: detail.slice(0, 800) });
  log(`unhandled rejection (continuing): ${detail.split('\n')[0]}`);
});

process.on('SIGTERM', async () => {
  shuttingDown = true;
  stopping = true;
  clearTimeout(gatewayRestartTimer);
  clearTimeout(sessionTimer);
  clearInterval(sessionTimer);
  clearTimeout(dailyTimer);
  clearInterval(updateTimer);
  cores.cancelInstall();
  const cliClosed = await plugins.cancelCliOperations('supervisor shutdown');
  if (!cliClosed.ok) log('CLI close unconfirmed: ' + cliClosed.remaining.map(item => item.pid).join(', '));
  await Promise.race([operation.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 20_000))]);
  try { await stopDsh(); await stopGateway(); process.exit(cliClosed.ok ? 0 : 1); }
  catch (error) { log('shutdown incomplete: ' + error.message); process.exit(1); }
});

operation = boot().catch(async (error) => {
  await stopDsh();
  publish({ mode: 'safe', error: error.message });
  if (!gateway) startGateway();
  log(`boot failed into safe mode: ${error.message}`);
});