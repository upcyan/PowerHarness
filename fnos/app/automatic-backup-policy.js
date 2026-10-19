'use strict';

// Never stop a core for an automatic backup. Ready cores use verified online
// copies; unknown/restarting cores still defer. Stopped safe-mode copies retain
// the existing stop-confirmation requirement.
function decide({ mode, coreHandlePresent, coreStopConfirmed, restartPending,
  stopping, shuttingDown, cliActive } = {}) {
  if (stopping || shuttingDown) return { allowed: false, reason: 'application-stopping' };
  if (cliActive) return { allowed: false, reason: 'management-cli-active' };
  // Online copies never signal the core; commit requires source/copy/source hashes.
  if (coreHandlePresent && mode === 'ready' && !restartPending) return { allowed: true, online: true, reason: null };
  if (coreHandlePresent) return { allowed: false, reason: 'core-running-or-unconfirmed' };
  if (restartPending || mode !== 'safe' || coreStopConfirmed !== true) {
    return { allowed: false, reason: 'core-stop-unconfirmed' };
  }
  return { allowed: true, reason: null };
}

const reasons = Object.freeze({
  'application-stopping': '应用正在停止',
  'management-cli-active': '管理命令仍在运行或尚未确认退出',
  'core-running-or-unconfirmed': '核心仍在运行或尚未确认退出',
  'core-stop-unconfirmed': '核心停止状态尚未确认',
  'scan-incomplete': '会话目录未能完整读取',
  'source-changing': '源数据正在变化，等待下一次校验备份',
});

function reasonText(reason) { return reasons[reason] || '当前状态无法确认'; }

function publicDeferrals(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const source of ['daily', 'session']) {
    const entry = value[source];
    if (!entry || typeof entry !== 'object') continue;
    result[source] = { reason: Object.hasOwn(reasons, entry.reason) ? entry.reason : 'unconfirmed-state' };
  }
  return Object.keys(result).length ? result : null;
}

module.exports = { decide, reasonText, publicDeferrals };
