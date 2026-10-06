'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
function validReceipt(r) {
  return r && r.schemaVersion === 1 && validId(r.id) && validId(r.fromBootId) &&
    (r.toBootId === null || validId(r.toBootId)) &&
    ['accepted', 'completed', 'failed'].includes(r.status) && Number.isFinite(r.acceptedAt);
}
function createRestartTracker(dataDir, { bootId = randomBytes(16).toString('hex') } = {}) {
  if (!validId(bootId)) throw new Error('Invalid boot generation');
  const file = path.join(path.resolve(dataDir), 'restart-receipt.json');
  let receipt = null, readable = true;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 8192) throw new Error('Invalid restart receipt file');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validReceipt(parsed)) throw new Error('Invalid restart receipt');
    receipt = parsed;
  } catch (error) { if (error.code !== 'ENOENT') readable = false; }
  const save = next => {
    if (!readable) throw new Error('Restart receipt unavailable; preserve file and inspect before retry');
    const temp = `${file}.pending-${randomBytes(16).toString('hex')}`;
    let fd, owned = false;
    try {
      fd = fs.openSync(temp, 'wx', 0o600); owned = true;
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file); receipt = next;
    } catch (error) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      if (owned && path.dirname(temp) === path.dirname(file) && temp.startsWith(file + '.pending-')) {
        try { fs.unlinkSync(temp); } catch {}
      }
      throw error;
    }
  };
  return {
    bootId,
    snapshot: () => receipt ? { ...receipt } : null,
    accept(id) {
      if (!validId(id)) throw new Error('Invalid restart request ID');
      if (receipt?.id === id) return false; // Replay never triggers a second restart.
      if (receipt?.status === 'accepted') throw new Error('Previous restart remains unconfirmed');
      save({ schemaVersion: 1, id, fromBootId: bootId, toBootId: null, status: 'accepted', acceptedAt: Date.now() });
      return true;
    },
    fail() {
      if (receipt?.status === 'accepted') save({ ...receipt, status: 'failed', toBootId: bootId });
    },
    observe(mode) {
      if (receipt?.status !== 'accepted' || receipt.fromBootId === bootId) return;
      if (mode === 'ready') save({ ...receipt, status: 'completed', toBootId: bootId });
      else if (mode === 'safe' || mode === 'rollback') save({ ...receipt, status: 'failed', toBootId: bootId });
    },
  };
}
module.exports = { createRestartTracker, validId, validReceipt };
