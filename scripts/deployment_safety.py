"""Fail-closed policy for data-preserving DSH application-layer deployment.
No install, uninstall, shell, recovery replay, or force mode is supported.
"""
import fcntl
import hashlib
import json
import math
import os
import stat
import time
import uuid
from pathlib import Path

APP_NAME = 'dsh-fnos'
FILES = frozenset(['automatic-backup-policy.js','gateway.js','management-page.js','ops.js','port-owner.js','supervisor.js','backup-store.js','guide-core-auth.js','market-supervision.js','actions.js','management-theme.js','reliability-panel.js','restore-integrity.js','core-capabilities.js','uninstall-retention.js','connection-settings.js'])
ALLOWED_COMMANDS = frozenset(['status','stop','start'])

class SafetyError(RuntimeError): pass
class UnknownState(SafetyError): pass

def require(condition, message):
    if not condition: raise SafetyError(message)

def sha256(data): return hashlib.sha256(data).hexdigest()

def platform_command(action, app=APP_NAME):
    require(action in ALLOWED_COMMANDS and app == APP_NAME, 'Forbidden platform operation: install/uninstall/reinstall are NEVER deployment operations')
    return ['/usr/local/bin/appcenter-cli', action, APP_NAME]

def ordinary_directory(path):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, 'Directory must be absolute, existing and have no symlink ancestors')
    require(path.is_dir(), 'Directory required')
    return path

def ordinary_file(path):
    path = Path(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink(), 'Regular non-symlink file required')
    return path

def validate_plan(plan, payload_root, app_root, fingerprint, now=None):
    now = time.time() if now is None else now
    require(plan.get('schema') == 1 and plan.get('app') == APP_NAME and plan.get('action') == 'hotfix', 'Only existing DSH application-layer hotfix is allowed')
    require(str(uuid.UUID(plan['operationId'])) == plan['operationId'], 'Operation id must be canonical UUID')
    created, expires = plan['createdAt'], plan['expiresAt']
    require(all(type(x) in (int,float) and math.isfinite(x) for x in [created,expires]), 'Invalid permission lifetime')
    require(created <= now + 2 and now < expires and 0 < expires-created <= 900, 'Plan expired/future/too long-lived; old permission cannot be reused')
    require(plan.get('before') == fingerprint, 'Installation/profile/TLS identity changed; re-read and re-authorize')
    payload_root, app_root = ordinary_directory(payload_root), ordinary_directory(app_root)
    records = plan.get('files')
    require(type(records) is list and records, 'Empty or invalid payload')
    names, blobs = set(), {}
    for record in records:
        name = record['name']
        require(name in FILES and name not in names, 'Unexpected/duplicate file; SDK, plugin, data, manifest and hooks are forbidden')
        names.add(name)
        data = ordinary_file(payload_root/name).read_bytes()
        require(sha256(data) == record['sha256'], 'Payload hash mismatch')
        destination = app_root/name
        before = sha256(ordinary_file(destination).read_bytes()) if destination.exists() or destination.is_symlink() else None
        require(before == record.get('beforeSha256'), 'Runtime file changed since approval')
        blobs[name] = data
    return blobs

