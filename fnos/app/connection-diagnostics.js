'use strict';

// Serialized as executable source: no template-string escaping of browser code.
function installConnectionDiagnostics() {
  if (window.__dshConnectionSnapshot) return;
  const events = [];
  // One shared bounded list: at most 40 retained transport objects, no timers.
  const connections = [];
  let total = 0;
  const available = {
    websocket: typeof window.WebSocket === 'function',
    eventSource: typeof window.EventSource === 'function'
  };
  const record = (type, fields = {}) => {
    events.push({ at: Date.now(), type, ...fields });
    if (events.length > 80) events.shift();
  };
  const page = () => ({ visibility: document.visibilityState, online: navigator.onLine });
  const inputs = () => {
    // First match per supported kind only; never enumerate the whole DOM or read content.
    const selectors = ['textarea', '[contenteditable="true"]', '[role="textbox"]'];
    const seen = new Set();
    return selectors.map((selector) => {
      const node = typeof document.querySelector === 'function' ? document.querySelector(selector) : null;
      if (!node) return { selector, exists: false };
      if (seen.has(node)) return { selector, exists: true, duplicate: true };
      seen.add(node);
      try {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const geometry = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
          style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity) !== 0;
        return { selector, exists: true, geometry, visible,
          intersectsViewport: rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight };
      } catch (_) { return { selector, exists: true, geometryUnavailable: true }; }
    });
  };
  for (const name of ['online', 'offline', 'pageshow', 'pagehide']) {
    window.addEventListener(name, () => record(name, page()));
  }
  document.addEventListener('visibilitychange', () => record('visibility', page()));
  record('installed', page());
  window.__dshConnectionSnapshot = () => {
    const rows = connections.map(({ object, row }) => ({ ...row, state: object.readyState }));
    return {
      sampledAt: Date.now(), page: page(), totalConnections: total,
      truncatedConnections: Math.max(0, total - connections.length),
      transportAvailability: { ...available },
      sockets: rows.filter((row) => row.transport === 'websocket'),
      eventSources: rows.filter((row) => row.transport === 'eventsource'),
      inputs: inputs(), events: events.map((e) => ({ ...e })),
      note: '仅 transport 观测，不等于 DSH 订阅健康；无流量不等于断线。仅覆盖安装后新建的 WebSocket/EventSource，fetch 型 SSE 与业务订阅未覆盖。输入仅每类首个匹配的存在/几何/样式可见性，不代表可交互。记录不包含消息正文、连接 URL、关闭原因文本或输入内容。'
    };
  };
  const retain = (object, row) => {
    connections.push({ object, row });
    if (connections.length > 40) connections.shift();
  };
  const Native = window.WebSocket;
  if (!available.websocket) record('websocket-unavailable');
  else window.WebSocket = new Proxy(Native, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget);
      const row = { id: ++total, transport: 'websocket', createdAt: Date.now(),
        sent: 0, received: 0, lastSendAt: null, lastReceiveAt: null };
      retain(ws, row);
      record('ws-created', { id: row.id });
      ws.addEventListener('open', () => record('ws-open', { id: row.id }));
      ws.addEventListener('message', () => { row.received++; row.lastReceiveAt = Date.now(); });
      ws.addEventListener('error', () => record('ws-error', { id: row.id }));
      ws.addEventListener('close', (e) => record('ws-close', { id: row.id, code: e.code, clean: e.wasClean }));
      const send = ws.send;
      ws.send = function (...parts) {
        const result = Reflect.apply(send, this, parts);
        row.sent++; row.lastSendAt = Date.now();
        return result;
      };
      return ws;
    }
  });
  const NativeEventSource = window.EventSource;
  if (!available.eventSource) record('eventsource-unavailable');
  else window.EventSource = new Proxy(NativeEventSource, {
    construct(target, args, newTarget) {
      const source = Reflect.construct(target, args, newTarget);
      const row = { id: ++total, transport: 'eventsource', createdAt: Date.now(),
        opened: 0, errors: 0, received: 0, lastOpenAt: null, lastErrorAt: null, lastReceiveAt: null };
      retain(source, row);
      record('es-created', { id: row.id });
      source.addEventListener('open', () => {
        row.opened++; row.lastOpenAt = Date.now(); record('es-open', { id: row.id });
      });
      source.addEventListener('error', () => {
        row.errors++; row.lastErrorAt = Date.now(); record('es-error', { id: row.id });
      });
      source.addEventListener('message', () => { row.received++; row.lastReceiveAt = Date.now(); });
      return source;
    }
  });
}

module.exports = { installConnectionDiagnostics,
  script: `<script>(${installConnectionDiagnostics.toString()})();</script>` };
