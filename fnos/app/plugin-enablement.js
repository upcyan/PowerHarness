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
function commit(dataDir, profile, manifestFile, manifest, beforePatch, afterPatch, ops, beforeManifest, patchSnapshot) {
  const patchFile = path.join(path.dirname(manifestFile), 'cordis.patch.yml');
  const manifestRevision = coordination.revision(beforeManifest), patchRevision = coordination.revision(patchSnapshot);
  coordination.assertRevision(manifestFile, manifestRevision);
  coordination.assertRevision(patchFile, patchRevision);
  const evidence = `${manifestFile}.enablement-backup-${randomBytes(8).toString('hex')}`;
  fs.writeFileSync(evidence, beforeManifest, { flag: 'wx', mode: 0o600 });
  const hadPatch = patchSnapshot !== null;
  if (!hadPatch && afterPatch !== beforePatch) throw Object.assign(new Error('patch 已消失，拒绝创建未经确认的新配置'), { code: 'ERR_CONFIG_CONFLICT' });
  const backup = hadPatch ? ops.backupPatchConfig(dataDir, patchFile, profile) : null;
  if (hadPatch && !backup) throw new Error('patch 备份未确认，拒绝写入');
  coordination.assertRevision(manifestFile, manifestRevision);
  coordination.assertRevision(patchFile, patchRevision);
  const manifestAfter = JSON.stringify(manifest, null, 2);
  let patchWritten = false;
  try {
    if (afterPatch !== beforePatch) {
      ops.atomicPatchWrite(patchFile, afterPatch, { expectedRevision: patchRevision }); patchWritten = true;
    }
    ops.writeJson(manifestFile, manifest, { expectedRevision: manifestRevision });
    coordination.assertRevision(manifestFile, coordination.revision(manifestAfter));
    if (patchWritten) coordination.assertRevision(patchFile, coordination.revision(afterPatch));
  } catch (failure) {
    const failures = [];
    // Never restore a file merely because it was read earlier. Only our own
    // exact published image may be rolled back; newer foreign bytes survive.
    let currentManifest;
    try { currentManifest = coordination.snapshot(manifestFile); } catch (error) { failures.push(error); }
    if (currentManifest === manifestAfter) {
      try { ops.atomicPatchWrite(manifestFile, beforeManifest, { expectedRevision: coordination.revision(manifestAfter) }); } catch (error) { failures.push(error); }
    } else if (currentManifest !== beforeManifest && patchWritten) {
      failures.push(Object.assign(new Error('manifest 已被外部改写，拒绝回滚覆盖'), { code: 'ERR_CONFIG_CONFLICT' }));
    }
    if (patchWritten) {
      let currentPatch;
      try { currentPatch = coordination.snapshot(patchFile); } catch (error) { failures.push(error); }
      if (currentPatch === afterPatch) {
        try { ops.atomicPatchWrite(patchFile, beforePatch, { expectedRevision: coordination.revision(afterPatch) }); } catch (error) { failures.push(error); }
      } else if (currentPatch !== patchSnapshot) {
        failures.push(Object.assign(new Error('patch 已被外部改写，拒绝回滚覆盖'), { code: 'ERR_CONFIG_CONFLICT' }));
      }
    }
    if (failures.length) {
      let retentionError;
      try { coordination.retain(path.dirname(manifestFile), { evidence, backup, phase: 'rollback-unconfirmed' }); } catch (error) { retentionError = error; }
      throw Object.assign(new Error('UNKNOWN: 配置回滚所有权未确认；已保留锁与备份，请勿重复操作'), { code: 'ERR_ENABLEMENT_UNKNOWN', cause: failure, rollbackErrors: failures, retentionError, evidence, backup });
    }
    discardEvidence(); throw failure;
  }
  discardEvidence(); return { backup };
  function discardEvidence() {
    if (path.resolve(evidence) !== evidence || path.dirname(evidence) !== path.dirname(manifestFile) || !evidence.startsWith(manifestFile + '.enablement-backup-')) throw new Error('Invalid transaction evidence path');
    try { fs.unlinkSync(evidence); } catch { /* retained evidence is harmless */ }
  }
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
module.exports = { KEY, intents, set, forget, ownedIds };
