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
const time = '2026-01-05T09:00:00.000000Z';
const received = '2026-01-05T09:00:01.000000Z';
const created = '2026-01-05T09:00:02.000000Z';
const insert = (db, table, row, prefix = 'INSERT') => db.prepare(`${prefix} INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?')})`).run(...Object.values(row));
const clone = value => JSON.parse(JSON.stringify(value));

function copyMigrations(directory, version) {
  const target = join(directory, `migrations-${version}`);
  mkdirSync(target);
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json')));
  const migrations = manifest.migrations.slice(0, version);
  assert.equal(migrations.length, version);
  for (const row of migrations) cpSync(join(migrationDirectory, row.file), join(target, row.file));
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations }));
  return target;
}

function fixture(t, version = 17) {
  const directory = mkdtempSync(join(tmpdir(), 'market-prices-migration-'));
  const path = join(directory, 'workbench.db');
  const migrations = copyMigrations(directory, version);
  migrateWorkbench(path, { directory: migrations });
  const db = new Database(path);
  db.pragma('foreign_keys=ON'); db.pragma('recursive_triggers=OFF');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, directory, path, migrations };
}

function snapshot(db, names) {
  names ??= db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  return names.map(name => {
    const columns = db.pragma(`table_info(${name})`).map(row => row.name);
    const bytes = columns.map((column, n) => `typeof("${column}") AS t${n},hex(CAST("${column}" AS BLOB)) AS b${n}`).join(',');
    return { name, columns, rows: db.prepare(`SELECT ${bytes} FROM "${name}" ORDER BY rowid`).all() };
  });
}

function portfolio(db, id = 'p') { insert(db, 'portfolios', { id, name: 'Synthetic market fixture', created_at: time }); }

function reference(db, version = 1, patch = {}) {
  const source = { id: `source-${version}`, portfolio_id: 'p', reference: 'Synthetic structured reference',
    content_text: '{ "synthetic": true, "spelling": "1.000" }\n', content_hash: sha('source'), known_at: time, created_by: 'human' };
  source.content_hash = sha(source.content_text);
  const facts = { provider: 'longport', listing_id: 'listing', provider_symbol: 'SYNTH.US', market: 'US', exchange: 'XNAS',
    currency: 'USD', valid_from: '2026-01-01', valid_to: null };
  const doc = { schema_version: 'market-reference-version-v1', id: `version-${version}`, portfolio_id: 'p', kind: 'mapping',
    scope_key: 'listing', version, source_id: source.id, source_hash: source.content_hash, source_known_at: time,
    known_at: time, created_by: 'human', review_reason: 'Synthetic review only', review_basis: 'human_reviewed_not_provider_verified', facts };
  const row = { id: doc.id, portfolio_id: 'p', kind: doc.kind, scope_key: doc.scope_key, version, source_id: source.id,
    source_hash: source.content_hash, known_at: time, document_json: JSON.stringify(doc), content_hash: sha(JSON.stringify(doc)),
    audit_id: `audit-${version}`, created_by: 'human', ...patch };
  const auditPayload = { actor_kind: 'human', input: { portfolio_id: 'p',
    expected_version: version - 1, source_id: source.id, source_hash: source.content_hash, review_reason: doc.review_reason,
    acknowledgement: true, document: { kind: doc.kind, facts } }, result: { id: doc.id, portfolio_id: 'p', kind: doc.kind,
    scope_key: doc.scope_key, version, source_id: source.id, source_hash: source.content_hash, known_at: time,
    content_hash: row.content_hash, verification_status: doc.review_basis } };
  const audit = { id: row.audit_id, portfolio_id: 'p', actor_id: 'human', action: 'publish_market_reference',
    object_type: 'market_reference', object_id: row.id, payload_json: JSON.stringify(auditPayload), created_at: time };
  const head = { portfolio_id: 'p', kind: doc.kind, scope_key: doc.scope_key, version, version_id: row.id, updated_at: time };
  return { source, row, audit, auditPayload, doc, head };
}

function storeReference(db, value, head = true) {
  db.transaction(() => {
    insert(db, 'market_reference_sources', value.source);
    insert(db, 'audit_events', value.audit);
    insert(db, 'market_reference_versions', value.row);
    if (head) insert(db, 'market_reference_heads', value.head);
  }).immediate();
}

function priceRequest() {
  return { schema_version: 'market-price-collect-v1', provider: 'longport', mapping_version_ids: ['version-1'],
    calendar_version_ids: ['calendar-1'], start_date: '2026-01-02', end_date: '2026-01-02', expected_publication_revision: 0, publish: true };
}

