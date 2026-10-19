'use strict';
const ops = require('./ops');
const coordination = require('./config-coordination');
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function file(dataDir) { return ops.dataPath(dataDir, 'connection-settings.json'); }
function read(dataDir) {
  const text = coordination.snapshot(file(dataDir));
  const value = text === null ? { autoReconnect: true } : JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.autoReconnect !== 'boolean') throw new Error('连接设置损坏，请先检查配置；未使用默认值覆盖');
  return { autoReconnect: value.autoReconnect, revision: coordination.revision(text) };
}
function save(dataDir, enabled, revision) {
  if (typeof enabled !== 'boolean' || !/^(missing|[a-f0-9]{64})$/.test(revision || '')) throw new Error('连接设置页面已过期或参数无效，请重新读取');
  read(dataDir); // Corrupt or linked configuration must not be overwritten.
  ops.writeJson(file(dataDir), { autoReconnect: enabled }, { expectedRevision: revision });
  return read(dataDir);
}
function render(dataDir, form) {
  let state;
  try { state = read(dataDir); } catch { return '<section><h3>客户端连接</h3><p class="error" role="status">连接设置暂不可读取；自动恢复暂停，请先检查配置。未覆盖原文件。</p></section>'; }
  const fields = '<input type="hidden" name="connectionRevision" value="' + escape(state.revision) + '"><label><input type="checkbox" name="autoReconnect" value="true"' + (state.autoReconnect ? ' checked' : '') + '> 自动重新连接（默认开启）</label>';
  return '<section class="connection-settings"><style>.connection-settings label{display:flex;flex-direction:row;align-items:center;gap:10px;min-height:44px;min-width:0}.connection-settings input[type=checkbox]{width:20px;max-width:20px;height:20px;min-height:0;padding:0;margin:0;flex:0 0 20px}.connection-settings button{min-height:44px}</style><h3>客户端连接</h3><p>返回前台后先确认原连接是否健康；无法确认时，自动请求SDK恢复连接。不会刷新页面或重发消息，可能短暂中断客户端传输。</p>' + form('set-connection-settings', fields, '保存连接设置') + '<p class="hint">关闭后保留“稍后／重新连接”提示。保存后在下一次恢复检查生效，无需重启核心；自动请求被SDK接管后不再强制重试。</p></section>';
}
module.exports = { read, save, render };
