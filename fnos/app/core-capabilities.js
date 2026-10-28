'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
function fromHelp(help, adapter) {
  const flags = new Set((String(help).match(/--[a-z][a-z0-9-]*/g) || []));
  const required = [...new Set(adapter.args.filter(x => typeof x === 'string' && x.startsWith('--')))];
  const missing = required.filter(x => !flags.has(x));
  return { schema: 1, status: missing.length ? 'incompatible' : 'compatible', observedFlags: [...flags].sort(), requiredFlags: required, missingFlags: missing, version: adapter.version, note: '参数能力检查不替代核心适配版本、健康检查和隔离启动验收。' };
}
function inspect(directory, adapter, { execute = execFileSync, env = process.env } = {}) {
  const target = adapter.bin;
  if (path.resolve(target) !== target || !fs.statSync(target).isFile()) throw new Error('Invalid core executable');
  // In profile-based DSH, "web --help" selects profile web and composes it
  // before interpreting app arguments. Top-level help exits without booting.
  const home = env.HOME || (env.FNOS_DATA_DIR ? path.join(env.FNOS_DATA_DIR, 'home') : os.userInfo().homedir);
  const probeEnv = { PATH: env.PATH || '', HOME: home, LANG: 'C.UTF-8', ...(env.DSH_HOME ? { DSH_HOME: env.DSH_HOME } : {}) };
  const help = execute(process.execPath, [target, '--help'], { timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8', env: probeEnv });
  const result = fromHelp(help, adapter);
  if (result.missingFlags.length && result.observedFlags.includes('--profile')) {
    return { ...result, status: 'unknown', probe: 'top-level-help', note: '此版本采用 profile CLI，顶层帮助未声明内部 Web 参数；未启动或改写配置档。缺失标记不代表核心不兼容，请另做隔离启动验收。' };
  }
  return { ...result, probe: 'top-level-help' };
}
module.exports = { fromHelp, inspect };
