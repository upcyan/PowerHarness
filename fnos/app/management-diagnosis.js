'use strict';
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]); }
function render({ state, action, diag, csrf, providers }) {
  const legacy = !!diag?.active && !['read-only', 'isolated-profile'].includes(diag.mode);
  const ready = !!diag?.active && diag.mode === 'isolated-profile';
  const items = (providers || []).slice().sort((a, b) => Number(b.models?.some(m => m.supported)) - Number(a.models?.some(m => m.supported)));
  const options = items.map(p => '<option value="' + esc(p.id) + '" data-models="' + esc(JSON.stringify(p.models || [])) + '" data-preferred="' + esc(p.model || '') + '">' + esc(p.id) + (p.reason ? '（暂不支持）' : '') + '</option>').join('');
  return '<section class="ai-diagnosis" aria-labelledby="ai-diagnosis-title"><h2 id="ai-diagnosis-title">AI 专用诊断配置档</h2>'
    + '<p>常驻入口 · <code>fnos-diagnostic</code> · <strong id="diagnosis-profile-status">' + (ready ? '已准备' : legacy ? '旧诊断状态待恢复' : '首次发送时准备') + '</strong></p>'
    + '<p>诊断配置与日常配置档隔离，不加载第三方插件。由管理网关独立调用模型，不依赖 DSH 核心启动，也不代表另一个核心已运行。</p>'
    + '<p class="hint">不会覆盖、切换主配置档或重启核心。AI 只读分析并给出建议，不执行修复；安装、禁用和重启仍由管理员确认。</p>'
    + (legacy ? '<p class="error">检测到旧诊断流程的配置变更，请先确认恢复。原备份：<code>' + esc(diag.backup || '未记录') + '</code></p><div class="actions">' + action('exit-diagnosis', '确认恢复旧诊断前配置') + '</div>' : '<div class="actions">' + action('enter-diagnosis', ready ? '核对诊断配置档' : '准备诊断配置档') + '</div>')
    + '<p id="ai-core-state" class="hint">主核心状态：' + esc(state.mode || 'unknown') + '。支持文本 Chat/API-key；OAuth/Codex 暂不走此独立通道。</p>'
    + (items.some(p => p.temporaryOnly) ? '<p class="hint">配置不可用时提供受控官方 Chat 目录，需输入本次临时密钥，不猜测或复制主配置的凭据。</p>' : '')
    + (!items.length ? '<p class="error">尚未读取到可支持的模型。请检查模型配置或诊断凭据，不要因此重置主配置档。</p>' : '')
    + '<div class="ai-fields"><label>模型 provider<select id="ai-provider">' + options + '</select></label><label>模型<select id="ai-model"></select></label><label>端点（服务器配置/官方目录）<input id="ai-base" type="url" readonly></label><p id="ai-provider-hint" class="hint"></p><label>本次临时密钥（可选，不保存）<input id="ai-key" type="password" autocomplete="off" placeholder="留空使用明确引用的托管 API key"></label></div>'
    + '<label class="ai-context-toggle"><input id="ai-include-context" type="checkbox">附加结构化诊断摘要（仅状态、版本和插件启用/文件检查，不含原始日志、配置或密钥）</label>'
    + '<div class="actions ai-prompts"><button type="button" data-ai-prompt="插件启用或禁用失败，请核对归属预检、当前启用状态、依赖和回滚风险。">插件操作失败</button><button type="button" data-ai-prompt="模型选择丢失或一直加载，请区分 provider、预设依赖、配置档与浏览器连接的问题。">模型无法选择</button><button type="button" data-ai-prompt="页面提示等待宿主连接。请区分客户端实际收到的 SSE、网关转发和宿主状态，不要仅凭 HTTP 200 判定正常。">宿主连接异常</button><button type="button" data-ai-prompt="命令执行发生 EACCES，请核对执行身份、HOME、DSH_HOME 和实际目标目录，不要建议 chmod 777 或放宽根目录权限。">权限与路径错误</button></div>'
    + '<div id="ai-log" role="log" aria-live="polite" aria-label="诊断对话"></div><label>错误信息或问题<textarea id="ai-input" rows="5" maxlength="12000" placeholder="粘贴已脱敏的错误，说明触发操作与时间"></textarea></label><input id="ai-csrf" type="hidden" value="' + esc(csrf) + '"><div class="actions"><button type="button" id="ai-send">发送并诊断</button><button type="button" id="ai-cancel" disabled>取消请求</button><button type="button" id="ai-clear">清空对话</button></div><p class="hint">发送前请遮盖个人信息；只发送本次输入和最近对话。临时密钥不写入配置，也不会随诊断摘要发送。</p></section>';
}
function installClient() {
  const log = document.getElementById('ai-log');
  const input = document.getElementById('ai-input');
  const button = document.getElementById('ai-send');
  if (!log || !input || !button) return;
  const provider = document.getElementById('ai-provider');
  const model = document.getElementById('ai-model');
  const endpoint = document.getElementById('ai-base');
  const key = document.getElementById('ai-key');
  const hint = document.getElementById('ai-provider-hint');
  const cancel = document.getElementById('ai-cancel');
  const history = [];
  let models = [], generation = 0, controller = null, busy = false;
  const update = () => {
    const selected = models.find(item => item.id === model.value);
    endpoint.value = selected?.baseURL || '';
    const temporaryUnsupported = key.value.trim() && !['deepseek', 'openai'].includes(provider.value);
    button.disabled = busy || !!temporaryUnsupported || !(selected?.supported && endpoint.value);
    cancel.disabled = !busy;
    hint.textContent = temporaryUnsupported ? '本次临时密钥仅可用于官方 DeepSeek / OpenAI Chat 目录，请切换 provider；不会发送到自定义端点。' : !(selected?.supported && endpoint.value) ? '此模型不支持独立 Chat/API-key 诊断。请选择支持的模型；不能用普通端点代替 OAuth。' : '端点由服务器核对，不能覆盖为其他地址；无需切换或重启主核心。';
  };
  const abort = () => { generation++; controller?.abort(); controller = null; busy = false; update(); };
  const clear = () => { abort(); history.length = 0; log.replaceChildren(); key.value = ''; };
  const applyProvider = () => {
    clear();
    const option = provider.selectedOptions[0];
    try { models = JSON.parse(option?.dataset.models || '[]'); } catch { models = []; }
    model.replaceChildren();
    for (const item of models) { const node = document.createElement('option'); node.value = item.id; node.textContent = item.id + (item.supported ? '' : '（暂不支持）'); model.appendChild(node); }
    const preferred = models.find(item => item.id === option?.dataset.preferred && item.supported) || models.find(item => item.supported);
    if (preferred) model.value = preferred.id;
    update();
  };
  const append = (role, text) => {
    const node = document.createElement('div'); node.className = 'ai-message'; node.textContent = (role === 'user' ? '我：' : 'AI：') + text;
    log.appendChild(node); while (log.children.length > 24) log.firstElementChild.remove(); log.scrollTop = log.scrollHeight; return node;
  };
  applyProvider();
  provider.addEventListener('change', applyProvider);
  key.addEventListener('input', update);
  model.addEventListener('change', () => { clear(); update(); });
  cancel.addEventListener('click', () => { abort(); key.value = ''; append('assistant', '本次诊断已取消。输入内容已保留。'); });
  document.getElementById('ai-clear').addEventListener('click', clear);
  document.querySelectorAll('[data-ai-prompt]').forEach(node => node.addEventListener('click', () => { input.value = node.dataset.aiPrompt; input.focus(); }));
  const send = async () => {
    const message = input.value.trim();
    if (!message || button.disabled || busy) return;
    const token = ++generation;
    busy = true; controller = new AbortController(); update();
    append('user', message); const pending = append('assistant', '正在只读诊断…');
    const activeController = controller;
    const deadline = setTimeout(() => activeController.abort(), 125000);
    try {
      const response = await fetch('/__fnos/ai-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: activeController.signal,
        body: JSON.stringify({ csrf: document.getElementById('ai-csrf').value, provider: provider.value, model: model.value, baseURL: endpoint.value,
          apiKey: key.value, message, history, includeContext: document.getElementById('ai-include-context').checked === true }) });
      const data = await response.json();
      if (token !== generation) return;
      if (!response.ok || data.ok !== true) { pending.textContent = '⚠ ' + (data.error || '请求失败（HTTP ' + response.status + '）'); return; }
      pending.textContent = 'AI：' + data.reply;
      history.push({ role: 'user', content: message }, { role: 'assistant', content: String(data.reply).slice(0, 12000) });
      if (history.length > 10) history.splice(0, history.length - 10);
      if (input.value.trim() === message) input.value = '';
      document.getElementById('diagnosis-profile-status').textContent = '已准备 · 本次诊断完成';
    } catch (error) {
      if (token === generation) pending.textContent = activeController.signal.aborted ? '⚠ 请求已取消或超时，输入内容已保留。' : '⚠ 诊断连接失败，输入内容已保留。';
    } finally {
      clearTimeout(deadline);
      if (token === generation) { busy = false; controller = null; key.value = ''; update(); log.scrollTop = log.scrollHeight; input.focus(); }
    }
  };
  button.addEventListener('click', send);
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } });
  window.addEventListener('pagehide', () => { abort(); key.value = ''; });
}
const styles = '.ai-diagnosis{min-width:0}.ai-diagnosis .ai-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.ai-diagnosis .ai-fields>p{grid-column:1/-1}.ai-diagnosis .ai-context-toggle{display:flex;align-items:flex-start;gap:8px;margin:16px 0}.ai-context-toggle input[type=checkbox]{width:20px;height:20px;flex:0 0 20px;margin:2px 0}.ai-diagnosis .actions{flex-wrap:wrap}.ai-prompts{margin:16px 0}.ai-message{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0}#ai-log{max-height:420px;overflow:auto}';
module.exports = { render, styles, installClient, clientScript: () => '(' + installClient.toString() + ')();' };
