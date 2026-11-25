'use strict';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const path = require('node:path');
const installOptions = require('./install-options.js');
// 备份目录默认跟随工作目录父级：<工作目录父级>/DSH-Recovery/<实例名>。
// 实例名取自 install-options 默认备份目录的叶子（主应用 dsh-fnos，二号 dsh-fnos2），
// 派生逻辑一份代码两个实例通用，不需要按包名硬编码分支。
const backupLeaf = path.basename(installOptions.defaults?.backupDir || '') || 'dsh-fnos';
function derivedBackup(dataDir, leaf) {
  const value = String(dataDir || '').trim();
  if (!value.startsWith('/')) return '';
  // 备份目录跟工作目录的卷级父级走（/vol1/1000），与 install-options 默认值同构：
  // 数据 /vol1/1000/DSH-Data/dsh-fnos -> 备份 /vol1/1000/DSH-Recovery/dsh-fnos。
  const parts = value.replace(/\/+$/, '').split('/').filter(Boolean).slice(0, -2);
  const parent = parts.length ? '/' + parts.join('/') : '/';
  return (parent === '/' ? '' : parent) + '/DSH-Recovery/' + leaf;
}

/**
 * 首次启动的目录配置页（工作目录运行时配置，2026-11-10）。
 *
 * 为什么要有它：目录不再在安装向导里填。安装阶段既拿不到目录授权、也验不了
 * 可写性，填了只是一串未经验证的字，等到首启才暴露问题。现在安装不写目录，
 * supervisor 首次启动进 setup 模式：只起网关、不起核心，用户打开应用（桌面
 * 图标、或直接访问端口）看到的就是这一页。选目录 -> 保存 -> supervisor 当场
 * 跑授权与读写探针：过则写 install-options.json 并重启进程以新目录启动，
 * 不过则留在本页、把每个不合格的目录和原因逐条列出来。
 *
 * 「未完成配置和授权，不继续启动」这条要求就落在这里：setup 模式下 core
 * 从不 spawn，页面是唯一出口。
 */
