import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const Database = createRequire(join(root, 'web/package.json'))('better-sqlite3');
const T = '2026-01-01T00:00:00.000000Z', UNTIL = '2026-02-01T00:00:00.000000Z';
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const insert = (db, table, row, prefix = 'INSERT') => db.prepare(`${prefix} INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?')})`).run(...Object.values(row));

function migrationCopy(directory, version) {
  const target = join(directory, `v${version}`); mkdirSync(target);
  const original = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), migrations = original.migrations.slice(0, version);
  assert.equal(migrations.length, version);
  for (const row of migrations) cpSync(join(migrationDirectory, row.file), join(target, row.file));
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...original, migrations }));
  return target;
}
function fixture(t, version = 20) {
  const directory = mkdtempSync(join(tmpdir(), 'evaluation-listing-boundary-')), path = join(directory, 'workbench.db');
  const migrations = migrationCopy(directory, version); migrateWorkbench(path, { directory: migrations });
  const db = new Database(path); db.pragma('foreign_keys=ON'); db.pragma('recursive_triggers=OFF');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const portfolio of ['p', 'other']) {
    insert(db, 'portfolios', { id: portfolio, name: 'Synthetic boundary fixture', created_at: T });
    insert(db, 'policy_versions', { id: `policy-${portfolio}`, portfolio_id: portfolio, version: 1, policy_json: '{}', content_hash: sha('{}'), created_by: 'synthetic-human', created_at: T });
    insert(db, 'strategy_versions', { id: `strategy-${portfolio}`, portfolio_id: portfolio, strategy_key: 'synthetic-monthly', version: 1, parameters_json: '{}', content_hash: sha('{}'), created_by: 'synthetic-human', created_at: T });
  }
  if (version >= 19) {
    insert(db, 'instruments', { id: 'instrument', name: 'Synthetic instrument', created_at: T });
    insert(db, 'listings', { id: 'listing', instrument_id: 'instrument', market: 'US', exchange: 'XNAS', ticker: 'SYNTH', currency: 'USD', created_at: T });
    for (const portfolio_id of ['p', 'other']) {
      insert(db, 'catalog_entries', { portfolio_id, listing_id: 'listing', created_at: T });
      const source = { id: `source-${portfolio_id}`, portfolio_id, reference: 'Synthetic source, not verified provider data',
        content_text: '{"synthetic":true}', content_hash: sha('{"synthetic":true}'), known_at: T, created_by: 'synthetic-human' };
      insert(db, 'market_reference_sources', source);
      insert(db, 'audit_events', { id: `${source.id}:audit`, portfolio_id, actor_id: source.created_by, action: 'store_market_reference_source',
        object_type: 'market_reference_source', object_id: source.id, created_at: T,
        payload_json: canonical({ actor_kind: 'human', input_hash: sha('synthetic source input'), result: {
          id: source.id, portfolio_id, reference: source.reference, content_hash: source.content_hash, known_at: T } }) });
    }
  }
  return { db, path, directory };
}
function snapshot(db, names) {
  names ??= db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  return names.map(name => {
    const columns = db.pragma(`table_info(${name})`).map(row => row.name);
    const bytes = columns.map((column, n) => `typeof("${column}") AS t${n},hex(CAST("${column}" AS BLOB)) AS b${n}`).join(',');
    return { name, columns, rows: db.prepare(`SELECT ${bytes} FROM "${name}" ORDER BY rowid`).all() };
  });
}
function review(db, portfolio = 'p', { failHead = false, prefix = 'INSERT' } = {}) {
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM listing_review_heads WHERE portfolio_id=? AND listing_id=?').get(portfolio, 'listing');
    const revision = (old?.revision ?? 0) + 1, id = `${portfolio}:review:${revision}`, audit_id = `${id}:audit`;
    const source = db.prepare('SELECT * FROM market_reference_sources WHERE id=?').get(`source-${portfolio}`);
    const identity = db.prepare('SELECT id AS listing_id,instrument_id,market,exchange,ticker,currency FROM listings WHERE id=?').get('listing');
    const facts = { instrument_kind: 'ETF', lifecycle_status: 'active', quantity_step: '1', price_step: '0.01', source_effective_date: null,
      fund_identifier: 'SYNTHETIC', share_class_identifier: null, risk_classification: { index_id: 'SYNTHETIC', region: 'Synthetic', sector: 'Synthetic' },
      product_structure: { leverage: 'unleveraged', direction: 'long_only' } };
    const document = { schema_version: 'listing-review-v1', id, portfolio_id: portfolio, listing_id: 'listing', revision,
      source_id: source.id, source_hash: source.content_hash, source_known_at: T, identity_snapshot: identity, identity_hash: sha(canonical(identity)),
      known_at: T, created_by: 'synthetic-human', review_until: UNTIL, reason: 'Synthetic migration test only', review_basis: 'human_reviewed_not_provider_verified', facts };
    const { schema_version, identity_snapshot, review_basis, facts: ignoredFacts, ...base } = document;
    const row = { ...base, identity_json: canonical(identity), facts_json: canonical(facts), document_json: canonical(document), content_hash: sha(canonical(document)), audit_id };
    const input = { portfolio_id: portfolio, listing_id: 'listing', expected_review_revision: revision - 1, expected_identity_hash: document.identity_hash,
      source_id: source.id, source_hash: source.content_hash, facts, review_until: UNTIL, reason: document.reason, acknowledgement: true, idempotency_key: `${id}:key` };
    const result = { id, portfolio_id: portfolio, listing_id: 'listing', revision, content_hash: row.content_hash, identity_hash: document.identity_hash,
      source_id: source.id, source_hash: source.content_hash, known_at: T, review_until: UNTIL, review_basis };
    insert(db, 'audit_events', { id: audit_id, portfolio_id: portfolio, actor_id: document.created_by, action: 'publish_listing_review',
      object_type: 'listing_review', object_id: id, created_at: T, payload_json: canonical({ actor_kind: 'human', input, result }) });
    insert(db, 'listing_review_versions', row, prefix);
    const head = { portfolio_id: portfolio, listing_id: 'listing', revision: failHead ? revision + 1 : revision, version_id: id, updated_at: T };
    if (old) db.prepare('UPDATE listing_review_heads SET revision=@revision,version_id=@version_id,updated_at=@updated_at WHERE portfolio_id=@portfolio_id AND listing_id=@listing_id').run(head);
    else insert(db, 'listing_review_heads', head);
    return row;
  }).immediate();
}
function schedule(db, portfolio = 'p') {
  const id = `schedule-${portfolio}`, version_id = `version-${portfolio}`;
  insert(db, 'evaluation_schedules', { id, portfolio_id: portfolio, environment: 'actual', strategy_key: 'synthetic-monthly', scope_key: 'portfolio', created_by: 'synthetic-human', created_at: T });
  const definition_json = canonical({ schema_version: 'evaluation-schedule-v1', environment: 'actual', frequency: 'monthly', policy_version_id: `policy-${portfolio}`, strategy_version_id: `strategy-${portfolio}` });
  insert(db, 'evaluation_schedule_versions', { id: version_id, schedule_id: id, version: 1, policy_version_id: `policy-${portfolio}`, strategy_version_id: `strategy-${portfolio}`,
    definition_json, content_hash: sha(definition_json), created_by: 'synthetic-human', created_at: T });
  for (const action of ['create', 'enable']) insert(db, 'audit_events', { id: `${id}:${action}`, portfolio_id: portfolio, actor_id: 'synthetic-human', action: 'save_evaluation_schedule',
    object_type: 'evaluation_schedule', object_id: id, payload_json: '{}', created_at: T });
  insert(db, 'evaluation_schedule_heads', { schedule_id: id, current_version_id: version_id, revision: 1, status: 'paused', last_audit_id: `${id}:create`, updated_at: T });
  db.prepare("UPDATE evaluation_schedule_heads SET revision=2,status='enabled',last_audit_id=? WHERE schedule_id=?").run(`${id}:enable`, id);
}
function cycle(db, id = 'cycle', portfolio = 'p', period = '2026-01') {
  insert(db, 'evaluation_cycles', { id, portfolio_id: portfolio, strategy_version_id: `strategy-${portfolio}`, policy_version_id: `policy-${portfolio}`,
    scope: 'actual:portfolio', period, status: 'pending', schedule_version_id: `version-${portfolio}`, environment: 'actual', strategy_key: 'synthetic-monthly', scope_key: 'portfolio',
    scheduled_at: T, cutoff_at: T, knowledge_at: T, deadline_at: '2026-01-02T00:00:00.000000Z', created_at: T, state_revision: 1 });
  return db.prepare('SELECT * FROM evaluation_cycles WHERE id=?').get(id);
}
const boundary = (db, id = 'cycle') => db.prepare('SELECT * FROM evaluation_listing_review_boundaries WHERE cycle_id=?').get(id);
const sequence = (db, id) => db.prepare('SELECT * FROM listing_review_sequences WHERE version_id=?').get(id);

