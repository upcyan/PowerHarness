'use strict';
const fs = require('node:fs');
const path = require('node:path');
const PRODUCTION_DATA = '/vol1/@appdata/dsh-fnos';
const PROTECTED_ROOT = '/vol1/1000/DSH-Recovery/dsh-fnos';
function root(dataDir) {
  const data = fs.realpathSync(dataDir);
  const configured = process.env.FNOS_BACKUP_DIR;
  const isProduction = data === PRODUCTION_DATA || (path.basename(data) === 'dsh-fnos' && data.split(path.sep).includes('@appdata'));
  if (!configured && !isProduction) return path.join(data, 'backups');
  const target = configured || PROTECTED_ROOT;
  if (!path.isAbsolute(target)) throw new Error('FNOS_BACKUP_DIR must be absolute');
  const resolved = path.resolve(target);
  if (resolved === data || resolved.startsWith(data + path.sep) || data.startsWith(resolved + path.sep)
      || ['/tmp', '/run', '/opt', '/var/apps'].some(base => resolved === base || resolved.startsWith(base + path.sep))
      || resolved.split(path.sep).some(part => part.startsWith('@app'))) {
    throw new Error('Backup storage must be isolated from application and temporary directories');
  }
  // Reject symlink ancestors, including a redirected user-data folder.
  for (let current = resolved; current !== path.dirname(current); current = path.dirname(current)) {
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Backup storage contains a non-directory or symlink');
  }
  return resolved;
}
function roots(dataDir) { return [...new Set([root(dataDir), path.join(fs.realpathSync(dataDir), 'backups')])]; }
function locate(dataDir, id) {
  for (const base of roots(dataDir)) {
    const candidate = path.join(base, id);
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (stat?.isDirectory() && !stat.isSymbolicLink()) return candidate;
  }
  throw new Error('Backup not found');
}
module.exports = { root, roots, locate, PROTECTED_ROOT };
