const fs=require('node:fs');const path=require('node:path');const ops=require('./ops.js');const store=require('./backup-store.js');
function policy(env){
 // Missing, malformed or ambiguous fields NEVER request deletion.
 const deletion=env.wizard_keep_data==='false'&&env.wizard_delete_confirmation==='DELETE DSH DATA';
 return {keep:!deletion,explicitDeletion:deletion};
}
function preserve(dataDir,configDir,version,env=process.env){
 const selected=policy(env);
 if(selected.explicitDeletion)return {schema:1,mode:'explicit-framework-delete',keep:false,externalBackupsDeleted:false};
 const root=store.root(dataDir);fs.mkdirSync(root,{recursive:true,mode:0o700});const realRoot=fs.realpathSync(root);
 const live=fs.realpathSync(dataDir);
 if(realRoot===live||realRoot.startsWith(live+path.sep))throw new Error('卸载保全必须位于应用私有数据之外');
 const snapshot=ops.createSnapshot(dataDir,configDir,'uninstall',version);
 const location=store.locate(dataDir,snapshot.id);
 const meta=ops.readJson(path.join(location,'meta.json'));
 if(meta.fingerprint!==ops.snapshotFingerprint(location,configDir)||meta.fingerprint!==ops.snapshotFingerprint(dataDir,configDir))throw new Error('卸载保全校验失败，拒绝继续');
 for(const control of meta.controlFiles||[]){const bytes=fs.readFileSync(path.join(location,'control-evidence',control.name));if(require('node:crypto').createHash('sha256').update(bytes).digest('hex')!==control.sha256)throw new Error('卸载控制配置保全失败');}
 const receipt={schema:1,mode:'independent-preservation',keep:true,snapshotId:snapshot.id,storageRoot:root,verified:true,at:new Date().toISOString(),externalBackupsDeleted:false};
 ops.writeJson(path.join(root,'uninstall-preservation.json'),receipt);return receipt;
}
if(require.main===module){const {FNOS_DATA_DIR:data,FNOS_CONFIG_DIR:config,FNOS_APP_DIR:app}=process.env;if(!data||!app)throw new Error('Missing fnOS retention paths');console.log(JSON.stringify(preserve(data,config,ops.dshVersion(app))));}
module.exports={policy,preserve};
