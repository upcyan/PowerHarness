'use strict';
// 属主接管与可读性自检（2026-10-31 事故加固）。
// 事故：卸载/安装钩子以 root 运行（install-migration 的 copy()、uninstall-retention
// 的 preserve()），产出的目录 0700/文件 0600 均为 root:root，应用账号读不了；
// 核心启动时 pnpm 对不可读目录做同步 opendirSync，报错恰好不带路径
// （"EACCES: permission denied, opendir"），排查极其困难。
// 本模块两件事：
//   claim() —— root 身份把数据/备份树里的非应用属主条目归还给应用账号（钩子收尾调用）；
//   audit() —— 应用身份启动前扫 pnpm-store/npm-cache/profile 的可读性，
//              不可读就抛带路径的中文错误（替代 pnpm 的无路径串）。
const fs = require('node:fs');
const path = require('node:path');
const STORE_SCOPES = ['pnpm-store', 'npm-cache', 'pnpm-home', 'corepack-home'];
function* walk(root, depth) {
  // 浅层优先：stores 顶层损坏最常见，限深防大树拖慢启动。
  let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) { yield { root, error }; return; }
  if (depth <= 0) return;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = path.join(root, entry.name);
    yield* walk(child, depth - 1);
  }
}
function identity(env = process.env) {
  if (process.getuid() !== 0) return null;
  const name = env.TRIM_USERNAME || 'dsh_fnos';
  if (!/^[a-z_][a-z0-9_-]*$/.test(name)) throw new Error('Invalid application identity');
  const record = require('node:child_process').execFileSync('getent', ['passwd', name], { encoding: 'utf8' }).trim().split(':');
  const uid = Number(record[2]), gid = Number(record[3]);
  if (!(uid > 0 && gid > 0)) throw new Error('Application identity unavailable');
  return { uid, gid };
}
function claim(root, env = process.env) {
  // root 钩子收尾：把树内非应用属主的条目 chown 回去。非 root 直接跳过。
  const user = identity(env); if (!user) return 0;
  let repaired = 0;
  const scan = (p) => {
    let entries; try { entries = fs.readdirSync(p, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const child = path.join(p, entry.name);
      let s; try { s = fs.lstatSync(child); } catch { continue; }
      try { if (s.uid !== user.uid) { fs.chownSync(child, user.uid, user.gid); repaired++; } } catch { /* 单点失败不阻断 */ }
      if (s.isDirectory() && !s.isSymbolicLink()) scan(child);
    }
  };
  let s; try { s = fs.statSync(root); } catch { return 0; }
  try { if (s.uid !== user.uid) { fs.chownSync(root, user.uid, user.gid); repaired++; } } catch { /* 同上 */ }
  if (s.isDirectory()) scan(root);
  return repaired;
}
function audit(dataDir, env = process.env) {
  // 应用身份 boot 前置：只报不可读，不修复（修复是 root 钩子的事）。
  const problems = [];
  for (const name of STORE_SCOPES) {
    const root = path.join(dataDir, name);
    let s; try { s = fs.statSync(root); } catch { continue; }
    if (!s.isDirectory() || s.isSymbolicLink()) continue;
    for (const { root: dir, error } of walk(root, 3)) {
      if (error && (error.code === 'EACCES' || error.code === 'EPERM')) {
        problems.push(`存储目录不可读：${dir}（属主 ${(() => { try { return fs.statSync(dir).uid; } catch { return '?'; } })()}，当前 ${process.getuid()}）。请在 NAS 终端执行：sudo chown -R $(id -un):$(id -gn) ${dataDir}`);
        break; // 每棵树报一条即可
      }
    }
  }
  return problems;
}
module.exports = { claim, audit };
