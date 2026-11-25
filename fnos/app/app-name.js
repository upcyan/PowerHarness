'use strict';
// Resolve the name this instance shows to the user.
//
// Nothing in the process environment carries it: fnOS exports appname-style
// TRIM_* vars, and the supervisor does not export the human-facing title.
// The title lives in the packaged ui/config, next to this file, so read it
// from there. Every instance gets its own name for free -- a derived build
// (大肥鱼2号) and the original (DeepSeek Harness) share this code unchanged.
const fs = require('node:fs');
const path = require('node:path');

const FALLBACK = '本应用';
let cached = null;

function fromUiConfig() {
  const file = path.join(__dirname, 'ui', 'config');
  try {
    const ui = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of Object.values(ui['.url'] || {})) {
      const title = String((entry || {}).title || '').trim();
      if (title) return title;
    }
  } catch { /* 读不到就用下一个来源 */ }
  return null;
}

function fromManifest() {
  // The main app ships a short-form manifest here; derived builds add
  // display_name. Both are package-level, so they stay instance-specific.
  for (const dir of [process.env.TRIM_APPDEST, process.env.FNOS_APP_DIR, __dirname]) {
    if (!dir) continue;
    try {
      let display = '';
      let packageName = '';
      for (const line of fs.readFileSync(path.join(dir, 'manifest'), 'utf8').split(String.fromCharCode(10))) {
        const at = line.indexOf('=');
        if (at < 0) continue;
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (!value) continue;
        if (key === 'display_name') display = value;
        else if (key === 'appname') packageName = value;
      }
      if (display) return display;
      if (packageName) return packageName;
    } catch { /* 换下一个来源 */ }
  }
  return null;
}

function appName() {
  if (cached) return cached;
  cached = fromUiConfig()
    || String(process.env.TRIM_APP_DISPLAY_NAME || '').trim()
    || fromManifest()
    || String(process.env.TRIM_APPNAME || process.env.TRIM_PKGNAME || '').trim()
    || FALLBACK;
  return cached;
}

module.exports = { appName };
