'use strict';
const fs = require('node:fs');

// Only the PID returned by our detached spawn can become an owned PGID.
function stat(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const end = text.lastIndexOf(')');
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || !text.startsWith(`${pid} (`) || fields.length < 20 ||
      !/^[A-Za-z]$/.test(fields[0]) || !/^\d+$/.test(fields[2]) ||
      !/^\d+$/.test(fields[3]) || !/^\d+$/.test(fields[19])) throw new Error('Invalid proc stat');
  return { state: fields[0], pgrp: Number(fields[2]), session: Number(fields[3]), starttime: fields[19] };
}
function create(child) {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) return null; // -1 means broadcast, never an owned-group signal // failed spawn has no group
  let birth, disappearedBeforeCapture = false;
  try {
    birth = stat(pid);
    if (birth.pgrp !== pid || birth.session !== pid) birth = null;
  } catch (error) { birth = null; disappearedBeforeCapture = error.code === 'ENOENT'; }
  const unknown = reason => ({ state: 'unknown', reason });
  function probe() {
    // A short-lived owned spawn can exit before its stat is sampled. A harmless
    // ESRCH still proves no such group exists; an existing group without birth
    // remains UNKNOWN and can never receive TERM/KILL.
    if (!birth && !disappearedBeforeCapture) return unknown('group owner birth unavailable or mismatched');
    try { process.kill(-pid, 0); }
    catch (error) { return error.code === 'ESRCH' ? { state: 'gone' } : unknown(`group probe: ${error.code || error.message}`); }
    if (!birth) return unknown('group owner birth unavailable');
    // A successful probe includes zombies. An incomplete snapshot is NEVER empty.
    try {
      // mountinfo can include shadowed older mounts at /proc. Identify the
      // actually opened directory by kernel mnt_id, not by pathname uniqueness.
      let procFd, mountId;
      try {
        procFd = fs.openSync('/proc', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        const info = fs.readFileSync(`/proc/self/fdinfo/${procFd}`, 'utf8');
        mountId = /^mnt_id:\s*(\d+)$/m.exec(info)?.[1];
      } finally { if (procFd !== undefined) fs.closeSync(procFd); }
      const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')
        .map(line => line.split(' ')).filter(fields => fields[0] === mountId && fields[4] === '/proc');
      if (!mountId || mounts.length !== 1) return unknown('proc mount visibility unconfirmed');
      const mount = mounts[0], separator = mount.indexOf('-');
      if (separator < 6 || mount.length !== separator + 4 || !mount[5] || !mount[separator + 3] ||
          mount[separator + 1] !== 'proc' || mount[3] !== '/') return unknown('proc mount visibility unconfirmed');
      const options = `${mount[5]},${mount[separator + 3]}`.split(',');
      if (options.some(option => option.startsWith('hidepid=') && option !== 'hidepid=0')) return unknown('proc hides process entries');
      const entries = fs.readdirSync('/proc');
      let live = false, members = 0;
      for (const entry of entries) {
        if (!/^[1-9]\d*$/.test(entry)) continue;
        const member = stat(Number(entry));
        if (member.pgrp === pid) {
          members++;
          if (member.state !== 'Z' && member.state !== 'X') live = true;
        }
      }
      if (!members) return unknown('group probe succeeded but snapshot found no members');
      return { state: live ? 'alive' : 'quiescent' }; // zombie-only, NOT proof that the group does not exist
    } catch (error) { return unknown(`incomplete proc snapshot: ${error.code || error.message}`); }
  }
  function signal(name) {
    if (name !== 'SIGTERM' && name !== 'SIGKILL') return unknown('invalid group signal');
    if (!birth) return unknown('group owner birth unavailable');
    let owner;
    try { owner = stat(pid); } catch { return unknown('group leader gone or unreadable'); }
    if (owner.starttime !== birth.starttime || owner.pgrp !== pid || owner.session !== pid ||
        owner.state === 'Z' || owner.state === 'X') return unknown('group owner no longer matches birth');
    // /proc identity validation and kill are not atomic. No late signal after
    // observed leader death; this does not claim to solve the kernel PID reuse race.
    try { process.kill(-pid, name); return { state: 'sent' }; }
    catch (error) { return error.code === 'ESRCH' ? { state: 'gone' } : unknown(`group signal: ${error.code || error.message}`); }
  }
  return { pid, probe, signal };
}
module.exports = { create };
