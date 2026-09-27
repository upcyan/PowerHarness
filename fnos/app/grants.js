const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ops = require('./ops.js');

const shortcutFolder = 'fnOS 授权目录';
const marker = '.dsh-fnos-shortcuts';
function within(root, target) { return root === '/' || target === root || target.startsWith(`${root}/`); }

function authorizedPaths(raw = process.env.TRIM_DATA_ACCESSIBLE_PATHS || '') {
  return [...new Set(String(raw).split(':').map((value) => value.trim()).filter((value) => value.startsWith('/')).map((value) => path.posix.resolve(value)))];
}

function inspect(raw) {
  return authorizedPaths(raw).map((target) => {
    let directory = false;
    let readable = false;
    let writable = false;
    try {
      directory = fs.statSync(target).isDirectory();
      fs.accessSync(target, fs.constants.R_OK);
      readable = true;
      try { fs.accessSync(target, fs.constants.W_OK); writable = true; } catch {}
    } catch {}
    return { path: target, directory, readable, writable };
  });
}

function probeWorkspace(input, raw = process.env.TRIM_DATA_ACCESSIBLE_PATHS || '') {
  const requested = String(input || '').trim();
  if (!requested.startsWith('/') || requested.length > 1024) throw new Error('请输入 NAS 上的工作区绝对路径');
  const target = path.posix.resolve(requested);
  const roots = authorizedPaths(raw);
  if (!roots.some((root) => within(root, target))) throw new Error('此工作区不在 fnOS 已授权目录内，请先在应用中心授权');
  let realTarget;
  try { realTarget = fs.realpathSync(target); }
  catch (error) {
    if (['EACCES', 'EPERM'].includes(error.code)) throw new Error('应用无法进入此目录，请检查 fnOS 目录授权及上级目录权限');
    if (error.code === 'ENOENT') throw new Error('工作区目录不存在');
    throw error;
  }
  const realRoots = roots.map((root) => {
    try { return fs.realpathSync(root); } catch { return null; }
  }).filter(Boolean);
  if (!realRoots.some((root) => within(root, realTarget))) throw new Error('工作区链接指向 fnOS 授权范围之外');
  if (!fs.statSync(realTarget).isDirectory()) throw new Error('工作区路径不是目录');
  try { fs.opendirSync(realTarget).closeSync(); }
  catch (error) {
    if (['EACCES', 'EPERM'].includes(error.code)) throw new Error('应用没有读取此目录的权限');
    throw error;
  }
  let temporary;
  try { temporary = fs.mkdtempSync(path.join(realTarget, '.dsh-fnos-write-check-')); }
  catch (error) {
    if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw new Error('应用无法在此工作区创建临时目录。请授予读写权限，并检查目标子目录的 ACL');
    throw error;
  }
  fs.rmdirSync(temporary);
  return { path: target, writable: true };
}

function linkName(target) {
  const name = path.posix.basename(target).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 40) || 'root';
  return `${name}-${createHash('sha256').update(target).digest('hex').slice(0, 10)}`;
}

function syncShortcuts(dataDir, raw = process.env.TRIM_DATA_ACCESSIBLE_PATHS || '') {
  const root = ops.dataPath(dataDir, 'workspace', shortcutFolder);
  const trackedFile = ops.dataPath(dataDir, 'authorized-links.json');
  const grants = inspect(raw);
  if (!fs.lstatSync(root, { throwIfNoEntry: false })) fs.mkdirSync(root, { mode: 0o700 });
  if (!fs.lstatSync(root).isDirectory()) throw new Error('Authorized directory shortcut location is not a directory');
  const markerPath = path.join(root, marker);
  const markerInfo = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  if (!markerInfo) {
    if (fs.readdirSync(root).length) throw new Error('Authorized directory shortcut location is occupied');
    fs.writeFileSync(markerPath, 'Managed by DeepSeek Harness for fnOS\n', { mode: 0o600 });
  } else if (!markerInfo.isFile() || fs.readFileSync(markerPath, 'utf8') !== 'Managed by DeepSeek Harness for fnOS\n') throw new Error('Authorized directory shortcut marker is invalid');
  const tracked = ops.readJson(trackedFile, {});
  const wanted = Object.fromEntries(grants.filter((item) => item.directory && item.readable).map((item) => [linkName(item.path), item.path]));
  for (const [name, target] of Object.entries(tracked)) {
    if (wanted[name] === target) continue;
    const link = path.join(root, name);
    if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() && fs.readlinkSync(link) === target) fs.unlinkSync(link);
    delete tracked[name];
  }
  for (const [name, target] of Object.entries(wanted)) {
    const link = path.join(root, name);
    const current = fs.lstatSync(link, { throwIfNoEntry: false });
    if (current) {
      if (!current.isSymbolicLink() || fs.readlinkSync(link) !== target) continue;
    } else fs.symlinkSync(target, link, 'dir');
    tracked[name] = target;
  }
  ops.writeJson(trackedFile, tracked);
  return grants;
}

module.exports = { authorizedPaths, inspect, probeWorkspace, syncShortcuts, shortcutFolder };
