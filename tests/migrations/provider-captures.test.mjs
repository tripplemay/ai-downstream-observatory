import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'web/package.json'));
const Database = require('better-sqlite3');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const sha = value => createHash('sha256').update(value).digest('hex');
const start = '2026-01-02T09:00:00.000000Z';
const received = '2026-01-02T09:00:01.000000Z';
const created = '2026-01-02T09:00:02.000000Z';
const leaseUntil = '2026-01-02T09:01:00.000000Z';
const insert = (db, table, row, prefix = 'INSERT') => db.prepare(`${prefix} INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?')})`).run(...Object.values(row));
const payload = () => ({ provider: 'ecb', feed: 'daily', currencies: ['USD'], expected_publication_revision: 0, publish: true });

function copyMigrations(directory, version) {
  const destination = join(directory, `migrations-v${version}`);
  mkdirSync(destination);
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'), 'utf8'));
  assert.ok(manifest.migrations.length >= version);
  const migrations = manifest.migrations.slice(0, version);
  for (const item of migrations) cpSync(join(migrationDirectory, item.file), join(destination, item.file));
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ ...manifest, migrations }));
  return destination;
}

function fixture(t, version = 16) {
  const directory = mkdtempSync(join(tmpdir(), 'provider-captures-migration-'));
  const filename = join(directory, 'workbench.db');
  const migrations = copyMigrations(directory, version);
  migrateWorkbench(filename, { directory: migrations });
  const db = new Database(filename);
  db.pragma('foreign_keys=ON'); db.pragma('recursive_triggers=OFF');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, directory, filename, migrations };
}

function worker(db, suffix = '', patch = {}) {
  const portfolio = `portfolio${suffix}`, commandId = `command${suffix}`, jobId = `job${suffix}`;
  insert(db, 'portfolios', { id: portfolio, name: 'Synthetic provider migration fixture', created_at: start });
  const body = JSON.stringify(payload());
  insert(db, 'command_requests', { id: commandId, portfolio_id: portfolio, command_type: 'market_collect',
    idempotency_key: `synthetic-key${suffix}`, payload_hash: sha(body), payload_json: body,
    actor_id: 'synthetic-human', created_at: start });
  insert(db, 'job_runs', { id: jobId, command_request_id: commandId, job_type: 'market_collect', scope: portfolio,
    period: 'synthetic-capture', input_version: commandId, status: 'running', max_attempts: 3, attempt_count: 1,
    not_before: start, created_at: start, updated_at: start, lease_owner: 'synthetic-worker',
    lease_until: leaseUntil, fencing_token: 1, ...patch });
  insert(db, 'job_attempts', { id: `attempt${suffix}`, job_id: jobId, attempt: 1, fencing_token: 1, status: 'running', started_at: start });
  return { portfolio, commandId, jobId };
}

