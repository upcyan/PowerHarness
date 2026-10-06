'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const defaults = Object.freeze({ keep: 8, totalBytes: 64 * 1024 * 1024, fileBytes: 512 * 1024 });
const archiveName = /^archive-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[A-Za-z0-9-]{1,57}$/;
const memberName = /^(?:dsh\.log(?:\.(?:[1-9]|10))?|meta\.json)$/;
function inventory(root, dir) {
  if (path.dirname(dir) !== root || !archiveName.test(path.basename(dir))) throw new Error('Archive path not owned');
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || fs.realpathSync(dir) !== dir) throw new Error('Archive directory not regular');
  const files = fs.readdirSync(dir);
  let bytes = 0;
  for (const name of files) {
    if (!memberName.test(name)) throw new Error('Unknown archive member; preserve directory');
    const target = path.join(dir, name), info = fs.lstatSync(target);
    if (!info.isFile()) throw new Error('Non-regular archive member; preserve directory');
    bytes += name === 'meta.json' ? Math.max(info.size, 32768) : info.size;
  }
  return { dir, files, bytes, time: stat.mtimeMs };
}
function prune(root, current, limits) {
  const rows = [], warnings = [], removed = [];
  for (const name of fs.readdirSync(root)) {
    if (!archiveName.test(name)) continue;
    try { rows.push(inventory(root, path.join(root, name))); }
    catch { warnings.push({ directory: name, reason: 'unverified archive preserved' }); }
  }
  rows.sort((a, b) => a.dir === current ? -1 : b.dir === current ? 1 : b.time - a.time || b.dir.localeCompare(a.dir));
  let bytes = rows.reduce((n, r) => n + r.bytes, 0), count = rows.length;
  for (const row of rows.slice(1).reverse()) {
    if (count <= limits.keep && bytes <= limits.totalBytes) break;
    try {
      const checked = inventory(root, row.dir); // Validate the entire set before deleting anything.
      for (const name of checked.files) {
        const target = path.join(checked.dir, name);
        if (path.dirname(target) !== checked.dir || !memberName.test(path.basename(target))) throw new Error('Unsafe archive cleanup');
        fs.unlinkSync(target);
      }
      fs.rmdirSync(checked.dir);
      bytes -= row.bytes; count--; removed.push(path.basename(row.dir));
    } catch { warnings.push({ directory: path.basename(row.dir), reason: 'archive cleanup incomplete' }); }
  }
  return { managedArchives: count, managedBytes: bytes, removed, warnings, withinBudget: !warnings.length && count <= limits.keep && bytes <= limits.totalBytes };
}
function readExact(fd, buffer, position) {
  let used = 0;
  while (used < buffer.length) { const n = fs.readSync(fd, buffer, used, buffer.length - used, position + used); if (!n) throw new Error('Log changed during archive read'); used += n; }
}
function boundedCopy(source, target, limit) {
  let fd;
  try {
    fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Log source not regular');
    let output, segments;
    if (stat.size <= limit) {
      output = Buffer.alloc(stat.size); readExact(fd, output, 0); segments = [{ offset: 0, bytes: output.length }];
    } else {
      const marker = Buffer.from('\n[archive truncated: preserved beginning and latest output]\n');
      const first = Math.min(64 * 1024, Math.floor((limit - marker.length) / 8));
      const last = limit - marker.length - first;
      const head = Buffer.alloc(first), tail = Buffer.alloc(last);
      readExact(fd, head, 0); readExact(fd, tail, stat.size - last);
      output = Buffer.concat([head, marker, tail]); segments = [{ offset: 0, bytes: first }, { offset: stat.size - last, bytes: last }];
    }
    fs.writeFileSync(target, output, { flag: 'wx', mode: 0o600 }); fs.chmodSync(target, 0o600);
    return { sourceBytes: stat.size, archivedBytes: output.length, truncated: stat.size > limit, segments };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function archiveLogs(dataDir, reason, extra, { limits = defaults, redact = String } = {}) {
  for (const key of ['keep', 'totalBytes', 'fileBytes']) if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) throw new Error('Invalid archive limits');
  if (limits.fileBytes < 4096 || limits.totalBytes < 11 * limits.fileBytes + 32768) throw new Error('Archive budget cannot retain one complete bounded archive');
  const data = fs.realpathSync(dataDir), root = path.join(data, 'startup-reports');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) throw new Error('Archive root is a symlink or outside data directory');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = String(reason || 'failure').replace(/[^A-Za-z0-9-]/g, '-').slice(0, 40) || 'failure';
  const dir = path.join(root, `archive-${stamp}-${tag}-${randomBytes(8).toString('hex')}`);
  fs.mkdirSync(dir, { mode: 0o700 }); fs.chmodSync(dir, 0o700);
  const copied = [], files = {}, sourceWarnings = [];
  for (let i = 0; i <= 10; i++) {
    const name = 'dsh.log' + (i ? '.' + i : '');
    try { files[name] = boundedCopy(path.join(data, name), path.join(dir, name), limits.fileBytes); copied.push(name); }
    catch (error) { if (error.code !== 'ENOENT') sourceWarnings.push({ file: name, code: error.code || 'INVALID_LOG' }); }
  }
  let serialized;
  try {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) serialized = JSON.stringify({ extraUnavailable: true });
    else serialized = JSON.stringify(extra);
  } catch { serialized = JSON.stringify({ extraUnavailable: true }); }
  let details;
  try { if (Buffer.byteLength(serialized) > 8192) throw new Error('Large metadata'); details = JSON.parse(redact(serialized)); }
  catch { details = { extraTruncated: true, extraSample: Buffer.from(redact(serialized.slice(0, 8192))).subarray(0, 4096).toString('utf8') }; }
  const meta = { ...details, reason: redact(String(reason || 'failure')).slice(0, 500), at: new Date().toISOString(), copied, files, limits: {keep:limits.keep,totalBytes:limits.totalBytes,fileBytes:limits.fileBytes}, sourceWarnings };
  const metaFile = path.join(dir, 'meta.json');
  fs.writeFileSync(metaFile, JSON.stringify(meta), { flag: 'wx', mode: 0o600 }); fs.chmodSync(metaFile, 0o600);
  const retention = prune(root, dir, limits);
  // Reserve 32KiB of per-archive budget for metadata, including cleanup evidence.
  meta.retention = { ...retention, removed: retention.removed.slice(0, 32), warnings: retention.warnings.slice(0, 32), removedCount: retention.removed.length, warningCount: retention.warnings.length };
  let finalMeta = JSON.stringify(meta);
  if (Buffer.byteLength(finalMeta) > 32768) { meta.retention.removed = []; meta.retention.warnings = []; meta.metadataTruncated = true; finalMeta = JSON.stringify(meta); }
  if (Buffer.byteLength(finalMeta) > 32768) throw new Error('Archive metadata exceeds reserved budget');
  fs.writeFileSync(metaFile, finalMeta, { mode: 0o600 });
  return { dir, copied, truncatedFiles: Object.values(files).filter(f => f.truncated).length, retention };
}
module.exports = { archiveLogs, defaults };
