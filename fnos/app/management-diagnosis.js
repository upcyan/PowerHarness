'use strict';
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function render({state,action,diag,csrf,providers}) {
 const legacy=!!diag?.active&&!['read-only','isolated-profile'].includes(diag.mode),ready=!!diag?.active&&diag.mode==='isolated-profile';
 const items=(providers||[]).slice().sort((a,b)=>Number(b.models?.some(m=>m.supported))-Number(a.models?.some(m=>m.supported)));
 const options=items.map(p=>'<option value="'+esc(p.id)+'" data-models="'+esc(JSON.stringify(p.models||[]))+'" data-preferred="'+esc(p.model||'')+'">'+esc(p.id)+(p.reason?'（暂不支持）':'')+'</option>').join('');
 return '<section class="ai-diagnosis" aria-labelledby="ai-diagnosis-title"><div class="ai-heading"><div><p class="ai-eyebrow">独立于主核心</p><h2 id="ai-diagnosis-title">AI 故障诊断</h2></div><span class="ai-safety-tag">只读 · 不执行修复</span></div>'
 +'<p class="ai-intro">先确认现象和证据，再决定是否修复。核心无法启动时，本页仍可使用；不会切换主配置档或重启核心。</p>'
 +'<p id="ai-core-state" class="hint">主核心状态：'+esc(state.mode||'unknown')+'。不把页面等待或日志停滞等同于核心停止。</p>'
 +(legacy?'<p class="error">旧诊断流程仍有待恢复状态，请先确认原备份：<code>'+esc(diag.backup||'未记录')+'</code></p><div class="actions">'+action('exit-diagnosis','确认恢复旧诊断前配置')+'</div>':'')
 +'<details class="ai-profile-detail"><summary>独立诊断配置档 · <strong id="diagnosis-profile-status">'+(ready?'已准备':legacy?'旧诊断状态待恢复':'首次发送时准备')+'</strong></summary><p><code>fnos-diagnostic</code> 不加载第三方插件，不代表另一个核心已运行。</p><div class="actions">'+(!legacy?action('enter-diagnosis','核对诊断配置档'):'')+'</div></details>'
 +'<div class="ai-fields"><label>模型渠道<select id="ai-provider">'+options+'</select></label><label>诊断模型<select id="ai-model"></select></label><p id="ai-provider-hint" class="hint"></p></div>'
 +'<details class="ai-private-config"><summary>连接与本次临时密钥</summary><div class="ai-fields"><label>端点（服务器核对）<input id="ai-base" type="url" readonly></label><label>本次临时密钥（可选，不保存）<input id="ai-key" type="password" autocomplete="off" placeholder="留空仅使用明确引用的托管 API key"></label></div><p class="hint">独立诊断仅支持 Chat/API-key；OAuth/Codex 暂不支持。临时密钥仅发往受控官方端点，不会写入配置或诊断摘要。</p></details>'
 +(!items.length?'<p class="error">暂未读取到可支持的模型。仍可预览只读摘要、查看日志；不要因此重置主配置档。</p>':'')
 +'<div class="ai-context-tools"><label class="ai-context-toggle"><input id="ai-include-context" type="checkbox"><span>附加白名单状态摘要<span class="hint">仅状态、实例标识、版本和插件文件检查；不含原始日志、配置或密钥。</span></span></label><button type="button" id="ai-preview-context">预览诊断摘要</button></div>'
 +'<details id="ai-context-details"><summary>查看摘要内容与采样时间</summary><textarea id="ai-context-preview" readonly rows="6" aria-label="仅供预览的脱敏诊断摘要" placeholder="点击预览诊断摘要，仅在服务器本地采集，不调用模型。"></textarea></details>'
 +'<div class="actions ai-prompts"><button type="button" data-ai-prompt="核心启动期间连续90秒无输出。请区分输出停滞、进程存在、端口监听与服务就绪，先给出最小只读检查，不建议盲目重启。">启动卡住</button><button type="button" data-ai-prompt="插件启用或禁用失败。请先核对当前实例、归属、依赖和回滚风险，不要直接重置配置。">插件操作失败</button><button type="button" data-ai-prompt="页面提示等待宿主连接。请区分客户端实际收到的 SSE、网关与核心状态，不要仅凭 HTTP 200 判定正常。">宿主连接异常</button><button type="button" data-ai-prompt="命令执行发生 EACCES。请核对实际执行身份、实例与目标路径，不要建议递归 chown、chmod 777 或放宽卷根权限。">权限与路径</button></div>'
 +'<div id="ai-log" role="log" aria-live="polite" aria-label="诊断对话" hidden></div><label class="ai-question">描述现象或粘贴脱敏错误<textarea id="ai-input" rows="5" maxlength="12000" placeholder="说明在哪个实例、做了什么、何时开始；粘贴前移除敏感信息。"></textarea></label><input id="ai-csrf" type="hidden" value="'+esc(csrf)+'">'
 +'<div class="actions ai-actions"><button type="button" id="ai-send">发送并诊断</button><button type="button" id="ai-cancel" disabled>取消请求</button><button type="button" id="ai-copy">复制对话</button><button type="button" id="ai-clear">清空对话</button></div><p id="ai-copy-status" class="hint" role="status"></p><p class="hint">发送前会确认接收端点和摘要范围。失败或取消保留输入；安装、配置变更、恢复和重启仍需管理员单独确认。</p></section>';
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
  const previewButton=document.getElementById('ai-preview-context'),previewBox=document.getElementById('ai-context-preview'),previewDetails=document.getElementById('ai-context-details'),contextToggle=document.getElementById('ai-include-context');
  let models=[],generation=0,controller=null,busy=false,previewBusy=false,previewed=false,contextController=null,contextGeneration=0,pageActive=true;
  const update = () => {
    const selected = models.find(item => item.id === model.value);
    endpoint.value = selected?.baseURL || '';
    const temporaryUnsupported = key.value.trim() && !['deepseek', 'openai'].includes(provider.value);
    button.disabled = busy || previewBusy || !!temporaryUnsupported || !(selected?.supported && endpoint.value);
    cancel.disabled = !busy && !previewBusy;
    previewButton.disabled=busy||previewBusy;
    window.__fnosDiagnosticBusy=busy||previewBusy;
    hint.textContent = temporaryUnsupported ? '本次临时密钥仅可用于官方 DeepSeek / OpenAI Chat 目录，请切换 provider；不会发送到自定义端点。' : !(selected?.supported && endpoint.value) ? '此模型不支持独立 Chat/API-key 诊断。请选择支持的模型；不能用普通端点代替 OAuth。' : '端点由服务器核对，不能覆盖为其他地址；无需切换或重启主核心。';
  };
  const abort=()=>{generation++;contextGeneration++;controller?.abort();contextController?.abort();controller=null;contextController=null;busy=false;previewBusy=false;update();};
  const clear=()=>{abort();history.length=0;log.replaceChildren();log.hidden=true;key.value='';previewed=false;previewBox.value='';previewDetails.open=false;};
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
    const node = document.createElement('div'); node.className = 'ai-message'; node.dataset.role=role; log.hidden=false; node.textContent = (role === 'user' ? '我：' : 'AI：') + text;
    log.appendChild(node); while (log.children.length > 24) log.firstElementChild.remove(); log.scrollTop = log.scrollHeight; return node;
  };
  const previewContext=async()=>{
    if(previewBusy||busy||!pageActive)return false;
    const token=++contextGeneration;previewBusy=true;previewed=false;contextController=new AbortController();const active=contextController;
    const deadline=setTimeout(()=>active.abort(),10000);previewDetails.open=true;previewBox.value='正在只读采集；不会调用模型或读取凭据。';update();
    try{
      const response=await fetch('/__fnos/ai-chat',{method:'POST',headers:{'Content-Type':'application/json'},signal:active.signal,
        body:JSON.stringify({csrf:document.getElementById('ai-csrf').value,action:'preview-context'})});
      const data=await response.json();if(token!==contextGeneration||!pageActive)return false;
      if(!response.ok||data.ok!==true||!data.context)throw Error('context unavailable');
      previewBox.value=JSON.stringify(data.context,null,2);previewed=true;return true;
    }catch{if(token===contextGeneration)previewBox.value='摘要采集未完成；未调用模型，输入内容保持不变。';return false;}
    finally{clearTimeout(deadline);if(token===contextGeneration){previewBusy=false;contextController=null;update();}}
  };
  previewButton.addEventListener('click',()=>void previewContext());
  contextToggle.addEventListener('change',()=>{if(contextToggle.checked&&!previewed)void previewContext();});
  document.getElementById('ai-copy').addEventListener('click',async()=>{
    const transcript=Array.from(log.children).map(node=>node.textContent).join(String.fromCharCode(10));
    try{if(!navigator.clipboard?.writeText)throw Error('clipboard unavailable');await navigator.clipboard.writeText(transcript);document.getElementById('ai-copy-status').textContent='诊断对话已复制，请分享前再次检查。';}
    catch{document.getElementById('ai-copy-status').textContent='复制不可用，可长按选择对话文本；临时密钥不会包含在内。';}
  });
  applyProvider();
  provider.addEventListener('change', applyProvider);
  key.addEventListener('input', update);
  model.addEventListener('change', () => { clear(); update(); });
  cancel.addEventListener('click', () => { abort(); key.value = ''; append('assistant', '本次诊断已取消。输入内容已保留。'); });
  document.getElementById('ai-clear').addEventListener('click', clear);
  document.querySelectorAll('[data-ai-prompt]').forEach(node => node.addEventListener('click', () => { input.value = node.dataset.aiPrompt; input.focus(); }));
  const send = async () => {
    let message = input.value.trim();
    if (!message || button.disabled || busy) return;
    if(contextToggle.checked&&!previewed&&!(await previewContext()))return;
    if(!pageActive)return;message=input.value.trim();if(!message)return;
    const attach=contextToggle.checked===true;
    const target=endpoint.value;
    if(typeof window.confirm!=='function'||!window.confirm('将本次输入和最近对话发送到 '+target+'。'+(attach?'附加白名单摘要；发送时重新采集同类状态。':'不附加服务器状态、日志或配置。')+'不会自动执行修复，是否继续？'))return;
    const token = ++generation;
    busy = true; controller = new AbortController(); update();
    append('user', message); const pending = append('assistant', '正在只读诊断…');
    const activeController = controller;
    const deadline = setTimeout(() => activeController.abort(), 125000);
    try {
      const response = await fetch('/__fnos/ai-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: activeController.signal,
        body: JSON.stringify({ csrf: document.getElementById('ai-csrf').value, provider: provider.value, model: model.value, baseURL: endpoint.value,
          apiKey: key.value, message, history, includeContext: attach }) });
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
  window.addEventListener('pagehide',()=>{pageActive=false;abort();key.value='';});
  window.addEventListener('pageshow',()=>{pageActive=true;update();});
}

