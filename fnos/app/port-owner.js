const fs = require('node:fs');
const path = require('node:path');

function listeningInodes(port, proc = '/proc') {
  const target = Number(port);
  if (!Number.isInteger(target) || target < 1 || target > 65535) return new Set();
  const result = new Set();
  for (const name of ['tcp', 'tcp6']) {
    let table;
    try { table = fs.readFileSync(path.join(proc, 'net', name), 'utf8'); }
    catch { continue; }
    for (const line of table.split(/\r?\n/).slice(1)) {
      const columns = line.trim().split(/\s+/);
      const local = columns[1]?.split(':');
      if (columns[3] !== '0A' || Number.parseInt(local?.[1], 16) !== target) continue;
      if (/^\d+$/.test(columns[9] || '') && columns[9] !== '0') result.add(columns[9]);
    }
  }
  return result;
}

function ownedListeners(port, dataDir, proc = '/proc') {
  const inodes = listeningInodes(port, proc);
  if (!inodes.size) return [];
  const expectedHome = `DSH_HOME=${path.join(dataDir, 'dsh-home')}`;
  const expectedData = `FNOS_DATA_DIR=${dataDir}`;
  const result = [];
  let entries;
  try { entries = fs.readdirSync(proc); } catch { return []; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const directory = path.join(proc, entry);
    try {
      if (process.getuid && fs.statSync(directory).uid !== process.getuid()) continue;
      const environment = fs.readFileSync(path.join(directory, 'environ'), 'utf8').split('\0');
      if (!environment.includes(expectedHome) || !environment.includes(expectedData)) continue;
      for (const fd of fs.readdirSync(path.join(directory, 'fd'))) {
        try {
          const socket = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(path.join(directory, 'fd', fd)));
          if (socket && inodes.has(socket[1])) { result.push(Number(entry)); break; }
        } catch { /* A closing fd does not invalidate the other descriptors. */ }
      }
    } catch { /* An exiting process or an inaccessible fd is not safe to claim. */ }
  }
  return result;
}

module.exports = { listeningInodes, ownedListeners };
