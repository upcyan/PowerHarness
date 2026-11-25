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
  const existing=read();
  // 升级时保留用户已选的数据/备份目录与插件清单——但**必须继续走完检查流程**。
  // 早先这里直接 process.exit(0)，被 fnOS 当成「本次没有任何变化」，
  // 于是整次升级判为失败（弹窗「无法更新」）。保留配置不等于跳过安装。
  // 目录不再由安装向导指定。安装阶段唯一能拿到的授权信息是平台传下来的父目录
  // 列表，而「父目录在列表里」并不能证明目录真的可写 —— 早先正是它让安装期检查
  // 形同虚设（默认值一路过），真出问题还是等到首启才炸。既然装的时候验不了，
  // 就不要把未验证的字符串写进 install-options.json 冒充「已配置」：两个字段都没
  // 给、也没有既有配置时，这里什么都不写，把选目录推迟到首次启动的配置页
  // （supervisor 的 setup 模式）。那里能当场验证授权与读写探针，验不过不启动核心。
  // 既有配置（升级）与老版本带值的安装包，照旧走完整检查。
  if(!existing&&!env.wizard_data_dir&&!env.wizard_backup_dir){
   console.log('数据与备份目录将在首次启动时配置');
  }else{
  let index={plugins:[]};try{index=JSON.parse(fs.readFileSync(path.join(app,'plugins-bundled/bundled-plugins.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const configured=options.initialize(control,{dataDir:env.wizard_data_dir||options.defaults.dataDir,backupDir:env.wizard_backup_dir||options.defaults.backupDir,selectedPlugins:options.selection(index,env)});const user=identity();if(process.getuid()===0&&fs.existsSync(options.file(control)))fs.chownSync(options.file(control),user.uid,user.gid);
  const child=spawnSync(process.execPath,[__filename,'probe-as-app',String(user.uid),String(user.gid)],{env,encoding:'utf8',timeout:15000,maxBuffer:262144});
  if(child.error||child.status!==0){console.log('安装设置已保存，目录尚未满足应用账号授权：'+options.advice);console.log((child.stderr||'').slice(-2000));console.log('NOTICE_AUTH_PENDING');process.exitCode=2;}else console.log('数据与备份目录应用身份读写检查通过');
  }
 }
 else if(mode==='get-data')console.log(read()?.dataDir||legacy);
 else if(mode==='get-backup')console.log(read()?.backupDir||env.FNOS_BACKUP_DIR||'');
 else if(mode==='check')probe();
 else throw new Error('Unknown install options operation');
}catch(error){console.error(error.message);process.exitCode=1;}
