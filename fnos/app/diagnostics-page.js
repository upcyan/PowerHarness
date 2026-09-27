const sources = [
  ['gateway', '应用网关'],
  ['supervisor', '应用运行'],
  ['dsh', 'DSH 核心']
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function render(basePath, source, content, nonce, settingsHref = '') {
  const title = sources.find(([id]) => id === source)?.[1];
  if (!title) throw new Error('Invalid log source');
  const tabs = sources.map(([id, label]) => `<a href="${basePath}?source=${id}"${source === id ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const back = settingsHref ? `<a class="back" href="${settingsHref}">返回应用设置</a>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeepSeek Harness 诊断日志</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f7fb;color:#1c2333;font:14px/1.55 system-ui,sans-serif}.shell{max-width:1050px;margin:0 auto;padding:20px 16px 48px}header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}h1{font-size:22px;margin:0 0 14px}.back{color:#175cd3;text-decoration:none}.tabs{display:flex;gap:7px;overflow-x:auto;white-space:nowrap;margin:8px 0 16px;border-bottom:1px solid #d9e1ec;padding-bottom:9px}.tabs a{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:8px 14px;border-radius:9px;color:#344054;text-decoration:none;font-weight:600}.tabs a[aria-current]{background:#175cd3;color:#fff}.tabs a:not([aria-current]):hover{background:#e8edf7}.card{background:#fff;border:1px solid #e5e9f1;border-radius:13px;padding:18px}h2{font-size:18px;margin:0}.tools{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}.actions{display:flex;gap:8px;flex-wrap:wrap;min-width:0}button,.actions a{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:7px 12px;border:1px solid #b8c5da;border-radius:8px;background:#fff;color:#175cd3;font:inherit;text-decoration:none;cursor:pointer}button:hover,.actions a:hover{background:#eef4ff}p{margin:12px 0;color:#667085}pre{margin:0;min-height:240px;white-space:pre-wrap;overflow-wrap:anywhere;background:#101828;color:#e8eef8;padding:16px;border-radius:9px;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}@property --edge-angle{syntax:"<angle>";inherits:false;initial-value:0deg}button.is-working{position:relative;isolation:isolate;box-shadow:0 0 0 1px #77cfff,0 0 9px #4ebdff55}button.is-working::after{content:"";position:absolute;inset:-2px;border-radius:inherit;padding:2px;background:conic-gradient(from var(--edge-angle),transparent 0deg 250deg,#50baff 295deg,#f3fcff 324deg,#75d2ff 340deg,transparent 360deg);-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:edge-sweep 1.35s linear infinite;pointer-events:none}@keyframes edge-sweep{to{--edge-angle:360deg}}@media(prefers-reduced-motion:reduce){button.is-working::after{animation:none;background:#84d6ff}}@media(max-width:620px){.shell{padding:14px 10px 32px}.card{padding:12px}.tabs a{padding:7px 10px}.tools{display:block}.actions{width:100%;margin-top:10px}.actions a,.actions button{flex:0 0 auto}pre{font-size:11px}}
  </style></head><body><div class="shell"><header><h1>诊断日志</h1>${back}</header><nav class="tabs" aria-label="日志类型">${tabs}</nav><main class="card"><div class="tools"><h2>${title}</h2><div class="actions"><button id="copy-log" type="button">复制日志</button><a href="${basePath}?source=${source}&amp;download=1">下载日志</a><a href="${basePath}?source=${source}">刷新</a></div></div><p>最新记录在上方；日志里的 Z 时间是 UTC，北京时间需加 8 小时。DSH 核心按运行批次倒序，下载文件保留原始顺序。DSH 核心日志仅遮盖常见令牌，分享前请检查。</p><pre id="log-content">${escapeHtml(content || '暂无日志')}</pre></main></div><script nonce="${nonce}">
  if (${Boolean(settingsHref)} && window.parent !== window) window.parent.postMessage({ type: 'dsh-fnos-view', view: 'settings' }, '*');
  document.getElementById('copy-log').addEventListener('click', async function () {
    const button = this;
    const value = document.getElementById('log-content').textContent;
    button.classList.add('is-working');
    button.setAttribute('aria-busy', 'true');
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const field = document.createElement('textarea');
        field.value = value;
        field.style.position = 'fixed';
        field.style.left = '-9999px';
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (!copied) throw new Error('copy unavailable');
      }
      button.textContent = '已复制';
    } catch {
      button.textContent = '复制失败，请长按日志复制';
    } finally {
      button.classList.remove('is-working');
      button.removeAttribute('aria-busy');
    }
    setTimeout(() => { button.textContent = '复制日志'; }, 3500);
  });
  </script></body></html>`;
}

module.exports = { render, sources };