test('v19 upgrade preserves every old column and schema byte; baseline reviews are mapped but old cycles get only legacy tombstones', t => {
  const f = fixture(t, 19); review(f.db); review(f.db); review(f.db, 'other'); schedule(f.db); cycle(f.db);
  const before = snapshot(f.db).filter(row => row.name !== 'schema_migrations');
  const schema = f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const migrations = migrationCopy(f.directory, 20);
  assert.equal(migrateWorkbench(f.path, { directory: migrations }).applied, 1);
  assert.deepEqual(snapshot(f.db, before.map(row => row.name)), before);
  for (const row of schema) assert.deepEqual(f.db.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=?').get(row.name), row);
  assert.deepEqual(f.db.prepare('SELECT * FROM listing_review_sequences ORDER BY sequence').all(), [
    { sequence: 1, version_id: 'other:review:1', portfolio_id: 'other' },
    { sequence: 2, version_id: 'p:review:1', portfolio_id: 'p' }, { sequence: 3, version_id: 'p:review:2', portfolio_id: 'p' }]);
  assert.deepEqual(boundary(f.db), { cycle_id: 'cycle', portfolio_id: 'p', knowledge_at: T, capture_kind: 'legacy_missing', watermark_sequence: null });
  for (const table of ['accounts', 'ledger_events', 'postings', 'activations', 'proposals']) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  const state = snapshot(f.db); f.db.pragma('wal_checkpoint(TRUNCATE)'); const bytes = sha(readFileSync(f.path));
  assert.equal(migrateWorkbench(f.path, { directory: migrations }).applied, 0); assert.equal(sha(readFileSync(f.path)), bytes);
  assert.deepEqual(snapshot(f.db), state); assert.equal(verifyWorkbenchSchema(f.db, migrations).version, 20);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []); assert.equal(f.db.pragma('quick_check', { simple: true }), 'ok');
});

