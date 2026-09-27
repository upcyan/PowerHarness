const ops = require('./ops.js');

const builtins = [
  '/api', '/plugins', '/assets', '/open-in-app', '/fnos-plugins/static',
  '/fnos-plugins/present', '/codebuddy', '/favicon.svg',
  '/manifest.webmanifest', '/index.html'
];
const maxPaths = 50;

function normalize(value) {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error('无效的插件 API 路径');
  const segment = value.slice(1).toLowerCase();
  if (['.', '..', 'app', 'api', 'plugins', 'assets', 'index.html', 'favicon.svg', 'manifest.webmanifest'].includes(segment) ||
      segment.startsWith('_fnos') || segment.startsWith('__fnos')) throw new Error('系统路径不能作为插件 API 放行');
  return value;
}

function firstSegment(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) return null;
  try { return normalize('/' + (pathname.split('/')[1] || '')); }
  catch { return null; }
}

function file(dataDir) { return ops.dataPath(dataDir, 'plugin-url-paths.json'); }

function snapshot(dataDir) {
  let saved;
  try { saved = ops.readJson(file(dataDir), {}); } catch { saved = {}; }
  const approved = Array.isArray(saved.approved) ? saved.approved.flatMap((item) => {
    try { return [normalize(item)]; } catch { return []; }
  }).slice(0, maxPaths) : [];
  const candidates = Array.isArray(saved.candidates) ? saved.candidates.flatMap((item) => {
    try {
      const path = normalize(item.path);
      if (approved.includes(path)) return [];
      return [{ path, count: Number.isInteger(item.count) ? Math.min(Math.max(item.count, 1), 9999) : 1,
        lastSeen: typeof item.lastSeen === 'string' ? item.lastSeen : '' }];
    } catch { return []; }
  }).slice(0, maxPaths) : [];
  return { version: 1, approved: [...new Set(approved)], candidates };
}

function save(dataDir, value) { ops.writeJson(file(dataDir), value); return value; }

function observe(dataDir, pathname) {
  const path = firstSegment(pathname);
  if (!path) return false;
  const value = snapshot(dataDir);
  if (value.approved.includes(path) || builtins.some((item) => pathname === item || pathname.startsWith(item + '/'))) return false;
  const now = new Date().toISOString();
  const current = value.candidates.find((item) => item.path === path);
  if (current && Date.now() - Date.parse(current.lastSeen) < 60_000) return true;
  const candidates = value.candidates.filter((item) => item.path !== path);
  candidates.unshift({ path, count: Math.min((current?.count || 0) + 1, 9999), lastSeen: now });
  save(dataDir, { ...value, candidates: candidates.slice(0, maxPaths) });
  return true;
}

function change(dataDir, action, input) {
  const path = normalize(input);
  const value = snapshot(dataDir);
  if (action === 'allow') {
    if (!value.candidates.some((item) => item.path === path)) throw new Error('请先让插件发起请求，待检测到路径后再放行');
    if (!value.approved.includes(path) && value.approved.length >= maxPaths) throw new Error('已达到插件路径放行上限');
    value.approved = [...new Set([...value.approved, path])];
    value.candidates = value.candidates.filter((item) => item.path !== path);
  } else if (action === 'dismiss') {
    value.candidates = value.candidates.filter((item) => item.path !== path);
  } else if (action === 'revoke') {
    value.approved = value.approved.filter((item) => item !== path);
  } else throw new Error('无效的插件路径操作');
  return save(dataDir, value);
}

function allowed(dataDir, pathname) {
  if (pathname === '/') return true;
  const paths = [...builtins, ...snapshot(dataDir).approved];
  return paths.some((item) => pathname === item || pathname.startsWith(item + '/'));
}

module.exports = { builtins, normalize, firstSegment, snapshot, observe, change, allowed };
