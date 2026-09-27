const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ops = require('./ops.js');
const cores = require('./core-manager.js');
const profiles = require('./profiles.js');

const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)?$/;
function parseSpec(value) {
  const spec = String(value || '').trim();
  if (!packagePattern.test(spec) || spec.length > 160) throw new Error('Only exact npm package names and versions are supported');
  const at = spec.lastIndexOf('@');
  return at > 0 ? { name: spec.slice(0, at), requestedVersion: spec.slice(at + 1) } : { name: spec, requestedVersion: null };
}
function bundlePatch(manifest) {
  const patch = manifest?.dsh?.bundle?.patch;
  if (typeof patch !== 'string' || !/^\.\/[a-zA-Z0-9._/-]+\.ya?ml$/.test(patch) || patch.split('/').includes('..')) throw new Error('Package does not declare a safe dsh bundle patch');
  return patch;
}
function profilePackage(dataDir, profile, spec) {
  const { name, requestedVersion } = parseSpec(spec);
  if (requestedVersion) throw new Error('Select an installed plugin by package name');
  const directory = profiles.directory(dataDir, profile);
  const manifestFile = path.join(directory, 'package.json');
  const manifest = ops.readJson(manifestFile);
  if (!manifest || !Object.hasOwn(manifest.dependencies || {}, name)) throw new Error('Plugin is not installed in this profile');
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw new Error('dsh profile manifest is incompatible');
  return { name, directory, manifestFile, manifest };
}
function list(dataDir, profile) {
  const directory = profiles.directory(dataDir, profile);
  const manifest = ops.readJson(path.join(directory, 'package.json'), {});
  const dependencies = manifest.dependencies || {};
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  return Object.entries(dependencies).filter(([name]) => {
    try { return parseSpec(name).name === name; } catch { return false; }
  }).map(([name, requested]) => {
    let installed;
    try { installed = ops.readJson(path.join(directory, 'node_modules', ...name.split('/'), 'package.json')); } catch {}
    let compatible = false;
    try { bundlePatch(installed); compatible = true; } catch {}
    return { name, version: installed?.version || requested, enabled: bundles.includes(name), compatible };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
function setEnabled(dataDir, profile, spec, enabled) {
  const { name, directory, manifestFile, manifest } = profilePackage(dataDir, profile, spec);
  if (enabled) {
    const installed = ops.readJson(path.join(directory, 'node_modules', ...name.split('/'), 'package.json'));
    if (installed?.name !== name) throw new Error('Installed plugin files are missing');
    bundlePatch(installed);
  }
  const bundles = manifest.dsh.profile.bundles;
  manifest.dsh.profile.bundles = bundles.filter((item) => item !== name);
  if (enabled) manifest.dsh.profile.bundles.push(name);
  ops.writeJson(manifestFile, manifest);
  return { name, enabled };
}
async function metadata(name, registry) {
  const url = new URL(encodeURIComponent(name), cores.registryUrl(registry));
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Package lookup failed (${response.status})`);
  return response.json();
}
async function inspect(spec, registry) {
  const { name, requestedVersion } = parseSpec(spec);
  const record = await metadata(name, registry);
  const version = requestedVersion || record['dist-tags']?.latest;
  const manifest = record.versions?.[version];
  if (!manifest || manifest.name !== name || manifest.version !== version) throw new Error('Package version is unavailable');
  const integrity = manifest.dist?.integrity || '';
  if (!/^sha512-[A-Za-z0-9+/=]+$/.test(integrity) || Buffer.from(integrity.slice(7), 'base64').length !== 64) throw new Error('Package has no SHA-512 integrity digest');
  bundlePatch(manifest);
  return { name, version, integrity: manifest.dist.integrity };
}
function npmBin() { return process.env.FNOS_NPM_BIN || path.join(path.dirname(process.execPath), 'npm'); }
function runNpm(args, cwd, registry, logFile, allowAuditFailure = false) {
  return new Promise((resolve, reject) => {
    const output = fs.openSync(logFile, 'a', 0o600);
    const child = spawn(npmBin(), args, {
      cwd, env: { ...process.env, npm_config_registry: registry, npm_config_cache: path.join(path.dirname(logFile), 'npm-cache') },
      stdio: ['ignore', 'pipe', output]
    });
    fs.closeSync(output);
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; if (text.length > 2_000_000) child.kill('SIGTERM'); });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0 || allowAuditFailure) resolve({ code, text });
      else reject(new Error(`npm failed (${code}); see plugin-install.log`));
    });
  });
}
async function install(dataDir, profile, spec, registry, inspected = null) {
  const source = cores.registryUrl(registry);
  const packageInfo = inspected || await inspect(spec, source);
  const parsed = parseSpec(spec);
  if (parsed.name !== packageInfo.name || (parsed.requestedVersion && parsed.requestedVersion !== packageInfo.version)) throw new Error('Plugin inspection does not match request');
  const profileDir = profiles.directory(dataDir, profile);
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) throw new Error('dsh profile is not initialized');
  const logFile = ops.dataPath(dataDir, 'plugin-install.log');
  await runNpm(['install', '--save-exact', '--omit=dev', '--ignore-scripts', '--engine-strict', '--strict-peer-deps', '--no-fund', '--no-audit', '--registry', source, `${packageInfo.name}@${packageInfo.version}`], profileDir, source, logFile);
  const packageDir = path.join(profileDir, 'node_modules', ...packageInfo.name.split('/'));
  const installed = ops.readJson(path.join(packageDir, 'package.json'));
  if (installed?.name !== packageInfo.name || installed?.version !== packageInfo.version) throw new Error('Installed package failed dsh bundle verification');
  const patch = bundlePatch(installed);
  const patchFile = fs.realpathSync(path.join(packageDir, patch));
  const resolvedDir = fs.realpathSync(packageDir);
  const modulesDir = fs.realpathSync(path.join(profileDir, 'node_modules'));
  if (!resolvedDir.startsWith(modulesDir + path.sep) || !patchFile.startsWith(resolvedDir + path.sep) || !fs.statSync(patchFile).isFile()) throw new Error('Plugin patch escapes its package');
  const lock = ops.readJson(path.join(profileDir, 'package-lock.json'));
  if (lock?.packages?.[`node_modules/${packageInfo.name}`]?.integrity !== packageInfo.integrity) throw new Error('Installed package integrity differs from inspected metadata');
  const audit = await runNpm(['audit', '--omit=dev', '--audit-level=high', '--json', '--registry', 'https://registry.npmjs.org/'], profileDir, 'https://registry.npmjs.org/', logFile, true);
  let report;
  try { report = JSON.parse(audit.text); } catch { throw new Error('Security advisory check was unavailable'); }
  if (!report.metadata?.vulnerabilities || report.error) throw new Error('Security advisory check was unavailable');
  const issues = report.metadata.vulnerabilities;
  if (issues.high || issues.critical) throw new Error(`Security advisory check found ${issues.high || 0} high and ${issues.critical || 0} critical vulnerabilities`);
  const manifestFile = path.join(profileDir, 'package.json');
  const profileManifest = ops.readJson(manifestFile);
  const bundles = profileManifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) throw new Error('dsh profile manifest is incompatible');
  if (!bundles.includes(packageInfo.name)) bundles.push(packageInfo.name);
  ops.writeJson(manifestFile, profileManifest);
  return { name: packageInfo.name, version: packageInfo.version, audit: issues };
}
async function uninstall(dataDir, profile, spec, registry) {
  const { name, directory } = profilePackage(dataDir, profile, spec);
  setEnabled(dataDir, profile, name, false);
  const source = cores.registryUrl(registry);
  const logFile = ops.dataPath(dataDir, 'plugin-install.log');
  await runNpm(['uninstall', '--ignore-scripts', '--no-fund', '--no-audit', '--registry', source, name], directory, source, logFile);
  const updated = ops.readJson(path.join(directory, 'package.json'));
  if (Object.hasOwn(updated?.dependencies || {}, name)) throw new Error('npm did not remove the plugin dependency');
  return { name, removed: true };
}
module.exports = { parseSpec, inspect, install, list, setEnabled, uninstall };
