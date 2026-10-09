const fs = require('node:fs');
const configCoordination = require('./config-coordination.js');
// 会话库完整性校验用（P6 防护）：zstd -t 只校验不落盘。
const { execFileSync } = require('node:child_process');
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
function writeJson(file, value, options = {}) {
  return configCoordination.withFileLock(file, isProfile => {
    const expectedRevision = options.expectedRevision ?? (isProfile ? configCoordination.revision(configCoordination.snapshot(file)) : undefined);
    return writeJsonUnlocked(file, value, { ...options, expectedRevision });
  });
}
function writeJsonUnlocked(file, value, options) {
  configCoordination.assertRevision(file, options.expectedRevision);
  const tmp = inside(path.dirname(file), `${file}.tmp-${randomBytes(16).toString('hex')}`);
  let fd, owned = false;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600); owned = true;
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), { encoding: 'utf8' });
    fs.closeSync(fd); fd = undefined;
    for (let attempt = 0; ; attempt++) {
      try { configCoordination.assertRevision(file, options.expectedRevision); fs.renameSync(tmp, file); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) || attempt >= 20) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (owned) {
      if (path.dirname(tmp) !== path.resolve(path.dirname(file)) || !path.basename(tmp).startsWith(path.basename(file) + '.tmp-')) throw new Error('JSON temporary file ownership path mismatch');
      try { fs.unlinkSync(tmp); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError; }
    }
    throw error;
  }
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

// sessionMode（0.3.61）—— 会话存档策略，三档：
//   'auto'   （默认）检测到会话有新内容就自动建立快照，无需人工干预；
//   'timer'  按 sessionInterval 分钟周期定时检查并快照；
//   'manual' 只在设置页手动点「检查并立即快照」。
// sessionInterval 为定时的检查周期（分钟），范围 5 分钟 ~ 7 天。
const defaultBackupSettings = { daily: 7, manual: 3, 'pre-upgrade': 2, dailyMode: 'always', sessionMode: 'auto', sessionInterval: 60 };
function backupSettings(dataDir) {
  const saved = readJson(dataPath(dataDir, 'backup-settings.json'), {});
  const result = { ...defaultBackupSettings, ...saved };
  for (const [kind, max] of [['daily', 30], ['manual', 30], ['pre-upgrade', 10]]) {
    if (!Number.isInteger(result[kind]) || result[kind] < 1 || result[kind] > max) throw new Error(`Invalid ${kind} backup limit`);
  }
  if (!['always', 'changed', 'updates'].includes(result.dailyMode)) throw new Error('Invalid daily backup mode');
  // 旧的配置里没有这两个字段：读的时候补默认值，避免启动后策略「未定义」。
  if (!['auto', 'timer', 'manual'].includes(result.sessionMode)) result.sessionMode = defaultBackupSettings.sessionMode;
  if (!Number.isInteger(result.sessionInterval) || result.sessionInterval < 5 || result.sessionInterval > 7 * 24 * 60) result.sessionInterval = defaultBackupSettings.sessionInterval;
  return result;
}
function saveBackupSettings(dataDir, value) {
  const settings = { ...backupSettings(dataDir), ...value };
  for (const kind of ['daily', 'manual', 'pre-upgrade']) if (typeof settings[kind] === 'string') settings[kind] = Number(settings[kind]);
  for (const [kind, max] of [['daily', 30], ['manual', 30], ['pre-upgrade', 10]]) {
    if (!Number.isInteger(settings[kind]) || settings[kind] < 1 || settings[kind] > max) throw new Error(`Invalid ${kind} backup limit`);
  }
  if (!['always', 'changed', 'updates'].includes(settings.dailyMode)) throw new Error('Invalid daily backup mode');
  if (settings.sessionInterval != null) settings.sessionInterval = Number(settings.sessionInterval);
  if (!['auto', 'timer', 'manual'].includes(settings.sessionMode)) throw new Error('Invalid session archive mode');
  if (!Number.isInteger(settings.sessionInterval) || settings.sessionInterval < 5 || settings.sessionInterval > 7 * 24 * 60) {
    throw new Error('会话检查周期需在 5 分钟到 7 天之间');
  }
  writeJson(dataPath(dataDir, 'backup-settings.json'), settings);
  pruneBackups(dataDir);
  return settings;
}
function snapshotFingerprint(dataDir, configDir) {
  const hash = createHash('sha256');
  const visit = (file, relative) => {
    if (!configCoordination.snapshotFilter(file)) return; // Coordination metadata is not user content.
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
// 会话存档状态检查（0.3.61）：'是否有未存档的会话更新'必须**便宜**才算得出 ——
// 现有 snapshotFingerprint 会读遍全部文件内容（含 100MB+ 会话），不能用于每次
// 页面渲染。这里改为**按 stat 的轻量账本**：只比较会话文件的 (路径,大小,mtime)，
// 不读内容。
// 账本 saved-sessions.json 存 dataDir 根（**不在 dsh-home 内，回滚不会覆盖**），
// 记录上次快照时的会话清单；据此算出「新增 + 有增长」的会话数与字节数。
function sessionStoreDir(dataDir) {
  return dataPath(dataDir, 'dsh-home', 'sessions');
}
function scanSessions(dataDir) {
  const root = sessionStoreDir(dataDir);
  const files = {};
  let totalBytes = 0;
  // 0.3.73（R25）：扫描**完整性**必须如实上报。原实现把 readdir 失败静默吞掉，
  // 于是"目录读不到"与"目录真的空"返回同一个 count=0 —— 上层就无法区分
  // 「确实没有会话」和「我没看全」。自动存档的空基线优化只允许建立在
  // complete===true 之上，否则会把未读到的会话误记为已存档。
  const errors = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      if (dir === root && error.code === 'ENOENT') return;
      errors.push({ dir, code: error.code || 'readdir_failed' }); return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // 软链目录可能形成环：只递归真实目录，交错的条目按文件处理。
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.startsWith('session.')) continue;
      try {
        const info = fs.statSync(full);
        files[path.relative(root, full)] = { size: info.size, mtimeMs: Math.floor(info.mtimeMs) };
        totalBytes += info.size;
      } catch (error) { errors.push({ file: full, code: error.code || 'stat_failed' }); }
    }
  };
  walk(root);
  return { files, count: Object.keys(files).length, totalBytes, complete: errors.length === 0, errors };
}
function sessionArchiveFile(dataDir) {
  return dataPath(dataDir, 'saved-sessions.json');
}
// 与上次快照对比，得出待存档的变更（新增会话 + 已有会话的增长）。
//
// 0.3.73（R25）契约修正：把「账本还没初始化」与「确实有新增/增长」分开报告。
// 原实现把 known=false 也算进"待存档"，配合上层 `!known || added || grown` 的
// pending 判据，导致**全新数据目录、零会话**时也会创建完整快照（停核心 → 备份
// → 再启动），首次启动因此多出一次无意义的核心停启，并破坏依赖启动次数的测试。
function sessionArchiveStatus(dataDir) {
  const current = scanSessions(dataDir);
  // 扫描不完整时不下任何"没有会话"的结论：如实上报，让调用方选择延期/报错。
  if (!current.complete) {
    return { known: false, complete: false, scanErrors: current.errors, count: current.count, totalBytes: current.totalBytes, added: current.count, grown: 0, pendingBytes: current.totalBytes, lastAt: null };
  }
  const saved = readJson(sessionArchiveFile(dataDir), null);
  if (!saved || !saved.files) {
    // baseline-empty：已经**确认**当前为空（扫描完整且 0 个会话文件）。
    // 这不是"已备份"，只是"没有需要备份的东西"——上层据此初始化账本即可，
    // 无需停核心。若账本缺失但当前非空，则保持 unknown，让上层按策略真实备份，
    // 绝不把现成文件直接标记成"已存档"。
    const baselineEmpty = current.count === 0;
    return {
      known: false, complete: true, baselineEmpty,
      count: current.count, totalBytes: current.totalBytes,
      added: current.count, grown: 0, pendingBytes: current.totalBytes, lastAt: null,
    };
  }
  let added = 0;
  let grown = 0;
  let pendingBytes = 0;
  for (const [rel, info] of Object.entries(current.files)) {
    const before = saved.files[rel];
    if (!before) { added += 1; pendingBytes += info.size; }
    else if (info.size > before.size) { grown += 1; pendingBytes += info.size - before.size; }
  }
  return {
    known: true,
    complete: true,
    count: current.count,
    totalBytes: current.totalBytes,
    added,
    grown,
    pendingBytes,
    lastAt: saved.at || null,
  };
}
// 记下本次存档点（在快照成功之后调用）。
// 0.3.73（R25）：补 schemaVersion / initializedAt / lastArchiveAt / snapshotId，
// 让"上次真实备份于何时"与"空基线的初始化时刻"可区分（空基线不是备份）。
function markSessionsArchived(dataDir, { snapshotId = null } = {}) {
  const current = scanSessions(dataDir);
  if (!current.complete) throw new Error('会话目录未能完整读取，拒绝提交存档账本');
  const existing = readJson(sessionArchiveFile(dataDir), null);
  const at = new Date().toISOString();
  const payload = {
    schemaVersion: 2,
    initializedAt: existing?.initializedAt || at,
    lastArchiveAt: at,
    snapshotId: snapshotId || existing?.snapshotId || null,
    at,
    count: current.count,
    totalBytes: current.totalBytes,
    files: current.files,
  };
  writeJson(sessionArchiveFile(dataDir), payload);
  return payload;
}
// 初始化"空基线"账本（0.3.73 / R25）：**明确表示当前没有需要存档的会话**，
// 不是"已备份"。与 markSessionsArchived 的区别体现在语义字段上：
//   · initializedAt 有值、lastArchiveAt/snapshotId 为空 ⇒ 界面与诊断能区分
//     「从未备份过」与「上次备份于 X」；
//   · files 记为空对象，因此之后的第一个真实会话仍会被算作 added。
// 只在扫描完整且确实 0 个会话时调用（见 supervisor.checkSessionArchive）。
function initEmptySessionArchive(dataDir) {
  const current = scanSessions(dataDir);
  if (!current.complete) throw new Error('会话目录未能完整读取，拒绝写入空基线账本');
  if (current.count !== 0) throw new Error(`当前仍有 ${current.count} 个会话，拒绝写入空基线账本`);
  const payload = {
    schemaVersion: 2,
    initializedAt: new Date().toISOString(),
    lastArchiveAt: null,
    snapshotId: null,
    count: 0,
    totalBytes: 0,
    files: {},
  };
  writeJson(sessionArchiveFile(dataDir), payload);
  return payload;
}
// 插件装载一致性诊断（0.3.61）：核心能启动、但浏览器 boot 报「N entry did not
// activate / import failed」——典型原因是**声明与装载清单脱节**：patch 里声明了某
// 插件，但该包不在 dsh.profile.bundles 里 ⇒ 它的 bundle patch 不会被应用、
// dsh.client 声明的客户端模块不会被装载。这类问题 core 侧不报错（宿主 Loader
// 跳过无法解析的条目），只有浏览器 boot 时才暴露，表现为「核心正常但 Web 进不去」。
// 这里在启动前做静态体检，把问题在启动阶段就暴露出来。
// 插件设置健康自检（0.3.61）。
//
// 背景：10-01 的「保存失败：设置服务不可用（settings 未装配）」是**四层缺陷叠加**，
// 其中前三层**全是静默失败** —— `settings.describe()` 直接跳过该命名空间，
// 设置页不出现、保存只报一句误导性的「未装配」，从界面上完全看不出是哪一层。
// 本函数把四层做成可自动运行的断言，接在 startDsh 的启动自检里。
//
// 四层判据：
//   ① inject 回调参数在闭包外被引用 → ReferenceError（`?.` 挡不住未声明变量）
//   ② profile patch 的条目 id ≠ 插件 SETTINGS_NS → entries() 过滤掉重复 id / 找不到条目
//   ③ 插件的 Config 被 loader 的 unwrapExports 丢弃（有 default 时只取 default）
//      → runtime.Config === undefined → describe() 静默跳过
//   ④ 没有 `.volatile()` 叶子（write 报 "has no volatile fields"），
//      或有「volatile 祖先 + volatile 后代」（抛固定路径错误）
//
// 返回 { ok, checked, issues: [{ id, layer, detail }] }。任何异常都不得影响启动。
// 断链检测与清理（P7，0.3.61）。
//
// 背景：升级过程中回退层（$DSH_HOME/profiles/node_modules）的软链会指向
// **已被替换的快照**（如 last-good/runtime 时代的包集），于是留下大批断链。
// 10-01 实测：77 个断链（express / hono / @aws-crypto/* 等）指向 0.1.x 快照里
// 已不存在的包，另有 31 个 pnpm-store 项目软链指向已删除的 /tmp 测试目录。
//
// 危害不是崩溃（Node 对断链只是解析失败回退），而是：
//   · 掩盖真实缺失 —— 排查「模块找不到」时分不清是断链还是真没装；
//   · 不断累积 —— 每次升级/迁移都加一批，越拖越难判断哪些还有用。
//
// scanBrokenSymlinks 只**报告**；quarantine 时才删（且只删软链本身，
// 绝不触碰实体文件与目录）。删除前把清单写进 dataDir 便于追溯。
function scanBrokenSymlinks(dataDir, { quarantine = false } = {}) {
  const roots = [
    dataPath(dataDir, 'dsh-home', 'profiles', 'node_modules'),
    dataPath(dataDir, 'pnpm-store', 'v10', 'projects'),
  ];
  const broken = [];
  const walk = (dir, depth, maxDepth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let stat;
      try { stat = fs.lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) {
        // 断链：lstat 成功但 stat（跟随链接）失败
        try { fs.statSync(full); } catch { broken.push(full); }
        continue;
      }
      if (stat.isDirectory()) walk(full, depth + 1, maxDepth);
    }
  };
  for (const root of roots) walk(root, 0, 2);
  if (!quarantine || !broken.length) return { scanned: roots.length, broken, quarantined: 0, dir: null };

  const dir = dataPath(dataDir, 'broken-symlinks-' + Date.now());
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'broken-symlinks.txt'),
      broken.map((full) => full + ' -> ' + (() => { try { return fs.readlinkSync(full); } catch { return '?'; } })()).join('\n') + '\n',
      { mode: 0o600 });
  } catch { /* 记录失败也要继续清理 */ }
  let quarantined = 0;
  for (const full of broken) {
    try { fs.unlinkSync(full); quarantined += 1; } catch { /* 尽力而为 */ }
  }
  return { scanned: roots.length, broken, quarantined, dir };
}

