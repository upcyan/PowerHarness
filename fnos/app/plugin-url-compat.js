// Runs only inside the fnOS subpath frame. Third-party DSH plugins often use
// root-absolute URLs, which otherwise escape /app/dsh-fnos/dsh/ on fnOS.
(function () {
  const prefix = '/app/dsh-fnos/dsh';
  if (globalThis.__FNOS_GATEWAY_PREFIX__ === prefix) return;
  globalThis.__FNOS_GATEWAY_PREFIX__ = prefix;
  const rules = globalThis.__FNOS_URL_RULES__ || { builtins: [], approved: [] };
  delete globalThis.__FNOS_URL_RULES__;
  const paths = [...rules.builtins, ...rules.approved];
  const originalFetch = globalThis.fetch;
  const reported = new Set();

  function permitted(pathname) {
    return pathname === '/' || paths.some((path) => pathname === path || pathname.startsWith(path + '/'));
  }

  function report(pathname) {
    const path = '/' + (pathname.split('/')[1] || '');
    if (!/^\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(path) || reported.has(path) || typeof originalFetch !== 'function') return;
    reported.add(path);
    void originalFetch.call(globalThis, prefix + '/__fnos-plugin-url-candidate', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path })
    }).catch(() => {});
  }

  function mapPath(pathname) {
    if (permitted(pathname)) return prefix + pathname;
    report(pathname);
    return prefix + '/__fnos-plugin-url-denied';
  }

  function route(value) {
    if (typeof value !== 'string') return value;
    if (value.startsWith('/') && !value.startsWith('//')) {
      if (value.startsWith('/app/') || value.startsWith('/_fnos/') || value.startsWith('/__fnos/')) return value;
      if (value === prefix || value.startsWith(prefix + '/')) return value;
      const url = new URL(value, location.origin);
      url.pathname = mapPath(url.pathname);
      url.search = permitted(new URL(value, location.origin).pathname) ? url.search : '';
      return url.pathname + url.search + url.hash;
    }
    try {
      const url = new URL(value);
      const sameOrigin = url.origin === location.origin ||
        ((url.protocol === 'ws:' || url.protocol === 'wss:') && url.host === location.host);
      if (!sameOrigin || url.pathname.startsWith('/app/') || url.pathname.startsWith('/_fnos/') || url.pathname.startsWith('/__fnos/') ||
          url.pathname === prefix || url.pathname.startsWith(prefix + '/')) return value;
      const allowed = permitted(url.pathname);
      url.pathname = mapPath(url.pathname);
      if (!allowed) { url.search = ''; url.hash = ''; }
      if (url.protocol === 'ws:' && location.protocol === 'https:') url.protocol = 'wss:';
      return url.href;
    } catch { return value; }
  }

  if (typeof originalFetch === 'function') {
    globalThis.fetch = function (input, init) {
      if (typeof input === 'string') input = route(input);
      else if (input instanceof URL) input = route(input.href);
      else if (typeof Request !== 'undefined' && input instanceof Request) {
        const target = route(input.url);
        if (target !== input.url) input = new Request(target, input);
      }
      return originalFetch.call(this, input, init);
    };
  }

  if (typeof XMLHttpRequest !== 'undefined') {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      return open.call(this, method, route(url), ...rest);
    };
  }

  // DSH's client module loader creates classic scripts and assigns el.src.
  // Those URLs are not covered by fetch/XHR or by rewriting the initial HTML.
  function wrapResourceProperty(type, name) {
    if (typeof type !== 'function') return;
    const descriptor = Object.getOwnPropertyDescriptor(type.prototype, name);
    if (!descriptor?.configurable || typeof descriptor.set !== 'function') return;
    Object.defineProperty(type.prototype, name, {
      ...descriptor,
      set(value) { return descriptor.set.call(this, route(value)); }
    });
  }
  wrapResourceProperty(globalThis.HTMLScriptElement, 'src');
  wrapResourceProperty(globalThis.HTMLLinkElement, 'href');
  if (typeof Element !== 'undefined') {
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      const resource = (this instanceof HTMLScriptElement && String(name).toLowerCase() === 'src') ||
        (typeof HTMLLinkElement !== 'undefined' && this instanceof HTMLLinkElement && String(name).toLowerCase() === 'href');
      return setAttribute.call(this, name, resource ? route(value) : value);
    };
  }

  for (const name of ['WebSocket', 'EventSource', 'Worker', 'SharedWorker']) {
    const Native = globalThis[name];
    if (typeof Native !== 'function') continue;
    globalThis[name] = new Proxy(Native, {
      construct(target, args, newTarget) {
        if (args.length) args[0] = route(args[0] instanceof URL ? args[0].href : args[0]);
        return Reflect.construct(target, args, newTarget);
      }
    });
  }

  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const sendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => sendBeacon(route(url), data);
  }

  document.addEventListener('click', (event) => {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    const next = route(href);
    if (next !== href) anchor.setAttribute('href', next);
  }, true);
})();