test('pre-monthly legacy cycles retain NULL knowledge with explicit missing boundaries instead of guessed watermarks', t => {
  const f = fixture(t, 14), old = { id: 'legacy', portfolio_id: 'p', strategy_version_id: 'strategy-p', policy_version_id: 'policy-p',
    scope: 'synthetic-old', period: 'old', status: 'completed', outcome: 'unchanged', completed_at: T };
  insert(f.db, 'evaluation_cycles', old); const migrations = migrationCopy(f.directory, 20);
  migrateWorkbench(f.path, { directory: migrations });
  assert.deepEqual(f.db.prepare(`SELECT ${Object.keys(old).join(',')} FROM evaluation_cycles WHERE id='legacy'`).get(), old);
  assert.deepEqual(boundary(f.db, 'legacy'), { cycle_id: 'legacy', portfolio_id: 'p', knowledge_at: null, capture_kind: 'legacy_missing', watermark_sequence: null });
  assert.throws(() => f.db.exec("UPDATE evaluation_listing_review_boundaries SET capture_kind='cycle_insert_transaction',watermark_sequence=0,knowledge_at='2026-01-01T00:00:00.000000Z'"), /immutable/);
});

test('same-time review sequence freezes at cycle insertion, remains scoped and does not change on later revisions', t => {
  const { db } = fixture(t); schedule(db); schedule(db, 'other');
  const first = review(db); cycle(db); const initial = boundary(db);
  const foreign = review(db, 'other'), newer = review(db);
  assert.deepEqual([sequence(db, first.id).sequence, sequence(db, foreign.id).sequence, sequence(db, newer.id).sequence], [1, 2, 3]);
  assert.deepEqual(boundary(db), initial); assert.equal(initial.watermark_sequence, 1); assert.equal(initial.capture_kind, 'cycle_insert_transaction');
  const selected = db.prepare(`SELECT v.id FROM listing_review_versions v JOIN listing_review_sequences s ON s.version_id=v.id AND s.portfolio_id=v.portfolio_id
    WHERE v.portfolio_id=? AND v.listing_id=? AND v.known_at<=? AND s.sequence<=? ORDER BY v.revision DESC LIMIT 1`).get('p', 'listing', T, initial.watermark_sequence);
  assert.equal(selected.id, first.id); assert.equal(db.prepare("SELECT version_id FROM listing_review_heads WHERE portfolio_id='p'").get().version_id, newer.id);
  cycle(db, 'later-cycle', 'p', '2026-02'); cycle(db, 'other-cycle', 'other');
  assert.equal(boundary(db, 'later-cycle').watermark_sequence, 3); assert.equal(boundary(db, 'other-cycle').watermark_sequence, 2);
});

