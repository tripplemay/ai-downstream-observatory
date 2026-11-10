import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const prelude = `
import importlib.util,hashlib,pathlib,sqlite3,tempfile,types
spec=importlib.util.spec_from_file_location('capacity', 'scripts/check-release-capacity.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
temporary=tempfile.TemporaryDirectory();base=pathlib.Path(temporary.name).resolve()
data=base/'data';backup=base/'backup';restore=base/'restore'
for folder in (data,backup,restore):folder.mkdir()
with sqlite3.connect(data/'etf-workbench.db') as db:
    db.execute('CREATE TABLE attachments(byte_size INTEGER)')
    db.execute('INSERT INTO attachments VALUES(12345)')
(data/'auth.sqlite').write_bytes(b'x'*1234)
`;
function python(source) {
  const run = spawnSync(process.env.WORKBENCH_PYTHON || 'python3', ['-c', prelude + source],
    { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
}

test('capacity estimate includes archived attachments, auth, WAL and padding without changing the source database', () => python(`
before=hashlib.sha256((data/'etf-workbench.db').read_bytes()).hexdigest()
expected=(data/'etf-workbench.db').stat().st_size+12345+1234+1024**2
assert module.payload_bytes(data)==expected
(data/'auth.sqlite-wal').write_bytes(b'y'*321)
assert module.payload_bytes(data)==expected+321
assert hashlib.sha256((data/'etf-workbench.db').read_bytes()).hexdigest()==before
assert list(backup.iterdir())==[] and list(restore.iterdir())==[]
`));

test('shared filesystem combines backup and restore workspace and fails below the exact boundary', () => python(`
payload=module.payload_bytes(data);required=6*payload+module.HEADROOM_BYTES
report=module.check_capacity(data,backup,restore,usage=lambda unused:types.SimpleNamespace(free=required),device=lambda unused:1)
assert report['status']=='sufficient' and len(report['volumes'])==1
assert report['volumes'][0]['required_bytes']==required
report=module.check_capacity(data,backup,restore,usage=lambda unused:types.SimpleNamespace(free=required-1),device=lambda unused:1)
assert report['status']=='insufficient' and not report['cleanup_performed']
`));

test('separate filesystems are evaluated separately rather than borrowing free space from another volume', () => python(`
payload=module.payload_bytes(data)
usage=lambda path:types.SimpleNamespace(free=(4 if path==backup else 2)*payload+module.HEADROOM_BYTES)
report=module.check_capacity(data,backup,restore,usage=usage,device=lambda path:1 if path==backup else 2)
assert report['status']=='sufficient' and len(report['volumes'])==2
usage=lambda path:types.SimpleNamespace(free=100*payload+module.HEADROOM_BYTES if path==backup else 1)
assert module.check_capacity(data,backup,restore,usage=usage,device=lambda path:1 if path==backup else 2)['status']=='insufficient'
`));

test('after the online backup succeeds, only future staging is reserved rather than counting its retained archive twice', () => python(`
payload=module.payload_bytes(data);remaining=5*payload+module.HEADROOM_BYTES
usage=lambda unused:types.SimpleNamespace(free=remaining)
assert module.check_capacity(data,backup,restore,usage=usage,device=lambda unused:1)['status']=='insufficient'
after=module.check_capacity(data,backup,restore,stage='after_online_backup',usage=usage,device=lambda unused:1)
assert after['status']=='sufficient' and after['volumes'][0]['required_bytes']==remaining
assert module.check_capacity(data,backup,restore,stage='after_online_backup',usage=lambda unused:types.SimpleNamespace(free=remaining-1),device=lambda unused:1)['status']=='insufficient'
try:module.check_capacity(data,backup,restore,stage='unknown')
except ValueError:pass
else:raise AssertionError('unknown capacity stage accepted')
`));

test('missing databases, unsafe file types and invalid attachment sizes are not treated as zero-byte payloads', () => python(`
(data/'auth.sqlite').unlink();(data/'auth.sqlite').symlink_to(data/'etf-workbench.db')
try:module.payload_bytes(data)
except ValueError:pass
else:raise AssertionError('symlink accepted')
(data/'auth.sqlite').unlink()
with sqlite3.connect(data/'etf-workbench.db') as db:db.execute('UPDATE attachments SET byte_size=-1')
try:module.payload_bytes(data)
except ValueError:pass
else:raise AssertionError('invalid attachment size accepted')
(data/'etf-workbench.db').unlink()
try:module.payload_bytes(data)
except ValueError:pass
else:raise AssertionError('missing database accepted')
`));

test('release checks capacity after image building and again before stopping existing writers without pruning automatically', () => {
  const source = readFileSync(join(root, 'scripts/deploy-workbench.sh'), 'utf8');
  const first = source.indexOf('if ((first_release == 0)); then assert_release_capacity');
  const second = source.indexOf('assert_release_capacity after_online_backup > "$evidence/capacity-before-stop.json"');
  assert.ok(source.indexOf('build --pull') < first && first < source.indexOf('pre-stop-backup.json'));
  assert.ok(source.indexOf('pre-stop-backup.json') < second && second < source.indexOf('writers_stopped=1', second));
  assert.doesNotMatch(source, /(?:builder|buildx|image|system|container|volume) prune/);
});

const uploadPrelude = `
incoming=base/'incoming';releases=base/'releases';docker=base/'docker'
for folder in (incoming,releases,docker):folder.mkdir()
budget={'format':'etf-upload-budget-v1','release_sha':'a'*40,'image_archive_bytes':1000,
 'image_archive_sha256':'b'*64,'image_content_bytes':2000,'image_expanded_bytes':5000,
 'source_archive_bytes':123,'source_archive_sha256':'c'*64,'source_expanded_bytes':789}
paths=(data,backup,restore,incoming,releases,docker)
`;
test('before-upload peak includes transport, source, nested layer expansion and the unchanged full recovery reserve', () => python(uploadPrelude + `
payload=module.payload_bytes(data)
transfer=1123+2*1024**2;source=789+1024**2;retained=7000+64*1024**2
required=module.HEADROOM_BYTES+transfer+source+retained+max(5000,6*payload)
run=lambda free:module.check_upload_capacity(*paths,budget,usage=lambda unused:types.SimpleNamespace(free=free),device=lambda unused:1)
report=run(required)
assert report['status']=='sufficient' and report['stage']=='before_upload' and not report['cleanup_performed']
assert len(report['volumes'])==1 and report['volumes'][0]['required_bytes']==required
assert report['volumes'][0]['backup_restore_bytes']==required
assert run(required-1)['status']=='insufficient'
assert list(incoming.iterdir())==[] and list(backup.iterdir())==[] and list(docker.iterdir())==[]
# When import is the larger phase, do not add future backup space to a temporary copy that is already gone.
budget['image_expanded_bytes']=10**8
report=module.check_upload_capacity(*paths,budget,usage=lambda unused:types.SimpleNamespace(free=10**12),device=lambda unused:1)
row=report['volumes'][0];assert row['required_bytes']==row['image_import_bytes']>row['backup_restore_bytes']
`));
test('upload, Docker and restore devices cannot borrow another device capacity, and invalid budgets fail closed', () => python(uploadPrelude + `
devices={incoming:1,releases:2,docker:3,backup:4,restore:5}
report=module.check_upload_capacity(*paths,budget,usage=lambda unused:types.SimpleNamespace(free=10**12),device=lambda path:devices[path])
assert len(report['volumes'])==5
for blocked in devices:
 result=module.check_upload_capacity(*paths,budget,usage=lambda path:types.SimpleNamespace(free=0 if path==blocked else 10**12),device=lambda path:devices[path])
 assert result['status']=='insufficient'
for field,value in [('image_expanded_bytes',True),('image_expanded_bytes',1999),('image_archive_bytes',0),('source_expanded_bytes',2**40),('image_archive_sha256','bad'),('extra',1)]:
 invalid={**budget,field:value}
 try:module.check_upload_capacity(*paths,invalid)
 except ValueError:pass
 else:raise AssertionError('invalid budget accepted')
(base/'alias').symlink_to(docker,target_is_directory=True)
try:module.check_upload_capacity(data,backup,restore,incoming,releases,base/'alias',budget)
except ValueError:pass
else:raise AssertionError('aliased Docker storage accepted')
`));
test('protected workflow measures and checks exact upload before any remote staging while retaining late gates and budgets', () => {
  const source = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8');
  const measure = source.indexOf('release-image-bundle.py budget');
  const check = source.indexOf('python3 - --pre-upload-root');
  const create = source.indexOf('mkdir -p', check);
  assert.ok(measure > source.indexOf('sha256sum release.tar.gz'));
  assert.ok(measure < check && check < create && create < source.indexOf('scp -o', create));
  assert.match(source, /< scripts\/check-release-capacity\.py/);
  assert.match(source, /timeout-minutes: 75/);
  assert.match(source, /environment: production/);
  assert.doesNotMatch(source, /(?:image|builder|system|volume) prune/);
});
