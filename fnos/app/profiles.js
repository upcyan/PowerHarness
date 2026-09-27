const fs = require('node:fs');
const path = require('node:path');
const ops = require('./ops.js');

const profilePattern = /^[a-z][a-z0-9_-]{0,31}$/;
function validateName(name) {
  if (!profilePattern.test(name) || name === 'desktop') throw new Error('Invalid dsh profile name');
  return name;
}
function directory(dataDir, name) { return ops.dataPath(dataDir, 'dsh-home', 'profiles', validateName(name)); }
function list(dataDir) {
  const root = ops.dataPath(dataDir, 'dsh-home', 'profiles');
  const names = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && profilePattern.test(entry.name) && entry.name !== 'desktop' && fs.existsSync(path.join(root, entry.name, 'package.json')))
    .map((entry) => entry.name) : [];
  return [...new Set(['web', ...names])].sort();
}
function selected(dataDir) {
  return validateName(ops.readJson(ops.dataPath(dataDir, 'profile-selection.json'), { name: 'web' }).name);
}
function select(dataDir, name) {
  validateName(name);
  if (!list(dataDir).includes(name)) throw new Error('dsh profile does not exist');
  ops.writeJson(ops.dataPath(dataDir, 'profile-selection.json'), { name });
  return name;
}
function create(dataDir, name) {
  validateName(name);
  if (name === 'web' || list(dataDir).includes(name)) throw new Error('dsh profile already exists');
  // The official CLI creates the profile from its shipped web template on first start.
  return name;
}
module.exports = { validateName, directory, list, selected, select, create };
