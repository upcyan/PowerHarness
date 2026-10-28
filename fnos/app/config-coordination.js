'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const LOCK = '.powerharness-config.lock';
function error(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }
// Only a snapshot copies live data without publishing changes back into it.
// Generic 'active' locks may instead represent a half-restored home/profile or
// an unconfirmed CLI subtree; death of their supervisor is NOT commit evidence.
function processIdentity(pid) {
  try {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    if (stat.slice(0, stat.indexOf(' ')) !== String(pid)) return null;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!/^[a-f0-9-]{36}$/i.test(bootId) || !/^[0-9]+$/.test(fields[19] || '')) return null;
    const pidNamespace = fs.readlinkSync('/proc/self/ns/pid');
    return { bootId, startTime: fields[19], pidNamespace };
  } catch { return null; }
}
function ownerIsGone(owner) {
  const identity = owner.processIdentity;
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !identity ||
      !/^[a-f0-9-]{36}$/i.test(identity.bootId || '') || !/^[0-9]+$/.test(identity.startTime || '')) return false;
  try { if (identity.pidNamespace !== fs.readlinkSync('/proc/self/ns/pid')) return false; } catch { return false; }
  try { process.kill(owner.pid, 0); }
  catch (failure) { return failure.code === 'ESRCH'; } // EPERM is unknown, not dead.
  const current = processIdentity(owner.pid);
  return !!current && (current.bootId !== identity.bootId || current.startTime !== identity.startTime);
}
function sameInode(a, b) { return !!a && !!b && a.dev === b.dev && a.ino === b.ino; }
function recoverSnapshotLock(directory, mutate) {
  const real = fs.realpathSync(directory), lock = path.join(real, LOCK);
  let directoryFd, claimFd, claimInfo, anchored, moved = false;
  try {
    const original = fs.lstatSync(lock);
    if (process.platform !== 'linux' || !original.isDirectory() || original.isSymbolicLink()) return false;
    // Anchor all work to this inode, not a lock pathname that another process
    // could replace while a contender is suspended.
    directoryFd = fs.openSync(lock, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    if (!sameInode(original, fs.fstatSync(directoryFd))) return false;
    anchored = '/proc/self/fd/' + directoryFd;
    const names = fs.readdirSync(anchored);
    if (names.length !== 1 || names[0] !== 'owner.json') return false;
    const ownerPath = path.join(anchored, 'owner.json');
    const ownerInfo = fs.lstatSync(ownerPath);
    if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.nlink !== 1 || ownerInfo.size > 8192) return false;
    const bytes = fs.readFileSync(ownerPath, 'utf8'), owner = JSON.parse(bytes);
    if (owner.schemaVersion !== 2 || owner.operation !== 'snapshot' || owner.phase !== 'active' || owner.recoveryBlocked ||
        !/^[a-f0-9]{32}$/.test(owner.token || '') || !ownerIsGone(owner)) return false;
    if (!mutate) return true; // Admission/preflight is deliberately read-only.
    claimFd = fs.openSync(path.join(anchored, 'recovery.json'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    claimInfo = fs.fstatSync(claimFd);
    fs.writeFileSync(claimFd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), operation: 'archive-orphan-snapshot', token: owner.token }));
    fs.fsyncSync(claimFd);
    const current = fs.lstatSync(lock, { throwIfNoEntry: false });
    if (!sameInode(current, original) || fs.readFileSync(ownerPath, 'utf8') !== bytes || !ownerIsGone(owner) ||
        fs.readdirSync(anchored).sort().join(',') !== 'owner.json,recovery.json') return false;
    const archive = path.join(real, '.powerharness-config.recovered-' + Date.now() + '-' + randomBytes(8).toString('hex'));
    if (path.dirname(archive) !== real || fs.existsSync(archive)) return false;
    fs.renameSync(lock, archive); moved = true; // Preserve owner and claim, never recursively remove evidence.
    const parentFd = fs.openSync(real, 'r');
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    return true;
  } catch { return false; }
  finally {
    try {
      if (!moved && claimInfo && anchored) {
        const claim = path.join(anchored, 'recovery.json');
        if (sameInode(fs.lstatSync(claim, { throwIfNoEntry: false }), claimInfo)) fs.unlinkSync(claim);
      }
    } finally {
      try { if (claimFd !== undefined) fs.closeSync(claimFd); }
      finally { if (directoryFd !== undefined) fs.closeSync(directoryFd); }
    }
  }
}
function snapshot(file) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw error('ERR_CONFIG_CONFLICT', '配置不是普通文件，拒绝覆盖');
    return fs.readFileSync(file, 'utf8');
  } catch (failure) { if (failure.code === 'ENOENT') return null; throw failure; }
}
function revision(text) { return text === null ? 'missing' : createHash('sha256').update(text).digest('hex'); }
function assertRevision(file, expected) {
  if (expected !== undefined && revision(snapshot(file)) !== expected) {
    throw error('ERR_CONFIG_CONFLICT', '配置已被其他写入者修改，拒绝覆盖；请重新读取后再操作');
  }
}
function profileDirectory(file) {
  const absolute = path.resolve(file), directory = path.dirname(absolute);
  if (!['package.json', 'cordis.patch.yml'].includes(path.basename(absolute))) return null;
  if (path.basename(path.dirname(directory)) !== 'profiles') return null;
  if (path.basename(path.dirname(path.dirname(directory))) !== 'dsh-home') throw error('ERR_CONFIG_CONFLICT', '配置文件路径没有可确认的数据根，请使用规范配置档入口');
  return directory;
}
function verify(lease) {
  try {
    const info = fs.lstatSync(lease.lock);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== lease.dev || info.ino !== lease.ino) throw error('ERR_CONFIG_UNKNOWN', '配置锁身份变化，拒绝继续写入');
    const owner = JSON.parse(fs.readFileSync(lease.owner, 'utf8'));
    if (owner.token !== lease.token) throw error('ERR_CONFIG_UNKNOWN', '配置锁所有权变化，拒绝继续写入');
  } catch (cause) {
    if (cause.code === 'ERR_CONFIG_UNKNOWN') throw cause;
    throw error('ERR_CONFIG_UNKNOWN', '配置锁身份或所有权无法确认，拒绝继续写入', { cause });
  }
}
function retain(directory, details = {}) {
  const real = fs.realpathSync(directory), lease = context.getStore()?.get(real);
  if (!lease) throw error('ERR_CONFIG_UNKNOWN', '没有本事务配置锁，不能确认回滚所有权');
  verify(lease); lease.retained = true;
  const previous = JSON.parse(fs.readFileSync(lease.owner, 'utf8'));
  fs.writeFileSync(lease.owner, JSON.stringify({ ...previous, pid: process.pid, token: lease.token, phase: 'unknown', ...details, recoveryBlocked: true }), { mode: 0o600 });
}
function dataDirectoryForProfile(directory) {
  if (path.basename(path.dirname(directory)) !== 'profiles' || path.basename(path.dirname(path.dirname(directory))) !== 'dsh-home') return null;
  return path.dirname(path.dirname(path.dirname(directory)));
}
function assertDataBarrier(directory, boundRoot) {
  const root = boundRoot || dataDirectoryForProfile(directory);
  if (!root || !fs.lstatSync(path.join(root, LOCK), { throwIfNoEntry: false })) return;
  const own = context.getStore()?.get(root);
  if (!own || own.finished || own.retained) {
    if (recoverSnapshotLock(root, true)) return;
    throw error('ERR_CONFIG_LOCKED', '数据快照或恢复持有配置屏障，拒绝并发写入');
  }
  verify(own);
}
function withLock(directory, callback, options = {}) {
  const logical = path.resolve(directory), logicalRoot = dataDirectoryForProfile(logical);
  if (path.basename(path.dirname(logical)) === 'profiles' && !logicalRoot) throw error('ERR_CONFIG_CONFLICT', '配置目录缺少可绑定的数据根，拒绝绕过快照屏障');
  const boundRoot = logicalRoot ? fs.realpathSync(logicalRoot) : null;
  const real = fs.realpathSync(directory), inherited = context.getStore(), existing = inherited?.get(real);
  assertDataBarrier(real, boundRoot);
  if (existing?.retained) throw error('ERR_CONFIG_UNKNOWN', '配置事务结果未知，拒绝继续写入');
  if (existing && !existing.finished) { verify(existing); return callback(); }
  const lock = path.join(real, LOCK), token = randomBytes(16).toString('hex');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (failure) {
    if (failure.code !== 'EEXIST') throw failure;
    if (!recoverSnapshotLock(real, true)) throw error('ERR_CONFIG_LOCKED', '配置锁已存在：活锁、旧格式或事务结果不明均需保留；不得只凭PID已死删锁', { lock });
    // A different writer may win after the archive. Retry acquisition only once.
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (cause) { throw error('ERR_CONFIG_LOCKED', '孤儿备份锁已归档，但另一写入者已取得配置锁', { cause, lock }); }
  }
  const owner = path.join(lock, 'owner.json');
  let info;
  // If initialization fails, leave this directory quarantined rather than
  // deleting a lock whose ownership file was not successfully established.
  try {
    fs.chmodSync(lock, 0o700);
    info = fs.lstatSync(lock);
    fs.writeFileSync(owner, JSON.stringify({ schemaVersion: 2, pid: process.pid, token, phase: 'active',
      operation: options.operation === 'snapshot' && !logicalRoot ? 'snapshot' : 'exclusive', processIdentity: processIdentity(process.pid) }), { flag: 'wx', mode: 0o600 });
    fs.chmodSync(owner, 0o600);
    const ownerFd = fs.openSync(owner, 'r');
    try { fs.fsyncSync(ownerFd); } finally { fs.closeSync(ownerFd); }
    const lockFd = fs.openSync(lock, 'r');
    try { fs.fsyncSync(lockFd); } finally { fs.closeSync(lockFd); }
  } catch (cause) { throw error('ERR_CONFIG_UNKNOWN', '配置锁初始化未确认；已保留目录，未执行配置操作', { cause, lock }); }
  const lease = { lock, owner, token, dev: info.dev, ino: info.ino, retained: false };
  const store = new Map([...(inherited || [])].filter(([, entry]) => !entry.finished || entry.retained)); store.set(real, lease);
  function release() {
    if (lease.retained) return;
    verify(lease);
    if (path.resolve(owner) !== owner || path.dirname(owner) !== lock || path.dirname(lock) !== real || path.basename(lock) !== LOCK) throw error('ERR_CONFIG_UNKNOWN', '配置锁清理路径不匹配');
    fs.unlinkSync(owner);
    fs.rmdirSync(lock); // Non-recursive: never deletes another writer's evidence.
    lease.finished = true;
  }
  function failed(failure) {
    if (isUnconfirmed(failure)) {
      try { context.run(store, () => retain(real, { errorCode: failure.code })); } catch (retentionError) { lease.retained = true; failure.retentionError = retentionError; }
    }
    try { release(); } catch (cleanupError) { throw error('ERR_CONFIG_UNKNOWN', '配置锁释放未确认，保留现场', { cause: failure, cleanupError, lock }); }
    throw failure;
  }
  let result;
  try { result = context.run(store, () => { assertDataBarrier(real, boundRoot); return callback(); }); } catch (failure) { return failed(failure); }
  function completed(value) {
    try { release(); } catch (cause) { lease.retained = true; throw error('ERR_CONFIG_UNKNOWN', '配置已提交但锁释放未确认；保留现场，拒绝继续写入或启动', { cause, lock }); }
    return value;
  }
  if (result && typeof result.then === 'function') return Promise.resolve(result).then(completed, failed);
  return completed(result);
}
function withFileLock(file, callback) { const directory = profileDirectory(file); return directory ? withLock(directory, () => callback(true)) : callback(false); }
function assertNoProfileLocks(home) {
  const profiles = path.join(home, 'profiles');
  if (fs.existsSync(profiles)) for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
    const directory = path.join(profiles, entry.name);
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory());
    if (isDirectory && fs.lstatSync(path.join(directory, LOCK), { throwIfNoEntry: false })) {
      throw error('ERR_CONFIG_LOCKED', '配置仍在写入或事务结果未知，拒绝备份/恢复以免复制锁或半截配置');
    }
  }
}
function withDataLock(dataDir, callback, options = {}) {
  return withLock(dataDir, () => { assertNoProfileLocks(path.join(dataDir, 'dsh-home')); return callback(); }, options);
}
function assertCanStart(dataDir) {
  if (fs.lstatSync(path.join(dataDir, LOCK), { throwIfNoEntry: false }) && !recoverSnapshotLock(dataDir, false)) throw error('ERR_CONFIG_LOCKED', '数据事务持有屏障或结果未知，拒绝启动核心');
  assertNoProfileLocks(path.join(dataDir, 'dsh-home'));
}
function isUnconfirmed(failure) {
  return failure?.closed === false || ['ERR_CONFIG_UNKNOWN', 'ERR_ENABLEMENT_UNKNOWN', 'ERR_CLI_UNCONFIRMED'].includes(failure?.code);
}
function snapshotFilter(source) { return path.basename(source) !== LOCK || dataDirectoryForProfile(path.dirname(source)) === null; }
module.exports = { withLock, withFileLock, withDataLock, assertNoProfileLocks, assertCanStart, isUnconfirmed, snapshotFilter, snapshot, revision, assertRevision, retain };
