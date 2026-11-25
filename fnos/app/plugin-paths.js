const ops = require('./ops.js');

const builtins = [
  '/api', '/plugins', '/assets', '/open-in-app', '/fnos-plugins/static',
  '/fnos-plugins/present', '/codebuddy', '/favicon.svg',
  '/manifest.webmanifest', '/index.html'
];
const maxPaths = 50;

function normalize(value) {
  // Shared plugin namespaces are approved per plugin, never as the whole /_dsh tree.
  if (typeof value === 'string' && /^\/_dsh\/[a-z0-9][a-z0-9-]{0,31}$/.test(value)) return value;
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error('无效的插件 API 路径');
  const segment = value.slice(1).toLowerCase();
  if (['.', '..', 'app', 'api', 'plugins', 'assets', 'index.html', 'favicon.svg', 'manifest.webmanifest'].includes(segment) ||
      segment.startsWith('_fnos') || segment.startsWith('__fnos')) throw new Error('系统路径不能作为插件 API 放行');
  return value;
}

function firstSegment(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) return null;
  const parts = pathname.split(/[?#]/, 1)[0].split('/');
  const candidate = parts[1] === '_dsh' ? '/_dsh/' + (parts[2] || '') : '/' + (parts[1] || '');
  try { return normalize(candidate); }
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
      const plugin = pluginName(item.plugin);
      return [{ path, count: Number.isInteger(item.count) ? Math.min(Math.max(item.count, 1), 9999) : 1,
        lastSeen: typeof item.lastSeen === 'string' ? item.lastSeen : '', ...(plugin ? { plugin } : {}) }];
    } catch { return []; }
  }).slice(0, maxPaths) : [];
  // approved 保持字符串数组（allowed() 与旧数据都依赖它），插件归属另放一张映射表：
  // 这样老文件无需迁移，读不到归属时界面显示「未知来源」而不是编一个。
  const approvedPlugins = {};
  if (saved.approvedPlugins && typeof saved.approvedPlugins === 'object') {
    for (const path of approved) {
      const plugin = pluginName(saved.approvedPlugins[path]);
      if (plugin) approvedPlugins[path] = plugin;
    }
  }
  return { version: 1, approved: [...new Set(approved)], approvedPlugins, candidates };
}

function save(dataDir, value) { ops.writeJson(file(dataDir), value); return value; }

// 插件名字面量校验：来源来自浏览器调用栈，属于不可信输入，不合规就丢弃（不阻断记录）。
function pluginName(value) {
  return typeof value === 'string' && /^(?:@[A-Za-z0-9._-]{1,40}\/)?[A-Za-z0-9._-]{1,64}$/.test(value) ? value : '';
}

function observe(dataDir, pathname, plugin = '') {
  const path = firstSegment(pathname);
  if (!path) return false;
  const value = snapshot(dataDir);
  if (value.approved.includes(path) || builtins.some((item) => pathname === item || pathname.startsWith(item + '/'))) return false;
  const origin = pluginName(plugin);
  const now = new Date().toISOString();
  const current = value.candidates.find((item) => item.path === path);
  if (current && Date.now() - Date.parse(current.lastSeen) < 60_000) return true;
  const candidates = value.candidates.filter((item) => item.path !== path);
  candidates.unshift({ path, count: Math.min((current?.count || 0) + 1, 9999), lastSeen: now, ...(origin ? { plugin: origin } : current?.plugin ? { plugin: current.plugin } : {}) });
  save(dataDir, { ...value, candidates: candidates.slice(0, maxPaths) });
  return true;
}

function change(dataDir, action, input) {
  const path = normalize(input);
  const value = snapshot(dataDir);
  if (action === 'allow') {
    const candidate = value.candidates.find((item) => item.path === path);
    if (!candidate) throw new Error('请先让插件发起请求，待检测到路径后再放行');
    if (!value.approved.includes(path) && value.approved.length >= maxPaths) throw new Error('已达到插件路径放行上限');
    value.approved = [...new Set([...value.approved, path])];
    value.candidates = value.candidates.filter((item) => item.path !== path);
    // 放行时把候选上记到的插件归属一并存下来，之后清单里就能显示是谁要的。
    if (candidate.plugin) value.approvedPlugins = { ...value.approvedPlugins, [path]: candidate.plugin };
  } else if (action === 'dismiss') {
    value.candidates = value.candidates.filter((item) => item.path !== path);
  } else if (action === 'revoke') {
    value.approved = value.approved.filter((item) => item !== path);
    if (value.approvedPlugins) {
      const next = { ...value.approvedPlugins };
      delete next[path];
      value.approvedPlugins = next;
    }
  } else throw new Error('无效的插件路径操作');
  return save(dataDir, value);
}

function allowed(dataDir, pathname) {
  if (pathname === '/') return true;
  const paths = [...builtins, ...snapshot(dataDir).approved];
  return paths.some((item) => pathname === item || pathname.startsWith(item + '/'));
}

module.exports = { builtins, normalize, firstSegment, snapshot, observe, change, allowed };
