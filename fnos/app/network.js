const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');

function fnosHost(value) {
  const host = String(value || '').trim();
  if (!host || host.length > 253) return null;
  const parts = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(host);
  if (!parts || (parts[2] && (Number(parts[2]) < 1 || Number(parts[2]) > 65535))) return null;
  let parsed;
  try { parsed = new URL(`http://${host}`); } catch { return null; }
  if (!parsed.hostname) return null;
  const name = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(name)) return net.isIP(name) === 4 && name !== parts[1] ? null : host.toLowerCase();
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(name)) return null;
  if (name !== parts[1].toLowerCase()) return null;
  return host.toLowerCase();
}

function hostIp(host) {
  if (!host) return null;
  try {
    const name = new URL(`http://${host}`).hostname;
    return net.isIP(name) === 4 ? name : null;
  } catch { return null; }
}

function privateIpv4(ip) {
  const octets = ip.split('.').map(Number);
  return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
}

function defaultInterface() {
  try {
    const routes = fs.readFileSync('/proc/net/route', 'utf8').trim().split(/\r?\n/).slice(1);
    return routes.map((line) => line.trim().split(/\s+/)).find((route) => route[1] === '00000000' && (Number.parseInt(route[3], 16) & 2))?.[0] || null;
  } catch { return null; }
}

function nasIpv4(host, interfaces = os.networkInterfaces(), preferredInterface = defaultInterface(), configuredIp = null) {
  const fromHost = hostIp(host);
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) => (addresses || [])
    .filter((address) => address.family === 'IPv4' && !address.internal && net.isIP(address.address) === 4)
    .map((address) => ({ name, ip: address.address })));
  if (fromHost && candidates.some((item) => item.ip === fromHost)) return fromHost;
  if (configuredIp && net.isIP(configuredIp) === 4) return configuredIp;
  candidates.sort((left, right) => {
    const score = (item) => Number(privateIpv4(item.ip)) * 4
      + Number(item.name === preferredInterface) * 8
      - Number(/^(docker|veth|br-|virbr|tun|tap|wg)/i.test(item.name)) * 16;
    return score(right) - score(left);
  });
  return candidates[0]?.ip || (fromHost?.startsWith('127.') ? fromHost : null);
}

module.exports = { fnosHost, hostIp, nasIpv4 };
