const fs=require('node:fs');const path=require('node:path');const {createRequire}=require('node:module');const {pathToFileURL}=require('node:url');
const SAFE_ID=/^[a-zA-Z0-9_@./:-]{1,180}$/;
function safe(value){return typeof value==='string'&&SAFE_ID.test(value)?value:'[invalid identifier]';}
function rows(input,output=[]){for(const row of Array.isArray(input)?input:[]){if(!row||typeof row!=='object')continue;if(Array.isArray(row.insert)){rows(row.insert,output);continue;}if(row.disabled===true)continue;output.push(row);if(row.name==='cordis:group')rows(row.config,output);if(row.name==='@deepseek-ai/dsh-agent-preset')rows(row.config?.plugins,output);}return output;}
function entryPresent(name,profileDir,runtimeDir){
 const resolver=createRequire(path.join(profileDir,'package.json'));
 try{resolver.resolve(name,{paths:[profileDir,path.join(runtimeDir,'runtime')]});return true;}catch{}
 const parts=name.split('/'),count=name.startsWith('@')?2:1;const pkg=parts.slice(0,count).join('/'),sub=parts.length>count?'./'+parts.slice(count).join('/') : '.';
 for(const root of [path.join(profileDir,'node_modules'),path.join(runtimeDir,'runtime/node_modules')])try{
  const dir=path.join(root,pkg),meta=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));let entry=meta.exports;
  if(entry&&typeof entry==='object'&&Object.keys(entry).some(x=>x.startsWith('.')))entry=entry[sub];
  while(entry&&typeof entry==='object'&&!Array.isArray(entry))entry=entry.import||entry.node||entry.default;
  if(typeof entry!=='string')entry=sub==='.'?meta.main:undefined;
  if(typeof entry==='string'&&entry.startsWith('./')&&!entry.split('/').includes('..')&&fs.statSync(path.join(dir,entry)).isFile())return true;
 }catch{}
 return false;
}
function references(value,result=new Set()){if(!value||typeof value!=='object')return result;for(const [key,item] of Object.entries(value)){if(key.endsWith('Ref')&&typeof item==='string')result.add(item);else if(item&&typeof item==='object')references(item,result);}return result;}
function summarize({configuredPresets,sessionRefs,plugins,credentials,issues=[],sessionsChecked=0,complete=true}){
 const missingPresets=[...new Set(sessionRefs.map(x=>x.preset).filter(x=>!configuredPresets.has(x)))].map(safe);
 const missingPlugins=plugins.filter(x=>!x.present).map(x=>safe(x.name));
 const missingCredentials=credentials.filter(x=>!x.present).map(x=>safe(x.name));
 return {schema:1,checkedAt:new Date().toISOString(),status:!complete?'unknown':missingPresets.length||missingPlugins.length||missingCredentials.length||issues.length?'incomplete':'references-ok',functionalRestore:'not-tested',complete,sessionsChecked,configuredPresetCount:configuredPresets.size,missingPresets,missingPlugins,missingCredentials,issues:issues.map(x=>({code:safe(x.code),subject:safe(x.subject||'')})),note:'引用完整不等于会话可续聊；需实际恢复和运行验证。不返回凭据明文。'};
}
async function loadSessions(home,runtime){
 const cordis=await import(pathToFileURL(path.join(runtime,'node_modules/@deepseek-ai/cordis/lib/index.js')).href);
 const module=await import(pathToFileURL(path.join(runtime,'node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')).href);
 const ctx=new cordis.Context();const backend=new module.default(ctx,{root:path.join(home,'sessions'),compression:'zstd'});const output=[];
 try{const listing=await backend.list();for(const entry of listing.slice(0,1000)){let handle;try{handle=await backend.open(entry.header.id,'read');const log=await handle.read();let preset=entry.header.agentPreset;for(const event of log.events)if(event.type==='agent-preset/selected'&&typeof event.data?.agentPreset==='string')preset=event.data.agentPreset;output.push({id:entry.header.id,preset});}catch{output.push({id:entry.header.id,error:true});}finally{if(handle)await handle.close();}}return {output,complete:listing.length<=1000};}finally{await ctx.fiber.dispose();}
}
async function inspect(dataDir,runtimeDir,profile,{readSessions=loadSessions}={}){
 const home=path.join(dataDir,'dsh-home'),profileDir=path.join(home,'profiles',profile);const requireRuntime=createRequire(path.join(runtimeDir,'runtime','package.json'));const yaml=requireRuntime('yaml');const issues=[];
 let manifest,document;
 try{manifest=JSON.parse(fs.readFileSync(path.join(profileDir,'package.json'),'utf8'));const doc=yaml.parseDocument(fs.readFileSync(path.join(profileDir,'cordis.patch.yml'),'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:x=>x}]});if(doc.errors.length)throw new Error('invalid');document=doc.toJS();if(!Array.isArray(document))throw new Error('not array');}catch{return summarize({configuredPresets:new Set(),sessionRefs:[],plugins:[],credentials:[],complete:false,issues:[{code:'profile-unreadable'}]});}
 const configuredPresets=new Set(['standard','ptc','minimal','cordis']);const allRows=rows(document);
 for(const row of allRows)if(row.name==='@deepseek-ai/dsh-agent-preset'&&typeof row.config?.id==='string')configuredPresets.add(row.config.id);
 const pluginNames=new Set([...(manifest.dsh?.profile?.bundles||[]),...allRows.map(x=>x.name).filter(x=>typeof x==='string'&&!x.startsWith('cordis:'))]);
 const plugins=[...pluginNames].map(name=>({name,present:entryPresent(name,profileDir,runtimeDir)}));
 const refs=references(document),available=new Set();let credentialKnown=true;const file=path.join(home,'.credentials.yaml');
 try{const mode=fs.statSync(file).mode;if(mode&0o077)throw new Error('not private');const doc=yaml.parse(fs.readFileSync(file,'utf8'));if(doc?.version!==1||!doc.refs||typeof doc.refs!=='object')throw new Error('unrecognized');for(const [name,value] of Object.entries(doc.refs))if(typeof value==='string'&&value.length)available.add(name);}catch(error){if(error.code!=='ENOENT'){credentialKnown=false;issues.push({code:'credentials-unreadable-or-unrecognized'});}}
 const credentials=[...refs].map(name=>({name,present:available.has(name)||(typeof process.env[name]==='string'&&!!process.env[name])}));let sessions={output:[],complete:false};
 try{sessions=await readSessions(home,path.join(runtimeDir,'runtime'));}catch{issues.push({code:'session-inventory-unreadable'});}
 for(const session of sessions.output)if(session.error)issues.push({code:'session-read-failed',subject:session.id});
 return summarize({configuredPresets,sessionRefs:sessions.output.filter(x=>!x.error),plugins,credentials,issues,sessionsChecked:sessions.output.length,complete:sessions.complete&&credentialKnown});
}
module.exports={rows,references,summarize,inspect,loadSessions,entryPresent};