function worker(db, ecb = false) {
  const commandType = ecb ? 'market_collect' : 'market_collect_prices';
  const payload = ecb ? { provider: 'ecb', feed: 'daily', currencies: ['USD'], expected_publication_revision: 0, publish: true } : priceRequest();
  insert(db, 'command_requests', { id: 'command', portfolio_id: 'p', command_type: commandType, idempotency_key: 'synthetic-key',
    payload_hash: sha(JSON.stringify(payload)), payload_json: JSON.stringify(payload), actor_id: 'human', created_at: time });
  insert(db, 'job_runs', { id: 'job', command_request_id: 'command', job_type: commandType, scope: 'p', period: 'synthetic',
    input_version: 'command', status: 'running', max_attempts: 3, attempt_count: 1, not_before: time, created_at: time,
    updated_at: time, lease_owner: 'worker', lease_until: '2026-01-05T09:01:00.000000Z', fencing_token: 1 });
  insert(db, 'job_attempts', { id: 'attempt', job_id: 'job', attempt: 1, fencing_token: 1, status: 'running', started_at: time });
  return payload;
}

function capture(payload, ecb = false) {
  const raw = Buffer.from(ecb ? '<synthetic/>\n' : JSON.stringify({ schema_version: 'longport-batch-projection-v1', projections: [{ synthetic: true }] }));
  const normalized = { synthetic: true };
  const plan = { id: 'batch', source_id: ecb ? 'provider:ecb:reference-fx' : 'provider:longport:prices', batch_type: ecb ? 'fx' : 'prices',
    scope: ecb ? 'provider:ecb:fx:daily:USD' : 'provider:longport:prices:' + sha('synthetic-scope'), expected_pages: 1,
    expected_rows: 1, expected_publication_revision: 0, source_mode: 'provider_observed', provider_capture_id: 'capture' };
  const observation = { id: 'observation', batch_id: plan.id, source_id: plan.source_id, series_key: ecb ? 'FX:USD' : 'listing',
    metric: ecb ? 'fx_cny_per_unit' : 'close', value: '1.000', unit: ecb ? 'CNY_per_unit_currency' : 'USD', observed_at: '2026-01-02',
    ingested_at: received, source_timezone: 'America/New_York', time_precision: 'date', price_basis: ecb ? 'not_applicable' : 'unadjusted',
    revision_id: 'capture', raw_hash: sha(raw), parser_version: ecb ? 'ecb-reference-xml-v1' : 'longport-price-collection-v1', provenance: 'live_observed' };
  const document = { schema_version: ecb ? 'market-provider-batch-v1' : 'market-price-provider-batch-v1', batch: plan,
    pages: [{ page_number: 1, observations: [observation] }] };
  const receipt = { schema_version: ecb ? 'market-provider-capture-v1' : 'market-sdk-capture-v1', id: 'capture', batch_id: 'batch',
    provider: ecb ? 'ecb' : 'longport', capture_kind: ecb ? 'http_response_bytes' : 'sdk_projection',
    command_request_id: 'command', job_id: 'job', attempt: 1, fencing_token: 1, request_hash: sha(JSON.stringify(payload)),
    request_started_at: time, received_at: received, raw_sha256: sha(raw), raw_bytes: raw.length,
    parser_version: ecb ? 'ecb-reference-xml-v1' : 'longport-price-collection-v1', normalized_hash: sha(JSON.stringify(normalized)),
    document_hash: sha(JSON.stringify(document)), rate_kind: ecb ? 'reference_not_executable' : 'market_price_not_executable',
    publication_time_status: 'not_supplied', coverage_kind: ecb ? 'returned_feed_dates_not_historical_calendar' : 'reviewed_calendar_exact_dates',
    ...(ecb ? { endpoint: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', response_status: 200, response_headers: {} }
      : { sdk_version: '4.3.7', references_hash: sha('references'), timestamp_semantics: 'provider_bar_timestamp_not_confirmed_close' }) };
  const row = { id: 'capture', batch_id: 'batch', command_request_id: 'command', job_id: 'job', attempt: 1, raw_body: raw,
    receipt_json: JSON.stringify(receipt), receipt_hash: sha(JSON.stringify(receipt)), normalized_json: JSON.stringify(normalized),
    document_json: JSON.stringify(document), created_at: created };
  const batch = { id: plan.id, source_id: plan.source_id, batch_type: plan.batch_type, scope: plan.scope, status: 'staging',
    expected_pages: 1, validation_json: JSON.stringify({ plan }), started_at: time };
  return { row, receipt, document, batch };
}

function storeCapture(db, value, ecb = false) {
  db.transaction(() => { insert(db, ecb ? 'market_provider_captures' : 'market_sdk_captures', value.row); insert(db, 'market_batches', value.batch); }).immediate();
}

test('v16 to v17 preserves every old value byte including ECB BLOB and creates no facts or private references; retry writes nothing', t => {
  const f = fixture(t, 16); portfolio(f.db); const payload = worker(f.db, true); storeCapture(f.db, capture(payload, true), true);
  const before = snapshot(f.db).filter(row => row.name !== 'schema_migrations');
  const migrations = copyMigrations(f.directory, 17);
  assert.equal(migrateWorkbench(f.path, { directory: migrations }).applied, 1);
  assert.deepEqual(snapshot(f.db, before.map(row => row.name)), before);
  for (const table of ['market_reference_sources', 'market_reference_versions', 'market_reference_heads', 'market_sdk_captures',
    'accounts', 'ledger_events', 'postings', 'proposals', 'approval_events', 'reservations']) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  f.db.pragma('wal_checkpoint(TRUNCATE)'); const physical = sha(readFileSync(f.path)), logical = snapshot(f.db);
  assert.equal(migrateWorkbench(f.path, { directory: migrations }).applied, 0);
  assert.equal(sha(readFileSync(f.path)), physical); assert.deepEqual(snapshot(f.db), logical);
  assert.equal(verifyWorkbenchSchema(f.db, migrations).version, 17);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []); assert.equal(f.db.pragma('quick_check', { simple: true }), 'ok');
});

