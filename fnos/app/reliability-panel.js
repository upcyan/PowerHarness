const fs=require('node:fs');const path=require('node:path');const store=require('./backup-store.js');
const escape=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render({dataDir,state,backups,backupReadError='',profile,authorizedCount,action,report}){
 let root;try{root=store.root(dataDir);}catch{root='存储位置无法确认';}
 const latest=backups[0];const referenceStatus=report?.status==='references-ok'?'引用检查通过（尚非恢复运行验证）':report?.status==='incomplete'?'发现缺失引用':report?'检查结果不完整':'未执行引用完整性检查';
 const pairs=[['当前配置档',profile],['自动备份提交时间',state.lastBackup||'尚未记录'],['独立备份位置',root],['最新备份一致性',backupReadError?'无法确认可用备份（列表读取失败）':latest?.consistency==='verified-online'?'已校验的在线副本':latest?.consistency==='stopped-core'?'已校验的停机副本':latest?'旧备份尚无一致性证明':'暂无备份'],['预设 / 插件 / 凭据引用',referenceStatus],['功能可恢复',report?.functionalRestore==='verified'?'已做实际运行验证':'尚未进行会话续聊等功能验证'],['fnOS 授权来源','TRIM_DATA_ACCESSIBLE_PATHS · '+authorizedCount+' 个可见授权目录']];
 const gaps=report?[['missingPresets','缺失预设'],['missingPlugins','缺失插件'],['missingCredentials','缺失凭据引用']].filter(([key])=>report[key]?.length).map(([key,label])=>'<p class="error">'+escape(label)+'：'+report[key].map(escape).join('、')+'</p>').join(''):'';
 return '<section class="reliability-status" aria-labelledby="reliability-title"><h3 id="reliability-title">数据保护与恢复完整性</h3>'+(backupReadError?'<p class="error" role="status">'+escape(backupReadError)+'</p>':'')+'<dl>'+pairs.map(([key,value])=>'<dt>'+escape(key)+'</dt><dd>'+escape(value)+'</dd>').join('')+'</dl>'+gaps+(report?.issues?.length?'<p class="hint">还有 '+report.issues.length+' 项无法确认；请勿据此认定可以安全恢复。</p>':'')+'<p class="hint">文件备份、引用检查与实际恢复是三个不同层级；保存设置不会自动授权重启。卸载默认先独立保全，保全快照不自动清理。</p><div class="actions">'+action('inspect-restore-integrity','检查恢复资产（不重启）')+'</div></section>';
}
module.exports={render};
