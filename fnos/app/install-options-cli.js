const fs=require('node:fs'),path=require('node:path'),{spawnSync,execFileSync}=require('node:child_process');const options=require('./install-options.js');
const env=process.env,control=env.TRIM_PKGETC||env.TRIM_PKGVAR,legacy=env.TRIM_PKGVAR,app=env.TRIM_APPDEST||env.FNOS_APP_DIR;
if(!control||!legacy||!app)throw new Error('Missing fnOS installation paths');
function read(){return options.read(control);}
function probe(){const stored=read();if(!stored)return;const status=options.check(stored,env,{create:true});if(!status.ok)throw new Error(status.issues.map(x=>x.path+'：'+x.message).join(String.fromCharCode(10)));}
function identity(){if(process.getuid()!==0)return {uid:process.getuid(),gid:process.getgid()};const name=env.TRIM_USERNAME||'dsh_fnos';if(!/^[a-z_][a-z0-9_-]*$/.test(name))throw new Error('Invalid application identity');const record=execFileSync('getent',['passwd',name],{encoding:'utf8'}).trim().split(':');const uid=Number(record[2]),gid=Number(record[3]);if(!(uid>0&&gid>0))throw new Error('Application identity unavailable');return {uid,gid};}
try{
 const mode=process.argv[2];
 if(mode==='probe-as-app'){if(process.getuid()===0){const uid=Number(process.argv[3]),gid=Number(process.argv[4]);if(!(uid>0&&gid>0))throw new Error('Invalid app identity');process.setgroups([]);process.setgid(gid);process.setuid(uid);}probe();}
 else if(mode==='init'){
  const existing=read();if(existing){console.log('已有安装设置保持不变');process.exit(0);}
  let index={plugins:[]};try{index=JSON.parse(fs.readFileSync(path.join(app,'plugins-bundled/bundled-plugins.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const configured=options.initialize(control,{dataDir:env.wizard_data_dir||options.defaults.dataDir,backupDir:env.wizard_backup_dir||options.defaults.backupDir,selectedPlugins:options.selection(index,env)});const user=identity();if(process.getuid()===0)fs.chownSync(options.file(control),user.uid,user.gid);
  const child=spawnSync(process.execPath,[__filename,'probe-as-app',String(user.uid),String(user.gid)],{env,encoding:'utf8',timeout:15000,maxBuffer:262144});
  if(child.error||child.status!==0){console.log('安装设置已保存，目录尚未满足应用账号授权：'+options.advice);console.log((child.stderr||'').slice(-2000));}else console.log('数据与备份目录应用身份读写检查通过');
 }
 else if(mode==='get-data')console.log(read()?.dataDir||legacy);
 else if(mode==='get-backup')console.log(read()?.backupDir||env.FNOS_BACKUP_DIR||'');
 else if(mode==='check')probe();
 else throw new Error('Unknown install options operation');
}catch(error){console.error(error.message);process.exitCode=1;}
