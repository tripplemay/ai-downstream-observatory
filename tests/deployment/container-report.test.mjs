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
const manifest = readFileSync(join(root, 'migrations/manifest.json'), 'utf8');
const publisherProof = { schema_version: 'monthly-publisher-smoke-v1', publisher_path: '/app/worker-bridge/monthly-evaluation.mjs',
  bundle_sha256: 'b'.repeat(64), node_version: 'v22.0.0', sqlite_schema_version: JSON.parse(manifest).migrations.length,
  runtime_uid: 10001, native_sqlite_loaded: true, invalid_lease_rejected: true, logical_database_unchanged: true };
const csvPublisherProof = { ...publisherProof, schema_version: 'csv-background-publisher-smoke-v1',
  publisher_path: '/app/worker-bridge/csv-background.mjs', bundle_sha256: 'f'.repeat(64),
  normal_csv_execution_verified: false, os_network_namespace_isolation: false };
const publisherEnvelope = { monthly: publisherProof, csv: csvPublisherProof };
const verifierProof = { schema_version: 'verification-container-smoke-v1', status: 'passed', runtime_uid: 10001,
  sqlite_schema_version: JSON.parse(manifest).migrations.length, source_manifest_sha256: 'c'.repeat(64),
  bundle_path: '/app/web/dist/governance-fixture.mjs', bundle_sha256: 'd'.repeat(64), sidecar_sha256: 'e'.repeat(64), source_file_count: 100,
  web_worker_sources_equal: true, network_disabled: true, credentials_present: false, verifier_role_isolated: true,
  fixed_node_fixture_executed: true, normal_ts_request: true, independent_ts_proof: true,
  persisted_blob_rechecked: true, request_financial_rows: 0, acceptance_scope: 'engineering_subcheck',
  data_provenance: 'synthetic', gate_eligible: false, completed_requirements: [] };
