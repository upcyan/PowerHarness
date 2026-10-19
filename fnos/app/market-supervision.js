'use strict';
const fs = require('node:fs');
const path = require('node:path');
const coordination = require('./config-coordination.js');
const MARKER = '/* fnOS supervisor owns market lifecycle v1 */';
function prepare(profileDir) {
  const packageDir = path.join(profileDir, 'node_modules', 'dshmarket');
  if (!fs.existsSync(packageDir)) return { patched: 0 };
  return coordination.withLock(profileDir, () => {
    const edits = [
      ['restart.js', 'export function restartAllowed(config, env = process.env, ppid = process.ppid) {',
       '    if (env.FNOS_DATA_DIR) return false;'],
      ['restart.js', 'export function scheduleRestart(port = null, recovery) {',
       "    if (process.env.FNOS_DATA_DIR) throw new Error('fnOS supervisor owns restart; use application management');"],
      ['recovery.js', 'export async function runRecoveryCli(argv) {',
       "    if (process.env.FNOS_DATA_DIR) { console.error('fnOS supervisor owns recovery; use application management'); return; }"],
    ];
    const files = new Map();
    // Validate ALL version anchors before touching any file.
    for (const [name, anchor, guard] of edits) {
      const file = path.join(packageDir, 'lib', name);
      const source = files.get(file)?.next ?? fs.readFileSync(file, 'utf8');
      const replacement = anchor + '\n' + MARKER + '\n' + guard;
      if (source.includes(replacement)) continue;
      if (source.split(anchor).length !== 2) throw new Error('Unsupported dshmarket lifecycle API: ' + name);
      const original = files.get(file)?.original ?? source;
      files.set(file, { original, next: source.replace(anchor, replacement) });
    }
    for (const [file, { original, next }] of files) {
      if (fs.readFileSync(file, 'utf8') !== original) throw new Error('dshmarket changed while preparing supervision');
      const evidence = file + '.fnos-original';
      if (!fs.existsSync(evidence)) fs.writeFileSync(evidence, original, { flag: 'wx', mode: 0o600 });
      const temporary = file + '.fnos-' + require('node:crypto').randomUUID();
      try { fs.writeFileSync(temporary, next, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    return { patched: files.size };
  });
}
module.exports = { prepare, MARKER };
