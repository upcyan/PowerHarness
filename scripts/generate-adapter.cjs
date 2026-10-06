'use strict';
const fs=require('node:fs'),path=require('node:path');
const cores=require('../fnos/app/core-manager');
function generateAdapter(appDirectory,expectedVersion) {
 const directory=fs.realpathSync(appDirectory),target=path.join(directory,'adapter.json');
 if(['/vol1/@appcenter','/vol1/@appdata','/var/apps','/opt/dsh'].some(root=>directory===root||directory.startsWith(root+'/')))throw new Error('Refuse generating adapter in live application/data paths');
 const metadata=JSON.parse(fs.readFileSync(path.join(directory,'runtime/node_modules/@deepseek-ai/dsh/package.json'),'utf8'));
 if(typeof expectedVersion!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(expectedVersion)||metadata.version!==expectedVersion)throw new Error('Build core version does not match the pinned dependency');
 const payload={contract:1,version:metadata.version,bin:'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',args:['web','--no-open','--host','{{host}}','--port','{{port}}'],readyPrefix:'dsh web:'};
 if(!fs.existsSync(path.join(directory,payload.bin)))throw new Error('Staged core executable is missing');
 const pending=target+'.build-pending';
 if(path.resolve(pending)!==path.join(directory,'adapter.json.build-pending'))throw new Error('Unsafe adapter target');
 fs.writeFileSync(pending,JSON.stringify(payload,null,2)+'\n',{mode:0o600,flag:'wx'});
 fs.renameSync(pending,target);
 const validated=cores.adapterFor(directory);
 if(validated.version!==expectedVersion||!fs.existsSync(validated.bin))throw new Error('Generated adapter executable/version validation failed');
 return payload;
}
if(require.main===module){
 const app=process.argv[2];if(!app)throw new Error('Staged application directory is required');
 const expected=JSON.parse(fs.readFileSync(path.join(__dirname,'../package.json'),'utf8')).dependencies['@deepseek-ai/dsh'];
 console.log('Generated and validated bundled adapter:',generateAdapter(app,expected).version);
}
module.exports={generateAdapter};
