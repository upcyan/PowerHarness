const fs = require('node:fs');
const path = require('node:path');

function listeningInodes(port, proc = '/proc') {
  const target = Number(port);
  if (!Number.isInteger(target) || target < 1 || target > 65535) return new Set();
  const result = new Set();
  for (const name of ['tcp', 'tcp6']) {
    let table;
    try { table = fs.readFileSync(path.join(proc, 'net', name), 'utf8'); } catch { continue; }
    for (const line of table.split(/\r?\n/).slice(1)) {
      const columns = line.trim().split(/\s+/);
      const local = columns[1]?.split(':');
      if (columns[3] !== '0A' || Number.parseInt(local?.[1], 16) !== target) continue;
      if (/^\d+$/.test(columns[9] || '') && columns[9] !== '0') result.add(columns[9]);
    }
  }
  return result;
}

function canonical(value) { try { return fs.realpathSync(value); } catch { return path.resolve(value); } }
function envValue(entries, name) {
  const matches = entries.filter((entry) => entry.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}
function homeMatches(environment, expectedHome) {
  const value = envValue(environment, 'DSH_HOME');
  return !!value && canonical(value) === canonical(expectedHome);
}

// stat's comm may contain spaces and ')'; field 22 starts after the LAST ')'.
// Keep starttime as a string: it is a kernel generation identifier, not a JS number.
function processStarttime(pid, proc = '/proc') {
  if (!/^[1-9]\d*$/.test(String(pid))) return null;
  try {
    const stat = fs.readFileSync(path.join(proc, String(pid), 'stat'), 'utf8');
    if (stat.slice(0, stat.indexOf(' ')) !== String(pid)) return null;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    return /^\d+$/.test(fields[19] || '') ? fields[19] : null;
  } catch { return null; }
}

// Only the node entry script counts, never an arbitrary argument to node -e or
// another program. These are the options used by our supervisor/core launcher.
function nodeEntry(argv) {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (['-r', '--require', '--import'].includes(arg)) { i++; continue; }
    if (/^--(?:require|import|inspect|inspect-brk)=/.test(arg) || ['--inspect', '--inspect-brk'].includes(arg)) continue;
    if (arg === '--') return argv[i + 1] || null;
    if (arg.startsWith('-')) return null;
    return arg;
  }
  return null;
}

function coreEntryMatches(entry, appDir, dataDir) {
  const defaultBin = 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js';
  if (entry === canonical(path.join(appDir, defaultBin))) return true;
  // Installed adapters may select another runtime entry. Verify the exact
  // adapter path and version directory rather than accepting a broad regex.
  const root = canonical(path.join(dataDir, 'cores'));
  if (!entry.startsWith(root + path.sep)) return false;
  const relative = path.relative(root, entry).split(path.sep);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(relative[0])) return false;
  const directory = path.join(root, relative[0]);
  try {
    const adapter = JSON.parse(fs.readFileSync(path.join(directory, 'adapter.json'), 'utf8'));
    const bin = adapter.bin || defaultBin;
    const resolved = path.resolve(directory, bin);
    return adapter.contract === 1 && adapter.version === relative[0] &&
      typeof bin === 'string' && bin.replaceAll('\\', '/').startsWith('runtime/') &&
      resolved.startsWith(directory + path.sep) && entry === canonical(resolved);
  } catch { return false; }
}

