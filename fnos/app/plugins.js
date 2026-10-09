const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const cliProcessGroup = require('./cli-process-group.js');
const cliContainment = require('./cli-containment.js');
const ops = require('./ops.js');
const configCoordination = require('./config-coordination.js');

// Single source of truth for an empty patch layer (see ops.PATCH_EMPTY comment).
const EMPTY_PATCH_TEXT = ops.PATCH_EMPTY;
const cores = require('./core-manager.js');
const profiles = require('./profiles.js');
const gitEnv = require('./git-transport.js');

const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)?$/;
function parseSpec(value) {
  const spec = String(value || '').trim();
  if (!packagePattern.test(spec) || spec.length > 160) throw new Error('Only exact npm package names and versions are supported');
  const at = spec.lastIndexOf('@');
  return at > 0 ? { name: spec.slice(0, at), requestedVersion: spec.slice(at + 1) } : { name: spec, requestedVersion: null };
}
// GitHub sources arrive as `user/repo`, `github:user/repo`, `github:user/repo#ref`
// or a github.com URL. Everything else is treated as a registry spec and goes
// through the existing strict package-name validation.
const GITHUB_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#([A-Za-z0-9._/-]+))?$/;
function normalizePluginSpec(input) {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 300) throw new Error('插件来源为空或过长');
  let candidate = raw;
  const url = /^https?:\/\/github\.com\/(.+?)(\.git)?$/i.exec(candidate);
  if (url) candidate = `github:${url[1]}`;
  if (/^github:/i.test(candidate)) {
    const rest = candidate.slice('github:'.length);
    const match = GITHUB_REPO.exec(rest);
    if (!match) throw new Error('GitHub 来源格式应为 user/repo 或 user/repo#tag');
    const ref = match[3] ? `#${match[3]}` : '';
    return { kind: 'git', spec: `github:${match[1]}/${match[2]}${ref}` };
  }
  if (!raw.startsWith('@') && !raw.includes('@') && GITHUB_REPO.test(raw)) {
    return { kind: 'git', spec: `github:${raw}` };
  }
  parseSpec(raw);
  return { kind: 'registry', spec: raw };
}