const mode = file => statSync(file).mode & 0o777;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'etf-container-report-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'migrations'), { mode: 0o700 });
  writeFileSync(join(directory, 'migrations/manifest.json'), manifest, { mode: 0o600 });
  const report = join(directory, 'artifacts', 'verification', `container-${runId}.json`);
  const run = (extra = {}, id = runId, webImage = image, publisher = JSON.stringify(publisherEnvelope), verifier = JSON.stringify(verifierProof)) => {
    const env = { ...process.env }; delete env.SUDO_UID; delete env.SUDO_GID;
    return spawnSync(process.env.WORKBENCH_PYTHON || 'python3', ['-c', code, directory, id, webImage, image, publisher, verifier], { env: { ...env, ...extra }, encoding: 'utf8' });
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
  assert.deepEqual(JSON.parse(readFileSync(f.report, 'utf8')), { run_id: runId, status: 'passed', non_root: true, missing_bind_source_rejected: true, legacy_actual_facts: 0, encrypted_local_restore: true, independent_host_restore: false, web_image: image, worker_image: image, monthly_publisher: publisherProof, csv_publisher: csvPublisherProof, governance_verifier: verifierProof });
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

test('container reports require complete current-schema runtime proof rather than defaulting missing checks to PASS', t => {
  const f = fixture(t);
  const missing = { ...publisherProof }; delete missing.invalid_lease_rejected;
  for (const proof of [null, {}, missing, { ...publisherProof, extra: true },
    { ...publisherProof, publisher_path: '/tmp/untrusted-publisher.mjs' },
    { ...publisherProof, bundle_sha256: 'invalid' }, { ...publisherProof, node_version: 'v20.0.0' },
    { ...publisherProof, sqlite_schema_version: publisherProof.sqlite_schema_version - 1 },
    { ...publisherProof, sqlite_schema_version: String(publisherProof.sqlite_schema_version) },
    { ...publisherProof, runtime_uid: 0 },
    ...['native_sqlite_loaded', 'invalid_lease_rejected', 'logical_database_unchanged'].flatMap(key => [
      { ...publisherProof, [key]: false }, { ...publisherProof, [key]: 1 },
    ])]) {
    const result = f.run({}, runId, image, JSON.stringify({ ...publisherEnvelope, monthly: proof }));
    assert.notEqual(result.status, 0, JSON.stringify(proof));
    assert.match(result.stderr, /runtime proof is missing or invalid/);
    assert.equal(existsSync(join(f.directory, 'artifacts')), false);
  }
  for (const raw of ['', '{', ' '.repeat(4097)]) {
    assert.notEqual(f.run({}, runId, image, raw).status, 0);
    assert.equal(existsSync(join(f.directory, 'artifacts')), false);
  }
});

test('container publisher envelope cannot omit either fixed publisher or silently accept the old monthly-only format', t => {
  const f = fixture(t);
  for (const envelope of [null, {}, publisherProof, { monthly: publisherProof }, { csv: csvPublisherProof }, { ...publisherEnvelope, extra: true }]) {
    const result = f.run({}, runId, image, JSON.stringify(envelope));
    assert.notEqual(result.status, 0, JSON.stringify(envelope));
    assert.match(result.stderr, /runtime proof is missing or invalid/);
    assert.equal(existsSync(join(f.directory, 'artifacts')), false);
  }
});

test('CSV container proof requires exact identity, current runtime and honest unverified execution boundaries', t => {
  const f = fixture(t);
  const missing = Object.keys(csvPublisherProof).map(key => { const proof = { ...csvPublisherProof }; delete proof[key]; return proof; });
  for (const proof of [null, {}, ...missing, { ...csvPublisherProof, extra: true },
    { ...csvPublisherProof, schema_version: publisherProof.schema_version },
    { ...csvPublisherProof, publisher_path: publisherProof.publisher_path },
    { ...csvPublisherProof, publisher_path: '/tmp/untrusted-csv-publisher.mjs' },
    { ...csvPublisherProof, bundle_sha256: 'invalid' }, { ...csvPublisherProof, bundle_sha256: 'F'.repeat(64) },
    { ...csvPublisherProof, node_version: 'v20.0.0' }, { ...csvPublisherProof, node_version: 'v22.0.1' },
    { ...csvPublisherProof, sqlite_schema_version: csvPublisherProof.sqlite_schema_version - 1 },
    { ...csvPublisherProof, sqlite_schema_version: String(csvPublisherProof.sqlite_schema_version) },
    { ...csvPublisherProof, runtime_uid: 0 }, { ...csvPublisherProof, runtime_uid: '10001' },
    ...['native_sqlite_loaded', 'invalid_lease_rejected', 'logical_database_unchanged'].flatMap(key => [
      { ...csvPublisherProof, [key]: false }, { ...csvPublisherProof, [key]: 1 }, { ...csvPublisherProof, [key]: 'true' },
    ]),
    ...['normal_csv_execution_verified', 'os_network_namespace_isolation'].flatMap(key => [
      { ...csvPublisherProof, [key]: true }, { ...csvPublisherProof, [key]: 0 }, { ...csvPublisherProof, [key]: 'false' },
    ]),
  ]) {
    const result = f.run({}, runId, image, JSON.stringify({ ...publisherEnvelope, csv: proof }));
    assert.notEqual(result.status, 0, JSON.stringify(proof));
    assert.match(result.stderr, /runtime proof is missing or invalid/);
    assert.equal(existsSync(join(f.directory, 'artifacts')), false);
  }
});

test('container report cannot omit verifier runtime proof or upgrade synthetic engineering scope', t => {
  const f = fixture(t), missing = { ...verifierProof }; delete missing.fixed_node_fixture_executed;
  for (const proof of [null, {}, missing, { ...verifierProof, extra: true }, { ...verifierProof, gate_eligible: true },
    { ...verifierProof, completed_requirements: ['E-02'] }, { ...verifierProof, acceptance_scope: 'gate' },
    { ...verifierProof, credentials_present: true }, { ...verifierProof, network_disabled: false },
    { ...verifierProof, source_file_count: '100' }, { ...verifierProof, source_manifest_sha256: 'invalid' },
    { ...verifierProof, bundle_path: '/app/worker-bridge/governance-fixture.mjs' }, { ...verifierProof, sqlite_schema_version: 20 }]) {
    const result = f.run({}, runId, image, JSON.stringify(publisherEnvelope), JSON.stringify(proof));
    assert.notEqual(result.status, 0, JSON.stringify(proof)); assert.match(result.stderr, /Governance verifier runtime proof is missing or invalid/);
    assert.equal(existsSync(join(f.directory, 'artifacts')), false);
  }
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
