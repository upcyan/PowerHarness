import fs from 'node:fs';
import path from 'node:path';

const runtime = process.argv[2];
if (!runtime) throw new Error('Pass the installed runtime directory');

// Resolve a @deepseek-ai package directory. npm may hoist the package to the
// top level or nest it under the dsh package (0.2.0 does both depending on
// conflict resolution), so every lookup tries the flat path first, then the
// nested one. Returning null lets callers skip with a clear message instead
// of an opaque ENOENT.
function pkgRoot(packageName) {
  const top = path.join(runtime, 'node_modules', '@deepseek-ai', packageName);
  if (fs.existsSync(path.join(top, 'package.json'))) return top;
  const nested = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', packageName);
  if (fs.existsSync(path.join(nested, 'package.json'))) return nested;
  return null;
}
function pkgFile(packageName, ...parts) {
  const root = pkgRoot(packageName);
  return root ? path.join(root, ...parts) : null;
}

const coreRoot = pkgRoot('dsh');
if (!coreRoot) throw new Error('dsh core package not found in the runtime');
const core = JSON.parse(fs.readFileSync(path.join(coreRoot, 'package.json'), 'utf8'));
const connectionFiles = clientEntry('dsh-client-connection');
if (!connectionFiles) throw new Error(`dsh ${core.version}: dsh-client-connection missing from the runtime`);
const metadata = JSON.parse(fs.readFileSync(path.join(pkgRoot('dsh-client-connection'), 'package.json'), 'utf8'));
if (metadata.version !== core.version) throw new Error(`dsh ${core.version} and client connection ${metadata.version} differ`);

// 0.2.1 splits the single client.js into client.browser.js / client.node.js
// halves selected by package exports. Patch both halves so whichever the
// runtime loads carries the fnOS adapter; 0.2.0 single file still resolves.
function clientEntry(packageName) {
  const halves = ['client.js', 'client.browser.js', 'client.node.js'].map((name) => pkgFile(packageName, 'lib', name)).filter((file) => file && fs.existsSync(file));
  if (halves.length) return halves;
  return null;
}