function material(suffix = '') {
  const captureId = `capture${suffix}`, batchId = `batch${suffix}`, commandId = `command${suffix}`, jobId = `job${suffix}`;
  const raw = Buffer.from('<synthetic-reference currency="USD" rate="8.0000"/>\n', 'utf8');
  const observation = { id: `observation${suffix}`, batch_id: batchId, source_id: 'provider:ecb:reference-fx',
    series_key: 'FX:USD', metric: 'fx_cny_per_unit', value: '8.0000', unit: 'CNY_per_unit_currency',
    observed_at: '2026-01-01', ingested_at: received, source_timezone: 'Europe/Berlin', time_precision: 'date',
    price_basis: 'not_applicable', revision_id: captureId, raw_hash: sha(raw), parser_version: 'ecb-reference-xml-v1', provenance: 'live_observed' };
  const plan = { id: batchId, source_id: observation.source_id, batch_type: 'fx', scope: 'provider:ecb:fx:daily:USD',
    expected_pages: 1, expected_rows: 1, expected_publication_revision: 0, source_mode: 'provider_observed', provider_capture_id: captureId };
  const document = { schema_version: 'market-provider-batch-v1', batch: plan, pages: [{ page_number: 1, observations: [observation] }] };
  const normalized = { schema_version: 'ecb-reference-rates-v1', source: { provider: 'ecb', feed: 'daily', raw_sha256: sha(raw),
    raw_bytes: raw.length, retrieved_at: received }, records: [{ rate_date: '2026-01-01', currency: 'USD', value_cny_per_unit: '8.0000' }] };
  const receipt = { schema_version: 'market-provider-capture-v1', id: captureId, batch_id: batchId, provider: 'ecb',
    capture_kind: 'http_response_bytes', command_request_id: commandId, job_id: jobId, attempt: 1, fencing_token: 1,
    request_hash: sha(JSON.stringify(payload())), request_started_at: start, received_at: received,
    endpoint: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', response_status: 200,
    response_headers: { 'content-type': 'application/xml' }, raw_sha256: sha(raw), raw_bytes: raw.length,
    parser_version: 'ecb-reference-xml-v1', normalized_hash: sha(JSON.stringify(normalized)), document_hash: sha(JSON.stringify(document)),
    rate_kind: 'reference_not_executable', publication_time_status: 'not_supplied', coverage_kind: 'returned_feed_dates_not_historical_calendar' };
  const capture = { id: captureId, batch_id: batchId, command_request_id: commandId, job_id: jobId, attempt: 1,
    raw_body: raw, receipt_json: JSON.stringify(receipt), receipt_hash: sha(JSON.stringify(receipt)),
    normalized_json: JSON.stringify(normalized), document_json: JSON.stringify(document), created_at: created };
  const batch = { id: batchId, source_id: plan.source_id, batch_type: plan.batch_type, scope: plan.scope, status: 'staging',
    expected_pages: plan.expected_pages, validation_json: JSON.stringify({ plan }), started_at: start };
  return { receipt, document, normalized, plan, observation, capture, batch };
}

function save(db, value = material()) {
  db.transaction(() => { insert(db, 'market_provider_captures', value.capture); insert(db, 'market_batches', value.batch); }).immediate();
}

function rejectCapture(db, row, message) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Assert the INSERT itself rejects, not a later deferred FK failure at COMMIT.
    assert.throws(() => insert(db, 'market_provider_captures', row), undefined, message);
  } finally { db.exec('ROLLBACK'); }
}

function receiptPatch(value, patch) {
  const receipt_json = JSON.stringify({ ...value.receipt, ...patch });
  return { ...value.capture, receipt_json, receipt_hash: sha(receipt_json) };
}

function snapshot(db, names) {
  names ??= db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  return names.map(name => {
    const columns = db.pragma(`table_info(${name})`).map(row => row.name);
    const bytes = columns.map((column, n) => `typeof("${column}") AS t${n},hex(CAST("${column}" AS BLOB)) AS b${n}`).join(',');
    return { name, columns, rows: db.prepare(`SELECT ${bytes} FROM "${name}" ORDER BY rowid`).all() };
  });
}

test('v15 to v16 preserves every old table value byte and creates no captures, ledger facts, or approvals; retry is zero-write', t => {
  const f = fixture(t, 15);
  worker(f.db);
  insert(f.db, 'legacy_archives', { id: 'legacy-synthetic', source_database_hash: sha('synthetic-database'), source_table: 'synthetic',
    source_key: 'synthetic-row', source_row_json: ' { "synthetic": "precision spelling retained" }\n', content_hash: sha('synthetic'),
    environment: 'legacy', provenance_json: '{ "fixture": true }', archived_at: start });
  insert(f.db, 'market_batches', { id: 'existing-manual', source_id: 'synthetic', batch_type: 'fx', scope: 'synthetic-scope',
    status: 'staging', expected_pages: 1, validation_json: '{ "original": true }', started_at: start });
  const before = snapshot(f.db).filter(row => row.name !== 'schema_migrations');
  const target = copyMigrations(f.directory, 16);
  assert.equal(migrateWorkbench(f.filename, { directory: target }).applied, 1);
  assert.deepEqual(snapshot(f.db, before.map(row => row.name)), before);
  for (const table of ['market_provider_captures', 'ledger_events', 'postings', 'position_movements', 'proposals', 'approval_events', 'reservations'])
    assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  const after = snapshot(f.db), changes = f.db.prepare('SELECT total_changes() n').get().n;
  f.db.pragma('wal_checkpoint(TRUNCATE)');
  const dbHash = sha(readFileSync(f.filename));
  assert.equal(migrateWorkbench(f.filename, { directory: target }).applied, 0);
  assert.equal(sha(readFileSync(f.filename)), dbHash);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
  assert.deepEqual(snapshot(f.db), after);
  assert.equal(verifyWorkbenchSchema(f.db, target).version, 16);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  assert.equal(f.db.pragma('quick_check', { simple: true }), 'ok');
});

