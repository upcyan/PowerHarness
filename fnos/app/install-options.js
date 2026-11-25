'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const defaults={dataDir:'/vol1/1000/DSH-Data/dsh-fnos',backupDir:'/vol1/1000/DSH-Recovery/dsh-fnos'};
// App name is instance-specific (this code ships into both dsh-fnos and
// derived builds); app-name.js resolves it from the packaged ui/config.
const appName=require('./app-name.js').appName();const advice='请到 fnOS 应用中心 → '+appName+' → 访问权限，授权所选数据目录与备份目录的父目录读写权限，然后重新启动应用。不会自动改ACL或使用其它目录。';
// 属主不对时的提示：授权解决不了 —— chmod 只有属主能做，得换一个本应用账号
// 拥有（或能新建）的目录。
const ownershipAdvice='该目录的属主不是应用账号，本应用无法修改它的权限（chmod 只有属主或管理员能做），启动必定失败。请改选一个由本应用账号拥有、或能新建出来的目录（例如应用账号自己的存储空间下的新目录）。';
const within=(a,b)=>b===a||b.startsWith(a+path.sep);
function directory(value){if(typeof value!=='string'||!value.startsWith('/')||value.length>1024||value.includes(String.fromCharCode(0))||value.includes(':')||value.includes(String.fromCharCode(10))||value.includes(String.fromCharCode(13)))throw new Error('目录必须为NAS绝对路径');const resolved=path.resolve(value);if(resolved==='/'||['/tmp','/run','/opt','/var','/etc','/proc','/sys','/dev'].some(x=>within(x,resolved))||resolved.split('/').some(x=>x.startsWith('@app')))throw new Error('请选择稳定的NAS用户存储目录，不能使用应用私有或临时系统路径');for(let current=resolved;current!==path.dirname(current);current=path.dirname(current)){const stat=fs.lstatSync(current,{throwIfNoEntry:false});if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()))throw new Error('所选目录或祖先不是普通目录，拒绝软链路径');}return resolved;}
function validate(input,env=process.env){const dataDir=directory(input.dataDir,env),backupDir=directory(input.backupDir,env);if(within(dataDir,backupDir)||within(backupDir,dataDir))throw new Error('数据目录与备份目录必须独立，不能相同或互相包含');if(!Array.isArray(input.selectedPlugins)||input.selectedPlugins.some(x=>typeof x!=='string'))throw new Error('插件选择清单无效');return {schema:1,dataDir,backupDir,selectedPlugins:[...new Set(input.selectedPlugins)]};}
function file(controlDir){return path.join(controlDir,'install-options.json');}
function read(controlDir,env=process.env){try{const options=JSON.parse(fs.readFileSync(file(controlDir),'utf8'));if(options.schema!==1)throw new Error('不支持存储设置版本');return validate(options,env);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function grants(env){return [...new Set([env.TRIM_DATA_ACCESSIBLE_PATHS||'',env.TRIM_DATA_SHARE_PATHS||''].join(':').split(':').filter(x=>x.startsWith('/')).map(x=>path.resolve(x)))];}
/**
 * 判定「数据目录 / 备份目录现在能不能真的读写」。
 *
 * 为什么不能只查父目录授权：fnOS 传下来的 TRIM_DATA_ACCESSIBLE_PATHS 是**父目录**
 * （实测 /vol1/1000/deepseek_harness:/vol1/1000/DSH-Recovery:/vol1/1000/DSH-Data），
 * 于是「只勾了 DSH-Data」也会因为父目录 /vol1/1000 在列表里而让备份目录一并过关。
 * 授权列表证明不了目录可写，只有真写一次才能证明。
 *
 * create=true（安装阶段）：目录不存在就建，并落数据身份标记。
 * create=false（启动门禁）：目录必须已存在；不建、不写标记，只做读写探针。
 * 两种情况都**无条件**对两个目录各跑一次探针 —— 这是这道检查的意义所在。
 */
function check(options,env=process.env,{create=false}={}){
  const validated=validate(options,env);
  const issues=[];
  for(const [kind,target] of [["data",validated.dataDir],["backup",validated.backupDir]]){
    const exists=fs.existsSync(target);
    // 1) 只认真实结果，不再拿 TRIM_DATA_ACCESSIBLE_PATHS 当判据。
    //    env 里那份授权列表是**进程启动那一刻的快照**：用户在应用中心勾完目录
    //    之后，正在运行的进程 env 不会更新，只有平台重新拉起进程才会。所以任何
    //    「用 env 判授权」的检查，在授权刚改完时必然还判旧账 —— 配置页的「保存
    //    并验证授权」于是永远失败，出路只剩「应用中心停用再启用」把进程换掉
    //    （2026-11-17 实测：主实例每次启动都因这份旧快照进 setup，页面按钮点了
    //    没有任何效果）。
    //    而且这份列表本身也不精确：它给的是**父目录**，父目录在表里不代表子目录
    //    可写，父目录不在表里也不代表子目录不可写（见上面「为什么不能只查父目录
    //    授权」）。真正的判据只有一条：现在以本应用身份，能不能在这里建目录、
    //    写文件、读回来。
    //    安全性不因此放宽：真要新建目录时，mkdir 在没被授权的位置会 EACCES
    //    （下面 catch 里统一映射成 not-authorized），本应用从不自行改 ACL。
    try{
      if(!exists&&!create){
        issues.push({kind,path:target,code:"missing",message:advice});
        continue;
      }
      if(create){
        // 已存在且有内容、却没有我们的身份标记 -> 不是我们的目录，拒绝接管。
        if(kind==="data"&&exists&&fs.readdirSync(target).length&&!fs.existsSync(path.join(target,'.dsh-fnos-data.json')))throw new Error("Existing unowned data");
        fs.mkdirSync(target,{recursive:true,mode:0o700});
        directory(target);
        if(kind==="data"){
          const marker=path.join(target,'.dsh-fnos-data.json');
          if(!fs.existsSync(marker))fs.writeFileSync(marker,JSON.stringify({app:"dsh-fnos",schema:1}),{flag:"wx",mode:0o600});
          else if(JSON.parse(fs.readFileSync(marker,"utf8")).app!=="dsh-fnos")throw new Error("Invalid data identity");
        }
      }
      // 探针：建临时目录 -> 写 -> 读回 -> 删。任何一步失败都算不可写。
      const probe=fs.mkdtempSync(path.join(target,".dsh-permission-"));
      try{
        const probeFile=path.join(probe,"probe");
        fs.writeFileSync(probeFile,"ok",{flag:"wx",mode:0o600});
        if(fs.readFileSync(probeFile,"utf8")!=="ok")throw new Error("readback");
      }finally{
        fs.rmSync(probe,{recursive:true,force:true});
      }
      // ⚠ **属主判定**：能写 ≠ 能改权限。
      // cmd/main 启动时会对数据目录执行 `chmod 700 "$DATA_DIR"`，而 POSIX 规定
      // chmod 只有属主或 root 能做。目录属主是别人（如 unas）时，读写探针照样
      // 全过（other 位有 r-x、目录本身又被共享 ACL 放宽），但启动脚本的 chmod
      // 必然 EPERM ⇒ `mkdir && chmod || exit 1` 直接把应用打死，用户只看到
      // 「本地应用启动失败」（2026-11-16 实测：/vol1/1000/DSH/DSH-Data/dsh-fnos
      // 属主 unas，探针通过但 chmod 失败）。
      // 所以这里必须单独验「当前身份能否 chmod 该目录」。
      const ownerUid=fs.lstatSync(target).uid;
      const currentUid=typeof process.getuid==='function'?process.getuid():null;
      if(currentUid!==null&&ownerUid!==currentUid&&currentUid!==0){
        issues.push({kind,path:target,code:"not-owned",message:ownershipAdvice});
        continue;
      }
    }catch(error){
      // 权限类失败说清楚是「没授权」，别让用户以为目录坏了：
      // 真正的授权判据就是这一步 syscall 的结果（EACCES/EPERM = 平台没把这个
      // 目录开放给应用账号），和 env 里那份启动快照无关。
      const denied=error&&(error.code==='EACCES'||error.code==='EPERM');
      issues.push({kind,path:target,code:denied?"not-authorized":"not-writable",message:advice,detail:(error&&error.code)||String(error)});
    }
  }
  return {ok:issues.length===0,issues};
}

// ── 备份目录物理位置提示（2026-11-25）────────────────────────────────────────
//
// 「数据目录与备份目录必须独立」这条约束只在**逻辑**上防止了误删/回滚互害，
// 它不保证两者落在不同物理介质上。实测本机：
//   /vol1/1000/DSH-Data/dsh-fnos      dev=41
//   /vol1/1000/DSH-Recovery/dsh-fnos  dev=42
// 两个不同的 dev，但都在同一块 ZFS 池上 —— 整盘故障会同时带走数据与备份。
//
// 另外，跨 dev 还让升级前冷备的硬链接加速彻底失效（fs.linkSync 必然 EXDEV，
// 退化为 copyFileSync）：2026-11-24 升级 115 时 62GB 实打实复制了 32 分钟，
// 而同一 dev 内本可以是秒级。
//
// 这里只**提示**，不阻断：把备份放到另一块盘需要用户另有可用介质，属于环境
// 条件而非错误，强制会让人无法完成安装。
function sameDevice(a, b) {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    // 任一路径还不存在（安装阶段尚未创建）就无从判断，按「未知」返回 null，
    // 调用方不提示，避免对着一个还没建的目录报磁盘建议。
    return null;
  }
}

// ── 结束备份目录物理位置提示 ────────────────────────────────────────────────
function selection(index,env){const entries=Array.isArray(index?.plugins)?index.plugins:[];return entries.filter(entry=>env['wizard_plugin_'+crypto.createHash('sha256').update(entry.name).digest('hex').slice(0,12)]==='true').map(entry=>entry.name);}
function initialize(controlDir,input,env=process.env){fs.mkdirSync(controlDir,{recursive:true,mode:0o700});const record=validate(input,env);const existing=read(controlDir,env);if(existing)return {created:false,options:existing};const filename=file(controlDir),lock=filename+'.lock';const fd=fs.openSync(lock,'wx',0o600);try{if(fs.existsSync(filename))return {created:false,options:read(controlDir)};const temp=filename+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';try{const out=fs.openSync(temp,'wx',0o600);try{fs.fchmodSync(out,0o600);fs.writeFileSync(out,JSON.stringify(record,null,2)+String.fromCharCode(10));fs.fsyncSync(out);}finally{fs.closeSync(out);}fs.renameSync(temp,filename);const dir=fs.openSync(controlDir,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}return {created:true,options:record};}finally{fs.closeSync(fd);fs.unlinkSync(lock);}}
function resolve(controlDir,legacy,env=process.env,{create=false}={}){const options=read(controlDir,env);if(!options)return {dataDir:legacy,backupDir:null,legacy:true};const status=check(options,env,{create});if(!status.ok)throw new Error(status.issues.map(x=>x.path+'：'+x.message).join(String.fromCharCode(10)));return {...options,legacy:false};}
// 配置页保存用。initialize 是「已存在就不动」的安装期语义（幂等），配置页允许改，
// 所以这里单独给一个可覆盖的原子写：tmp(fsync) -> rename -> 目录 fsync。
// 断电只留下 .tmp，不会留下半个 JSON 让下次启动判成损坏进 safe mode。
function write(controlDir,input,env=process.env){fs.mkdirSync(controlDir,{recursive:true,mode:0o700});const record=validate(input,env);const filename=file(controlDir);const temp=filename+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';const fd=fs.openSync(temp,'wx',0o600);try{fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,JSON.stringify(record,null,2)+String.fromCharCode(10));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,filename);const dir=fs.openSync(controlDir,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}return record;}
module.exports={defaults,advice,directory,validate,read,check,grants,selection,initialize,resolve,write,file,sameDevice};