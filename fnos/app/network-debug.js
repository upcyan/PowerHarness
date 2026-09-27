const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const diagnostics = require('./diagnostics.js');
const debugCommands = require('./network-debug-commands.js');

const defaultMinutes = 15;
const maxMinutes = 60;

function validMinutes(value) {
  const minutes = Number(value ?? defaultMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > maxMinutes) throw new Error(`调试有效期必须为 1–${maxMinutes} 分钟`);
  return minutes;
}

function validMode(value) {
  const mode = value ?? 'read-only';
  if (!['read-only', 'command'].includes(mode)) throw new Error('无效的网络调试模式');
  return mode;
}

function write(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(JSON.stringify(value));
}

function createNetworkDebug(dataDir, getState, onEvent = () => {}, executeCommand = null) {
  let active = null;
  let timer = null;

  function stop() {
    if (!active) return false;
    const previous = active;
    active = null;
    clearTimeout(timer);
    timer = null;
    try { previous.server.closeAllConnections(); previous.server.close(); } catch {}
    onEvent('network_debug_stopped');
    return true;
  }

  function status() {
    if (!active || Date.now() >= active.expiresAt) { stop(); return null; }
    return { address: active.address, port: active.port, token: active.token, expiresAt: new Date(active.expiresAt).toISOString(), minutes: active.minutes, mode: active.mode };
  }

  async function start(address, options = {}) {
    if (typeof address !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) throw new Error('无法确定 NAS IPv4 地址');
    const minutes = validMinutes(options.minutes);
    const mode = validMode(options.mode);
    if (mode === 'command' && typeof executeCommand !== 'function') throw new Error('指令模式不可用');
    stop();
    const token = randomBytes(32).toString('base64url');
    const lifetimeMs = minutes * 60_000;
    const expiresAt = Date.now() + lifetimeMs;
    const server = https.createServer({
      key: fs.readFileSync(path.join(dataDir, 'tls.key')),
      cert: fs.readFileSync(path.join(dataDir, 'tls.crt'))
    }, async (request, response) => {
      if (!active || active.server !== server || Date.now() >= expiresAt) return write(response, 410, { error: 'diagnostic window closed' });
      const header = String(request.headers.authorization || '');
      const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
      const actual = Buffer.from(token);
      const offered = Buffer.from(supplied);
      if (offered.length !== actual.length || !timingSafeEqual(offered, actual)) return write(response, 401, { error: 'token required' });
      const session = active;
      if (request.url === '/snapshot' && request.method === 'GET') {
        try {
          const current = getState();
          const state = { mode: current.mode, bundledVersion: current.bundledVersion, activeVersion: current.activeVersion, updatedAt: current.updatedAt, error: diagnostics.redactDsh(current.error || '') };
          const logs = Object.fromEntries(['gateway', 'supervisor', 'dsh'].map((source) => [source, diagnostics.read(dataDir, source, 200, true)]));
          return write(response, 200, { time: new Date().toISOString(), state, logs });
        } catch { return write(response, 500, { error: 'diagnostic snapshot unavailable' }); }
      }
      if (request.url === '/snapshot') return write(response, 405, { error: 'read-only endpoint' });
      if (request.url !== '/command') return write(response, 404, { error: 'not found' });
      if (request.method !== 'POST') return write(response, 405, { error: 'POST required' });
      if (mode !== 'command') return write(response, 403, { error: 'read-only mode' });
      if (!/^application\/json(?:;|$)/i.test(String(request.headers['content-type'] || ''))) return write(response, 415, { error: 'JSON required' });
      let selected;
      try {
        let body = '';
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 4096) return write(response, 413, { error: 'command too large' });
          body += chunk.toString();
        }
        selected = debugCommands.validate(JSON.parse(body));
      } catch { return write(response, 400, { error: 'invalid or disallowed command' }); }
      if (active !== session || Date.now() >= expiresAt) return write(response, 410, { error: 'diagnostic window closed' });
      if (session.busy) return write(response, 409, { error: 'another command is running' });
      session.busy = true;
      onEvent('network_debug_command_started', { action: selected.action });
      try {
        const result = await executeCommand(selected.action === 'probe-plugin-route'
          ? { action: selected.action, path: selected.path }
          : { action: selected.action, ...selected.params });
        onEvent('network_debug_command_succeeded', { action: selected.action });
        if (!response.destroyed) write(response, 200, { ok: true, result });
      } catch (error) {
        onEvent('network_debug_command_failed', { action: selected.action });
        if (!response.destroyed) write(response, 500, { ok: false, error: diagnostics.redactDsh(String(error.message || 'command failed')).slice(0, 500) });
      } finally {
        session.busy = false;
      }
    });
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 1_000;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, address, () => { server.removeListener('error', reject); resolve(); });
      });
    } catch (error) {
      server.close();
      throw error;
    }
    const port = server.address().port;
    active = { server, address, port, token, expiresAt, minutes, mode, busy: false };
    server.on('error', (error) => {
      if (active?.server === server) {
        onEvent('network_debug_error', { code: String(error.code || 'unknown') });
        stop();
      }
    });
    timer = setTimeout(stop, lifetimeMs);
    timer.unref();
    onEvent('network_debug_started', { port, minutes, mode });
    return status();
  }

  return { start, stop, status };
}

module.exports = { createNetworkDebug, defaultMinutes, maxMinutes, validMinutes, validMode };
