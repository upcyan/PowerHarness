const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ops = require('./ops.js');
const coordination = require('./config-coordination.js');
const profiles = require('./profiles.js');
const plugins = require('./plugins.js');
const gitEnv = require('./git-transport.js');

// Plugins the FPK ships inside itself, so a fresh install starts with the same
// set this deployment runs instead of needing a link: target, a private GitHub
// repository, or a hand-copied tgz.
//
// They are written into a profile *only when that profile is first created*.
// An upgrade never re-adds a plugin the administrator removed on purpose, and
// never overwrites one they replaced with a newer version: the bundle is the
// starting point, not an ongoing policy.

const bundleDirName = 'plugins-bundled';
const indexPath = 'bundled-plugins.json';
// Persisted in the data dir: whether the bundled set was already applied to a
// profile, and how each package went. "No third-party bundles right now" is
// NOT the same as "never seeded" — an administrator who removes every plugin
// must not get them all reinstalled on the next start, and a first pass that
// only partially succeeded must be able to finish on a later boot.
const seedStateFile = 'bundled-plugins-state.json';

function bundledRoot(appDir) {
  return path.join(appDir || process.env.FNOS_APP_DIR || '', bundleDirName);
}

function seedStatePath(dataDir) {
  return ops.dataPath(dataDir, seedStateFile);
}

function readSeedState(dataDir) {
  return ops.readJson(seedStatePath(dataDir), { seeded: false, results: {} });
}

function writeSeedState(dataDir, state) {
  ops.writeJson(seedStatePath(dataDir), state);
}

function readIndex(appDir) {
  const file = path.join(bundledRoot(appDir), indexPath);
  const index = ops.readJson(file);
  if (!index || !Array.isArray(index.plugins)) return null;
  return index.plugins.filter((entry) => (
    entry && typeof entry.name === 'string' && typeof entry.file === 'string'
    && !entry.file.includes('/') && !entry.file.includes('..')
  ));
}

function available(appDir) {
  const root = bundledRoot(appDir);
  if (!fs.existsSync(root)) return [];
  return readIndex(appDir) || [];
}

// The install runs pnpm through the dsh CLI, exactly like the management page's
// uninstall: the profile is a pnpm workspace whose peers come from the shared
// fallback layer, which npm's strict resolution cannot express (see plugins.js).
function dshBin(appDir) {
  if (!appDir) throw new Error('Missing fnOS application path');
  return path.join(appDir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

async function runDshPlugin(args, { appDir, dataDir, profile, logFile }) {
  const bins = path.join(appDir, 'runtime', 'node_modules', '.bin');
  const env = {
    // Tarball seeding adds no GitHub policy; preserve inherited COUNT groups.
    ...gitEnv.normalizeGitParentEnv(process.env),
    DSH_HOME: ops.dataPath(dataDir, 'dsh-home'),
    PNPM_HOME: ops.dataPath(dataDir, 'pnpm-home'),
    npm_config_store_dir: plugins.runtimeStoreDir(dataDir, profile),
    PATH: `${bins}${path.delimiter}${process.env.PATH || ''}`
  };
  const preload = require('./port-owner.js').instancePreload(dataDir);
  return plugins.runCli(process.execPath, ['--require', preload, dshBin(appDir), 'plugin', '--profile', profile, ...args], {
    cwd: ops.dataPath(dataDir, 'dsh-home', 'profiles', profile), env, logFile, maxOutput: 1_000_000,
    failureMessage: code => `bundled plugin install failed (exit ${code}); see plugin-install.log`,
  });
}

// Stage the tarballs inside the profile first. Keeping the FPK's own path out
// of the manifest matters: the app directory changes on reinstall, and a
// `file:` dependency pointing at it would break the moment it moved. Each
// archive is checksummed against the index it shipped with, so a truncated or
// swapped file is refused instead of silently corrupting a profile.
function stageTarballs(entries, { appDir, profileDir }) {
  const stage = path.join(profileDir, bundleDirName);
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  const staged = [];
  const problems = [];
  for (const entry of entries) {
    const source = path.join(bundledRoot(appDir), entry.file);
    if (!fs.existsSync(source)) { problems.push(`${entry.name}: bundled archive missing (${entry.file})`); continue; }
    // integrity 必填（0.3.60 起）：缺失/非字符串一律拒绝安装，而不是静默放行。
    // 上游桌面版 core-package-set 把逐包 sha512 当作 schema 硬字段——缺校验值的
    // 归档等同于不可信归档，宁可首装少一个插件（有日志与摘要可追），不冒装坏包的险。
    if (typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/=]+$/.test(entry.integrity)) {
      problems.push(`${entry.name}: bundled index entry lacks a valid sha512 integrity field`); continue;
    }
    const actual = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(source)).digest('base64');
    if (actual !== entry.integrity) { problems.push(`${entry.name}: bundled archive failed integrity check`); continue; }
    const target = path.join(stage, entry.file);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
    staged.push({ entry, target });
  }
  return { stage, staged, problems };
}

