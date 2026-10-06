import fs from 'node:fs';
import path from 'node:path';

const runtime = process.argv[2];
if (!runtime) throw new Error('Pass the installed runtime directory');

// Resolve a @deepseek-ai package directory. npm may hoist the package to the
// top level or nest it under the dsh package (0.2.0 does both depending on
// conflict resolution), so every lookup tries the flat path first, then the
// nested one. Returning null lets callers skip with a clear message instead
// of an opaque ENOENT.
function pkgRoot(packageName) {
  const top = path.join(runtime, 'node_modules', '@deepseek-ai', packageName);
  if (fs.existsSync(path.join(top, 'package.json'))) return top;
  const nested = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', packageName);
  if (fs.existsSync(path.join(nested, 'package.json'))) return nested;
  return null;
}
function pkgFile(packageName, ...parts) {
  const root = pkgRoot(packageName);
  return root ? path.join(root, ...parts) : null;
}

const coreRoot = pkgRoot('dsh');
if (!coreRoot) throw new Error('dsh core package not found in the runtime');
const core = JSON.parse(fs.readFileSync(path.join(coreRoot, 'package.json'), 'utf8'));
const connectionFile = pkgFile('dsh-client-connection', 'lib', 'client.js');
if (!connectionFile) throw new Error(`dsh ${core.version}: dsh-client-connection missing from the runtime`);
const metadata = JSON.parse(fs.readFileSync(path.join(pkgRoot('dsh-client-connection'), 'package.json'), 'utf8'));
if (metadata.version !== core.version) throw new Error(`dsh ${core.version} and client connection ${metadata.version} differ`);

// ---------------------------------------------------------------------------
// Trust anchor: the browser half decides whether a page origin is trusted for
// host-channel RPCs. fnOS always authenticates the frame at the gateway
// (admin ticket + session cookie) before anything reaches the core, so loopback
// is not the right predicate for us — the gateway origin must always count.
// ---------------------------------------------------------------------------
{
  const file = connectionFile;
  const source = fs.readFileSync(file, 'utf8');
  const anchor = 'isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),';
  const occurrences = source.split(anchor).length - 1;
  if (occurrences !== 1) throw new Error(`dsh ${core.version} needs a new fnOS adapter: expected one client trust anchor, found ${occurrences}`);
  fs.writeFileSync(file, source.replace(anchor, 'isLoopback: true, /* fnOS HTTPS gateway authenticates via NAS admin ticket before forwarding */'));
  console.log(`Patched ${path.relative(runtime, file)} for authenticated fnOS gateway`);
}

// ---------------------------------------------------------------------------
// 0.2.0 made every browser route document-relative (upstream note:
// web-document-relative-app-routes): routes ship as `"/path".slice(1)` and are
// resolved against document.baseURI. A subpath deployment therefore inherits
// its prefix for free, and the seven fnOS gateway-prefix rewrites that 0.1.5
// needed are gone.
//
// These assertions pin that contract. If a future core reverts a route to an
// absolute path, the build fails HERE with a named package instead of shipping
// a core whose browser half silently bypasses the gateway prefix (the exact
// class of bug that produced those rewrites in the first place).
// ---------------------------------------------------------------------------
function assertAnchor(packageName, anchor, label) {
  const file = pkgFile(packageName, 'lib', 'client.js');
  if (!file) throw new Error(`dsh ${core.version}: package ${packageName} not found (needed to verify ${label})`);
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes(anchor)) {
    throw new Error(`dsh ${core.version}: ${packageName} (${label}) no longer carries its relative-route anchor — re-check fnOS gateway-prefix assumptions before bumping`);
  }
  console.log(`Verified ${packageName} keeps its document-relative route (${label})`);
}

assertAnchor('dsh-client-connection',
  '`${channel}/${endpoint}`.slice(1)',
  'unary RPC relative to document');
assertAnchor('dsh-api-gateway',
  'globals.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI',
  'remote mux base falls back to document.baseURI');
assertAnchor('dsh-client-hmr',
  'new EventSource(EVENTS_ROUTE)',
  'SSE events route');
assertAnchor('dsh-client-hmr',
  'const EVENTS_ROUTE = "/plugins/events".slice(1);',
  'SSE events route stays relative');
assertAnchor('dsh-client-file-upload',
  'new URL(request.path, document.baseURI)',
  'upload resolves against document.baseURI');
assertAnchor('dsh-session-log-export',
  'const SESSION_LOG_EXPORT_ROUTE = "/api/session.export".slice(1);',
  'session export route stays relative');
assertAnchor('dsh-client-ui-deliverables',
  'const PRESENT_OPEN_ROUTE = PRESENT_OPEN_PATH.slice(1);',
  'present.open route stays relative');
assertAnchor('dsh-client-ui-deliverables',
  'const PRESENT_HOST_ROUTE = PRESENT_HOST_PATH.slice(1);',
  'present.host route stays relative');

