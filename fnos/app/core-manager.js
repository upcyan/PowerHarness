const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const ops = require('./ops.js');

const packageName = '@deepseek-ai/dsh';
const defaultRegistry = 'https://registry.npmjs.org/';
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const defaultBin = 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js';
const defaultArgs = ['web', '--no-open', '--host', '{{host}}', '--port', '{{port}}'];
let activeCommand = null;

function registryUrl(value) {
  const url = new URL(value || defaultRegistry);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('npm source must be an HTTPS URL without credentials');
  url.pathname = `${url.pathname.replace(/\/*$/, '')}/`;
  return url.href;
}

function corePath(dataDir, version) {
  if (!versionPattern.test(version)) throw new Error('Invalid dsh version');
  return ops.dataPath(dataDir, 'cores', version);
}

function installedVersion(directory) {
  return ops.dshVersion(directory);
}

function adapterError(code, message, directory, version, adapter) {
  const declared = typeof adapter?.version === 'string' && versionPattern.test(adapter.version) ? adapter.version : 'invalid';
  const error = new Error(`Unsupported core adapter: [${code}] ${message}（runtime=${version || 'missing'}, adapter=${declared}；文件=${path.join(directory, 'adapter.json')}）`);
  error.code = code;
  error.details = { runtimeVersion: version || null, adapterVersion: declared, adapterFile: path.join(directory, 'adapter.json') };
  return error;
}
function adapterFor(directory, corePort = 3081) {
  const version = installedVersion(directory);
  if (!version || !versionPattern.test(version)) throw adapterError('CORE_RUNTIME_INVALID', '核心运行时缺失或版本无法识别', directory, null);
  let adapter;
  try { adapter = JSON.parse(fs.readFileSync(path.join(directory, 'adapter.json'), 'utf8')); }
  catch (error) {
    const code = error.code === 'ENOENT' ? 'ADAPTER_MISSING' : error instanceof SyntaxError ? 'ADAPTER_JSON_INVALID' : 'ADAPTER_UNREADABLE';
    throw adapterError(code, '适配声明缺失、损坏或无法读取，请保留现场并核对配套部署', directory, version);
  }
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) throw adapterError('ADAPTER_SHAPE_INVALID', '适配声明必须为对象', directory, version, adapter);
  if (adapter.contract !== 1) throw adapterError('ADAPTER_CONTRACT_UNSUPPORTED', '不支持当前适配契约，只支持contract=1', directory, version, adapter);
  if (adapter.version !== version) throw adapterError('ADAPTER_VERSION_MISMATCH', '核心与适配声明版本不一致，启动已阻止；不要仅改版本号强行对齐', directory, version, adapter);
  if (typeof adapter.readyPrefix !== 'string' || !adapter.readyPrefix || adapter.readyPrefix.length > 100) throw adapterError('ADAPTER_READY_PREFIX_INVALID', '就绪标记无效', directory, version, adapter);
  const relativeBin = adapter.bin || defaultBin;
  if (typeof relativeBin !== 'string' || relativeBin.length > 1024) throw adapterError('ADAPTER_BIN_INVALID', '核心入口必须为受限相对路径', directory, version, adapter);
  const bin = path.resolve(directory, relativeBin), base = path.resolve(directory);
  if (bin === base || !bin.startsWith(base + path.sep) || !relativeBin.replaceAll('\\', '/').startsWith('runtime/')) throw adapterError('ADAPTER_BIN_INVALID', '核心入口越出runtime目录', directory, version, adapter);
  const args = adapter.args || defaultArgs;
  if (!Array.isArray(args) || args.length > 20 || args.some(item => typeof item !== 'string' || item.length > 200)) throw adapterError('ADAPTER_ARGS_INVALID', '核心启动参数形状无效', directory, version, adapter);
  return { version, bin, args: args.map(item => item.replaceAll('{{host}}', '127.0.0.1').replaceAll('{{port}}', String(corePort))), readyPrefix: adapter.readyPrefix };
}

function validCore(directory, version) {
  if (!fs.existsSync(path.join(directory, 'adapter.json'))) return false;
  try { return adapterFor(directory).version === version; } catch { return false; }
}

