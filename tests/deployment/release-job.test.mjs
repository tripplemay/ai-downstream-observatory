import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.WORKBENCH_TEST_PYTHON || 'python3';
const bootstrap = String.raw`
import hashlib,importlib.util,json,os,pathlib,shutil,sqlite3,subprocess,sys,time
spec=importlib.util.spec_from_file_location('release_job',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
r=pathlib.Path(sys.argv[2]).resolve();sha='a'*40;run_id='123';attempt='1';uid=os.getuid();gid=os.getgid()
release=r/'releases'/sha;source=pathlib.Path(sys.argv[1]).parent
for p in [release/'scripts',release/'migrations',r/'incoming'/sha/'images-123-1',r/'data-workbench',r/'release-evidence']:p.mkdir(parents=True,mode=0o700,exist_ok=True)
for name in ['release-job.py','release-barrier.py']:shutil.copyfile(source/name,release/'scripts'/name)
(release/'.release-sha').write_text(sha+'\n');(release/'scripts/deploy-workbench.sh').write_text('#!/bin/bash\nexit 23\n')
(release/'migrations/0001.sql').write_text('SELECT 1;\n');checksum=hashlib.sha256((release/'migrations/0001.sql').read_bytes()).hexdigest()
(release/'migrations/manifest.json').write_text(json.dumps({'migrations':[{'version':1,'file':'0001.sql','sha256':checksum}]}))
config=r/'release.env';config.write_text('FIXTURE_ONLY=1\n');config.chmod(0o600)
bundle=r/'incoming'/sha/'images-123-1/release-images.json';bundle.write_text(json.dumps({'release_sha':sha,'market_provider':False}));bundle.chmod(0o600)
data=r/'data-workbench';db=sqlite3.connect(data/'etf-workbench.db');db.executescript('CREATE TABLE schema_migrations(version INTEGER,filename TEXT,checksum TEXT);PRAGMA user_version=1;');db.execute('INSERT INTO schema_migrations VALUES(1,?,?)',('0001.sql',checksum));db.commit();db.close()
def seal():
 files=sorted(p for p in release.rglob('*') if p.is_file() and p.name!='.release-files.sha256')
 (release/'.release-files.sha256').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  ./'+str(p.relative_to(release))+'\n' for p in files))
seal();calls=[];unit_state='not-found';containers=[]
def backend(command,**kw):
 calls.append(command)
 if command[0]=='systemd-run':return subprocess.CompletedProcess(command,0,'','')
 if command[:2]==['systemctl','show']:
  return subprocess.CompletedProcess(command,0,'LoadState='+unit_state+'\nActiveState='+('active' if unit_state=='loaded' else 'inactive')+'\nSubState='+('running' if unit_state=='loaded' else 'dead')+'\nMainPID='+('42' if unit_state=='loaded' else '0')+'\nResult=success\n','')
 if command[:2]==['docker','ps']:return subprocess.CompletedProcess(command,0,'\n'.join(x['Id'] for x in containers),'')
 if command[:2]==['docker','inspect']:return subprocess.CompletedProcess(command,0,json.dumps(containers),'')
 if command[:2]==['docker','stop']:
  assert (data/'RESTORE_PENDING_REVIEW').is_file(), 'write barrier must precede cleanup'
  for x in containers:x['State']['Running']=False
  return subprocess.CompletedProcess(command,0,'','')
 if command[0]=='bash':return subprocess.CompletedProcess(command,23,'','')
 raise AssertionError(command)
def job():return m.ReleaseJob(r,sha,run_id,attempt,config,owner_uid=uid,app_uid=uid,app_gid=gid,runner=backend)
def phase():
 e=r/'release-evidence'/(sha+'-20261107T000000Z');e.mkdir(mode=0o700)
 m.barrier['begin_cutover'](e,data,sha,'etf-workbench',operator_uid=uid,app_uid=uid)
 p=e/'image-bundle-verification.json';p.write_text(json.dumps({'release_sha':sha,'status':'loaded_images_verified','runtime_image_ids':['sha256:'+'1'*64,'sha256:'+'2'*64]}));p.chmod(0o600)
 return e
def fleet(health='healthy'):
 return [{'Id':str(i)*64,'Image':'sha256:'+('1' if role=='web' else '2')*64,'Config':{'Image':'etf-workbench-'+('worker' if role=='verifier' else role)+':'+sha,'User':'10001:10001','Labels':{'com.docker.compose.project':'etf-workbench','com.docker.compose.service':role,'org.opencontainers.image.revision':sha}},'State':{'Running':True,'Health':{'Status':health}},'Mounts':[{'Type':'bind','Source':str(data)}]} for i,role in enumerate(['web','worker','verifier'],1)]
`;