const markerName = '.fnos-instance.cjs';
const markerContent = '// fnOS instance binding: intentionally no executable code.\n';
function instancePreload(dataDir) {
  const directory = canonical(dataDir), marker = path.join(directory, markerName);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(marker, markerContent, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(marker);
  if (!stat.isFile() || stat.uid !== process.getuid() || fs.readFileSync(marker, 'utf8') !== markerContent) throw new Error('Invalid fnOS instance preload');
  fs.chmodSync(marker, 0o600);
  return marker;
}
function identityUnknown(pid) {
  const error = new Error(`Cannot establish process identity for PID ${pid}; refuse lifecycle cleanup`);
  error.code = 'ERR_IDENTITY_UNKNOWN';
  return error;
}
function preloads(argv) {
  const result = [];
  for (let i = 1; i < argv.length; i++) {
    if (['-r', '--require'].includes(argv[i])) { result.push(argv[++i]); continue; }
    if (argv[i].startsWith('--require=')) { result.push(argv[i].slice(10)); continue; }
    if (argv[i] === '--import') { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    break; // script arguments never count as Node preload identity.
  }
  return result.filter(value => typeof value === 'string' && path.basename(value) === markerName);
}
function recordedSupervisor(pid, starttime, dataDir) {
  try {
    const read = name => {
      const file = path.join(dataDir, name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) return null;
      return fs.readFileSync(file, 'utf8').trim();
    };
    return read('supervisor.pid') === String(pid) && read('supervisor.pid.starttime') === starttime;
  } catch { return false; }
}

// New launches bind the instance in cmdline, without environ/exe/FD ptrace reads.
// A legacy protected PID+birth record may bind a supervisor. Other legacy
// children retain v2 checks when readable; unreadable candidates are UNKNOWN,
// never an empty successful scan (P24/P25).
function processIdentity(pid, dataDir, appDir = process.env.FNOS_APP_DIR || __dirname, proc = '/proc') {
  if (!dataDir || !appDir || !/^[1-9]\d*$/.test(String(pid)) || Number(pid) === process.pid) return null;
  const directory = path.join(proc, String(pid));
  let argv;
  try {
    if (!process.getuid) return null;
    let uid;
    try {
      const status = fs.readFileSync(path.join(directory, 'status'), 'utf8');
      const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
      if (!match) throw identityUnknown(pid);
      uid = Number(match[2]); // proc inode ownership can become root when non-dumpable.
    } catch (error) {
      if (proc === '/proc' || error.code !== 'ENOENT') throw error;
      uid = fs.statSync(directory).uid; // existing synthetic proc contract.
    }
    if (uid !== process.getuid()) return null;
    argv = fs.readFileSync(path.join(directory, 'cmdline'), 'utf8').split('\0').filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw identityUnknown(pid);
  }
  if (!argv.length || (argv[0] !== 'node' && canonical(argv[0]) !== canonical(process.execPath))) return null;
  const rawEntry = nodeEntry(argv);
  if (!rawEntry || !path.isAbsolute(rawEntry)) return null;
  const entry = canonical(rawEntry);
  let role;
  if (entry === canonical(path.join(appDir, 'supervisor.js'))) role = 'supervisor';
  else if (entry === canonical(path.join(appDir, 'gateway.js'))) role = 'gateway';
  else if (coreEntryMatches(entry, appDir, dataDir)) role = 'core';
  else return null;
  const starttime = processStarttime(pid, proc);
  if (!starttime) {
    try { fs.readFileSync(path.join(directory, 'stat')); } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw identityUnknown(pid);
    }
    return null;
  }
  const markers = preloads(argv);
  if (markers.length) {
    if (markers.some(value => canonical(value) !== path.join(canonical(dataDir), markerName))) return null;
  } else if (!(role === 'supervisor' && recordedSupervisor(pid, starttime, dataDir))) {
    try {
      if (canonical(fs.readlinkSync(path.join(directory, 'exe'))) !== canonical(process.execPath)) return null;
      const environment = fs.readFileSync(path.join(directory, 'environ'), 'utf8').split('\0');
      const data = envValue(environment, 'FNOS_DATA_DIR');
      if (!data || canonical(data) !== canonical(dataDir)) return null;
      if (role !== 'supervisor' && !homeMatches(environment, path.join(dataDir, 'dsh-home'))) return null;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
      throw identityUnknown(pid);
    }
  }
  if (processStarttime(pid, proc) !== starttime) return null;
  return { pid: Number(pid), starttime, role };
}

function ownedProcesses(dataDir, appDir = process.env.FNOS_APP_DIR || __dirname, proc = '/proc') {
  let entries;
  try { entries = fs.readdirSync(proc); } catch { throw identityUnknown('scan'); }
  return entries.filter((entry) => /^[1-9]\d*$/.test(entry))
    .map((entry) => processIdentity(entry, dataDir, appDir, proc)).filter(Boolean);
}

function identityMatches(identity, dataDir, appDir = process.env.FNOS_APP_DIR || __dirname, proc = '/proc') {
  if (!identity || !/^\d+$/.test(identity.starttime || '')) return false;
  const current = processIdentity(identity.pid, dataDir, appDir, proc);
  return !!current && current.starttime === identity.starttime && current.role === identity.role;
}

// Recheck both ownership and generation immediately before every TERM/KILL.
// Linux does not expose pidfd via node here; the check/syscall window remains.
function signalOwned(identity, signal, dataDir, appDir = process.env.FNOS_APP_DIR || __dirname) {
  if (!['SIGTERM', 'SIGKILL'].includes(signal) || !identityMatches(identity, dataDir, appDir)) return false;
  try { process.kill(identity.pid, signal); return true; } catch { return false; }
}

function ownedListenerIdentities(port, dataDir, appDir = process.env.FNOS_APP_DIR || __dirname, proc = '/proc') {
  const inodes = listeningInodes(port, proc);
  if (!inodes.size) return [];
  return ownedProcesses(dataDir, appDir, proc).filter((identity) => {
    const directory = path.join(proc, String(identity.pid));
    try {
      const holdsSocket = fs.readdirSync(path.join(directory, 'fd')).some((fd) => {
        try {
          const socket = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(path.join(directory, 'fd', fd)));
          return !!socket && inodes.has(socket[1]);
        } catch { return false; }
      });
      return holdsSocket && identityMatches(identity, dataDir, appDir, proc);
    } catch { return false; }
  });
}

// Keep the numeric API for existing callers; signal paths should use identities.
function ownedListeners(port, dataDir, proc = '/proc') {
  return ownedListenerIdentities(port, dataDir, process.env.FNOS_APP_DIR || __dirname, proc).map((identity) => identity.pid);
}

module.exports = { listeningInodes, ownedListeners, processStarttime, processIdentity,
  ownedProcesses, identityMatches, signalOwned, ownedListenerIdentities, instancePreload };
