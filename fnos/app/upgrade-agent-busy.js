'use strict';
// 升级前置：检测 agent 对话/任务是否进行中（0.3.99 用户反馈）。
// 信号：.writing/.lock 在最近 120 秒内有写入（真实任务互斥痕迹）。
// 注意：不能把 session.v4.jsonl 当信号——会话容器即使空闲也持续轮转事件日志，
// 会把"本会话还开着"误判成"对话进行中"（0.3.100 实机误报根因）。
// 必须在 main stop 之前运行——停止后这些痕迹会消失或僵死。
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FNOS_DATA_DIR;
if (!root) { console.log('idle'); process.exit(0); }
const cut = Date.now() - 120000;
let busy = false;
const scan = (p, depth) => {
  if (busy || depth > 4) return;
  let entries; try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (busy) return;
    const child = path.join(p, entry.name);
    let s; try { s = fs.lstatSync(child); } catch { continue; }
    if (entry.isSymbolicLink()) continue;
    if (s.isDirectory()) scan(child, depth + 1);
    else if ((entry.name.endsWith('.writing') || entry.name.endsWith('.lock')) && s.mtimeMs > cut) busy = true;
  }
};
scan(path.join(root, 'dsh-home', 'sessions'), 0);
scan(path.join(root, 'dsh-home', 'profiles', 'web', 'super-code-connection'), 0);
console.log(busy ? 'busy' : 'idle');
