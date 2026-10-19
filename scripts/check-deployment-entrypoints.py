#!/usr/bin/env python3
"""CI/read-only gate: no unguarded installers or replayable historical workers."""
import ast,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
failures=[]
for script in (ROOT/'scripts').glob('*.py'):
    tree=ast.parse(script.read_text(),filename=str(script))
    for node in ast.walk(tree):
        if isinstance(node,ast.Constant) and isinstance(node.value,str) and node.value.startswith(str(Path('/usr/local/bin')/'appcenter-cli')):
            failures.append(str(script)+': raw platform executable belongs ONLY to deployment_safety.platform_command')
    if script.name=='safe-deploy.py' and 'platform_command' not in script.read_text():failures.append('safe deploy lost guarded command builder')
# The command builder is the single intentional executable literal.
failures=[x for x in failures if 'deployment_safety.py:' not in x]
workspace=ROOT.parent
legacy=['pwtest/powerharness/install-0.3.89-20261012/install-local-authorized.py','pwtest/powerharness/install-0.3.89-20261012/install-authorized.py','pwtest/powerharness/incident-20261012/deploy-worker-0.3.90.py','pwtest/powerharness/incident-20261012/deploy-hotfix-worker.py']
for name in legacy:
    file=workspace/name
    if not file.exists():continue
    tree=ast.parse(file.read_text());body=[n for n in tree.body if not(isinstance(n,ast.Expr) and isinstance(n.value,ast.Constant) and isinstance(n.value.value,str))]
    if len(body)!=1 or not isinstance(body[0],ast.Raise):failures.append(name+': historical executable is not hard-disabled')
if failures:
    print('DEPLOYMENT SAFETY BLOCK:\n'+'\n'.join(failures),file=sys.stderr);sys.exit(1)
print('Deployment entrypoint gate: PASS; historical installers disabled; platform commands centralized')