test('capture and matching provider batch commit atomically only for the current running job attempt', t => {
  const { db } = fixture(t); worker(db);
  const value = material(); save(db, value);
  assert.deepEqual(db.prepare('SELECT raw_body FROM market_provider_captures').get().raw_body, value.capture.raw_body);
  assert.equal(db.prepare('SELECT receipt_json FROM market_provider_captures').get().receipt_json, value.capture.receipt_json);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM market_batches').get().n, 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  for (const table of ['ledger_events', 'postings', 'proposals', 'approval_events', 'reservations'])
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
});

test('capture scope, command identity, receipt identifiers, attempt, fencing and lease mismatches reject before commit', t => {
  const { db } = fixture(t); worker(db); worker(db, '-other');
  const value = material();
  for (const patch of [{ id: 'other' }, { batch_id: 'other' }, { job_id: 'job-other' }, { command_request_id: 'command-other' },
    { attempt: 2 }, { fencing_token: 2 }, { request_hash: sha('other') }])
    rejectCapture(db, receiptPatch(value, patch), JSON.stringify(patch));
  for (const patch of [{ job_id: 'missing' }, { command_request_id: 'missing' }, { attempt: 2 }, { job_id: 'job-other' }])
    rejectCapture(db, { ...value.capture, ...patch }, JSON.stringify(patch));
  for (const [column, bad] of [['status', 'queued'], ['job_type', 'valuation'], ['scope', 'portfolio-other'],
    ['fencing_token', 2], ['attempt_count', 2], ['lease_until', created], ['lease_owner', null]]) {
    const original = db.prepare(`SELECT ${column} value FROM job_runs WHERE id='job'`).get().value;
    db.prepare(`UPDATE job_runs SET ${column}=? WHERE id='job'`).run(bad);
    rejectCapture(db, value.capture, `job ${column}`);
    db.prepare(`UPDATE job_runs SET ${column}=? WHERE id='job'`).run(original);
  }
  db.exec("UPDATE job_attempts SET status='failed' WHERE id='attempt'");
  rejectCapture(db, value.capture, 'terminal job attempt');
});

test('capture time proof cannot predate its actual attempt, run backwards, exceed storage time, or outlive lease', t => {
  const { db } = fixture(t); worker(db); const value = material();
  for (const patch of [{ request_started_at: '2026-01-02T08:59:59.999999Z' },
    { received_at: '2026-01-02T08:59:59.999999Z' }, { received_at: '2026-01-02T09:00:03.000000Z' },
    { request_started_at: '2026-01-02T09:00:01.000000Z', received_at: start }])
    rejectCapture(db, receiptPatch(value, patch), JSON.stringify(patch));
  rejectCapture(db, { ...value.capture, created_at: leaseUntil }, 'capture at lease expiry');
  for (const timestamp of ['not-a-date', '2026-02-30T09:00:02.000000Z', '2026-01-02T09:00:02+00:00', '2026-01-02T09:00:02Z'])
    rejectCapture(db, { ...value.capture, created_at: timestamp }, `noncanonical storage instant ${timestamp}`);
});

