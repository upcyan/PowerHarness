const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

// 显式设置的 FNOS_WORKSPACE_HOME 优先（0.3.66 修正）。
//
// 原实现是「current 存在就用 current，否则才用 fallback」，其隐含前提是
// os.homedir() 指向一个**不存在**的目录。但 supervisor 为修 corepack 的
// EACCES 设了 HOME=<dataDir>/home —— 该目录一旦存在，fallback 就永不生效，
// 于是 DSH 目录选择器的「主目录」指向那个空目录，用户**看不到 fnOS 授权目录**
// 快捷方式（10-02 实测）。语义上 FNOS_WORKSPACE_HOME 是明确指定，应当胜出。
function chooseHome(current, fallback) {
  if (path.isAbsolute(fallback || '') && fs.statSync(fallback, { throwIfNoEntry: false })?.isDirectory()) return fallback;
  try { if (fs.statSync(current).isDirectory()) return current; } catch {}
  return current;
}

if (process.env.FNOS_WORKSPACE_HOME) {
  const original = os.homedir;
  os.homedir = () => chooseHome(original(), process.env.FNOS_WORKSPACE_HOME);
  syncBuiltinESMExports();
}

module.exports = { chooseHome };
