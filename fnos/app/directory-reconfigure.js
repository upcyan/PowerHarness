'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {fork} = require('node:child_process');
const options = require('./install-options');
const migration = require('./install-migration');
const owner = require('./port-owner');
const ITEMS = [...migration.ITEMS, 'cores', 'last-good-runtime', '.dsh-fnos-data.json'];
const JOURNAL = 'directory-reconfigure-transaction.json';
const stat = p => fs.lstatSync(p,{throwIfNoEntry:false});
const within = (a,b) => b === a || b.startsWith(a + path.sep);
const overlap = (a,b) => within(a,b) || within(b,a);
const names = p => stat(p) ? fs.readdirSync(p).sort() : [];
const sourceItems = p => names(p.source).filter(n => p.kind !== 'data' || (!['state.json','supervisor.pid','supervisor.pid.starttime','.fnos-instance.cjs'].includes(n) && !n.endsWith('.log') && !n.endsWith('.sock') && !stat(path.join(p.source,n))?.isSocket()));
const sourceStamp = p => JSON.stringify(sourceItems(p).map(n => [n,stamp(path.join(p.source,n))]));
function syncTree(p) { const s=stat(p); if(s.isSymbolicLink())return; if(s.isDirectory())for(const n of names(p))syncTree(path.join(p,n)); const fd=fs.openSync(p,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);} }
// Metadata only: confirmation binds the whole target tree without reading user files.
function stamp(root) {
  const hash = crypto.createHash('sha256');
  const walk = p => {const s=stat(p);if(!s)return;hash.update(JSON.stringify([path.relative(root,p),s.dev,s.ino,s.mode,s.size,s.mtimeMs,s.ctimeMs]));if(s.isDirectory())for(const n of names(p))walk(path.join(p,n));};
  walk(root); return hash.digest('hex');
}
function otherRoots(env) {
  const baseName = ['dsh','fnos'].join('-'); // Keep the counterpart identity out of generic derived-build rewrites.
  const other = baseName + (options.defaults.dataDir.endsWith('2') ? '' : '2');
  const suffix = options.defaults.dataDir.endsWith('2') ? '' : '2';
  const roots = [options.defaults.dataDir.replace(/2$/, '') + suffix, options.defaults.backupDir.replace(/2$/, '') + suffix];
  // Resolve bridge names dynamically: derived-build rewrites must not alias the two.
  for(const name of fs.readdirSync('/opt').filter(n => /^dsh[0-9]*$/.test(n))) {
    try { const root = path.dirname(fs.realpathSync(path.join('/opt',name,'home'))); if(root !== path.resolve(env.FNOS_DATA_DIR || '.')) roots.push(root); } catch {}
  }
  for(const volume of fs.readdirSync('/').filter(n => /^vol[0-9]+$/.test(n))) {
    try { const r=options.read(path.join('/',volume,'@appconf',other));if(r)roots.push(r.dataDir,r.backupDir); } catch(error) {if(error.code !== 'ENOENT')throw error;}
  }
  return [...new Set(roots)];
}
function plan({dataDir,backupDir,currentDataDir,currentBackupDir,env=process.env,protectedRoots}) {
  const target=options.directory(dataDir),targetBackup=options.directory(backupDir);
  const current=options.directory(currentDataDir),currentBackup=options.directory(currentBackupDir);
  const pairs=[{kind:'data',source:current,target},{kind:'backup',source:currentBackup,target:targetBackup}].filter(p=>p.source!==p.target);
  if(!pairs.length)return {ok:false,code:'same-directory',message:'数据与备份目录均未变化。'};
  const roots=[current,currentBackup,target,targetBackup];
  for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++)if(roots[i]!==roots[j]&&overlap(roots[i],roots[j]))throw Error('新旧数据与备份目录不能相互包含');
  if(target===currentBackup||targetBackup===current||target===targetBackup)throw Error('数据与备份目录不能互换或合并');
  const protectedPaths=protectedRoots || otherRoots(env);
  for(const p of pairs) {
    if(!stat(p.source)?.isDirectory())throw Error('迁移源目录不存在，拒绝提交');
    if(protectedPaths.some(r=>overlap(path.resolve(r),p.target)||overlap(path.resolve(r),p.source)))throw Error('目录属于另一实例，拒绝迁移');
    // 不查 options.grants(env)：那是 supervisor 启动时的授权快照，用户刚在应用中心
    // 勾完目录时运行中的进程还是旧表，会把合法的迁移挡在门外（2026-11-17 实测）。
    // 下面以本应用身份真访问一次，才是有意义的判据。
    let parent=p.target;while(!stat(parent))parent=path.dirname(parent);
    try{fs.accessSync(parent,fs.constants.R_OK|fs.constants.W_OK|fs.constants.X_OK);}
    catch(error){throw Error('目标目录所在位置当前不可写（'+((error&&error.code)||error)+'）：请在应用中心授权目标目录的父目录读写权限');}
    if(stat(p.target))fs.accessSync(path.dirname(p.target),fs.constants.W_OK|fs.constants.X_OK);
    p.existingItems=names(p.target);p.stamp=stamp(p.target);
  }
  const existingItems=pairs.flatMap(p=>p.existingItems.map(n=>p.kind+': '+n));
  return {ok:true,target,targetBackup,pairs,existingItems,needsConfirmation:!!existingItems.length,
    confirmation:crypto.createHash('sha256').update(JSON.stringify(pairs.map(p=>[p.target,p.stamp]))).digest('hex'),
    message:existingItems.length?'新目录非空。确认后先将原内容移出到可恢复隔离区，再复制并校验；不确认请更换其他目录。':'新目录为空；迁移时仅暂停本实例核心，控制台保持可访问。'};
}
function save(file,entry) {
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(entry));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);
  const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