function render(state, { nonce, csrf, notice, defaults, actionUrl = '/__fnos/action', stateUrl = '/__fnos/state' }) {
  const reason = typeof state?.error === 'string' ? state.error.slice(0, 800) : '';
  const dataDefault = escape(defaults?.dataDir || '');
  const backupDefault = escape(defaults?.backupDir || '');
  // 已保存的自定义备份路径保持手动模式，不在打开页面时悄悄改写。
  const followDefault = !defaults?.backupDir
    || defaults.backupDir === installOptions.defaults.backupDir
    || defaults.backupDir === derivedBackup(defaults.dataDir, backupLeaf);
  // 备份目录与工作目录是否落在同一物理介质上。null = 路径还不存在或无法读取，
  // 此时不提示 —— 对着一个尚未创建的目录谈论磁盘布局只会误导。
  // 只提示不阻断：另备一块盘属于环境条件，不是用户填错了。
  const sameDisk = defaults?.dataDir && defaults?.backupDir
    ? installOptions.sameDevice(defaults.dataDir, defaults.backupDir)
    : null;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>配置工作目录</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#1c2333;font:16px system-ui,sans-serif}
.card{max-width:640px;margin:20px;padding:28px;background:white;border:1px solid #e1e7f0;border-radius:14px}
h1{font-size:22px;margin:0 0 8px}p{line-height:1.65;overflow-wrap:anywhere;margin:10px 0}
.sub{color:#475467;font-size:14px}
label{display:block;margin:16px 0 6px;font-weight:600;font-size:14px}
input[type=text]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;background:#fff}
input[type=text][readonly]{background:#f2f4f7;color:#667085;cursor:default}
.hint{color:#667085;font-size:13px;margin-top:6px}
button{margin-top:20px;padding:11px 18px;border:0;border-radius:8px;background:#175cd3;color:#fff;font:inherit;cursor:pointer}
button[disabled]{background:#98a2b3;cursor:default}
.issue{padding:12px;background:#fdf2f2;border:1px solid #fecaca;border-radius:8px;font-size:13px;margin-top:12px}
.issue b{display:block;margin-bottom:6px}
.notice{padding:12px;background:#ecfdf3;border:1px solid #abefc6;border-radius:8px;font-size:14px;margin-top:12px}
.steps{margin:14px 0 0;padding-left:20px;line-height:1.7;font-size:14px;color:#475467}
code{background:#f2f4f7;padding:1px 5px;border-radius:4px;font-size:13px}
</style></head><body><main class="card">
<h1>首次启动：配置工作目录</h1>
<p class="sub">这个应用还没有确定工作目录与备份目录。目录一旦选定，会话、设置、插件数据都会保存在那里；备份目录用于存放快照，两者必须互相独立。</p>
${notice ? `<p class="notice">${escape(notice)}</p>` : ''}
${reason ? `<div class="issue"><b>还不能启动</b>${escape(reason)}</div>` : ''}
<form method="post" action="${escape(actionUrl)}">
<input type="hidden" name="csrf" value="${escape(csrf)}">
<input type="hidden" name="action" value="save-setup">
<label for="dataDir">工作目录</label>
<input id="dataDir" type="text" name="dataDir" value="${dataDefault}" placeholder="/vol1/1000/DSH-Data/dsh-fnos" autocomplete="off" spellcheck="false">
<div class="hint">会话、设置、插件数据都放这里。必须是 NAS 上的绝对路径，不能是 /tmp、/opt、应用安装目录或临时目录。</div>
<label for="backupDir">备份目录</label>
<input id="backupDir" type="text" name="backupDir" value="${backupDefault}" placeholder="/vol1/1000/DSH-Recovery/dsh-fnos" autocomplete="off" spellcheck="false">
<div class="hint">快照与迁移回滚包存放处；必须与工作目录互相独立，不能相同或互相包含。</div>
${sameDisk === true ? `<div class="notice" style="margin:8px 0 0">提示：备份目录与工作目录在同一块物理磁盘上。这样能防误删与回滚互害，但整盘故障会同时带走两者；升级前冷备也会退化为全量复制（实测 60GB 级约半小时），无法用硬链接加速。若条件允许，建议选到另一块物理盘；不改也能正常使用。</div>` : ''}
<label style="display:flex;flex-wrap:wrap;align-items:center;column-gap:8px;row-gap:4px;font-weight:400;font-size:14px;line-height:1.5;margin:10px 0 0"><input id="backupFollow" type="checkbox"${followDefault ? ' checked' : ''}><span style="min-width:0;overflow-wrap:anywhere">备份目录随工作目录父级（<code style="overflow-wrap:anywhere">${escape(backupLeaf)}</code>）</span></label>
<button type="submit">保存并验证授权</button></form>
</main>
<script nonce="${escape(nonce)}">
(function(){
  var data = document.getElementById('dataDir'), backup = document.getElementById('backupDir'), follow = document.getElementById('backupFollow');
  if (!data || !backup || !follow) return;
  var manual = backup.value;
  var derive = ${derivedBackup.toString()};
  function sync() {
    backup.readOnly = follow.checked;
    if (follow.checked) backup.value = derive(data.value, ${JSON.stringify(backupLeaf)});
  }
  data.addEventListener('input', sync);
  backup.addEventListener('input', function(){ if (!follow.checked) manual = backup.value; });
  follow.addEventListener('change', function(){
    if (follow.checked) manual = backup.value;
    else backup.value = manual;
    sync();
  });
  sync();
})();
</script>
<main class="card" style="margin-top:0">
<p><strong>目录已经存在时不需要另外授权</strong>：本应用会真的在里面写一个临时文件读回来，写得进去就算过。</p>
<p>只有在<strong>要新建目录</strong>时才需要先授权。fnOS 的目录授权在应用中心里，页面无法代改：</p>
<ol class="steps">
<li>打开 fnOS 应用中心 → 本应用 → 访问权限。</li>
<li>勾选工作目录与备份目录的<strong>父目录</strong>（例如要选 <code>/vol1/1000/DSH-Data/dsh-fnos</code>，就授权 <code>/vol1/1000/DSH-Data</code>）。</li>
<li>回到本页点「保存并验证授权」。本页每 4 秒自动重检，检查通过会自己重启，不用再点。</li>
</ol>
<p class="sub">本应用不会自动修改 ACL，也不会偷偷换用别的目录。检查没通过时核心不会启动，页面会列出缺哪一项。如果授权已经勾上、这里却一直不过，去应用中心把本应用「停用」再「启用」一次——授权列表是进程启动时的快照，换掉进程才拿得到新的。</p>
</main>
<script nonce="${escape(nonce)}">
setInterval(async () => {
  try {
    const r = await fetch(${JSON.stringify(stateUrl)}, { cache: 'no-store' });
    if (!r.ok && r.status !== 503) return;
    const info = await r.json();
    if (info.mode && info.mode !== 'setup') location.reload();
  } catch {}
}, 4000);
</script></body></html>`;
}
module.exports = { render };
