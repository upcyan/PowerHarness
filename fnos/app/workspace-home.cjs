const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

function chooseHome(current, fallback) {
  try { if (fs.statSync(current).isDirectory()) return current; } catch {}
  if (!path.isAbsolute(fallback || '') || !fs.statSync(fallback, { throwIfNoEntry: false })?.isDirectory()) return current;
  return fallback;
}

if (process.env.FNOS_WORKSPACE_HOME) {
  const original = os.homedir;
  os.homedir = () => chooseHome(original(), process.env.FNOS_WORKSPACE_HOME);
  syncBuiltinESMExports();
}

module.exports = { chooseHome };
