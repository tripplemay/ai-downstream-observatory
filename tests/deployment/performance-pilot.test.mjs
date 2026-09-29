import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(join(root, '.github/workflows/workbench-performance.yml'), 'utf8');
const prelude = `
import importlib.util, json, os, sqlite3, tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('pilot', 'scripts/performance/pilot.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
def rejected(fn, code):
    try:
        fn()
    except ValueError as error:
        assert str(error) == code, (str(error), code)
    else:
        raise AssertionError('expected rejection: ' + code)
`;
function python(code) {
  const result = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c', prelude + code], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

test('manual pilot workflow accepts only reviewed mainline SHA and fixed small/full profiles, separate from release CI', () => {
  assert.match(workflow, /on:\s*\n  workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule|workflow_run):/m);
  assert.match(workflow, /default: small\s+options: \[small, full\]/);
  assert.match(workflow, /\^\[a-f0-9\]\{40\}\$/);
  assert.match(workflow, /git merge-base --is-ancestor "\$COMMIT_SHA" origin\/main/);
  assert.match(workflow, /ref: \$\{\{ needs.validate.outputs.commit_sha \}\}/);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /secrets\.|ssh |docker |deploy-workbench|continue-on-error/);
  assert.match(workflow, /pip install -r requirements-workbench.txt/);
  assert.match(workflow, /npm --prefix web ci --no-audit --no-fund/);
  for (const command of ['build:evaluation-worker', 'build:csv-worker', 'build:verification-worker', 'build']) {
    assert.ok(workflow.includes(`npm --prefix web run ${command}\n`));
  }
  assert.match(workflow, /path: artifacts\/verification\/performance-pilot\//);
  assert.doesNotMatch(workflow, /path: (?:\.|artifacts\/verification\/)\s*$/m);
});

test('fixed profiles preserve full quantities, ordinary worker polling and separate setup/load budgets', () => python(`
assert p.PROFILES['full'] == {'history':50000, 'listings':1000, 'market-rows':2000000, 'csv-rows':10000,
    'count':1000, 'interval-ms':250, 'setup-seconds':1200, 'overall-seconds':1800,
    'background-cycles':12, 'background-interval-ms':20000}
args = p.profile_args('full')
assert args[-6:] == ['--core-count','1','--poll-seconds','5','--max-queued','32']
assert p.LIMITS['full'] > 1200 + 1800
assert p.PROFILES['small']['count'] == 20
rejected(lambda: p.profile_args('full; arbitrary shell'), 'INVALID_PROFILE')
`));

test('cgroup limits reject host totals, unlimited swap, wrong quota and widened affinity', () => python(`
values = {'cpu_max':'400000 100000', 'memory_max':str(p.MEMORY), 'swap_max':'0', 'effective_cpus':'0-3'}
p.verify_limits(values, [0,1,2,3])
for key, value, code in [('cpu_max','max 100000','CPU_LIMIT_UNVERIFIED'), ('cpu_max','800000 100000','CPU_LIMIT_UNVERIFIED'),
    ('memory_max','max','MEMORY_LIMIT_UNVERIFIED'), ('memory_max',str(16*1024**3),'MEMORY_LIMIT_UNVERIFIED'),
    ('swap_max','max','SWAP_LIMIT_UNVERIFIED'), ('swap_max','1','SWAP_LIMIT_UNVERIFIED'),
    ('effective_cpus','0-7','AFFINITY_LIMIT_UNVERIFIED'), ('effective_cpus','1-4','AFFINITY_LIMIT_UNVERIFIED')]:
    rejected(lambda: p.verify_limits({**values,key:value}, [0,1,2,3]), code)
assert p.parse_cpus('2,4-6') == [2,4,5,6]
for text in ['', '-1', '4-2', '1;echo', '0-65536']:
    rejected(lambda: p.parse_cpus(text), 'CPU_SET_INVALID')
`));

