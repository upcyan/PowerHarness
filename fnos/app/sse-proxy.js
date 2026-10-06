'use strict';

function discardReply(reply) {
  // IncomingMessage.destroy may race with an already queued socket error.
  const ignore = () => {};
  reply.on('error', ignore);
  reply.once('close', () => reply.removeListener('error', ignore));
  reply.destroy();
}

// Installed before response headers arrive: GET request.close is NOT a client
// disconnect (it also fires after a normal request body completes).
function createProxyLifetime(request, response) {
  let upstream = null, reply = null, closed = false;
  const cleanup = new Set();
  function close({ cancel = true, downstream = false } = {}) {
    if (closed) return;
    closed = true;
    request.removeListener('aborted', onAbort);
    response.removeListener('close', onClose);
    response.removeListener('finish', onFinish);
    for (const fn of cleanup) { try { fn(); } catch { /* Teardown must still destroy both upstream objects. */ } }
    cleanup.clear();
    if (cancel) {
      request.unpipe?.(upstream);
      reply?.unpipe(response);
      reply?.destroy();
      upstream?.destroy();
    }
    if (downstream && !response.destroyed) response.destroy();
  }
  const onAbort = () => close({ downstream: true });
  const onClose = () => close({ cancel: !response.writableFinished || !reply?.readableEnded });
  const onFinish = () => close({ cancel: !reply?.readableEnded });
  request.once('aborted', onAbort);
  response.once('close', onClose);
  response.once('finish', onFinish);
  if (request.aborted || response.destroyed || response.writableEnded) close();
  return {
    get closed() { return closed; },
    attachRequest(value) { upstream = value; if (closed || response.destroyed) { close(); value.destroy(); } },
    acceptReply(value) {
      if (value === reply) return false; // Never destroy the already active stream.
      if (closed || response.destroyed || response.writableEnded || reply || response.headersSent) {
        discardReply(value);
        if (!reply && !closed) close();
        return false;
      }
      reply = value;
      const ignore = () => {};
      reply.on('error', ignore);
      reply.once('close', () => reply.removeListener('error', ignore));
      return true;
    },
    addCleanup(fn) { if (closed) fn(); else cleanup.add(fn); },
    close,
  };
}

function sseHeaders(headers) {
  const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'cache-control', 'x-accel-buffering']);
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() === 'connection') {
    for (const token of String(value).split(',')) hop.add(token.trim().toLowerCase());
  }
  const result = Object.fromEntries(Object.entries(headers).filter(([name]) => !hop.has(name.toLowerCase())));
  return { ...result, 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' };
}

function pipeSse({ reply, response, lifetime, headers, log = () => {}, label = '', heartbeatMs = 15000, writableLimit = 256 * 1024 }) {
  let timer = null, cleaned = false, beats = 0;
  const safeLog = (event, details) => { try { log(event, details); } catch { /* Logging is not a stream dependency. */ } };
  const fail = () => lifetime.close({ downstream: true });
  const onClose = () => { if (!reply.readableEnded) fail(); else cleanup(); };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(timer);
    reply.removeListener('end', cleanup);
    reply.removeListener('close', onClose);
    reply.removeListener('error', fail);
    response.removeListener('error', fail);
    if (beats) safeLog('sse_keepalive_end', { path: label, beats });
  };
  lifetime.addCleanup(cleanup);
  if (lifetime.closed || response.destroyed || response.writableEnded) return false;
  reply.once('end', cleanup);
  reply.once('close', onClose);
  reply.once('error', fail);
  response.once('error', fail);
  try {
    response.writeHead(reply.statusCode, sseHeaders(headers));
    response.flushHeaders?.();
    reply.pipe(response);
    if (!response.destroyed && !response.writableEnded) response.write(': connected\n\n');
    if (lifetime.closed) return false;
    timer = setInterval(() => {
      if (response.destroyed || response.writableEnded) return fail();
      if (response.writableLength > writableLimit) return;
      try { response.write(': keepalive\n\n'); beats++; } catch { fail(); }
    }, heartbeatMs);
    timer.unref?.();
    safeLog('sse_keepalive_start', { path: label });
    return true;
  } catch { fail(); return false; }
}

module.exports = { createProxyLifetime, pipeSse, sseHeaders };