class Journal:
    """An unfinished journal is a persistent application-wide barrier, not a retry hint."""
    def __init__(self, control_root, operation_id):
        self.root = ordinary_directory(control_root)
        self.operation_id = operation_id
        self.path = self.root/'state.json'
        self.fd = None
    def __enter__(self):
        require(str(uuid.UUID(self.operation_id)) == self.operation_id, 'Invalid journal operation id')
        self.fd = os.open(self.root/'deployment.lock', os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
            if self.path.exists() or self.path.is_symlink():
                state = json.loads(ordinary_file(self.path).read_text())
                if state.get('phase') == 'cancelled-unwritten':
                    receipt=json.loads(ordinary_file(self.root/(state['operationId']+'.cancelled-unwritten.json')).read_text())
                    prior=ordinary_file(self.root/(state['operationId']+'.stop-pending.json')).read_bytes()
                    require(receipt==state and state.get('noRuntimeWrites') is True and sha256(prior)==state.get('priorStateSha256'), 'Unwritten cancellation evidence is invalid')
                else:
                    require(state.get('phase') == 'completed', 'Previous deployment incomplete/unknown; no new stop/start/write is allowed')
                require(state.get('operationId') != self.operation_id, 'Completed operation cannot be replayed')
            self.save('preflight')
            return self
        except Exception:
            os.close(self.fd); self.fd = None
            raise
    def cancel_unwritten(self, plan_raw, expected_plan_sha256, expected_state_sha256, app_root, backend, fingerprint, confirmation):
        require(confirmation == 'CANCEL-UNWRITTEN '+APP_NAME+' '+self.operation_id+' '+expected_state_sha256, 'Fresh explicit unwritten-cancellation confirmation required')
        require(sha256(plan_raw)==expected_plan_sha256, 'Original plan hash changed')
        plan=json.loads(plan_raw)
        require(plan.get('schema')==1 and plan.get('app')==APP_NAME and plan.get('action')=='hotfix' and plan.get('operationId')==self.operation_id, 'Original operation identity invalid')
        require(str(uuid.UUID(self.operation_id))==self.operation_id, 'Operation id must be canonical UUID')
        self.fd=os.open(self.root/'deployment.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            fcntl.flock(self.fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            raw=ordinary_file(self.path).read_bytes();state=json.loads(raw)
            require(sha256(raw)==expected_state_sha256 and state.get('operationId')==self.operation_id and state.get('phase')=='stop-pending', 'Unfinished state changed or is not unwritten stop-pending')
            allowed={self.operation_id+'.preflight.json',self.operation_id+'.stop-pending.json'}
            require(all(p.name in allowed for p in self.root.glob(self.operation_id+'.*.json')), 'Later/unknown deployment phase exists; cannot cancel as unwritten')
            require(ordinary_file(self.root/(self.operation_id+'.stop-pending.json')).read_bytes()==raw, 'Original stopped-at evidence does not match current state')
            records=plan.get('files');require(type(records) is list and records,'Original file list missing')
            root=ordinary_directory(app_root);names=set()
            for record in records:
                name=record['name'];require(name in FILES and name not in names,'Unexpected original file');names.add(name)
                target=root/name
                current=sha256(ordinary_file(target).read_bytes()) if target.exists() or target.is_symlink() else None
                require(current==record.get('beforeSha256'),'Runtime file changed; cannot prove an unwritten operation')
            require(backend.fingerprint()==fingerprint,'Current installation/configuration changed during review')
            running=backend.running_evidence()
            require(backend.fingerprint()==fingerprint,'Current configuration changed before cancellation')
            self.save('cancelled-unwritten',noRuntimeWrites=True,priorStateSha256=expected_state_sha256,originalPlanSha256=expected_plan_sha256,currentFingerprint=fingerprint,runningEvidence=running,originalFiles=records)
            return json.loads(ordinary_file(self.path).read_text())
        finally:
            os.close(self.fd);self.fd=None

    def save(self, phase, **fields):
        record = dict(operationId=self.operation_id, app=APP_NAME, phase=phase, updatedAt=time.time(), **fields)
        history = self.root/(self.operation_id+'.'+phase+'.json')
        # Every phase is unique: no overwriting or erasing prior UNKNOWN evidence.
        with history.open('x') as output:
            os.chmod(history,0o600);json.dump(record,output);output.flush();os.fsync(output.fileno())
        temporary = self.root/('.state-'+str(uuid.uuid4())+'.tmp')
        try:
            with temporary.open('x') as output:
                os.chmod(temporary,0o600);json.dump(record,output);output.flush();os.fsync(output.fileno())
            os.replace(temporary,self.path)
            fd=os.open(self.root,os.O_RDONLY)
            try:os.fsync(fd)
            finally:os.close(fd)
        finally:
            if temporary.exists(): temporary.unlink() # Only this invocation's UUID-owned file.
    def __exit__(self, *_):
        if self.fd is not None: os.close(self.fd);self.fd=None

class Deployment:
    """Backend operations are separated from policy so dangerous interleavings can be tested."""
    def __init__(self, backend, journal): self.backend,self.journal=backend,journal
    def execute(self, plan, blobs, confirmation, now=None):
        require(confirmation == 'STOP-AND-RESTART '+APP_NAME+' '+plan['operationId'], 'Fresh explicit stop/restart confirmation required')
        require(self.backend.fingerprint() == plan['before'], 'Preflight identity changed')
        try:
            self.journal.save('stop-pending')
            self.backend.platform(platform_command('stop'))
            require(self.backend.stopped(), 'Core/gateway/supervisor stop not confirmed')
            require(self.backend.fingerprint() == plan['before'], 'Data identity changed during stop')
            self.journal.save('stopped-confirmed')
            snapshot=self.backend.backup()
            require(self.backend.verify_backup(snapshot), 'Independent current-data backup is missing, corrupt, stale or unverifiable')
            self.journal.save('backup-verified',snapshotId=snapshot['id'])
            require(self.backend.stopped(), 'A process restarted during backup')
            require(self.backend.fingerprint() == plan['before'], 'Profile/TLS changed before write')
            # Recheck freshness immediately before irreversible writes.
            require(time.time() < plan['expiresAt'], 'Permission expired during preparation')
            self.backend.recheck_payload(plan,blobs)
            self.backend.preserve_runtime(blobs)
            self.journal.save('write-pending')
            self.backend.write_files(blobs)
            self.backend.verify_files(blobs)
            require(self.backend.fingerprint() == plan['before'], 'Profile/TLS changed after write; refuse automatic launch')
            self.journal.save('start-pending')
            self.backend.platform(platform_command('start'))
            require(self.backend.ready(), 'New owner generation/readiness not confirmed')
            self.backend.verify_files(blobs)
            require(self.backend.fingerprint() == plan['before'], 'Data/configuration/TLS preservation failed')
            self.journal.save('completed',snapshotId=snapshot['id'])
            return snapshot
        except Exception as failure:
            # NEVER auto-start, reinstall, restore old data or repeat a timed-out action.
            self.journal.save('unknown',errorType=type(failure).__name__)
            raise UnknownState('Deployment incomplete; evidence retained; inspect before any new operation') from failure