test('disk proof rejects tmpfs, network, overlay and rotating storage instead of claiming local SSD', () => python(`
mount = {'source':'/dev/pilot1','fstype':'ext4','target':'/synthetic','options':'rw'}
devices = [{'path':'/dev/pilot','type':'disk','rota':False,'children':[{'path':'/dev/pilot1','type':'part','rota':False}]}]
proof = p.verify_storage(mount, devices)
assert proof['nonrotational_block_device_verified'] is True
assert proof['physical_ssd_independently_inspected'] is False
for filesystem in ['tmpfs','nfs','overlay']:
    rejected(lambda: p.verify_storage({**mount,'fstype':filesystem}, devices), 'DISK_FILESYSTEM_UNVERIFIED')
rejected(lambda: p.verify_storage({**mount,'source':'server:share'}, devices), 'LOCAL_BLOCK_DEVICE_REQUIRED')
rejected(lambda: p.verify_storage(mount, [{'path':'/dev/pilot1','rota':True}]), 'NONROTATIONAL_STORAGE_UNVERIFIED')
rejected(lambda: p.verify_storage(mount, []), 'NONROTATIONAL_STORAGE_UNVERIFIED')
`));

test('fixed systemd argv places runuser and all descendants inside one unit with a minimal secret-free environment', () => python(`
args = SimpleNamespace(node='/opt/node/bin/node', python='/opt/venv/bin/python', profile='full', commit='a'*40)
with patch.dict(os.environ, {'LONGPORT_APP_SECRET':'SYNTHETIC-DO-NOT-COPY','GITHUB_TOKEN':'SYNTHETIC-DO-NOT-COPY'}):
    env = p.minimal_environment(args, Path('/synthetic/private'))
    command = p.unit_command(args, 'runner', 'workbench-pilot-fixed', '0,1,2,3', Path('/synthetic/private'))
assert set(env) == {'PATH','HOME','TMPDIR','LANG','TZ','WORKBENCH_TEST_PYTHON','WORKBENCH_PYTHON','PYTHONDONTWRITEBYTECODE'}
assert 'SYNTHETIC-DO-NOT-COPY' not in str(command)
assert command[:2] == ['systemd-run','--unit=workbench-pilot-fixed']
for prop in ['CPUQuota=400%','AllowedCPUs=0,1,2,3','MemoryMax=8589934592','MemorySwapMax=0',
    'KillMode=control-group','NoNewPrivileges=yes','RemainAfterExit=yes','RuntimeMaxSec=3600']:
    assert '--property=' + prop in command
start = command.index('/usr/sbin/runuser')
assert command[start:start+7] == ['/usr/sbin/runuser','--user','runner','--','/usr/bin/env','-i', 'PATH='+env['PATH']]
assert 'sh' not in command and '-c' not in command
`));

test('resource sample records actual cgroup CPU, throttling, memory, IO and OOM counters', () => python(String.raw`
with tempfile.TemporaryDirectory() as temporary:
    directory = Path(temporary)
    files = {'cpu.max':'400000 100000', 'memory.max':str(p.MEMORY), 'memory.swap.max':'0', 'cpuset.cpus.effective':'0-3',
        'cpu.stat':'usage_usec 100\nnr_throttled 2\nthrottled_usec 50\n', 'memory.current':'1234','memory.peak':'5678',
        'memory.events':'oom 1\noom_kill 1\n','io.stat':'8:0 rbytes=12 wbytes=34 rios=1 wios=2',
        'cgroup.events':'populated 1\nfrozen 0\n','cgroup.procs':'10\n11\n'}
    for name, value in files.items(): (directory/name).write_text(value)
    sample = p.sample(directory,[0,1,2,3],1.25)
    assert sample['cpu']['nr_throttled'] == 2 and sample['cpu']['throttled_usec'] == 50
    assert sample['memory_current'] == 1234 and sample['memory_peak'] == 5678
    assert sample['memory_events']['oom_kill'] == 1 and sample['pids'] == [10,11]
    assert sample['io_stat'] == files['io.stat']
`));

test('clean unit termination requires retained exited state, exit zero and an empty cgroup, never timeout or signal', () => python(`
state = {'ActiveState':'active','SubState':'exited','Result':'success','ExecMainCode':'1','ExecMainStatus':'0'}
assert p.clean_terminal(state, True, False)
assert not p.clean_terminal(state, False, False)
assert not p.clean_terminal(state, True, True)
for key, value in [('ActiveState','inactive'),('SubState','running'),('Result','timeout'),('Result','oom-kill'),('ExecMainCode','2'),('ExecMainStatus','1')]:
    assert not p.clean_terminal({**state,key:value}, True, False)
for key in state:
    assert not p.clean_terminal({k:v for k,v in state.items() if k != key}, True, False)
failure={**state,'ActiveState':'failed','Result':'exit-code','ExecMainStatus':'1'}
assert p.settled_terminal(failure, True, False)
assert not p.settled_terminal(failure, False, False) and not p.settled_terminal(failure, True, True)
assert not p.settled_terminal({**failure,'ExecMainCode':'2'}, True, False)
`));

