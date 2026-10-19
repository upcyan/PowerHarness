'use strict';
const fs=require('node:fs');const path=require('node:path');const {execFileSync,spawnSync}=require('node:child_process');const options=require('./install-options.js');
try{
 const env=process.env,legacy=env.TRIM_PKGVAR,app=env.TRIM_APPDEST||env.FNOS_APP_DIR,control=env.TRIM_PKGETC||legacy;
 if(!app||!legacy||!control)throw new Error('缺少fnOS平台迁移路径');
 if(process.getuid()===0){const name=env.TRIM_USERNAME||'dsh_fnos';if(!/^[a-z_][a-z0-9_-]*$/.test(name))throw new Error('应用账号无效');const account=execFileSync('getent',['passwd',name],{encoding:'utf8'}).trim().split(':');const uid=Number(account[2]),gid=Number(account[3]);if(!(uid>0&&gid>0))throw new Error('应用账号不可用');const code='process.setgroups([]);process.setgid('+gid+');process.setuid('+uid+');process.argv=[process.execPath,'+JSON.stringify(__filename)+',...process.argv.slice(1)];require('+JSON.stringify(__filename)+');';const r=spawnSync(process.execPath,['-e',code,...process.argv.slice(2)],{env,stdio:'inherit',timeout:300000});if(r.error||r.status===null)throw new Error('迁移子进程结果未知');process.exit(r.status);}
 const stored=options.read(control);if(!stored){console.log('无新存储设置，保留原数据目录');process.exit(0);}
 if(fs.realpathSync(legacy)===stored.dataDir){console.log('数据目录未变更');process.exit(0);}
 const result=require('./install-migration.js').migrate({legacy,target:stored.dataDir,backupDir:stored.backupDir,controlDir:control,env,appDir:app,preserveExisting:process.argv.includes('--preserve-existing')});
 console.log(JSON.stringify(result));
}catch(error){console.error('数据迁移未完成：'+error.message);process.exitCode=1;}
