// 管理页「命令行」视图的后端：让管理员快速执行 dsh / npm / pnpm 命令，
// 不必为一条查询开 SSH。
//
// 安全边界（与整个管理页同一信任级别 —— 管理员已经能改 patch 配置注入 JS）：
//   * 只有 dsh / npm / pnpm 三个前缀，其余一律拒绝；
//   * 不经过 shell，argv 数组直接 spawn，无法拼接重定向或管道；
//   * 拒绝命令分隔符类字符（; | & ` $ > < 换行）作为纵深防御；
//   * 60 秒超时、输出截断 64KB、同时只允许一条命令在跑。
const path = require('node:path');
const fs = require('node:fs');
const cli = require('./plugins.js');
const ops = require('./ops.js');
const coordination = require('./config-coordination.js');

const ALLOWED = new Set(['dsh', 'npm', 'pnpm']);
const FORBIDDEN = /[;&|`$><\r\n]/;
const MAX_OUTPUT = 64 * 1024;
const TIMEOUT = 60_000;
const HISTORY_KEEP = 20;
const HISTORY_FILE = 'terminal-history.json';

function runtimeBin(file) {
  return path.join(process.env.FNOS_APP_DIR, 'runtime', 'node_modules', '.bin', file);
}

function dshEntry() {
  return path.join(process.env.FNOS_APP_DIR, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

// 拆分为 argv（不经 shell）。返回 { argv, display }。
function resolveArgv(commandText) {
  const raw = String(commandText || '');
  // 先对原文做分隔符检查：空白类字符（含换行）会被下面的 split 吃掉，
  // 事后逐 token 检查就拦不住 "dsh x\necho pwned" 这类输入了。
  if (FORBIDDEN.test(raw)) throw new Error('命令包含不允许的字符（如 ; | & ` $ > < 换行）');
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new Error('命令为空');
  if (tokens.length > 32) throw new Error('参数过多');
  const head = tokens[0];
  if (!ALLOWED.has(head)) {
    throw new Error(`只允许 ${[...ALLOWED].join(' / ')} 开头的命令（收到「${head}」）`);
  }
  let argv;
  if (head === 'dsh') argv = [dshEntry(), ...tokens.slice(1)];
  else if (head === 'pnpm') argv = [runtimeBin('pnpm'), ...tokens.slice(1)];
  else argv = [process.env.FNOS_NPM_BIN || path.join(path.dirname(process.execPath), 'npm'), ...tokens.slice(1)];
  const display = argv.map((part) => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ');
  return { argv, display };
}

function readHistory(dataDir) {
  return ops.readJson(ops.dataPath(dataDir, HISTORY_FILE), []);
}

function appendHistory(dataDir, entry) {
  const history = readHistory(dataDir);
  history.unshift(entry);
  ops.writeJson(ops.dataPath(dataDir, HISTORY_FILE), history.slice(0, HISTORY_KEEP));
}

function storeDirFor(dataDir, profile, plugins) {
  try { return plugins.runtimeStoreDir(dataDir, profile); } catch { return ops.dataPath(dataDir, 'pnpm-store'); }
}

// 执行并把结果写入历史（最新在前）。绝不 throw —— 非零退出属于正常结果，
// 由调用方读返回值。
async function run(dataDir, profile, commandText, logFile, plugins) {
  try {
    // argv can select a different profile or install prefix: keep the whole
    // application's data barrier, not merely the terminal's working directory.
    return await coordination.withDataLock(dataDir, () => runLocked(dataDir, profile, commandText, logFile, plugins));
  } catch (error) {
    return { time: new Date().toISOString(), command: String(commandText || ''), code: -1, output: error.message,
      closed: !coordination.isUnconfirmed(error), errorCode: error.code || null };
  }
}
async function runLocked(dataDir, profile, commandText, logFile, plugins) {
  const appDir = process.env.FNOS_APP_DIR;
  if (!appDir) return { command: commandText, code: -1, output: 'Missing fnOS application path' };
  let argv, display;
  try { ({ argv, display } = resolveArgv(commandText)); }
  catch (error) { return { command: String(commandText || ''), code: -1, output: error.message }; }
  let entry;
  try {
    const env = { ...process.env,
      DSH_HOME: ops.dataPath(dataDir, 'dsh-home'),
      PNPM_HOME: ops.dataPath(dataDir, 'pnpm-home'),
      npm_config_store_dir: storeDirFor(dataDir, profile, plugins),
      PATH: `${path.join(appDir, 'runtime', 'node_modules', '.bin')}${path.delimiter}${process.env.PATH || ''}`,
    };
    // Bind directly launched Node scripts; shell/native overrides must keep
    // their original executable semantics (not be parsed as JavaScript).
    let nodeScript = /\.[cm]?js$/.test(argv[0]);
    if (!nodeScript) {
      try {
        const fd = fs.openSync(argv[0], 'r');
        try {
          const head = Buffer.alloc(256), size = fs.readSync(fd, head, 0, head.length, 0);
          nodeScript = /^#![^\n]*\bnode\b/.test(head.subarray(0, size).toString());
        } finally { fs.closeSync(fd); }
      } catch { /* spawn will report missing/inaccessible executables */ }
    }
    const command = nodeScript ? process.execPath : argv[0];
    const args = nodeScript
      ? ['--require', require('./port-owner.js').instancePreload(dataDir), ...argv]
      : argv.slice(1);
    const result = await cli.runCli(command, args, {
      cwd: ops.dataPath(dataDir, 'dsh-home', 'profiles', profile), env,
      collectStderr: true, maxOutput: MAX_OUTPUT, timeoutMs: TIMEOUT, allowFailure: true,
    });
    entry = { time: new Date().toISOString(), command: display, code: result.code, output: result.text, closed: true };
  } catch (error) {
    if (coordination.isUnconfirmed(error)) coordination.retain(dataDir, { errorCode: error.code || 'CLI_UNCONFIRMED', phase: 'terminal-unconfirmed' });
    entry = { time: new Date().toISOString(), command: display, code: -1,
      output: `${error.text || ''}${error.text ? '\n' : ''}${error.message}`, closed: error.closed === true };
  }
  try { appendHistory(dataDir, entry); }
  catch (error) { entry.historyError = error.message; }
  return entry;
}

module.exports = { run, resolveArgv, readHistory, ALLOWED };
