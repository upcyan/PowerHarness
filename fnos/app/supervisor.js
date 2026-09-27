const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, fork } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const ops = require('./ops.js');
const cores = require('./core-manager.js');
const profiles = require('./profiles.js');
const plugins = require('./plugins.js');
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
const stateFile = ops.dataPath(dataDir, 'state.json');
const logFile = ops.dataPath(dataDir, 'dsh.log');
const gatewayLog = ops.dataPath(dataDir, 'gateway.log');
const eventLog = diagnostics.logger(dataDir, 'supervisor');
let state = { mode: 'starting', bundledVersion: ops.dshVersion(appDir), activeVersion: null, error: null, updatedAt: new Date().toISOString() };
let dsh = null;
let gateway = null;
let activeDir = appDir;
let stopping = false;
let expectedDshStop = false;
let cleanExitRestarts = 0;
let cleanExitTimer = null;
let cleanExitGeneration = 0;
const cleanExitRestartLimit = 3;
const cleanExitRestartDelay = 5_000;
const cleanExitResetAfter = 10 * 60_000;
let operation = Promise.resolve();
let dailyTimer;
let updateTimer;

function publish(patch) {
  const previousMode = state.mode;
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
  ops.writeJson(stateFile, state);
  if (state.mode !== previousMode || Object.hasOwn(patch, 'activeVersion')) eventLog('state_changed', { mode: state.mode, version: state.activeVersion || null });
}

function log(message) { console.log(`[supervisor] ${message}`); }
function exited(child) { return child.exitCode !== null || child.signalCode !== null; }
function readyMode() { return activeDir === ops.dataPath(dataDir, 'last-good') ? 'rollback' : 'ready'; }
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
async function probeWeb() {
  const launch = ops.readJson(ops.dataPath(dataDir, 'launch.json'));
  if (!launch?.path) throw new Error('Missing dsh launch URL');
  const first = await requestLocal(launch.path);
  if (![200, 302, 303].includes(first.status)) throw new Error(`dsh login check returned ${first.status}`);
  const cookie = (first.headers['set-cookie'] || []).map((item) => item.split(';')[0]).join('; ');
  const page = await requestLocal('/', cookie);
  if (page.status !== 200 || !/<html[\s>]/i.test(page.body)) throw new Error(`dsh Web UI check returned ${page.status}`);
}
function updateSettings() {
  const value = ops.readJson(ops.dataPath(dataDir, 'update-settings.json'), {});
  return { registry: cores.registryUrl(value.registry), autoUpdate: value.autoUpdate === true };
}

