'use strict';
const http = require('node:http');
const https = require('node:https');
function postJson(endpoint, body, apiKey, { signal, timeoutMs = 120000, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let req, res, timer, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { res?.destroy(); req?.destroy(); reject(error); } else resolve(result);
    };
    const abort = () => finish(new Error('诊断请求已取消'));
    if (signal?.aborted) return abort();
    try {
      const url = new URL(endpoint);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('协议不支持');
      const text = JSON.stringify(body);
      req = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), authorization: `Bearer ${apiKey}` },
      }, reply => {
        res = reply;
        let bytes = 0; const chunks = [];
        reply.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) return finish(new Error('模型响应超过大小上限'));
          if (!settled) chunks.push(chunk);
        });
        reply.on('error', error => finish(error));
        reply.on('aborted', () => finish(new Error('模型响应中断')));
        reply.on('end', () => {
          if (settled) return;
          try { finish(null, { status: reply.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch { finish(new Error('模型返回的内容不是合法 JSON')); }
        });
      });
      req.on('error', error => finish(error));
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(new Error('模型请求超过总时限')), timeoutMs);
      req.end(text);
    } catch (error) { finish(error); }
  });
}
module.exports = { postJson };