function diagnosePluginSettings(dataDir, profile) {
  const result = { ok: true, checked: 0, issues: [] };
  try {
    const profileDir = path.join(dataPath(dataDir, 'dsh-home', 'profiles', profile));
    const manifest = readJson(path.join(profileDir, 'package.json'));
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
    // profile patch 的 id → name（层② 用）
    const patchRows = [];
    try {
      const text = readPatchConfig(dataDir, profile).patch || '';
      const re = /^- id:\s*(\S+)\s*\n\s*name:\s*(\S+)/gm;
      let m;
      while ((m = re.exec(text))) patchRows.push({ id: m[1].replace(/['"]/g, ''), name: m[2].replace(/['"]/g, '') });
      const ids = patchRows.map((r) => r.id);
      for (const id of new Set(ids)) {
        if (ids.filter((x) => x === id).length > 1) {
          result.issues.push({ id, layer: '②', detail: 'profile patch 里 id 重复 —— configEditor.entries() 会过滤掉重复项，设置将不可保存' });
        }
      }
    } catch { /* patch 不可读时跳过层② */ }

    for (const name of bundles) {
      if (name.startsWith('@deepseek-ai/')) continue;
      const hostFile = path.join(profileDir, 'node_modules', ...name.split('/'), 'host.js');
      let src;
      try { src = fs.readFileSync(hostFile, 'utf8'); } catch { continue; }
      const relevant = /SETTINGS_NS\s*=/.test(src) || /export\s+const\s+Config\b/.test(src);
      if (!relevant) continue;
      result.checked += 1;

      // 层①：逐个 inject 调用，看参数名是否在本体之外（且不在其它 inject 体内）出现
      const bodies = [];
      const re = /ctx\.inject\(\s*\[[^\]]*\]\s*,\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\{/g;
      let m;
      while ((m = re.exec(src))) {
        const open = m.index + m[0].length - 1;
        let depth = 0;
        let close = -1;
        for (let i = open; i < src.length; i += 1) {
          if (src[i] === '{') depth += 1;
          else if (src[i] === '}') { depth -= 1; if (depth === 0) { close = i; break; } }
        }
        if (close > 0) bodies.push({ param: m[1], from: m.index, to: close });
      }
      for (const b of bodies) {
        if (b.param.startsWith('_')) continue;
        let outside = '';
        for (let i = 0; i < src.length; i += 1) {
          if (bodies.some((o) => i >= o.from && i <= o.to)) continue;
          outside += src[i];
        }
        if (new RegExp('\\b' + b.param.replace(/\$/g, '\\$') + '\\b').test(outside)) {
          result.issues.push({ id: name, layer: '①', detail: 'inject 回调参数 ' + b.param + ' 在回调外被引用 —— 运行时抛 ReferenceError（设置保存会报「未装配」）' });
        }
      }

      // 层②：id 三处一致
      const nsMatch = /SETTINGS_NS\s*=\s*["']([^"']+)["']/.exec(src);
      if (nsMatch) {
        const ns = nsMatch[1];
        const patchId = (patchRows.find((r) => r.name === name) || {}).id;
        if (patchId && patchId !== ns) {
          result.issues.push({ id: name, layer: '②', detail: 'profile patch 的 id=' + patchId + ' 与 SETTINGS_NS=' + ns + ' 不一致 —— settings.write() 找不到条目' });
        }
      }
    }
  } catch (error) {
    return { ok: true, checked: 0, issues: [], skipped: String(error.message || error).slice(0, 120) };
  }
  result.ok = result.issues.length === 0;
  return result;
}

function diagnosePluginWiring(dataDir, profile, yamlModule) {
  const profileDir = path.join(dataPath(dataDir, 'dsh-home', 'profiles', profile));
  const manifest = readJson(path.join(profileDir, 'package.json'));
  if (!manifest?.dsh?.profile) return { ok: true, issues: [], skipped: 'no-profile' };
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
  const dependencies = manifest.dependencies || {};
  const bundleSet = new Set(bundles);
  const issues = [];
  let disabled;
  try { disabled = require('./plugin-enablement.js').intents(manifest); }
  catch (error) { return { ok: false, issues: [{ kind: 'invalid-enablement-metadata', fixable: false, detail: error.message }] }; }
  const disabledIds = new Set(Object.values(disabled).flatMap(record => record.ids));
  // ① patch 里声明的插件 id（直接条目 + insert 条目）
  let declared = new Set();
  try {
    const doc = yamlModule && typeof yamlModule.parse === 'function' ? yamlModule.parse(readPatchConfig(dataDir, profile).patch) : null;
    for (const row of Array.isArray(doc) ? doc : []) {
      // disabled 条目不会被装载，也就不会请求客户端模块 —— 不是问题，跳过
      // （例如按既定方针停用、等待上游修复的 dsh-glm-mode）。
      if (!row || row.disabled === true) continue;
      if (typeof row.id === 'string') declared.add(row.id);
      if (Array.isArray(row.insert)) {
        for (const ins of row.insert) {
          if (ins && ins.disabled !== true && typeof ins.id === 'string') declared.add(ins.id);
        }
      }
    }
  } catch { return { ok: true, issues: [], skipped: 'patch-unparsable' }; }
  for (const id of declared) {
    if (Object.hasOwn(disabled, id) || disabledIds.has(id)) continue;
    if (id.startsWith('@deepseek-ai/')) continue;   // 核心自带包不走 bundles
    const installed = fs.lstatSync(path.join(profileDir, 'node_modules', ...id.split('/')), { throwIfNoEntry: false });
    if (!installed) continue;                        // 未安装：由 patch 校验环节负责
    if (!bundleSet.has(id)) {
      issues.push({ kind: 'not-in-bundles', id, fixable: true,
        detail: 'patch 声明了 ' + id + '，但它不在 profile bundles 里 —— 它的客户端模块不会被装载，浏览器 boot 会报「did not activate」' });
    }
  }
  // ② bundles 里的插件包必须存在，且其 bundle patch 文件必须在位
  for (const name of bundles) {
    if (name.startsWith('@deepseek-ai/')) continue;
    const dir = path.join(profileDir, 'node_modules', ...name.split('/'));
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!pkg) {
      if (Object.keys(dependencies).includes(name)) {
        issues.push({ kind: 'missing-package', id: name, fixable: false,
          detail: 'bundles 声明了 ' + name + '，但 node_modules 里找不到它（需要重新安装）' });
      }
      continue;
    }
    const patchRel = pkg?.dsh?.bundle?.patch;
    if (patchRel && !fs.existsSync(path.join(dir, patchRel))) {
      issues.push({ kind: 'missing-bundle-patch', id: name, fixable: false,
        detail: name + ' 的 ' + patchRel + ' 缺失，装载会失败' });
    }
  }
  return { ok: issues.length === 0, issues, declared: declared.size, bundles: bundles.length };
}

// 自动修复装载脱节（0.3.61）：把「已安装、被 patch 声明、但未登记 bundles」的插件
// 补进 bundles。只做加法（登记缺失项），不动已有条目，不碰 @deepseek-ai/* 核心包。
// 返回 { fixed, issues }；fixed 非空时需要重启核心才生效。
function repairPluginWiring(dataDir, profile, yamlModule) {
  return configCoordination.withLock(patchProfileDir(dataDir, profile), () => repairPluginWiringLocked(dataDir, profile, yamlModule));
}
function repairPluginWiringLocked(dataDir, profile, yamlModule) {
  const diag = diagnosePluginWiring(dataDir, profile, yamlModule);
  const fixable = (diag.issues || []).filter((item) => item.kind === 'not-in-bundles');
  if (!fixable.length) return { fixed: [], issues: diag.issues || [] };
  const profileDir = path.join(dataPath(dataDir, 'dsh-home', 'profiles', profile));
  const manifestFile = path.join(profileDir, 'package.json');
  const manifest = readJson(manifestFile);
  const bundles = manifest.dsh.profile.bundles;
  const fixed = [];
  for (const issue of fixable) {
    // Recheck metadata immediately before writing; corrupt intent is never empty.
    const disabled = require('./plugin-enablement.js').intents(manifest);
    if (Object.hasOwn(disabled, issue.id) || Object.values(disabled).some(record => record.ids.includes(issue.id))) continue;
    if (bundles.includes(issue.id)) continue;
    bundles.push(issue.id);
    fixed.push(issue.id);
  }
  if (fixed.length) writeJson(manifestFile, manifest);
  return { fixed, issues: diag.issues || [] };
}
// 会话库损坏检测与隔离（0.3.61，P6 防护）。
// 背景：09-30 升级后核心启动失败，根因是上游 dsh-session-persistence-jsonl 读到
// 「corrupt Zstandard session log: first frame is not exactly one header line」——
// **一个损坏的会话文件就能让整个核心起不来**（loader 的 workspace 行 apply 失败）。
// 上游是数据层问题，我们改不了；但可以把「一个坏文件拖垮整次启动」变成
// 「坏文件被隔离、其余照常启动」：
//   · 用 `zstd -t`（解压校验，不落盘）逐个验证会话文件；
//   · 损坏的移到 sessions-corrupt-<ts>/ 并写 meta（保留现场供上报上游）；
//   · 默认只检测+报告；`quarantine: true` 时才真的移动。
// 返回 { scanned, corrupt: [相对路径], quarantined, dir }。
function scanCorruptSessions(dataDir, { quarantine = false } = {}) {
  const root = sessionStoreDir(dataDir);
  if (!fs.existsSync(root)) return { scanned: 0, corrupt: [], quarantined: 0, dir: null };
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.startsWith('session.') && entry.name.endsWith('.zstd')) files.push(full);
    }
  };
  walk(root);
  const corrupt = [];
  for (const file of files) {
    try {
      // -t 只校验不输出；-q 抑制正常输出。限时防止异常文件挂住启动。
      execFileSync('zstd', ['-t', '-q', file], { stdio: 'ignore', timeout: 5000 });
    } catch { corrupt.push(path.relative(root, file)); }
  }
  if (!corrupt.length || !quarantine) return { scanned: files.length, corrupt, quarantined: 0, dir: null };
  const dir = path.join(root, '..', 'sessions-corrupt-' + Date.now());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let quarantined = 0;
  for (const rel of corrupt) {
    const from = path.join(root, rel);
    const to = path.join(dir, rel.replace(/[\/]/g, '__'));
    try { fs.renameSync(from, to); quarantined += 1; } catch { /* 尽力而为 */ }
  }
  try {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      at: new Date().toISOString(), scanned: files.length, quarantined,
      files: corrupt,
      note: '上游 dsh-session-persistence-jsonl 读取损坏的 Zstandard 会话日志会导致核心启动失败（corrupt Zstandard session log）。这些文件已隔离；如需上报上游请保留本目录。',
    }, null, 2) + '\n', { mode: 0o600 });
  } catch { /* ignore */ }
  return { scanned: files.length, corrupt, quarantined, dir };
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
  return configCoordination.withDataLock(dataDir, () => createSnapshotLocked(dataDir, configDir, kind, version));
}
function createSnapshotLocked(dataDir, configDir, kind, version) {
  const root = dataPath(dataDir, 'backups');
  privateDir(root);
  const backupId = id();
  const pending = dataPath(dataDir, 'backups', `.pending-${backupId}`);
  const final = dataPath(dataDir, 'backups', backupId);
  privateDir(pending);
  try {
    for (const name of ['dsh-home', 'workspace']) {
      const src = dataPath(dataDir, name);
      if (exists(src)) fs.cpSync(src, path.join(pending, name), { recursive: true, dereference: false, filter: configCoordination.snapshotFilter });
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

// 回滚前的「丢不起」数据保护（0.3.61）：快照只覆盖 dsh-home 与 workspace，而
// 恢复时旧目录会被直接删除（见 restoreSnapshot 末尾的 rmSync）。这意味着快照
// 之后产生的一切都会消失：
//   · 会话记录（sessions/*/*/session.v3.jsonl.zstd）—— 最痛的，无法重建；
//   · 版本豁免、插件配置等人工授予的运行状态。
// 做法：回滚前把「当前 dsh-home」整体挪到 backups/.pre-restore-<ts>，于是旧数据
// 始终有一份可恢复副本；同时把 sessions 增量合并回恢复后的数据（会话是只追加的
// 日志，按会话 id 合并安全，且不覆盖快照里的同 id 文件）。
function archiveBeforeRestore(dataDir) {
  const live = dataPath(dataDir, 'dsh-home');
  if (!exists(live)) return null;
  const dest = dataPath(dataDir, 'backups', `.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  try {
    privateDir(dest);
    fs.cpSync(live, path.join(dest, 'dsh-home'), { recursive: true, dereference: false, force: true, filter: configCoordination.snapshotFilter });
    return dest;
  } catch { return null; }
}

// 把归档里的会话合并进当前数据：只补「恢复后不存在」或「恢复后更小」的会话文件。
// 会话文件是追加型，更大的版本总是更完整；同 id 不会删除或截断已有内容。
function mergeSessionsFrom(archiveDir, dataDir) {
  const from = path.join(archiveDir, 'dsh-home', 'sessions');
  const to = dataPath(dataDir, 'dsh-home', 'sessions');
  let added = 0;
  let updated = 0;
  if (!exists(from)) return { added, updated };
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, name.name);
      const rel = path.relative(from, src);
      const dst = path.join(to, rel);
      if (name.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); walk(src); continue; }
      if (!name.name.startsWith('session.')) continue;
      const existing = fs.lstatSync(dst, { throwIfNoEntry: false });
      if (!existing) { fs.copyFileSync(src, dst); added += 1; continue; }
      if (fs.statSync(src).size > existing.size) { fs.copyFileSync(src, dst); updated += 1; }
    }
  };
  try { walk(from); } catch { /* 尽力而为，绝不阻塞恢复 */ }
  return { added, updated };
}

// 归档目录的保留策略：与备份同源，避免无限增长（默认保留 5 份）。
function prunePreRestoreArchives(dataDir, keep = 5) {
  try {
    const root = dataPath(dataDir, 'backups');
    if (!exists(root)) return;
    const items = fs.readdirSync(root)
      .filter((name) => name.startsWith('.pre-restore-'))
      .map((name) => ({ name, time: fs.statSync(path.join(root, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    for (const item of items.slice(keep)) fs.rmSync(path.join(root, item.name), { recursive: true, force: true });
  } catch { /* ignore */ }
}
function restoreSnapshot(dataDir, configDir, backupId) {
  if (!/^\d{4}-\d{2}-\d{2}T[0-9Z-]+-[a-f0-9]{8}$/.test(backupId)) throw new Error('Invalid backup ID');
  return configCoordination.withDataLock(dataDir, () => restoreSnapshotLocked(dataDir, configDir, backupId));
}
function restoreSnapshotLocked(dataDir, configDir, backupId) {
  const source = dataPath(dataDir, 'backups', backupId);
  const meta = readJson(path.join(source, 'meta.json'));
  if (!meta || meta.id !== backupId) throw new Error('Backup metadata mismatch');
  for (const name of ['dsh-home', 'workspace']) {
    if (!fs.lstatSync(path.join(source, name), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Backup is incomplete: ${name}`);
  }
  configCoordination.assertNoProfileLocks(path.join(source, 'dsh-home'));
  const targets = [
    ['dsh-home', dataPath(dataDir, 'dsh-home')],
    ['workspace', dataPath(dataDir, 'workspace')]
  ];
  // 回滚会删除快照时间点之后的一切（会话、豁免、运行状态）。先把当前 dsh-home
  // 完整归档到 backups/.pre-restore-<ts>（不属于快照、不会被 pruneBackups 清理），
  // 恢复成功后再把其中更新的会话合并回来。归档失败不阻塞恢复。
  const preRestore = archiveBeforeRestore(dataDir);
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
    const rollbackErrors = [];
    for (const entry of stages.reverse()) {
      // All paths are unique siblings created by this invocation. A failed
      // restoration keeps its old/staged copies instead of deleting evidence.
      const root = path.resolve(dataDir), target = path.resolve(entry.target);
      if (path.dirname(target) !== root || !['dsh-home', 'workspace'].includes(path.basename(target))
          || path.dirname(entry.stage) !== root || !entry.stage.startsWith(`${target}.restore-new-`)
          || path.dirname(entry.old) !== root || !entry.old.startsWith(`${target}.restore-old-`)) {
        rollbackErrors.push(new Error('Restore rollback ownership path mismatch')); continue;
      }
      try {
        if (entry.installed && exists(entry.target)) fs.rmSync(entry.target, { recursive: true, force: true });
        if (exists(entry.old)) fs.renameSync(entry.old, entry.target);
        if (exists(entry.stage)) fs.rmSync(entry.stage, { recursive: true, force: true });
      } catch (failure) { rollbackErrors.push(failure); }
    }
    if (rollbackErrors.length) {
      throw Object.assign(new Error('UNKNOWN: 备份恢复的回滚未确认；已保留数据屏障和旧/暂存目录，请勿重复操作'), { code: 'ERR_CONFIG_UNKNOWN', cause: error, rollbackErrors, stages });
    }
    throw error;
  }
  for (const entry of stages) if (exists(entry.old)) {
    try { fs.rmSync(entry.old, { recursive: true, force: true }); } catch {}
  }
  // 合并会话：快照里没有的会话补回来，快照里较小的用归档里更大的覆盖（会话文件
  // 是追加型日志，更大的版本一定包含更多内容，不会丢事件）。
  let sessions = { added: 0, updated: 0 };
  if (preRestore) {
    sessions = mergeSessionsFrom(preRestore, dataDir);
    prunePreRestoreArchives(dataDir);
  }
  // 版本豁免也在 dsh-home 内、同样会被回滚清空，而「期望清单」在 dataDir 根不受影响
  // —— 这里顺手重放，回滚后不必再手工恢复（见 MEMORY 三十）。
  let exemptions = { added: [], desired: [] };
  try { exemptions = syncExemptions(dataDir, path.join(dataPath(dataDir, 'dsh-home'), 'profiles', 'web')); }
  catch { /* 尽力而为 */ }
  return { ...meta, preRestoreArchive: preRestore, sessionsRestored: sessions, exemptionsRestored: exemptions.added };
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

// FPK 应用自身的版本号（不是 dsh 核心版本）。
// manifest 由 fnOS 放在应用安装目录（/var/apps/<appname>/manifest），不在
// FNOS_APP_DIR 里 —— 后者是 app.tgz 的解包处。路径按 fnOS 的约定推导，
// 读不到就返回空串（面板显示"未知"），绝不因为读不到而报错。
function appVersion() {
  const candidates = [
    path.join('/var/apps', path.basename(dataDirName()), 'manifest'),
    path.join(process.env.TRIM_PKGMETA || '', 'manifest'),
    path.join(process.env.FNOS_APP_DIR || '', '..', 'manifest'),
  ];
  for (const file of candidates) {
    try {
      if (!file || !fs.existsSync(file)) continue;
      const match = /^version\s*=\s*(.+)$/m.exec(fs.readFileSync(file, 'utf8'));
      if (match) return match[1].trim();
    } catch { /* 读不到就换下一个候选 */ }
  }
  return '';
}

function dataDirName() {
  return path.basename(process.env.FNOS_DATA_DIR || process.env.TRIM_PKGVAR || 'dsh-fnos');
}

// 端口设置（0.3.73 / A16）。
//
// ⚠ 原实现直接 `readJson(port-settings.json, {})`，而 readJson 对**损坏 JSON**
// 会 throw（只有 ENOENT 才回退）⇒ supervisor 在**模块初始化阶段**（第 25 行
// `let corePort = ops.portSettings(dataDir).corePort`）就抛错退出。那时
// uncaughtException / boot().catch 处理器都还没注册 ⇒ 既进不了 safe 管理页，
// 也留不下可读诊断，平台只看到"启动失败"。
//
// 端口设置是**可选**配置：损坏时应当退回默认端口并把损坏事实如实上报，让应用
// 仍能启动到受保护的控制面，由管理页提示管理员修复。绝不因为一个可选项坏了
// 就让整个应用无法启动。
function portSettings(dataDir) {
  const file = dataPath(dataDir, 'port-settings.json');
  let saved = {};
  let corrupted = null;
  try {
    saved = readJson(file, {}) || {};
  } catch (error) {
    corrupted = String(error.message || error).slice(0, 200);
    // 保留现场供排查（不覆盖原文件），只是本次使用默认值。
    saved = {};
  }
  const core = Number(saved.corePort);
  const pub = Number(saved.publicPort);
  return {
    corePort: Number.isInteger(core) && core >= 1024 && core <= 65535 ? core : 3081,
    publicPort: Number.isInteger(pub) && pub >= 1024 && pub <= 65535 ? pub : null,
    corrupted,
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

// ── dsh profile 配置文件（cordis.patch.yml）───────────────────────────────
// cordis.yml 是 profile 根配置（dsh 注释明确说不要编辑它）；用户层改动只进
// cordis.patch.yml。写入前自动备份到数据目录，保留最近 10 份。

const PROFILE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const PATCH_BACKUP_KEEP = 10;
// patch 备份文件名。历史上只有 `cordis.patch.yml.<13位时间戳>` 这一种形态，
// 正则也就写成纯数字；但后来各个写入点都改用了**带语义前缀**的名字：
//   disable3p-<ts>、pre-mimo-id-<ts>、pre-ns-fix-<ts>、heal-<ts>、…
// 正则没跟着放宽，于是这些备份对 newestValidPatchBackup **完全不可见**。
// 2026-10-02 的实证事故：备份目录里有 16 条的完好备份（disable3p / pre-*），
// 但 heal 只看得到 5 个纯数字文件，其中最新的可用项只有 **1 条**——一键「重置
// patch 配置」于是把用户 16 条的插件配置降成 1 条，与它自己的注释
//（「直接清空曾导致一次事故」）承诺的"优先恢复备份"正好相反。
// 放宽为「cordis.patch.yml.<可选前缀->时间戳」，并把时间戳取为**最后一段数字**。
// 时间戳有**两种精度**：多数写入点用 Date.now()（13 位毫秒），也有用秒的
// （如 pre-mimo-id-1790863953，10 位）。早先的 \d{13,} 把秒级那批一并排除。
const PATCH_BACKUP_NAME = /^cordis\.patch\.yml\.(?:[A-Za-z0-9_-]+-)?\d{10,}$/;
// ⚠ 0.3.58 修正（推翻 0.3.49 的判断）：空 patch 层必须是【裸 []】，不能是纯注释。
// 纯注释文件 YAML 解析为 null，而 core 要求顶层是数组 → "must be a top-level
// YAML array" → core 拒绝启动。三方证据一致：
//   1) core 自己的 PROFILE_PATCH_TEMPLATE 就是注释 + 裸 []（dsh-app-boot）；
//   2) dshmarket append（lib/patch.js:459）会把裸 [] 注释掉再加条目——它认识
//      裸 []，不需要我们替它预防；
//   3) dshmarket 删光全部条目后（withPlaceholderRestored）恢复裸 []——各方公认
//      的合法空层形态。
// 0.3.49 把 PATCH_EMPTY 改成 "# []" 的前提（dshmarket 无脑追加导致双文档）已
// 不成立；而 "# []" 形态一旦被写入且后续没有插件追加（装完又全删、seed 中途
// 失败），core 下次启动必崩——0.3.57 升级 safe mode 事故的推手之一。
// 双文档防护仍由 normalizeEmptyPatchArray（仅"注释 [] 行"那一条路径）承担。
const PATCH_EMPTY = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
].join('\n');

function readTextFile(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function patchProfileDir(dataDir, name = 'web') {
  if (!PROFILE_NAME.test(name)) throw new Error('Invalid dsh profile name');
  return dataPath(dataDir, 'dsh-home', 'profiles', name);
}

function readPatchConfig(dataDir, profile = 'web') {
  const dir = patchProfileDir(dataDir, profile);
  let patch = '', patchRevision = 'missing';
  try { patch = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'); patchRevision = configCoordination.revision(patch); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {
    patch, patchRevision,
    rootConfig: readTextFile(path.join(dir, 'cordis.yml')),
  };
}

function listPatchBackups(dataDir) {
  const dir = dataPath(dataDir, 'patch-backups');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => PATCH_BACKUP_NAME.test(name))
    .map((name) => {
      const raw = Number(name.match(/(\d{10,})$/)[1]);
      let meta = null;
      try { meta = readJson(path.join(dir, `${name}.meta.json`)); } catch { /* invalid provenance */ }
      return { name, time: raw < 1e12 ? raw * 1000 : raw, profile: meta?.profile || null };
    }).sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
}

// heal 首选策略（0.3.61）：从 patch-backups 找最新的、可解析且非空的备份。
// 直接清空曾导致一次事故：备份目录里有 16 条的完好备份，heal 却把配置降成
// 2 条（见 MEMORY 二十二·补）。返回 { name, text, entries } 或 null。
// 版本豁免的「期望状态」重放（0.3.61）：exact-version 豁免写在 profile 的
// compatibility.json，而它在 dsh-home 内——一旦从快照回滚就会被清空（10-01 实际
// 发生：08:00 授予的 4 项豁免在 09:54 回滚后全部消失，插件重新被 skip）。
// 因此把期望豁免持久化到 dataDir 根（回滚不覆盖），启动时自动重放：
//   · desired-exemptions.json 不存在 → 用当前 profile 的豁免初始化（尊重现状）；
//   · 存在 → 按它补齐 profile 的 compatibility.json，返回 { added, desired }。
function syncExemptions(dataDir, profileDir) {
  const desiredFile = dataPath(dataDir, 'desired-exemptions.json');
  const profileFile = path.join(profileDir, 'compatibility.json');
  let desired = readJson(desiredFile, null);
  if (!desired || typeof desired !== 'object' || Array.isArray(desired)) {
    const seeded = readJson(profileFile, {});
    desired = seeded && typeof seeded === 'object' && !Array.isArray(seeded) ? seeded : {};
    if (Object.keys(desired).length) fs.writeFileSync(desiredFile, JSON.stringify(desired, null, 2) + '\n', { mode: 0o600 });
  }
  let current = readJson(profileFile, {});
  if (!current || typeof current !== 'object' || Array.isArray(current)) current = {};
  const added = [];
  for (const [pkg, versions] of Object.entries(desired)) {
    if (!Array.isArray(versions) || !versions.length) continue;
    const have = Array.isArray(current[pkg]) ? current[pkg] : [];
    const missing = versions.filter((version) => !have.includes(version));
    if (!missing.length) continue;
    current[pkg] = [...have, ...missing];
    added.push(pkg + ' → ' + missing.join(','));
  }
  if (added.length) {
    fs.mkdirSync(path.dirname(profileFile), { recursive: true });
    fs.writeFileSync(profileFile, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
  }
  return { added, desired: Object.keys(desired) };
}

// 登记一项期望豁免（管理页授予豁免时调用）：写 desired 文件并立即同步到 profile。
function rememberExemption(dataDir, profileDir, packageVersion, runtimeVersion) {
  const desiredFile = dataPath(dataDir, 'desired-exemptions.json');
  const existing = readJson(desiredFile, {});
  const desired = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const list = Array.isArray(desired[packageVersion]) ? desired[packageVersion] : [];
  if (!list.includes(runtimeVersion)) list.push(runtimeVersion);
  desired[packageVersion] = list;
  fs.mkdirSync(path.dirname(desiredFile), { recursive: true });
  fs.writeFileSync(desiredFile, JSON.stringify(desired, null, 2) + '\n', { mode: 0o600 });
  return syncExemptions(dataDir, profileDir);
}
// 回退层同步（0.3.61）：$DSH_HOME/profiles/node_modules/@deepseek-ai/ 是 profile
// 解析第三方插件 peer 依赖的 fallback 层，必须与运行 runtime 的包集一致。
// 缺包会让 profile 里的行解析失败；更糟的是旧版核心包残留会"就近遮蔽"回退层，
// 使核心自身的行（settings/connection/authorization）被判不兼容而禁用 →
// 消费者永久 pending → 启动永不就绪（见 MEMORY 二十六 的 90 秒超时事故）。
// 返回 { added, removed, total }；只动软链，真实目录一律不碰。
function syncFallbackLayer(coreDir, dataDir) {
  const runtimeDir = path.join(coreDir, 'runtime', 'node_modules', '@deepseek-ai');
  const layerDir = dataPath(dataDir, 'dsh-home', 'profiles', 'node_modules', '@deepseek-ai');
  if (!fs.existsSync(runtimeDir)) return { added: 0, removed: 0, total: 0, skipped: 'runtime-missing' };
  fs.mkdirSync(layerDir, { recursive: true });
  const wanted = fs.readdirSync(runtimeDir).filter((name) => {
    try { return fs.statSync(path.join(runtimeDir, name)).isDirectory(); } catch { return false; }
  });
  const wantedSet = new Set(wanted);
  let added = 0;
  let removed = 0;
  for (const name of wanted) {
    const link = path.join(layerDir, name);
    const target = path.join(runtimeDir, name);
    const stat = fs.lstatSync(link, { throwIfNoEntry: false });
    if (stat && !stat.isSymbolicLink()) continue;
    const alive = stat ? fs.existsSync(link) : false;
    let same = false;
    if (alive) { try { same = fs.realpathSync(link) === fs.realpathSync(target); } catch { same = false; } }
    if (same) continue;
    if (stat) { try { fs.rmSync(link, { force: true }); } catch { /* ignore */ } }
    try { fs.symlinkSync(target, link, 'dir'); added += 1; } catch { /* race: ignore */ }
  }
  for (const name of fs.readdirSync(layerDir)) {
    if (wantedSet.has(name)) continue;
    const link = path.join(layerDir, name);
    const stat = fs.lstatSync(link, { throwIfNoEntry: false });
    if (stat && stat.isSymbolicLink() && !fs.existsSync(link)) {
      try { fs.rmSync(link, { force: true }); removed += 1; } catch { /* ignore */ }
    }
  }
  return { added, removed, total: fs.readdirSync(layerDir).length };
}

// 核心包遮蔽检测（0.3.61）：profile 顶层 node_modules/@deepseek-ai/ 里若存在与
// 运行 runtime 版本不一致的核心包，会遮蔽回退层 → 核心自身的行被判不兼容而禁用
// → 12 条消费者 pending → 启动卡死。命中即归档到 node_modules-shadowed-<ts>/
// （可恢复，不删除）；版本一致 / runtime 没有的包一律不动。
function readPackageVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null; } catch { return null; }
}
function quarantineShadowedCorePackages(coreDir, nodeModulesDir) {
  const runtimeDir = path.join(coreDir, 'runtime', 'node_modules', '@deepseek-ai');
  const candidate = path.join(nodeModulesDir, '@deepseek-ai');
  if (!fs.existsSync(candidate) || !fs.existsSync(runtimeDir)) return { moved: [], dir: null };
  const moved = [];
  let quarantineDir = null;
  for (const name of fs.readdirSync(candidate)) {
    const entry = path.join(candidate, name);
    const runtimeVersion = readPackageVersion(path.join(runtimeDir, name));
    if (!runtimeVersion) continue;
    const profileVersion = readPackageVersion(entry);
    if (!profileVersion || profileVersion === runtimeVersion) continue;
    if (!quarantineDir) quarantineDir = path.join(nodeModulesDir, 'node_modules-shadowed-' + Date.now());
    fs.mkdirSync(quarantineDir, { recursive: true });
    try { fs.renameSync(entry, path.join(quarantineDir, name)); moved.push(name + '@' + profileVersion); }
    catch { /* ignore */ }
  }
  try { if (!fs.readdirSync(candidate).length) fs.rmdirSync(candidate); } catch { /* ignore */ }
  return { moved, dir: quarantineDir };
}
function patchFileHash(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (let size; (size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

// Historical backups remain listed, but unknown provenance requires explicit confirmation.
function patchBackupSource(dataDir, name, profile, { confirmLegacyProfile = false } = {}) {
  patchProfileDir(dataDir, profile);
  const file = dataPath(dataDir, 'patch-backups', name);
  const missing = {};
  const meta = readJson(`${file}.meta.json`, missing);
  if (meta === missing) {
    if (/^cordis\.patch\.yml\.[a-z][a-z0-9_-]{0,31}-[a-f0-9]{32}-\d{10,}$/.test(name)) throw new Error('新备份缺少来源 metadata，拒绝恢复');
    if (confirmLegacyProfile !== true) throw new Error('历史备份缺少 profile 来源；需显式 confirmLegacyProfile 确认目标 profile');
    return file;
  }
  if (!meta || meta.schemaVersion !== 1 || meta.name !== name || meta.profile !== profile ||
      meta.sourceFile !== path.join(patchProfileDir(dataDir, profile), 'cordis.patch.yml')) {
    throw new Error('备份 profile 来源不匹配，拒绝跨 profile 恢复');
  }
  if (fs.statSync(file).size > 262144) throw new Error('备份内容校验失败：配置文件超过 256KB（UTF-8）');
  const hash = patchFileHash(file);
  if (meta.sha256 !== hash) throw new Error('备份内容与来源 metadata 不匹配');
  return file;
}
function newestValidPatchBackup(dataDir, yamlModule, profile = 'web', options = {}) {
  patchProfileDir(dataDir, profile);
  for (const item of listPatchBackups(dataDir)) {
    try {
      const file = patchBackupSource(dataDir, item.name, profile, options);
      if (fs.statSync(file).size > 262144) continue;
      const text = fs.readFileSync(file, 'utf8');
      const check = validatePatchText(text, yamlModule);
      if (!check.ok || !check.entries) continue;
      return { name: item.name, text, entries: check.entries, profile };
    } catch { /* try next; never infer an unknown profile */ }
  }
  return null;
}
function backupPatchConfig(dataDir, patchFile, profile) {
  const source = path.resolve(patchFile);
  const inferred = path.basename(path.dirname(source));
  const owner = profile === undefined ? inferred : profile;
  if (source !== path.join(patchProfileDir(dataDir, owner), 'cordis.patch.yml')) throw new Error('patch 备份来源路径与 profile 不匹配');
  try { fs.statSync(source); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const dir = dataPath(dataDir, 'patch-backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `cordis.patch.yml.${owner}-${randomBytes(16).toString('hex')}-${Date.now()}`;
  const dest = dataPath(dataDir, 'patch-backups', name);
  fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(`${dest}.meta.json`, JSON.stringify({
    schemaVersion: 1, name, profile: owner, sourceFile: source,
    createdAt: new Date().toISOString(), sha256: patchFileHash(dest),
  }), { flag: 'wx', mode: 0o600 });
  // Only prune this profile's attributed backups; never delete historical unknown sources.
  for (const stale of listPatchBackups(dataDir).filter((item) => item.profile === owner && item.name !== name).slice(PATCH_BACKUP_KEEP - 1)) {
    const target = dataPath(dataDir, 'patch-backups', stale.name);
    fs.rmSync(target, { force: true });
    fs.rmSync(`${target}.meta.json`, { force: true });
  }
  return name;
}

// 0.3.60：把一批 loader entry id 标记为 disabled（safe mode 一键「禁用全部第三方
// 插件」，对照上游桌面版 fatal-recovery 的 disablePlugins 第三恢复按钮）。纯文本级
// 操作以保留注释与条目顺序：
//   1) 已有 `- id: X` 条目 → 块内 disabled 改为 true（没有 disabled 行则补）；
//   2) 没有的 id → 文件末尾追加新条目；
//   3) 文件是合法空层（裸 [] 且前后无条目）时先注释掉 [] 再追加 —— 直接在裸 []
//      后追加条目会构成两个 YAML 文档，core 拒绝启动（dshmarket append 同款处理）。
// 已是 disabled: true 的条目不计 changed；返回 { text, changed, applied }。
function disablePatchEntries(text, ids) {
  const original = String(text ?? '');
  const wanted = [...new Set((ids || []).filter((id) => typeof id === 'string' && id))];
  if (!wanted.length) return { text: original, changed: false, applied: [] };
  const lines = original.replace(/\r\n/g, '\n').split('\n');
  const isTop = (line) => /^-[ ]/.test(line);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isTop(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !isTop(lines[end])) end++;
    const body = lines.slice(i, end);
    const direct = body.join('\n').match(/^-\s*id:\s*['"]?([A-Za-z0-9._@\/-]+)['"]?\s*$/m);
    entries.push({ start: i, end, id: direct ? direct[1] : null, body });
    i = end - 1;
  }
  const wantedSet = new Set(wanted);
  const applied = [];
  const entryAt = new Map(entries.map((entry) => [entry.start, entry]));
  const out = [];
  for (let i = 0; i < lines.length; ) {
    const entry = entryAt.get(i);
    if (!entry) { out.push(lines[i]); i += 1; continue; }
    const body = entry.body.slice();
    if (entry.id && wantedSet.has(entry.id)) {
      const at = body.findIndex((line) => /^\s+disabled:/.test(line));
      if (at >= 0) {
        if (!/disabled:\s*true/.test(body[at])) {
          body[at] = body[at].replace(/disabled:\s*(?:true|false)/, 'disabled: true');
          if (!applied.includes(entry.id)) applied.push(entry.id);
        }
      } else {
        let last = body.length - 1;
        while (last > 0 && (body[last].trim() === '' || body[last].trim().startsWith('#'))) last -= 1;
        body.splice(last + 1, 0, '  disabled: true');
        if (!applied.includes(entry.id)) applied.push(entry.id);
      }
    }
    out.push(...body);
    i = entry.end;
  }
  const present = new Set(entries.map((entry) => entry.id).filter(Boolean));
  const appendIds = wanted.filter((id) => !present.has(id));
  if (appendIds.length) {
    const bareAt = out.findIndex((line) => line.trim() === '[]');
    if (bareAt !== -1) {
      const after = out.slice(bareAt + 1).some((line) => line.trim() !== '' && !line.trim().startsWith('#'));
      const before = out.slice(0, bareAt).some((line) => line.trim() !== '' && !line.trim().startsWith('#'));
      if (!after && !before) out[bareAt] = out[bareAt].replace('[]', '# []');
    }
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    for (const id of appendIds) {
      out.push('- id: ' + id, '  disabled: true', '');
      if (!applied.includes(id)) applied.push(id);
    }
  }
  const next = out.join('\n');
  return { text: next, changed: next !== original, applied };
}

// 修复 dsh 官方模板与 dshmarket 的固有冲突（全新安装必踩）：
//   dsh-app-boot 的 PROFILE_PATCH_TEMPLATE 把新 profile 的 cordis.patch.yml
//   初始化为 `[]`（一个完整的 YAML 文档）；
//   dshmarket 随后会往同一文件**追加** `- id: X` + `disabled: true` 行；
//   `[]` 后面再跟序列项 = 第二个文档 → 整个文件解析失败 → **core 起不来**
//   （报 "failed to parse overlay .../cordis.patch.yml"）。
// 修法：把"裸 [] 行 + 后面还有实质条目"归一化为注释形式（`# []`）——
// 空数组语义不变（注释不参与解析），但追加内容后仍是合法的单文档数组。
// 只动这一种形态，其他内容一律不碰（用户可能有意写了多文档？不存在这种合法用法）。
function normalizeEmptyPatchArray(text) {
  const lines = String(text ?? '').split('\n');
  const bareEmpty = lines.findIndex((line) => line.trim() === '[]');
  if (bareEmpty === -1) return null;
  // 除了这一行的 `[]`，后面是否还有实质内容（非注释、非空行）？
  const hasEntries = lines.slice(bareEmpty + 1).some((line) => {
    const t = line.trim();
    return t !== '' && !t.startsWith('#');
  });
  if (!hasEntries) return null;          // 纯 `[]`（合法）不动
  const before = lines.slice(0, bareEmpty).some((line) => {
    const t = line.trim();
    return t !== '' && !t.startsWith('#');
  });
  if (before) return null;               // 前面有内容说明不是模板形态，不猜
  lines[bareEmpty] = lines[bareEmpty].replace('[]', '# []');
  return lines.join('\n');
}

// ⚠ 0.3.58 新增：patch 层健康检查（preflight 自愈的第一步）。
// 不变式：cordis.patch.yml 的 YAML 解析结果必须是一个数组——core 启动时
// 硬性要求，违反即 "must be a top-level YAML array of loader patch entries"
// → 拒绝启动。本函数检测【解析级】病灶并给出修复文本，不做文本形态猜测：
//   1) 解析为 null / 非数组（纯注释、空文件、误写成对象）→ 在文件末尾
//      补一个裸 `[]`（保住原有注释），恢复合法空层；
//   2) 解析抛错（真正的 YAML 语法错误）→ 返回 { broken: true }，交上层
//      决策（管理页一键重置），本函数绝不静默改写看不懂的内容。
// 双文档（裸 [] + 条目）由 normalizeEmptyPatchArray 负责，这里不重复。
// 与保存、恢复和备份选择共用 AST 校验；缺 parser/超限均 fail closed。
// 仅已成功解析为 null 的空/纯注释层保留 fixable 契约。
function diagnosePatchLayer(text, yamlModule) {
  const check = validatePatchText(text, yamlModule);
  if (check.ok) return { ok: true };
  return { ok: false, ...(check.fixable ? { fixable: true } : { broken: true }), skipped: check.skipped, reason: check.error };
}

// 给"解析非数组"的 patch 层生成修复文本：保留原注释，末尾补裸 []。
// 若文件已经以裸 [] 行结尾（罕见：normalizeEmptyPatchArray 处理过但仍有
// 条目在其后等），返回 null 交上层走 normalizeEmptyPatchArray 路径。
function repairPatchLayerText(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  // 已有裸 [] 行时不动内容（交给 normalizeEmptyPatchArray 处理双文档）。
  if (lines.some((line) => line.trim() === '[]')) return null;
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  lines.push('[]', '');
  return lines.join('\n');
}

// ⚠ 0.3.58：重复条目检测。"duplicate loader entry id: X"（core 启动拒绝）的
// 病灶是同一 id 在 patch 层被声明多次——最常见于插件包自带 bundle patch
// （insert 自己）的同时，用户层又被誊写了一份。自愈是确定性的：删除用户层
// 的重复声明即可，插件本体的 bundle patch 仍会装载，功能无损。
// 返回 { duplicateIds: [...] }（发现重复）或 null（没有重复/无法解析）。
// yamlModule 可选：没有时返回 null（不做解析级检查）。
function findDuplicatePatchIds(text, yamlModule) {
  const load = yamlModule && (typeof yamlModule.parse === 'function' ? yamlModule.parse.bind(yamlModule) : typeof yamlModule.load === 'function' ? yamlModule.load.bind(yamlModule) : null);
  if (!load) return null;
  let parsed;
  try { parsed = load(String(text ?? '')); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const seen = new Map();
  const record = (id, index) => {
    if (typeof id !== 'string' || !id) return;
    if (!seen.has(id)) seen.set(id, []);
    seen.get(id).push(index);
  };
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry || typeof entry !== 'object') continue;
    // 两种声明形态都可能有重复：直接 "- id: X"，或 "- insert: [- id: X]"
    // （bundle-patch 誊写副本是后者，0.3.57 preset-switch 事故即此形态）。
    if (typeof entry.id === 'string') record(entry.id, i);
    if (Array.isArray(entry.insert)) {
      for (const inner of entry.insert) {
        if (inner && typeof inner === 'object' && typeof inner.id === 'string') record(inner.id, i);
      }
    }
  }
  const duplicateIds = [...seen.entries()].filter(([, idx]) => idx.length > 1).map(([id]) => id);
  return duplicateIds.length ? { duplicateIds } : null;
}

// 从 patch 层文本中删除指定 id 的【重复】条目：保留该 id 的第一份声明，删除
// 其后的所有同 id 条目。文本级操作（不动注释与其他条目）。返回修复后文本；
// 没有可删内容时返回 null。
function dedupePatchEntriesText(text, duplicateIds) {
  const ids = new Set(Array.isArray(duplicateIds) ? duplicateIds : []);
  if (!ids.size) return null;
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  // 顶层条目 = 顶格的 "- "（缩进版本属于上一层条目的嵌套续行）。
  const isTopEntry = (line) => /^-[ ]/.test(line);
  // 扫出顶层条目的 [start, end) 行区间（条目 = 起始行到下一个顶层条目前的所有行）。
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isTopEntry(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !isTopEntry(lines[end])) end++;
    const body = lines.slice(i, end).join('\n');
    let id = null;
    const direct = body.match(/^-\s*id:\s*['\"]?([A-Za-z0-9._@/-]+)['\"]?\s*$/m);
    if (direct) { id = direct[1]; }
    else if (/^-\s*insert\s*:/.test(body)) {
      const inner = body.match(/^\s+-\s+id:\s*['\"]?([A-Za-z0-9._@/-]+)['\"]?\s*$/m);
      if (inner) id = inner[1];
    }
    if (id) entries.push({ start: i, end, id });
  }
  // 同 id 保留第一份，其余删除。
  const toDelete = new Set();
  const seenOnce = new Set();
  for (const e of entries) {
    if (!ids.has(e.id)) continue;
    if (seenOnce.has(e.id)) toDelete.add(e);
    else seenOnce.add(e.id);
  }
  if (!toDelete.size) return null;
  const keep = [];
  let i = 0;
  while (i < lines.length) {
    const hit = entries.find((e) => e.start === i && toDelete.has(e));
    if (hit) { i = hit.end; continue; }
    keep.push(lines[i]);
    i++;
  }
  return keep.join('\n');
}

// `yamlModule` must provide the runtime yaml AST API. Only scalar field !!js
// expressions are accepted without evaluation; other unresolved tags fail closed.
// PatchOptions has an index signature, so extension fields remain supported.
function validatePatchText(text, yamlModule) {
  if (typeof text !== 'string') return { ok: false, error: 'patch 文本必须是 string' };
  if (Buffer.byteLength(text, 'utf8') > 262144) return { ok: false, error: '配置文件超过 256KB（UTF-8）' };
  if (!yamlModule || typeof yamlModule.parseDocument !== 'function' ||
      typeof yamlModule.YAMLSeq !== 'function' || typeof yamlModule.YAMLMap !== 'function') {
    return { ok: false, skipped: true, error: 'YAML AST 解析器不可用，已拒绝未经校验的 patch' };
  }
  try {
    const document = yamlModule.parseDocument(text, { strict: true });
    const issues = [...(document.errors || []), ...(document.warnings || [])];
    // !!js is data, not executable here. Every other unresolved tag fails closed.
    const bad = issues.find((issue) => !/^Unresolved tag: tag:yaml.org,2002:js(?:\s|$)/.test(issue.message || ''));
    if (bad) return { ok: false, error: `YAML 解析失败：${String(bad.message).slice(0, 200)}` };
    const node = document.contents;
    if (!(node instanceof yamlModule.YAMLSeq)) return { ok: false, fixable: node === null, error: '顶层必须是 YAML 数组（纯注释或空文件不是合法 patch 层）' };
    const jsTag = 'tag:yaml.org,2002:js';
    const scanTags = (value, field = false) => {
      if (!value || typeof value !== 'object') return;
      if (value.tag === jsTag && (!field || typeof value.value !== 'string')) throw new Error('!!js 仅允许作为字段的字符串表达式');
      if (value instanceof yamlModule.YAMLMap) for (const pair of value.items) { scanTags(pair.key); scanTags(pair.value, true); }
      else if (value instanceof yamlModule.YAMLSeq) for (const item of value.items) scanTags(item, field);
    };
    const checkRows = (seq) => {
      for (const [index, row] of seq.items.entries()) {
        if (!(row instanceof yamlModule.YAMLMap)) throw new Error(`第 ${index + 1} 个条目必须是 mapping（插件条目）`);
        for (const pair of row.items) {
          const key = pair.key?.value;
          const value = pair.value;
          if (typeof key !== 'string') throw new Error('patch 字段名必须是字符串');
          if (['id', 'name'].includes(key) && typeof value?.value !== 'string') throw new Error(`${key} 必须是字符串`);
          if (['disabled', 'group'].includes(key) && value?.tag !== jsTag && value?.value !== null && typeof value?.value !== 'boolean') throw new Error(`${key} 必须是 boolean/null 或 !!js 表达式`);
          if (key === 'insert') {
            if (!(value instanceof yamlModule.YAMLSeq)) throw new Error('insert 必须是 mapping 数组');
            checkRows(value);
          }
        }
      }
    };
    scanTags(node);
    checkRows(node);
    return { ok: true, entries: node.items.length };
  } catch (error) { return { ok: false, error: `YAML 校验失败：${String(error.message || error).slice(0, 200)}` }; }
}

// Exclusive creation establishes ownership before writing; cleanup never targets business files.
function atomicPatchWrite(file, content, options = {}) {
  return configCoordination.withFileLock(file, isProfile => {
    const expectedRevision = options.expectedRevision ?? (isProfile ? configCoordination.revision(configCoordination.snapshot(file)) : undefined);
    return atomicPatchWriteUnlocked(file, content, { ...options, expectedRevision });
  });
}
function atomicPatchWriteUnlocked(file, content, options) {
  configCoordination.assertRevision(file, options.expectedRevision);
  const tmp = inside(path.dirname(file), `${file}.tmp-${randomBytes(16).toString('hex')}`);
  let fd;
  let owned = false;
  try {
    fd = fs.openSync(tmp, 'wx', 0o644);
    owned = true;
    fs.writeFileSync(fd, content, { encoding: 'utf8' });
    fs.closeSync(fd); fd = undefined;
    configCoordination.assertRevision(file, options.expectedRevision);
    fs.renameSync(tmp, file);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (owned) {
      // tmp is an explicitly checked absolute sibling uniquely created by this call.
      try { fs.unlinkSync(tmp); } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
      }
    }
    throw error;
  }
}

function writePatchConfig(dataDir, text, yamlModule, profile = 'web', options = {}) {
  const directory = patchProfileDir(dataDir, profile);
  if (!fs.existsSync(directory)) throw new Error(`配置档目录不存在，无法写入 patch：${directory}（profile=${profile}）`);
  return configCoordination.withLock(directory, () => writePatchConfigUnlocked(dataDir, text, yamlModule, profile, options));
}
function writePatchConfigUnlocked(dataDir, text, yamlModule, profile, options) {
  // 入参类型断言（0.3.70，落实 P21 建议）：本函数的第一个参数是**文本**，
  // 但历史上有调用点误传 JS 对象/数组 —— `String([{...}])` 会静默产出
  // "[object Object]" 写进 cordis.patch.yml，core 启动即报
  // `overlay entry 1 ... must be a mapping`，且看不出是谁写的。
  // 与其隐式 String() 掩盖错误，不如在写盘前就抛错并指出来源。
  if (typeof text !== 'string') {
    if (text === null || text === undefined) throw new Error('writePatchConfig: patch 文本不能为空');
    throw new Error(`writePatchConfig: patch 文本必须是 string，收到 ${Array.isArray(text) ? 'array' : typeof text}`
      + '（若来自对象/数组，请先 yaml.stringify() 序列化）');
  }
  const content = text;
  const check = validatePatchText(content, yamlModule);
  if (!check.ok) throw new Error(check.error);
  const dir = patchProfileDir(dataDir, profile);
  // 目录必须先存在：否则 writeFileSync 会在临时文件上抛 ENOENT，而报错路径是
  // `cordis.patch.yml.tmp-xxxx`，看不出真正原因是"配置档不存在"（0.3.73）。
  if (!fs.existsSync(dir)) throw new Error(`配置档目录不存在，无法写入 patch：${dir}（profile=${profile}）`);
  const file = path.join(dir, 'cordis.patch.yml');
  const expectedRevision = options.expectedRevision ?? configCoordination.revision(configCoordination.snapshot(file));
  configCoordination.assertRevision(file, expectedRevision);
  const backup = backupPatchConfig(dataDir, file, profile);
  atomicPatchWrite(file, content, { expectedRevision });
  return { backup };
}

function restorePatchConfig(dataDir, backupName, yamlModule, profile = 'web', options = {}) {
  return configCoordination.withLock(patchProfileDir(dataDir, profile), () => restorePatchConfigUnlocked(dataDir, backupName, yamlModule, profile, options));
}
function restorePatchConfigUnlocked(dataDir, backupName, yamlModule, profile, options) {
  if (!PATCH_BACKUP_NAME.test(backupName || '')) throw new Error('备份名不合法');
  const file = dataPath(dataDir, 'patch-backups', backupName);
  if (!fs.existsSync(file)) throw new Error('备份不存在或已被清理');
  patchBackupSource(dataDir, backupName, profile, options);
  if (fs.statSync(file).size > 262144) throw new Error('备份内容校验失败：配置文件超过 256KB（UTF-8）');
  const content = fs.readFileSync(file, 'utf8');
  const check = validatePatchText(content, yamlModule);
  if (!check.ok) throw new Error(`备份内容校验失败：${check.error}`);
  const dir = patchProfileDir(dataDir, profile);
  const current = path.join(dir, 'cordis.patch.yml');
  const expectedRevision = options.expectedRevision ?? configCoordination.revision(configCoordination.snapshot(current));
  configCoordination.assertRevision(current, expectedRevision);
  const backup = backupPatchConfig(dataDir, current, profile);
  atomicPatchWrite(current, content, { expectedRevision });
  return { backup };
}

function disablePatchConfig(dataDir, yamlModule, profile = 'web') {
  return writePatchConfig(dataDir, PATCH_EMPTY, yamlModule, profile);
}

module.exports = { dataPath, readJson, writeJson, appVersion, dshVersion, listBackups, backupSettings, saveBackupSettings, snapshotFingerprint, createSnapshot, restoreSnapshot, diagnosePluginWiring, diagnosePluginSettings, scanBrokenSymlinks, scanCorruptSessions, repairPluginWiring, sessionArchiveStatus, markSessionsArchived, initEmptySessionArchive, scanSessions, archiveBeforeRestore, mergeSessionsFrom, prunePreRestoreArchives, promoteRuntime, portSettings, savePorts, readPatchConfig, listPatchBackups, newestValidPatchBackup, syncFallbackLayer, quarantineShadowedCorePackages, syncExemptions, rememberExemption, validatePatchText, atomicPatchWrite, writePatchConfig, restorePatchConfig, disablePatchConfig, backupPatchConfig, normalizeEmptyPatchArray, disablePatchEntries, diagnosePatchLayer, repairPatchLayerText, findDuplicatePatchIds, dedupePatchEntriesText, PATCH_EMPTY };