test('empty portfolio captures zero even when another portfolio has reviews and cannot gain later knowledge', t => {
  const { db } = fixture(t); schedule(db); review(db, 'other'); cycle(db);
  const initial = boundary(db); assert.equal(initial.watermark_sequence, 0); review(db);
  assert.deepEqual(boundary(db), initial);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM listing_review_sequences WHERE portfolio_id=? AND sequence<=?').get('p', initial.watermark_sequence).n, 0);
});

test('review and cycle triggers preserve statement order within one transaction and roll back together', t => {
  const { db } = fixture(t); schedule(db);
  db.transaction(() => { review(db); cycle(db); review(db); }).immediate();
  assert.equal(boundary(db).watermark_sequence, 1); assert.equal(db.prepare('SELECT MAX(sequence) n FROM listing_review_sequences').get().n, 2);
  const before = snapshot(db), allocation = db.prepare("SELECT * FROM sqlite_sequence WHERE name='listing_review_sequences'").get();
  assert.throws(() => db.transaction(() => { review(db); cycle(db, 'rolled-back', 'p', '2026-02'); throw new Error('synthetic rollback'); }).immediate(), /synthetic rollback/);
  assert.deepEqual(snapshot(db), before); assert.deepEqual(db.prepare("SELECT * FROM sqlite_sequence WHERE name='listing_review_sequences'").get(), allocation);
});

test('two SQLite connections serialize review publication and cycle capture in actual writer order', t => {
  const { db, path } = fixture(t); schedule(db);
  const peer = new Database(path); peer.pragma('foreign_keys=ON'); peer.pragma('busy_timeout=5'); db.pragma('busy_timeout=5');
  t.after(() => peer.close());
  db.exec('BEGIN IMMEDIATE'); review(db);
  assert.throws(() => cycle(peer), error => error.code === 'SQLITE_BUSY');
  db.exec('COMMIT'); cycle(peer); assert.equal(boundary(peer).watermark_sequence, 1);
  peer.exec('BEGIN IMMEDIATE'); cycle(peer, 'before-next-review', 'p', '2026-02');
  assert.throws(() => review(db), error => error.code === 'SQLITE_BUSY');
  peer.exec('COMMIT'); review(db);
  assert.equal(boundary(peer, 'before-next-review').watermark_sequence, 1);
  assert.equal(db.prepare('SELECT MAX(sequence) n FROM listing_review_sequences').get().n, 2);
});

test('failed review publication cannot leave a sequence, source audit or partially advanced head', t => {
  const { db } = fixture(t); review(db); const before = snapshot(db);
  assert.throws(() => review(db, 'p', { failHead: true }), /CAS/); assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM listing_review_sequences').get().n, 1);
});

test('sequence rows reject UPDATE, DELETE and both unique REPLACE aliases with recursive triggers off', t => {
  const { db } = fixture(t), first = review(db), other = review(db, 'other'), before = snapshot(db);
  assert.equal(db.pragma('recursive_triggers', { simple: true }), 0);
  for (const sql of ["UPDATE listing_review_sequences SET portfolio_id='other'", 'UPDATE OR REPLACE listing_review_sequences SET sequence=2 WHERE sequence=1',
    'DELETE FROM listing_review_sequences']) { assert.throws(() => db.exec(sql), /immutable/); assert.deepEqual(snapshot(db), before); }
  for (const row of [{ version_id: first.id, portfolio_id: 'p' }, { sequence: 99, version_id: first.id, portfolio_id: 'p' },
    { sequence: 1, version_id: other.id, portfolio_id: 'other' }, { sequence: 1, version_id: 'missing', portfolio_id: 'other' }]) {
    assert.throws(() => insert(db, 'listing_review_sequences', row, 'INSERT OR REPLACE'), /cannot be replaced/); assert.deepEqual(snapshot(db), before);
  }
  assert.throws(() => insert(db, 'listing_review_sequences', { version_id: 'missing', portfolio_id: 'p' }), /portfolio mismatch/);
});