// ---------------------------------------------------------------------------
// Trust anchor: the browser half decides whether a page origin is trusted for
// host-channel RPCs. fnOS always authenticates the frame at the gateway
// (admin ticket + session cookie) before anything reaches the core, so loopback
// is not the right predicate for us — the gateway origin must always count.
// ---------------------------------------------------------------------------
for (const connectionFile of connectionFiles) {
  const file = connectionFile;
  const source = fs.readFileSync(file, 'utf8');
  const anchor = 'isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),';
  const occurrences = source.split(anchor).length - 1;
  const applied = 'isLoopback: true, /* fnOS HTTPS gateway authenticates via NAS admin ticket before forwarding */';
  if (occurrences !== 1 && !(occurrences === 0 && source.split(applied).length === 2)) throw new Error(`dsh ${core.version} needs a new fnOS adapter: expected one verified trust anchor`);
  if (occurrences === 1) fs.writeFileSync(file, source.replace(anchor, applied));
  console.log(`Patched ${path.relative(runtime, file)} for authenticated fnOS gateway`);
}
// Probe the existing carrier before replacing it: a healthy foreground must not
// cancel its active streams. No page reload, user-RPC replay, or second owner.
function installForegroundRecovery(globals, connection) {
  const browser = globals.window, document = globals.document;
  if (!browser?.addEventListener || !document?.addEventListener) return () => {};
  let away = document.visibilityState === 'hidden';
  let queued = false, disposed = false, revision = 0, flight = null;
  let notice = null, status = null, reconnectButton = null, noticeRequired = false;
  let autoTimer = null, policyFlight = null, autoAttempts = 0, autoAccepted = false, dismissed = false;
  const delays = [1000, 3000, 8000];
  const visible = () => document.visibilityState !== 'hidden';
  const available = () => visible() && browser.navigator?.onLine !== false;
  const cancelAutomatic = () => { if (autoTimer !== null) globals.clearTimeout(autoTimer); autoTimer = null; policyFlight?.abort(); };
  const removeNotice = () => { cancelAutomatic(); noticeRequired = false; notice?.remove(); notice = null; status = null; reconnectButton = null; };
  const fitNotice = () => {
    if (!notice) return;
    const viewport = browser.visualViewport;
    const height = viewport?.height || browser.innerHeight || 640;
    const bottom = Math.max(0, (browser.innerHeight || height) - height - (viewport?.offsetTop || 0));
    notice.style.bottom = 'calc(' + (bottom + 20) + 'px + env(safe-area-inset-bottom, 0px))';
    notice.style.maxHeight = 'calc(' + Math.max(80, height) + 'px - 40px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))';
  };
  const cancelProbe = () => { if (flight) flight.abort(); };
  const requestReconnect = (ownerNotice, ownerButton, automatic) => {
    if (disposed || notice !== ownerNotice || reconnectButton !== ownerButton || queued || !available() || ownerButton.disabled) return false;
    revision++; cancelProbe(); cancelAutomatic();
    let accepted = false;
    try { accepted = connection.reconnect() === true; } catch { /* Never reload or replay a business request. */ }
    if (notice !== ownerNotice) return accepted;
    if (!accepted) { status.textContent = '连接尚未准备好或状态已变化，请稍后重试。未刷新页面。'; return false; }
    autoAccepted = true; ownerButton.disabled = true;
    status.textContent = automatic ? '已自动请求重新连接，正在等待服务回应；不会重发消息。' : '已请求重新连接，正在等待服务回应。';
    return true;
  };
  const scheduleAutomatic = () => {
    if (disposed || dismissed || autoAccepted || autoTimer !== null || policyFlight || !notice || !noticeRequired || !available()) return;
    if (autoAttempts >= delays.length) { status.textContent = '自动重连暂未完成，已暂停自动尝试。可稍后手动重新连接；不会刷新页面或重发消息。'; return; }
    autoTimer = globals.setTimeout(() => { autoTimer = null; void automaticAttempt(); }, delays[autoAttempts]);
  };
  const automaticAttempt = async () => {
    if (disposed || dismissed || autoAccepted || !notice || !available()) return;
    const ownerNotice = notice, ownerButton = reconnectButton, token = revision;
    const controller = new AbortController(); policyFlight = controller; autoAttempts++;
    let abortListener, enabled;
    const aborted = new Promise(resolve => { abortListener = () => resolve(undefined); controller.signal.addEventListener('abort', abortListener, { once: true }); });
    const deadline = globals.setTimeout(() => controller.abort(), 2500);
    try {
      if (typeof connection.policy === 'function') enabled = await Promise.race([connection.policy(controller.signal), aborted]);
    } catch { /* A policy read failure must not override a saved opt-out. */ }
    finally { globals.clearTimeout(deadline); controller.signal.removeEventListener('abort', abortListener); controller.abort(); if (policyFlight === controller) policyFlight = null; }
    if (disposed || dismissed || revision !== token || notice !== ownerNotice || !available()) return;
    if (enabled === false) { status.textContent = '自动重连已关闭。可手动重新连接；不会刷新页面或重发消息。'; return; }
    if (enabled !== true) { status.textContent = '暂未取得自动重连设置，未主动断开连接。可手动重试。'; scheduleAutomatic(); return; }
    if (connection.state() === 'connecting') { autoAccepted = true; status.textContent = '客户端正在恢复连接，请稍候；不会刷新页面或重发消息。'; return; }
    status.textContent = '正在自动请求重新连接（第 ' + autoAttempts + '/' + delays.length + ' 次）…';
    if (!requestReconnect(ownerNotice, ownerButton, true)) scheduleAutomatic();
  };
  const showNotice = () => {
    noticeRequired = true;
    if (disposed || notice || !document.body || !document.createElement) return;
    notice = document.createElement('section');
    notice.setAttribute('data-fnos-recovery-notice', ''); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    notice.style.cssText = 'position:fixed;box-sizing:border-box;left:calc(16px + env(safe-area-inset-left,0px));right:calc(16px + env(safe-area-inset-right,0px));bottom:calc(20px + env(safe-area-inset-bottom,0px));z-index:2147483000;max-width:620px;margin:0 auto;padding:16px;border:1px solid GrayText;border-radius:16px;color-scheme:light dark;background:Canvas;color:CanvasText;font:14px/1.5 system-ui;box-shadow:0 4px 18px rgb(0 0 0 / .18);display:grid;gap:12px;overflow:auto;overscroll-behavior:contain;overflow-wrap:anywhere;max-height:calc(100vh - 40px)';
    status = document.createElement('div'); status.textContent = '连接响应尚未确认，正在检查恢复策略；不会刷新页面或重发消息。';
    const actions = document.createElement('div'); actions.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px';
    reconnectButton = document.createElement('button'); reconnectButton.type = 'button'; reconnectButton.textContent = '重新连接'; reconnectButton.setAttribute('data-fnos-reconnect', '');
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = '稍后';
    for (const button of [dismiss, reconnectButton]) {
      button.style.cssText = 'box-sizing:border-box;min-width:0;min-height:44px;padding:8px 12px;border:1px solid GrayText;border-radius:8px;font:inherit;white-space:normal;color:inherit;background:Canvas;cursor:pointer;outline-offset:2px';
      button.addEventListener('focus', () => { button.style.outline = '2px solid CanvasText'; }); button.addEventListener('blur', () => { button.style.outline = ''; });
    }
    const ownerNotice = notice, ownerButton = reconnectButton;
    dismiss.addEventListener('click', () => { if (!disposed && notice === ownerNotice) { dismissed = true; revision++; cancelProbe(); removeNotice(); } });
    reconnectButton.addEventListener('click', () => { dismissed = true; cancelAutomatic(); requestReconnect(ownerNotice, ownerButton, false); });
    actions.append(dismiss, reconnectButton); notice.append(status, actions); document.body.appendChild(notice); fitNotice();
  };
  const onBodyReady = () => { if (noticeRequired) { showNotice(); scheduleAutomatic(); } };
  document.addEventListener('DOMContentLoaded', onBodyReady);
  const unsubscribeState = connection.subscribe?.(() => {
    if (disposed) return;
    const state = connection.state();
    if (state === 'connected') { autoAttempts = 0; autoAccepted = false; dismissed = false; removeNotice(); return; }
    if (notice && state === 'disconnected') { reconnectButton.disabled = false; status.textContent = '连接尚未恢复，客户端会按自身策略继续恢复；也可稍后手动重新连接。'; }
  });
  const enqueue = typeof globals.queueMicrotask === 'function' ? callback => globals.queueMicrotask(callback) : callback => Promise.resolve().then(callback);
  const markAway = () => { away = true; revision++; cancelProbe(); cancelAutomatic(); autoAttempts = 0; autoAccepted = false; dismissed = false; };
  const resume = () => {
    if (disposed || queued || !away || !available()) return;
    queued = true;
    enqueue(async () => {
      if (disposed || !away || !available()) { queued = false; return; }
      const token = revision, controller = new AbortController(); flight = controller;
      let abortListener;
      const aborted = new Promise(resolve => { abortListener = () => resolve(false); controller.signal.addEventListener('abort', abortListener, { once: true }); });
      const timer = globals.setTimeout(() => controller.abort(), 5000); let healthy = false;
      try { healthy = await Promise.race([connection.probe(controller.signal), aborted]); } catch { /* Probe is not a business RPC. */ }
      finally { globals.clearTimeout(timer); controller.signal.removeEventListener('abort', abortListener); controller.abort(); if (flight === controller) flight = null; queued = false; }
      if (disposed) return;
      if (revision !== token || !available()) { resume(); return; }
      away = false;
      if (healthy === true) removeNotice(); else { showNotice(); scheduleAutomatic(); }
    });
  };
  const visibility = () => { if (visible()) resume(); else markAway(); };
  const onOnline = () => { if (reconnectButton) reconnectButton.disabled = false; resume(); };
  document.addEventListener('visibilitychange', visibility); browser.addEventListener('pagehide', markAway); browser.addEventListener('pageshow', resume); browser.addEventListener('offline', markAway); browser.addEventListener('online', onOnline);
  browser.addEventListener('resize', fitNotice); browser.visualViewport?.addEventListener('resize', fitNotice); browser.visualViewport?.addEventListener('scroll', fitNotice);
  return () => {
    disposed = true; revision++; cancelProbe(); cancelAutomatic(); unsubscribeState?.(); removeNotice();
    document.removeEventListener('DOMContentLoaded', onBodyReady); document.removeEventListener('visibilitychange', visibility);
    browser.removeEventListener('pagehide', markAway); browser.removeEventListener('pageshow', resume); browser.removeEventListener('offline', markAway); browser.removeEventListener('online', onOnline);
    browser.removeEventListener('resize', fitNotice); browser.visualViewport?.removeEventListener('resize', fitNotice); browser.visualViewport?.removeEventListener('scroll', fitNotice);
  };
}

