'use strict';
const ops = require('./ops');
const profiles = require('./profiles');
const isolated = require('./diagnostic-profile');
const file = dataDir => ops.dataPath(dataDir, 'diagnosis-state.json');

// This prepares a private configuration, not a running DSH core or another server.
function ensure(dataDir, yaml, appDir) { return isolated.ensure(dataDir); }
function enter(dataDir, yaml, appDir) { return ensure(dataDir, yaml, appDir); }
function exit(dataDir, yaml) {
  const saved = isolated.readState(dataDir) || { active: false };
  if (!saved.active) return { diagnosis: saved, restored: false, needsRestart: false };
  if (saved.mode === 'isolated-profile') {
    const record = isolated.inspect(dataDir);
    if (!record || record.targetProfile !== saved.targetProfile) throw new isolated.DiagnosticError('诊断配置档状态不一致，已拒绝清除或覆盖');
    return { diagnosis: saved, restored: false, needsRestart: false, persistent: true };
  }
  if (saved.mode === 'read-only' && saved.patchModified === false) {
    const next = { ...saved, active: false, phase: 'resolved', resolvedAt: Date.now() };
    ops.writeJson(file(dataDir), next);
    return { diagnosis: next, restored: false, needsRestart: false };
  }
  // Legacy isolation really changed a patch. Keep its exact profile/backup recovery.
  const selected = profiles.selected(dataDir);
  if (typeof saved.profile !== 'string' || !saved.profile.trim()) throw new Error('旧诊断未记录配置档来源，已保留现场；请从备份页显式确认原配置档，不会默认恢复到 web');
  const profile = profiles.validateName(saved.profile);
  if (!saved.backup) throw new Error('缺少诊断前备份，已保留诊断状态；请从备份页确认原配置');
  ops.restorePatchConfig(dataDir, saved.backup, yaml, profile, { confirmLegacyProfile: true });
  const next = { ...saved, active: false, profile, restored: true, phase: 'resolved', resolvedAt: Date.now() };
  ops.writeJson(file(dataDir), next);
  return { diagnosis: next, restored: true, needsRestart: profile === selected };
}
module.exports = { ensure, enter, exit };
