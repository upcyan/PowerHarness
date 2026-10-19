'use strict';
const http = require('node:http');
// Only the private fnOS-admin guide channel may use this bridge. The public
// HTTPS listener keeps its own NAS-session and browser-cookie checks unchanged.
function create({ launchPath, port, transport = http, now = Date.now, cacheMs = 60000 }) {
  let cached = null, flight = null;
  function current() {
    const value = launchPath();
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) throw new Error('DSH launch credential unavailable');
    const url = new URL(value, 'http://127.0.0.1:' + port);
    if (url.pathname !== '/' || url.searchParams.getAll('token').length !== 1 || !url.searchParams.get('token')) throw new Error('DSH launch credential invalid');
    return { path: url.pathname + url.search, key: value + ':' + port };
  }
  function exchange(path) {
    return new Promise((resolve, reject) => {
      const request = transport.get({ host: '127.0.0.1', port, path, agent: false, timeout: 5000 }, response => {
        response.resume();
        response.once('error', reject);
        response.once('aborted', () => reject(new Error('DSH authentication response aborted')));
        response.once('end', () => {
          const cookies = (response.headers['set-cookie'] || []).filter(value => (String(value).startsWith('dsh-auth-') || String(value).startsWith('dsh-auth=')));
          if (![302,303].includes(response.statusCode) || cookies.length !== 1) return reject(new Error('DSH authentication exchange failed'));
          const cookie = cookies[0].split(';')[0];
          const separator = cookie.indexOf('=');
          if (separator <= 0 || separator === cookie.length - 1) return reject(new Error('DSH authentication cookie invalid'));
          resolve({ cookie, name: cookie.slice(0, separator) });
        });
      });
      request.once('error', reject);
      request.once('timeout', () => request.destroy(new Error('DSH authentication exchange timed out')));
    });
  }
  async function session() {
    const state = current();
    if (cached?.key === state.key && cached.expires > now()) return cached;
    if (flight?.key === state.key) return flight.promise;
    const promise = exchange(state.path).then(value => {
      if (current().key !== state.key) throw new Error('DSH launch changed during authentication');
      cached = { ...value, key: state.key, expires: now() + cacheMs };
      return cached;
    }).finally(() => { if (flight?.promise === promise) flight = null; });
    flight = { key: state.key, promise };
    return promise;
  }
  async function headersForGuide(request, headers) {
    if (request.headers['x-trim-isadmin'] !== 'true') throw new Error('fnOS administrator authentication required');
    const auth = await session();
    const cookies = String(headers.cookie || '').split(';').map(value => value.trim()).filter(value => value && value.split('=')[0] !== auth.name);
    return { ...headers, cookie: [...cookies, auth.cookie].join('; ') };
  }
  return { headersForGuide };
}
module.exports = { create };
