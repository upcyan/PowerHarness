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
assert.equal(sdkMeta.version, '2.2.0', 'MCP client must resolve to the exact patched version');
const bridgeMeta = JSON.parse(fs.readFileSync(path.join(path.dirname(bridgeEntry), '../package.json'), 'utf8'));
assert.equal(bridgeMeta.version, '0.2.0-rc.2');
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
console.log('MCP pre-pack gate: client 2.2.0, DSH RC2 ABI, foreign issuer blocked, legitimate issuer authorized');
