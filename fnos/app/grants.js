const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ops = require('./ops.js');

const shortcutFolder = 'fnOS 授权目录';
const marker = '.dsh-fnos-shortcuts';
const stateFileName = 'grant-state.json';
const markerText = 'Managed by DeepSeek Harness for fnOS\n';

// ── fnOS 授权快照的三层判据（2026-11-18 事故后重写）────────────────────────
// fnOS 只在**启动应用进程时**把授权目录写进 TRIM_DATA_ACCESSIBLE_PATHS，进程存活
// 期间不会刷新。事故现场：用户在应用中心补授权 → 授权落地（ACL 已生效、目录已可
// 读写）但环境变量还是启动那一刻的旧值（空）→ 旧实现把「快照为空」当成「授权被
// 撤销」→ 主动 unlink 掉三个快捷入口、把 authorized-links.json 写成 {}，管理页
// 随即显示「当前未收到 fnOS 授权目录」。全过程没有任何日志，靠模式猜测才能发现。
//
// 所以本模块不再把环境变量当唯一真相，判据分三层：
//   1) env 快照        —— 平台下发过什么（可能过期，present=false 表示没下发）
//   2) 真实读写探测    —— 现在能不能读写（ACL 是真正的边界）
//   3) 已建链接+状态文件 —— 历史证据（上次同步到底建了什么）
// 快照缺失时**只读历史、绝不删除**：宁可留一个已经失效的入口（访问会 EACCES，
// ACL 仍然拦着），也不要抹掉用户可用的入口。
const envKey = 'TRIM_DATA_ACCESSIBLE_PATHS';

function within(root, target) { return root === '/' || target === root || target.startsWith(`${root}/`); }

function authorizedPaths(raw = process.env.TRIM_DATA_ACCESSIBLE_PATHS || '') {
  return [...new Set(String(raw).split(':').map((value) => value.trim()).filter((value) => value.startsWith('/')).map((value) => path.posix.resolve(value)))];
}

/**
 * 平台下发的授权快照。
 * present=false 有三种可能，且**无法在进程内区分**：从未授权、授权晚于本次启动、
 * 平台这一次没注入。三者都不构成「删除已有入口」的理由。
 */
function snapshot(raw = process.env.TRIM_DATA_ACCESSIBLE_PATHS || '', options = {}) {
  const text = String(raw ?? '');
  const paths = authorizedPaths(text);
  return { present: paths.length > 0, paths, raw: text, readAt: new Date().toISOString(), startedAt: options.startedAt || null };
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

/**
 * 工作区写入探测。
 * 快照里有授权列表时，仍要求目标落在授权根内（保持原有边界）。
 * 快照为空时不再一律拒绝 —— 那正是「授权已生效但进程没看到」的误报来源 ——
 * 改为只认真实结果，并用 snapshotTrusted:false 让调用方把结论说清楚。
 */
function probeWorkspace(input, raw = process.env.TRIM_DATA_ACCESSIBLE_PATHS || '') {
  const requested = String(input || '').trim();
  if (!requested.startsWith('/') || requested.length > 1024) throw new Error('请输入 NAS 上的工作区绝对路径');
  const target = path.posix.resolve(requested);
  const roots = authorizedPaths(raw);
  const snapshotTrusted = roots.length > 0;
  if (snapshotTrusted && !roots.some((root) => within(root, target))) throw new Error('此工作区不在 fnOS 已授权目录内，请先在应用中心授权');
  let realTarget;
  try { realTarget = fs.realpathSync(target); }
  catch (error) {
    if (['EACCES', 'EPERM'].includes(error.code)) throw new Error('应用无法进入此目录，请检查 fnOS 目录授权及上级目录权限');
    if (error.code === 'ENOENT') throw new Error('工作区目录不存在');
    throw error;
  }
  if (snapshotTrusted) {
    const realRoots = roots.map((root) => {
      try { return fs.realpathSync(root); } catch { return null; }
    }).filter(Boolean);
    if (!realRoots.some((root) => within(root, realTarget))) throw new Error('工作区链接指向 fnOS 授权范围之外');
  }
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
  return { path: target, writable: true, snapshotTrusted };
}

function linkName(target) {
  const name = path.posix.basename(target).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 40) || 'root';
  return `${name}-${createHash('sha256').update(target).digest('hex').slice(0, 10)}`;
}

function rootDir(dataDir) { return ops.dataPath(dataDir, 'workspace', shortcutFolder); }
function trackedPath(dataDir) { return ops.dataPath(dataDir, 'authorized-links.json'); }
function statePath(dataDir) { return ops.dataPath(dataDir, stateFileName); }

function readLinkTarget(link) {
  try {
    const info = fs.lstatSync(link, { throwIfNoEntry: false });
    if (!info || !info.isSymbolicLink()) return null;
    return fs.readlinkSync(link);
  } catch { return null; }
}

