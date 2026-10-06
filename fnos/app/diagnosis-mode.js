'use strict';
const fs = require('node:fs');
const ops = require('./ops');
const profiles = require('./profiles');
const file = dataDir => ops.dataPath(dataDir, 'diagnosis-state.json');

// AI辅助分析不是插件隔离。默认只记录面板状态，不改patch、不停启核心。
function enter(dataDir) {
  const saved = ops.readJson(file(dataDir), { active: false });
  if (saved?.active) return saved;
  const next = { active: true, mode: 'read-only', patchModified: false, profile: profiles.selected(dataDir), phase: 'active', startedAt: Date.now() };
  ops.writeJson(file(dataDir), next);
  return next;
}
function exit(dataDir, yaml) {
  const saved = ops.readJson(file(dataDir), { active: false });
  if (!saved?.active) return { diagnosis: saved, restored: false, needsRestart: false };
  if (saved.mode === 'read-only' && saved.patchModified === false) {
    const next = { ...saved, active: false, phase: 'resolved', resolvedAt: Date.now() };
    ops.writeJson(file(dataDir), next);
    return { diagnosis: next, restored: false, needsRestart: false };
  }
  // 兼容旧模式：只有确实恢复成功才清active。缺备份/坏备份保持现场可重试。
  const selected = profiles.selected(dataDir);
  if (typeof saved.profile !== 'string' || !saved.profile.trim()) throw new Error('旧诊断未记录配置档来源，已保留现场；请从备份页显式确认原配置档，不会默认恢复到 web');
  const profile = profiles.validateName(saved.profile);
  if (!saved.backup) throw new Error('缺少诊断前备份，已保留诊断状态；请从备份页确认原配置');
  // 进入诊断时已把该 profile 与其备份绑定在同一事务里，所以这对 (profile, backup)
  // 是已知来源；缺少的只是新版 sidecar 元数据。这里确认的正是进入时记录的那个
  // profile，而不是"当前选中的其他 profile"，因此不构成跨档猜测。
  ops.restorePatchConfig(dataDir, saved.backup, yaml, profile, { confirmLegacyProfile: true });
  const next = { ...saved, active: false, profile, restored: true, phase: 'resolved', resolvedAt: Date.now() };
  ops.writeJson(file(dataDir), next);
  return { diagnosis: next, restored: true, needsRestart: profile === selected };
}
module.exports = { enter, exit };