function run(t, program) {
  const directory = mkdtempSync(join(tmpdir(), 'release-job-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(python, ['-c', bootstrap + program, join(root, 'scripts/release-job.py'), directory],
    { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
}

test('actual source staging strips archive write bits before the unchanged host source guard', t => run(t, String.raw`
workflow=(source.parent/'.github/workflows/deploy.yml').read_text()
line=next(row.strip() for row in workflow.splitlines() if row.strip().startswith('tar --extract '))
assert '--no-same-permissions' in line, 'root tar must not preserve Git archive group-write bits'
for p in [release,*release.rglob('*')]:p.chmod(0o775 if p.is_dir() else 0o664)
(release/'scripts/deploy-workbench.sh').chmod(0o775)
archive=r/'release.tar.gz'
subprocess.run(['tar','--create','--gzip','--file',str(archive),'--directory',str(release),'.'],check=True,capture_output=True)
before={str(p.relative_to(release)):hashlib.sha256(p.read_bytes()).hexdigest() for p in release.rglob('*') if p.is_file()}
release.rename(r/'archive-input');release.mkdir(mode=0o700)
old=line.replace('--no-same-permissions','--same-permissions')
subprocess.run(['bash','-c','umask 077; stage=$1; '+old,'fixture',str(release)],cwd=r,check=True,capture_output=True)
j=job()
try:j._source()
except ValueError:pass
else:raise AssertionError('unmodified strict guard must reject the old root extraction modes')
shutil.rmtree(release);release.mkdir(mode=0o700)
subprocess.run(['bash','-c','umask 077; stage=$1; '+line,'fixture',str(release)],cwd=r,check=True,capture_output=True)
j._source()
assert all(not p.lstat().st_mode&0o022 for p in [release,*release.rglob('*')])
assert (release/'scripts/deploy-workbench.sh').stat().st_mode&0o100
assert before=={str(p.relative_to(release)):hashlib.sha256(p.read_bytes()).hexdigest() for p in release.rglob('*') if p.is_file()}
assert not calls and not (r/'release-jobs').exists()
`));

test('atomic submission starts one detached exec service, pins the absolute budget and never retries an existing SHA', t => run(t, String.raw`
j=job();deadline=int(time.time())+120;create=m.barrier['_create'];observed=[]
def staged(fd,name,value,*args):
 assert name.startswith('.pending-') and not (j.directory/'intent.json').exists(), 'incomplete record must not be published'
 create(fd,name,value,*args)
 assert not (j.directory/'intent.json').exists()
 observed.append(name)
m.barrier['_create']=staged
j.submit(deadline)
m.barrier['_create']=create
assert len(observed)==1 and json.loads((j.directory/'intent.json').read_text())['release_sha']==sha
start=next(x for x in calls if x[0]=='systemd-run')
assert '--service-type=exec' in start and '--property=Restart=no' in start
assert any(x.startswith('--property=ExecStopPost=') for x in start)
assert not any(x in start for x in ['--scope','--wait','--pipe','--pty'])
intent=json.loads((j.directory/'intent.json').read_text());assert intent['deadline_epoch']==deadline
try:j.submit(deadline)
except ValueError:pass
else:raise AssertionError('must not resubmit')
assert len([x for x in calls if x[0]=='systemd-run'])==1
`));

test('unknown submission remains reconcilable; a live manager handle and missing handle are not successful cutovers', t => run(t, String.raw`
def lost(command,**kw):
 if command[0]=='systemd-run':calls.append(command);raise subprocess.TimeoutExpired(command,1)
 return backend(command,**kw)
j=job();j.runner=lost
try:j.submit(int(time.time())+120)
except subprocess.TimeoutExpired:pass
else:raise AssertionError('unknown submit')
unit_state='loaded';x=j.status();assert x['status']=='RUNNING' and x['manager']['MainPID']=='42'
unit_state='not-found';assert j.status()['status']=='UNKNOWN_REQUIRES_REVIEW'
try:j.submit(int(time.time())+120)
except ValueError:pass
else:raise AssertionError('unknown submit cannot be retried')
assert len([x for x in calls if x[0]=='systemd-run'])==1
`));

test('worker verifies source/config, records one execution and cannot rerun a deployment or extend the deadline', t => run(t, String.raw`
j=job();j.submit(int(time.time())+120);assert j.worker()==23;before=set(j.directory.iterdir())
try:j.worker()
except (FileExistsError,ValueError):pass
else:raise AssertionError('worker cannot replay')
assert len([x for x in calls if x[0]=='bash'])==1
assert set(j.directory.iterdir())==before, 'known duplicate cannot accumulate temporary copies'
command=next(x for x in calls if x[0]=='bash');assert command[command.index('--image-bundle')+1]==str(bundle) and command[-1]=='--execute'
assert json.loads((j.directory/'execution.json').read_text())['exit_code']==23
`));

test('source or private configuration changes reject before the deployment command', t => run(t, String.raw`
j=job();j.submit(int(time.time())+120);config.write_text('CHANGED=1\n')
try:j.worker()
except ValueError:pass
else:raise AssertionError('changed configuration')
assert not any(x[0]=='bash' for x in calls)
`));

test('failed execution after write-ahead phase fences first, stops only verified project writers and preserves the database', t => run(t, String.raw`
j=job();j.submit(int(time.time())+120);e=phase();before=hashlib.sha256((data/'etf-workbench.db').read_bytes()).hexdigest();containers=fleet()
x=j.finalize('signal','killed','9')
assert x['status']=='FAILED_RECOVERY_REQUIRED' and x['cleanup_complete'] is True
assert (data/'RESTORE_PENDING_REVIEW').is_file() and not any(z['State']['Running'] for z in containers)
assert hashlib.sha256((data/'etf-workbench.db').read_bytes()).hexdigest()==before
assert len([c for c in calls if c[:2]==['docker','stop']])==1
assert j.finalize('signal','killed','9')==x
`));

test('known pre-cutover failure preserves existing running services and never invokes Docker cleanup', t => run(t, String.raw`
j=job();j.submit(int(time.time())+120);e=phase();containers=fleet()
(e/'result.json').write_text(json.dumps({'release_sha':sha,'status':'failed','writers_stopped':0,'database_overwritten':False}));(e/'result.json').chmod(0o600)
x=j.finalize('exit-code','exited','23')
assert x['status']=='FAILED_PRE_CUTOVER' and not (data/'RESTORE_PENDING_REVIEW').exists()
assert not any(c[0]=='docker' for c in calls)
`));

test('exit zero alone is not success; actual source, current link, schema and healthy fleet are mandatory', t => run(t, String.raw`
j=job();j.submit(int(time.time())+120);e=phase();containers=fleet()
j._write('execution.json',{'exit_code':0});(r/'current').symlink_to(release,target_is_directory=True)
(e/'result.json').write_text(json.dumps({'release_sha':sha,'status':'technical_cutover_verified','local_restore_verified':True}));(e/'result.json').chmod(0o600)
x=j._finalize(None,None,None,worker_completed=True);assert x['status']=='SUCCEEDED' and x['schema_version']==1
assert not (data/'RESTORE_PENDING_REVIEW').exists()
unit_state='loaded';assert j.status()['status']=='RUNNING'
unit_state='not-found';assert j.status()['status']=='SUCCEEDED'
`));

test('unhealthy or unrelated containers cannot turn a technical receipt into success or cause broad cleanup', t => run(t, String.raw`
j=job();j.submit(int(time.time())+120);e=phase();containers=fleet('unhealthy')
j._write('execution.json',{'exit_code':0});(r/'current').symlink_to(release,target_is_directory=True)
(e/'result.json').write_text(json.dumps({'release_sha':sha,'status':'technical_cutover_verified','local_restore_verified':True}));(e/'result.json').chmod(0o600)
containers[0]['Config']['Labels']['com.docker.compose.project']='unrelated'
x=j._finalize(None,None,None,worker_completed=True);assert x['status']=='FAILED_RECOVERY_REQUIRED' and x['cleanup_complete'] is False
assert (data/'RESTORE_PENDING_REVIEW').exists() and not any(c[:2]==['docker','stop'] for c in calls)
`));

test('slow successful verification runs inside the original worker deadline and the stop hook only reads its receipt', t => run(t, String.raw`
j=job();start=int(time.time());j.clock=lambda:start;j.submit(start+120)
def success(command,**kw):
 global containers
 if command[0]=='bash':
  calls.append(command);e=phase();containers=fleet();(r/'current').symlink_to(release,target_is_directory=True)
  p=e/'result.json';p.write_text(json.dumps({'release_sha':sha,'status':'technical_cutover_verified','local_restore_verified':True}));p.chmod(0o600)
  return subprocess.CompletedProcess(command,0,'','')
 return backend(command,**kw)
j.runner=success;original=j._schema;checked=[]
def slow_schema(path):
 checked.append(True);j.clock=lambda:start+110;return original(path)
j._schema=slow_schema
assert j.worker()==0 and checked==[True]
terminal=j._bound('terminal.json');assert terminal['status']=='SUCCEEDED' and terminal['completion_basis']=='managed_worker_verification'
j._schema=lambda _:(_ for _ in ()).throw(AssertionError('stop hook must not repeat integrity scan'))
assert j.finalize('success','exited','0')==terminal
assert len([c for c in calls if c[0]=='bash'])==1
assert '--property=TimeoutStopSec=90s' in next(c for c in calls if c[0]=='systemd-run')
`));

test('late successful command cannot buy verification time, and a missing worker receipt cannot be forged by hook success', t => run(t, String.raw`
j=job();start=int(time.time());j.clock=lambda:start;j.submit(start+120);e=phase();containers=fleet()
j._write('execution.json',{'exit_code':0});(r/'current').symlink_to(release,target_is_directory=True)
p=e/'result.json';p.write_text(json.dumps({'release_sha':sha,'status':'technical_cutover_verified','local_restore_verified':True}));p.chmod(0o600)
j.clock=lambda:start+121
j._schema=lambda _:(_ for _ in ()).throw(AssertionError('no late full scan'))
x=j._finalize(None,None,None,worker_completed=True)
assert x['status']=='FAILED_RECOVERY_REQUIRED' and (data/'RESTORE_PENDING_REVIEW').is_file()
# A different hook invocation cannot relabel the failure receipt.
assert j.finalize('success','exited','0')==x
`));

test('manual reconciliation is explicit, post-deadline, independently verified and never an automatic success receipt', t => run(t, String.raw`
j=job();start=int(time.time());j.clock=lambda:start;j.submit(start+120);e=phase();containers=fleet()
j._write('execution.json',{'exit_code':0});(r/'current').symlink_to(release,target_is_directory=True)
p=e/'result.json';p.write_text(json.dumps({'release_sha':sha,'status':'technical_cutover_verified','local_restore_verified':True}));p.chmod(0o600)
for acknowledge in (False,True):
 try:j.reconcile(acknowledge)
 except ValueError:pass
 else:raise AssertionError('no implicit or in-budget reconciliation')
j.clock=lambda:start+121;unit_state='loaded'
try:j.reconcile(True)
except ValueError:pass
else:raise AssertionError('live manager is not reconcilable')
unit_state='not-found';containers[0]['State']['Health']['Status']='unhealthy'
try:j.reconcile(True)
except ValueError:pass
else:raise AssertionError('current health mandatory')
containers=fleet();record=j.reconcile(True)
assert record['status']=='TECHNICAL_CUTOVER_RECONCILED' and record['automatic_release_succeeded'] is False
assert not (j.directory/'terminal.json').exists() and j.status()['status']=='UNKNOWN_REQUIRES_REVIEW'
assert j._reconciled() and j._intent()['deadline_epoch']==start+120
try:j.reconcile(True)
except ValueError:pass
else:raise AssertionError('manual operation is once only')
assert not any(c[:2]==['docker','stop'] or c[0]=='bash' for c in calls)
`));

test('manual receipt unlocks only a new release submission; changed bound execution is rejected', t => run(t, String.raw`
j=job();start=int(time.time());j.clock=lambda:start;j.submit(start+120);e=phase();containers=fleet()
j._write('execution.json',{'exit_code':0});(r/'current').symlink_to(release,target_is_directory=True)
p=e/'result.json';p.write_text(json.dumps({'release_sha':sha,'status':'technical_cutover_verified','local_restore_verified':True}));p.chmod(0o600)
old_release=release;old_bundle=bundle;old_sha=sha
sha='b'*40;release=r/'releases'/sha;shutil.copytree(old_release,release);(release/'.release-sha').write_text(sha+'\n');seal()
bundle=r/'incoming'/sha/'images-123-1/release-images.json';bundle.parent.mkdir(mode=0o700,parents=True);bundle.write_text(json.dumps({'release_sha':sha,'market_provider':False}));bundle.chmod(0o600)
next_job=job();next_job.clock=lambda:start+121
try:next_job.submit(start+241)
except ValueError as error:assert str(error)=='ANOTHER_RELEASE_REQUIRES_RECONCILIATION'
else:raise AssertionError('missing terminal requires a separate decision')
assert not next_job.directory.exists()
j.clock=lambda:start+121;j.reconcile(True)
next_job.submit(start+241)
assert len([c for c in calls if c[0]=='systemd-run'])==2
p=j.directory/'execution.json';value=json.loads(p.read_text());value['exit_code']=23;p.write_text(json.dumps(value))
assert not j._reconciled()
`));

test('expired budgets and unsafe state directories cannot submit a service', t => run(t, String.raw`
j=job()
try:j.submit(int(time.time())-1)
except ValueError:pass
else:raise AssertionError('expired deadline')
assert not any(c[0]=='systemd-run' for c in calls)
p=r/'release-jobs';p.mkdir(mode=0o755,exist_ok=True);p.chmod(0o755)
try:j.submit(int(time.time())+120)
except ValueError:pass
else:raise AssertionError('broad private state')
assert not any(c[0]=='systemd-run' for c in calls)
p.chmod(0o700)
j=job();deadline=int(time.time())+120;j.submit(deadline);original=j._source
def slow_source():
 value=original();j.clock=lambda:deadline+1;return value
j._source=slow_source
try:j.worker()
except ValueError:pass
else:raise AssertionError('expired during full source validation')
assert not any(c[0]=='bash' for c in calls) and not (j.directory/'started.json').exists()
`));

test('workflow observes a submitted host job without a second cutover and retains every original budget', () => {
  const workflow = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8');
  assert.match(workflow, /timeout-minutes: 75/);
  assert.match(workflow, /release-job\.py" submit/);
  assert.match(workflow, /release-job\.py" status/);
  assert.match(workflow, /RELEASE_DEADLINE_EPOCH/);
  assert.match(workflow, /ServerAliveInterval=15/);
  assert.doesNotMatch(workflow, /bash "\$release\/scripts\/deploy-workbench\.sh"/);
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /release-job-smoke\.sh/);
});

test('simultaneous submissions reserve one durable intent and start at most one manager job', t => run(t, String.raw`
trace=r/'starts'
def counted(command,**kw):
 if command[0]=='systemd-run':
  fd=os.open(trace,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600);os.write(fd,b'one\n');os.fsync(fd);os.close(fd)
 return backend(command,**kw)
children=[]
for index in range(2):
 pid=os.fork()
 if pid==0:
  try:
   j=job();j.runner=counted;j.submit(int(time.time())+120)
  except (ValueError,OSError):pass
  os._exit(0)
 children.append(pid)
for pid in children:assert os.waitpid(pid,0)[1]==0
assert trace.read_bytes()==b'one\n' and (r/'release-jobs'/sha/'intent.json').is_file()
`));

test('a changed deployment source is rejected before execution even with the same source manifest claim', t => run(t, String.raw`
j=job();j.submit(int(time.time())+120)
(release/'scripts/deploy-workbench.sh').write_text('#!/bin/bash\necho fictional changed source\n')
try:j.worker()
except ValueError:pass
else:raise AssertionError('source content must match')
assert not any(c[0]=='bash' for c in calls)
`));

test('late expiry during submission and before worker entry cannot buy another runtime budget', t => run(t, String.raw`
j=job();deadline=int(time.time())+120
def delayed(command,**kw):
 result=backend(command,**kw)
 if command[0]=='systemctl':j.clock=lambda:deadline+1
 return result
j.runner=delayed
try:j.submit(deadline)
except ValueError:pass
else:raise AssertionError('expired while checking manager')
assert not any(c[0]=='systemd-run' for c in calls)
`));

test('worker does not inherit SSH, model, provider or cloud credentials from its caller', t => run(t, String.raw`
os.environ['AWS_SECRET_ACCESS_KEY']='fictional-cloud-secret';os.environ['LONGBRIDGE_APP_SECRET']='fictional-provider-secret'
os.environ['SSH_AUTH_SOCK']='/fictional/socket';os.environ['WORKBENCH_AI_ENABLED']='1'
j=job();j.submit(int(time.time())+120)
def clean(command,**kw):
 if command[0]=='bash':
  assert set(kw['env'])=={'PATH','LANG','HOME','PYTHONDONTWRITEBYTECODE'}
  assert not any(value in json.dumps(command) for value in ['fictional-cloud-secret','fictional-provider-secret'])
 return backend(command,**kw)
j.runner=clean;assert j.worker()==23
`));

test('unsafe existing recovery markers do not overwrite their targets and cannot produce a successful terminal', t => run(t, String.raw`
j=job();j.submit(int(time.time())+120);e=phase();containers=fleet()
outside=r/'private-preserved';outside.write_bytes(b'original private bytes');(data/'RESTORE_PENDING_REVIEW').symlink_to(outside)
try:j.finalize('signal','killed','9')
except ValueError:pass
else:raise AssertionError('unsafe marker must remain unresolved')
assert outside.read_bytes()==b'original private bytes' and not any(x['State']['Running'] for x in containers)
assert j.status()['status']=='UNKNOWN_REQUIRES_REVIEW'
`));

test('private state aliases cannot cause writes outside the release job namespace', t => run(t, String.raw`
outside=r/'other-private';outside.mkdir(mode=0o700);(r/'release-jobs').symlink_to(outside,target_is_directory=True)
j=job()
try:j.submit(int(time.time())+120)
except ValueError:pass
else:raise AssertionError('state alias')
assert list(outside.iterdir())==[] and not any(c[0]=='systemd-run' for c in calls)
`));

test('required Linux lifecycle smoke is isolated, kills only its caller and verifies ownership before cleanup', () => {
  const smoke = readFileSync(join(root, 'tests/deployment/release-job-smoke.sh'), 'utf8');
  for (const literal of ['etf-release-job-native-', "started['parent_pid']==1", 'os.killpg(observer.pid,signal.SIGTERM)',
    "value['status']=='RUNNING'", "value['status']=='FAILED_PRE_CUTOVER'", "'execution_count':1",
    "'backup_or_restore_created':False", "assert str(root) in exec_start", "subprocess.run(['systemctl','stop',unit]",
    "state.get('MainPID')=='0'", 'shutil.rmtree(root)']) assert.ok(smoke.includes(literal), literal);
  assert.doesNotMatch(smoke, /deploysvr|\/opt\/observatory|docker (?:compose|stop|rm)|\bprune\b|curl|requests\./);
  assert.ok(smoke.indexOf("assert str(root) in exec_start") < smoke.indexOf("subprocess.run(['systemctl','stop',unit]"));
});

test('an actual image identity different from the verified load cannot be blessed by its tag or health label', t => run(t, String.raw`
j=job();j.submit(int(time.time())+120);e=phase();containers=fleet()
j._write('execution.json',{'exit_code':0});(r/'current').symlink_to(release,target_is_directory=True)
(e/'result.json').write_text(json.dumps({'release_sha':sha,'status':'technical_cutover_verified','local_restore_verified':True}));(e/'result.json').chmod(0o600)
containers[0]['Image']='sha256:'+'f'*64
x=j.finalize('success','exited','0')
assert x['status']=='FAILED_RECOVERY_REQUIRED' and x['cleanup_complete'] is True and (data/'RESTORE_PENDING_REVIEW').is_file()
assert not any(item['State']['Running'] for item in containers)
`));