test('boundaries reject UPDATE, DELETE, REPLACE, scope forgery and caller-created legacy markers', t => {
  const { db } = fixture(t); schedule(db); review(db); cycle(db); const row = boundary(db), before = snapshot(db);
  for (const sql of ["UPDATE evaluation_listing_review_boundaries SET watermark_sequence=0", "UPDATE OR REPLACE evaluation_listing_review_boundaries SET cycle_id='replacement'",
    'DELETE FROM evaluation_listing_review_boundaries']) { assert.throws(() => db.exec(sql), /immutable/); assert.deepEqual(snapshot(db), before); }
  for (const patch of [{}, { portfolio_id: 'other' }, { watermark_sequence: 2 }, { knowledge_at: UNTIL }, { capture_kind: 'legacy_missing', watermark_sequence: null }]) {
    assert.throws(() => insert(db, 'evaluation_listing_review_boundaries', { ...row, ...patch }, 'INSERT OR REPLACE'), /cannot be replaced/); assert.deepEqual(snapshot(db), before);
  }
  for (const patch of [{}, { portfolio_id: 'other' }, { capture_kind: 'legacy_missing', watermark_sequence: null }, { watermark_sequence: null }, { watermark_sequence: 9007199254740992n }]) {
    assert.throws(() => insert(db, 'evaluation_listing_review_boundaries', { ...row, cycle_id: 'missing', ...patch }), /current cycle transaction watermark/); assert.deepEqual(snapshot(db), before);
  }
});

test('legacy boundaries cannot be replaced after migration even when a plausible current watermark exists', t => {
  const f = fixture(t, 19); schedule(f.db); review(f.db); cycle(f.db);
  const migrations = migrationCopy(f.directory, 20); migrateWorkbench(f.path, { directory: migrations });
  const before = snapshot(f.db), row = boundary(f.db);
  assert.throws(() => insert(f.db, 'evaluation_listing_review_boundaries', { ...row, capture_kind: 'cycle_insert_transaction', watermark_sequence: 1 }, 'INSERT OR REPLACE'), /cannot be replaced/);
  assert.throws(() => f.db.exec('DELETE FROM evaluation_listing_review_boundaries'), /immutable/);
  assert.deepEqual(snapshot(f.db), before); assert.equal(boundary(f.db).watermark_sequence, null);
});

test('safe integer exhaustion rejects the whole review transaction rather than producing a rounded boundary', t => {
  const { db } = fixture(t); review(db); schedule(db);
  db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='listing_review_sequences'").run(9007199254740990);
  const last = review(db); assert.equal(sequence(db, last.id).sequence, 9007199254740991); cycle(db);
  assert.equal(boundary(db).watermark_sequence, 9007199254740991);
  const before = snapshot(db);
  for (const prefix of ['INSERT', 'INSERT OR IGNORE', 'INSERT OR REPLACE']) {
    assert.throws(() => review(db, 'p', { prefix }), /CHECK constraint failed|sequence capture failed/); assert.deepEqual(snapshot(db), before);
  }
});

test('fresh schema installs mandatory automatic capture and immutable row guards', t => {
  const { db, directory } = fixture(t); assert.equal(verifyWorkbenchSchema(db, join(directory, 'v20')).version, 20);
  const expected = ['listing_review_capture_sequence', 'listing_review_sequence_insert', 'listing_review_sequence_no_update', 'listing_review_sequence_no_delete',
    'evaluation_cycle_capture_listing_boundary', 'evaluation_listing_boundary_insert', 'evaluation_listing_boundary_no_update', 'evaluation_listing_boundary_no_delete'];
  for (const name of expected) assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name=?").get(name).n, 1, name);
});
