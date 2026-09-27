const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');

function inside(root, child) {
  const base = path.resolve(root);
  const target = path.resolve(child);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('Path leaves app data directory');
  return target;
}

function dataPath(dataDir, ...parts) { return inside(dataDir, path.join(dataDir, ...parts)); }
function exists(p) { return fs.existsSync(p); }
function privateDir(p) { fs.mkdirSync(p, { recursive: true, mode: 0o700 }); fs.chmodSync(p, 0o700); }
function id() { return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`; }
function writeJson(file, value) {
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, file); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) || attempt >= 20) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } catch (error) { fs.rmSync(tmp, { force: true }); throw error; }
}
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function dshVersion(appDir) {
  try { return JSON.parse(fs.readFileSync(path.join(appDir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version; }
  catch { return null; }
}

function listBackups(dataDir) {
  const root = dataPath(dataDir, 'backups');
  if (!exists(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => {
      const meta = readJson(dataPath(dataDir, 'backups', entry.name, 'meta.json'));
      return meta && meta.id === entry.name ? meta : null;
    }).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const defaultBackupSettings = { daily: 7, manual: 3, 'pre-upgrade': 2, dailyMode: 'always' };
function backupSettings(dataDir) {
  const saved = readJson(dataPath(dataDir, 'backup-settings.json'), {});
  const result = { ...defaultBackupSettings, ...saved };
  for (const [kind, max] of [['daily', 30], ['manual', 30], ['pre-upgrade', 10]]) {
    if (!Number.isInteger(result[kind]) || result[kind] < 1 || result[kind] > max) throw new Error(`Invalid ${kind} backup limit`);
  }
  if (!['always', 'changed', 'updates'].includes(result.dailyMode)) throw new Error('Invalid daily backup mode');
  return result;
}
function saveBackupSettings(dataDir, value) {
  const settings = { ...backupSettings(dataDir), ...value };
  for (const kind of ['daily', 'manual', 'pre-upgrade']) if (typeof settings[kind] === 'string') settings[kind] = Number(settings[kind]);
  for (const [kind, max] of [['daily', 30], ['manual', 30], ['pre-upgrade', 10]]) {
    if (!Number.isInteger(settings[kind]) || settings[kind] < 1 || settings[kind] > max) throw new Error(`Invalid ${kind} backup limit`);
  }
  if (!['always', 'changed', 'updates'].includes(settings.dailyMode)) throw new Error('Invalid daily backup mode');
  writeJson(dataPath(dataDir, 'backup-settings.json'), settings);
  pruneBackups(dataDir);
  return settings;
}
function snapshotFingerprint(dataDir, configDir) {
  const hash = createHash('sha256');
  const visit = (file, relative) => {
    const info = fs.lstatSync(file);
    hash.update(relative);
    if (info.isSymbolicLink()) { hash.update('link'); hash.update(fs.readlinkSync(file)); }
    else if (info.isDirectory()) {
      hash.update('dir');
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), `${relative}/${name}`);
    } else if (info.isFile()) {
      hash.update('file');
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      try { for (let size; (size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, size)); }
      finally { fs.closeSync(fd); }
    }
  };
  // TRIM_PKGETC is fnOS-managed. Package users may read it but cannot rename its parent.
  for (const [name, root] of [['dsh-home', dataPath(dataDir, 'dsh-home')], ['workspace', dataPath(dataDir, 'workspace')]]) {
    if (root && exists(root)) visit(root, name);
  }
  return hash.digest('hex');
}
function pruneBackups(dataDir) {
  const limits = backupSettings(dataDir);
  const groups = new Map();
  for (const item of listBackups(dataDir)) {
    const group = groups.get(item.kind) || [];
    group.push(item);
    groups.set(item.kind, group);
  }
  for (const [kind, entries] of groups) {
    for (const item of entries.slice(limits[kind] ?? 2)) {
      fs.rmSync(dataPath(dataDir, 'backups', item.id), { recursive: true, force: true });
    }
  }
}

function createSnapshot(dataDir, configDir, kind, version) {
  if (!['daily', 'manual', 'pre-upgrade'].includes(kind)) throw new Error('Invalid backup kind');
  const root = dataPath(dataDir, 'backups');
  privateDir(root);
  const backupId = id();
  const pending = dataPath(dataDir, 'backups', `.pending-${backupId}`);
  const final = dataPath(dataDir, 'backups', backupId);
  privateDir(pending);
  try {
    for (const name of ['dsh-home', 'workspace']) {
      const src = dataPath(dataDir, name);
      if (exists(src)) fs.cpSync(src, path.join(pending, name), { recursive: true, dereference: false });
    }
    const meta = { id: backupId, kind, version, createdAt: new Date().toISOString(), fingerprint: snapshotFingerprint(dataDir, configDir) };
    writeJson(path.join(pending, 'meta.json'), meta);
    fs.renameSync(pending, final);
    pruneBackups(dataDir);
    return meta;
  } catch (error) {
    fs.rmSync(pending, { recursive: true, force: true });
    throw error;
  }
}

function restoreSnapshot(dataDir, configDir, backupId) {
  if (!/^\d{4}-\d{2}-\d{2}T[0-9Z-]+-[a-f0-9]{8}$/.test(backupId)) throw new Error('Invalid backup ID');
  const source = dataPath(dataDir, 'backups', backupId);
  const meta = readJson(path.join(source, 'meta.json'));
  if (!meta || meta.id !== backupId) throw new Error('Backup metadata mismatch');
  for (const name of ['dsh-home', 'workspace']) {
    if (!fs.lstatSync(path.join(source, name), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Backup is incomplete: ${name}`);
  }
  const targets = [
    ['dsh-home', dataPath(dataDir, 'dsh-home')],
    ['workspace', dataPath(dataDir, 'workspace')]
  ];
  const stages = [];
  try {
    for (const [name, target] of targets) {
      const saved = path.join(source, name);
      if (!exists(saved)) continue;
      const stage = `${target}.restore-new-${randomBytes(4).toString('hex')}`;
      stages.push({ target, stage, old: `${target}.restore-old-${randomBytes(4).toString('hex')}`, installed: false });
      fs.cpSync(saved, stage, { recursive: true, dereference: false });
    }
    for (const entry of stages) {
      if (exists(entry.target)) fs.renameSync(entry.target, entry.old);
      fs.renameSync(entry.stage, entry.target);
      entry.installed = true;
    }
  } catch (error) {
    for (const entry of stages.reverse()) {
      if (entry.installed && exists(entry.target)) fs.rmSync(entry.target, { recursive: true, force: true });
      if (exists(entry.old)) {
        fs.renameSync(entry.old, entry.target);
      }
      if (exists(entry.stage)) fs.rmSync(entry.stage, { recursive: true, force: true });
    }
    throw error;
  }
  for (const entry of stages) if (exists(entry.old)) {
    try { fs.rmSync(entry.old, { recursive: true, force: true }); } catch {}
  }
  return meta;
}

