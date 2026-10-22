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
temporary=tempfile.TemporaryDirectory();base=pathlib.Path(temporary.name)
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
