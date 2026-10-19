#!/usr/bin/env python3
"""Inventory actual runtime package roots and source/notice evidence, never legal clearance.
No package manager, package import, installation, network request or source rewrite.
"""
import argparse, hashlib, json, re, tarfile
from pathlib import Path, PurePosixPath
MAX_TEXT=2*1024*1024
COPYLEFT=re.compile(r'(^|[^A-Za-z])(?:AGPL|LGPL|GPL|MPL)(?:[- ]|$)',re.I)
def package_root(rel):
 p=PurePosixPath(rel)
 return p.name=='package.json' and (p.parent.parent.name=='node_modules' or (p.parent.parent.name.startswith('@') and p.parent.parent.parent.name=='node_modules'))
def safe_name(name):
 p=PurePosixPath(name)
 if p.is_absolute() or '..' in p.parts or chr(92) in name:raise ValueError('unsafe archive path')
 return p.as_posix().removeprefix('./')
def directory_files(root):
 root=root.resolve(strict=True)
 if not root.is_dir():raise ValueError('runtime directory required')
 entries={p.relative_to(root).as_posix():p for p in root.rglob('*') if p.is_file() and not p.is_symlink()}
 def read(name):
  p=entries[name]
  if p.stat().st_size>MAX_TEXT:raise ValueError('metadata text too large: '+name)
  return p.read_bytes()
 return entries,read,None
def archive_files(file):
 archive=tarfile.open(file,'r:*');entries={}
 try:
  for item in archive:
   name=safe_name(item.name)
   if item.isfile():entries[name]=item
  prefix='runtime/' if any(k.startswith('runtime/node_modules/') for k in entries) else ''
  selected={k[len(prefix):]:v for k,v in entries.items() if k.startswith(prefix)}
  def read(name):
   m=selected[name]
   if m.size>MAX_TEXT:raise ValueError('metadata text too large: '+name)
   return archive.extractfile(m).read()
  return selected,read,archive
 except BaseException:archive.close();raise
def audit(entries,read):
 rows=[]
 for rel in sorted(k for k in entries if package_root(k)):
  raw=read(rel);meta=json.loads(raw)
  if not isinstance(meta,dict) or not isinstance(meta.get('name'),str) or not isinstance(meta.get('version'),str):raise ValueError('invalid package root: '+rel)
  prefix=PurePosixPath(rel).parent.as_posix()+'/'
  local=[k for k in entries if k.startswith(prefix) and '/' not in k[len(prefix):]]
  paths=[k for k in local if PurePosixPath(k).name.lower().startswith(('license','licence','copying','notice'))]
  notices=[{'path':k,'sha256':hashlib.sha256(read(k)).hexdigest()} for k in sorted(paths)]
  license=meta.get('license') if isinstance(meta.get('license'),str) else None
  review=[]
  if not license or license.upper() in ['UNLICENSED','UNDECLARED']:review.append('license-declaration-not-verified')
  if license and COPYLEFT.search(license):review.append('corresponding-source-and-combination-obligations-need-review')
  if not notices:review.append('no-package-root-license-or-notice-text')
  recipes=[]
  for name in sorted(k for k in entries if k.startswith(prefix+'sources/') and PurePosixPath(k).name in ['core-source.json','source.json']):
   body=read(name);recipe=json.loads(body)
   if not isinstance(recipe,dict):raise ValueError('invalid source recipe')
   recipes.append({'path':name,'sha256':hashlib.sha256(body).hexdigest(),'recipe':recipe,'isCompleteCorrespondingSource':False})
  versions_path=prefix+'versions.json'
  rows.append({'path':rel,'name':meta['name'],'version':meta['version'],'license':license,'manifestSha256':hashlib.sha256(raw).hexdigest(),'repository':meta.get('repository'),'notices':notices,'embeddedSourceRecipes':recipes,'nativeComponentVersions':json.loads(read(versions_path)) if versions_path in entries else None,'reviewRequired':review})
 if not rows:raise ValueError('no actual node_modules package roots found')
 return {'schema':1,'scope':'actual runtime package roots only; non-root package metadata excluded','legalClearance':'not-assessed','distributable':False,'packageRootCount':len(rows),'reviewRequiredCount':sum(bool(r['reviewRequired']) for r in rows),'copyleftPackageCount':sum(bool(COPYLEFT.search(r['license'] or '')) for r in rows),'packages':rows}
def markdown(result):
 lines=['# Third-party runtime inventory and source obligations','','This inventory does not relicense dependencies or approve redistribution.','Preserve every upstream copyright, license, NOTICE and source-delivery obligation.','An embedded recipe identifies build inputs; it is not proof of complete corresponding source.','','Package roots: '+str(result['packageRootCount'])+'. Packages requiring review: '+str(result['reviewRequiredCount'])+'.','','| Package | Version | Declared license | Notice files | Review |','|---|---|---|---|---|']
 esc=lambda s:str(s if s is not None else '(missing)').replace('|',chr(92)+'|').replace(chr(10),' ')
 for r in result['packages']:lines.append('| '+' | '.join(esc(x) for x in [r['name'],r['version'],r['license'],len(r['notices']),'; '.join(r['reviewRequired']) or 'No automatic finding; not legal clearance'])+' |')
 lines+=['','## Copyleft/source evidence (not a clearance)','']
 for r in result['packages']:
  if not COPYLEFT.search(r['license'] or ''):continue
  lines+=['### '+r['name']+' '+r['version'],'','- Package metadata: '+r['path'], '- Upstream repository declaration: '+json.dumps(r['repository'],ensure_ascii=False)]
  for recipe in r['embeddedSourceRecipes']:lines.append('- Embedded recipe: '+recipe['path']+'; SHA256 '+recipe['sha256']+'; '+json.dumps(recipe['recipe'],ensure_ascii=False))
  if r['nativeComponentVersions']:lines.append('- Included component versions: '+json.dumps(r['nativeComponentVersions'],ensure_ascii=False))
  lines+=['- Complete source, build inputs, changes and replacement/relink conditions require version-specific review.','']
 return chr(10).join(lines)+chr(10)
def main():
 p=argparse.ArgumentParser(description=__doc__);choice=p.add_mutually_exclusive_group(required=True);choice.add_argument('--runtime',type=Path);choice.add_argument('--app-tgz',type=Path);p.add_argument('--out',type=Path,required=True);p.add_argument('--fail-on-review',action='store_true');a=p.parse_args()
 if a.out.exists():raise ValueError('output exists; refuse overwrite')
 entries,read,archive=directory_files(a.runtime) if a.runtime else archive_files(a.app_tgz)
 try:result=audit(entries,read)
 finally:
  if archive:archive.close()
 a.out.mkdir(parents=True,mode=0o700)
 (a.out/'runtime-licenses.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+chr(10))
 (a.out/'THIRD-PARTY-NOTICES.md').write_text(markdown(result))
 print(json.dumps({k:result[k] for k in ['packageRootCount','reviewRequiredCount','copyleftPackageCount','legalClearance','distributable']}))
 return 2 if a.fail_on_review and result['reviewRequiredCount'] else 0
if __name__=='__main__':
 try:raise SystemExit(main())
 except (ValueError,OSError,tarfile.TarError) as e:raise SystemExit('License audit blocked: '+str(e))
