'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ops = require('./ops.js');
const store = require('./backup-store.js');

/** 升级备份保留份数（2026-11-25）：此前无上限，实测累积 15 份 / 34GB。 */
const UPGRADE_BACKUP_KEEP = 5;

/**
 * 回收过期的平台升级备份，只保留最近 keep 份。
 *
 * 只删「名字像 operation（UUID）且带 receipt.json」的目录 —— receipt 是本次
 * 备份确实写完并通过指纹校验的证据。任何不符合的条目原样保留：宁可留一份
 * 垃圾，也不删掉一次仍在进行或形态不明的备份。
 * @param {string} parent - .platform-upgrade-backups 目录。
 * @param {number} keep - 保留份数。
 */
function pruneUpgradeBackups(parent, keep) {
  let entries;
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { return; }
  const candidates = entries
    .filter(e => e.isDirectory() && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(e.name))
    .map(e => e.name)
    .filter(name => fs.existsSync(path.join(parent, name, 'receipt.json')))
    // 排序键必须取 receipt 里的快照 id（形如 2026-11-17T06-49-34-456Z-b85b51e8，
    // 前缀是 ISO 时间戳）。目录名本身是随机 UUID，字典序与时间毫无关系 ——
    // 2026-11-25 实测：按目录名排序会保留到 10 月的旧备份、删掉最新的，
    // 方向完全相反。
    // 读不出 id 的目录排最后（视为最旧），只在还不够 keep 时保留，
    // 不会因信息缺失被误删成「最新」。
    .map(name => {
      let key = '';
      try { key = String(JSON.parse(fs.readFileSync(path.join(parent, name, 'receipt.json'), 'utf8')).id || ''); }
      catch { key = ''; }
      return { name, key };
    })
    .sort((a, b) => (a.key === b.key ? a.name.localeCompare(b.name) : a.key.localeCompare(b.key)))
    .reverse()
    .map(entry => entry.name);
  for (const name of candidates.slice(keep)) {
    const target = path.join(parent, name);
    // 再确认一次仍是普通目录且不是软链，避免删到被替换过的路径。
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
    fs.rmSync(target, { recursive: true, force: true });
    console.log('Pruned expired upgrade backup: ' + name);
  }
}

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
    // ── 升级备份回收（2026-11-25）────────────────────────────────────────────
    // 这里曾经完全没有清理：每次升级新建一个 operation 目录，永不回收。实测
    // 2026-11-25 累积 15 份 / 34GB。保留最近 UPGRADE_BACKUP_KEEP 份，更早的删掉。
    //
    // 只动 .platform-upgrade-backups 之下的 operation 目录，且只认带 receipt.json
    // 的完整操作 —— 列表本身来自 mkdir 成功的目录，但 receipt 是「本工具确实
    // 写完并校验过」的唯一证据。缺 receipt 的目录保留不删（可能是正在进行的
    // 另一次升级，或早于本版本、形态不明的遗留）。
    //
    // 顺序按目录名（含 ISO 时间戳前缀）倒序即最新在前；不用 mtime，因为复制
    // 过程会刷新子项时间。
    try { pruneUpgradeBackups(parent, UPGRADE_BACKUP_KEEP); }
    catch (error) { console.error('升级备份回收失败（不影响本次备份）：' + error.message); }
    return receipt;
  } finally {
    if (previous === undefined) delete process.env.FNOS_BACKUP_DIR; else process.env.FNOS_BACKUP_DIR = previous;
  }
}
if (require.main === module) run();
module.exports = { run };
