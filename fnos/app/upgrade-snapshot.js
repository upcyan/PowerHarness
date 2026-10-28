'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ops = require('./ops.js');
const store = require('./backup-store.js');

function ordinaryDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error('Upgrade backup directory must be canonical and not linked');
}
function run(env = process.env) {
  const appDir = env.FNOS_APP_DIR, dataDir = env.FNOS_DATA_DIR, configDir = env.FNOS_CONFIG_DIR;
  if (!appDir || !dataDir) throw new Error('Missing fnOS application paths');
  const previous = process.env.FNOS_BACKUP_DIR;
  const primary = store.root(dataDir);
  fs.mkdirSync(primary, { recursive: true, mode: 0o700 });
  ordinaryDirectory(primary);
  const parent = path.join(primary, '.platform-upgrade-backups');
  fs.mkdirSync(parent, { mode: 0o711, recursive: true });
  ordinaryDirectory(parent);
  const operation = crypto.randomUUID();
  const root = path.join(parent, operation);
  fs.mkdirSync(root, { mode: 0o700 });
  ordinaryDirectory(root);
  try {
    // Scope retention to this newly created operation, never the user's store.
    process.env.FNOS_BACKUP_DIR = root;
    const snapshot = ops.createSnapshot(dataDir, configDir, 'pre-upgrade', ops.dshVersion(appDir));
    const directory = store.locate(dataDir, snapshot.id);
    if (path.dirname(directory) !== root) throw new Error('Upgrade backup escaped its operation');
    const meta = JSON.parse(fs.readFileSync(path.join(directory, 'meta.json'), 'utf8'));
    if (meta.id !== snapshot.id || meta.consistency !== 'stopped-core' ||
        ops.snapshotFingerprint(directory, configDir) !== meta.fingerprint ||
        ops.snapshotFingerprint(dataDir, configDir) !== meta.fingerprint) throw new Error('Independent upgrade backup verification failed');
    for (const item of meta.controlFiles || []) {
      if (path.basename(item.name) !== item.name) throw new Error('Unsafe upgrade control evidence name');
      const bytes = fs.readFileSync(path.join(directory, 'control-evidence', item.name));
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('Upgrade control evidence hash mismatch');
    }
    const receipt = { operation, id: snapshot.id, fingerprint: meta.fingerprint, consistency: meta.consistency, isolatedRetention: true };
    const fd = fs.openSync(path.join(root, 'receipt.json'), 'wx', 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(receipt)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    console.log('Pre-upgrade backup: ' + snapshot.id + ' (independent operation ' + operation + ')');
    return receipt;
  } finally {
    if (previous === undefined) delete process.env.FNOS_BACKUP_DIR; else process.env.FNOS_BACKUP_DIR = previous;
  }
}
if (require.main === module) run();
module.exports = { run };