test('reference version requires exact scoped source and explicit human audit, with raw source spelling retained', t => {
  const { db } = fixture(t); portfolio(db); const value = reference(db); storeReference(db, value);
  assert.equal(db.prepare('SELECT content_text FROM market_reference_sources').get().content_text, value.source.content_text);
  assert.equal(db.prepare('SELECT document_json FROM market_reference_versions').get().document_json, value.row.document_json);
  assert.equal(db.prepare('SELECT version FROM market_reference_heads').get().version, 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('review cannot self-certify provider truth, change source scope/hash, omit acknowledgement or impersonate the audit actor', t => {
  const { db } = fixture(t); portfolio(db); portfolio(db, 'other');
  const attempts = [
    v => { v.source.portfolio_id = 'other'; }, v => { v.source.content_hash = sha('different'); },
    v => { v.source.known_at = received; }, v => { v.audit.actor_id = 'other'; }, v => { v.audit.portfolio_id = 'other'; },
    v => { v.audit.action = 'other'; }, v => { v.audit.object_type = 'other'; }, v => { v.audit.object_id = 'other'; },
    v => { v.audit.created_at = received; }, v => { v.auditPayload.actor_kind = 'ai'; },
    v => { v.auditPayload.input.acknowledgement = false; }, v => { v.auditPayload.input.expected_version = 1; },
    v => { v.auditPayload.input.document.facts.currency = 'CNY'; },
    v => { v.auditPayload.result.content_hash = sha('different'); }, v => { v.auditPayload.result.verification_status = 'provider_verified'; },
  ];
  for (const change of attempts) {
    const value = reference(db); change(value); value.audit.payload_json = JSON.stringify(value.auditPayload);
    assert.throws(() => storeReference(db, value));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM market_reference_versions').get().n, 0);
  }
});

test('reference heads CAS once, retain the old version, and reject all replacement aliases with recursive triggers off', t => {
  const { db } = fixture(t); portfolio(db); const first = reference(db); storeReference(db, first);
  const second = reference(db, 2); storeReference(db, second, false);
  for (const row of [{ ...second.head, version: 3 }, { ...second.head, portfolio_id: 'other' }, { ...second.head, updated_at: received }])
    assert.throws(() => db.prepare('UPDATE market_reference_heads SET portfolio_id=@portfolio_id,version=@version,version_id=@version_id,updated_at=@updated_at').run(row));
  db.prepare('UPDATE market_reference_heads SET version=2,version_id=?,updated_at=? WHERE version=1').run(second.row.id, time);
  assert.equal(db.prepare('SELECT version FROM market_reference_heads').get().version, 2);
  const before = snapshot(db);
  for (const [table, rows] of [
    ['market_reference_sources', [first.source]],
    ['market_reference_versions', [first.row, { ...first.row, id: 'alias' }, { ...second.row, id: 'alias', version: 3 }]],
    ['market_reference_heads', [second.head]],
  ]) {
    for (const row of rows) assert.throws(() => insert(db, table, row, 'INSERT OR REPLACE'), table);
    assert.throws(() => db.exec(`DELETE FROM ${table}`), table);
    if (table !== 'market_reference_heads') assert.throws(() => db.exec(`UPDATE ${table} SET portfolio_id=portfolio_id`), table);
  }
  assert.deepEqual(snapshot(db), before);
});

test('reference SQL rejects non-text JSON, invalid objects, oversize UTF8 and noncanonical known times', t => {
  const { db } = fixture(t); portfolio(db); const source = reference(db).source;
  for (const patch of [{ content_text: Buffer.from('{}') }, { content_text: '[]' }, { content_text: '\ufeff{}' },
    { content_text: '{bad}' }, { content_text: JSON.stringify({ text: 'a'.repeat(1048576) }) },
    { content_hash: 'A'.repeat(64) }, { known_at: '2026-01-05T09:00:00Z' }, { known_at: '0000-01-01T00:00:00.000000Z' }])
    assert.throws(() => insert(db, 'market_reference_sources', { ...source, ...patch }));
});

test('SDK projection capture and exact price batch are atomic under a real current worker attempt', t => {
  const { db } = fixture(t); portfolio(db); const value = capture(worker(db)); storeCapture(db, value);
  assert.deepEqual(db.prepare('SELECT raw_body FROM market_sdk_captures').get().raw_body, value.row.raw_body);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM market_provider_captures').get().n, 0);
  for (const table of ['ledger_events', 'proposals', 'approval_events']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
});

test('SDK receipt identity, time, fence, lease, provider and job type mismatches cannot be captured', t => {
  const { db } = fixture(t); portfolio(db); const value = capture(worker(db));
  for (const patch of [{ id: 'other' }, { batch_id: 'other' }, { command_request_id: 'other' }, { job_id: 'other' },
    { attempt: true }, { attempt: 2 }, { fencing_token: false }, { fencing_token: 2 }, { request_hash: sha('other') },
    { provider: 'ecb' }, { capture_kind: 'http_response_bytes' }, { sdk_version: '0.0.0' }, { raw_bytes: 1 },
    { references_hash: null }, { references_hash: 'G'.repeat(64) }, { received_at: '2026-01-05T09:00:01Z' },
    { received_at: time, request_started_at: received }, { received_at: '2026-01-05T09:00:03.000000Z' },
    { request_started_at: '2026-01-05T08:59:59.000000Z' }, { publication_time_status: 'known' }]) {
    const receipt = JSON.stringify({ ...value.receipt, ...patch });
    assert.throws(() => storeCapture(db, { ...value, row: { ...value.row, receipt_json: receipt, receipt_hash: sha(receipt) } }), JSON.stringify(patch));
  }
  for (const [column, bad] of [['scope', 'other'], ['job_type', 'market_collect'], ['status', 'queued'], ['attempt_count', 2],
    ['fencing_token', 2], ['lease_owner', null], ['lease_until', created]]) {
    const old = db.prepare(`SELECT ${column} value FROM job_runs`).get().value;
    db.prepare(`UPDATE job_runs SET ${column}=?`).run(bad);
    assert.throws(() => storeCapture(db, value), column);
    db.prepare(`UPDATE job_runs SET ${column}=?`).run(old);
  }
});

test('SDK BLOB and JSON limits, batch linkage, and replacement aliases fail without mutating originals', t => {
  const { db } = fixture(t); portfolio(db); const value = capture(worker(db));
  for (const patch of [{ raw_body: value.row.raw_body.toString() }, { raw_body: Buffer.alloc(0) }, { raw_body: Buffer.alloc(2097153) },
    { receipt_json: '[]' }, { normalized_json: Buffer.from('{}') }, { normalized_json: 'null' },
    { document_json: '[]' }, { normalized_json: JSON.stringify({ x: 'a'.repeat(4194304) }) }])
    assert.throws(() => storeCapture(db, { ...value, row: { ...value.row, ...patch } }));
  for (const patch of [{ source_id: 'provider:other' }, { scope: 'other' }, { started_at: received }, { expected_pages: 2 }, { batch_type: 'fx' }])
    assert.throws(() => storeCapture(db, { ...value, batch: { ...value.batch, ...patch } }));
  storeCapture(db, value); const before = snapshot(db);
  for (const row of [value.row, { ...value.row, id: 'alias' }, { ...value.row, id: 'alias', batch_id: 'other' },
    { ...value.row, id: 'alias', command_request_id: 'other' }])
    assert.throws(() => insert(db, 'market_sdk_captures', row, 'INSERT OR REPLACE'));
  assert.throws(() => db.exec('UPDATE market_sdk_captures SET raw_body=raw_body'));
  assert.throws(() => db.exec('DELETE FROM market_sdk_captures'));
  assert.deepEqual(snapshot(db), before);
});

test('ECB capture remains accepted under v17 without becoming a price SDK capture', t => {
  const { db } = fixture(t); portfolio(db); const value = capture(worker(db, true), true); storeCapture(db, value, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM market_provider_captures').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM market_sdk_captures').get().n, 0);
});

test('ECB capture cannot authorize a price batch, and an SDK capture cannot authorize an ECB batch', t => {
  for (const ecb of [true, false]) {
    const { db } = fixture(t); portfolio(db); const value = capture(worker(db, ecb), ecb);
    const source = ecb ? 'provider:longport:prices' : 'provider:ecb:reference-fx';
    const type = ecb ? 'prices' : 'fx';
    value.document.batch.source_id = source; value.document.batch.batch_type = type;
    value.row.document_json = JSON.stringify(value.document);
    value.receipt.document_hash = sha(value.row.document_json);
    value.row.receipt_json = JSON.stringify(value.receipt); value.row.receipt_hash = sha(value.row.receipt_json);
    value.batch.source_id = source; value.batch.batch_type = type;
    value.batch.validation_json = JSON.stringify({ plan: value.document.batch });
    assert.throws(() => storeCapture(db, value, ecb));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM market_batches').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM market_provider_captures').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM market_sdk_captures').get().n, 0);
  }
});

test('new contracts compile strictly and reject authority, URL, token, timestamp and float mutations', () => {
  const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv);
  for (const name of readdirSync(join(root, 'contracts/v1')).filter(name => name.endsWith('.schema.json')))
    ajv.addSchema(JSON.parse(readFileSync(join(root, 'contracts/v1', name))));
  const validate = name => ajv.getSchema(`https://etf-workbench.invalid/contracts/v1/${name}.schema.json`);
  const referenceValidator = validate('market-reference-version'), priceValidator = validate('market-price-collect');
  const receiptValidator = validate('market-sdk-capture'), batchValidator = validate('market-price-provider-batch');
  const ref = reference(null).doc, command = priceRequest(), cap = capture(command);
  for (const [validator, value] of [[referenceValidator, ref], [priceValidator, command], [receiptValidator, cap.receipt], [batchValidator, cap.document]])
    assert.equal(validator(value), true, JSON.stringify(validator.errors));
  for (const patch of [{ endpoint: 'https://synthetic.invalid' }, { token: 'synthetic-not-a-token' }, { publish: 'true' },
    { mapping_version_ids: ['same', 'same'] }, { expected_publication_revision: 0.5 }, { start_date: '2026-02-30' }])
    assert.equal(priceValidator({ ...command, ...patch }), false);
  for (const patch of [{ endpoint: 'https://synthetic.invalid' }, { authorization: 'synthetic-not-a-token' }, { provider: 'ecb' },
    { capture_kind: 'http_response_bytes' }, { sdk_version: '4.3.8' }, { publication_time_status: 'known' },
    { received_at: '2026-01-05T09:00:01+00:00' }, { attempt: 1.1 }]) assert.equal(receiptValidator({ ...cap.receipt, ...patch }), false);
  for (const patch of [{ review_basis: 'provider_verified' }, { review_reason: '   ' }, { account_buyable: true },
    { known_at: '2026-01-05T09:00:00Z' }, { version: true }]) assert.equal(referenceValidator({ ...ref, ...patch }), false);
  const floating = clone(cap.document); floating.pages[0].observations[0].value = 1.1;
  assert.equal(batchValidator(floating), false);
  const calendar = { kind: 'calendar', facts: { market: 'US', exchange: 'XNAS', timezone: 'America/New_York', range_start: '2026-01-02',
    range_end: '2026-01-02', days: [{ date: '2026-01-02', kind: 'half', close_at: '2026-01-02T18:00:00.000000Z' }] } };
  const factsValidator = validate('market-reference-facts'); assert.equal(factsValidator(calendar), true);
  calendar.facts.days[0].kind = 'closed'; assert.equal(factsValidator(calendar), false);
  calendar.facts.days[0].close_at = null; assert.equal(factsValidator(calendar), true);
});