function spawnDsh(directory, profileName = profiles.selected(dataDir), createProfile = false) {
  return new Promise((resolve, reject) => {
    let adapter;
    try { adapter = cores.adapterFor(directory, corePort); }
    catch (error) { reject(error); return; }
    const bin = adapter.bin;
    if (!fs.existsSync(bin)) { reject(new Error('dsh runtime is missing')); return; }
    try { profiles.validateName(profileName); } catch (error) { reject(error); return; }
    if (profileName !== 'web' && adapter.args[0] !== 'web') { reject(new Error('Selected dsh core does not support Web profile switching')); return; }
    fs.rmSync(ops.dataPath(dataDir, 'launch.json'), { force: true });
    diagnostics.startDshLog(dataDir);
    const output = (chunk) => diagnostics.appendDsh(dataDir, chunk);
    let settled = false;
    let startupComplete = false;
    let readinessPending = false;
    let pending = '';
    let launchUrl = null;
    let startupStderr = '';
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
    const dshEnv = { ...process.env };
    delete dshEnv.DOCKER_HOST;
    delete dshEnv.DOCKER_CONTEXT;
    const child = spawn(process.execPath, ['--require', path.join(__dirname, 'workspace-home.cjs'), bin, ...args], {
      cwd: workspace,
      env: { ...dshEnv, ...dockerAccess.dshEnvironment(dataDir), DSH_HOME: ops.dataPath(dataDir, 'dsh-home'), FNOS_WORKSPACE_HOME: workspace,
        PATH: `${localBins}${path.delimiter}${process.env.PATH || ''}`,
        PNPM_HOME: ops.dataPath(dataDir, 'pnpm-home'), npm_config_store_dir: ops.dataPath(dataDir, 'pnpm-store'),
        npm_config_cache: ops.dataPath(dataDir, 'npm-cache'), NO_COLOR: '1', NPM_CONFIG_REGISTRY: registry, npm_config_registry: registry },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    dsh = child;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      fail(new Error('dsh startup timed out after 90 seconds'));
    }, 90_000);
    child.stdout.on('data', (chunk) => {
      output(chunk);
      pending += chunk.toString();
      if (pending.includes('\n')) {
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        const readyLine = lines.find((line) => line.startsWith(adapter.readyPrefix));
        if (!settled && !readinessPending && readyLine) {
          launchUrl = readyLine.slice(adapter.readyPrefix.length).trim().split(/\s+/)[0];
          readinessPending = true;
          setTimeout(() => {
            if (exited(child)) fail(new Error(`dsh exited after readiness: ${child.exitCode ?? child.signalCode}`));
            else {
              try {
                const url = new URL(launchUrl);
                if (url.hostname !== '127.0.0.1' || url.port !== String(corePort)) throw new Error('Unexpected dsh URL');
                ops.writeJson(ops.dataPath(dataDir, 'launch.json'), { path: `${url.pathname}${url.search}${url.hash}` });
              } catch (error) { fail(error); return; }
              settled = true; startupComplete = true; clearTimeout(timeout); resolve(child);
            }
          }, 2000);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
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
        fail(new Error(diagnosis ? `dsh 启动失败：${diagnosis}` : fallback));
      }
      else if (startupComplete && !expectedDshStop && !stopping) handleUnexpectedExit(code, signal);
    });
  });
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

function staleCorePids() { return portOwner.ownedListeners(corePort, dataDir); }

async function releaseOwnedCorePort() {
  const pids = staleCorePids();
  if (!pids.length) return;
  log(`terminating remaining dsh listener(s): ${pids.join(', ')}`);
  for (const pid of pids) if (staleCorePids().includes(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  for (let i = 0; i < 20; i++) {
    if (!pids.some((pid) => staleCorePids().includes(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const pid of pids) if (staleCorePids().includes(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
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
  await reclaimCorePort();
  return spawnDsh(directory, profileName, createProfile);
}

function cancelSelfRestart() {
  cleanExitGeneration += 1;
  clearTimeout(cleanExitTimer);
  cleanExitTimer = null;
  cleanExitRestarts = 0;
}

async function stopDsh() {
  cancelSelfRestart();
  if (!dsh) { await releaseOwnedCorePort(); return; }
  if (exited(dsh)) { dsh = null; await releaseOwnedCorePort(); return; }
  expectedDshStop = true;
  const child = dsh;
  const exitPromise = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (!exited(child)) { child.kill('SIGKILL'); await exitPromise; }
  dsh = null;
  await releaseOwnedCorePort();
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
    publish({ mode: 'maintenance', error: `dsh 正在自动重启（第 ${cleanExitRestarts}/${cleanExitRestartLimit} 次）…` });
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

function startGateway() {
  fs.writeFileSync(gatewayLog, '', { mode: 0o600 });
  const fd = fs.openSync(gatewayLog, 'a', 0o600);
  gateway = fork(path.join(appDir, 'gateway.js'), [], {
    env: { ...process.env, FNOS_DATA_DIR: dataDir, GUIDE_SOCKET: guideSocket, DSH_PORT: String(corePort), NODE_PATH: path.join(appDir, 'runtime', 'node_modules') },
    stdio: ['ignore', fd, fd, 'ipc']
  });
  fs.closeSync(fd);
  gateway.on('message', (message) => {
    if (message?.type === 'public-port-result') {
      const reply = portReplies.get(message.id);
      if (reply) { portReplies.delete(message.id); reply(message.ok ? null : new Error(message.error || '端口切换失败')); }
      return;
    }
    if (message?.type !== 'command' || !['backup', 'restore', 'retry', 'safe-mode', 'check-update', 'install-core', 'switch-core', 'set-registry', 'set-backup-settings', 'set-docker-mode', 'set-core-port', 'set-public-port', 'create-profile', 'switch-profile', 'install-plugin', 'disable-plugin', 'enable-plugin', 'uninstall-plugin', 'use-bundled'].includes(message.action)) return;
    operation = operation.catch(() => {}).then(() => runCommand(message));
  });
  gateway.on('exit', (code) => {
    if (!stopping) { log(`gateway exited (${code}); supervisor will restart it`); setTimeout(startGateway, 1000); }
  });
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

async function backup(kind) {
  const settings = ops.backupSettings(dataDir);
  if (kind === 'daily' && settings.dailyMode === 'updates') return { skipped: 'updates-only' };
  if (state.mode === 'safe') {
    if (kind === 'daily' && settings.dailyMode === 'changed' && ops.listBackups(dataDir).find((item) => item.kind === 'daily')?.fingerprint === ops.snapshotFingerprint(dataDir, configDir)) return { skipped: 'unchanged' };
    const snapshot = ops.createSnapshot(dataDir, configDir, kind, state.activeVersion);
    publish({ lastBackup: snapshot.createdAt });
    return snapshot;
  }
  publish({ mode: 'maintenance', error: null });
  await stopDsh();
  let snapshot;
  try {
    const lastDaily = kind === 'daily' ? ops.listBackups(dataDir).find((item) => item.kind === 'daily') : null;
    if (kind === 'daily' && settings.dailyMode === 'changed' && lastDaily?.fingerprint === ops.snapshotFingerprint(dataDir, configDir)) snapshot = { skipped: 'unchanged' };
    else snapshot = ops.createSnapshot(dataDir, configDir, kind, state.activeVersion);
  }
  finally {
    try {
      await startDsh(activeDir);
      publish({ mode: readyMode(), lastBackup: snapshot?.createdAt ?? state.lastBackup });
    } catch (error) { await stopDsh(); publish({ mode: 'safe', error: `Restart after backup failed: ${error.message}` }); }
  }
  return snapshot;
}

async function switchProfile(name, create = false) {
  const selected = create ? profiles.create(dataDir, name) : profiles.validateName(name);
  if (!create && !profiles.list(dataDir).includes(selected)) throw new Error('dsh profile does not exist');
  const previous = profiles.selected(dataDir);
  if (!create && previous === selected) return { name: selected };
  publish({ mode: 'maintenance', error: null });
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
  const packageInfo = await plugins.inspect(spec, registry);
  publish({ mode: 'maintenance', error: null });
  await stopDsh();
  const snapshot = ops.createSnapshot(dataDir, configDir, 'pre-upgrade', state.activeVersion);
  try {
    const result = await plugins.install(dataDir, profile, `${packageInfo.name}@${packageInfo.version}`, registry, packageInfo);
    await startDsh(activeDir);
    await probeWeb();
    publish({ mode: readyMode(), lastBackup: snapshot.createdAt, error: null });
    return result;
  } catch (error) {
    await stopDsh();
    try { ops.restoreSnapshot(dataDir, configDir, snapshot.id); }
    catch (restoreError) {
      const failure = new Error(`插件安装失败：${error.message}；数据回滚失败：${restoreError.message}`);
      publish({ mode: 'safe', error: failure.message });
      throw failure;
    }
    try { await startDsh(activeDir); publish({ mode: readyMode(), error: `Plugin installation failed: ${error.message}` }); }
    catch (rollbackError) { await stopDsh(); publish({ mode: 'safe', error: `Plugin rollback failed: ${rollbackError.message}` }); }
    throw error;
  }
}

async function managePlugin(action, spec) {
  const wasSafe = state.mode === 'safe';
  const profile = profiles.selected(dataDir);
  const { name, requestedVersion } = plugins.parseSpec(spec);
  if (requestedVersion || !plugins.list(dataDir, profile).some((item) => item.name === name)) throw new Error('Plugin is not installed in this profile');
  publish({ mode: 'maintenance', error: null });
  await stopDsh();
  const snapshot = ops.createSnapshot(dataDir, configDir, 'pre-upgrade', state.activeVersion);
  let result;
  try {
    result = action === 'uninstall-plugin'
      ? await plugins.uninstall(dataDir, profile, name, updateSettings().registry)
      : plugins.setEnabled(dataDir, profile, name, action === 'enable-plugin');
    try {
      await startDsh(activeDir);
      await probeWeb();
    } catch (startupError) {
      if (!wasSafe || action === 'enable-plugin') throw startupError;
      await stopDsh();
      const warning = `插件已${action === 'uninstall-plugin' ? '卸载' : '禁用'}，DSH 仍未启动：${startupError.message}`;
      publish({ mode: 'safe', lastBackup: snapshot.createdAt, error: warning });
      return { ...result, warning };
    }
    publish({ mode: readyMode(), lastBackup: snapshot.createdAt, error: null });
    return result;
  } catch (error) {
    await stopDsh();
    try { ops.restoreSnapshot(dataDir, configDir, snapshot.id); }
    catch (restoreError) {
      const failure = new Error(`插件操作失败：${error.message}；数据回滚失败：${restoreError.message}`);
      publish({ mode: 'safe', error: failure.message });
      throw failure;
    }
    try {
      await startDsh(activeDir);
      await probeWeb();
      publish({ mode: readyMode(), error: `Plugin management failed: ${error.message}` });
    } catch (rollbackError) {
      await stopDsh();
      publish({ mode: 'safe', error: `Plugin management failed: ${error.message}; previous configuration still cannot start: ${rollbackError.message}` });
    }
    throw error;
  }
}

async function installCore(version) {
  const selectedVersion = String(version || '');
  const settings = updateSettings();
  const directory = await cores.installCore(dataDir, appDir, selectedVersion, settings.registry);
  const previousDir = activeDir;
  publish({ mode: 'maintenance', error: null });
  await stopDsh();
  let snapshot;
  try {
    snapshot = ops.createSnapshot(dataDir, configDir, 'pre-upgrade', state.activeVersion);
    await startDsh(directory);
    await probeWeb();
    cores.selectCore(dataDir, selectedVersion);
    activeDir = directory;
    publish({ mode: 'ready', activeVersion: selectedVersion, lastBackup: snapshot.createdAt, error: null });
    try { ops.promoteRuntime(directory, dataDir); }
    catch (error) { log(`last-good runtime copy failed: ${error.message}`); publish({ error: `Rollback copy failed: ${error.message}` }); }
    return { version: selectedVersion };
  } catch (error) {
    await stopDsh();
    try { if (snapshot) ops.restoreSnapshot(dataDir, configDir, snapshot.id); }
    catch (restoreError) { publish({ mode: 'safe', error: `Core update failed; data restore failed: ${restoreError.message}` }); throw restoreError; }
    activeDir = previousDir;
    if (stopping) throw error;
    try {
      await startDsh(previousDir);
      publish({ mode: readyMode(), error: `dsh ${selectedVersion} failed and previous core was restored: ${error.message}` });
    } catch (rollbackError) {
      await stopDsh();
      publish({ mode: 'safe', error: `Core update and rollback failed: ${rollbackError.message}` });
    }
    throw error;
  }
}

async function runCommand(message) {
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
    else if (message.action === 'set-backup-settings') result = ops.saveBackupSettings(dataDir, {
      daily: message.dailyLimit, manual: message.manualLimit,
      'pre-upgrade': message.upgradeLimit, dailyMode: message.dailyMode
    });
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
          publish({ mode: 'maintenance', error: null });
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
        if (shouldRestart) publish({ mode: 'maintenance', error: null });
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
      publish({ mode: 'maintenance', error: null });
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
      publish({ mode: 'maintenance', error: null });
      try {
        result = ops.restoreSnapshot(dataDir, configDir, backupId);
        await startDsh(activeDir);
        await probeWeb();
        publish({ mode: readyMode(), error: null });
      } catch (error) {
        await stopDsh();
        publish({ mode: 'safe', error: `Backup restore failed: ${error.message}` });
        throw error;
      }
    }
    eventLog('operation_succeeded', { action: message.action });
    if (gateway?.connected) gateway.send({ type: 'command-result', id: message.id, ok: true, result });
  } catch (error) {
    eventLog('operation_failed', { action: message.action, code: error.code || 'failed' });
    if (gateway?.connected) gateway.send({ type: 'command-result', id: message.id, ok: false, error: error.message });
  }
}

function scheduleDaily() {
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

async function boot() {
  process.umask(0o077);
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('fnOS App Center Node.js 24 is required');
  for (const name of [dataDir, ops.dataPath(dataDir, 'dsh-home'), ops.dataPath(dataDir, 'workspace')]) fs.mkdirSync(name, { recursive: true, mode: 0o700 });
  publish(state);
  const bundled = ops.dshVersion(appDir);
  activeDir = cores.selectedCore(dataDir, appDir);
  const desiredVersion = ops.dshVersion(activeDir);
  publish({ activeVersion: desiredVersion });
  const lastGood = ops.dataPath(dataDir, 'last-good');
  const previousVersion = ops.dshVersion(lastGood);
  let preUpgrade = null;
  if (previousVersion && previousVersion !== desiredVersion) {
    preUpgrade = ops.createSnapshot(dataDir, configDir, 'pre-upgrade', previousVersion);
    log(`pre-upgrade snapshot ${preUpgrade.id}`);
  } else if (!ops.listBackups(dataDir).length) {
    ops.createSnapshot(dataDir, configDir, 'daily', bundled);
  }
  try {
    await startDsh(activeDir);
    publish({ mode: 'ready', activeVersion: desiredVersion, error: null });
    try { ops.promoteRuntime(activeDir, dataDir); }
    catch (error) { log(`last-good runtime copy failed: ${error.message}`); publish({ error: `Rollback copy failed: ${error.message}` }); }
  } catch (error) {
    log(`bundled dsh failed: ${error.message}`);
    await stopDsh();
    if (preUpgrade && previousVersion) {
      try {
        ops.restoreSnapshot(dataDir, configDir, preUpgrade.id);
        activeDir = lastGood;
        await startDsh(lastGood);
        publish({ mode: 'rollback', activeVersion: previousVersion, error: `Bundled dsh failed; restored ${previousVersion}: ${error.message}` });
      } catch (rollbackError) {
        await stopDsh();
        publish({ mode: 'safe', error: `Startup and rollback failed: ${rollbackError.message}` });
      }
    } else publish({ mode: 'safe', error: `dsh startup failed: ${error.message}` });
  }
  startGateway();
  scheduleDaily();
  checkUpdate().catch((error) => log(`update check failed: ${error.message}`));
  updateTimer = setInterval(() => checkUpdate().catch((error) => log(`update check failed: ${error.message}`)), 24 * 60 * 60 * 1000);
  log(`boot completed in ${state.mode} mode`);
}

process.on('SIGTERM', async () => {
  stopping = true;
  clearTimeout(dailyTimer);
  clearInterval(updateTimer);
  cores.cancelInstall();
  await Promise.race([operation.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 20_000))]);
  await stopDsh();
  gateway?.kill('SIGTERM');
  process.exit(0);
});

boot().catch(async (error) => {
  await stopDsh();
  publish({ mode: 'safe', error: error.message });
  if (!gateway) startGateway();
  log(`boot failed into safe mode: ${error.message}`);
});