test('capture requires bounded BLOB bytes, object JSON text, exact hash syntax, safe positive integer attempt', t => {
  const { db } = fixture(t); worker(db); const value = material();
  for (const raw_body of ['', 'synthetic', Buffer.alloc(0), Buffer.alloc(2097153), 1])
    rejectCapture(db, { ...value.capture, raw_body }, `raw body ${typeof raw_body}`);
  for (const field of ['receipt_json', 'normalized_json', 'document_json'])
    for (const content of ['{bad', 'null', '[]', '1', '"text"', Buffer.from('{}')])
      rejectCapture(db, { ...value.capture, [field]: content }, `${field} ${String(content)}`);
  for (const receipt_hash of ['a'.repeat(63), 'A'.repeat(64), 'z'.repeat(64), Buffer.alloc(64, 'a')])
    rejectCapture(db, { ...value.capture, receipt_hash }, 'receipt hash type/format');
  for (const attempt of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    rejectCapture(db, { ...value.capture, attempt }, 'attempt integer/range');
  for (const patch of [{ attempt: true }, { fencing_token: true }, { raw_bytes: 1.5 }, { raw_bytes: value.capture.raw_body.length + 1 }])
    rejectCapture(db, receiptPatch(value, patch), `receipt scalar ${JSON.stringify(patch)}`);
});

test('provider batch column identity and source must match captured plan; no unlinked privileged source can stage', t => {
  const { db } = fixture(t); worker(db); const value = material();
  for (const patch of [{}, { source_id: 'synthetic', scope: 'synthetic' }, { validation_json: '{}' },
    { source_id: 'PROVIDER:ecb:reference-fx' }])
    assert.throws(() => insert(db, 'market_batches', { ...value.batch, ...patch }));
  for (const patch of [{ source_id: 'provider:wrong' }, { scope: 'provider:wrong' }, { batch_type: 'prices' }, { expected_pages: 2 },
    { started_at: received }, { id: 'wrong-batch' }]) {
    db.exec('BEGIN IMMEDIATE');
    try {
      insert(db, 'market_provider_captures', value.capture);
      assert.throws(() => insert(db, 'market_batches', { ...value.batch, ...patch }), undefined, JSON.stringify(patch));
    } finally { db.exec('ROLLBACK'); }
  }
});

test('provider captures are append-only and all id/batch/command replacement aliases reject with recursive triggers OFF', t => {
  const { db } = fixture(t); worker(db); worker(db, '-other'); const value = material(); save(db, value);
  assert.equal(db.pragma('recursive_triggers', { simple: true }), 0);
  const before = snapshot(db);
  assert.throws(() => db.exec("UPDATE market_provider_captures SET raw_body=x'00'"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM market_provider_captures'), /append-only/);
  for (const patch of [{}, { id: 'alias' },
    { id: 'capture', batch_id: 'batch-alias', command_request_id: 'command-other', job_id: 'job-other' },
    { id: 'alias', batch_id: 'batch', command_request_id: 'command-other', job_id: 'job-other' },
    { id: 'alias', batch_id: 'batch-alias' }]) {
    const row = { ...value.capture, ...patch };
    const document = structuredClone(value.document);
    document.batch.id = row.batch_id; document.batch.provider_capture_id = row.id;
    document.pages[0].observations[0].batch_id = row.batch_id;
    row.document_json = JSON.stringify(document);
    row.receipt_json = JSON.stringify({ ...value.receipt, id: row.id, batch_id: row.batch_id,
      command_request_id: row.command_request_id, job_id: row.job_id, document_hash: sha(row.document_json) });
    row.receipt_hash = sha(row.receipt_json);
    assert.throws(() => insert(db, 'market_provider_captures', row, 'INSERT OR REPLACE'), /cannot be replaced/, JSON.stringify(patch));
  }
  assert.deepEqual(snapshot(db), before);
});

test('failed provider batch creation rolls capture back, and orphan capture cannot commit despite its deferred FK', t => {
  const { db } = fixture(t); worker(db); const value = material();
  assert.throws(() => db.transaction(() => insert(db, 'market_provider_captures', value.capture)).immediate(), /FOREIGN KEY/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM market_provider_captures').get().n, 0);
  assert.throws(() => db.transaction(() => {
    insert(db, 'market_provider_captures', value.capture);
    insert(db, 'market_batches', { ...value.batch, validation_json: '{}' });
  }).immediate());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM market_provider_captures').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM market_batches').get().n, 0);
});

const validator = new Ajv({ allErrors: true, strict: true }); addFormats(validator);
for (const file of readdirSync(join(root, 'contracts/v1')).filter(name => name.endsWith('.schema.json')))
  validator.addSchema(JSON.parse(readFileSync(join(root, 'contracts/v1', file), 'utf8')));
const contract = name => validator.getSchema(`https://etf-workbench.invalid/contracts/v1/${name}.schema.json`);

test('market collect contract accepts only bounded declarative provider requests, never URLs, credentials or caller knowledge clocks', () => {
  const check = contract('market-collect'); assert.equal(check(payload()), true, JSON.stringify(check.errors));
  for (const patch of [{ url: 'https://fixture.invalid' }, { endpoint: 'https://fixture.invalid' }, { access_token: 'synthetic-forbidden' },
    { received_at: received }, { published_at: start }, { actor_id: 'system' }, { provider: 'synthetic' }, { feed: 'all-history' },
    { expected_publication_revision: 0.5 }, { expected_publication_revision: Number.MAX_SAFE_INTEGER + 1 }, { publish: 1 },
    { currencies: [] }, { currencies: ['USD', 'USD'] }, { currencies: ['usd'] }])
    assert.equal(check({ ...payload(), ...patch }), false, JSON.stringify(patch));
});

test('capture contract disallows arbitrary endpoint, authentication headers, fake PIT, extra fields, floats and malformed timestamps', () => {
  const check = contract('market-provider-capture'); const value = material().receipt;
  assert.equal(check(value), true, JSON.stringify(check.errors));
  for (const patch of [{ endpoint: 'https://fixture.invalid' }, { capture_kind: 'sdk_projection' }, { provider: 'longport' },
    { response_headers: { authorization: 'synthetic-forbidden' } }, { response_headers: { 'set-cookie': 'synthetic-forbidden' } },
    { response_headers: { date: 'bad\r\nheader' } }, { access_token: 'synthetic-forbidden' }, { published_at: start },
    { publication_time_status: 'historical_point_in_time' }, { request_started_at: '2026-02-30T00:00:00Z' },
    { received_at: '2026-01-02T09:00:01+00:00' }, { attempt: 1.5 }, { fencing_token: true },
    { raw_bytes: 0 }, { raw_bytes: 2097153 }, { raw_sha256: 'A'.repeat(64) }])
    assert.equal(check({ ...value, ...patch }), false, JSON.stringify(patch));
});

test('provider batch contract requires captured source identity and exact Decimal text, without conflating manual or synthetic payloads', () => {
  const check = contract('market-provider-batch'); const value = material().document;
  assert.equal(check(value), true, JSON.stringify(check.errors));
  for (const patch of [{ source_mode: 'manual_verified' }, { source_mode: 'synthetic' }, { source_id: 'manual' },
    { provider_capture_id: undefined }, { expected_pages: 2 }, { expected_rows: 0 }, { access_token: 'synthetic-forbidden' }])
    assert.equal(check({ ...value, batch: { ...value.batch, ...patch } }), false, JSON.stringify(patch));
  for (const amount of [8, 8.1, true, 'NaN', '1e3', '0.0000000000000000001']) {
    const changed = structuredClone(value); changed.pages[0].observations[0].value = amount;
    assert.equal(check(changed), false, String(amount));
  }
  assert.equal(check({ ...value, access_token: 'synthetic-forbidden' }), false);
});