function blocked(controlDir) {
  const file=path.join(controlDir,JOURNAL);
  if(stat(file)) {const entry=JSON.parse(fs.readFileSync(file,'utf8'));if(!['completed','rolled-back'].includes(entry.phase))return '存在未完成的目录迁移，旧数据与隔离副本均保留；请在控制台检查迁移事务，不要重复提交。';}
  return null;
}
function apply(input) {
  const {controlDir,env=process.env,appDir=__dirname,confirmed=false,confirmation,commitGuard=()=>true}=input;
  if(!controlDir || [input.currentDataDir,input.currentBackupDir,input.dataDir,input.backupDir].some(r=>within(path.resolve(r),path.resolve(controlDir))))throw Error('迁移需要独立且稳定的应用配置目录');
  if(blocked(controlDir))throw Error(blocked(controlDir));
  const planned=plan(input);if(!planned.ok)throw Error(planned.message);
  if(planned.needsConfirmation&&!confirmed)throw Error('目标非空，需要二次确认；请确认或更换其他目录');
  if((planned.needsConfirmation || confirmation)&&confirmation!==planned.confirmation)throw Error('目标内容已变化，请重新检查并确认');
  const running=owner.ownedProcesses(input.currentDataDir,appDir).filter(p=>!['supervisor','gateway'].includes(p.role));
  if(running.length)throw Error('本实例仍有核心或恢复进程运行，拒绝迁移');
  const journal=path.join(controlDir,JOURNAL),lock=journal+'.lock';
  const old=options.read(controlDir,env);
  const record=options.validate({dataDir:planned.target,backupDir:planned.targetBackup,selectedPlugins:old?.selectedPlugins || []},env);
  const fd=fs.openSync(lock,'wx',0o600);
  const entry={schema:1,id:crypto.randomUUID(),phase:'prepared',pairs:[],record};
  let committed=false;
  try {
    save(journal,entry);
    for(const p of planned.pairs) {
      if(stamp(p.target)!==p.stamp)throw Error('目标内容已变化，请重新确认');
      fs.mkdirSync(path.dirname(p.target),{recursive:true,mode:0o700});
      const quarantine=fs.mkdtempSync(path.join(path.dirname(p.target),'.dsh-reconfigure-previous-'));
      const targetExisted=!!stat(p.target);
      const pair={...p,quarantine,targetExisted,cleared:[],copied:[],sourceItems:sourceItems(p),sourceStamp:sourceStamp(p)};
      entry.pairs.push(pair);save(journal,entry);
      fs.mkdirSync(p.target,{recursive:true,mode:0o700});
      // Clear first by rename, never irrevocably delete confirmed target contents.
      for(const n of p.existingItems) {pair.cleared.push(n);save(journal,entry);fs.renameSync(path.join(p.target,n),path.join(quarantine,n));}
      entry.phase='copying';save(journal,entry);
      for(const n of pair.sourceItems) {
        pair.copied.push(n);save(journal,entry);
        migration.copy(path.join(p.source,n),path.join(p.target,n),p.source,p.target);
      }
      for(const n of pair.sourceItems)migration.verify(path.join(p.source,n),path.join(p.target,n),p.source,p.target);
    }
    for(const p of entry.pairs) {
      if(sourceStamp(p)!==p.sourceStamp)throw Error('迁移源发生并发变化，拒绝提交');
      syncTree(p.target);
    }
    if(!commitGuard())throw Error('守护进程已关闭，保留旧目录并取消提交');
    const status=options.check(record,env,{create:false});
    if(!status.ok)throw Error('新目录真实读写或属主检查失败，保留旧目录');
    entry.phase='verified';save(journal,entry);
    // Config commit is the point of no return. Never remove the source before it.
    if(!commitGuard())throw Error('守护进程已关闭，取消提交');
    for(const p of entry.pairs)if(sourceStamp(p)!==p.sourceStamp)throw Error('迁移源发生并发变化，拒绝提交');
    options.write(controlDir,record,env);committed=true;
    entry.phase='committed';save(journal,entry);
    const removedOld=[];
    for(const p of entry.pairs) {
      p.retired=fs.mkdtempSync(path.join(path.dirname(p.source),'.dsh-reconfigure-old-'));
      save(journal,entry);
      for(const n of p.sourceItems) {fs.renameSync(path.join(p.source,n),path.join(p.retired,n));removedOld.push(p.kind+': '+n);}
    }
    entry.phase='completed';save(journal,entry);
    return {migrated:true,record,removedOld,journal,previous:entry.pairs.map(p=>p.quarantine),retired:entry.pairs.map(p=>p.retired)};
  } catch(error) {
    // A post-rename fsync failure may mean the config is already committed.
    try {const r=options.read(controlDir,env);if(r?.dataDir===record.dataDir&&r?.backupDir===record.backupDir)committed=true;} catch {}
    if(committed) {
      entry.phase='committed';entry.error=error.message;try{save(journal,entry);}catch{}
      return {migrated:true,record,removedOld:[],journal,warning:'新目录已提交，旧数据清理未完成；副本保留，请检查迁移事务。'};
    }
    let restored=true;
    for(const p of [...entry.pairs].reverse())try {
      // Preserve partial copies as well; rollback never permanently deletes files.
      const failed=fs.mkdtempSync(path.join(path.dirname(p.target),'.dsh-reconfigure-failed-'));
      for(const n of p.copied)if(stat(path.join(p.target,n)))fs.renameSync(path.join(p.target,n),path.join(failed,n));
      for(const n of p.cleared)if(stat(path.join(p.quarantine,n)))fs.renameSync(path.join(p.quarantine,n),path.join(p.target,n));
    }catch{restored=false;}
    entry.phase=restored?'rolled-back':'rollback-required';entry.error=error.message;try{save(journal,entry);}catch{}
    throw Error('目录迁移失败；旧数据保留'+(restored?'，目标已恢复':'，目标恢复需检查事务')+'：'+error.message);
  } finally {fs.closeSync(fd);try{fs.unlinkSync(lock);}catch{}}
}
// Offload large copies/hashes so state/action requests never block the supervisor loop.
function run(method,input) {
  return new Promise((resolve,reject)=>{
    const worker=fork(__filename,[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});let response;
    worker.once('message',r=>{response=r;});
    worker.once('error',reject);
    worker.once('exit',(code,signal)=>{if(code===0&&response?.ok)resolve(response.result);else reject(Error(response?.error||'迁移工作进程异常退出；保留事务与旧数据（'+(signal||code)+'）'));});
    worker.send({method,input},error=>{if(error)reject(error);});
  });
}
if(require.main===module) {
  const parentPid=process.ppid;
  process.once('message',({method,input})=>{
    try {const result=method==='plan'?plan(input):apply({...input,commitGuard:()=>process.ppid===parentPid&&process.connected});process.send({ok:true,result},()=>process.disconnect());}
    catch(error){process.send({ok:false,error:error.message},()=>{process.exitCode=1;process.disconnect();});}
  });
}
module.exports={ITEMS,JOURNAL,plan,apply,run,blocked,targetHasData:p=>!!names(p).length,targetDataItems:names};
