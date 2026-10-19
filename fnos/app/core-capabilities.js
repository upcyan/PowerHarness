const {execFileSync}=require('node:child_process');const path=require('node:path');const fs=require('node:fs');
function fromHelp(help,adapter){
 const flags=new Set((String(help).match(/--[a-z][a-z0-9-]*/g)||[]));
 const required=[...new Set(adapter.args.filter(x=>typeof x==='string'&&x.startsWith('--')))];
 const missing=required.filter(x=>!flags.has(x));
 return {schema:1,status:missing.length?'incompatible':'compatible',observedFlags:[...flags].sort(),requiredFlags:required,missingFlags:missing,version:adapter.version,note:'参数能力检查不替代核心适配版本、健康检查和隔离启动验收。'};
}
function inspect(directory,adapter){
 const target=adapter.bin;if(path.resolve(target)!==target||!fs.statSync(target).isFile())throw new Error('Invalid core executable');
 const help=execFileSync(process.execPath,[target,'web','--help'],{timeout:15000,maxBuffer:1024*1024,encoding:'utf8',env:{PATH:process.env.PATH||'',HOME:process.env.HOME||'',LANG:'C.UTF-8'}});
 return fromHelp(help,adapter);
}
module.exports={fromHelp,inspect};
