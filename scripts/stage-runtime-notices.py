#!/usr/bin/env python3
"""Add version-bound upstream notice bytes to a private FPK build stage only.
No network, package import, installation, overwrite or legal-clearance decision.
"""
import argparse,hashlib,json,os
from pathlib import Path,PurePosixPath

def digest(data):return hashlib.sha256(data).hexdigest()
def relative(value):
 if not isinstance(value,str) or not value or chr(92) in value:raise ValueError('invalid relative notice path')
 p=PurePosixPath(value)
 if p.is_absolute() or '..' in p.parts or '.' in p.parts:raise ValueError('notice path leaves staging')
 return p

def inside(root,value):
 parts=relative(value).parts;p=root
 for part in parts:
  p=p/part
  if p.is_symlink():raise ValueError('symlink in notice path')
 if not p.resolve().is_relative_to(root):raise ValueError('resolved notice path escapes staging')
 return p

def stage_notices(stage,runtime,manifest):
 stage=Path(stage).resolve(strict=True);runtime=Path(runtime)
 if '@appcenter' in stage.parts or stage.is_relative_to(Path('/var/apps')) or stage.is_relative_to(Path('/opt/dsh')):raise ValueError('installed application paths are not build staging')
 if not (stage/'manifest').is_file() or not (stage/'cmd').is_dir() or not (stage/'config').is_dir():raise ValueError('FPK staging structure required')
 expected=stage/'app/runtime'
 if runtime.absolute()!=expected or runtime.is_symlink() or (stage/'app').is_symlink():raise ValueError('runtime must be the non-symlink staged app/runtime')
 runtime=runtime.resolve(strict=True);manifest=Path(manifest).resolve(strict=True);source=manifest.parent
 data=json.loads(manifest.read_bytes())
 if data.get('schema')!=1 or data.get('legalClearance')!='not-assessed' or data.get('distributable') is not False:raise ValueError('notice manifest must retain unassessed clearance')
 plans=[];targets=set();packages=set();existing=0
 for row in data['packages']:
  meta_path=relative(row['packagePath'])
  if meta_path.name!='package.json' or 'node_modules' not in meta_path.parts:raise ValueError('package root manifest required')
  if str(meta_path) in packages:raise ValueError('duplicate package root')
  packages.add(str(meta_path));file=inside(runtime,str(meta_path));raw=file.read_bytes();meta=json.loads(raw)
  if meta.get('name')!=row['name'] or meta.get('version')!=row['version'] or digest(raw)!=row['manifestSha256']:raise ValueError('staged package identity/hash differs: '+row['name'])
  for doc in row['documents']:
   target_name=relative(doc['target'])
   if len(target_name.parts)!=1 or not target_name.name.lower().startswith(('license','licence','notice','copying','authors','copyright')):raise ValueError('legal text filename required')
   target=inside(runtime,str(meta_path.parent/target_name));text=inside(source,doc['text']).read_bytes()
   if digest(text)!=doc['sha256']:raise ValueError('upstream notice bytes differ: '+row['name'])
   if target in targets:raise ValueError('duplicate notice target')
   targets.add(target)
   if target.exists():
    if not target.is_file() or target.read_bytes()!=text:raise ValueError('existing notice differs; refuse overwrite: '+row['name'])
    existing+=1
   else:plans.append((target,text))
 # All identities, source bytes, paths and conflicts have passed before any write.
 for target,text in plans:
  with target.open('xb') as output:
   output.write(text);os.fchmod(output.fileno(),0o644)
 return {'packageRoots':len(packages),'documents':len(targets),'added':len(plans),'alreadyIdentical':existing,'legalClearance':'not-assessed','distributable':False}

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--staging-root',required=True,type=Path);p.add_argument('--runtime',required=True,type=Path);p.add_argument('--manifest',type=Path,default=Path(__file__).parent/'runtime-notices/manifest.json');a=p.parse_args()
 try:result=stage_notices(a.staging_root,a.runtime,a.manifest)
 except (ValueError,OSError,KeyError,TypeError) as error:p.exit(2,'Notice staging blocked: '+str(error)+chr(10))
 print(json.dumps(result));return 0
if __name__=='__main__':raise SystemExit(main())
