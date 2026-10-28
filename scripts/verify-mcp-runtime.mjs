import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Mandatory pre-pack compatibility/security seam. All fetches below are
// synthetic; no credentials, servers or production configuration are read.
const runtime = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Pass the exact installed candidate runtime');
const req = createRequire(path.join(runtime, 'package.json'));
const bridgeEntry = req.resolve('@deepseek-ai/dsh-mcp-client');
const bridgeRequire = createRequire(bridgeEntry);
const sdkEntry = bridgeRequire.resolve('@modelcontextprotocol/client');
const sdkRoot = path.dirname(path.dirname(sdkEntry));
const sdkMeta = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'));
assert.equal(sdkMeta.version, '2.3.1', 'MCP client must resolve to the exact redirect-safe version');
const bridgeMeta = JSON.parse(fs.readFileSync(path.join(path.dirname(bridgeEntry), '../package.json'), 'utf8'));
const coreMeta = JSON.parse(fs.readFileSync(path.join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
const requestedCore = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh'];
assert.equal(coreMeta.version, requestedCore, 'DSH must match the exact candidate pin');
assert.equal(bridgeMeta.version, coreMeta.version, 'MCP bridge and DSH core must be the same release');
const sdk = await import(pathToFileURL(path.join(sdkRoot, sdkMeta.exports['.'].import.default)).href);
const bridge = await import(pathToFileURL(bridgeEntry).href);
assert.equal(typeof sdk.Client, 'function');
assert.equal(typeof sdk.StreamableHTTPClientTransport, 'function');
assert.equal(typeof sdk.specTypeSchemas.CallToolResult['~standard'].validate, 'function');
const stdioEntry = bridgeRequire.resolve('@modelcontextprotocol/client/stdio');
assert.equal(typeof (await import(pathToFileURL(stdioEntry).href)).StdioClientTransport, 'function');
assert.equal(typeof bridge.apply, 'function');
const definition = bridge.createMcpToolDefinition({}, {
  name: 'mcp__gate__echo', rawName: 'echo', description: 'synthetic gate', inputSchema: { type: 'object' },
  call: async () => ({ content: [{ type: 'text', text: 'gate-ok' }] }),
});
assert.deepEqual(await definition.execute({}, { signal: new AbortController().signal }), { content: [{ type: 'text', text: 'gate-ok' }] });
const serverUrl = 'https://mcp.fixture.invalid/mcp';
const expectedIssuer = 'https://auth.fixture.invalid';
function discovery(issuer) {
  const calls = [];
  const fetchFn = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method || 'GET', credential: headers.has('authorization') });
    if (url.includes('oauth-protected-resource')) return Response.json({ resource: serverUrl, authorization_servers: [issuer] });
    if (url.includes('/.well-known/')) return Response.json({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', grant_types_supported: ['client_credentials'], response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['client_secret_basic'] });
    if (url === issuer + '/token') return Response.json({ access_token: 'synthetic-access-token', token_type: 'Bearer', expires_in: 3600 });
    throw new Error('Unexpected synthetic OAuth route: ' + url);
  };
  return { calls, fetchFn };
}
const malicious = discovery('https://other.fixture.invalid');
const pinned = new sdk.ClientCredentialsProvider({ clientId: 'synthetic-client', clientSecret: 'synthetic-not-live', expectedIssuer });
await assert.rejects(sdk.auth(pinned, { serverUrl, fetchFn: malicious.fetchFn }), e => e instanceof sdk.AuthorizationServerMismatchError);
assert(!malicious.calls.some(call => call.credential || call.method === 'POST'), 'foreign issuer must not receive credentials or token POST');
const good = discovery(expectedIssuer);
const accepted = new sdk.ClientCredentialsProvider({ clientId: 'synthetic-client', clientSecret: 'synthetic-not-live', expectedIssuer });
assert.equal(await sdk.auth(accepted, { serverUrl, fetchFn: good.fetchFn }), 'AUTHORIZED');
assert(good.calls.some(call => call.url === expectedIssuer + '/token' && call.credential));
assert.equal(accepted.tokens().issuer, expectedIssuer);

// Synthetic fetch faithfully models ordinary fetch following 307 when redirect
// handling is omitted. No network, credentials, sessions or live data are used.
const origin = 'https://mcp.fixture.invalid';
const foreign = 'https://untrusted.fixture.invalid';
function redirectFetch(cross, calls) {
  return async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init.headers);
    const row = { url, method: init.method || 'GET', credential: headers.has('authorization') || headers.has('x-fnos-canary'), body: typeof init.body === 'string' && init.body.includes('synthetic-private-body') };
    calls.push(row);
    const destination = cross ? foreign + '/sink' : origin + '/second';
    if (url === origin + '/mcp') {
      if (init.redirect === 'manual') return new Response(null, { status: 307, headers: { location: destination } });
      if (init.redirect === 'error') throw new TypeError('synthetic redirect rejected');
      // Fault/control: ordinary auto-follow forwards a POST and custom headers.
      calls.push({ ...row, url: destination });
    } else assert.equal(url, destination, 'unexpected synthetic redirect request');
    return Response.json({ jsonrpc: '2.0', id: 31, result: { content: [{ type: 'text', text: 'gate-ok' }] } });
  };
}
async function httpRedirect(cross, unsafe = false) {
  const calls = [], received = [];
  const transport = new sdk.StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
    fetch: redirectFetch(cross, calls),
    requestInit: { headers: { 'x-fnos-canary': 'synthetic-credential' } },
    ...(unsafe ? { redirectPolicy: 'follow' } : {}),
  });
  transport.onmessage = message => received.push(message);
  transport.onerror = () => {};
  await transport.start();
  try {
    const sending = transport.send({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'gate', arguments: { note: 'synthetic-private-body' } } });
    if (cross && !unsafe) await assert.rejects(sending); else await sending;
  } finally { await transport.close(); }
  return { calls, received };
}
const didNotLeak = calls => assert(!calls.some(call => new URL(call.url).origin === foreign), 'foreign redirect must never receive custom headers or a request body');
const blocked = await httpRedirect(true);didNotLeak(blocked.calls);
assert(blocked.calls.length === 1 && blocked.calls[0].credential && blocked.calls[0].body, 'the protected request must actually carry synthetic canaries');
const same = await httpRedirect(false);didNotLeak(same.calls);
assert.equal(same.calls.length, 2);assert.equal(same.received[0]?.id, 31, 'legitimate same-origin redirects must still deliver responses');
assert(same.calls.every(call => call.method === 'POST' && call.credential && call.body));
const faulty = await httpRedirect(true, true);
assert.throws(() => didNotLeak(faulty.calls), assert.AssertionError, 'negative control must catch an injected unsafe follow policy');
didNotLeak((await httpRedirect(true)).calls);

