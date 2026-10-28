'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const options = require('./install-options.js');
const owner = require('./port-owner.js');
const ITEMS = ['dsh-home','workspace','patch-backups','startup-reports','pnpm-store','pnpm-home','corepack-home','npm-cache','tls.crt','tls.key','gateway-sessions.json','authorized-links.json','desired-exemptions.json','plugin-url-paths.json','restore-integrity.json','saved-sessions.json','exemptions.json','port-settings.json','profile-selection.json','automatic-backup-policy.json'];
const MARKER = '.dsh-fnos-migration-receipt.json';
const within = (a,b) => b === a || b.startsWith(a + path.sep);
const stat = p => fs.lstatSync(p,{throwIfNoEntry:false});
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function ordinary(p){const s=stat(p);if(!s||!s.isDirectory()||s.isSymbolicLink())throw new Error('迁移目录不是普通目录');return fs.realpathSync(p);}
function trustedSource(legacy,env){if(!env.TRIM_PKGVAR||!path.isAbsolute(env.TRIM_PKGVAR))throw new Error('缺少平台旧数据路径');const source=ordinary(legacy),expected=ordinary(env.TRIM_PKGVAR);if(source!==expected)throw new Error('迁移源不等于平台TRIM_PKGVAR');return source;}
function hasRealData(root){return ITEMS.some(n=>{const s=stat(path.join(root,n));return s&&(s.isFile()||(s.isDirectory()&&fs.readdirSync(path.join(root,n)).length));});}
function cold(roots,app){for(const root of roots){if(owner.ownedProcesses(root,app).length)throw new Error('应用仍在运行，拒绝迁移');const home=path.join(root,'dsh-home');if(stat(home)){const scan=p=>{for(const ent of fs.readdirSync(p,{withFileTypes:true})){const child=path.join(p,ent.name);if(ent.isDirectory())scan(child);else if(ent.name.endsWith('.lock')||ent.name.endsWith('.writing'))throw new Error('旧数据存在写锁，拒绝迁移');}};scan(home);}}}
function authorised(record,env){const status=options.check(record,env,{create:false});if(!status.ok)throw new Error(status.issues.map(x=>x.message).join('; '));const parent=path.dirname(record.dataDir);if(!options.grants(env).some(r=>within(r,parent)))throw new Error('原子迁移需授权数据目录父目录读写');fs.accessSync(parent,fs.constants.R_OK|fs.constants.W_OK|fs.constants.X_OK);}
function inventory(root){const out={};const walk=(p,rel)=>{const s=stat(p);if(!s)return;if(s.isSymbolicLink()){out[rel]={type:'link',link:fs.readlinkSync(p)};}else if(s.isDirectory()){out[rel]={type:'dir'};for(const n of fs.readdirSync(p).sort())walk(path.join(p,n),rel?rel+'/'+n:n);}else if(s.isFile()){out[rel]={type:'file',hash:hash(p),mode:s.mode&0o111};}else throw new Error('拒绝迁移特殊文件');};walk(root,'');return out;}
function fingerprint(root){return JSON.stringify(inventory(root));}
function linkTarget(src,legacy,target){const link=fs.readlinkSync(src),absolute=path.resolve(path.dirname(src),link);return within(legacy,absolute)?path.join(target,path.relative(legacy,absolute)):fs.realpathSync(absolute);}
function copy(src,dst,legacy,target){const s=stat(src);if(!s)return;const existing=stat(dst);if(s.isDirectory()){if(existing&&!existing.isDirectory())throw new Error('迁移类型冲突');if(!existing)fs.mkdirSync(dst,{mode:0o700});for(const n of fs.readdirSync(src))copy(path.join(src,n),path.join(dst,n),legacy,target);}else if(s.isSymbolicLink()){if(existing){if(existing.isDirectory())throw new Error('迁移类型冲突');fs.unlinkSync(dst);}fs.symlinkSync(linkTarget(src,legacy,target),dst);}else if(s.isFile()){if(existing&&existing.isDirectory())throw new Error('迁移类型冲突');if(existing?.isSymbolicLink())fs.unlinkSync(dst);fs.copyFileSync(src,dst);fs.chmodSync(dst,0o600|(s.mode&0o111));}else throw new Error('拒绝迁移特殊文件');}
function verify(src,dst,legacy,target){const s=stat(src),d=stat(dst);if(!d)throw new Error('迁移校验缺文件');if(s.isDirectory()){if(!d.isDirectory())throw new Error('迁移校验类型冲突');for(const n of fs.readdirSync(src))verify(path.join(src,n),path.join(dst,n),legacy,target);}else if(s.isSymbolicLink()){if(!d.isSymbolicLink()||fs.readlinkSync(dst)!==linkTarget(src,legacy,target))throw new Error('迁移链接校验失败');}else if(!d.isFile()||hash(src)!==hash(dst)||(d.mode&0o111)!==(s.mode&0o111))throw new Error('迁移字节或执行位校验失败');}
function save(file,record){const temp=file+'.'+crypto.randomUUID()+'.tmp';const fd=fs.openSync(temp,'wx',0o600);try{fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,JSON.stringify(record,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
function backupNew(target,backupDir){fs.mkdirSync(backupDir,{recursive:true,mode:0o700});const folder=fs.mkdtempSync(path.join(backupDir,'pre-migration-new-'));fs.chmodSync(folder,0o700);const archive=path.join(folder,'skeleton-'+Date.now()+'-'+crypto.randomUUID()+'.tgz');const fd=fs.openSync(archive,'wx',0o600);fs.fchmodSync(fd,0o600);fs.closeSync(fd);for(const args of [['-czf',archive,'-C',target,'.'],['-tzf',archive]]){const p=spawnSync('tar',args,{encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});if(p.error||p.status!==0)throw new Error('迁移回滚备份失败');}return {archive,sha256:hash(archive)};}
function migrate({legacy,target,backupDir,controlDir,env=process.env,appDir=__dirname,preserveExisting=false}){
 const source=trustedSource(legacy,env),dest=options.directory(target),backup=options.directory(backupDir);if(source===dest)return {migrated:false,reason:'same-directory'};
 if(within(source,dest)||within(dest,source)||within(source,backup)||within(backup,source)||within(dest,backup)||within(backup,dest))throw new Error('迁移源、目标、备份必须独立');
 ordinary(controlDir);const journal=path.join(controlDir,'migration-transaction.json'),lock=path.join(controlDir,'migration-transaction.lock');
 const state=stat(journal)?JSON.parse(fs.readFileSync(journal,'utf8')):null;
 if(state&&state.phase!=='completed'&&state.phase!=='rolled-back')throw new Error('存在未完成迁移事务，保留现场，不自动重试');
 if(state?.phase==='completed'&&state.source===source&&state.target===dest&&stat(path.join(dest,MARKER)))return {migrated:false,reason:'already-migrated'};
 if(!hasRealData(source))return {migrated:false,reason:'no-legacy-data'};
 // Existing configured data is authoritative. This is a read-only no-op, not
 // a migration: do not demand parent rename grants or scan stale legacy locks.
 // Trust, path independence and unresolved transaction guards above still apply.
 if(preserveExisting&&stat(dest)&&hasRealData(dest))return {migrated:false,reason:'configured-target-preserved'};
 const record={dataDir:dest,backupDir:backup,selectedPlugins:[]};authorised(record,env);cold([source,dest],appDir);
 if(stat(dest)&&hasRealData(dest)){if(preserveExisting)return {migrated:false,reason:'configured-target-preserved'};throw new Error('目标已使用，拒绝覆盖');}
 const fd=fs.openSync(lock,'wx',0o600);fs.fchmodSync(fd,0o600);let stage=null,previous=null,moved=false,committed=false,confirmed=false,entry=null;
 try{
  const targetExisted=!!stat(dest);if(targetExisted)ordinary(dest);else fs.mkdirSync(dest,{mode:0o700});
  const sourceBefore=fingerprint(source),targetBefore=fingerprint(dest),receipt=backupNew(dest,backup);
  stage=fs.mkdtempSync(path.join(path.dirname(dest),'.dsh-migration-stage-'));fs.chmodSync(stage,0o700);previous=stage+'-original';
  entry={schema:1,id:crypto.randomUUID(),source,target:dest,stage,previous,backup:receipt,targetExisted,phase:'prepared'};save(journal,entry);
  copy(dest,stage,dest,dest);for(const name of ITEMS){const src=path.join(source,name);if(stat(src))copy(src,path.join(stage,name),source,dest);}
  for(const name of ITEMS){const src=path.join(source,name);if(stat(src))verify(src,path.join(stage,name),source,dest);}
  if(fingerprint(source)!==sourceBefore||fingerprint(dest)!==targetBefore)throw new Error('迁移期间目录变化，拒绝提交');cold([source,dest],appDir);
  save(path.join(stage,MARKER),{schema:1,id:entry.id,source,target:dest,backup:receipt});
  entry.phase='committing';save(journal,entry);fs.renameSync(dest,previous);moved=true;fs.renameSync(stage,dest);committed=true;stage=null;
  entry.phase='completed';save(journal,entry);confirmed=true;return {migrated:true,backup:receipt.archive,previous,receipt:path.join(dest,MARKER)};
 }catch(error){
  if(committed){throw new Error('迁移已提交但回执未确认，禁止自动重试：'+error.message);}
  if(moved){try{if(stat(dest))throw new Error('目标身份未知');fs.renameSync(previous,dest);moved=false;}catch{throw new Error('迁移恢复状态未确认，保留事务与锁，禁止重试');}}
  if(entry){entry.phase='rolled-back';entry.error=error.message;save(journal,entry);}
  if(stage){ordinary(stage);if(path.dirname(stage)!==path.dirname(dest)||!path.basename(stage).startsWith('.dsh-migration-stage-'))throw new Error('拒绝不安全暂存清理');fs.rmSync(stage,{recursive:true});stage=null;}
  throw error;
 }finally{fs.closeSync(fd);if((!moved&&!committed)||confirmed)fs.unlinkSync(lock);}
}
module.exports={migrate,backupNew,hasRealData,trustedSource,inventory,MARKER};