test('evidence allowlist excludes auth databases, credentials and environment; unknown writers never export financial database', () => python(String.raw`
with tempfile.TemporaryDirectory() as temporary:
    base = Path(temporary); source=base/'source'; source.mkdir()
    (source/'report.json').write_text('{"status":"FAIL"}')
    (source/'server-trace.jsonl').write_text('{"status":200}\n')
    for name in ['auth.sqlite','session.db','environment.json','.env','token.txt']:
        (source/name).write_text('SYNTHETIC-DO-NOT-COPY')
    db = sqlite3.connect(source/'final-workbench.db'); db.execute('CREATE TABLE ledger_events(id TEXT)'); db.close()
    (source/'attachments').mkdir(); (source/'attachments'/'synthetic.csv').write_text('synthetic,csv\n')
    members = p.safe_collect(source, base/'failed', False)
    assert {m['path'] for m in members} == {'report.json','server-trace.jsonl'}
    members = p.safe_collect(source, base/'success', True)
    assert {m['path'] for m in members} == {'report.json','server-trace.jsonl','final-workbench.db','attachments/synthetic.csv'}
    assert all((base/'success'/m['path']).stat().st_mode & 0o777 == 0o600 for m in members)
    assert all(p.file_hash(base/'success'/m['path']) == m['sha256'] for m in members)
    assert (base/'success').stat().st_mode & 0o777 == 0o700
    assert (source/'auth.sqlite').exists()
`));

test('allowlisted database cannot be auth storage and symlinks/hardlinks cannot bypass synthetic-only retention', () => python(`
with tempfile.TemporaryDirectory() as temporary:
    base=Path(temporary); source=base/'source'; source.mkdir()
    db=sqlite3.connect(source/'final-workbench.db')
    db.execute('CREATE TABLE ledger_events(id TEXT)'); db.execute('CREATE TABLE sessions(token TEXT)'); db.close()
    rejected(lambda: p.safe_collect(source,base/'auth',True), 'AUTH_DATABASE_FORBIDDEN')
    (source/'final-workbench.db').unlink()
    outside=base/'secret'; outside.write_text('SYNTHETIC-DO-NOT-COPY')
    (source/'report.json').symlink_to(outside)
    rejected(lambda: p.safe_collect(source,base/'symlink',False), 'EVIDENCE_FILE_INVALID')
    (source/'report.json').unlink(); os.link(outside,source/'report.json')
    rejected(lambda: p.safe_collect(source,base/'hardlink',False), 'EVIDENCE_FILE_INVALID')
`));

test('sampling barriers bracket the actual child harness, with no unbounded wait or idle workload padding', () => python(`
with tempfile.TemporaryDirectory() as temporary:
    marker=Path(temporary)/'ready'
    with patch.object(p.time,'monotonic',side_effect=[0,31]), patch.object(p.time,'sleep') as sleep:
        rejected(lambda: p.wait_for_marker(marker), 'SUPERVISOR_BARRIER_TIMEOUT')
        sleep.assert_not_called()
    marker.touch()
    with patch.object(p.time,'sleep') as sleep:
        p.wait_for_marker(marker); sleep.assert_not_called()
source=Path('scripts/performance/pilot.py').read_text()
start=source.index('wait_for_marker(scratch / "supervisor-ready")')
dispatch=source.index('result = subprocess.run(command',start)
result=source.index('write_json(scratch / "child-result.json"',dispatch)
final=source.index('wait_for_marker(scratch / "supervisor-final-sample")',result)
assert start < dispatch < result < final
assert 'shutil.rmtree' not in source
assert 'performance_gate": True' not in source
`));