/**
 * Install the bundled plugins into a profile that has just been created.
 *
 * Ordinary confirmed install failures are returned in the summary: missing an
 * optional plugin need not block startup. Unconfirmed CLI/config transactions
 * instead throw and retain the profile lock; they must not be treated as safe.
 */
async function installInto({ appDir, dataDir, profile, logFile, onProgress = null }) {
  const entries = available(appDir);
  if (!entries.length) return { installed: [], skipped: [], failed: [] };

  const profileDir = profiles.directory(dataDir, profile);
  const manifestFile = path.join(profileDir, 'package.json');
  if (!fs.existsSync(manifestFile)) return { installed: [], skipped: [], failed: [], reason: 'profile is not initialized' };

  return coordination.withLock(profileDir, () => installIntoLocked({ appDir, dataDir, profile, logFile, onProgress }, entries, profileDir, manifestFile));
}
async function installIntoLocked({ appDir, dataDir, profile, logFile, onProgress }, entries, profileDir, manifestFile) {
  const manifest = ops.readJson(manifestFile, {});
  const deps = manifest.dependencies || {};
  // Only packages the profile does not have yet: anything already declared is
  // the user's choice (or a previous pass's success) — never reinstall over it.
  const wanted = entries.filter((entry) => !Object.hasOwn(deps, entry.name));
  const already = entries.filter((entry) => Object.hasOwn(deps, entry.name)).map((entry) => entry.name);
  if (!wanted.length) return { installed: [], skipped: already, failed: [] };

  const { staged, problems } = stageTarballs(wanted, { appDir, profileDir });
  const installed = [];
  const failed = [...problems];
  for (const { entry, target } of staged) {
    if (onProgress) onProgress(entry);
    try {
      await runDshPlugin(['add', target], { appDir, dataDir, profile, logFile });
      installed.push(`${entry.name}@${entry.version}`);
    } catch (error) {
      if (coordination.isUnconfirmed(error)) throw error;
      failed.push(`${entry.name}: ${error.message}`);
    }
  }
  return { installed, skipped: already, failed };
}

/**
 * Seed the bundled set, driven by the persisted seed record instead of the
 * profile's current shape:
 *
 * - never seeded → install everything missing (a partial pass retries the
 *   remainder on the next boot, because only successes are recorded);
 * - already seeded → do nothing, so an administrator who removed every plugin
 *   keeps that choice.
 */
async function seed({ appDir, dataDir, profile, logFile }) {
  const state = readSeedState(dataDir);
  if (state.seeded) return { seeded: true, ...{ installed: [], skipped: [], failed: [] } };
  const summary = await installInto({ appDir, dataDir, profile, logFile });
  for (const done of summary.installed) {
    const name = done.split('@')[0];
    state.results[name] = 'installed';
  }
  for (const name of summary.skipped) state.results[name] = 'already-present';
  for (const item of summary.failed) state.results[item.split(':')[0]] = 'failed';
  state.seeded = true;
  writeSeedState(dataDir, state);
  return { seeded: true, ...summary };
}

// Whether a profile looks untouched, i.e. safe to seed with the bundled set.
function isFreshProfile(dataDir, profile) {
  const profileDir = profiles.directory(dataDir, profile);
  const manifest = ops.readJson(path.join(profileDir, 'package.json'));
  if (!manifest) return false;
  const bundles = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return false;
  // A profile created from the official template carries exactly the core
  // bundles and nothing else.
  return !bundles.some((item) => !/^@deepseek-ai\//.test(item));
}

module.exports = { available, installInto, seed, isFreshProfile, bundleDirName };
