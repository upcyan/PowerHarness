/** Read-only FPK platform-patch inspection. Contains no patch application API. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root,file) => file === root || file.startsWith(root+path.sep);
const count = (text,needle) => typeof needle === 'string' && needle ? text.split(needle).length-1 : 0;
const normalized = text => text.split(/\s+/).join(' ');
const clients = ['lib/client.js','lib/client.browser.js','lib/client.node.js'];
const eager = [...clients,'lib/index.js'];
const kinds = new Set(['version','replace','probe','foreground','route','iterator','composer','shim']);
const owner = 'FPK构建 · patch-dsh.mjs';
function problem(message,code='INVALID_PLATFORM_PATCH') { return Object.assign(Error(message),{code}); }
function fileText(file,boundary) {
  const real=fs.realpathSync(file);
  if(!within(boundary,real))throw problem('平台检查目标越出已确认的运行时边界');
  const stat=fs.statSync(real);
  if(!stat.isFile()||stat.size>8*1024*1024)throw problem('平台检查目标不是受限文本文件');
  const bytes=fs.readFileSync(real),text=bytes.toString('utf8');
  if(!Buffer.from(text).equals(bytes))throw problem('平台检查目标不是UTF-8文本');
  return text;
}
function validCatalog(catalog) {
  if(!catalog||catalog.schemaVersion!==1||!Array.isArray(catalog.rules)||catalog.rules.length!==15||!/^[a-f0-9]{64}$/.test(catalog.scriptSHA256||''))throw problem('平台检查清单缺失、损坏或版本不支持');
  const ids=new Set();
  for(const rule of catalog.rules) {
    if(!rule||!/^platform-[a-z0-9-]+$/.test(rule.id)||ids.has(rule.id)||!kinds.has(rule.kind)||!/^@deepseek-ai[/][a-z0-9-]+$/.test(rule.plugin))throw problem('平台检查规则身份无效');
    ids.add(rule.id);
    if(rule.targetFile&&(path.isAbsolute(rule.targetFile)||rule.targetFile.includes(String.fromCharCode(92))||rule.targetFile.split('/').some(part=>!part||part==='..'||part==='.')))throw problem('平台检查目标路径无效');
  }
  return catalog;
}
export function runtimeFromInstallAnchor(installAnchor) {
  try {
    const manifest=createRequire(installAnchor).resolve('@deepseek-ai/dsh/package.json');
    const root=path.dirname(path.dirname(path.dirname(path.dirname(fs.realpathSync(manifest)))));
    const identity=JSON.parse(fileText(manifest,root));
    return identity.name==='@deepseek-ai/dsh'?root:null;
  } catch { return null; }
}
function baseRow(rule,targetFile) {
  return {id:rule.id,plugin:rule.plugin,targetFile:targetFile||rule.targetFile||'',description:rule.description,source:'PowerHarness/scripts/patch-dsh.mjs',scope:'platform',kind:['version','probe','route','iterator'].includes(rule.kind)?'contract':'patch',managedBy:owner,canApply:false,canRollback:false,anchorStatus:'unknown'};
}
export function inspectPlatformPatches({runtimeDir,fallbackCatalog}) {
  let runtime,app,catalog,catalogSource;
  const broken=(message)=>({ok:false,catalogSource:catalogSource||'unavailable',patches:[{...baseRow({id:'platform-catalog',plugin:'@deepseek-ai/dsh',description:'平台补丁清单'}),status:'invalid',message}]});
  try {
    if(!runtimeDir)throw problem('无法从当前profileContext.installAnchor确认活动运行时；不猜测默认安装位置');
    runtime=fs.realpathSync(runtimeDir);app=path.dirname(runtime);
    const installed=path.join(app,'platform-patches.json');
    if(fs.existsSync(installed)){catalog=JSON.parse(fileText(installed,app));catalogSource='active-fpk';}
    else {catalog=typeof fallbackCatalog==='string'?JSON.parse(fileText(fallbackCatalog,path.dirname(fs.realpathSync(fallbackCatalog)))):fallbackCatalog;catalogSource='plugin-fallback';}
    validCatalog(catalog);
  }catch(error){return broken(error.message);}
  const cache=new Map();
  const read=(file,boundary=runtime)=>{if(!cache.has(file))cache.set(file,fileText(file,boundary));return cache.get(file);};
  const packages=new Map();
  function pkg(name) {
    if(packages.has(name))return packages.get(name);
    const short=name.slice('@deepseek-ai/'.length);
    const options=[path.join(runtime,'node_modules/@deepseek-ai',short),path.join(runtime,'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',short)];
    const root=options.find(dir=>fs.existsSync(path.join(dir,'package.json')));
    if(!root)throw problem('运行时缺少包 '+name,'ENOENT');
    const manifest=JSON.parse(read(path.join(root,'package.json')));
    if(manifest.name!==name||typeof manifest.version!=='string')throw problem('平台包身份或版本无法确认');
    const value={root,version:manifest.version,exports:manifest.exports};packages.set(name,value);return value;
  }
  let core;
  try {
    core=pkg('@deepseek-ai/dsh');
    const source=path.join(app,'patch-dsh.mjs');
    if(fs.existsSync(source)&&sha(read(source,app))!==catalog.scriptSHA256) {
      return {ok:false,catalogSource,patches:catalog.rules.map(rule=>({...baseRow(rule),version:core.version,status:'conflict',message:'检查清单与活动FPK的patch-dsh.mjs版本不一致；请随FPK重新生成，未改动运行时'}))};
    }
  }catch(error){return broken(error.message);}
  function available(info,options) {
    const exported=[];
    const visit=value=>{if(typeof value==='string'&&clients.map(file=>'./'+file).includes(value))exported.push(value.slice(2));else if(value&&typeof value==='object')Object.values(value).forEach(visit);};
    visit(info.exports);
    for(const file of exported)if(!fs.existsSync(path.join(info.root,file)))throw problem('包声明的客户端入口缺失：'+file,'ENOENT');
    return options.filter(file=>fs.existsSync(path.join(info.root,file)));
  }
  function probeGood(rule,info) {
    const source=read(path.join(info.root,rule.targetFile));
    return count(source,rule.reject)===1&&rule.prefixes.some(prefix=>normalized(source).includes(prefix));
  }
  const patches=[];
  for(const rule of catalog.rules) {
    let info;
    try {
      info=pkg(rule.plugin);
      const files=['replace','foreground'].includes(rule.kind)?available(info,clients):[rule.targetFile||''];
      if(!files.length)throw problem('平台包没有可检查的客户端入口','ENOENT');
      for(const file of files) {
        const row={...baseRow(rule,file),version:info.version};
        if(files.length>1)row.id+='-'+file.split('/').join('-');
        let result;
        if(rule.kind==='version') {
          row.targetFile='package.json';result=info.version===core.version?['verified','valid','核心与连接模块版本一致（契约检查，不是新增补丁）']:['invalid','invalid','核心与连接模块版本不一致'];
        }else if(rule.kind==='route') {
          const entries=available(info,[...clients,'lib/types/client/runtime.js']);row.targetFile=entries.join(' / ');
          if(!entries.length)throw problem('路由契约没有可检查入口','ENOENT');
          const found=entries.some(entry=>read(path.join(info.root,entry)).includes(rule.needle));
          result=found?['verified','valid','至少一个入口满足原构建脚本的文档相对路由契约；并非重写补丁']:['invalid','invalid','文档相对路由锚点缺失，上游契约已漂移'];
        }else if(rule.kind==='iterator') {
          const entries=available(info,eager);row.targetFile=entries.join(' / ');
          if(!entries.length)throw problem('首屏预览入口缺失，不能按未检查判通过','ENOENT');
          const unsafe=entries.some(entry=>read(path.join(info.root,entry)).includes(rule.forbidden));
          result=unsafe?['invalid','invalid','首屏模块重新出现裸Iterator解引用']:['verified','valid','所有存在的首屏入口通过；延迟PDF入口不在此检查范围'];
        }else if(rule.kind==='probe') {
          result=probeGood(rule,info)?['verified','valid','Host探针在注册客户端或调用业务之前拒绝非空参数']:['invalid','invalid','Host无副作用探针契约失效，不能安全重放前台恢复补丁'];
        }else {
          const source=read(path.join(info.root,file));
          if(rule.kind==='replace') {
            const raw=count(source,rule.anchor),done=count(source,rule.applied);
            result=info.version!==core.version?['invalid','invalid','连接包与核心版本不一致，不能确认适配']:raw===0&&done===1?['active','applied','网关信任适配完整且唯一']:raw===1&&done===0?['stale','valid','原始锚点有效；应由FPK构建应用，不在运行中改写']:['invalid','ambiguous','信任锚点缺失、重复或混合，需复核上游'];
          }else if(rule.kind==='foreground') {
            const probe=catalog.rules.find(candidate=>candidate.kind==='probe');
            if(!probe||!probeGood(probe,info))result=['invalid','invalid','关联Host探针契约失效，不能确认前台恢复适配'];
            else if(count(source,rule.applied)===1&&count(source,rule.marker)===1&&count(source,rule.previous)===0&&count(source,rule.anchor)===1)result=['active','applied','完整恢复块与当前FPK策略逐字一致，单一transport所有者'];
            else if(count(source,rule.anchor)===1&&count(source,rule.marker)===0&&(count(source,rule.previous)===0||(count(source,rule.previous)===1&&count(source,rule.end)===1)))result=['stale','valid','可由FPK构建应用或升级旧适配；当前不执行写入'];
            else result=['invalid',count(source,rule.marker)>1||count(source,rule.anchor)>1?'ambiguous':'invalid','恢复块缺失、内容漂移或重复；仅有v2标记不能证明有效'];
          }else if(rule.kind==='composer') {
            result=source.includes(rule.anchor)?['stale','valid','仍含老引擎不支持的color-mix，应在FPK构建转换']:source.includes(rule.applied)?['not-needed','valid','原表达式已不存在且透明fallback可见，仅确认脚本后置条件，不证明渲染效果']:['invalid','invalid','原表达式与可识别的透明fallback均缺失，不能把未知样式判为健康'];
          }else if(rule.kind==='shim') {
            const compat=path.join(app,'legacy-compat.js');
            const outside=source.replace(rule.applied,'<head>');
            const moduleAt=outside.search(/[<]script[^>]*type=["']module["']/i);
            const compatGood=fs.existsSync(compat)&&sha(read(compat,app))===rule.polyfillSHA256;
            if(!compatGood)result=['invalid','invalid','兼容shim源文件缺失或版本与清单不一致'];
            else if(count(source,rule.applied)===1&&count(source,rule.marker)===1&&count(source,rule.end)===1&&count(outside,'<head>')===1&&(moduleAt<0||source.indexOf(rule.applied)<moduleAt))result=['active','applied','head内完整shim与随包源文件匹配，标记唯一'];
            else if(count(source,rule.marker)===0&&count(source,rule.end)===0&&count(source,'<head>')===1)result=['stale','valid','head锚点有效；应由FPK构建注入兼容shim'];
            else result=['invalid',count(source,rule.marker)>1?'ambiguous':'invalid','shim块不完整、版本漂移或标记重复；不能仅凭start标记判健康'];
          }
        }
        patches.push({...row,status:result[0],anchorStatus:result[1],message:result[2]+'。平台补丁归FPK管理，此处只读。'});
      }
    }catch(error){patches.push({...baseRow(rule),version:info?.version||core.version,status:error.code==='ENOENT'?'missing':'invalid',message:error.message+'；未改动运行时。'});}
  }
  return {ok:patches.every(row=>['active','verified','not-needed'].includes(row.status)),catalogSource,patches};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);if(args.length!==2)throw Error('Usage: node platform-patch-status.mjs <runtime> <catalog.json>');
  const report=inspectPlatformPatches({runtimeDir:args[0],fallbackCatalog:args[1]});
  console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;
}