function promoteRuntime(appDir, dataDir) {
  const current = dshVersion(appDir);
  if (!current) throw new Error('Bundled dsh runtime is missing');
  const last = dataPath(dataDir, 'last-good');
  if (dshVersion(last) === current) return current;
  const previous = dataPath(dataDir, 'previous-good');
  const stage = dataPath(dataDir, `.runtime-stage-${id()}`);
  fs.cpSync(appDir, stage, {
    recursive: true, dereference: false,
    filter: (source) => !fs.lstatSync(source).isSocket()
  });
  if (exists(previous)) fs.rmSync(previous, { recursive: true, force: true });
  if (exists(last)) fs.renameSync(last, previous);
  try { fs.renameSync(stage, last); }
  catch (error) { if (exists(previous) && !exists(last)) fs.renameSync(previous, last); throw error; }
  return current;
}

function portSettings(dataDir) {
  const saved = readJson(dataPath(dataDir, 'port-settings.json'), {}) || {};
  const core = Number(saved.corePort);
  const pub = Number(saved.publicPort);
  return {
    corePort: Number.isInteger(core) && core >= 1024 && core <= 65535 ? core : 3081,
    publicPort: Number.isInteger(pub) && pub >= 1024 && pub <= 65535 ? pub : null
  };
}

function savePorts(dataDir, patch) {
  const file = dataPath(dataDir, 'port-settings.json');
  const current = readJson(file, {}) || {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  writeJson(file, next);
}

module.exports = { dataPath, readJson, writeJson, dshVersion, listBackups, backupSettings, saveBackupSettings, snapshotFingerprint, createSnapshot, restoreSnapshot, promoteRuntime, portSettings, savePorts };
