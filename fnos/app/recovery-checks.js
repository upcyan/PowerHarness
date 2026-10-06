'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ops = require('./ops');
const profiles = require('./profiles');
// 只读元信息与配置形状；不启动进程、不创建目录、不修权限、不改链接。
function inspect(dataDir, yaml, { bridge = '/opt/dsh/home', appDir = process.env.FNOS_APP_DIR || null } = {}) {
  const checks = [];
  const add = (id, status, text) => checks.push({ id, status, text });
  const home = ops.dataPath(dataDir, 'dsh-home');
  try {
    fs.accessSync(home, fs.constants.R_OK | fs.constants.X_OK);
    add('data-home', 'ok', '真实数据目录可读、可遍历');
  } catch { add('data-home', 'error', '真实数据目录缺失或不可读；不要创建空目录掩盖原数据'); }
  try {
    const link = fs.lstatSync(bridge);
    if (!link.isSymbolicLink()) add('bridge', 'warning', '桥接不是符号链接，需要核对启动时实际 DSH_HOME');
    else if (fs.realpathSync(bridge) !== fs.realpathSync(home)) add('bridge', 'error', '桥接指向其他数据目录；禁止盲目改写或重置配置');
    else add('bridge', 'ok', '桥接可达且指向本应用真实数据目录');
  } catch { add('bridge', 'error', '桥接缺失、目标不可达或无权读取，需要保留现场核对'); }
  try {
    const profile = profiles.selected(dataDir), dir = profiles.directory(dataDir, profile);
    JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    add('profile', 'ok', '选中配置档的 manifest 可读且为合法 JSON');
    const text = ops.readPatchConfig(dataDir, profile).patch;
    const result = ops.validatePatchText(text, yaml);
    add('patch', result.ok ? 'ok' : 'warning', result.ok ? '用户 patch 结构校验通过（不等于插件运行成功）' : '用户 patch 未通过结构校验；先查看配置和备份，不自动重置');
  } catch { add('profile', 'error', '配置档选择或 manifest 不可读取/解析'); }
  if (appDir) {
    try {
      const cores = require('./core-manager');
      const directory = cores.selectedCore(dataDir, appDir), adapter = cores.adapterFor(directory, ops.portSettings(dataDir).corePort);
      add('core-adapter', 'ok', '当前核心配套只读校验通过：runtime/adapter=' + adapter.version);
    } catch (error) { add('core-adapter', 'error', String(error.message || error)); }
  } else add('core-adapter', 'warning', '未提供应用目录，尚未验证核心与适配声明配套');
  return { checks, readOnly: true, sampledAt: new Date().toISOString(), note: '当前检查不能证明过去故障已解决。此检查未修复任何文件；请保留失败运行ID与日志。' };
}
module.exports = { inspect };
