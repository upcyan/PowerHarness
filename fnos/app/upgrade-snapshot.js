const ops = require('./ops.js');

const appDir = process.env.FNOS_APP_DIR;
const dataDir = process.env.FNOS_DATA_DIR;
const configDir = process.env.FNOS_CONFIG_DIR;
if (!appDir || !dataDir) throw new Error('Missing fnOS application paths');
const version = ops.dshVersion(appDir);
const snapshot = ops.createSnapshot(dataDir, configDir, 'pre-upgrade', version);
console.log(`Pre-upgrade backup: ${snapshot.id}`);
