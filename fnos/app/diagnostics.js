const fs = require('node:fs');
const path = require('node:path');
const ops = require('./ops.js');

const maxBytes = 512 * 1024;
const sources = new Set(['gateway', 'supervisor', 'dsh']);

function fileFor(dataDir, source) {
  if (!sources.has(source)) throw new Error('Invalid log source');
  return ops.dataPath(dataDir, source === 'dsh' ? 'dsh.log' : `${source}-events.log`);
}

// 轮转保留代数：从 3 提到 10（0.3.61）。原先 3 代意味着连续 4 次启动/超时就会把
// 最早的启动日志 rm 掉——而「启动失败 → 重启 → 回滚」往往连续发生，证据正好落进
// 被丢弃的那一代（10-01 的 90 秒超时排查差点因此失去关键线索）。
function rotate(file, force = false, limit = maxBytes, keep = 10) {
  if (!fs.existsSync(file) || (!force && fs.statSync(file).size < limit)) return;
  fs.rmSync(`${file}.${keep}`, { force: true });
  for (let index = keep - 1; index >= 1; index--) {
    if (fs.existsSync(`${file}.${index}`)) fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
}

// 启动时轮转并写入带时间戳的启动头（core 目录 + profile）：排查启动问题一眼能看出
// 「这次启动是什么时候、跑的是哪个核心」，不必依赖文件 mtime。
function startDshLog(dataDir, marker = '') {
  const file = fileFor(dataDir, 'dsh');
  if (fs.existsSync(file) && fs.statSync(file).size) rotate(file, true);
  const head = '=== dsh core start ' + new Date().toISOString() + (marker ? ' [' + marker + ']' : '') + ' ===\n';
  fs.writeFileSync(file, head, { mode: 0o600 });
}

// 每行加时间戳（0.3.61）：启动卡死时最关键的信息是「最后一条输出发生在何时」，
// 借此能区分「卡在某一步」与「根本没输出」。流式 chunk 可能切断行，此时各行带各自
// 的时间戳，仍然可读。
function appendDsh(dataDir, chunk) {
  const file = fileFor(dataDir, 'dsh');
  try {
    rotate(file, false, 2 * 1024 * 1024);
    const stamp = new Date().toISOString().slice(11, 19);
    const raw = String(chunk);
    const limited = raw.slice(0, 16384) + (raw.length > 16384 ? '\n[log chunk truncated]\n' : '');
    const lines = limited.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === '' && index === lines.length - 1) continue;
      out.push('[' + stamp + '] ' + line);
    }
    if (out.length) fs.appendFileSync(file, out.join('\n') + '\n', { mode: 0o600 });
  } catch (error) {
    process.stderr.write(`[diagnostics] dsh log write failed: ${error.code || 'unknown'}\n`);
  }
}

// 启动失败/超时时归档日志（0.3.61）：轮转代数有限，且失败后通常紧跟重启/数据回滚，
// 关键证据极易消失。归档目录在 startup-reports/ 下（位于 dataDir 根，不在 dsh-home
// 内），因此数据回滚不会波及它。
function archiveDshLogs(dataDir, reason = 'failure', extra = {}, options = {}) {
  try {
    const result = require('./log-archive').archiveLogs(dataDir, reason, extra, { ...options, redact: redactDsh });
    if (!result.retention.withinBudget) process.stderr.write('[diagnostics] archive budget unconfirmed; unverified files preserved\n');
    if (result.truncatedFiles) process.stderr.write(`[diagnostics] archive truncated ${result.truncatedFiles} log file(s); original logs preserved\n`);
    return result;
  } catch (error) {
    process.stderr.write('[diagnostics] archive failed: ' + (error.code || error.message) + '\n');
    return { dir: null, copied: [], archiveError: error.code || 'ARCHIVE_FAILED' };
  }
}

function logger(dataDir, source) {
  const file = fileFor(dataDir, source);
  return (event, details = {}) => {
    if (!/^[a-z_]{1,40}$/.test(event)) throw new Error('Invalid log event');
    let encoded;
    try { encoded = JSON.stringify(details) || 'null'; } catch { encoded = JSON.stringify({ unavailable: true }); }
    const bounded = encoded.length > 16384 ? { truncated: true, sample: redactDsh(encoded.slice(0, 16384)) } : JSON.parse(redactDsh(encoded));
    const entry = { time: new Date().toISOString(), source, event, details: bounded };
    try {
      rotate(file);
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (error) {
      // Diagnostics must never stop the gateway or the supervisor.
      process.stderr.write(`[diagnostics] write failed: ${error.code || 'unknown'}\n`);
    }
  };
}

function origin(value) {
  const text = String(value || '').trim();
  if (text === 'null') return 'null';
  if (text === 'file://' || text === 'file:///') return 'file://';
  if (text === 'about:blank') return 'about:blank';
  if (text.length > 200 || !/^[a-z][a-z0-9+.-]*:\/\/[^/?#@\s]+$/i.test(text)) return null;
  return text;
}

function browserReport(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid browser report');
  const ancestors = Array.isArray(value.ancestors) ? value.ancestors : [];
  if (ancestors.length > 8) throw new Error('Too many ancestor origins');
  const normalized = ancestors.map(origin);
  if (normalized.some((item) => item === null)) throw new Error('Invalid ancestor origin');
  const referrerOrigin = value.referrerOrigin ? origin(value.referrerOrigin) : null;
  if (value.referrerOrigin && !referrerOrigin) throw new Error('Invalid referrer origin');
  const platform = ['android', 'ios', 'other'].includes(value.platform) ? value.platform : 'other';
  const trigger = ['auto', 'manual', 'probe'].includes(value.trigger) ? value.trigger : null;
  const connection = ['reachable', 'unreachable'].includes(value.connection) ? value.connection : null;
  return { ancestors: normalized, referrerOrigin, platform, ...(trigger ? { trigger } : {}), ...(connection ? { connection } : {}) };
}

function read(dataDir, source, maxLines = 200, newestFirst = false) {
  const file = fileFor(dataDir, source);
  const parts = [];
  for (const suffix of ['.3', '.2', '.1', '']) {
    const candidate = `${file}${suffix}`;
    if (fs.existsSync(candidate)) parts.push(fs.readFileSync(candidate, 'utf8'));
  }
  const recent = parts.join('').trimEnd().split('\n').filter(Boolean).slice(-maxLines);
  const text = newestFirst
    ? source === 'dsh'
      ? parts.reverse().map((part) => part.trimEnd().split('\n').filter(Boolean).slice(-maxLines)).flat().slice(0, maxLines).join('\n')
      : recent.reverse().join('\n')
    : recent.join('\n');
  return source === 'dsh' ? redactDsh(text) : text;
}

function redactDsh(value) {
  return String(value)
    .replace(/([?&](?:token|access_token|refresh_token|key|api_key)=)[^\s&#"']+/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|key|secret|password|token)\s*[:=]\s*)[^\s&#"']+/gi, '$1[REDACTED]')
    .replace(/("(?:api[_-]?key|key|secret|password|token|access_token|refresh_token)"\s*:\s*")[^"]+(?=")/gi, '$1[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]')
    .replace(/\b((?:set-cookie|cookie|authorization|x-api-key)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]');
}

module.exports = { logger, browserReport, read, redactDsh, startDshLog, appendDsh, archiveDshLogs };