function selectedCore(dataDir, appDir) {
  const selected = ops.readJson(ops.dataPath(dataDir, 'core-selection.json'), null);
  if (!selected) return appDir;
  if (!versionPattern.test(selected.version)) throw new Error('Invalid selected core version');
  const directory = corePath(dataDir, selected.version);
  const adapter = adapterFor(directory);
  if (adapter.version !== selected.version) throw adapterError('CORE_SELECTION_VERSION_MISMATCH', '核心选择记录与实际安装版本不一致', directory, adapter.version);
  return directory;
}

function selectCore(dataDir, version) {
  const directory = corePath(dataDir, version);
  if (!validCore(directory, version)) throw new Error('Core is not installed or incompatible');
  ops.writeJson(ops.dataPath(dataDir, 'core-selection.json'), { version });
  return directory;
}
function clearSelection(dataDir) { fs.rmSync(ops.dataPath(dataDir, 'core-selection.json'), { force: true }); }

function listCores(dataDir) {
  const root = ops.dataPath(dataDir, 'cores');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && versionPattern.test(entry.name) && validCore(path.join(root, entry.name), entry.name))
    .map((entry) => entry.name).sort();
}

async function run(command, args, options) {
  const controller = new AbortController();
  activeCommand = controller;
  try {
    return await require('./plugins').runCli(command, args, { ...options, signal: controller.signal,
      failureMessage: code => `${path.basename(command)} failed (${code}); see core-install.log` });
  } finally { if (activeCommand === controller) activeCommand = null; }
}

function cancelInstall() { activeCommand?.abort(); }

async function installCore(dataDir, appDir, version, registry) {
  if (!versionPattern.test(version)) throw new Error('Invalid dsh version');
  const source = registryUrl(registry);
  const target = corePath(dataDir, version);
  if (fs.existsSync(target)) {
    if (!validCore(target, version)) throw new Error('Existing core directory is invalid');
    return target;
  }
  const cores = ops.dataPath(dataDir, 'cores');
  fs.mkdirSync(cores, { recursive: true, mode: 0o700 });
  const stage = ops.dataPath(dataDir, 'cores', `.pending-${version}-${randomBytes(6).toString('hex')}`);
  const runtime = path.join(stage, 'runtime');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const logFile = ops.dataPath(dataDir, 'core-install.log');
  const npm = process.env.FNOS_NPM_BIN || path.join(path.dirname(process.execPath), 'npm');
  try {
    fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name: 'fnos-dsh-core', private: true, version: '1.0.0', dependencies: { [packageName]: version } }, null, 2));
    await run(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--save-exact', '--registry', source], {
      cwd: runtime,
      env: { ...process.env, npm_config_cache: ops.dataPath(dataDir, 'npm-cache'), npm_config_registry: source },
      logFile
    });
    if (installedVersion(stage) !== version) throw new Error('Installed dsh version does not match request');
    for (const file of [
      path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
    ]) if (!fs.existsSync(file)) throw new Error(`Core is incomplete: ${path.basename(file)}`);
    await run(process.execPath, [path.join(appDir, 'patch-dsh.mjs'), runtime], { cwd: runtime, env: process.env, logFile });
    await run(process.execPath, ['-e', "const {createRequire}=require('node:module');const path=require('node:path');createRequire(path.resolve('node_modules/@deepseek-ai/dsh/package.json'))('node-pty')"], { cwd: runtime, env: process.env, logFile });
    fs.writeFileSync(path.join(stage, 'adapter.json'), JSON.stringify({ contract: 1, version, bin: defaultBin, args: defaultArgs, readyPrefix: 'dsh web:' }, null, 2), { mode: 0o600 });
    fs.renameSync(stage, target);
    return target;
  } catch (error) {
    // A rejected lifecycle promise may still own a live child/pipes. Never race
    // recursive cleanup against that installer; keep its evidence and directory.
    if (error.code === 'ERR_CLI_UNCONFIRMED' || error.closed === false) {
      error.stagePreserved = stage;
      throw error;
    }
    const checked = path.resolve(stage);
    if (path.dirname(checked) !== path.resolve(cores) || !path.basename(checked).startsWith(`.pending-${version}-`)) throw new Error('Refuse unsafe installation cleanup', { cause: error });
    fs.rmSync(checked, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { defaultRegistry, registryUrl, corePath, adapterFor, selectedCore, selectCore, clearSelection, listCores, installCore, cancelInstall };
