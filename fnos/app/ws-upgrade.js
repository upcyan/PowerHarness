'use strict';
// Own the pre-101 phase too: peer disappearance and non-101 replies must cancel
// the upstream request, not only the socket pair after a successful upgrade.
function forwardUpgrade(socket, upstream, head, bridge, { deadlineMs = 10000 } = {}) {
  let timer = null, done = false, upgraded = false, backend = null;
  const clear = () => { clearTimeout(timer); timer = null; };
  const fail = () => {
    if (done) return;
    done = true;
    clear();
    socket.removeListener('close', fail);
    socket.removeListener('end', fail);
    socket.removeListener('error', fail);
    backend?.destroy();
    upstream.destroy();
    if (!socket.destroyed) socket.destroy();
  };
  socket.once('close', fail);
  socket.once('end', fail);
  socket.once('error', fail);
  upstream.on('error', fail);
  upstream.once('response', reply => { reply.on('error', () => {}); reply.destroy(); fail(); });
  upstream.once('upgrade', (reply, upstreamSocket, upstreamHead) => {
    if (done || socket.destroyed || reply.statusCode !== 101) { upstreamSocket.on('error', () => {}); upstreamSocket.destroy(); fail(); return; }
    backend = upstreamSocket;
    upgraded = true;
    clear();
    try {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n`);
      if (head.length) backend.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      bridge(socket, backend);
    } catch { fail(); }
  });
  timer = setTimeout(fail, deadlineMs);
  timer.unref?.();
  if (socket.destroyed) fail();
  return { cancel: fail, get upgraded() { return upgraded; } };
}
module.exports = { forwardUpgrade };