/** 工作区里的快捷入口实况（含目标的元数据变更时间，用来和进程启动时刻做对比）。 */
function listLinks(root) {
  let names;
  try { names = fs.readdirSync(root); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter((name) => name !== marker).map((name) => {
    const link = path.join(root, name);
    const entry = { name, target: readLinkTarget(link), symbolic: false, present: false, readable: false, changedAt: null };
    const info = fs.lstatSync(link, { throwIfNoEntry: false });
    if (!info) return entry;
    entry.symbolic = info.isSymbolicLink();
    if (!entry.target) return entry;
    try {
      const stat = fs.statSync(entry.target);
      entry.present = true;
      entry.changedAt = new Date(stat.ctimeMs).toISOString();
      try { fs.accessSync(entry.target, fs.constants.R_OK); entry.readable = true; } catch {}
    } catch {}
    return entry;
  });
}

/**
 * 同步工作区快捷入口。
 * 快照可信（present）→ 按快照增删（原行为）。
 * 快照为空 → 保留全部仍存在的入口，只清理已消失的脏记录，绝不 unlink。
 * 两种情形都写 grant-state.json，让管理页与日志能说明「为什么现在是这样」。
 */
function syncShortcuts(dataDir, raw = process.env.TRIM_DATA_ACCESSIBLE_PATHS || '', options = {}) {
  const snap = snapshot(raw, options);
  const root = rootDir(dataDir);
  const trackedFile = trackedPath(dataDir);
  if (!fs.lstatSync(root, { throwIfNoEntry: false })) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(root).isDirectory()) throw new Error('Authorized directory shortcut location is not a directory');
  const markerPath = path.join(root, marker);
  const markerInfo = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  if (!markerInfo) {
    if (fs.readdirSync(root).length) throw new Error('Authorized directory shortcut location is occupied');
    fs.writeFileSync(markerPath, markerText, { mode: 0o600 });
  } else if (!markerInfo.isFile() || fs.readFileSync(markerPath, 'utf8') !== markerText) throw new Error('Authorized directory shortcut marker is invalid');
  const grants = inspect(raw);
  const tracked = ops.readJson(trackedFile, {});
  const wanted = Object.fromEntries(grants.filter((item) => item.directory && item.readable).map((item) => [linkName(item.path), item.path]));
  const removed = [];
  const kept = [];
  if (snap.present) {
    for (const [name, target] of Object.entries(tracked)) {
      if (wanted[name] === target) continue;
      const link = path.join(root, name);
      if (readLinkTarget(link) === target) {
        try { fs.unlinkSync(link); removed.push(target); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      delete tracked[name];
    }
    for (const [name, target] of Object.entries(wanted)) {
      const link = path.join(root, name);
      const current = fs.lstatSync(link, { throwIfNoEntry: false });
      if (current) { if (readLinkTarget(link) !== target) continue; }
      else fs.symlinkSync(target, link, 'dir');
      tracked[name] = target;
    }
    ops.writeJson(trackedFile, tracked);
  } else {
    let dirty = false;
    for (const [name, target] of Object.entries(tracked)) {
      if (readLinkTarget(path.join(root, name)) === target) kept.push(target);
      else { delete tracked[name]; dirty = true; }
    }
    if (dirty) ops.writeJson(trackedFile, tracked);
  }
  const links = listLinks(root);
  const state = { schema: 1, checkedAt: new Date().toISOString(), snapshot: snap, grants, links, removed, kept };
  try { ops.writeJson(statePath(dataDir), state); } catch { /* 状态文件只是证据，写不了不阻断启动 */ }
  return { snapshot: snap, grants, links, removed, kept, state };
}

/** 管理页用的完整视图：快照 + 真实探测 + 已有入口 + 上次同步记录。 */
function status(dataDir, raw = process.env.TRIM_DATA_ACCESSIBLE_PATHS || '') {
  const snap = snapshot(raw);
  const links = listLinks(rootDir(dataDir));
  let saved = null;
  try { saved = ops.readJson(statePath(dataDir), null); } catch { saved = null; }
  const startedAt = (saved && saved.snapshot && saved.snapshot.startedAt) || snap.startedAt || null;
  // 入口的目标目录在「本进程启动之后」才被改过权限/内容 ⇒ 极可能就是新授权落地的时刻，
  // 而 env 不会因此刷新。用这个对比把「需要重启整个应用」变成可验证的结论，而不是猜。
  const lateGrants = startedAt ? links.filter((item) => item.changedAt && item.changedAt > startedAt) : [];
  return {
    snapshot: snap,
    startedAt,
    grants: inspect(raw),
    links,
    saved,
    needsRestart: !snap.present && links.length > 0,
    lateGrants: lateGrants.length,
    // 入口还在、目标却访问不到：可能是共享目录临时不可用，也可能是真的删了。
    // 空快照期间一律保留（临时不可用不该被当成撤销），等下一次拿到授权列表再清理。
    dangling: links.filter((item) => item.target && !item.present).length,
    root: rootDir(dataDir),
  };
}

module.exports = { authorizedPaths, snapshot, inspect, probeWorkspace, syncShortcuts, status, listLinks, shortcutFolder, envKey, stateFileName };
