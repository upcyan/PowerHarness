'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// A bounded COUNT group is converted atomically before DSH's credential-name
// scrub. PARAMETERS survives that scrub; no transport policy belongs here.
const MAX_CONFIG_COUNT = 1024;
// Stay below Linux's per-environment-string exec limit after atomization.
const MAX_CONFIG_BYTES = 64 * 1024;
const RULES = [
  ['git+ssh://git@github.com/', 'https://github.com/'],
  ['ssh://git@github.com/', 'https://github.com/'],
  ['git@github.com:', 'https://github.com/'],
];
function invalid(field) {
  const error = new Error(`Invalid inherited Git configuration (${field}); refusing child environment`);
  error.code = 'ERR_GIT_CONFIG_ENV';
  return error;
}
function quoteEntry(entry) {
  return `'${entry.replace(/'/g, "'\\''")}'`;
}

/** Return a COMPLETE, fresh parent environment, not an overlay.
 * Use the return value as the spawn env base: spreading the old env afterwards
 * would reintroduce the fragile COUNT group. No rewrite/prompt/SSH policy added.
 * COUNT precedes existing PARAMETERS, matching Git's original precedence.
 * Invalid groups throw ERR_GIT_CONFIG_ENV without disclosing keys or values.
 */
function normalizeGitParentEnv(env = process.env) {
  const result = { ...env };
  const parameters = env.GIT_CONFIG_PARAMETERS;
  if (parameters !== undefined && (typeof parameters !== 'string' || parameters.includes('\0') || Buffer.byteLength(parameters) > MAX_CONFIG_BYTES)) {
    throw invalid('GIT_CONFIG_PARAMETERS');
  }
  const raw = env.GIT_CONFIG_COUNT;
  const entries = [];
  let bytes = parameters ? Buffer.byteLength(parameters) : 0;
  if (raw !== undefined) {
    if (typeof raw !== 'string' || !/^[0-9]{1,10}$/.test(raw)) throw invalid('GIT_CONFIG_COUNT');
    const count = Number(raw);
    if (!Number.isSafeInteger(count) || count > MAX_CONFIG_COUNT) throw invalid('GIT_CONFIG_COUNT limit');
    for (let index = 0; index < count; index += 1) {
      const key = env[`GIT_CONFIG_KEY_${index}`];
      const value = env[`GIT_CONFIG_VALUE_${index}`];
      if (typeof key !== 'string' || !key || key.includes('\0') || !/^[A-Za-z][A-Za-z0-9-]*\.(?:.*\.)?[A-Za-z][A-Za-z0-9-]*$/s.test(key)) throw invalid(`GIT_CONFIG_KEY_${index}`);
      if (typeof value !== 'string' || value.includes('\0')) throw invalid(`GIT_CONFIG_VALUE_${index}`);
      // Git's split key/value PARAMETERS grammar also preserves empty values,
      // equals signs, newlines, spaces, backslashes and single quotes exactly.
      const entry = `${quoteEntry(key)}=${quoteEntry(value)}`;
      bytes += Buffer.byteLength(entry) + 1;
      if (bytes > MAX_CONFIG_BYTES) throw invalid('configuration size limit');
      entries.push(entry);
    }
  }
  delete result.GIT_CONFIG_COUNT;
  for (const name of Object.keys(result)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete result[name];
  }
  if (entries.length) result.GIT_CONFIG_PARAMETERS = [...entries, parameters].filter((item) => item !== undefined && item !== '').join(' ');
  return result;
}

// A positive installation decision is necessary, not sufficient. Respect
// agents, explicit commands, user SSH files and inherited/file Git transport
// configuration. Probe failures fail closed, never discard user configuration.
function hasSshIntent(env, cwd) {
  if (['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT'].some((key) => Object.hasOwn(env, key))) return true;
  const home = env.HOME || os.homedir();
  try {
    fs.lstatSync(path.join(home, '.ssh', 'config'));
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return true;
  }
  const probe = spawnSync('git', ['config', '--get-regexp', '^(core\\.sshcommand|url\\..*\\.(insteadof|pushinsteadof))$'], {
    env, cwd, encoding: 'utf8', timeout: 3000, maxBuffer: MAX_CONFIG_BYTES,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  // Any existing transport override is intentional; no need to expose its value.
  return !!probe.error || probe.status !== 1;
}

/** Installation-only COMPLETE environment. The caller must explicitly identify
 * an approved public GitHub shorthand add (never SSH URI, registry, tarball,
 * repair, audit or remove). sshIntent additionally covers profile SSH sources.
 */
function gitInstallEnv(env = process.env, { publicGithubShorthand = false, sshIntent = false, cwd } = {}) {
  const result = normalizeGitParentEnv(env);
  result.GIT_TERMINAL_PROMPT = '0';
  if (!publicGithubShorthand || sshIntent || hasSshIntent(result, cwd)) return result;
  const entries = RULES.map(([from, to]) => `${quoteEntry(`url.${to}.insteadOf`)}=${quoteEntry(from)}`);
  result.GIT_CONFIG_PARAMETERS = [result.GIT_CONFIG_PARAMETERS, ...entries].filter((item) => item !== undefined && item !== '').join(' ');
  return result;
}

module.exports = { normalizeGitParentEnv, gitInstallEnv, MAX_CONFIG_COUNT, RULES };
