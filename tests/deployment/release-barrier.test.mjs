import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.WORKBENCH_TEST_PYTHON || 'python3';
const helper = join(root, 'scripts/release-barrier.py');

function fixture(t, program) {
  const directory = mkdtempSync(join(tmpdir(), 'release-barrier-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['data', 'release-evidence']) mkdirSync(join(directory, name), { mode: 0o700 });
  const bootstrap = `import importlib.util,json,os,pathlib,stat,sys\n` +
    `spec=importlib.util.spec_from_file_location('release_barrier',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n` +
    `r=pathlib.Path(sys.argv[2]).resolve();uid=os.getuid();gid=os.getgid();sha='a'*40;data=r/'data'\n`;
  const result = spawnSync(python, ['-c', bootstrap + program, helper, directory], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return { directory, result };
}

test('cutover write-ahead intent is durable, source-bound and cannot be silently reused', t => {
  const { directory } = fixture(t, `e=r/'release-evidence'/ (sha+'-20261107T000000Z');e.mkdir(mode=0o700)
x=m.begin_cutover(e,data,sha,'etf-workbench',operator_uid=uid,app_uid=uid)
assert x['format']=='etf-release-cutover-intent-v1' and x['release_sha']==sha and x['data_dir']==str(data)
assert x['project']=='etf-workbench' and x['database_overwritten'] is False
p=e/'cutover-started.json';assert stat.S_IMODE(p.stat().st_mode)==0o600
before=p.read_bytes()
try:m.begin_cutover(e,data,sha,'etf-workbench',operator_uid=uid,app_uid=uid)
except FileExistsError:pass
else:raise AssertionError('ambiguous cutover may not restart')
assert p.read_bytes()==before
`);
  const intent = JSON.parse(readFileSync(join(directory, 'release-evidence', 'a'.repeat(40) + '-20261107T000000Z', 'cutover-started.json'), 'utf8'));
  assert.equal(intent.project, 'etf-workbench');
});

test('recovery fence is private, app-owned and never changes a preexisting review or database', t => {
  fixture(t, `db=data/'etf-workbench.db';db.write_bytes(b'original financial facts')
x=m.fence_release(data,sha,app_uid=uid,app_gid=gid)
p=data/'RESTORE_PENDING_REVIEW';before=p.read_bytes()
assert x['created'] is True and p.stat().st_uid==uid and stat.S_IMODE(p.stat().st_mode)==0o600
y=m.fence_release(data,'b'*40,app_uid=uid,app_gid=gid)
assert y['created'] is False and p.read_bytes()==before and db.read_bytes()==b'original financial facts'
`);
});

test('existing symlink or hardlink marker is rejected without following or overwriting it', t => {
  fixture(t, `outside=r/'preserved';outside.write_bytes(b'unchanged private file');p=data/'RESTORE_PENDING_REVIEW'
for kind in ['symlink','hardlink']:
 if kind=='symlink':p.symlink_to(outside)
 else:os.link(outside,p)
 try:m.fence_release(data,sha,app_uid=uid,app_gid=gid)
 except ValueError:pass
 else:raise AssertionError('unsafe marker')
 assert outside.read_bytes()==b'unchanged private file'
 p.unlink()
`);
});

test('alias, broad permissions and invalid identity cannot create a marker or intent', t => {
  fixture(t, `alias=r/'alias';alias.symlink_to(data,target_is_directory=True)
for path,identifier in [(alias,sha),(data,'not-a-sha')]:
 try:m.fence_release(path,identifier,app_uid=uid,app_gid=gid)
 except ValueError:pass
 else:raise AssertionError('unsafe target')
os.chmod(data,0o755)
try:m.fence_release(data,sha,app_uid=uid,app_gid=gid)
except ValueError:pass
else:raise AssertionError('broad data directory')
os.chmod(data,0o700)
e=r/'release-evidence'/ ('b'*40+'-20261107T000000Z');e.mkdir(mode=0o700)
try:m.begin_cutover(e,data,sha,'etf-workbench',operator_uid=uid,app_uid=uid)
except ValueError:pass
else:raise AssertionError('wrong evidence identity')
assert not (data/'RESTORE_PENDING_REVIEW').exists() and not (e/'cutover-started.json').exists()
`);
});

test('unsafe existing marker permissions reject without replacing the review bytes', t => {
  fixture(t, `p=data/'RESTORE_PENDING_REVIEW';p.write_bytes(b'original review');os.chmod(p,0o644)
try:m.fence_release(data,sha,app_uid=uid,app_gid=gid)
except ValueError:pass
else:raise AssertionError('unsafe marker permissions')
assert p.read_bytes()==b'original review' and stat.S_IMODE(p.stat().st_mode)==0o644
`);
});

test('an interrupted intent write leaves no permission to continue and never claims success', t => {
  fixture(t, `e=r/'release-evidence'/ (sha+'-20261107T000000Z');e.mkdir(mode=0o700)
sync=m.os.fsync
def fail(fd):raise OSError('fictional fsync failure')
m.os.fsync=fail
try:m.begin_cutover(e,data,sha,'etf-workbench',operator_uid=uid,app_uid=uid)
except OSError:pass
else:raise AssertionError('fsync must be required')
finally:m.os.fsync=sync
assert not (data/'RESTORE_PENDING_REVIEW').exists()
try:m.begin_cutover(e,data,sha,'etf-workbench',operator_uid=uid,app_uid=uid)
except FileExistsError:pass
else:raise AssertionError('unknown intent cannot be retried implicitly')
`);
});

test('production CLI accepts no caller-selected ownership or unprivileged recovery override', t => {
  const directory = mkdtempSync(join(tmpdir(), 'release-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'preserved'), 'SYNTHETIC PRESERVED DATA');
  const result = spawnSync(python, [helper, 'fence', '--data-dir', directory, '--release', 'a'.repeat(40), '--app-uid', String(process.getuid())], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(directory, 'preserved'), 'utf8'), 'SYNTHETIC PRESERVED DATA');
});
