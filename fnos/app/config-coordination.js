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
// 'boot' is the supervisor's own startup lock: the sequence it guards is
// re-runnable by design (leftover cores are reaped, package/patch fixes are
// idempotent), so a boot lock whose owner is verifiably dead — same identity
// checks as snapshots — may be archived automatically. Interrupted restores
// and CLI/snapshot writes stay 'exclusive' and keep requiring manual recovery.
//
// 2026-11-11（实例A 实测）：上面的白名单让 **exclusive** 孤儿锁永远无法自动
// 恢复 —— supervisor 取 profile 锁后被 cmd/main 的 cleanup_failed_start
// SIGTERM，锁目录遗留、owner 已死，但每次启动 assertNoProfileLocks 都抛
// ERR_CONFIG_LOCKED ⇒ 永久安全模式（19:44 / 22:41 / 23:04 三次启动同样报错）。
//
// 因此新增 recoverOrphanLock：判据从「operation 是什么」改为「事务是否确认
// 完成」—— 只有同时满足下列全部条件才可自动归档：
//   · owner 的出生身份可确认已消失（bootId/startTime/PID namespace 三重比对，
//     EPERM 一律不算死）；进程死亡**只**用于确认持锁者不在，不代表事务完成
//   · phase === 'active' 且未置 recoveryBlocked（结果未知的保留现场）
//   · 锁目录内**只有** owner.json：出现 recovery.json 说明有中断的恢复认领，
//     出现任何其它文件说明事务留下了半截证据，二者都必须人工核对
//   · schemaVersion/token/身份字段格式合法（防旧格式与损坏文件被猜测回收）
// 归档用 rename 保留 owner.json 证据，不递归删除。人工恢复路径（结果未知、
// 锁内有额外文件、旧格式、跨 namespace）保持不变，仍然阻塞。
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
// 持锁者状态四分：gone（确认消失）/ alive（仍在跑，含 EPERM 这类"不确定"）/
// identity-missing（owner 没留下可核对的身份）/ namespace-mismatch（跨 PID 命名
// 空间，不能凭本机 /proc 判断）。只有 gone 允许回收，其余一律要人工核对。
function ownerVerdict(owner) {
  const identity = owner.processIdentity;
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !identity ||
      !/^[a-f0-9-]{36}$/i.test(identity.bootId || '') || !/^[0-9]+$/.test(identity.startTime || '')) return 'identity-missing';
  try { if (identity.pidNamespace !== fs.readlinkSync('/proc/self/ns/pid')) return 'namespace-mismatch'; } catch { return 'namespace-mismatch'; }
  // ★ 身份优先：出生身份对不上（bootId 不同 = 跨了一次开机；startTime 不同 =
  //   PID 已被复用）即确认持锁者消失，与 kill 是否返回 EPERM 无关。这条路径必须
  //   在 kill 之前，否则「PID 被别的用户进程复用 → EPERM → 立刻 return alive」
  //   会让 recoverSnapshotLock() 恒为 false，每次启动都 ERR_CONFIG_LOCKED
  //   （2026-11-17 实例A 实测：snapshot 锁被宿主重启打断后永久安全模式）。
  const current = processIdentity(owner.pid);
  if (!current || current.bootId !== identity.bootId || current.startTime !== identity.startTime) return 'gone';

  // 身份完全一致 → 确认是同一个进程，才用 kill 判断它是否还活着。
  try { process.kill(owner.pid, 0); return 'alive'; }
  catch (failure) { return failure.code === 'ESRCH' ? 'gone' : 'alive'; } // EPERM is unknown, not dead.
}
function ownerIsGone(owner) { return ownerVerdict(owner) === 'gone'; }
// 锁为何留在磁盘上 —— 只用于诊断文案，不参与回收判定（判定在 probeLock）。
const LOCK_REASONS = {
  'directory-unreadable': '目录无法解析（可能已不存在）',
  'lock-unreadable': '锁路径不可读或不是目录',
  'lock-symlink': '锁路径是符号链接',
  'non-linux': '当前平台无法核对持锁者身份',
  'owner-missing': '锁目录内没有 owner.json',
  'recovery-claimed': '锁内有中断的恢复认领（recovery.json），事务结果未知',
  'extra-evidence': '锁目录内除 owner.json 外还有额外文件',
  'owner-unreadable': 'owner.json 不是普通单链接文件或不可读',
  'owner-corrupt': 'owner.json 无法解析',
  'legacy-format': '旧格式 owner（无 schemaVersion 2）',
  'operation-mismatch': '锁属于另一种事务类型',
  'phase-unknown': '事务被标记为结果未知（phase 不是 active）',
  'recovery-blocked': '事务被标记为结果未确认（recoveryBlocked）',
  'token-invalid': 'owner token 格式非法',
  'identity-missing': 'owner 缺少可核对的出生身份',
  'namespace-mismatch': 'owner 来自其他 PID 命名空间',
  'owner-alive': '持锁进程仍在运行（或无法确认已退出）',
  'data-barrier-exclusive': '数据根级 exclusive 屏障：可能处在目录交换中途或 CLI 子树未关闭'
};
// 只读判定，绝不修改磁盘。恢复路径与只读清点共用它，避免两套判据漂移。
function probeLock(directory, operation) {
  const blocked = (reason, extra) => ({ state: 'blocked', reason, message: LOCK_REASONS[reason] || reason, directory, ...extra });
  let real;
  try { real = fs.realpathSync(directory); } catch { return blocked('directory-unreadable'); }
  const lock = path.join(real, LOCK);
  let original;
  try { original = fs.lstatSync(lock, { throwIfNoEntry: false }); } catch { return blocked('lock-unreadable', { real, lock }); }
  if (!original) return { state: 'absent', reason: null, message: '', directory, real, lock };
  if (!original.isDirectory()) return blocked('lock-unreadable', { real, lock });
  if (original.isSymbolicLink()) return blocked('lock-symlink', { real, lock });
  if (process.platform !== 'linux') return blocked('non-linux', { real, lock });
  let fd, anchored, claimText = null;
  try {
    // 锚定 inode 而不是路径名：竞争者被挂起期间路径可能被替换。
    fd = fs.openSync(lock, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    if (!sameInode(original, fs.fstatSync(fd))) return blocked('lock-unreadable', { real, lock });
    anchored = '/proc/self/fd/' + fd;
    const names = fs.readdirSync(anchored).sort();
    // 恰好 owner.json 才算「未归档的孤儿」。owner.json + recovery.json 是上一次
    // 归档在「写认领」与「rename」之间被打断的现场（2026-11-12）：认领者可确认
    // 消失、且认领与这把锁对得上时，事务状态与未归档的孤儿完全相同，可以连同
    // 认领一起归档留证；任何核对不上的情况继续 fail closed。
    const onlyOwner = names.length === 1 && names[0] === 'owner.json';
    const interrupted = names.length === 2 && names[0] === 'owner.json' && names[1] === 'recovery.json';
    if (!onlyOwner && !interrupted) {
      return blocked(names.includes('recovery.json') ? 'recovery-claimed' : names.includes('owner.json') ? 'extra-evidence' : 'owner-missing', { real, lock });
    }
    const ownerPath = path.join(anchored, 'owner.json');
    const ownerInfo = fs.lstatSync(ownerPath);
    if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.nlink !== 1 || ownerInfo.size > 8192) return blocked('owner-unreadable', { real, lock });
    const bytes = fs.readFileSync(ownerPath, 'utf8');
    let owner;
    try { owner = JSON.parse(bytes); } catch { return blocked('owner-corrupt', { real, lock }); }
    // operation === null ⇒ 不限操作类型（孤儿锁通用回收）；否则只回收指定类型。
    // 其余判据对所有类型一视同仁：phase 必须是 active（结果未知的保留现场）、
    // 不得置 recoveryBlocked、token 格式合法、且持锁者身份可确认已消失。
    if (owner.schemaVersion !== 2) return blocked('legacy-format', { real, lock });
    if (operation !== null && owner.operation !== operation) return blocked('operation-mismatch', { real, lock });
    if (owner.phase !== 'active') return blocked('phase-unknown', { real, lock });
    if (owner.recoveryBlocked) return blocked('recovery-blocked', { real, lock });
    if (!/^[a-f0-9]{32}$/.test(owner.token || '')) return blocked('token-invalid', { real, lock });
    const verdict = ownerVerdict(owner);
    if (verdict !== 'gone') return blocked(verdict === 'identity-missing' ? 'identity-missing' : verdict === 'namespace-mismatch' ? 'namespace-mismatch' : 'owner-alive', { real, lock });
    if (interrupted) {
      let claim;
      try { claimText = fs.readFileSync(path.join(anchored, 'recovery.json'), 'utf8'); claim = JSON.parse(claimText); }
      catch { return blocked('recovery-claimed', { real, lock }); }
      // 认领必须指向同一次事务（同一个 token）、同一个动作，且认领者可确认消失。
      // 旧认领没有 processIdentity —— 无法核对，按 unknown 处理，交人工。
      if (claim.operation !== 'archive-orphan-' + owner.operation || claim.token !== owner.token || ownerVerdict(claim) !== 'gone') {
        return blocked('recovery-claimed', { real, lock });
      }
    }
    return { state: 'recoverable', reason: null, message: '', directory, real, lock, original, bytes, owner, claimText };
  } catch { return blocked('lock-unreadable', { real, lock }); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 已关闭 */ } } }
}
function sameInode(a, b) { return !!a && !!b && a.dev === b.dev && a.ino === b.ino; }
function recoverSnapshotLock(directory, mutate) { return recoverDeadOwnerLock(directory, mutate, 'snapshot'); }
function recoverBootLock(directory, mutate) { return recoverDeadOwnerLock(directory, mutate, 'boot'); }
// operation === null 表示「不限操作类型」：只要事务本身确认完成且持锁者确实
// 已死即可归档（见文件头 2026-11-11 说明）。其余判据与 snapshot/boot 完全一致。
function recoverOrphanLock(directory, mutate) { return recoverDeadOwnerLock(directory, mutate, null); }
function recoverDeadOwnerLock(directory, mutate, operation) {
  const probe = probeLock(directory, operation);
  if (probe.state !== 'recoverable') return false;
  if (!mutate) return true; // Admission/preflight is deliberately read-only.
  const real = probe.real, lock = probe.lock, original = probe.original, bytes = probe.bytes, owner = probe.owner;
  let directoryFd, claimFd, claimInfo, anchored, moved = false, claimOwned = false;
  try {
    // Anchor all work to this inode, not a lock pathname that another process
    // could replace while a contender is suspended.
    directoryFd = fs.openSync(lock, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    if (!sameInode(original, fs.fstatSync(directoryFd))) return false;
    anchored = '/proc/self/fd/' + directoryFd;
    // 判据已在 probeLock 里复核过一次；这里再做一次现场一致性检查（锁目录形态
    // 与 owner.json 字节），防止读判据与归档之间被换掉。
    const ownerPath = path.join(anchored, 'owner.json');
    const claimPath = path.join(anchored, 'recovery.json');
    const names = fs.readdirSync(anchored).sort();
    // 上一次归档在「写认领」与「rename」之间被打断时，锁目录停在
    // owner.json + recovery.json，probeLock 已核对过认领与这把锁对得上、
    // 认领者也已确认消失 —— 与未归档的孤儿事务状态完全相同，直接连同认领
    // 一起归档留证，不再重写认领（重写会 EEXIST 并永久卡住）。
    const interrupted = names.length === 2 && names[0] === 'owner.json' && names[1] === 'recovery.json' && typeof probe.claimText === 'string';
    if (!interrupted && (names.length !== 1 || names[0] !== 'owner.json')) return false;
    if (fs.readFileSync(ownerPath, 'utf8') !== bytes) return false;
    if (interrupted) {
      if (fs.readFileSync(claimPath, 'utf8') !== probe.claimText) return false;
      claimInfo = fs.lstatSync(claimPath);
    } else {
      claimFd = fs.openSync(claimPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      claimInfo = fs.fstatSync(claimFd);
      claimOwned = true;
      fs.writeFileSync(claimFd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), operation: 'archive-orphan-' + owner.operation, token: owner.token }));
      fs.fsyncSync(claimFd);
    }
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
      // 只清理本次写的认领；上一次归档遗留的认领是证据，失败时原样保留。
      if (!moved && claimOwned && claimInfo && anchored) {
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
    // 数据根级屏障只认语义明确的 snapshot/boot。数据根的 exclusive 事务可能
    // 处在「两目录交换中途」或「CLI 子树未确认关闭」，持锁进程已死**不代表**事务
    // 完成 —— 保持原有的人工恢复要求，不自动回收（2026-11-11 回归确认）。
    if (recoverSnapshotLock(root, true) || recoverBootLock(root, true)) return;
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
    // 窄判据优先（snapshot/boot），再退到通用孤儿回收（2026-11-11：profile 级
    // exclusive 孤儿锁曾导致实例A 每次启动都进安全模式）。
    // **仅 profile 级**可用通用孤儿回收：profile 内的事务边界由文件修订号校验
    // 兜底，孤儿锁可安全重试；数据根级 exclusive 可能处在目录交换中途或 CLI
    // 子树未确认关闭，必须保持人工恢复。
    const recovered = recoverSnapshotLock(real, true) || recoverBootLock(real, true)
      || (logicalRoot ? recoverOrphanLock(real, true) : false);
    if (!recovered) {
      throw error('ERR_CONFIG_LOCKED', '配置锁已存在：活锁、旧格式或事务结果不明均需保留；不得只凭PID已死删锁', { lock });
    }
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
      operation: !logicalRoot && ['snapshot', 'boot'].includes(options.operation) ? options.operation : 'exclusive', processIdentity: processIdentity(process.pid) }), { flag: 'wx', mode: 0o600 });
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
// options.mutate === false 时只判定、不归档：用于「读别人的备份快照」这种
// 只读语义的调用点，避免把写操作藏在只读名字后面（ops.restoreSnapshot 曾如此）。
function assertNoProfileLocks(home, options = {}) {
  const mutate = options.mutate !== false;
  const profiles = path.join(home, 'profiles');
  if (fs.existsSync(profiles)) for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
    const directory = path.join(profiles, entry.name);
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory());
    if (!isDirectory || !fs.lstatSync(path.join(directory, LOCK), { throwIfNoEntry: false })) continue;
    // 2026-11-11：这里曾是无条件拒绝 —— 孤儿 exclusive 锁（持锁者已死、事务
    // 确认完成）会让每次启动都进安全模式，永久无法自愈。现在先只读判定：
    // 确属可回收孤儿锁才归档放行；活锁／结果未知／锁内有额外证据的现场
    // 仍然保留并拒绝，交人工核对。
    if (recoverOrphanLock(directory, mutate)) continue;
    const probe = probeLock(directory, null);
    // 消息必须能定位到具体锁目录与原因：只写「结果未知」时操作者无处下手。
    throw error('ERR_CONFIG_LOCKED', `配置锁未解除：${probe.message}（${path.join(directory, LOCK)}）。活锁、旧格式、锁内有额外证据或结果未确认的现场必须人工核对，不要直接删除`, { lock: probe.lock || path.join(directory, LOCK), reason: probe.reason, profile: entry.name });
  }
}
// 只读清点：数据根级屏障 + 每个配置档的锁，逐条给出能否自动回收与阻塞原因。
// 不创建、不改名、不删除任何文件 —— 管理页的「只读检查」和诊断包都用它。
function inspectLocks(dataDir) {
  const locks = [];
  const root = path.join(dataDir, LOCK);
  if (fs.lstatSync(root, { throwIfNoEntry: false })) {
    // 数据根级只认 snapshot/boot：exclusive 可能处在目录交换中途或 CLI 子树
    // 未确认关闭，进程死亡不构成事务完成证据（保持人工恢复）。
    const recoverable = recoverSnapshotLock(dataDir, false) || recoverBootLock(dataDir, false);
    const probe = probeLock(dataDir, null);
    const reason = recoverable ? null : probe.state === 'absent' ? 'lock-unreadable' : probe.state === 'recoverable' ? 'data-barrier-exclusive' : probe.reason;
    locks.push({ scope: 'data', profile: null, path: probe.lock || root, recoverable, reason, manualOnly: !recoverable,
      message: recoverable ? '数据快照/启动事务已结束，启动时自动归档' : LOCK_REASONS[reason] || reason });
  }
  const profiles = path.join(dataDir, 'dsh-home', 'profiles');
  if (fs.existsSync(profiles)) for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
    const directory = path.join(profiles, entry.name);
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory());
    if (!isDirectory || !fs.lstatSync(path.join(directory, LOCK), { throwIfNoEntry: false })) continue;
    const probe = probeLock(directory, null);
    const recoverable = probe.state === 'recoverable';
    const reason = recoverable ? null : probe.state === 'absent' ? 'lock-unreadable' : probe.reason;
    locks.push({ scope: 'profile', profile: entry.name, path: probe.lock || path.join(directory, LOCK), recoverable, reason, manualOnly: !recoverable,
      message: recoverable ? '孤儿锁（持锁者已确认消失、事务已完成），下次启动或写入时自动归档' : LOCK_REASONS[reason] || reason });
  }
  return { locks, readOnly: true, sampledAt: new Date().toISOString() };
}
function withDataLock(dataDir, callback, options = {}) {
  return withLock(dataDir, () => { assertNoProfileLocks(path.join(dataDir, 'dsh-home'), { mutate: options.mutate }); return callback(); }, options);
}
function assertCanStart(dataDir) {
  // 数据根级屏障：只认 snapshot/boot（exclusive 保持人工恢复）。
  if (fs.lstatSync(path.join(dataDir, LOCK), { throwIfNoEntry: false }) &&
      !recoverSnapshotLock(dataDir, false) && !recoverBootLock(dataDir, false)) {
    throw error('ERR_CONFIG_LOCKED', '数据事务持有屏障或结果未知，拒绝启动核心');
  }
  // profile 级：孤儿锁可自动归档（2026-11-11）。
  assertNoProfileLocks(path.join(dataDir, 'dsh-home'));
}
function isUnconfirmed(failure) {
  return failure?.closed === false || ['ERR_CONFIG_UNKNOWN', 'ERR_ENABLEMENT_UNKNOWN', 'ERR_CLI_UNCONFIRMED'].includes(failure?.code);
}
function snapshotFilter(source) { return path.basename(source) !== LOCK || dataDirectoryForProfile(path.dirname(source)) === null; }
module.exports = { withLock, withFileLock, withDataLock, assertNoProfileLocks, assertCanStart, isUnconfirmed, snapshotFilter, snapshot, revision, assertRevision, retain, inspectLocks, LOCK_REASONS };
