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

function adapterFor(directory, corePort = 3081) {
  const version = installedVersion(directory);
  const adapter = ops.readJson(path.join(directory, 'adapter.json'), { contract: 1, version, readyPrefix: 'dsh web:' });
  if (adapter.contract !== 1 || adapter.version !== version || typeof adapter.readyPrefix !== 'string' || !adapter.readyPrefix || adapter.readyPrefix.length > 100) throw new Error('Unsupported core adapter');
  const relativeBin = adapter.bin || defaultBin;
  const bin = path.resolve(directory, relativeBin);
  const base = path.resolve(directory);
  if (bin === base || !bin.startsWith(base + path.sep) || !relativeBin.replaceAll('\\', '/').startsWith('runtime/')) throw new Error('Invalid core executable path');
  const args = adapter.args || defaultArgs;
  if (!Array.isArray(args) || args.length > 20 || args.some((item) => typeof item !== 'string' || item.length > 200)) throw new Error('Invalid core arguments');
  return { version, bin, args: args.map((item) => item.replaceAll('{{host}}', '127.0.0.1').replaceAll('{{port}}', String(corePort))), readyPrefix: adapter.readyPrefix };
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
  if (!validCore(directory, selected.version)) throw new Error(`Selected dsh core ${selected.version} is missing or incompatible`);
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
  return new Promise((resolve, reject) => {
    const output = fs.openSync(options.logFile, 'a', 0o600);
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', output, output] });
    activeCommand = child;
    fs.closeSync(output);
    const timeout = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000);
    const finish = () => { clearTimeout(timeout); if (activeCommand === child) activeCommand = null; };
    child.once('error', (error) => { finish(); reject(error); });
    child.once('exit', (code, signal) => {
      finish();
      code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed (${code ?? signal}); see core-install.log`));
    });
  });
}

function cancelInstall() { if (activeCommand) activeCommand.kill('SIGTERM'); }

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
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { defaultRegistry, registryUrl, corePath, adapterFor, selectedCore, selectCore, clearSelection, listCores, installCore, cancelInstall };
