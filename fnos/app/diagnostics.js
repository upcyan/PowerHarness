const fs = require('node:fs');
const path = require('node:path');
const ops = require('./ops.js');

const maxBytes = 512 * 1024;
const sources = new Set(['gateway', 'supervisor', 'dsh']);

function fileFor(dataDir, source) {
  if (!sources.has(source)) throw new Error('Invalid log source');
  return ops.dataPath(dataDir, source === 'dsh' ? 'dsh.log' : `${source}-events.log`);
}

function rotate(file, force = false, limit = maxBytes) {
  if (!fs.existsSync(file) || (!force && fs.statSync(file).size < limit)) return;
  fs.rmSync(`${file}.3`, { force: true });
  for (let index = 2; index >= 1; index--) {
    if (fs.existsSync(`${file}.${index}`)) fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
}

function startDshLog(dataDir) {
  const file = fileFor(dataDir, 'dsh');
  if (fs.existsSync(file) && fs.statSync(file).size) rotate(file, true);
  fs.writeFileSync(file, '', { mode: 0o600 });
}

function appendDsh(dataDir, chunk) {
  const file = fileFor(dataDir, 'dsh');
  try {
    rotate(file, false, 2 * 1024 * 1024);
    fs.appendFileSync(file, chunk, { mode: 0o600 });
  } catch (error) {
    process.stderr.write(`[diagnostics] dsh log write failed: ${error.code || 'unknown'}\n`);
  }
}

function logger(dataDir, source) {
  const file = fileFor(dataDir, source);
  return (event, details = {}) => {
    if (!/^[a-z_]{1,40}$/.test(event)) throw new Error('Invalid log event');
    const entry = { time: new Date().toISOString(), source, event, details };
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

module.exports = { logger, browserReport, read, redactDsh, startDshLog, appendDsh };
