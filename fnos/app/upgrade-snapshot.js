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
    // 平台对升级钩子有超时（1.7G 数据全量复制约 8 分钟即触发"未知错误"弹窗，0.3.101 实机）。
    // 升级路径 core 已停、数据盘无人写：不可变大文件用硬链接（同一 /vol1/1000 文件系统，秒级），
    // 迁移脚本 --preserve-existing 不重写既有数据文件，硬链接不会污染备份。
    process.env.FNOS_UPGRADE_SNAPSHOT_FAST = '1';
    const snapshot = ops.createSnapshot(dataDir, configDir, 'pre-upgrade', ops.dshVersion(appDir));
    const directory = store.locate(dataDir, snapshot.id);
    if (path.dirname(directory) !== root) throw new Error('Upgrade backup escaped its operation');
    const meta = JSON.parse(fs.readFileSync(path.join(directory, 'meta.json'), 'utf8'));
    if (meta.id !== snapshot.id || meta.consistency !== 'stopped-core') throw new Error('Independent upgrade backup verification failed');
    const mismatch = ops.snapshotFingerprint(directory, configDir) !== meta.fingerprint
      ? directory /* 快照自身不完整 */
      : ops.snapshotFingerprint(dataDir, configDir) !== meta.fingerprint ? dataDir /* 源盘在备份窗口内变化 */
      : null;
    if (mismatch) {
      // 给管理员可读的漂移清单：最近 90 秒内有写入的文件（限 20 条），直接定位是谁在升级窗口写数据。
      try {
        const since = new Date(Date.now() - 90_000);
        const changed = [];
        const walk = (p, depth) => {
          if (changed.length >= 20 || depth > 6) return;
          let entries; try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (changed.length >= 20) return;
            const child = path.join(p, e.name);
            let s; try { s = fs.lstatSync(child); } catch { continue; }
            if (e.isSymbolicLink()) continue;
            if (s.isDirectory()) walk(child, depth + 1);
            else if (s.mtime > since) changed.push(child + ' (' + s.mtime.toISOString() + ')');
          }
        };
        walk(mismatch, 0);
        console.error('升级备份校验失败：' + (mismatch === dataDir ? '数据目录' : '快照目录') + ' 在备份窗口内发生变化。最近写入的文件（最多 20 条）：');
        for (const line of changed) console.error('  ' + line);
        if (!changed.length) console.error('  （90 秒内未发现新写入，漂移可能来自文件删除或元数据变化）');
      } catch { /* 诊断尽力而为，不掩盖原始错误 */ }
      throw new Error('Independent upgrade backup verification failed');
    }
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