{
  const files = clientEntry('dsh-api-gateway');
  const host = pkgFile('dsh-api-gateway', 'lib', 'index.js');
  if (!files || !host) throw new Error(`dsh ${core.version}: foreground probe requires both Gateway faces`);
  for (const file of files) {
  const hostSource = fs.readFileSync(host, 'utf8');
  // Nonempty $events args are rejected BEFORE registering any client or calling
  // a business handler. That typed rejection proves a same-carrier round trip.
  const rejectAnchor = 'Reflect.ownKeys(payload.args).length !== 0) throw new TypertGatewayError("gateway/arguments-invalid", REMOTE_EVENT_STREAM_ENDPOINT';
  // 0.2.0 signature: openRemoteEvents(payload, signal). 0.2.1 adds a peer
  // parameter used for lifetime binding. Accept both; the empty-args reject
  // anchor below still pins the same side-effect-free contract.
  const validationPrefix = 'async *openRemoteEvents(payload, signal, peer) { if (!isObject(payload) || !isPlainObject(payload) || Reflect.ownKeys(payload).length !== 1 || !Object.hasOwn(payload, "args") || !isObject(payload.args) || !isPlainObject(payload.args) || Reflect.ownKeys(payload.args).length !== 0) throw new TypertGatewayError("gateway/arguments-invalid", REMOTE_EVENT_STREAM_ENDPOINT, "forwarded Remote event stream requires an empty args object"); const registration = this.remoteEvents;';
  const validationPrefix020 = 'async *openRemoteEvents(payload, signal) { if (!isObject(payload) || !isPlainObject(payload) || Reflect.ownKeys(payload).length !== 1 || !Object.hasOwn(payload, "args") || !isObject(payload.args) || !isPlainObject(payload.args) || Reflect.ownKeys(payload.args).length !== 0) throw new TypertGatewayError("gateway/arguments-invalid", REMOTE_EVENT_STREAM_ENDPOINT, "forwarded Remote event stream requires an empty args object"); const registration = this.remoteEvents;';
  const normalizedHost = hostSource.replace(/\s+/g, ' ');
  if (hostSource.split(rejectAnchor).length !== 2 || (!normalizedHost.includes(validationPrefix) && !normalizedHost.includes(validationPrefix020))) {
    throw new Error(`dsh ${core.version}: re-check the side-effect-free foreground probe contract`);
  }
  let source = fs.readFileSync(file, 'utf8');
  const marker = '/* fnOS connection foreground recovery v2 */';
  const previousMarker = '/* fnOS connection foreground recovery */';
  const anchor = '}, "api-gateway.client.transport");';
  if (source.includes(previousMarker)) {
    const endMarker = '}, "fnos.connection.foreground");';
    const at = source.indexOf(previousMarker), until = source.indexOf(endMarker, at);
    if (source.split(previousMarker).length !== 2 || until < at) throw new Error('Cannot safely replace previous foreground adapter');
    source = source.slice(0, at) + source.slice(until + endMarker.length);
  }
  if (!source.includes(marker)) {
    if (source.split(anchor).length !== 2) throw new Error(`dsh ${core.version}: foreground recovery requires one transport owner`);
    const probe = `async (signal) => {
      foregroundCarrier = this.streams.socket;
      if (connection.rpc.open !== void 0) return true;
      try {
        for await (const value of this.streams.open("$events", { args: { fnosProbe: true } }, signal)) return false;
        return false;
      } catch (error) { return error?.code === "gateway/arguments-invalid"; }
    }`;
    // An old probe must not replace the new carrier already owned by SDK retry.
    const reconnect = `() => {
      if (loop === void 0) return false;
      if (foregroundCarrier !== this.streams.socket) return false;
      if (foregroundCarrier?.readyState !== WebSocket.OPEN) return false;
      connection.reconnect();
      return true;
    }`;
    const recovery = `${anchor}\n${marker}\nctx.effect(() => { let foregroundCarrier; return (${installForegroundRecovery.toString()})(globalThis, { probe: ${probe}, reconnect: ${reconnect}, state: () => connection.state.getSnapshot(), subscribe: listener => connection.state.subscribe(listener), policy: async signal => { const response = await fetch(new URL("__fnos/connection-policy", document.baseURI), { credentials: "same-origin", cache: "no-store", signal }); if (!response.ok) throw new Error("connection policy unavailable"); const policy = await response.json(); if (typeof policy.autoReconnect !== "boolean") throw new Error("connection policy invalid"); return policy.autoReconnect; } }); }, "fnos.connection.foreground");`;
    fs.writeFileSync(file, source.replace(anchor, recovery));
    console.log('Patched fnOS foreground carrier check and SDK-owned recovery');
  }
  }
}
// 0.2.0 made every browser route document-relative (upstream note:
// web-document-relative-app-routes): routes ship as `"/path".slice(1)` and are
// resolved against document.baseURI. A subpath deployment therefore inherits
// its prefix for free, and the seven fnOS gateway-prefix rewrites that 0.1.5
// needed are gone.
//
// These assertions pin that contract. If a future core reverts a route to an
// absolute path, the build fails HERE with a named package instead of shipping
// a core whose browser half silently bypasses the gateway prefix (the exact
// class of bug that produced those rewrites in the first place).
// ---------------------------------------------------------------------------
function assertAnchor(packageName, anchor, label) {
  const files = clientEntry(packageName) || [];
  const extra = pkgFile(packageName, 'lib', 'types', 'client', 'runtime.js');
  if (extra && fs.existsSync(extra)) files.push(extra);
  if (!files.length) throw new Error(`dsh ${core.version}: package ${packageName} not found (needed to verify ${label})`);
  let seen = false;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes(anchor)) { seen = true; break; }
  }
  if (!seen) {
    throw new Error(`dsh ${core.version}: ${packageName} (${label}) no longer carries its relative-route anchor — re-check fnOS gateway-prefix assumptions before bumping`);
  }
  console.log(`Verified ${packageName} keeps its document-relative route (${label})`);
}

