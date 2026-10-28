'use strict';
const fs = require('node:fs');
const path = require('node:path');
const isolated = require('./diagnostic-profile');
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
function version(value) { return typeof value === 'string' && value.length <= 80 && VERSION.test(value) ? value : null; }
function readable(dataDir, ...parts) {
  try { const directory = isolated.boundary(dataDir, ...parts); if (!fs.lstatSync(directory).isDirectory()) return false; fs.accessSync(directory, fs.constants.R_OK); return true; } catch { return false; }
}
function parse(raw) { try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } }
function collect(dataDir, yaml, appDir) {
  const info = isolated.source(dataDir), prefix = ['dsh-home', 'profiles', info.targetProfile];
  let manifest = {};
  try { manifest = parse(isolated.readSourceText(dataDir, info.targetProfile, 'package.json')); } catch {}
  const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies) ? manifest.dependencies : {};
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const plugins = Object.keys(dependencies).filter(name => name.length <= 160 && PACKAGE.test(name)).sort().slice(0, 100).map(name => {
    let installed = {}, filesOk = false;
    const parts = [...prefix, 'node_modules', ...name.split('/')];
    try {
      installed = parse(isolated.text(dataDir, [...parts, 'package.json']));
      const patch = installed.dsh?.bundle?.patch;
      if (installed.name === name && typeof patch === 'string' && /^\.\/[a-zA-Z0-9._/-]+\.ya?ml$/.test(patch) && !patch.split('/').includes('..')) {
        const filename = isolated.boundary(dataDir, ...parts, ...patch.slice(2).split('/'));
        const file = fs.lstatSync(filename); filesOk = file.isFile() && !file.isSymbolicLink();
      }
    } catch {}
    return { name, version: version(installed.version) || version(dependencies[name]), enabled: bundles.includes(name), filesOk };
  });
  let coreVersion = null;
  if (typeof appDir === 'string' && appDir) {
    try { coreVersion = version(parse(isolated.text(appDir, ['runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'])).version); } catch {}
  }
  return { schema: 1, coreVersion, directories: { targetProfileReadable: readable(dataDir, ...prefix), pluginDirectoryReadable: readable(dataDir, ...prefix, 'node_modules') }, plugins };
}
module.exports = { collect };
