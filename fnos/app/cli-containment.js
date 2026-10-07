'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { getSystemErrorName } = require('node:util');
const helper = path.join(__dirname, 'cli-supervisor');
const signalNames = new Map(Object.entries(os.constants.signals).map(([name, value]) => [value, name]));
// Match Node child_process canonical names, not numeric aliases such as SIGIOT.
for (const name of ['SIGABRT', 'SIGCHLD', 'SIGIO']) {
  if (os.constants.signals[name] !== undefined) signalNames.set(os.constants.signals[name], name);
}
function unavailable(cause) {
  return Object.assign(new Error('管理 CLI 后代隔离助手不可用；拒绝直接运行，请安装完整应用包', { cause }), { code: 'ERR_CLI_CONTAINMENT', closed: true });
}
function prepare(command, args) {
  try { fs.accessSync(helper, fs.constants.X_OK); } catch (cause) { throw unavailable(cause); }
  const nonce = crypto.randomBytes(16).toString('hex');
  let text = '', ended = false, invalid = false;
  return {
    command: helper, args: [nonce, command, ...args],
    attach(child) {
      const stream = child.stdio?.[3];
      if (!stream) { invalid = true; return; }
      stream.on('data', chunk => {
        if (invalid) return;
        if (Buffer.byteLength(text) + chunk.length > 256) { invalid = true; text = ''; return; }
        text += chunk.toString('utf8');
      });
      stream.once('error', () => { invalid = true; text = ''; });
      stream.once('end', () => { ended = true; });
    },
    result() {
      if (invalid || !ended) return null;
      const match = /^FNOSCLI1 ([a-f0-9]{32}) (exit|signal|exec|setup) ([0-9]{1,3})\n$/.exec(text);
      if (!match || match[1] !== nonce) return null;
      const value = Number(match[3]), kind = match[2];
      if (kind === 'exit') return value <= 255 ? { code: value, signal: null } : null;
      if (kind === 'signal') return signalNames.has(value) ? { code: null, signal: signalNames.get(value) } : null;
      if (value === 0) return null;
      let systemCode;
      try { systemCode = getSystemErrorName(-value); } catch { return null; }
      const error = kind === 'setup' ? unavailable(Object.assign(new Error(systemCode), { code: systemCode }))
        : Object.assign(new Error(`CLI exec failed (${systemCode})`), { code: systemCode });
      return { code: null, signal: null, error };
    },
  };
}
module.exports = { prepare, unavailable };
