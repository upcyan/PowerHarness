const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const ops = require('./ops.js');

function selected(dataDir) {
  const saved = ops.readJson(ops.dataPath(dataDir, 'docker-access.json'), {});
  return saved.mode === 'rootless' ? 'rootless' : 'system';
}

function save(dataDir, mode) {
  if (!['system', 'rootless'].includes(mode)) throw new Error('无效的 Docker 连接模式');
  ops.writeJson(ops.dataPath(dataDir, 'docker-access.json'), { mode });
}

function rootlessSocket(uid = process.getuid?.()) {
  return Number.isInteger(uid) && uid >= 0 ? `/run/user/${uid}/docker.sock` : null;
}

function commandAvailable(name) {
  return String(process.env.PATH || '').split(path.delimiter).some((directory) => {
    try { fs.accessSync(path.join(directory, name), fs.constants.X_OK); return true; } catch { return false; }
  });
}

function subordinateIds(file, user, uid) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').some((line) => {
      const [name, start, count] = line.split(':');
      return (name === user || name === String(uid)) && Number.isSafeInteger(Number(start)) && Number(start) >= 0 && Number(count) >= 65536;
    });
  } catch { return false; }
}

function dockerGroupMember() {
  try {
    const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find((item) => item.startsWith('docker:'));
    const gid = Number(line?.split(':')[2]);
    return Number.isInteger(gid) && process.getgroups?.().includes(gid);
  } catch { return false; }
}

function checks() {
  const uid = process.getuid?.();
  let user;
  try { user = os.userInfo(); }
  catch { user = { username: process.env.USER || process.env.USERNAME || 'unknown', homedir: os.homedir() }; }
  let homeReady = false;
  try { homeReady = fs.statSync(user.homedir).isDirectory() && fs.accessSync(user.homedir, fs.constants.W_OK) === undefined; } catch {}
  return {
    username: user.username,
    uid,
    home: user.homedir,
    homeReady,
    uidmap: commandAvailable('newuidmap') && commandAvailable('newgidmap'),
    setupTool: commandAvailable('dockerd-rootless-setuptool.sh'),
    subuid: subordinateIds('/etc/subuid', user.username, uid),
    subgid: subordinateIds('/etc/subgid', user.username, uid),
    dockerGroup: dockerGroupMember(),
    socket: rootlessSocket(uid)
  };
}

function isRootlessInfo(info) {
  return Array.isArray(info?.SecurityOptions) && info.SecurityOptions.some((item) => typeof item === 'string' && /^(?:name=)?rootless$/.test(item));
}

async function probe(socket = rootlessSocket(), uid = process.getuid?.()) {
  if (process.platform !== 'linux' || !socket) return { ready: false, reason: '只支持 Linux 上的应用专用用户' };
  try {
    const directory = fs.lstatSync(path.dirname(socket));
    const stat = fs.lstatSync(socket);
    if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o022) || !stat.isSocket() || stat.uid !== uid) {
      return { ready: false, reason: 'Socket 或运行目录不属于应用用户' };
    }
  } catch { return { ready: false, reason: 'Rootless Docker Socket 尚未创建' }; }
  return new Promise((resolve) => {
    const request = http.get({ socketPath: socket, path: '/info', timeout: 2500 }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 256 * 1024) request.destroy(new Error('Docker response too large'));
      });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200 || !isRootlessInfo(JSON.parse(body))) return resolve({ ready: false, reason: '守护进程未报告 Rootless 模式' });
          resolve({ ready: true, reason: '' });
        } catch { resolve({ ready: false, reason: '无法验证 Docker 守护进程身份' }); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => resolve({ ready: false, reason: '无法连接 Rootless Docker 守护进程' }));
  });
}

async function inspect(dataDir) {
  return { ...checks(), mode: selected(dataDir), connection: await probe() };
}

function dshEnvironment(dataDir) {
  const socket = rootlessSocket();
  if (selected(dataDir) !== 'rootless') return {};
  if (!socket) throw new Error('Rootless Docker requires Linux');
  return { DOCKER_HOST: `unix://${socket}` };
}

module.exports = { selected, save, rootlessSocket, checks, probe, inspect, isRootlessInfo, dshEnvironment };