assertAnchor('dsh-client-connection',
  '`${channel}/${endpoint}`.slice(1)',
  'unary RPC relative to document');
assertAnchor('dsh-api-gateway',
  'globals.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI',
  'remote mux base falls back to document.baseURI');
assertAnchor('dsh-client-hmr',
  'new EventSource(EVENTS_ROUTE)',
  'SSE events route');
assertAnchor('dsh-client-hmr',
  'const EVENTS_ROUTE = "/plugins/events".slice(1);',
  'SSE events route stays relative');
assertAnchor('dsh-client-file-upload',
  'new URL(request.path, document.baseURI)',
  'upload resolves against document.baseURI');
assertAnchor('dsh-session-log-export',
  'const SESSION_LOG_EXPORT_ROUTE = "/api/session.export".slice(1);',
  'session export route stays relative');
assertAnchor('dsh-client-ui-deliverables',
  'const PRESENT_OPEN_ROUTE = PRESENT_OPEN_PATH.slice(1);',
  'present.open route stays relative');
assertAnchor('dsh-client-ui-deliverables',
  'const PRESENT_HOST_ROUTE = PRESENT_HOST_PATH.slice(1);',
  'present.host route stays relative');

// The old preview-bundle bug (a bare `typeof Iterator.prototype.join`
// dereferencing a missing global) was fixed upstream in 0.2.0 — the eager
// entry no longer carries it. Scan the EAGER entry points (client.js +
// index.js): a bare dereference there crashes module import on engines
// without iterator helpers ("Failed to load plugins" on Chromium 107).
//
// Carve-out: lib/client.pdf.js still carries the bare form, but it is loaded
// lazily (react.lazy + require.async) only when a PDF preview renders, and by
// then the legacy-compat shim injected into index.html <head> has already
// defined the Iterator global — so the expression only ever evaluates when the
// global exists. That dependency is why patchLegacyCompat must FAIL the build
// when the shim cannot be injected, never skip silently.
{
  const eager = ['lib/client.js', 'lib/client.browser.js', 'lib/client.node.js', 'lib/index.js']
    .map((rel) => pkgFile('dsh-client-ui-sidebar-documentpreview', rel))
    .filter((file) => file && fs.existsSync(file));
  for (const file of eager) {
    if (fs.readFileSync(file, 'utf8').includes('typeof Iterator.prototype.join')) {
      throw new Error(`dsh ${core.version}: the unguarded Iterator.prototype.join dereference is back in ${path.basename(file)} — re-add the iterator guard (or move the code behind a lazy load like client.pdf.js)`);
    }
  }
  console.log('Verified the legacy-unsafe iterator guard stays removed from the eager entries');
}

