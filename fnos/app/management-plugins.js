'use strict';
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function operationFeedback(error={},isRestart=false){
 function safe(value){return String(value??'').replace(/\u001b\[[0-9;]*m/g,'').replace(/(https?:\/\/)[^/\s@]+@/gi,'$1[已隐藏]@').replace(/([?&](?:token|csrf|api[_-]?key|password|secret|state|code)=)[^&#\s]+/gi,'$1[已隐藏]').replace(/\bBearer\s+[^\s,;]+/gi,'Bearer [已隐藏]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[JWT已隐藏]').replace(/\b(?:sk-|ghp_)[A-Za-z0-9_-]+/g,'[密钥已隐藏]').replace(/((?:api[_-]?key|token|csrf|password|secret|authorization|cookie)\s*[:=]\s*["']?)[^\s"',;]+/gi,'$1[已隐藏]').slice(0,420);}
 const message=String(error.message??''),status=Number(error.httpStatus)||Number(error.status)||(message.startsWith('HTTP ')?Number(message.slice(5)):0),reason=safe(error.serverNotice||error.serverReason||'');
 if(status===401||error.authExpired&&status!==403)return{tone:'error',title:'管理会话失效，请刷新页面',detail:'请求未获授权，请刷新控制台后重新认证；未自动重发操作。',uncertain:false};
 if(status===403)return{tone:'error',title:'管理请求被拒绝（HTTP 403）',detail:(reason?reason+'。':'')+'请刷新控制台并核对管理员权限或 CSRF 校验；未自动重发操作。',uncertain:false};
 if(error.restartFailed)return{tone:'error',title:'应用重启失败',detail:reason||'请查看运行控制和日志；未自动重发重启。',uncertain:false};
 if(error.confirmedFailure)return{tone:'error',title:'操作未完成',detail:reason||safe(message)||'服务端拒绝了此操作，请核对原因。',uncertain:false};
 if(error.confirmedAccepted)return{tone:'warning',title:'服务端已处理，页面结果未确认',detail:(reason?reason+'。':'')+'请先刷新核对当前状态，不要重复提交。',uncertain:true};
 if(status>=400&&status<500&&status!==408)return{tone:'error',title:'请求被拒绝（HTTP '+status+'）',detail:(reason?reason+'。':'')+'请核对参数或配置；未自动重发操作。',uncertain:false};
 return{tone:'warning',title:isRestart?'重启结果未确认':'操作结果未确认',detail:(status?'服务器返回 HTTP '+status+'；':'连接中断或请求超时；')+(reason?reason+'。':'')+'这不等于操作失败。请先刷新核对，不要重复提交。',uncertain:true};
}
function showOperationFeedback(form,button,feedback){
 let box=form.querySelector('[data-operation-feedback]');if(!box){box=document.createElement('div');box.dataset.operationFeedback='';box.className='operation-feedback';form.appendChild(box);}box.replaceChildren();box.dataset.tone=feedback.tone;box.setAttribute('role','alert');box.setAttribute('aria-live','polite');form.classList.add('has-operation-feedback');
 const title=document.createElement('strong');title.textContent=feedback.title;const detail=document.createElement('p');detail.textContent=feedback.detail;const refresh=document.createElement('button');refresh.type='button';refresh.textContent='刷新核对状态';refresh.addEventListener('click',()=>location.reload());box.append(title,detail,refresh);
 if(feedback.uncertain){form.dataset.operationUnconfirmed='1';button.disabled=true;button.textContent='结果未确认';}else{delete form.dataset.operationUnconfirmed;button.disabled=false;if(!button.classList.contains('restart-icon'))button.textContent=button.dataset.originalText||'操作未完成';}
}
function cards(items, form) {
  const shared = [...new Set(items.map(item => item.profileUpdateReason).filter(Boolean))];
  const profileNotice = shared.length ? '<aside class="plugin-update-notice" role="note"><strong>配置档自动更新受限</strong>' + shared.map(text => '<p>' + escapeHtml(text) + '</p>').join('') + '<p>这不是每个插件都损坏，也不表示缺少全局依赖。启停等操作独立预检；不要为此删除正常的本地插件。</p></aside>' : '';
  return profileNotice + items.map(item => {
    const name = escapeHtml(item.name);
    const field = '<input type="hidden" name="packageName" value="' + name + '">';
    const problem = item.filesOk === false || !!item.enablementError;
    const enabled = !!item.enabled;
    const canDisable = enabled && !item.enablementError && item.canDisable !== false;
    const tone = problem ? 'problem' : enabled ? 'enabled' : 'disabled';
    const status = problem ? (enabled ? '已启用 · 需要检查' : '已禁用 · 需要检查') : enabled ? '已启用' : '已禁用';
    const select = '<label class="plugin-selection"><input type="checkbox" name="packageNames" form="plugin-bulk-form" value="' + name + '" aria-label="选择禁用 ' + name + '"' + (canDisable ? '' : ' disabled') + '><span>选择</span></label>';
    const toggle = item.enablementError ? '' : enabled
      ? canDisable ? form('disable-plugin', field, '禁用', 'plugin-ghost') : '<button type="button" class="plugin-ghost" disabled title="' + escapeHtml(item.disableReason || '此插件不能安全禁用') + '">禁用受限</button>'
      : item.compatible ? form('enable-plugin', field, '启用') : '';
    const labels = { file: '本地包（file:）', link: '源码链接（link/workspace）', git: 'Git / URL 来源', registry: 'npm 来源', alias: 'npm 别名', unknown: '来源待核对' };
    const kind = item.updateSourceKind || 'unknown';
    const sourceLabel = item.updateSourceDisplay ? '<p class="hint plugin-source"><span class="plugin-source-label">' + escapeHtml(labels[kind] || labels.unknown) + '</span><code>' + escapeHtml(item.updateSourceDisplay) + '</code></p>' : '';
    let update;
    if (!item.enablementError && item.updateSupported) update = form('update-plugin', field, '检查并更新', 'plugin-ghost');
    else {
      const label = kind === 'file' ? '查看本地包更新方式' : kind === 'link' ? '查看源码更新方式' : item.updateScope === 'profile' ? '查看配置档更新限制' : '查看更新限制';
      const reason = item.updateScope === 'profile' && shared.length ? '请查看上方的配置档限制。此保护未被绕过。' : item.updateReason || '请核对安装来源后更新。';
      const guide = kind === 'file' ? '保持 file: 来源：先从原项目生成可信新版包。重新导入按安装/启用处理，不能当成保留所有状态的原位更新；不要自动切换 npm。'
        : kind === 'link' ? '此插件由外部源码项目提供，请在对应项目维护、构建和验证后更新；控制台不会改动源码或切换 npm 来源。'
        : kind === 'git' || kind === 'alias' ? '需要从原引用核对新版与安全恢复方式，控制台不会猜测或替换包的归属。'
        : '只有来源与配置档隔离预检都通过，才开放自动更新。';
      update = '<details class="plugin-update-help"><summary>' + escapeHtml(label) + '</summary><div class="plugin-update-help-body"><p>' + escapeHtml(reason) + '</p><p>' + escapeHtml(guide) + '</p></div></details>';
    }
    const issues = [...new Set([item.enablementError, enabled && !canDisable ? item.disableReason : ''].filter(Boolean))];
    return '<article class="plugin-card installed-plugin" data-plugin-card data-plugin-name="' + name + '" data-enabled="' + enabled + '" data-problem="' + problem + '" data-description="' + escapeHtml(item.description || '') + '">'
      + select
      + '<div class="plugin-detail"><div class="plugin-heading"><strong>' + name + '</strong><span class="plugin-status" data-tone="' + tone + '">' + escapeHtml(item.version) + ' · ' + status + '</span></div>'
      + '<p class="plugin-description">' + escapeHtml(item.description || '插件未提供描述') + '</p>' + sourceLabel
      + issues.map(text => '<p class="hint plugin-issue">' + escapeHtml(text) + '</p>').join('') + '</div>'
      + '<div class="actions plugin-actions">' + toggle + update
      + (item.enablementError ? '' : form('uninstall-plugin', field, '卸载并清理', 'danger')) + '</div></article>';
  }).join('');
}
function toolbar(csrf, view) {
  return '<div id="installed-plugin-controls" class="plugin-toolbar">'
    + '<div class="plugin-filters"><label class="plugin-field"><span>搜索已安装插件</span><input type="search" id="plugin-search" placeholder="名称或描述…" autocomplete="off"></label>'
    + '<label class="plugin-field"><span>状态筛选</span><select id="plugin-state-filter"><option value="all">全部已安装</option><option value="enabled">已启用</option><option value="disabled">已禁用</option><option value="problem">需要检查</option></select></label></div>'
    + '<div class="plugin-batch"><p class="hint" id="plugin-selection-status" role="status" aria-live="polite">未选择插件</p>'
    + '<div class="actions"><button type="button" id="plugin-select-visible">选择当前结果</button><button type="button" id="plugin-clear-selection">清空选择</button>'
    + '<form id="plugin-bulk-form" method="post" action="/__fnos/action"><input type="hidden" name="csrf" value="' + escapeHtml(csrf) + '"><input type="hidden" name="view" value="' + escapeHtml(view) + '"><input type="hidden" name="action" value="disable-plugins"><button id="plugin-disable-selected" type="submit" class="danger" disabled>批量禁用所选插件</button></form></div></div>'
    + '<p class="hint plugin-toolbar-note">仅选择支持安全禁用的已启用插件，每批最多 50 个。先整体预检，再一次重启生效；切换筛选会清空选择，不会禁用隐藏项。</p></div>';
}
function installClient() {
  const controls = document.getElementById('installed-plugin-controls');
  if (!controls) return;
  const cards = Array.from(document.querySelectorAll('[data-plugin-card]'));
  const search = document.getElementById('plugin-search');
  const filter = document.getElementById('plugin-state-filter');
  const status = document.getElementById('plugin-selection-status');
  const button = document.getElementById('plugin-disable-selected');
  const check = card => card.querySelector('input[name="packageNames"]');
  const selected = () => cards.filter(card => check(card)?.checked);
  const sync = () => {
    const visible = cards.filter(card => !card.hidden).length;
    const count = selected().length;
    button.disabled = count === 0 || count > 50;
    status.textContent = '显示 ' + visible + ' / ' + cards.length + ' 个，已选择 ' + count + ' 个' + (count > 50 ? '（每批最多 50 个）' : '');
  };
  const clear = () => { for (const card of cards) { const input = check(card); if (input) input.checked = false; } sync(); };
  const apply = () => {
    const query = search.value.trim().toLowerCase();
    for (const card of cards) {
      const text = (card.dataset.pluginName + ' ' + card.dataset.description).toLowerCase();
      const matches = filter.value === 'all' || filter.value === 'enabled' && card.dataset.enabled === 'true'
        || filter.value === 'disabled' && card.dataset.enabled === 'false' || filter.value === 'problem' && card.dataset.problem === 'true';
      card.hidden = !(matches && (!query || text.includes(query)));
    }
    clear();
  };
  search.addEventListener('input', apply);
  filter.addEventListener('change', apply);
  for (const card of cards) check(card)?.addEventListener('change', sync);
  document.getElementById('plugin-clear-selection').addEventListener('click', clear);
  document.getElementById('plugin-select-visible').addEventListener('click', () => {
    clear();
    let count = 0;
    for (const card of cards) { const input = check(card); if (!card.hidden && input && !input.disabled && count < 50) { input.checked = true; count++; } }
    sync();
  });
  document.getElementById('plugin-bulk-form').addEventListener('submit', event => {
    if (!selected().length || selected().length > 50 || selected().some(card => card.hidden || check(card).disabled)) {
      event.preventDefault(); status.textContent = '请选择 1–50 个当前结果中的可安全禁用插件。';
    }
  });
  sync();
}
const styles = [
  '.plugin-update-notice{margin:16px 0;padding:14px 16px;border:1px solid var(--mg-warn-border);border-radius:var(--mg-radius-item,10px);background:var(--mg-warn-bg);color:var(--mg-warn-title);overflow-wrap:anywhere}',
  '.plugin-update-notice strong{display:block;margin-bottom:8px;font-size:14px}',
  '.plugin-update-notice p{margin:6px 0;line-height:1.6}',
  '.plugin-update-notice p:last-child{margin-bottom:0;color:var(--mg-warn-title);opacity:.86}',
  '.plugin-toolbar{display:grid;gap:12px;margin:18px 0 16px;padding:14px 16px;border:1px solid var(--mg-border);border-radius:var(--mg-radius-item,10px);background:var(--mg-softer);align-items:stretch}',
  '.plugin-toolbar .plugin-filters{display:flex;flex-wrap:wrap;gap:12px 16px;align-items:flex-end}',
  '.plugin-toolbar .plugin-field{display:flex;flex-direction:column;gap:6px;flex:1 1 220px;min-width:0;margin:0;font-size:13px;font-weight:600;line-height:1.3;color:var(--mg-muted)}',
  '.plugin-toolbar .plugin-field>span{display:block}',
  '.plugin-toolbar .plugin-field input,.plugin-toolbar .plugin-field select{width:100%;min-height:38px;margin:0;font-size:14px;font-weight:400;color:var(--mg-text);background:var(--mg-panel)}',
  '.plugin-batch{display:flex;flex-wrap:wrap;gap:10px 12px;align-items:center;justify-content:space-between;padding-top:12px;border-top:1px solid var(--mg-border)}',
  '.plugin-batch>#plugin-selection-status{margin:0;font-size:13px;line-height:1.5;color:var(--mg-muted);font-variant-numeric:tabular-nums}',
  '.plugin-batch .actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0}',
  '.plugin-batch .actions form{margin:0}',
  '.plugin-batch .actions button{min-height:36px;padding:0 14px;font-size:14px}',
  '.plugin-batch .actions button#plugin-select-visible,.plugin-batch .actions button#plugin-clear-selection{background:var(--mg-panel);color:var(--mg-text);border:1px solid var(--mg-border-strong)}',
  '.plugin-batch .actions button#plugin-select-visible:hover,.plugin-batch .actions button#plugin-clear-selection:hover{background:var(--mg-soft)}',
  '.plugin-toolbar-note{max-width:78ch;margin:0;font-size:13px;line-height:1.65;color:var(--mg-muted)}',
  '.installed-plugin[hidden]{display:none!important}',
  '.plugin-list{display:grid;gap:12px}',
  '.installed-plugin{display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-areas:"select detail" ". actions";column-gap:14px;row-gap:14px;align-items:start;padding:16px 18px;background:var(--mg-panel);border:1px solid var(--mg-border);border-radius:var(--mg-radius-item,10px)}',
  '.installed-plugin .plugin-selection{grid-area:select;margin-top:1px}',
  '.installed-plugin .plugin-detail{grid-area:detail;min-width:0}',
  '.installed-plugin .plugin-actions{grid-area:actions;display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0}',
  '.plugin-heading{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;min-width:0}',
  '.plugin-heading strong{font-size:15px;line-height:1.4;overflow-wrap:anywhere}',
  '.plugin-status{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;line-height:1.4;color:var(--mg-muted);font-variant-numeric:tabular-nums}',
  '.plugin-status::before{content:"";width:6px;height:6px;flex:0 0 6px;border-radius:50%;background:var(--mg-tertiary)}',
  '.plugin-status[data-tone="enabled"]::before{background:#2f9e5f}',
  '.plugin-status[data-tone="problem"]{color:var(--mg-warn-title)}',
  '.plugin-status[data-tone="problem"]::before{background:#d6a12a}',
  '.plugin-description{margin:8px 0 0;font-size:14px;line-height:1.6;color:var(--mg-muted);overflow-wrap:anywhere;white-space:normal}',
  '.plugin-source{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 8px;margin:10px 0 0;font-size:13px;min-width:0}',
  '.plugin-source-label{font-weight:600;color:var(--mg-muted);white-space:nowrap}',
  '.plugin-source code{padding:2px 7px;border-radius:6px;background:var(--mg-soft);color:var(--mg-text);font-size:12.5px;line-height:1.5;white-space:normal;overflow-wrap:anywhere;user-select:all}',
  '.plugin-issue{margin:8px 0 0;font-size:13px;line-height:1.55;color:var(--mg-warn-title)}',
  '.installed-plugin .plugin-actions button,.installed-plugin .plugin-actions summary{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:0 14px;border-radius:8px;font:inherit;font-size:14px;font-weight:500;line-height:1.2;cursor:pointer}',
  '.installed-plugin .plugin-actions button.plugin-ghost{background:var(--mg-panel);color:var(--mg-text);border:1px solid var(--mg-border-strong)}',
  '.installed-plugin .plugin-actions button.plugin-ghost:hover{background:var(--mg-soft)}',
  '.installed-plugin .plugin-actions>form{margin:0}',
  '.installed-plugin .plugin-actions>form:last-child{margin-left:auto}',
  '.installed-plugin button:disabled{cursor:not-allowed;background:var(--mg-soft);color:var(--mg-tertiary);border:1px solid var(--mg-border);opacity:1}',
  '.plugin-toolbar button:disabled{cursor:not-allowed;background:var(--mg-soft);color:var(--mg-tertiary);border:1px solid var(--mg-border);opacity:1}',
  '.installed-plugin .plugin-update-help{min-width:0;max-width:100%;border:0;background:none}',
  '.installed-plugin .plugin-update-help summary{list-style:none;background:var(--mg-panel);color:var(--mg-text);border:1px solid var(--mg-border-strong)}',
  '.installed-plugin .plugin-update-help summary::-webkit-details-marker{display:none}',
  '.installed-plugin .plugin-update-help summary::after{content:"▾";margin-left:6px;font-size:11px;opacity:.6;transition:transform .15s}',
  '.installed-plugin .plugin-update-help[open] summary::after{transform:rotate(180deg)}',
  '.installed-plugin .plugin-update-help summary:hover{background:var(--mg-soft)}',
  '.plugin-update-help-body{margin-top:8px;padding:12px 14px;border:1px solid var(--mg-border);border-radius:8px;background:var(--mg-softer)}',
  '.plugin-update-help-body p{margin:6px 0;font-size:13px;line-height:1.65;color:var(--mg-muted);overflow-wrap:anywhere}',
  '.plugin-update-help-body p:first-child{margin-top:0}',
  '.plugin-update-help-body p:last-child{margin-bottom:0}',
  '.actions form.has-operation-feedback{flex-basis:100%;display:flex;flex-wrap:wrap;gap:8px;align-items:start;min-width:0}',
  '.operation-feedback{flex-basis:100%;margin:4px 0;padding:12px;border:1px solid var(--mg-border-strong);border-radius:10px;background:var(--mg-soft);color:var(--mg-text);overflow-wrap:anywhere}',
  '.operation-feedback strong{display:block}',
  '.operation-feedback p{margin:8px 0}',
  '.operation-feedback button{min-height:36px;padding:0 14px;border-radius:8px;background:var(--mg-panel);color:var(--mg-text);border:1px solid var(--mg-border-strong)}',
  '.operation-feedback[data-tone="warning"]{border-color:var(--mg-warn-border);background:var(--mg-warn-bg);color:var(--mg-warn-title)}',
  '.plugin-selection{display:inline-flex;align-items:center;gap:8px;flex:0 0 auto;font-size:13px;color:var(--mg-muted);cursor:pointer}',
  '.plugin-selection input[type=checkbox]{width:18px;height:18px;min-height:0;margin:0;padding:0;flex:0 0 auto}',
  '.plugin-selection span{font-size:13px;line-height:1.2;white-space:nowrap}',
  '@media(max-width:640px){.installed-plugin{grid-template-columns:minmax(0,1fr);grid-template-areas:"select" "detail" "actions";row-gap:12px}.installed-plugin .plugin-actions>form:last-child{margin-left:0}.plugin-toolbar .plugin-field{flex:1 1 100%}.plugin-batch .actions{width:100%}.plugin-batch .actions form{flex:1 1 100%}.plugin-batch .actions button{width:100%}}'
].join('');
module.exports = { cards, toolbar, styles, installClient, operationFeedback, showOperationFeedback, clientScript: () => '(' + installClient.toString() + ')();' };
