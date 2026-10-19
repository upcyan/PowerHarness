#!/usr/bin/env python3
"""Existing DSH hotfix only. Default is read-only preflight; NEVER reinstall.
Confirmation arguments are an operator interlock, not proof of user permission.
A fresh user authorization is still required before --execute.
"""
import argparse,hashlib,json,os,pwd,re,socket,subprocess,time,uuid
from pathlib import Path
from deployment_safety import Deployment,Journal,SafetyError,UnknownState,FILES,platform_command,require,sha256,validate_plan,ordinary_directory,ordinary_file
APP=Path('/vol1/@appcenter/dsh-fnos');DATA=None;RECOVERY=Path('/vol1/1000/DSH-Recovery/dsh-fnos')
NODE='/vol1/@appcenter/nodejs_v24/bin/node';CONFIG='/vol1/@appconf/dsh-fnos'

class Backend:
    def __init__(self,payload,plan):
        self.payload,self.plan=payload,plan;self.account=pwd.getpwnam('dsh_fnos');self.initial=[];self.old_boot=None
    @property
    def backup_root(self):
        operation=self.plan.get('operationId')
        require(operation is not None and str(uuid.UUID(operation))==operation,'Backup requires a canonical operation id')
        return RECOVERY/'.safe-deploy-backups'/operation
    def validate_active_data(self):
        owners=self.owners()
        require(all(sum(x['role']==role for x in owners)==1 for role in ['core','supervisor','gateway']), 'Configured data directory must identify exactly one live application generation')
        for owner in owners:
            if owner['role'] not in ['supervisor','gateway']:continue
            raw=Path('/proc')/str(owner['pid'])/'environ'
            env=dict(item.split(b'=',1) for item in raw.read_bytes().split(b'\0') if b'=' in item)
            require(env.get(b'FNOS_DATA_DIR')==os.fsencode(DATA), 'Live owner data directory differs from the reviewed data directory')
    def drop(self):
        os.initgroups(self.account.pw_name,self.account.pw_gid);os.setgid(self.account.pw_gid);os.setuid(self.account.pw_uid)
    def node(self,code,*args):
        env=os.environ.copy()
        env.update(FNOS_DATA_DIR=str(DATA),FNOS_APP_DIR=str(APP),FNOS_CONFIG_DIR=CONFIG,FNOS_BACKUP_DIR=str(self.backup_root) if self.plan.get('operationId') else str(RECOVERY))
        result=subprocess.run([NODE,'-e',code,*map(str,args)],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=180,preexec_fn=self.drop if os.geteuid()==0 else None)
        require(result.returncode==0,'Independent Node verification failed; details kept out of public output')
        return json.loads(result.stdout)
    def fingerprint(self):
        ordinary_directory(APP);ordinary_directory(DATA);home=ordinary_directory(DATA/'dsh-home')
        paths={'package':home/'profiles/web/package.json','patch':home/'profiles/web/cordis.patch.yml','tlsKey':DATA/'tls.key','tlsCert':DATA/'tls.crt','adapter':APP/'adapter.json','sdkPackage':APP/'runtime/node_modules/@deepseek-ai/dsh/package.json','sdkEntry':APP/'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'}
        result={key:sha256(ordinary_file(file).read_bytes()) for key,file in paths.items()}
        result['dataDirectory']=str(DATA)
        result['homeIdentity']=[home.stat().st_dev,home.stat().st_ino]
        # No platform version files are ever modified by this script.
        result['platformManifest']=sha256(ordinary_file(Path('/var/apps/dsh-fnos/manifest')).read_bytes())
        return result
    def owners(self):
        return self.node('const p=require(process.argv[1]);console.log(JSON.stringify(p.ownedProcesses(process.argv[2],process.argv[3])))',APP/'port-owner.js',DATA,APP)
    def platform(self,command):
        require(command in [platform_command(x) for x in ['status','stop','start']],'Forbidden command')
        if command[1]=='stop':
            self.initial=self.owners();self.old_boot=json.loads((DATA/'state.json').read_text()).get('bootId')
        # A timeout/nonzero return is UNKNOWN, never an invitation to repeat.
        result=subprocess.run(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120,text=True)
        require(result.returncode==0,'Platform action not confirmed')
    def stopped(self):
        if self.owners():return False
        # Exact configured port relation is supplied by the validated app API.
        ports=self.node('const o=require(process.argv[1]);console.log(JSON.stringify(o.portSettings(process.argv[2])))',APP/'ops.js',DATA)
        public=ports['publicPort']
        if public is None:
            match=re.search(r'^service_port\s*=\s*([0-9]+)',Path('/var/apps/dsh-fnos/manifest').read_text(),re.M)
            require(match is not None,'Platform service port is unknown')
            public=int(match.group(1))
        for port in [ports['corePort'],public]:
            with socket.socket() as connection:
                connection.settimeout(1)
                code=connection.connect_ex(('127.0.0.1',int(port)))
                if code not in [111,61,10061]:return False
        return True
    def backup(self):
        ordinary_directory(RECOVERY)
        # Per-operation storage prevents createSnapshot retention from pruning any
        # existing user snapshot; never change their backup-settings.json.
        parent=RECOVERY/'.safe-deploy-backups'
        parent.mkdir(mode=0o711,exist_ok=True);ordinary_directory(parent)
        self.backup_root.mkdir(mode=0o700,exist_ok=False)
        os.chown(self.backup_root,self.account.pw_uid,self.account.pw_gid)
        ordinary_directory(self.backup_root)
        require(not str(RECOVERY).startswith(str(DATA)+'/') and RECOVERY!=DATA,'Backup must be independent of app data')
        return self.node("const o=require(process.argv[1]);const s=o.createSnapshot(process.argv[2],process.argv[3],'pre-upgrade',o.dshVersion(process.argv[4]));console.log(JSON.stringify(s));",APP/'ops.js',DATA,CONFIG,APP)
    def verify_backup(self,snapshot):
        # Re-read files and compare BOTH snapshot and stopped source, not a success flag.
        result=self.node("const o=require(process.argv[1]),b=require(process.argv[2]),fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');const root=b.locate(process.argv[3],process.argv[4]);const m=o.readJson(root+'/meta.json');let controls=true;const names=[];for(const f of m.controlFiles||[]){if(p.basename(f.name)!==f.name)throw new Error('Unsafe backup control name');const bytes=fs.readFileSync(p.join(root,'control-evidence',f.name));if(c.createHash('sha256').update(bytes).digest('hex')!==f.sha256)controls=false;names.push(f.name);}console.log(JSON.stringify({id:m.id,consistency:m.consistency,createdAt:m.createdAt,copy:o.snapshotFingerprint(root),source:o.snapshotFingerprint(process.argv[3]),expected:m.fingerprint,root,controls,hasTls:names.includes('tls.key')&&names.includes('tls.crt')}));",APP/'ops.js',APP/'backup-store.js',DATA,snapshot['id'])
        require(Path(result['root']).parent==self.backup_root,'Backup landed outside this operation protected root')
        require(result['id']==snapshot['id'] and result['consistency']=='stopped-core','Backup identity/consistency invalid')
        require(result['copy']==result['source']==result['expected'],'Backup verification failed')
        require(result['controls'] and result['hasTls'],'TLS/control backup evidence missing or corrupt')
        from datetime import datetime,timezone
        age=time.time()-datetime.fromisoformat(result['createdAt'].replace('Z','+00:00')).timestamp()
        require(0<=age<900,'Stale/future backup')
        return True
    def recheck_payload(self,plan,blobs):
        current=validate_plan(plan,self.payload,APP,self.fingerprint())
        require(current==blobs,'Payload changed since approval')
    def preserve_runtime(self,blobs):
        self.rollback=RECOVERY/'.safe-deploy-runtime'/self.plan['operationId'];self.rollback.mkdir(parents=True,exist_ok=False,mode=0o700)
        for name in blobs:
            target=APP/name
            if target.exists():
                saved=self.rollback/name;saved.write_bytes(ordinary_file(target).read_bytes());saved.chmod(0o600)
                require(sha256(saved.read_bytes())==sha256(target.read_bytes()),'Rollback copy hash mismatch')
    def write_files(self,blobs):
        for name,data in blobs.items():
            require(name in FILES,'Unexpected file')
            target=APP/name
            if target.exists() or target.is_symlink():ordinary_file(target)
            temporary=APP/(name+'.safe-deploy-'+str(uuid.uuid4())+'.tmp')
            try:
                with temporary.open('xb') as output:
                    output.write(data);output.flush();os.fsync(output.fileno())
                os.chown(temporary,self.account.pw_uid,self.account.pw_gid);temporary.chmod(0o644)
                os.replace(temporary,target)
            finally:
                if temporary.exists():temporary.unlink() # Only this invocation's UUID-owned file.
        fd=os.open(APP,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
    def verify_files(self,blobs):
        for name,data in blobs.items():require(sha256(ordinary_file(APP/name).read_bytes())==sha256(data),'Deployed hash mismatch')
    def running_evidence(self):
        self.validate_active_data()
        state=json.loads((DATA/'state.json').read_text())
        require(state.get('mode')=='ready' and state.get('bootId') and not state.get('error') and not state.get('pendingRestore'), 'Current application is not safely running')
        return dict(mode=state['mode'],bootId=state['bootId'],owners=self.owners())
    def ready(self):
        old={(x['pid'],x['starttime']) for x in self.initial}
        for _ in range(120):
            state=json.loads((DATA/'state.json').read_text());owners=self.owners()
            if state.get('mode')=='ready' and state.get('bootId')!=self.old_boot and not state.get('error') and not state.get('pendingRestore') and all(sum(x['role']==role for x in owners)==1 for role in ['core','supervisor','gateway']) and all((x['pid'],x['starttime']) not in old for x in owners):return True
            time.sleep(1)
        return False

def verify_worker_domain(operation_id):
    # App-owned jobs disappear when this application is stopped. Require a host
    # service; nohup/setsid alone never prove lifetime independence.
    unit='dsh-fnos-deploy-'+str(uuid.UUID(operation_id))+'.service'
    group='/system.slice/'+unit
    own=Path('/proc/self/cgroup').read_text().splitlines()
    require(any(line.split(':',2)[-1]==group for line in own), 'Stop/start requires an independent host deployment service; refusing an application-owned worker')
    result=subprocess.run(['/usr/bin/systemctl','show',unit,'--property=MainPID','--property=ControlGroup','--property=ActiveState'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=10)
    require(result.returncode==0,'Independent deployment service cannot be verified')
    properties=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
    require(properties.get('MainPID')==str(os.getpid()) and properties.get('ControlGroup')==group and properties.get('ActiveState')=='active', 'Deployment service owner generation is not confirmed')

def main():
    global DATA
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir',type=Path,required=True,help='Explicit canonical data directory of the current live supervisor')
    parser.add_argument('--payload',type=Path,required=True)
    parser.add_argument('--plan',type=Path,required=True)
    parser.add_argument('--prepare',action='store_true',help='Create a fresh plan only, no platform action')
    parser.add_argument('--execute',action='store_true',help='Requires NEW explicit user permission')
    parser.add_argument('--cancel-unwritten',action='store_true',help='Explicitly reconcile only an interrupted operation proved to have no runtime writes')
    parser.add_argument('--expected-state-sha256')
    parser.add_argument('--plan-sha256')
    parser.add_argument('--confirm',default='')
    args=parser.parse_args();require(sum([args.prepare,args.execute,args.cancel_unwritten])<=1,'Actions cannot be combined')
    DATA=ordinary_directory(args.data_dir)
    payload=ordinary_directory(args.payload.resolve());backend=Backend(payload,{})
    backend.validate_active_data()
    if args.prepare:
        require(not args.plan.exists(),'Plan exists; refuse overwrite')
        manifest=json.loads(ordinary_file(payload/'payload.json').read_text());files=[]
        for item in manifest:
            name=item['name'];require(name in FILES,'Forbidden file');source=ordinary_file(payload/name);require(sha256(source.read_bytes())==item['sha256'],'Payload checksum failed')
            target=APP/name;before=sha256(ordinary_file(target).read_bytes()) if target.exists() or target.is_symlink() else None
            files.append(dict(name=name,sha256=item['sha256'],beforeSha256=before))
        now=time.time();plan=dict(schema=1,app='dsh-fnos',action='hotfix',operationId=str(uuid.uuid4()),createdAt=now,expiresAt=now+900,before=backend.fingerprint(),files=files)
        with args.plan.open('x') as output:os.chmod(args.plan,0o600);json.dump(plan,output,indent=2)
        print('Plan created only; no deployment or service action');return
    raw=ordinary_file(args.plan).read_bytes();plan=json.loads(raw);backend.plan=plan
    if args.cancel_unwritten:
        require(os.geteuid()==0,'Cancellation requires administrator')
        require(args.expected_state_sha256 and args.plan_sha256,'Exact reviewed state and original plan hashes required')
        control=ordinary_directory(RECOVERY/'.safe-deploy-control')
        record=Journal(control,plan['operationId']).cancel_unwritten(raw,args.plan_sha256,args.expected_state_sha256,APP,backend,backend.fingerprint(),args.confirm)
        print(json.dumps({'operationId':record['operationId'],'phase':record['phase'],'noRuntimeWrites':record['noRuntimeWrites']}));return
    blobs=validate_plan(plan,payload,APP,backend.fingerprint())
    if not args.execute:
        print(json.dumps({'mode':'read-only-preflight','operationId':plan['operationId'],'files':list(blobs),'planSha256':sha256(raw)}));return
    require(os.geteuid()==0,'Deployment requires administrator')
    require(args.plan_sha256==sha256(raw),'Exact reviewed plan hash required')
    require(args.confirm=='STOP-AND-RESTART dsh-fnos '+plan['operationId'],'Explicit NEW stop/restart confirmation required')
    verify_worker_domain(plan['operationId'])
    control=RECOVERY/'.safe-deploy-control';control.mkdir(mode=0o700,exist_ok=True)
    with Journal(control,plan['operationId']) as journal:
        Deployment(backend,journal).execute(plan,blobs,args.confirm)
    print('Completed data-preserving application-layer hotfix; platform version unchanged')

if __name__=='__main__':
    try:main()
    except (SafetyError,UnknownState,KeyError,ValueError,OSError,subprocess.SubprocessError) as failure:
        raise SystemExit('SAFETY BLOCK: '+str(failure))
