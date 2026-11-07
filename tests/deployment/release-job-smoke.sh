#!/usr/bin/env bash
set -Eeuo pipefail

[[ $(uname -s) == Linux ]] || { printf 'Native Linux systemd required; no synthetic pass or skip\n' >&2; exit 1; }
sudo -n env PYTHONDONTWRITEBYTECODE=1 python3 - "$PWD" <<'PY'
import hashlib,json,os,pathlib,selectors,shlex,shutil,signal,subprocess,sys,tempfile,time,uuid
source=pathlib.Path(sys.argv[1]);root=pathlib.Path(tempfile.mkdtemp(prefix='etf-release-job-native-')).resolve()
sha=hashlib.sha256(uuid.uuid4().bytes).hexdigest()[:40];unit='etf-workbench-release-'+sha+'.service';observer=None
def manager():
 p=subprocess.run(['systemctl','show',unit,'--property=LoadState,ActiveState,MainPID'],text=True,capture_output=True,timeout=10)
 value=dict(line.split('=',1) for line in p.stdout.splitlines() if '=' in line)
 assert p.returncode==0 or p.returncode==4 and value.get('LoadState')=='not-found'
 return value
try:
 assert manager().get('LoadState')=='not-found'
 release=root/'releases'/sha;release.joinpath('scripts').mkdir(parents=True,mode=0o700)
 for name in ['release-job.py','release-barrier.py']:shutil.copyfile(source/'scripts'/name,release/'scripts'/name)
 (release/'.release-sha').write_text(sha+'\n')
 (release/'scripts/deploy-workbench.sh').write_text('#!/bin/bash\nset -euo pipefail\nroot='+shlex.quote(str(root))+'\nprintf "one execution\\n" >> "$root/executions"\nwhile [[ ! -e "$root/finish" ]]; do sleep 0.1; done\nexit 23\n')
 names=sorted(p for p in release.rglob('*') if p.is_file())
 (release/'.release-files.sha256').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  ./'+str(p.relative_to(release))+'\n' for p in names))
 incoming=root/'incoming'/sha/'images-123-1';incoming.mkdir(parents=True,mode=0o700)
 bundle=incoming/'release-images.json';bundle.write_text(json.dumps({'release_sha':sha,'market_provider':False}));bundle.chmod(0o600)
 config=root/'release.env';config.write_text('FIXTURE_ONLY=1\n');config.chmod(0o600)
 (root/'release-evidence').mkdir(mode=0o700);data=root/'data-workbench';data.mkdir(mode=0o700)
 (data/'unchanged.txt').write_text('fictional preserved facts\n');before=hashlib.sha256((data/'unchanged.txt').read_bytes()).hexdigest()
 base=['/usr/bin/python3',str(release/'scripts/release-job.py')]
 common=['--root',str(root),'--release',sha,'--workflow-run','123','--attempt','1','--config',str(config)]
 command=base+['submit',*common,'--deadline',str(int(time.time())+60)]
 # This disposable process stands in for the SSH caller; PID 1 must own the worker.
 observer=subprocess.Popen(['bash','-c',shlex.join(command)+' && exec sleep 60'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
 selector=selectors.DefaultSelector();selector.register(observer.stdout,selectors.EVENT_READ)
 assert selector.select(20),'submission did not return';submitted=json.loads(observer.stdout.readline());selector.close()
 assert submitted['status']=='SUBMITTED_NOT_YET_CUT_OVER'
 limit=time.monotonic()+20
 while not (root/'release-jobs'/sha/'started.json').exists():
  assert time.monotonic()<limit;time.sleep(0.1)
 started=json.loads((root/'release-jobs'/sha/'started.json').read_text());assert started['parent_pid']==1
 try:os.killpg(observer.pid,signal.SIGTERM)
 except ProcessLookupError:pass
 observer.wait(timeout=10)
 value=json.loads(subprocess.check_output(base+['status',*common],text=True,timeout=15));assert value['status']=='RUNNING' and int(value['manager']['MainPID'])>0
 (root/'finish').write_text('finish fictional failure before cutover\n')
 limit=time.monotonic()+20
 while True:
  value=json.loads(subprocess.check_output(base+['status',*common],text=True,timeout=15))
  if value['status']=='FAILED_PRE_CUTOVER':break
  assert value['status']=='RUNNING' and time.monotonic()<limit;time.sleep(0.1)
 assert (root/'executions').read_text()=='one execution\n'
 assert not (data/'RESTORE_PENDING_REVIEW').exists() and hashlib.sha256((data/'unchanged.txt').read_bytes()).hexdigest()==before
 assert not (root/'backups-workbench').exists() and not (root/'restores-workbench').exists()
finally:
 if observer is not None:
  if observer.poll() is None:
   try:os.killpg(observer.pid,signal.SIGTERM)
   except ProcessLookupError:pass
   observer.wait(timeout=10)
  if observer.stdout:observer.stdout.close()
  if observer.stderr:observer.stderr.close()
 state=manager()
 if state.get('LoadState')!='not-found':
  exec_start=subprocess.check_output(['systemctl','show',unit,'--property=ExecStart','--value'],text=True,timeout=10)
  assert str(root) in exec_start,'refuse cleanup of a unit not bound to this fixture'
  subprocess.run(['systemctl','stop',unit],check=True,timeout=90)
 state=manager();assert state.get('LoadState')=='not-found' or state.get('ActiveState') in ('inactive','failed') and state.get('MainPID')=='0'
 shutil.rmtree(root)
print(json.dumps({'status':'PASS','native_systemd':True,'worker_parent_pid':1,'caller_terminated':True,'execution_count':1,
 'terminal':'FAILED_PRE_CUTOVER','business_services_started':False,'database_overwritten':False,'backup_or_restore_created':False,
 'owned_unit_stopped_or_collected':True,'fixture_deleted':not root.exists(),'provider_calls':0,'gateway_calls':0}))
PY
