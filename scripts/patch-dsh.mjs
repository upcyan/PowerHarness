import fs from 'node:fs';
import path from 'node:path';

const runtime = process.argv[2];
if (!runtime) throw new Error('Pass the installed runtime directory');
const core = JSON.parse(fs.readFileSync(path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
const packageDir = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh-client-connection');
const metadata = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
if (metadata.version !== core.version) throw new Error(`dsh ${core.version} and client connection ${metadata.version} differ`);
const file = path.join(packageDir, 'lib', 'client.js');
const source = fs.readFileSync(file, 'utf8');
const anchor = 'isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),';
const occurrences = source.split(anchor).length - 1;
if (occurrences !== 1) throw new Error(`dsh ${core.version} needs a new fnOS adapter: expected one client trust anchor, found ${occurrences}`);
const patched = source.replace(anchor, 'isLoopback: true, /* fnOS HTTPS gateway authenticates via NAS admin ticket before forwarding */');
fs.writeFileSync(file, patched);
console.log(`Patched ${path.relative(runtime, file)} for authenticated fnOS gateway`);

function patchOnce(packageName, anchor, replacement) {
  const target = path.join(runtime, 'node_modules', '@deepseek-ai', packageName, 'lib', 'client.js');
  const original = fs.readFileSync(target, 'utf8');
  const count = original.split(anchor).length - 1;
  if (count !== 1) throw new Error(`dsh ${core.version} needs a new fnOS path adapter for ${packageName}: found ${count} anchors`);
  fs.writeFileSync(target, original.replace(anchor, replacement));
  console.log(`Patched ${path.relative(runtime, target)} for fnOS gateway prefix`);
}

patchOnce('dsh-client-connection',
  'new URL(`${channel}/${endpoint}`, resolveBase())',
  'new URL(`${globalThis.__FNOS_GATEWAY_PREFIX__ ?? ""}${channel}/${endpoint}`, resolveBase())');
patchOnce('dsh-api-gateway',
  'new URL(REMOTE_STREAM_MUX_PATH, base)',
  'new URL((globalThis.__FNOS_GATEWAY_PREFIX__ ?? "") + REMOTE_STREAM_MUX_PATH, base)');
patchOnce('dsh-client-hmr',
  'new EventSource(EVENTS_ENDPOINT)',
  'new EventSource((globalThis.__FNOS_GATEWAY_PREFIX__ ?? "") + EVENTS_ENDPOINT)');
patchOnce('dsh-client-file-upload',
  'path: `${FILE_UPLOAD_PATH}?${query.toString()}`',
  'path: `${globalThis.__FNOS_GATEWAY_PREFIX__ ?? ""}${FILE_UPLOAD_PATH}?${query.toString()}`');
patchOnce('dsh-client-ui-deliverables',
  'const PRESENT_OPEN_PATH = "/api/present.open";',
  'const PRESENT_OPEN_PATH = (globalThis.__FNOS_GATEWAY_PREFIX__ ?? "") + "/api/present.open";');
patchOnce('dsh-client-ui-deliverables',
  'const PRESENT_HOST_PATH = "/api/present.host";',
  'const PRESENT_HOST_PATH = (globalThis.__FNOS_GATEWAY_PREFIX__ ?? "") + "/api/present.host";');
patchOnce('dsh-session-log-export',
  'new URL("/api/session.export", hostBase())',
  'new URL((globalThis.__FNOS_GATEWAY_PREFIX__ ?? "") + "/api/session.export", hostBase())');