function bundlePatch(manifest) {
  const patch = manifest?.dsh?.bundle?.patch;
  if (typeof patch !== 'string' || !/^\.\/[a-zA-Z0-9._/-]+\.ya?ml$/.test(patch) || patch.split('/').includes('..')) throw new Error('Package does not declare a safe dsh bundle patch');
  return patch;
}
function profilePackage(dataDir, profile, spec) {
  const { name, requestedVersion } = parseSpec(spec);
  if (requestedVersion) throw new Error('Select an installed plugin by package name');
  const directory = profiles.directory(dataDir, profile);
  const manifestFile = path.join(directory, 'package.json');
  const beforeManifest = configCoordination.snapshot(manifestFile);
  const manifest = beforeManifest === null ? null : JSON.parse(beforeManifest);
  if (!manifest || !Object.hasOwn(manifest.dependencies || {}, name)) throw new Error('Plugin is not installed in this profile');
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw new Error('dsh profile manifest is incompatible');
  return { name, directory, manifestFile, manifest, beforeManifest };
}
function list(dataDir, profile) {
  const directory = profiles.directory(dataDir, profile);
  const manifest = ops.readJson(path.join(directory, 'package.json'), {});
  let enablementError = null;
  try { require('./plugin-enablement.js').intents(manifest); }
  catch (error) { enablementError = error.message; } // Keep read-only management/backup views reachable.
  const dependencies = manifest.dependencies || {};
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  return Object.entries(dependencies).filter(([name]) => {
    try { return parseSpec(name).name === name; } catch { return false; }
  }).map(([name, requested]) => {
    let installed;
    try { installed = ops.readJson(path.join(directory, 'node_modules', ...name.split('/'), 'package.json')); } catch {}
    let compatible = false;
    try { bundlePatch(installed); compatible = true; } catch {}
    let filesOk = false;
    try { filesOk = installed?.name === name && !!bundlePatch(installed); } catch { filesOk = false; }
    return { name, version: installed?.version || requested, enabled: bundles.includes(name), compatible, filesOk, ...(enablementError ? { enablementError } : {}) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
function setEnabled(dataDir, profile, spec, enabled, options = {}) {
  const apply = () => require('./plugin-enablement.js').set(dataDir, profile,
    profilePackage(dataDir, profile, spec), enabled, ops, options);
  return options.preflightOnly === true ? apply() : configCoordination.withLock(profiles.directory(dataDir, profile), apply);
}
async function metadata(name, registry) {
  const url = new URL(encodeURIComponent(name), cores.registryUrl(registry));
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Package lookup failed (${response.status})`);
  return response.json();
}
async function inspect(spec, registry) {
  const { name, requestedVersion } = parseSpec(spec);
  const record = await metadata(name, registry);
  const version = requestedVersion || record['dist-tags']?.latest;
  const manifest = record.versions?.[version];
  if (!manifest || manifest.name !== name || manifest.version !== version) throw new Error('Package version is unavailable');
  const integrity = manifest.dist?.integrity || '';
  if (!/^sha512-[A-Za-z0-9+/=]+$/.test(integrity) || Buffer.from(integrity.slice(7), 'base64').length !== 64) throw new Error('Package has no SHA-512 integrity digest');
  bundlePatch(manifest);
  return { name, version, integrity: manifest.dist.integrity };
}
function npmBin() { return process.env.FNOS_NPM_BIN || path.join(path.dirname(process.execPath), 'npm'); }
// All management CLI launchers share one close-confirmed lifecycle registry.
// A rejected operation without close remains registered: exit alone does not
// establish that inherited pipes/descriptors have been released.
const cliOperations = new Set();
const MAX_CLI_OPERATIONS = 16; // Includes unknown leases; unique-cwd retries cannot grow without bound.
let cliStopping = false;
function cliOperationStatus() {
  for (const operation of cliOperations) operation.reap();
  return [...cliOperations].map(({ child, cwd }) => ({ pid: child.pid ?? null, cwd, closed: false }));
}
async function cancelCliOperations(reason = 'CLI shutdown') {
  cliStopping = true;
  const active = [...cliOperations];
  for (const operation of active) operation.cancel(Object.assign(new Error(reason), { code: 'ERR_CLI_CANCELLED' }));
  await Promise.all(active.map(operation => operation.completion));
  const remaining = cliOperationStatus();
  return { ok: remaining.length === 0, remaining };
}
function runCli(command, args, {
  cwd, env, logFile, collectStderr = false, maxOutput = 2_000_000,
  timeoutMs = 10 * 60_000, termGraceMs = 2_000, killGraceMs = 2_000,
  signal, allowFailure = false, failureMessage = code => `CLI failed (${code})`,
} = {}) {
  return new Promise((resolve, reject) => {
    if (cliStopping) { reject(new Error('CLI shutdown in progress')); return; }
    if (signal?.aborted) { reject(Object.assign(new Error('CLI aborted before spawn'), {code:'ERR_CLI_CANCELLED',closed:true})); return; }
    cliOperationStatus(); // harmless reaping only; never signal after leader close
    if ([...cliOperations].some(operation => operation.cwd === cwd && operation.unconfirmed)) {
      reject(Object.assign(new Error('Previous CLI has not confirmed close'), { code: 'ERR_CLI_UNCONFIRMED', closed: false })); return;
    }
    if (cliOperations.size >= MAX_CLI_OPERATIONS) { reject(Object.assign(new Error('CLI operation capacity reached; wait for active or unknown operations'), { code: 'ERR_CLI_CAPACITY', closed: true })); return; }
    let child, output, containment;
    try {
      containment = process.platform === 'linux' ? cliContainment.prepare(command, args) : null;
      if (!collectStderr) output = fs.openSync(logFile, 'a', 0o600);
      child = spawn(containment?.command || command, containment?.args || args, {
        cwd, env, detached: process.platform === 'linux',
        stdio: ['ignore', 'pipe', collectStderr ? 'pipe' : output, ...(containment ? ['pipe'] : [])],
      });
      containment?.attach(child);
    } catch (error) { reject(error); return; }
    finally { if (output !== undefined) fs.closeSync(output); }
    const group = process.platform === 'linux' ? cliProcessGroup.create(child) : null;
    let done = false, childClosed = false, closed = false, cause = null, size = 0;
    const chunks = [];
    let timeout, termTimer, killTimer, complete;
    const completion = new Promise(resolveCompletion => { complete = resolveCompletion; });
    const clearTimers = () => { clearTimeout(timeout); clearTimeout(termTimer); clearTimeout(killTimer); };
    const text = () => Buffer.concat(chunks, size).toString('utf8');
    const settle = (error, code, closeSignal) => {
      if (done) return;
      done = true;
      clearTimers();
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        error.closed = closed;
        error.text = text();
        reject(error);
      } else resolve({ code, signal: closeSignal, text: text(), closed: true });
      chunks.length = 0;
      size = 0;
      complete({ closed });
    };
    const signalChild = signal => {
      if (childClosed || done) return; // late callbacks must never signal a recycled PGID
      // SIGKILL would destroy the reaper before it can prove descendant exit.
      // SIGUSR2 asks the owned helper to force-kill/reap its children instead.
      if (group) return group.signal(containment && signal === 'SIGKILL' ? 'SIGUSR2' : signal);
      if (process.platform === 'linux') return; // failed spawn: never fall back to a shared group
      try { child.kill(signal); } catch (error) { cause ||= error; }
    };
    const unconfirmed = reason => {
      operation.unconfirmed = true;
      settle(Object.assign(new Error(`${cause?.message || 'CLI completion'}; ${reason}`), {
        code: 'ERR_CLI_UNCONFIRMED', cause,
      }));
    };
    const cancel = error => {
      if (childClosed || done || cause) return;
      cause = error;
      clearTimeout(timeout);
      signalChild('SIGTERM');
      if (childClosed || done) return;
      termTimer = setTimeout(() => {
        if (childClosed || done) return;
        signalChild('SIGKILL');
        if (childClosed || done) return;
        killTimer = setTimeout(() => {
          if (childClosed || done) return;
          unconfirmed('child close/tree termination unconfirmed after cancellation');
        }, killGraceMs);
      }, termGraceMs);
    };
    const operation = { child, cwd, cancel, completion, unconfirmed: false, reap() {
      if (childClosed && containment?.result() && group && ['gone', 'quiescent'].includes(group.probe().state)) cliOperations.delete(operation);
    } };
    const onAbort = () => cancel(Object.assign(new Error('CLI aborted'), {code:'ERR_CLI_CANCELLED'}));
    cliOperations.add(operation);
    signal?.addEventListener('abort', onAbort, {once:true});
    if (signal?.aborted) onAbort();
    const collect = chunk => {
      if (done || cause) return; // Keep draining, but never accumulate after cancellation.
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const kept = buffer.subarray(0, Math.max(0, maxOutput - size));
      if (kept.length) { chunks.push(Buffer.from(kept)); size += kept.length; }
      if (buffer.length > kept.length || size >= maxOutput) {
        cancel(Object.assign(new Error(`CLI output exceeded ${maxOutput} bytes`), { code: 'ERR_CLI_OUTPUT_LIMIT' }));
      }
    };
    child.stdout?.on('data', collect);
    if (collectStderr) child.stderr?.on('data', collect);
    const onError = error => cancel(error);
    child.on('error', onError);
    child.once('close', (code, closeSignal) => {
      childClosed = true;
      clearTimers();
      child.stdout?.removeListener('data', collect);
      child.stderr?.removeListener('data', collect);
      child.removeListener('error', onError);
      const proof = containment?.result();
      const failedSpawn = containment && !Number.isSafeInteger(child.pid) && cause;
      const tree = group ? group.probe() : { state: 'gone' };
      closed = (tree.state === 'gone' || tree.state === 'quiescent') && (!containment || !!proof || !!failedSpawn);
      if (!closed) { unconfirmed(`process group ${tree.state}: ${tree.reason || 'descendant completion receipt missing'}`); return; }
      if (failedSpawn) cause = cliContainment.unavailable(cause);
      if (proof) { code = proof.code; closeSignal = proof.signal; cause ||= proof.error; }
      cliOperations.delete(operation);
      if (cause) settle(cause);
      else if (code === 0 || (allowFailure && code !== null && !closeSignal)) settle(null, code, closeSignal);
      else settle(new Error(failureMessage(code, closeSignal)));
    });
    if (!done) timeout = setTimeout(() => cancel(Object.assign(new Error('CLI timed out'), { code: 'ERR_CLI_TIMEOUT' })), timeoutMs);
  });
}
function runNpm(args, cwd, registry, logFile, allowAuditFailure = false) {
  return runCli(npmBin(), args, {
    cwd, env: { ...process.env, npm_config_registry: registry, npm_config_cache: path.join(path.dirname(logFile), 'npm-cache') },
    logFile, allowFailure: allowAuditFailure,
    failureMessage: code => `npm failed (${code}); see plugin-install.log`,
  });
}

// The profile is a pnpm workspace (pnpm-lock.yaml + pnpm-workspace.yaml with
// nodeLinker: hoisted), and DSH's peer dependencies are supplied by the
// $DSH_HOME/profiles/node_modules fallback layer rather than installed into
// the profile. npm's strict peer resolution cannot express that arrangement:
// it re-resolves the whole tree and fails with ERESOLVE before writing
// anything, which is why every management-page uninstall used to fail.
// The official CLI forwards to pnpm (which warns instead of refusing) and
// reconciles dsh.profile.bundles afterwards, so removal goes through it.
// pnpm records the store a profile was built from in node_modules/.modules.yaml.
// Feeding the process a different store makes EVERY pnpm operation refuse with
// ERR_PNPM_UNEXPECTED_STORE — which is exactly what broke plugin updates after
// the profile's store had drifted (an update once ran with pnpm's default
// store and rewrote the record). Follow the profile's own record; fall back to
// the private per-app store only for a profile that was never built.
function runtimeStoreDir(dataDir, profile) {
  const fallback = ops.dataPath(dataDir, 'pnpm-store');
  let recorded = null;
  let modulesYaml = null;
  try {
    modulesYaml = path.join(profiles.directory(dataDir, profile), 'node_modules', '.modules.yaml');
    const match = /["']?storeDir["']?:\s*["']?([^"'\s,]+)/.exec(fs.readFileSync(modulesYaml, 'utf8'));
    if (match && match[1]) recorded = match[1];
  } catch { /* a fresh profile has no build record yet */ }
  if (!recorded) return fallback;

  // ── storeDir 记录自愈（0.3.61）───────────────────────────────────────────
  // pnpm 的 checkCompatibility 要求 `.modules.yaml` 里的 storeDir 与**本次运行
  // 的 pnpm 算出的 store** 严格相等，否则每个操作都拒绝：
  //   ERR_PNPM_UNEXPECTED_STORE
  //     The dependencies at "<profile>/node_modules" are currently linked from the
  //     store at "<记录值>"。pnpm now wants to use the store at "<计算值>"
  //
  // 记录值会被"当时跑的 pnpm"改写、而不同大版本算出的路径不同，于是升级/混用
  // 之后两边对不上。根因已定位：PATH 里若先命中 **corepack 的 pnpm shim**，
  // 它会下载 pnpm 12.8.1，把 storeDir 写成 `<store-root>/v11`；而应用自带的
  // pnpm 10.34.5 算的是 `<store-root>/v11/v10`。
  //
  // PATH 已在 supervisor 启动时修正（见 supervisor.js 顶部），这里是**兜底**：
  // 万一记录仍是被别的版本写坏的旧值，就用 pnpm 自己算出的规范路径**就地改写
  // 记录**，让两边一致。这比"改用默认 store"更好——不丢已有缓存、不需要重装。
  const computed = computedStoreDir(recorded);
  if (computed && computed !== recorded) {
    pointRecordAt(modulesYaml, recorded, computed);
    recorded = computed;
  }

  // A recorded store can become unusable (permissions reset by another tool,
  // a path on storage that was reformatted). Feeding pnpm an unwritable store
  // makes every operation fail — and a purge half-way through can leave the
  // profile without node_modules at all, which takes down core at boot.
  // Self-heal order: repair the store's permissions if we own it; otherwise
  // rewrite the recorded store back to the private one (cost: a fresh full
  // download, because the private store does not have the old cache).
  try {
    fs.accessSync(recorded, fs.constants.W_OK);
    return recorded;
  } catch { /* unusable as-is */ }
  try {
    fs.chmodSync(recorded, 0o755);
    fs.accessSync(recorded, fs.constants.W_OK);
    console.log(`[plugins] pnpm store ${recorded} had lost its permissions; repaired to 0755`);
    return recorded;
  } catch { /* not repairable by this user */ }
  if (modulesYaml && fs.existsSync(modulesYaml)) {
    pointRecordAt(modulesYaml, recorded, fallback);
    console.log(`[plugins] pnpm store ${recorded} is unwritable; switched the profile record to ${fallback}`);
  }
  return fallback;
}

// 用 runtime 自带的 pnpm 算出「规范化」的 store 路径。
// 做法：把 storeDir 交给 pnpm 自己解析（`pnpm store path`），它会把
// layout 版本段补上。失败一律返回 null —— 自愈是尽力而为，绝不能阻断操作。
function computedStoreDir(storeDir) {
  const appDir = process.env.FNOS_APP_DIR;
  if (!appDir) return null;
  const pnpmBin = path.join(appDir, 'runtime', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  if (!fs.existsSync(pnpmBin)) return null;
  try {
    const out = require('node:child_process').execFileSync(
      process.execPath, [pnpmBin, 'store', 'path'],
      { env: { ...process.env, npm_config_store_dir: storeDir }, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const line = String(out).trim().split('\n').filter(Boolean).pop();
    if (line && path.isAbsolute(line) && line !== storeDir) return line;
  } catch { /* pnpm 不可用或超时：不自愈 */ }
  return null;
}

// 原地改写 .modules.yaml 的 storeDir 记录（保持其余内容逐字节不变）。
function pointRecordAt(modulesYaml, from, to) {
  if (!modulesYaml) return false;
  try {
    const text = fs.readFileSync(modulesYaml, 'utf8');
    const next = text.replace(/(storeDir["']?:\s*["']?)[^"'\s,]+/, `$1${to}`);
    if (next === text) return false;
    fs.writeFileSync(modulesYaml, next);
    console.log(`[plugins] pnpm storeDir record corrected: ${from} -> ${to}`);
    return true;
  } catch { return false; }
}

function dshBin() {
  const appDir = process.env.FNOS_APP_DIR;
  if (!appDir) throw new Error('Missing fnOS application path');
  return path.join(appDir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}
function pluginEnv(dataDir, profile, options = {}) {
  const bins = path.join(process.env.FNOS_APP_DIR, 'runtime', 'node_modules', '.bin');
  return {
    ...gitEnv.gitInstallEnv(process.env, {
      publicGithubShorthand: options.publicGithubShorthand === true,
      sshIntent: options.sshIntent === true,
      cwd: profiles.directory(dataDir, profile),
    }),
    // DSH_HOME decides which profile tree the CLI mutates; the working
    // directory does not. Always point it at this installation's data
    // directory so a stray cwd can never redirect the operation.
    DSH_HOME: ops.dataPath(dataDir, 'dsh-home'),
    PNPM_HOME: ops.dataPath(dataDir, 'pnpm-home'),
    npm_config_store_dir: runtimeStoreDir(dataDir, profile),
    PATH: `${bins}${path.delimiter}${process.env.PATH || ''}`,
  };
}
async function runDshPlugin(args, dataDir, profile, logFile, options = {}) {
  // Validate argv and environment before opening the log descriptor.
  const env = pluginEnv(dataDir, profile, options);
  if (options.registry) env.npm_config_registry = options.registry;
  const preload = require('./port-owner.js').instancePreload(dataDir);
  return runCli(process.execPath, ['--require', preload, dshBin(), 'plugin', '--profile', profile, ...args], {
    cwd: ops.dataPath(dataDir, 'dsh-home', 'profiles', profile), env, logFile,
    failureMessage: code => `插件管理器失败（退出码 ${code}）；详见 plugin-install.log`,
  });
}
// 插件文件健康修复（0.3.61）：node_modules 被半途失败的 pnpm 操作清空后的
// 恢复——走官方 CLI 的 install（按锁文件 reconcile 全部 bundles；store 已有
// 缓存时可离线完成）。返回 { ok, text, missing }；missing 非空表示部分 bundle
// 仍缺失（如 github 来源在离线时无法还原）。
async function repairPluginFiles(dataDir, profile, registry) {
  const logFile = ops.dataPath(dataDir, 'plugin-install.log');
  const profileDir = profiles.directory(dataDir, profile);
  const disabledNames = Object.keys(require('./plugin-enablement.js').intents(ops.readJson(path.join(profileDir, 'package.json'))));
  let text, closed = false;
  try { ({ text } = await runDshPlugin(['install'], dataDir, profile, logFile, { registry })); closed = true; }
  catch (error) { closed = error.closed === true; throw error; }
  finally {
    // Never write under an unconfirmed CLI that may still be mutating files.
    // Closed failures, like success, may have reconciled all bundles already.
    if (closed) for (const name of disabledNames) setEnabled(dataDir, profile, name, false);
  }
  const manifest = ops.readJson(path.join(profileDir, 'package.json'));
  const bundles = manifest?.dsh?.profile?.bundles || [];
  const missing = bundles.filter((name) => !name.startsWith('@deepseek-ai/') && !fs.existsSync(path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json')));
  return { ok: missing.length === 0, text, missing };
}
// 安装统一走 pnpm（经 dsh plugin add）：profile 的 peer 依赖来自共享回退层，
// npm 的严格解析无法表达（会 ERESOLVE 拒绝整个安装）。registry 来源保留
// npm audit（尽力而为，失败不阻断）；GitHub 来源没有可审计的 registry 元数据，
// 明确提示风险。每次写入都先走校验，失败时 best-effort 移除半安装的包。
async function pnpmAuditWarn(dataDir, profile, registry, logFile) {
  try {
    const { text } = await runDshPlugin(['audit', '--prod', '--json'], dataDir, profile, logFile, { registry });
    const report = JSON.parse(text);
    const issues = report?.metadata?.vulnerabilities;
    if (issues && (issues.high || issues.critical)) {
      return `安全审计发现 ${issues.high || 0} 个高危、${issues.critical || 0} 个严重漏洞，请评估后使用`;
    }
  } catch (error) {
    // Optional audit failure is tolerable; an unclosed mutating CLI/shutdown is not.
    if (error.code === 'ERR_CLI_UNCONFIRMED' || error.code === 'ERR_CLI_CANCELLED' || cliStopping) throw error;
  }
  return null;
}

// 本地导入的包名无法从 spec 预知——由「安装前后依赖清单的差集」推导（与
// GitHub 来源同思路）。跳过 registry 元数据与审计（本地包没有对应记录），
// 但 dsh 声明校验、bundle patch 校验、启动验证与失败回滚全部保留。
async function installLocal(dataDir, profile, tgzPath) {
  const profileDir = profiles.directory(dataDir, profile);
  const manifestFile = path.join(profileDir, 'package.json');
  if (!fs.existsSync(manifestFile)) throw new Error('dsh profile is not initialized');
  const beforeManifest = ops.readJson(manifestFile);
  require('./plugin-enablement.js').intents(beforeManifest);
  const before = beforeManifest?.dependencies || {};
  const logFile = ops.dataPath(dataDir, 'plugin-install.log');

  await runDshPlugin(['add', tgzPath], dataDir, profile, logFile);

  const after = ops.readJson(manifestFile)?.dependencies || {};
  const changed = Object.keys(after).filter((key) => before[key] !== after[key]);
  if (changed.length !== 1) {
    await runDshPlugin(['remove', changed.join(' ')], dataDir, profile, logFile).catch(() => {});
    throw new Error('无法唯一确定导入包对应的插件包名（依赖清单变化异常）');
  }
  const name = changed[0];

  try {
    const packageDir = path.join(profileDir, 'node_modules', ...name.split('/'));
    const installed = ops.readJson(path.join(packageDir, 'package.json'));
    if (installed?.name !== name) throw new Error('Installed package failed dsh bundle verification');
    const patch = bundlePatch(installed);
    const patchFile = fs.realpathSync(path.join(packageDir, patch));
    const resolvedDir = fs.realpathSync(packageDir);
    const modulesDir = fs.realpathSync(path.join(profileDir, 'node_modules'));
    if (!resolvedDir.startsWith(modulesDir + path.sep) || !patchFile.startsWith(resolvedDir + path.sep) || !fs.statSync(patchFile).isFile()) throw new Error('Plugin patch escapes its package');
  } catch (error) {
    await runDshPlugin(['remove', name], dataDir, profile, logFile).catch(() => {});
    throw error;
  }

  // Reinstall is a fresh enable action: remove prior management intent and
  // restore its precise disabled fields before publishing the bundle list.
  require('./plugin-enablement.js').forget(dataDir, profile, name, ops);
  const profileManifest = ops.readJson(manifestFile);
  const bundles = profileManifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) throw new Error('dsh profile manifest is incompatible');
  if (!bundles.includes(name)) bundles.push(name);
  ops.writeJson(manifestFile, profileManifest);

  const version = ops.readJson(path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json'))?.version || '';
  return { name, version, source: 'local', warning: '本地导入的插件未经安全审计，请只导入可信来源的包' };
}

// The caller may opt in only after approving a public GitHub shorthand.
// Syntax alone does not prove repository visibility; the default is no rewrite.
async function install(dataDir, profile, spec, registry, options = {}) {
  // 本地导入：只接受本应用上传目录内的 .tgz（网关 plugin-import 端点落盘），
  // 拒绝任意路径——否则 install-plugin 就成了任意文件安装通道。
  const uploadsDir = ops.dataPath(dataDir, 'plugin-uploads');
  if (typeof spec === 'string' && spec.startsWith(uploadsDir + path.sep) && /\.tgz$/.test(spec)) {
    return installLocal(dataDir, profile, spec);
  }
  const normalized = normalizePluginSpec(spec);
  const source = cores.registryUrl(registry);
  const profileDir = profiles.directory(dataDir, profile);
  const manifestFile = path.join(profileDir, 'package.json');
  if (!fs.existsSync(manifestFile)) throw new Error('dsh profile is not initialized');
  const beforeManifest = ops.readJson(manifestFile);
  require('./plugin-enablement.js').intents(beforeManifest);
  const before = beforeManifest?.dependencies || {};
  const logFile = ops.dataPath(dataDir, 'plugin-install.log');

  const rawSource = String(spec).trim().replace(/^github:/i, '');
  const publicGithubShorthand = options.publicGithubShorthand === true
    && normalized.kind === 'git' && GITHUB_REPO.test(rawSource);
  const sshIntent = Object.values(before).some((value) => typeof value === 'string'
    && /^(?:git\+ssh:|ssh:|[^\s/@]+@[^\s/:]+:)/i.test(value));
  await runDshPlugin(['add', normalized.spec], dataDir, profile, logFile, {
    registry: source, publicGithubShorthand, sshIntent,
  });

  const after = ops.readJson(manifestFile)?.dependencies || {};
  let name;
  if (normalized.kind === 'registry') {
    name = parseSpec(normalized.spec).name;
    if (!Object.hasOwn(after, name)) {
      await runDshPlugin(['remove', name], dataDir, profile, logFile).catch(() => {});
      throw new Error(`安装完成后依赖清单中未找到 ${name}`);
    }
  } else {
    const changed = Object.keys(after).filter((key) => before[key] !== after[key]);
    if (changed.length !== 1) throw new Error('无法唯一确定 GitHub 来源对应的插件包名，请改用 github:user/repo#tag 精确指定');
    name = changed[0];
  }

  try {
    const packageDir = path.join(profileDir, 'node_modules', ...name.split('/'));
    const installed = ops.readJson(path.join(packageDir, 'package.json'));
    if (installed?.name !== name) throw new Error('Installed package failed dsh bundle verification');
    const patch = bundlePatch(installed);
    const patchFile = fs.realpathSync(path.join(packageDir, patch));
    const resolvedDir = fs.realpathSync(packageDir);
    const modulesDir = fs.realpathSync(path.join(profileDir, 'node_modules'));
    if (!resolvedDir.startsWith(modulesDir + path.sep) || !patchFile.startsWith(resolvedDir + path.sep) || !fs.statSync(patchFile).isFile()) throw new Error('Plugin patch escapes its package');
  } catch (error) {
    await runDshPlugin(['remove', name], dataDir, profile, logFile).catch(() => {});
    throw error;
  }

  // Reinstall is a fresh enable action: remove prior management intent and
  // restore its precise disabled fields before publishing the bundle list.
  require('./plugin-enablement.js').forget(dataDir, profile, name, ops);
  const profileManifest = ops.readJson(manifestFile);
  const bundles = profileManifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) throw new Error('dsh profile manifest is incompatible');
  if (!bundles.includes(name)) bundles.push(name);
  ops.writeJson(manifestFile, profileManifest);

  const version = ops.readJson(path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json'))?.version || '';
  if (normalized.kind === 'git') {
    return { name, version, source: 'github', warning: 'GitHub 来源未经 npm 安全审计，请只安装可信发布者的插件' };
  }
  return { name, version, source: 'registry', warning: await pnpmAuditWarn(dataDir, profile, source, logFile) || undefined };
}

// Removing the package leaves two side tables pointing at a plugin that no
// longer exists: the profile's cordis.patch.yml can keep a `disabled: true`
// row, and the market's .dsh-market/state.json can keep the name in its
// `disabled` list. Reinstalling the plugin then starts it disabled, and the
// loader patch layer can suppress a row that is not there any more. Both are
// safe to prune: they only ever described a plugin that is now gone.
function prunePatchRows(profileDir, name) {
  const file = path.join(profileDir, 'cordis.patch.yml');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = new RegExp(`^- id: ['"]?${escaped}['"]?\\r?\\n(?:  disabled: (?:true|false)\\r?\\n|  [^\\r\\n]*\\r?\\n)*`, 'mu');
  const next = text.replace(row, '');
  if (next === text) return false;
  // A patch layer whose entries are all gone must stay parseable. Write only
  // the explanatory comments, never a bare `[]`: dshmarket appends its own
  // patch rows to this file, and an explicit empty-array document followed by
  // sequence items is two YAML documents — the loader then refuses to start.
  const meaningful = next.replace(/^[ \t]*#.*$/gmu, '').trim();
  fs.writeFileSync(file, meaningful === '' ? EMPTY_PATCH_TEXT : next);
  return true;
}
function pruneMarketState(profileDir, name) {
  const file = path.join(profileDir, '.dsh-market', 'state.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  if (!Array.isArray(state?.disabled) || !state.disabled.includes(name)) return false;
  state.disabled = state.disabled.filter((item) => item !== name);
  const tmp = `${file}.tmp-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
  return true;
}
// 手工摘除（0.3.61，P9 第三级降级）：pnpm 因 peer 冲突连 remove 都失败时，
// 直接从配置里摘掉该插件——从 dependencies 移除、从 bundles 移除、清理 patch 行。
// **不动 node_modules 里的文件**（保留供人工确认/回滚），只做配置层摘除。
function manualDetach(directory, name) {
  const manifestFile = path.join(directory, 'package.json');
  const manifest = ops.readJson(manifestFile);
  if (!manifest) return false;
  let changed = false;
  if (manifest.dependencies && Object.hasOwn(manifest.dependencies, name)) {
    delete manifest.dependencies[name];
    changed = true;
  }
  const bundles = manifest?.dsh?.profile?.bundles;
  if (Array.isArray(bundles)) {
    const next = bundles.filter((item) => item !== name);
    if (next.length !== bundles.length) { manifest.dsh.profile.bundles = next; changed = true; }
  }
  if (changed) ops.writeJson(manifestFile, manifest);
  return changed;
}
async function uninstall(dataDir, profile, spec, registry) {
  const { name, directory, manifestFile, manifest } = profilePackage(dataDir, profile, spec);
  require('./plugin-enablement.js').intents(manifest);
  const packageDir = path.join(directory, 'node_modules', ...name.split('/'));
  const installed = ops.readJson(path.join(packageDir, 'package.json'));
  let canBind = false;
  try { canBind = fs.existsSync(path.join(packageDir, bundlePatch(installed))); } catch {}
  if (canBind) setEnabled(dataDir, profile, name, false);
  else {
    // Removal must remain possible for a broken/missing installed package.
    // The caller already stopped core; retain any existing bound intent until
    // the CLI confirms removal, and do not invent entry ownership.
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(item => item !== name);
    ops.writeJson(manifestFile, manifest);
  }
  const logFile = ops.dataPath(dataDir, 'plugin-install.log');
  // P9（0.3.61）：pnpm 的严格 peer 解析会把「profile 里任何既有 peer 冲突」算到
  // 本次 remove 头上 —— 于是**卸载一个无关插件也会整单失败**（实测退出码 1，
  // 报错却指向别的包的 peer 依赖）。分三级保证卸载仍能完成：
  //   ① 正常 remove；② 失败则 --force（跳过 peer 检查）重试；
  //   ③ 仍失败则手工摘除配置（不动文件，保留供人工确认）。
  let removedBy = 'pnpm';
  let degradeNote = null;
  try {
    await runDshPlugin(['remove', name], dataDir, profile, logFile);
  } catch (firstError) {
    if (firstError.code === 'ERR_CLI_UNCONFIRMED' || firstError.code === 'ERR_CLI_CANCELLED' || firstError.code === 'ERR_CLI_CONTAINMENT' || cliStopping) throw firstError;
    try {
      await runDshPlugin(['remove', name, '--force'], dataDir, profile, logFile);
      removedBy = 'pnpm --force';
    } catch (secondError) {
      if (secondError.code === 'ERR_CLI_UNCONFIRMED' || secondError.code === 'ERR_CLI_CANCELLED' || secondError.code === 'ERR_CLI_CONTAINMENT' || cliStopping) throw secondError;
      manualDetach(directory, name);
      removedBy = 'manual';
      degradeNote = 'pnpm remove 两次失败（' + String(secondError.message || secondError).slice(0, 160) + '），已从配置层摘除；node_modules 文件保留。';
    }
  }
  const updated = ops.readJson(path.join(directory, 'package.json'));
  if (Object.hasOwn(updated?.dependencies || {}, name)) throw new Error('插件管理器没有移除该依赖');
  // Includes manual detach. Only confirmed removal clears intent and its bound
  // profile rows; unknown CLI completion retains intent and rollback evidence.
  const patchBeforeCleanup = ops.readPatchConfig(dataDir, profile).patch;
  require('./plugin-enablement.js').forget(dataDir, profile, name, ops, { removed: true });
  // Include the bound-row transaction's cleanup as well as legacy package-id rows.
  const legacyPatchCleaned = prunePatchRows(directory, name);
  const cleaned = [];
  if (legacyPatchCleaned || ops.readPatchConfig(dataDir, profile).patch !== patchBeforeCleanup) cleaned.push('cordis.patch.yml');
  if (pruneMarketState(directory, name)) cleaned.push('插件市场状态');
  return { name, removed: true, cleaned, removedBy, degradeNote };
}
function coordinatedProfileOperation(operation) {
  return (dataDir, profile, ...args) => configCoordination.withLock(profiles.directory(dataDir, profile), () => operation(dataDir, profile, ...args));
}
module.exports = { runCli, cancelCliOperations, cliOperationStatus,
  repairPluginFiles: coordinatedProfileOperation(repairPluginFiles), runtimeStoreDir, parseSpec, normalizePluginSpec, inspect,
  install: coordinatedProfileOperation(install), installLocal: coordinatedProfileOperation(installLocal), list, setEnabled,
  uninstall: coordinatedProfileOperation(uninstall) };
