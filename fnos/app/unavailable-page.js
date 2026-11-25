'use strict';
const recovery = require('./recovery-status');
const theme = require('./management-theme');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function installPlaceholder(options) {
  let hosted = false, reopened = false;
  let parentOrigin = location.ancestorOrigins?.[0] || null;
  try { if (document.referrer) parentOrigin = new URL(document.referrer).origin; } catch {}
  const title = document.getElementById('recovery-page-title');
  const description = document.getElementById('recovery-page-description');
  function update(mode) {
    if (mode === 'ready' || mode === 'rollback') {
      title.textContent = '核心已就绪，正在重新打开 DSH';
      description.textContent = '若没有进入 DSH，请点击“重新打开 DSH”再试一次。';
      if (!reopened) { reopened = true; location.reload(); }
    } else {
      title.textContent = mode === 'starting' ? 'DSH 正在启动' : mode === 'maintenance' ? 'DSH 正在维护' : 'DSH 核心尚未就绪';
      description.textContent = '此页每隔几秒自动检查启动状态，就绪后会尝试重新打开 DSH。若仍停留在此页，请点击“重新打开 DSH”尝试；也可先打开控制台查看日志。';
    }
  }
  const onMessage = e => {
    if (parent === window || e.source !== parent || (parentOrigin && e.origin !== parentOrigin) || e.data?.type !== 'fnos:host-recovery') return;
    parentOrigin = e.origin; // A parent-only handshake carries status, never credentials or actions.
    hosted = true;
    parent.postMessage({type:'fnos:placeholder-owned'}, parentOrigin);
    document.getElementById('boot-status').hidden = true;
    window.__fnosRecovery?.destroy();
    update(e.data.mode);
  };
  window.addEventListener('message', onMessage);
  document.getElementById('refresh').onclick = () => location.reload();
  document.querySelector('.recovery-footer a').addEventListener('click',()=>{if(parent!==window)parent.postMessage({type:'dsh-fnos-view',view:'settings'},parentOrigin);});
  window.addEventListener('fnos:recovery-state', e => { if (!hosted) update(e.detail.mode); });
  // Same-origin desktop shell owns the banner and polling; standalone keeps its own.
  if (parent !== window) parent.postMessage({type:'fnos:unavailable'}, parentOrigin || '*');
  const timer = setTimeout(() => { if (!hosted) window.__fnosRecovery = window.__startRecovery(); }, 500);
  window.addEventListener('pagehide', () => { clearTimeout(timer); window.removeEventListener('message', onMessage); window.__fnosRecovery?.destroy(); }, {once:true});
}
function render(state, {nonce='', settingsUrl='/__fnos/?view=runtime'} = {}) {
  const base = settingsUrl.split('?')[0];
  const title = state?.mode === 'starting' ? 'DSH 正在启动' : state?.mode === 'maintenance' ? 'DSH 正在维护' : 'DSH 核心尚未就绪';
  const css = '.recovery-page{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--mg-soft);color:var(--mg-text);font:15px/1.7 var(--mg-font)}.recovery-workspace{width:min(760px,100%);padding:32px 24px;box-sizing:border-box}.recovery-workspace h1{font-size:24px;line-height:1.4;margin:0 0 12px}.recovery-workspace>p{color:var(--mg-muted);margin:0 0 20px}.recovery-footer{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}.recovery-footer :is(a,button){min-height:44px;padding:9px 14px;border:1px solid var(--mg-border-strong);border-radius:9px;color:var(--mg-text);background:var(--mg-panel);font:inherit;text-decoration:none;cursor:pointer;box-sizing:border-box}.recovery-note{font-size:13px;margin-top:16px}@media(max-width:480px){.recovery-workspace{padding:24px 14px}.recovery-workspace h1{font-size:21px}.recovery-footer>*{flex:1 1 auto;text-align:center}}';
  return '<!doctype html><html lang="zh-CN" data-fnos-surface="unavailable"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>'+esc(title)+'</title><style>'+theme.css+recovery.styles+css+'</style></head><body class="recovery-page"><main class="recovery-workspace"><h1 id="recovery-page-title">'+esc(title)+'</h1><p id="recovery-page-description">此页会自动检查启动状态，就绪后尝试重新打开 DSH。若仍停留在此页，请点击“重新打开 DSH”尝试；控制台和诊断不受核心启动影响。</p>'+recovery.render(state,{settingsUrl})+'<div class="recovery-footer"><a href="'+esc(settingsUrl)+'">打开控制台</a><button id="refresh" type="button">重新打开 DSH</button></div><p class="recovery-note">只自动重新打开本启动页，不会打断你在控制台中的操作。</p></main><script nonce="'+esc(nonce)+'">window.__startRecovery=function(){'+recovery.script({statePath:base+'state',instanceKey:base,showReady:true})+'return window.__fnosRecovery;};('+installPlaceholder.toString()+')({});</script></body></html>';
}
module.exports = {render};