// ---------------------------------------------------------------------------
// Composer seat background patch: the seat paints with color-mix(), which any
// engine below Chromium 111 drops ENTIRELY (it does not fall back to
// transparent), so the seat loses its background while remaining
// position:absolute/sticky over the scrolling view — every row scrolls straight
// through the composer, its toolbar and the status footer. Rewriting the one
// declaration to rgba() keeps the layered gradient intact.
// ---------------------------------------------------------------------------
(function patchComposerSeatBackground() {
  const target = pkgFile('dsh-client-ui-conversation', 'lib', 'client.js');
  if (!target || !fs.existsSync(target)) {
    console.log('conversation shell not found; skipped composer seat background patch');
    return;
  }
  const source = fs.readFileSync(target, 'utf8');
  const anchor = 'color-mix(in srgb, var(--dsw-alias-bg-base) 0%, transparent)';
  if (!source.includes(anchor)) {
    console.log('composer seat background is already engine-portable; skipped');
    return;
  }
  fs.writeFileSync(target, source.split(anchor).join('rgba(0, 0, 0, 0)'));
  console.log('Patched composer seat background (color-mix -> rgba) for legacy engines');
})();

// ---------------------------------------------------------------------------
// Inject the legacy-engine compatibility shim into the served frontend
// index.html. The fnOS desktop entry is commonly opened in frozen Chromium 107
// engines (QAX Trusted Browser and friends) that lack APIs the client bundle
// calls directly: AbortSignal.any, Promise.withResolvers/try, URL.parse,
// Array.fromAsync, Iterator + helpers, Object.groupBy, Symbol.dispose,
// ReadableStream async iteration. The shim is a classic script in <head> so it
// runs before the module bundle; every block is guarded by a feature check, so
// modern browsers are untouched.
//
// ⚠ index.html is generated into the runtime, not the repo: this patch is
// idempotent via its marker because a rebuild re-applies it to a fresh copy.
// ---------------------------------------------------------------------------
(function patchLegacyCompat() {
  const compatFile = path.join(path.dirname(runtime), 'legacy-compat.js');
  if (!fs.existsSync(compatFile)) {
    // Never skip silently: the shim is the safety net for every old-engine
    // hazard upstream ships (0.3.45 shipped a broken build exactly this way),
    // including the bare Iterator dereference that client.pdf.js still
    // evaluates lazily. Missing here means the build is incomplete.
    throw new Error('legacy-compat.js missing next to patch-dsh.mjs — the old-engine shim must ship');
  }
  const indexFile = pkgFile('dsh-web-frontend', 'dist', 'index.html');
  if (!indexFile || !fs.existsSync(indexFile)) {
    throw new Error('frontend index.html not found — cannot inject the old-engine shim');
  }
  const marker = '<!-- dsh-legacy-compat:start -->';
  const html = fs.readFileSync(indexFile, 'utf8');
  if (html.includes(marker)) {
    console.log('frontend index.html already carries the compatibility shim');
    return;
  }
  if (!html.includes('<head>')) {
    throw new Error('frontend index.html has no <head> anchor — cannot inject the old-engine shim');
  }
  const polyfill = fs.readFileSync(compatFile, 'utf8');
  if (polyfill.includes('</' + 'script')) {
    throw new Error('legacy-compat.js contains a script terminator — would break the served index.html');
  }
  const block = '<head>\n    <script>\n' + marker + '\n' + polyfill + '\n<!-- dsh-legacy-compat:end -->\n    </script>';
  fs.writeFileSync(indexFile, html.replace('<head>', block));
  console.log('Patched frontend index.html with the legacy-engine compatibility shim');
})();