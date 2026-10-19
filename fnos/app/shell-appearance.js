'use strict';

// The outer shell owns fnOS navigation and confirmation. The client owns the
// caption. Only a ready child can collapse this shell's old management banner.
function installShellAppearance(win, doc) {
  const frame = doc.querySelector('iframe[name="dsh-frame"]');
  const nav = doc.querySelector('nav[aria-label="应用导航"]');
  if (!frame || !nav) return { dispose() {} };
  const targets = { console: nav.querySelector('#console-open'), settings: nav.querySelector('#settings-nav'),
    refresh: nav.querySelector('#dsh-nav'), diagnostics: nav.querySelector('#diagnose') };
  const actions = Object.keys(targets).filter(key => targets[key]);
  const keys = ['sidebar', 'base', 'primary', 'secondary', 'hover', 'accent', 'border'];
  const style = doc.createElement('style'); style.dataset.plugin = 'dsh-ui-cyanmod-shell-bridge';
  style.textContent = 'header:has(nav[aria-label="应用导航"]){display:none!important}';
  let disposed = false, suspended = false, session = '', sequence = -1, actionId = 0, pendingRefresh = null;
  // 首屏内联规则（gateway.js 的 #shell-boot-banner）让老横幅**从一开始就不可见**，
  // 消除「先看到横幅、握手完成才消失」的闪烁。这里负责两条收敛路径：
  //   · 握手成功 → 由 style（display:none）接管，横幅保持隐藏；
  //   · 握手失败 / 子层始终不响应 → **撤掉内联规则、把横幅还回来**。
  //     ⚠ 不能省：横幅里是控制台／刷新／应用设置三个入口，若 cyanmod 未安装或被停用，
  //       永久隐藏会让用户**失去入口且无法自行恢复** ——
  //       这正是本文件开头「only a ready child can collapse this banner」的用意。
  const bootStyle = doc.getElementById('shell-boot-banner');
  const REVEAL_NO_REPLY = 4000;   // 子层完全没回话：cyanmod 未装/未加载
  const REVEAL_DISABLED = 2500;   // 子层明确说 enabled=false：留宽限，避免启动期 transient false 造成闪回
  let revealTimer = 0, revealAt = Infinity;
  const cancelReveal = () => { if (revealTimer) { win.clearTimeout(revealTimer); revealTimer = 0; } revealAt = Infinity; };
  /**
   * 安排"把横幅还回来"。
   * ⚠ 取**最早**的期限，而不是"已有计时器就不再安排"（第一版即此写法，被用例抓到）：
   *   启动时 request() 先排了 4000ms（无回应），随后子层回 enabled=false 想改 2500ms，
   *   却因已有计时器被忽略 ⇒ 实际仍等 4 秒，与"明确不可用就早点还入口"的意图不符。
   *   改成：新期限更早则重设，更晚则不动（不能让后来的长期限推迟已经确定的短期限）。
   */
  const revealLater = (ms) => {
    const at = Date.now() + ms;
    if (at >= revealAt) return;                       // 已有更早的期限
    if (revealTimer) win.clearTimeout(revealTimer);
    revealAt = at;
    revealTimer = win.setTimeout(() => {
      revealTimer = 0; revealAt = Infinity;
      // 复查：宽限期内若已被 style 接管（连上了），就不还横幅
      if (!style.isConnected) { try { bootStyle?.remove(); } catch { /* ignore */ } }
    }, Math.max(0, at - Date.now()));
  };
  const refreshDialog = doc.getElementById('refresh-confirm');
  const refreshClosed = () => {
    const item = pendingRefresh; pendingRefresh = null;
    if (item && !disposed && !suspended && item.session === session) item.source.postMessage({
      type: 'dsh-fnos-shell-action-complete', version: 3, session, requestId: item.requestId, action: 'refresh'
    }, item.origin);
  };
  const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(key => Object.prototype.hasOwnProperty.call(value, key));
  const rgba = v => Array.isArray(v) && v.length === 4 && v.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
  const origin = () => { try { const u = new URL(frame.getAttribute('src'), win.location.href); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } };
  const reset = () => { style.remove(); session = ''; sequence = -1; actionId = 0; pendingRefresh = null; };
  const request = () => {
    if (disposed || suspended) return;
    reset(); if (!frame.isConnected || !origin()) return;
    const bytes = new Uint8Array(16); win.crypto.getRandomValues(bytes);
    session = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
    frame.contentWindow.postMessage({ type: 'dsh-fnos-shell-theme-request', version: 3, session }, origin());
    // 子层完全没回话（cyanmod 未安装/未加载/脚本报错）⇒ 超时把横幅还回来。
    // 每次 request 重新计时：子层重载/换 src 都会再发一轮，上轮的计时不该拖累这轮。
    cancelReveal(); revealLater(REVEAL_NO_REPLY);
  };
  const ack = (source, target, n) => source.postMessage({ type: 'dsh-fnos-shell-theme-ack', version: 3,
    session, sequence: n, applied: style.isConnected, actions }, target);
  const receive = event => {
    if (disposed || suspended || !event.isTrusted || event.source !== frame.contentWindow || !origin() || event.origin !== origin()) return;
    const d = event.data;
    if (exact(d, ['type', 'version']) && d.type === 'dsh-ui-cyanmod-shell-ready' && d.version === 3) { request(); return; }
    if (exact(d, ['type', 'version', 'session', 'requestId', 'action']) && d.type === 'dsh-ui-cyanmod-shell-action' && d.version === 3 &&
        session && d.session === session && Number.isSafeInteger(d.requestId) && d.requestId > actionId && style.isConnected && actions.includes(d.action)) {
      actionId = d.requestId; const target = targets[d.action]; let ok = false;
      if (target && target.isConnected && !target.disabled) {
        if (d.action === 'refresh') pendingRefresh = { source: event.source, origin: event.origin, session, requestId: d.requestId };
        try { target.click(); ok = true; } catch { pendingRefresh = null; }
      }
      event.source.postMessage({ type: 'dsh-fnos-shell-action-ack', version: 3, session, requestId: d.requestId, ok }, event.origin);
      if (d.action === 'refresh' && pendingRefresh && !refreshDialog?.open) refreshClosed();
      return;
    }
    if (!exact(d, ['type', 'version', 'session', 'sequence', 'enabled', 'ready', 'colors']) || d.type !== 'dsh-ui-cyanmod-shell-theme' || d.version !== 3 ||
        !session || d.session !== session || !Number.isSafeInteger(d.sequence) || d.sequence < 0 || d.sequence < sequence ||
        typeof d.enabled !== 'boolean' || typeof d.ready !== 'boolean' ||
        (d.enabled ? !exact(d.colors, keys) || !keys.every(key => rgba(d.colors[key])) : d.colors !== null)) return;
    if (d.sequence === sequence) { ack(event.source, event.origin, d.sequence); return; }
    if (d.enabled && d.ready && actions.length === 4) {
      if (!style.isConnected) doc.head.append(style);
      cancelReveal();          // 连上了：横幅由 style 保持隐藏，不要再还回来
    } else {
      style.remove();
      revealLater(REVEAL_DISABLED);   // 子层明确不可用 ⇒ 宽限后把入口还给用户
    }
    sequence = d.sequence; ack(event.source, event.origin, d.sequence);
  };
  const hide = () => { suspended = true; reset(); }, show = () => { suspended = false; request(); };
  const observer = new win.MutationObserver(request); observer.observe(frame, { attributes: true, attributeFilter: ['src'] });
  refreshDialog?.addEventListener('close', refreshClosed);
  win.addEventListener('message', receive); win.addEventListener('pagehide', hide); win.addEventListener('pageshow', show); frame.addEventListener('load', request); request();
  return { dispose() { if (disposed) return; disposed = true; cancelReveal(); reset(); observer.disconnect(); refreshDialog?.removeEventListener('close', refreshClosed); win.removeEventListener('message', receive);
    win.removeEventListener('pagehide', hide); win.removeEventListener('pageshow', show); frame.removeEventListener('load', request); } };
}
module.exports = { installShellAppearance };
