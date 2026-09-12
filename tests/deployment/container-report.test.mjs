import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(join(root, 'tests/deployment/container-smoke.sh'), 'utf8');
const code = source.match(/<<'PY_REPORT'\n([\s\S]*?)\nPY_REPORT/)?.[1];
assert.ok(code, 'exercise the report implementation embedded in the actual smoke script');
const runId = '20260105T120000Z-123', image = `sha256:${'a'.repeat(64)}`;
const mode = file => statSync(file).mode & 0o777;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'etf-container-report-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const report = join(directory, 'artifacts', 'verification', `container-${runId}.json`);
  const run = (extra = {}, id = runId, webImage = image) => {
    const env = { ...process.env }; delete env.SUDO_UID; delete env.SUDO_GID;
    return spawnSync(process.env.WORKBENCH_PYTHON || 'python3', ['-c', code, directory, id, webImage, image], { env: { ...env, ...extra }, encoding: 'utf8' });
  };
  return { directory, report, run };
}

test('container report handoff gives the caller a bounded 0600 JSON without exposing fixture secrets', t => {
  const f = fixture(t), secrets = join(f.directory, 'separate-fixture'); mkdirSync(secrets, { mode: 0o700 });
  const secret = join(secrets, 'backup.passphrase'); writeFileSync(secret, 'SYNTHETIC-NOT-A-REAL-KEY', { mode: 0o600 });
  const result = f.run({ SUDO_UID: String(process.getuid()), SUDO_GID: String(process.getgid()) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(mode(join(f.directory, 'artifacts')), 0o700); assert.equal(mode(dirname(f.report)), 0o700); assert.equal(mode(f.report), 0o600);
  assert.equal(statSync(f.report).uid, process.getuid()); assert.equal(statSync(f.report).gid, process.getgid());
  assert.equal(mode(secrets), 0o700); assert.equal(mode(secret), 0o600);
  assert.deepEqual(JSON.parse(readFileSync(f.report, 'utf8')), { run_id: runId, status: 'passed', non_root: true, legacy_actual_facts: 0, encrypted_local_restore: true, independent_host_restore: false, web_image: image, worker_image: image });
  assert.doesNotMatch(readFileSync(f.report, 'utf8'), /SYNTHETIC-NOT-A-REAL-KEY/);
});

test('ordinary invocation keeps existing caller-owned directory modes and unrelated reports untouched', t => {
  const f = fixture(t), artifacts = join(f.directory, 'artifacts'), verification = dirname(f.report);
  mkdirSync(artifacts, { mode: 0o750 }); mkdirSync(verification, { mode: 0o700 }); chmodSync(artifacts, 0o750);
  const existing = join(verification, 'existing.json'); writeFileSync(existing, 'SYNTHETIC existing report', { mode: 0o600 });
  const before = lstatSync(existing), result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(mode(artifacts), 0o750); assert.equal(mode(verification), 0o700);
  assert.equal(readFileSync(existing, 'utf8'), 'SYNTHETIC existing report'); assert.equal(lstatSync(existing).uid, before.uid); assert.equal(lstatSync(existing).mtimeMs, before.mtimeMs);
});

test('malformed or partial sudo identities and injected metadata fail before creating reports', t => {
  const f = fixture(t);
  for (const env of [{ SUDO_UID: '1' }, { SUDO_GID: '1' }, { SUDO_UID: '', SUDO_GID: '1' }, { SUDO_UID: '-1', SUDO_GID: '1' }, { SUDO_UID: '1x', SUDO_GID: '1' }, { SUDO_UID: '4294967295', SUDO_GID: '1' }]) assert.notEqual(f.run(env).status, 0);
  assert.notEqual(f.run({}, '../outside').status, 0); assert.notEqual(f.run({}, runId, 'sha256:invalid').status, 0);
  assert.equal(existsSync(join(f.directory, 'artifacts')), false);
});

for (const level of ['artifacts', 'verification']) test(`report handoff refuses a symlinked ${level} directory`, t => {
  const f = fixture(t), outside = join(f.directory, 'unrelated'); mkdirSync(outside, { mode: 0o700 });
  if (level === 'verification') mkdirSync(join(f.directory, 'artifacts'), { mode: 0o700 });
  symlinkSync(outside, level === 'artifacts' ? join(f.directory, 'artifacts') : dirname(f.report));
  assert.notEqual(f.run().status, 0); assert.equal(existsSync(join(outside, `container-${runId}.json`)), false); assert.equal(mode(outside), 0o700);
});

for (const symlink of [false, true]) test(`report handoff never overwrites an existing ${symlink ? 'symlink' : 'regular file'}`, t => {
  const f = fixture(t); mkdirSync(dirname(f.report), { recursive: true, mode: 0o700 });
  const original = symlink ? join(f.directory, 'unrelated-original') : f.report;
  writeFileSync(original, 'SYNTHETIC original', { mode: 0o600 }); if (symlink) symlinkSync(original, f.report);
  assert.notEqual(f.run().status, 0); assert.equal(readFileSync(original, 'utf8'), 'SYNTHETIC original'); assert.equal(lstatSync(f.report).isSymbolicLink(), symlink);
});

test('other-writable report directories are rejected rather than recursively repaired', t => {
  const f = fixture(t), artifacts = join(f.directory, 'artifacts'); mkdirSync(artifacts); chmodSync(artifacts, 0o777);
  assert.notEqual(f.run().status, 0); assert.equal(mode(artifacts), 0o777); assert.equal(existsSync(f.report), false);
});
