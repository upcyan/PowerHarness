'use strict';
// Runs only in the outer shell. A confirmed core outage must not trap management views.
function install(options = {}) {
  const frame = document.querySelector('iframe[name="dsh-frame"]');
  const banner = document.getElementById('boot-status');
  if (!frame || !banner) return;
  options.frameOrigin = options.frameOrigin || location.origin;
  let mode = banner.dataset.mode, everReady = mode === 'ready' || mode === 'rollback';
  let view = 'dsh', placeholder = false, destroyed = false, outage = false;
  const overlay = document.createElement('section');
  overlay.id = 'dsh-outage'; overlay.hidden = true;
  overlay.setAttribute('role', 'alert');
  overlay.innerHTML = '<div><h1>DSH 核心连接已中断</h1><p id="dsh-outage-text">当前 DSH 页面已经无法继续使用。控制台和诊断仍然可用。</p><a id="dsh-outage-console" target="dsh-frame">打开控制台</a><button id="dsh-outage-reopen" type="button">重新打开 DSH</button></div>';
  const style = document.createElement('style');
  style.textContent = '#dsh-outage{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:24px;background:var(--dsh-shell-bg,#f5f7fb);color:var(--dsh-shell-text,#17202e)}#dsh-outage[hidden]{display:none!important}#dsh-outage>div{max-width:640px}#dsh-outage h1{font-size:24px}#dsh-outage p{line-height:1.8}#dsh-outage a,#dsh-outage button{display:inline-flex;align-items:center;min-height:44px;margin:6px 10px 0 0;padding:10px 16px;border:1px solid #98a2b3;border-radius:9px;background:transparent;color:inherit;font:inherit;text-decoration:none;cursor:pointer}';
  document.head.append(style); document.body.append(overlay);
  const consoleLink = overlay.querySelector('a'); consoleLink.href = options.settingsUrl;
  const blocked = () => ['starting','safe','maintenance','setup'].includes(mode);
  const draw = () => {
    const show = everReady && view === 'dsh' && !placeholder && (blocked() || outage);
    overlay.hidden = !show;
    // One state surface: the placeholder or outage owns the content, not a second banner.
    banner.hidden = show || mode === 'ready' || mode === 'rollback';
    if (show) overlay.querySelector('p').textContent = !blocked()
      ? '核心已恢复，但原 DSH 页面不会自动恢复。请点击“重新打开 DSH”尝试，或进入控制台继续排障。'
      : mode === 'starting'
      ? '核心正在重新启动，旧 DSH 页面暂不可用。状态会自动更新；稍后可点击“重新打开 DSH”尝试。'
      : '当前 DSH 页面已经无法继续使用。请打开控制台查看日志或使用 AI 诊断；恢复后可点击“重新打开 DSH”。';
  };
  const frameOrigin = () => new URL(frame.src, location.href).origin;
  const notify = () => frame.contentWindow.postMessage({type:'fnos:host-recovery',mode}, frameOrigin());
  const enter = next => { view = next; if (next === 'settings') placeholder = false; draw(); };
  const onState = e => { mode = e.detail.mode; if (everReady && blocked()) outage = true; if (mode === 'ready' || mode === 'rollback') everReady = true; notify(); draw(); };
  const onMessage = e => {
    if (e.source !== frame.contentWindow || e.origin !== frameOrigin()) return;
    if (e.data?.type === 'fnos:unavailable') { placeholder = true; view = 'dsh'; notify(); draw(); }
    if (e.data?.type === 'fnos:placeholder-owned') { placeholder = true; draw(); }
    if (e.data?.type === 'dsh-fnos-view') enter(e.data.view === 'settings' ? 'settings' : 'dsh');
  };
  const onLoad = () => {
    placeholder = false; outage = false;
    try { placeholder = frame.contentDocument?.documentElement.dataset.fnosSurface === 'unavailable'; } catch { /* direct-mode handshake */ }
    notify(); if (view === 'settings') frame.contentWindow?.postMessage({ type: 'fnos:host-recovery', mode }, options.frameOrigin); draw();
  };
  const goConsole = () => { enter('settings'); window.__fnosRecovery?.enterConsole(); };
  const goDsh = () => { outage = false; enter('dsh'); placeholder = false; overlay.hidden = true; };
  const reopen = () => { goDsh(); frame.src = options.dshUrl; };
  const settings = document.getElementById('settings-nav'), dsh = document.getElementById('dsh-nav');
  const confirm = document.getElementById('refresh-accept');
  consoleLink.addEventListener('click',()=>{goConsole();window.dispatchEvent(new CustomEvent('fnos:recovery-navigate'));}); overlay.querySelector('button').addEventListener('click',reopen);
  settings?.addEventListener('click',goConsole); dsh?.addEventListener('click',goDsh); confirm?.addEventListener('click',goDsh);
  window.addEventListener('fnos:recovery-navigate',goConsole);
  window.addEventListener('fnos:recovery-state',onState); window.addEventListener('message',onMessage); frame.addEventListener('load',onLoad);
  const cleanup = () => { if(destroyed)return;destroyed=true;window.removeEventListener('fnos:recovery-state',onState);window.removeEventListener('message',onMessage);window.removeEventListener('fnos:recovery-navigate',goConsole);frame.removeEventListener('load',onLoad);settings?.removeEventListener('click',goConsole);dsh?.removeEventListener('click',goDsh);confirm?.removeEventListener('click',goDsh); };
  window.addEventListener('pagehide',cleanup,{once:true}); draw();
}
module.exports = { install, script: options => '(' + install.toString() + ')(' + JSON.stringify(options).replace(/</g,'\u003c') + ');' };
