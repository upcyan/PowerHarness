'use strict';
const fs = require('node:fs');
const coordination = require('./config-coordination.js');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const KEY = '_powerHarnessPluginEnablement';
function intents(manifest) {
  if (!Object.hasOwn(manifest, KEY)) return {};
  const meta = manifest[KEY];
  if (!meta || meta.version !== 1 || !meta.disabled || typeof meta.disabled !== 'object' || Array.isArray(meta.disabled)) throw new Error('插件禁用 metadata 损坏，拒绝自愈/修改');
  for (const [name, record] of Object.entries(meta.disabled)) {
    if (!name || !record || !Array.isArray(record.ids) || !record.ids.length || record.ids.some(id => typeof id !== 'string' || !id) || !Array.isArray(record.rows)) throw new Error('插件禁用 metadata 损坏，拒绝自愈/修改');
    if (new Set(record.ids).size !== record.ids.length) throw new Error('插件禁用 metadata id 重复');
    const seen = new Set();
    for (const row of record.rows) {
      if (!row || !record.ids.includes(row.id) || !Number.isInteger(row.ordinal) || row.ordinal < 0 || !(row.before === null || (typeof row.before === 'string' && /^(?:true|false|True|False|TRUE|FALSE)$/.test(row.before)))) throw new Error('插件禁用 metadata 损坏，拒绝自愈/修改');
      const key = JSON.stringify([row.id, row.ordinal]);
      if (seen.has(key)) throw new Error('插件禁用 metadata row 重复');
      seen.add(key);
    }
  }
  return meta.disabled;
}
function parser(options = {}) {
  if (Object.hasOwn(options, 'yamlModule')) return options.yamlModule;
  // The app modules are beside runtime/, not inside its node_modules search tree.
  // Match the supervisor's visible parser contract rather than ambient NODE_PATH.
  if (process.env.FNOS_APP_DIR) return require(path.join(process.env.FNOS_APP_DIR, 'runtime', 'node_modules', 'yaml'));
  return require('yaml');
}
function document(text, yaml, ops) {
  const check = ops.validatePatchText(text, yaml);
  if (!check.ok) throw new Error(check.error);
  return yaml.parseDocument(text, { strict: true });
}
function value(row, key) { return row.get(key, true)?.value; }
function entries(seq, yaml, out = []) {
  for (const row of seq.items) {
    const insert = row.get('insert', true);
    if (insert) { entries(insert, yaml, out); continue; }
    out.push(row);
    if (value(row, 'group') === true) throw new Error('暂不支持 group entry 的安全归属映射');
  }
  return out;
}
function ownedIds(directory, name, yaml, ops) {
  const dir = path.join(directory, 'node_modules', ...name.split('/'));
  const pkg = ops.readJson(path.join(dir, 'package.json'));
  const rel = pkg?.dsh?.bundle?.patch;
  if (pkg?.name !== name || typeof rel !== 'string' || !/^\.\/[a-zA-Z0-9._/-]+\.ya?ml$/.test(rel) || rel.split('/').includes('..')) throw new Error('插件 bundle patch 声明不可安全绑定');
  const root = fs.realpathSync(dir), file = fs.realpathSync(path.join(dir, rel));
  if (!file.startsWith(root + path.sep)) throw new Error('插件 patch 逃逸 package');
  const rows = entries(document(fs.readFileSync(file, 'utf8'), yaml, ops).contents, yaml);
  const ids = [];
  for (const row of rows) {
    const id = value(row, 'id'), module = value(row, 'name');
    if (row.get('id', true)?.tag || row.get('name', true)?.tag || typeof id !== 'string' || !id || !(module === name || (typeof module === 'string' && module.startsWith(name + '/')) || (module === undefined && id === name))) throw new Error('bundle 包含无法明确绑定到本 package 的 entry，拒绝禁用');
    ids.push(id);
  }
  if (!ids.length) throw new Error('bundle 没有可绑定的 entry，拒绝禁用');
  return [...new Set(ids)];
}
function locate(text, ids, yaml, ops, name) {
  const rows = entries(document(text, yaml, ops).contents, yaml);
  const counts = new Map();
  for (const row of rows) {
    const module = value(row, 'name');
    if (typeof module === 'string' && (module === name || module.startsWith(name + '/')) && !ids.includes(value(row, 'id'))) throw new Error('profile 存在 bundle 未绑定的本 package entry，拒绝不完整禁用');
  }
  return rows.filter(row => ids.includes(value(row, 'id'))).map(row => {
    const id = value(row, 'id'), ordinal = counts.get(id) || 0;
    const module = value(row, 'name');
    if (row.get('id', true)?.tag || row.get('name', true)?.tag || (module !== undefined && module !== name && !module.startsWith(name + '/'))) throw new Error('profile entry name 与 package 归属冲突，拒绝覆盖');
    counts.set(id, ordinal + 1);
    if (row.flow) throw new Error('暂不支持 flow mapping 的安全禁用');
    const pair = row.items.find(pair => pair.key.value === 'disabled');
    if (pair && (pair.value?.tag || typeof pair.value?.value !== 'boolean')) throw new Error('disabled 不是静态 boolean，拒绝覆盖');
    const first = row.items[0].key.range[0];
    const lineStart = text.lastIndexOf('\n', first - 1) + 1;
    const column = first - lineStart;
    const at = text.indexOf('\n', first);
    if (at < 0 && !pair) throw new Error('entry 缺少行尾，拒绝安全插入');
    return { row, id, ordinal, pair, at: at + 1, indent: ' '.repeat(column) };
  });
}
function apply(text, edits) { for (const e of edits.sort((a,b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end); return text; }
function transform(text, ids, record, yaml, ops, name) {
  const found = locate(text, ids, yaml, ops, name), edits = [], saved = [];
  if (record && found.length !== record.rows.length) throw new Error('禁用后的 patch entry 已变化，拒绝不精确恢复');
  for (const hit of found) {
    const { id, ordinal, pair } = hit;
    if (!record) {
      const before = pair ? text.slice(pair.value.range[0], pair.value.range[1]) : null;
      saved.push({ id, ordinal, before });
      if (pair) edits.push({ start: pair.value.range[0], end: pair.value.range[1], text: 'true' });
      else edits.push({ start: hit.at, end: hit.at, text: hit.indent + 'disabled: true\n' });
    } else {
      const original = record.rows.find(row => row.id === id && row.ordinal === ordinal);
      if (!original || !pair || pair.value.value !== true) throw new Error('禁用状态被外部修改，拒绝覆盖用户改动');
      if (original.before !== null) edits.push({ start: pair.value.range[0], end: pair.value.range[1], text: original.before });
      else {
        const start = text.lastIndexOf('\n', pair.key.range[0] - 1) + 1;
        const end = text.indexOf('\n', pair.value.range[1]);
        if (end < 0 || text.slice(start, end + 1) !== hit.indent + 'disabled: true\n') throw new Error('禁用字段被编辑，拒绝删除');
        edits.push({ start, end: end + 1, text: '' });
      }
    }
  }
  return { text: apply(text, edits), rows: saved };
}
// Rollback handles are process-local, opaque and bounded; old/forged handles fail closed.
const rollbackHandles = new Map();
const MAX_ROLLBACK_HANDLES = 64;
function fileIdentity(file) {
  const info = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  return info ? [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':') : null;
}
function saveRollback(directory, image, names) {
  const token = randomBytes(24).toString('hex');
  rollbackHandles.set(token, { directory: fs.realpathSync(directory), image, names: [...names], manifestIdentity: fileIdentity(path.join(directory, 'package.json')), patchIdentity: fileIdentity(path.join(directory, 'cordis.patch.yml')) });
  while (rollbackHandles.size > MAX_ROLLBACK_HANDLES) rollbackHandles.delete(rollbackHandles.keys().next().value);
  return token;
}
function discardEvidence(file, manifestFile) {
  if (path.resolve(file) !== file || path.dirname(file) !== path.dirname(manifestFile) || !file.startsWith(manifestFile + '.enablement-backup-')) throw new Error('Invalid transaction evidence path');
  try { fs.unlinkSync(file); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
}
function keepUnknown(directory, details, cause, rollbackErrors = []) {
  let retentionError;
  try { coordination.retain(directory, details); } catch (failure) { retentionError = failure; }
  throw Object.assign(new Error('UNKNOWN: 配置回滚所有权未确认；已保留锁与证据，请勿重复操作'), {
    code: 'ERR_ENABLEMENT_UNKNOWN', cause, rollbackErrors, retentionError, ...details,
  });
}
// A pair is published once, under the shared profile lease. Compensation only
// touches exact images actually attempted by this transaction, including a write
// that renamed successfully and then threw. Foreign bytes are never restored over.
function publishPair(dataDir, profile, directory, image, ops, jsonManifest) {
  const manifestFile = path.join(directory, 'package.json'), patchFile = path.join(directory, 'cordis.patch.yml');
  const { beforeManifest, afterManifest, beforePatch, afterPatch } = image;
  coordination.assertRevision(manifestFile, coordination.revision(beforeManifest));
  coordination.assertRevision(patchFile, coordination.revision(beforePatch));
  if (beforePatch === null && afterPatch !== null) throw Object.assign(new Error('patch 已消失，拒绝创建未经确认的新配置'), { code: 'ERR_CONFIG_CONFLICT' });
  const evidence = manifestFile + '.enablement-backup-' + randomBytes(8).toString('hex');
  fs.writeFileSync(evidence, JSON.stringify({ version: 1, profile, ...image }), { flag: 'wx', mode: 0o600 });
  let backup = null, patchAttempted = false, manifestAttempted = false;
  try {
    if (beforePatch !== null) {
      backup = ops.backupPatchConfig(dataDir, patchFile, profile);
      if (!backup) throw new Error('patch 备份未确认，拒绝写入');
    }
    coordination.assertRevision(manifestFile, coordination.revision(beforeManifest));
    coordination.assertRevision(patchFile, coordination.revision(beforePatch));
    if (afterPatch !== beforePatch) {
      patchAttempted = true;
      ops.atomicPatchWrite(patchFile, afterPatch, { expectedRevision: coordination.revision(beforePatch) });
    }
    if (afterManifest !== beforeManifest) {
      manifestAttempted = true;
      if (jsonManifest) ops.writeJson(manifestFile, jsonManifest, { expectedRevision: coordination.revision(beforeManifest) });
      else ops.atomicPatchWrite(manifestFile, afterManifest, { expectedRevision: coordination.revision(beforeManifest) });
    }
    coordination.assertRevision(manifestFile, coordination.revision(afterManifest));
    coordination.assertRevision(patchFile, coordination.revision(afterPatch));
  } catch (failure) {
    const failures = [];
    for (const [file, original, published, attempted] of [
      [manifestFile, beforeManifest, afterManifest, manifestAttempted],
      [patchFile, beforePatch, afterPatch, patchAttempted],
    ]) {
      try {
        const current = coordination.snapshot(file);
        if (attempted && current === published && original !== published) ops.atomicPatchWrite(file, original, { expectedRevision: coordination.revision(published) });
        else if ((patchAttempted || manifestAttempted) && current !== original) throw Object.assign(new Error(path.basename(file) + ' 已被外部改写，拒绝回滚覆盖'), { code: 'ERR_CONFIG_CONFLICT' });
      } catch (error) { failures.push(error); }
    }
    if (failures.length) keepUnknown(directory, { evidence, backup, phase: 'rollback-unconfirmed' }, failure, failures);
    try { discardEvidence(evidence, manifestFile); }
    catch (error) { keepUnknown(directory, { evidence, backup, phase: 'evidence-cleanup-unconfirmed' }, failure, [error]); }
    throw failure;
  }
  try { discardEvidence(evidence, manifestFile); }
  catch (failure) { keepUnknown(directory, { evidence, backup, phase: 'evidence-cleanup-unconfirmed' }, failure); }
  return { backup };
}
function commit(dataDir, profile, manifestFile, manifest, beforePatch, afterPatch, ops, beforeManifest, patchSnapshot, options = {}) {
  const directory = path.dirname(manifestFile);
  const image = { beforeManifest, afterManifest: JSON.stringify(manifest, null, 2), beforePatch: patchSnapshot, afterPatch: patchSnapshot === null ? null : afterPatch };
  if (patchSnapshot === null && beforePatch !== afterPatch) throw Object.assign(new Error('patch 已消失，拒绝创建未经确认的新配置'), { code: 'ERR_CONFIG_CONFLICT' });
  const result = publishPair(dataDir, profile, directory, image, ops, manifest);
  if (options.rollbackNames) result.rollbackToken = saveRollback(directory, image, options.rollbackNames);
  return result;
}
function set(dataDir, profile, state, enabled, ops, options = {}) {
  if (options.preflightOnly === true) {
    coordination.assertCanStart(dataDir); // Read-only admission check; no lock files created.
    return setLocked(dataDir, profile, state, enabled, ops, options);
  }
  return coordination.withLock(state.directory, () => setLocked(dataDir, profile, state, enabled, ops, options));
}
function setLocked(dataDir, profile, state, enabled, ops, options) {
  const { name, directory, manifestFile, manifest } = state;
  const beforeManifest = state.beforeManifest ?? coordination.snapshot(manifestFile);
  if (JSON.stringify(JSON.parse(beforeManifest)) !== JSON.stringify(manifest)) throw Object.assign(new Error('插件配置输入已过期，拒绝覆盖'), { code: 'ERR_CONFIG_CONFLICT' });
  const disabled = intents(manifest), record = Object.hasOwn(disabled, name) ? disabled[name] : undefined, yaml = parser(options);
  const ids = record?.ids || ownedIds(directory, name, yaml, ops);
  if (enabled && record) {
    const current = ownedIds(directory, name, yaml, ops);
    if (current.length !== ids.length || current.some(id => !ids.includes(id))) throw new Error('bundle entry 声明已变化，拒绝不精确恢复');
  }
  if (Object.entries(disabled).some(([other, state]) => other !== name && state.ids.some(id => ids.includes(id)))) throw new Error('entry 归属与其他禁用 package 冲突');
  const patchFile = path.join(directory, 'cordis.patch.yml');
  const patchSnapshot = coordination.snapshot(patchFile);
  const before = patchSnapshot ?? ops.PATCH_EMPTY;
  let next = before;
  if (!enabled && record) transform(before, ids, record, yaml, ops, name); // verify, without restoring
  if (!enabled && !record) {
    const result = transform(before, ids, null, yaml, ops, name);
    next = result.text;
    disabled[name] = { ids, rows: result.rows };
  } else if (enabled && record) {
    next = transform(before, ids, record, yaml, ops, name).text;
    delete disabled[name];
  }
  manifest[KEY] = { version: 1, disabled };
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(item => item !== name);
  if (enabled) manifest.dsh.profile.bundles.push(name);
  const check = ops.validatePatchText(next, yaml); if (!check.ok) throw new Error(check.error);
  if (options.preflightOnly === true) return { name, enabled }; // No files/backups are written; reject unsupported bindings before stopping core.
  return { name, enabled, ...commit(dataDir, profile, manifestFile, manifest, before, next, ops, beforeManifest, patchSnapshot) };
}
function removeBoundRows(text, record, yaml, ops, name) {
  // Confirm every recorded disabled row first; never delete a changed/foreign row.
  transform(text, record.ids, record, yaml, ops, name);
  const doc = document(text, yaml, ops), edits = [];
  function visit(seq) {
    const removable = seq.items.filter(row => !row.has('insert') && record.ids.includes(value(row, 'id')));
    if (removable.length === seq.items.length && removable.length) {
      edits.push({ start: seq.range[0], end: seq.range[1], text: '[]\n' });
      return;
    }
    for (const row of seq.items) {
      if (removable.includes(row)) {
        const start = text.lastIndexOf('\n', row.range[0] - 1) + 1;
        edits.push({ start, end: row.range[1], text: '' });
      } else if (row.has('insert')) visit(row.get('insert', true));
    }
  }
  visit(doc.contents);
  const next = apply(text, edits), check = ops.validatePatchText(next, yaml);
  if (!check.ok) throw new Error(`卸载 patch 清理不安全：${check.error}`);
  return next;
}
// Confirmed removal deletes only bound profile rows and forgets intent. Reinstall
// instead restores precise prior disabled fields. Failed removal retains intent.
function forget(dataDir, profile, name, ops, options = {}) {
  const directory = ops.dataPath(dataDir, 'dsh-home', 'profiles', profile);
  return coordination.withLock(directory, () => forgetLocked(dataDir, profile, name, ops, options));
}
function forgetLocked(dataDir, profile, name, ops, options) {
  const directory = ops.dataPath(dataDir, 'dsh-home', 'profiles', profile), manifestFile = path.join(directory, 'package.json');
  const beforeManifest = coordination.snapshot(manifestFile), manifest = JSON.parse(beforeManifest), disabled = intents(manifest), record = Object.hasOwn(disabled, name) ? disabled[name] : undefined;
  if (!record) return false;
  const yaml = parser(options), patchSnapshot = coordination.snapshot(path.join(directory, 'cordis.patch.yml')), before = patchSnapshot ?? ops.PATCH_EMPTY;
  const next = options.removed === true ? removeBoundRows(before, record, yaml, ops, name)
    : transform(before, record.ids, record, yaml, ops, name).text;
  delete disabled[name]; manifest[KEY] = { version: 1, disabled };
  commit(dataDir, profile, manifestFile, manifest, before, next, ops, beforeManifest, patchSnapshot);
  return true;
}
function batchFailure(failures) {
  return Object.assign(new Error('批量禁用预检失败：' + failures.map(item => item.name + '：' + item.reason).join('；')), { code: 'ERR_PLUGIN_BATCH_PREFLIGHT', failures });
}
function disableBatch(dataDir, profile, directory, names, ops, options = {}) {
  const applyBatch = () => {
    const manifestFile = path.join(directory, 'package.json'), patchFile = path.join(directory, 'cordis.patch.yml');
    const beforeManifest = coordination.snapshot(manifestFile), patchSnapshot = coordination.snapshot(patchFile);
    let manifest, disabled, yaml;
    try {
      manifest = JSON.parse(beforeManifest);
      if (!manifest || !Array.isArray(manifest.dsh?.profile?.bundles)) throw new Error('dsh profile manifest is incompatible');
      disabled = intents(manifest); yaml = parser(options);
    } catch (failure) { throw batchFailure(names.map(name => ({ name, reason: failure.message, code: failure.code || 'ERR_PLUGIN_BINDING' }))); }
    const before = patchSnapshot ?? ops.PATCH_EMPTY;
    let next = before;
    const changed = [], skipped = [], failures = [], owners = new Map();
    for (const [owner, record] of Object.entries(disabled)) for (const id of record.ids) {
      if (!owners.has(id)) owners.set(id, owner);
      else owners.set(id, null);
    }
    for (const name of names) {
      try {
        if (!Object.hasOwn(manifest.dependencies || {}, name)) throw new Error('Plugin is not installed in this profile');
        const record = Object.hasOwn(disabled, name) ? disabled[name] : undefined;
        const ids = ownedIds(directory, name, yaml, ops);
        if (record && (record.ids.length !== ids.length || ids.some(id => !record.ids.includes(id)))) throw new Error('bundle entry 声明已变化，拒绝不精确禁用/恢复');
        if (ids.some(id => owners.has(id) && owners.get(id) !== name)) throw new Error('entry 归属与其他 package 冲突，拒绝禁用');
        const bundled = manifest.dsh.profile.bundles.includes(name);
        if (record) {
          transform(next, ids, record, yaml, ops, name); // verify without restoring
          if (!bundled) { skipped.push(name); continue; }
        } else if (!bundled && locate(next, ids, yaml, ops, name).every(hit => hit.pair?.value?.value === true)) {
          skipped.push(name); continue;
        }
        if (!record) {
          const result = transform(next, ids, null, yaml, ops, name);
          next = result.text; disabled[name] = { ids, rows: result.rows };
        }
        for (const id of ids) owners.set(id, name);
        manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(item => item !== name);
        changed.push(name);
      } catch (failure) { failures.push({ name, reason: failure.message, code: failure.code || 'ERR_PLUGIN_BINDING' }); }
    }
    if (failures.length) throw batchFailure(failures);
    const check = ops.validatePatchText(next, yaml);
    if (!check.ok) throw batchFailure(names.map(name => ({ name, reason: check.error, code: 'ERR_PLUGIN_BINDING' })));
    coordination.assertRevision(manifestFile, coordination.revision(beforeManifest));
    coordination.assertRevision(patchFile, coordination.revision(patchSnapshot));
    if (options.preflightOnly === true || !changed.length) return { changed, skipped, preflightOnly: options.preflightOnly === true, rollbackToken: null };
    manifest[KEY] = { version: 1, disabled };
    return { changed, skipped, preflightOnly: false, ...commit(dataDir, profile, manifestFile, manifest, before, next, ops, beforeManifest, patchSnapshot, { rollbackNames: changed }) };
  };
  if (options.preflightOnly === true) { if (options.admissionChecked !== true) coordination.assertCanStart(dataDir); return applyBatch(); }
  return coordination.withLock(directory, applyBatch);
}
function restoreDisabledBatch(dataDir, profile, directory, result, ops) {
  return coordination.withLock(directory, () => {
    if (result?.preflightOnly === true) throw new Error('预检结果没有可恢复的提交');
    if (Array.isArray(result?.changed) && result.changed.length === 0 && result.rollbackToken === null) return { changed: [], restored: true };
    const entry = rollbackHandles.get(result?.rollbackToken);
    if (!entry || entry.directory !== fs.realpathSync(directory)) throw Object.assign(new Error('批量禁用恢复 token 无效、过期或不属于此 profile'), { code: 'ERR_ENABLEMENT_TOKEN' });
    const { image } = entry, manifestFile = path.join(directory, 'package.json'), patchFile = path.join(directory, 'cordis.patch.yml');
    try {
      coordination.assertRevision(manifestFile, coordination.revision(image.afterManifest));
      coordination.assertRevision(patchFile, coordination.revision(image.afterPatch));
      if (fileIdentity(manifestFile) !== entry.manifestIdentity || fileIdentity(patchFile) !== entry.patchIdentity) throw Object.assign(new Error('已发布文件的身份或版本变化，拒绝恢复同字节外部重发布'), { code: 'ERR_CONFIG_CONFLICT' });
    } catch (failure) {
      const evidence = manifestFile + '.enablement-backup-' + randomBytes(8).toString('hex');
      let evidenceError;
      try { fs.writeFileSync(evidence, JSON.stringify({ version: 1, profile, ...image }), { flag: 'wx', mode: 0o600 }); } catch (error) { evidenceError = error; }
      keepUnknown(directory, { evidence, phase: 'restore-conflict' }, failure, evidenceError ? [evidenceError] : []);
    }
    publishPair(dataDir, profile, directory, { beforeManifest: image.afterManifest, afterManifest: image.beforeManifest, beforePatch: image.afterPatch, afterPatch: image.beforePatch }, ops);
    rollbackHandles.delete(result.rollbackToken);
    return { changed: [...entry.names], restored: true };
  });
}
function packageIds(directory, name, ops, options = {}) { return ownedIds(directory, name, parser(options), ops); }
function packageBindings(directory, name, ops, options = {}) {
  const yaml = parser(options);
  ownedIds(directory, name, yaml, ops);
  const root = path.join(directory, 'node_modules', ...name.split('/'));
  const pkg = ops.readJson(path.join(root, 'package.json'));
  return entries(document(fs.readFileSync(path.join(root, pkg.dsh.bundle.patch), 'utf8'), yaml, ops).contents, yaml).map(row => [value(row, 'id'), value(row, 'name') ?? null]);
}
module.exports = { KEY, intents, set, forget, ownedIds, packageIds, packageBindings, disableBatch, restoreDisabledBatch };