const styles=".ai-diagnosis{min-width:0}.ai-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.ai-heading h2{margin:2px 0 0!important}.ai-eyebrow{margin:0;color:var(--mg-muted);font-size:12px}.ai-safety-tag{padding:4px 9px;border:1px solid var(--mg-border-strong);border-radius:7px;font-size:12px;color:var(--mg-muted)}.ai-intro{max-width:70ch;line-height:1.75}.ai-profile-detail,.ai-private-config{margin:16px 0;padding:10px 0;border-top:1px solid var(--mg-border)}.ai-diagnosis summary{cursor:pointer;min-height:32px;line-height:1.6;color:var(--mg-muted)}.ai-diagnosis .ai-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start;margin:16px 0}.ai-diagnosis .ai-fields>p{grid-column:1/-1;margin:0}.ai-diagnosis label{display:block;min-width:0;line-height:1.6}.ai-diagnosis label :is(input:not([type=checkbox]),select,textarea){display:block;width:100%;min-width:0;box-sizing:border-box;margin:6px 0 0;min-height:44px;padding:9px 11px;border:1px solid var(--mg-border-strong);border-radius:9px;background:var(--mg-panel);color:var(--mg-text);font:14px/1.6 var(--mg-font)}.ai-diagnosis .ai-context-tools{display:flex;gap:14px;justify-content:space-between;align-items:center;flex-wrap:wrap;margin:18px 0 8px}.ai-diagnosis .ai-context-toggle{display:flex;align-items:flex-start;gap:8px;flex:1 1 280px;margin:0}.ai-context-toggle .hint{display:block;font-size:12px;margin-top:3px;line-height:1.6}.ai-context-toggle input[type=checkbox]{width:20px;height:20px;flex:0 0 20px;margin:2px 0}.ai-diagnosis button{min-height:44px;line-height:1.5;padding:9px 12px;box-sizing:border-box}.ai-diagnosis button:disabled{opacity:.55;cursor:not-allowed}.ai-diagnosis #ai-context-preview{display:block;box-sizing:border-box;width:100%;min-height:150px;margin:8px 0;padding:12px;border:1px solid var(--mg-border-strong);border-radius:9px;background:var(--mg-soft);color:var(--mg-text);font:12px/1.7 ui-monospace,monospace;resize:vertical}.ai-diagnosis .ai-prompts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:20px 0}.ai-prompts button{width:100%;min-width:0;margin:0;background:var(--mg-soft);color:var(--mg-text);border:1px solid var(--mg-border)}.ai-diagnosis #ai-log{max-height:420px;overflow:auto;margin:20px 0;padding:2px 16px;border:1px solid var(--mg-border);border-radius:10px;background:var(--mg-softer)}.ai-diagnosis #ai-log[hidden]{display:none}.ai-message{white-space:pre-wrap;overflow-wrap:anywhere;margin:14px 0;line-height:1.75}.ai-message[data-role=user]{color:var(--mg-muted);padding-bottom:12px;border-bottom:1px solid var(--mg-border)}.ai-diagnosis .ai-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}.ai-actions #ai-send{background:var(--mg-accent);color:white;border:1px solid var(--mg-accent)}.ai-actions :not(#ai-send){background:var(--mg-panel);color:var(--mg-text);border:1px solid var(--mg-border-strong)}.ai-question textarea{resize:vertical;min-height:128px}.ai-diagnosis :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--mg-accent);outline-offset:2px}@media(max-width:600px){.ai-heading{align-items:flex-start}.ai-diagnosis .ai-prompts{grid-template-columns:repeat(2,minmax(0,1fr))}.ai-diagnosis .ai-fields{gap:10px}.ai-diagnosis .ai-fields label{font-size:13px}.ai-context-tools>button{width:100%}.ai-actions #ai-send{flex:1 1 100%}.ai-actions>button{flex:1 1 auto}.ai-diagnosis #ai-log{padding:2px 12px}}@media(prefers-reduced-motion:reduce){.ai-diagnosis *{scroll-behavior:auto;transition:none}}";
module.exports={render,styles,installClient,clientScript:()=> '('+installClient.toString()+')();'};