function tokenRedirect(cross, calls) {
  return async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init.headers);
    const row = { url, method: init.method || 'GET', credential: headers.has('authorization') };
    calls.push(row);
    if (url.includes('oauth-protected-resource')) return Response.json({ resource: serverUrl, authorization_servers: [expectedIssuer] });
    if (url.includes('/.well-known/')) return Response.json({ issuer: expectedIssuer, authorization_endpoint: expectedIssuer + '/authorize', token_endpoint: expectedIssuer + '/token', grant_types_supported: ['client_credentials'], response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['client_secret_basic'] });
    if (url === expectedIssuer + '/token') {
      const destination = cross ? foreign + '/token' : expectedIssuer + '/token-second';
      if (init.redirect === 'manual') return new Response(null, { status: 307, headers: { location: destination } });
      if (init.redirect === 'error') throw new TypeError('synthetic token redirect rejected');
      calls.push({ ...row, url: destination });
    } else assert.equal(url, expectedIssuer + '/token-second');
    return Response.json({ access_token: 'synthetic-token-only', token_type: 'Bearer', expires_in: 3600 });
  };
}
for (const cross of [true, false]) {
  const calls = [], provider = new sdk.ClientCredentialsProvider({ clientId: 'synthetic-client', clientSecret: 'synthetic-not-live', expectedIssuer });
  const result = sdk.auth(provider, { serverUrl, fetchFn: tokenRedirect(cross, calls) });
  if (cross) await assert.rejects(result); else assert.equal(await result, 'AUTHORIZED');
  didNotLeak(calls);
  assert(calls.some(call => call.url === expectedIssuer + '/token' && call.method === 'POST' && call.credential), 'OAuth negative test must reach the credential-bearing token request');
}
console.log('MCP pre-pack gate: client ' + sdkMeta.version + ', exact DSH/bridge ABI, foreign issuer blocked, HTTP/OAuth cross-origin redirects blocked, same-origin success and injected-fault detection passed');