// The old preview-bundle bug (a bare `typeof Iterator.prototype.join`
// dereferencing a missing global) was fixed upstream in 0.2.0 — the eager
// entry no longer carries it. Scan the EAGER entry points (client.js +
// index.js): a bare dereference there crashes module import on engines
// without iterator helpers ("Failed to load plugins" on Chromium 107).
//
// Carve-out: lib/client.pdf.js still carries the bare form, but it is loaded
// lazily (react.lazy + require.async) only when a PDF preview renders, and by
// then the legacy-compat shim injected into index.html <head> has already
// defined the Iterator global — so the expression only ever evaluates when the
// global exists. That dependency is why patchLegacyCompat must FAIL the build
// when the shim cannot be injected, never skip silently.
{
  const eager = ['lib/client.js', 'lib/index.js']
    .map((rel) => pkgFile('dsh-client-ui-sidebar-documentpreview', rel))
    .filter((file) => file && fs.existsSync(file));
  for (const file of eager) {
    if (fs.readFileSync(file, 'utf8').includes('typeof Iterator.prototype.join')) {
      throw new Error(`dsh ${core.version}: the unguarded Iterator.prototype.join dereference is back in ${path.basename(file)} — re-add the iterator guard (or move the code behind a lazy load like client.pdf.js)`);
    }
  }
  console.log('Verified the legacy-unsafe iterator guard stays removed from the eager entries');
}

// ---------------------------------------------------------------------------
// Composer seat background patch: the seat paints with color-mix(), which any
// engine below Chromium 111 drops ENTIRELY (it does not fall back to
// transparent), so the seat loses its background while remaining
// position:absolute/sticky over the scrolling view — every row scrolls straight
// through the composer, its toolbar and the status footer. Rewriting the one
// declaration to rgba() keeps the layered gradient intact.
// ---------------------------------------------------------------------------
(function patchComposerSeatBackground() {
  const target = pkgFile('dsh-client-ui-conversation', 'lib', 'client.js');
  if (!target || !fs.existsSync(target)) {
    console.log('conversation shell not found; skipped composer seat background patch');
    return;
  }
  const source = fs.readFileSync(target, 'utf8');
  const anchor = 'color-mix(in srgb, var(--dsw-alias-bg-base) 0%, transparent)';
  if (!source.includes(anchor)) {
    console.log('composer seat background is already engine-portable; skipped');
    return;
  }
  fs.writeFileSync(target, source.split(anchor).join('rgba(0, 0, 0, 0)'));
  console.log('Patched composer seat background (color-mix -> rgba) for legacy engines');
})();

// ---------------------------------------------------------------------------
// Inject the legacy-engine compatibility shim into the served frontend
// index.html. The fnOS desktop entry is commonly opened in frozen Chromium 107
// engines (QAX Trusted Browser and friends) that lack APIs the client bundle
// calls directly: AbortSignal.any, Promise.withResolvers/try, URL.parse,
// Array.fromAsync, Iterator + helpers, Object.groupBy, Symbol.dispose,
// ReadableStream async iteration. The shim is a classic script in <head> so it
// runs before the module bundle; every block is guarded by a feature check, so
// modern browsers are untouched.
//
// ⚠ index.html is generated into the runtime, not the repo: this patch is
// idempotent via its marker because a rebuild re-applies it to a fresh copy.
// ---------------------------------------------------------------------------
(function patchLegacyCompat() {
  const compatFile = path.join(path.dirname(runtime), 'legacy-compat.js');
  if (!fs.existsSync(compatFile)) {
    // Never skip silently: the shim is the safety net for every old-engine
    // hazard upstream ships (0.3.45 shipped a broken build exactly this way),
    // including the bare Iterator dereference that client.pdf.js still
    // evaluates lazily. Missing here means the build is incomplete.
    throw new Error('legacy-compat.js missing next to patch-dsh.mjs — the old-engine shim must ship');
  }
  const indexFile = pkgFile('dsh-web-frontend', 'dist', 'index.html');
  if (!indexFile || !fs.existsSync(indexFile)) {
    throw new Error('frontend index.html not found — cannot inject the old-engine shim');
  }
  const marker = '<!-- dsh-legacy-compat:start -->';
  const html = fs.readFileSync(indexFile, 'utf8');
  if (html.includes(marker)) {
    console.log('frontend index.html already carries the compatibility shim');
    return;
  }
  if (!html.includes('<head>')) {
    throw new Error('frontend index.html has no <head> anchor — cannot inject the old-engine shim');
  }
  const polyfill = fs.readFileSync(compatFile, 'utf8');
  if (polyfill.includes('</' + 'script')) {
    throw new Error('legacy-compat.js contains a script terminator — would break the served index.html');
  }
  const block = '<head>\n    <script>\n' + marker + '\n' + polyfill + '\n<!-- dsh-legacy-compat:end -->\n    </script>';
  fs.writeFileSync(indexFile, html.replace('<head>', block));
  console.log('Patched frontend index.html with the legacy-engine compatibility shim');
})();