'use strict';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Same message contract for the direct HTTPS and fnOS same-origin entry points.
function render(state, { nonce, settingsUrl }) {
  const mode = state?.mode;
  const title = mode === 'maintenance' ? '自动维护模式，请等待' : mode === 'starting' ? 'DSH 正在启动' : 'DSH 暂不可用';
  const explanation = mode === 'maintenance'
    ? '维护耗时受数据量和磁盘速度影响，暂无法准确预计完成时间。DSH 服务暂时不可用；维护完成后会自动尝试恢复，请等待，不要重复操作。'
    : mode === 'starting' ? '应用正在准备 DSH 服务，请稍候。' : 'DSH 尚未就绪。请查看下方原因，或进入应用设置检查运行状态。';
  const operation = typeof state?.operation?.text === 'string' ? state.operation.text.slice(0, 500) : '';
  const reason = state?.error ? String(state.error).slice(0, 500) : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#1c2333;font:16px system-ui,sans-serif}.card{max-width:520px;margin:20px;padding:28px;background:white;border:1px solid #e1e7f0;border-radius:14px}h1{font-size:22px}p{line-height:1.6;overflow-wrap:anywhere}.operation{padding:12px;background:#fffaeb;border:1px solid #fedf89;border-radius:8px}.reason{padding:12px;background:#fdf2f2;border:1px solid #fecaca;border-radius:8px;font-size:13px}button,a{display:inline-block;margin:6px 8px 0 0;padding:10px 14px;border:0;border-radius:8px;background:#175cd3;color:white;font:inherit;text-decoration:none;cursor:pointer}</style></head><body><main class="card" role="status"><h1>${escape(title)}</h1><p>${escape(explanation)}</p>${operation ? `<p class="operation"><strong>当前操作：</strong>${escape(operation)}</p>` : ''}${reason ? `<p class="reason">${escape(reason)}</p>` : ''}<p>页面将在 5 秒后自动刷新以检查进度；这不是维护结束倒计时。</p><button id="refresh" type="button">立即刷新</button><a href="${escape(settingsUrl)}">应用设置</a></main><script nonce="${escape(nonce)}">document.getElementById('refresh').onclick=()=>location.reload();setTimeout(()=>location.reload(),5000)</script></body></html>`;
}
module.exports = { render };
