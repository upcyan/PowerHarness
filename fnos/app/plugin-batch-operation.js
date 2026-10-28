'use strict';
// One maintenance window for the entire selection. All callbacks refer to the
// supervisor's existing close-confirmed lifecycle, never to an extra core.
async function run({ plugins, dataDir, profile, names, wasSafe = false, stop, start, maintenance, ready, safe, isUnconfirmed }) {
  const plan = plugins.disableBatch(dataDir, profile, names, { preflightOnly: true });
  if (!plan.changed.length) return { changed: [], skipped: plan.skipped, notice: '所选插件均已禁用，无需重启。' };
  maintenance('正在批量禁用 ' + plan.changed.length + ' 个插件（一次重启生效）');
  try { await stop(); }
  catch (error) { safe('无法确认核心已停止，未修改插件状态：' + error.message); throw error; }
  let committed;
  try {
    committed = plugins.disableBatch(dataDir, profile, names);
    await start();
    ready();
    return { changed: committed.changed, skipped: committed.skipped, notice: '已禁用 ' + committed.changed.length + ' 个插件，跳过 ' + committed.skipped.length + ' 个已禁用项。' };
  } catch (error) {
    if (isUnconfirmed(error)) { safe('插件批量事务状态未确认，保留现场且不启动核心：' + error.message); throw error; }
    try { await stop(); }
    catch (stopError) { safe('批量禁用后无法确认核心停止，不继续回滚或启动：' + stopError.message); throw stopError; }
    if (committed && wasSafe) {
      const warning = '已禁用 ' + committed.changed.length + ' 个插件，但核心仍未启动：' + error.message;
      safe(warning);
      return { changed: committed.changed, skipped: committed.skipped, warning };
    }
    try {
      if (committed) plugins.restoreDisabledBatch(dataDir, profile, committed);
    } catch (restoreError) {
      safe('批量禁用恢复未确认，已保留证据，不继续启动：' + restoreError.message);
      throw restoreError;
    }
    try { await start(); }
    catch (startupError) { safe('批量禁用未生效，原状态已恢复，但核心仍无法启动：' + startupError.message); throw startupError; }
    const warning = '批量禁用失败，已恢复原状态：' + error.message;
    ready(warning);
    return { changed: [], skipped: plan.skipped, warning };
  }
}
module.exports = { run };