for (const succeeds of [true, false]) test(`mocked unit ${succeeds ? 'success requires final sample and exact source binding' : 'normal business failure preserves verified backup without claiming success'}`, () => python(String.raw`
succeeds = ${succeeds ? 'True' : 'False'}
with tempfile.TemporaryDirectory() as temporary:
    root=Path(temporary); cgroup=root/'cgroups'; cgroup.mkdir()
    executable=root/'executable'; executable.write_text('synthetic'); executable.chmod(0o700)
    args=SimpleNamespace(profile='small',commit='a'*40,node=str(executable),python=str(executable))
    process = {}; calls=[]
    def fake_run(command, timeout=10):
        calls.append(command)
        if command[0] == 'git':
            if command[-1] == 'HEAD': return 'a'*40
            if command[-1] == 'HEAD^{tree}': return 'b'*40
            return ''
        if command[0] == 'systemd-run':
            scratch=Path(command[command.index('--scratch')+1]); unit=command[command.index('--unit')+1]
            directory=cgroup/'system.slice'/(unit+'.service'); directory.mkdir(parents=True)
            process.update(scratch=scratch,unit=unit,directory=directory,reads=0)
            p.write_json(scratch/'resource-preflight.json',{'status':'verified'})
            db=sqlite3.connect(scratch/'evidence/final-workbench.db'); db.execute('CREATE TABLE ledger_events(id TEXT)'); db.close()
            p.write_json(scratch/'evidence/report.json',{'status':'PASS' if succeeds else 'FAIL','owned_processes_stopped':True,
                'uncertain_writers':False,'retention_verified':True,'retained_database':{'path':'final-workbench.db',
                'sha256':p.file_hash(scratch/'evidence/final-workbench.db')}})
            return ''
        assert command[:2] == ['systemctl','stop'], command
        return ''
    def fake_state(unit):
        process['reads'] += 1
        if process['reads'] == 2:
            assert (process['scratch']/'supervisor-ready').exists()
            p.write_json(process['scratch']/'child-result.json',{'exit_code':0 if succeeds else 1})
        if process['reads'] >= 3:
            assert (process['scratch']/'supervisor-final-sample').exists()
            (process['directory']/'cgroup.events').write_text('populated 0')
        return {'ActiveState':'active' if succeeds or process['reads'] < 3 else 'failed',
            'SubState':'running' if process['reads'] < 3 else 'exited',
            'Result':'success' if succeeds else 'exit-code','ExecMainCode':'1','ExecMainStatus':'0' if succeeds else '1',
            'ControlGroup':'/system.slice/'+unit+'.service'}
    def fake_sample(directory, cpus, elapsed):
        assert directory == process['directory'].resolve() and cpus == [0,1,2,3]
        return {'memory_events':{'oom_kill':0},'cpu':{'usage_usec':process['reads']},'elapsed_seconds':elapsed}
    with patch.object(p,'ROOT',root), patch.object(p,'CGROUP_ROOT',cgroup), patch.object(p.sys,'platform','linux'), \
        patch.object(p.os,'geteuid',return_value=0), patch.object(p.os,'chown'), \
        patch.object(p.os,'sched_getaffinity',return_value={0,1,2,3},create=True), \
        patch.object(p.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=1001,pw_gid=1001,pw_name='runner')), \
        patch.object(p,'run',side_effect=fake_run), patch.object(p,'unit_properties',side_effect=fake_state), \
        patch.object(p,'sample',side_effect=fake_sample), patch.object(p.time,'sleep'), \
        patch.object(p,'stop_unit',return_value=True) as stop:
        status=p.supervisor(args)
    reports=list(root.glob('artifacts/verification/performance-pilot/*/pilot-result.json'))
    assert len(reports) == 1
    report=json.loads(reports[0].read_text())
    assert report['tree'] == 'b'*40 and report['commit'] == 'a'*40
    assert report['sample_count'] == 3 and report['post_harness_resource_sample']['cpu']['usage_usec'] == 2, report
    assert report['scratch_retained'] is True and process['scratch'].exists()
    assert report['authentication_database_uploaded'] is False and report['performance_gate'] is False
    if succeeds:
        assert status == 0 and report['status'] == 'PILOT_PASSED'
        assert report['unknown_writer_outcome'] is False and report['forced_stop'] is False
        assert ['systemctl','stop',process['unit']] in calls
        stop.assert_not_called()
    else:
        assert status == 1 and report['status'] == 'FAILED'
        assert report['unknown_writer_outcome'] is False and report['forced_stop'] is False
        assert report['retained_backup_verified'] is True
        assert (reports[0].parent/'synthetic/final-workbench.db').exists()
        stop.assert_not_called()
`));
