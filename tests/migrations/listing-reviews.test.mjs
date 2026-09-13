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
const Database = require('better-sqlite3'), Ajv = require('ajv/dist/2020'), addFormats = require('ajv-formats');
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const clone = value => JSON.parse(JSON.stringify(value));
const T = '2026-01-05T09:00:00.000000Z', LATER = '2026-01-05T09:00:00.999999Z', UNTIL = '2026-01-06T09:00:00.000000Z';
const insert = (db, table, row, prefix = 'INSERT') => db.prepare(`${prefix} INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?')})`).run(...Object.values(row));
const facts = patch => ({ instrument_kind: 'ETF', lifecycle_status: 'active', quantity_step: '1.000', price_step: '0.0100',
  source_effective_date: '2026-01-05', fund_identifier: 'SYNTHETIC-FUND', share_class_identifier: 'SYNTHETIC-CLASS',
  product_structure: { leverage: 'unleveraged', direction: 'long_only' },
  risk_classification: { index_id: 'SYNTHETIC-INDEX', region: 'Synthetic region', sector: 'Synthetic sector' }, ...patch });

function copyMigrations(directory, version) {
  const target = join(directory, `migrations-${version}`); mkdirSync(target);
  const original = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), migrations = original.migrations.slice(0, version);
  assert.equal(migrations.length, version);
  for (const row of migrations) cpSync(join(migrationDirectory, row.file), join(target, row.file));
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...original, migrations }));
  return target;
}
function source(db, { id = 'source', portfolio = 'p', creator = 'source-human', at = T, audited = true } = {}) {
  const text = '{\n "synthetic": true, "quantity_step": "1.000", "source_note": "Not provider data"\n}\n';
  const row = { id, portfolio_id: portfolio, reference: 'Synthetic identity review source', content_text: text,
    content_hash: sha(text), known_at: at, created_by: creator };
  insert(db, 'market_reference_sources', row);
  if (audited) insert(db, 'audit_events', { id: `${id}:store`, portfolio_id: portfolio, actor_id: creator,
    action: 'store_market_reference_source', object_type: 'market_reference_source', object_id: id, created_at: at,
    payload_json: canonical({ actor_kind: 'human', input_hash: sha(canonical({ portfolio_id: portfolio, reference: row.reference, content_text: text })),
      result: { id, portfolio_id: portfolio, reference: row.reference, content_hash: row.content_hash, known_at: at } }) });
  return row;
}
function fixture(t, version = 19) {
  const directory = mkdtempSync(join(tmpdir(), 'listing-review-migration-')), path = join(directory, 'workbench.db');
  const migrations = copyMigrations(directory, version); migrateWorkbench(path, { directory: migrations });
  const db = new Database(path); db.pragma('foreign_keys=ON'); db.pragma('recursive_triggers=OFF');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const id of ['p', 'other']) insert(db, 'portfolios', { id, name: 'Synthetic review fixture', created_at: T });
  insert(db, 'instruments', { id: 'instrument', name: 'Synthetic unverified instrument', created_at: T });
  insert(db, 'listings', { id: 'listing', instrument_id: 'instrument', market: 'US', exchange: 'XNAS', ticker: 'SYNTH', currency: 'USD', created_at: T });
  for (const portfolio_id of ['p', 'other']) insert(db, 'catalog_entries', { portfolio_id, listing_id: 'listing', created_at: T });
  source(db); source(db, { id: 'other-source', portfolio: 'other' });
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
function material(db, { portfolio = 'p', listing = 'listing', sourceId = portfolio === 'p' ? 'source' : 'other-source', at = T, fact = facts(), until = UNTIL } = {}) {
  const old = db.prepare('SELECT * FROM listing_review_heads WHERE portfolio_id=? AND listing_id=?').get(portfolio, listing);
  const revision = (old?.revision ?? 0) + 1, id = `${portfolio}:${listing}:review:${revision}`, auditId = `${id}:audit`;
  const origin = db.prepare('SELECT * FROM market_reference_sources WHERE id=?').get(sourceId);
  const identity = db.prepare('SELECT id AS listing_id,instrument_id,market,exchange,ticker,currency FROM listings WHERE id=?').get(listing);
  const doc = { schema_version: 'listing-review-v1', id, portfolio_id: portfolio, listing_id: listing, revision,
    source_id: sourceId, source_hash: origin.content_hash, source_known_at: origin.known_at, identity_snapshot: identity, identity_hash: sha(canonical(identity)),
    known_at: at, created_by: 'review-human', review_until: until, reason: 'Synthetic explicit review, not supplier verification', review_basis: 'human_reviewed_not_provider_verified', facts: fact };
  const row = { id, portfolio_id: portfolio, listing_id: listing, revision, source_id: doc.source_id, source_hash: doc.source_hash,
    source_known_at: doc.source_known_at, identity_json: canonical(identity), identity_hash: doc.identity_hash, known_at: at,
    created_by: doc.created_by, review_until: until, reason: doc.reason, facts_json: canonical(fact), document_json: canonical(doc),
    content_hash: sha(canonical(doc)), audit_id: auditId };
  const input = { portfolio_id: portfolio, listing_id: listing, expected_review_revision: revision - 1, expected_identity_hash: doc.identity_hash,
    source_id: sourceId, source_hash: doc.source_hash, facts: fact, review_until: until, reason: doc.reason, acknowledgement: true, idempotency_key: `${id}:key` };
  const result = { id, portfolio_id: portfolio, listing_id: listing, revision, content_hash: row.content_hash, identity_hash: doc.identity_hash,
    source_id: sourceId, source_hash: doc.source_hash, known_at: at, review_until: until, review_basis: doc.review_basis };
  const auditPayload = { actor_kind: 'human', input, result };
  const audit = { id: auditId, portfolio_id: portfolio, actor_id: doc.created_by, action: 'publish_listing_review', object_type: 'listing_review',
    object_id: id, created_at: at, payload_json: canonical(auditPayload) };
  const head = { portfolio_id: portfolio, listing_id: listing, revision, version_id: id, updated_at: at };
  return { row, doc, auditPayload, audit, head, old };
}
function updateHead(db, row, prefix = 'UPDATE') {
  db.prepare(`${prefix} listing_review_heads SET revision=@revision,version_id=@version_id,updated_at=@updated_at WHERE portfolio_id=@portfolio_id AND listing_id=@listing_id`).run(row);
}
function store(db, value, { head = true, prefix = 'INSERT', rawAudit } = {}) {
  db.transaction(() => {
    insert(db, 'audit_events', { ...value.audit, payload_json: rawAudit ?? canonical(value.auditPayload) });
    insert(db, 'listing_review_versions', value.row, prefix);
    if (head) { if (value.old) updateHead(db, value.head); else insert(db, 'listing_review_heads', value.head); }
  }).immediate();
}

test('v18 to v19 preserves every old column byte, creates empty review tables and does not seed actual facts', t => {
  const f = fixture(t, 18), before = snapshot(f.db).filter(row => row.name !== 'schema_migrations');
  const oldSchema = f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const migrations = copyMigrations(f.directory, 19);
  assert.equal(migrateWorkbench(f.path, { directory: migrations }).applied, 1);
  assert.deepEqual(snapshot(f.db, before.map(row => row.name)), before);
  for (const row of oldSchema) assert.deepEqual(f.db.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=?').get(row.name), row);
  for (const table of ['listing_review_versions', 'listing_review_heads', 'accounts', 'ledger_events', 'postings', 'position_movements', 'activations', 'proposals', 'reservations']) {
    assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  }
  const all = snapshot(f.db); f.db.pragma('wal_checkpoint(TRUNCATE)'); const bytes = sha(readFileSync(f.path));
  assert.equal(migrateWorkbench(f.path, { directory: migrations }).applied, 0);
  assert.equal(sha(readFileSync(f.path)), bytes); assert.deepEqual(snapshot(f.db), all);
  assert.equal(verifyWorkbenchSchema(f.db, migrations).version, 19);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []); assert.equal(f.db.pragma('quick_check', { simple: true }), 'ok');
});

test('portfolio-private reviews preserve exact step spelling without updating global identity or financial tables', t => {
  const { db } = fixture(t), before = snapshot(db, ['instruments', 'listings', 'ledger_heads', 'ledger_events', 'postings', 'valuation_runs', 'activations']);
  const first = material(db); store(db, first);
  store(db, material(db, { portfolio: 'other', fact: facts({ instrument_kind: 'unknown', lifecycle_status: 'unknown', quantity_step: null, price_step: null }) }));
  store(db, material(db, { at: LATER, fact: facts({ lifecycle_status: 'suspended', quantity_step: null, price_step: null }) }));
  assert.deepEqual(db.prepare('SELECT portfolio_id,revision FROM listing_review_heads ORDER BY portfolio_id').all(), [{ portfolio_id: 'other', revision: 1 }, { portfolio_id: 'p', revision: 2 }]);
  assert.equal(JSON.parse(db.prepare('SELECT facts_json FROM listing_review_versions WHERE id=?').get(first.row.id).facts_json).price_step, '0.0100');
  assert.equal(db.prepare("SELECT json_extract(v.facts_json,'$.lifecycle_status') state FROM listing_review_heads h JOIN listing_review_versions v ON v.id=h.version_id WHERE h.portfolio_id='p'").get().state, 'suspended');
  assert.deepEqual(snapshot(db, before.map(row => row.name)), before);
});

test('unknown and incomplete active reviews can revoke eligibility while only positive exact step text is stored', t => {
  const { db } = fixture(t);
  for (const fact of [facts({ quantity_step: null, price_step: null }), facts({ instrument_kind: 'ETN' }),
    facts({ instrument_kind: 'unknown', lifecycle_status: 'unknown' }), facts({ lifecycle_status: 'delisted' }),
    facts({ product_structure: { leverage: 'unknown', direction: 'unknown' } }),
    facts({ product_structure: { leverage: 'leveraged', direction: 'inverse' } }),
    facts({ quantity_step: '99999999999999999999.999999999999999999', price_step: '0.000000000000000001' })]) store(db, material(db, { fact }));
  const before = snapshot(db);
  for (const value of [0, 1.5, true, '0', '-0', '0.000', '-1', '1e-2', '01', '.1', '1.', '1..1', ' 1', '1 ', '1,000', 'NaN', 'Infinity', '0.0000000000000000001', '9'.repeat(39)]) {
    assert.throws(() => store(db, material(db, { fact: facts({ quantity_step: value }) })), undefined, String(value));
    assert.deepEqual(snapshot(db), before);
  }
});

test('source scope, original hash, source knowledge and a non-system human store audit are mandatory', t => {
  const { db } = fixture(t);
  source(db, { id: 'system-source', creator: 'system:collector' }); source(db, { id: 'unaudited', audited: false });
  source(db, { id: 'future-source', at: '2026-01-05T09:01:00.000000Z' });
  for (const sourceId of ['other-source', 'system-source', 'unaudited', 'future-source']) {
    assert.throws(() => store(db, material(db, { sourceId })), /source evidence/);
  }
  const stale = material(db); stale.row.source_hash = sha('unrelated'); assert.throws(() => store(db, stale));
  insert(db, 'portfolios', { id: 'not-member', name: 'Synthetic empty directory', created_at: T });
  source(db, { id: 'not-member-source', portfolio: 'not-member' });
  assert.throws(() => store(db, material(db, { portfolio: 'not-member', sourceId: 'not-member-source' })), /FOREIGN KEY/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM listing_review_versions').get().n, 0);
});

test('new reviews bind the current six-field identity, while old review bytes survive later identity changes', t => {
  const { db } = fixture(t); const first = material(db); store(db, first);
  const stale = material(db, { at: LATER }); db.prepare("UPDATE listings SET ticker='SYNTH-RENAMED' WHERE id='listing'").run();
  assert.throws(() => store(db, stale), /identity mismatch/);
  assert.equal(db.prepare('SELECT document_json FROM listing_review_versions WHERE id=?').get(first.row.id).document_json, first.row.document_json);
  const fresh = material(db, { at: LATER }); store(db, fresh);
  assert.notEqual(first.row.identity_hash, fresh.row.identity_hash);
  assert.equal(JSON.parse(fresh.row.identity_json).ticker, 'SYNTH-RENAMED');
});

test('review time uses exact UTC microseconds and legal calendar dates without rounding or backdating', t => {
  const { db } = fixture(t);
  store(db, material(db, { at: LATER, until: '2026-01-05T09:00:01.000000Z' }));
  for (const at of ['2026-01-05T09:00:00.999998Z', '2026-01-05T09:00:01.000Z', '2026-01-05T09:00:01.000000+00:00',
    '0000-01-05T09:00:01.000000Z', '2026-02-30T09:00:01.000000Z', '2026-01-05T24:00:00.000000Z']) {
    assert.throws(() => store(db, material(db, { at })), undefined, at);
  }
  for (const until of [LATER, T]) assert.throws(() => store(db, material(db, { at: LATER, until })));
  for (const date of ['0000-01-01', '2025-02-29', '2026-02-30', '2026-1-5', true, 20260105]) {
    assert.throws(() => store(db, material(db, { at: LATER, fact: facts({ source_effective_date: date }) })));
  }
  // Market-local future-date checks require IANA rules in both application verifiers, not a SQLite fixed UTC offset.
  store(db, material(db, { at: LATER, fact: facts({ source_effective_date: null }) }));
});

test('human audit has exact keys and binds scope, acknowledgement, identity CAS, revision, facts and returned hashes', t => {
  const { db } = fixture(t), before = snapshot(db);
  for (const change of [
    v => { v.audit.actor_id = 'another-human'; }, v => { v.row.created_by = 'system:forged'; },
    v => { v.audit.portfolio_id = 'other'; }, v => { v.audit.object_type = 'other'; }, v => { v.audit.object_id = 'other'; },
    v => { v.audit.action = 'store_market_reference_source'; }, v => { v.audit.ledger_revision = 0; }, v => { v.audit.created_at = LATER; },
    v => { v.auditPayload.actor_kind = 'ai'; }, v => { v.auditPayload.extra = true; },
    v => { v.auditPayload.input.extra = true; }, v => { delete v.auditPayload.input.reason; },
    v => { v.auditPayload.input.acknowledgement = false; }, v => { v.auditPayload.input.expected_review_revision = 1; },
    v => { v.auditPayload.input.expected_review_revision = '0'; }, v => { v.auditPayload.input.expected_identity_hash = sha('old identity'); },
    v => { v.auditPayload.input.idempotency_key = 'bad key'; }, v => { v.auditPayload.input.source_hash = sha('other'); },
    v => { v.auditPayload.input.facts = { ...v.auditPayload.input.facts, lifecycle_status: 'delisted' }; },
    v => { v.auditPayload.result.extra = 'PASS'; }, v => { v.auditPayload.result.revision = true; },
    v => { v.auditPayload.result.content_hash = sha('other'); }, v => { v.auditPayload.result.review_basis = 'provider_verified'; },
  ]) {
    const value = material(db); change(value); assert.throws(() => store(db, value)); assert.deepEqual(snapshot(db), before);
  }
  const value = material(db), duplicate = canonical(value.auditPayload).replace('"actor_kind":"human"', '"actor_kind":"ai","actor_kind":"human"');
  assert.throws(() => store(db, value, { rawAudit: duplicate })); assert.deepEqual(snapshot(db), before);
});

test('document and nested facts cannot add unknown keys, duplicate fields or differ from the immutable row', t => {
  const { db } = fixture(t), before = snapshot(db);
  for (const change of [v => { v.row.document_json = canonical({ ...v.doc, extra: 'provider_verified' }); },
    v => { v.row.document_json = canonical({ ...v.doc, identity_hash: sha('other') }); },
    v => { v.row.document_json = canonical({ ...v.doc, revision: '1' }); },
    v => { v.row.identity_json = canonical({ ...v.doc.identity_snapshot, asset_class: 'ETF' }); },
    v => { v.row.facts_json = canonical({ ...v.doc.facts, tradable: true }); },
    v => { v.row.facts_json = canonical({ ...v.doc.facts, risk_classification: { ...v.doc.facts.risk_classification, weight: '1' } }); },
    v => { v.row.facts_json = canonical({ ...v.doc.facts, product_structure: { leverage: true, direction: 'long_only' } }); },
    v => { v.row.facts_json = canonical({ ...v.doc.facts, product_structure: { leverage: 'unleveraged', direction: 'long_only', permission: true } }); },
    v => { v.row.facts_json = v.row.facts_json.replace('"instrument_kind":"ETF"', '"instrument_kind":"ETF","instrument_kind":"ETF"'); },
    v => { v.row.document_json = Buffer.from(v.row.document_json); }, v => { v.row.facts_json = '[]'; }]) {
    const value = material(db); change(value); assert.throws(() => store(db, value)); assert.deepEqual(snapshot(db), before);
  }
});

test('append-only rows reject UPDATE, DELETE and every unique INSERT OR REPLACE alias with recursive triggers off', t => {
  const { db } = fixture(t); const first = material(db); store(db, first);
  const second = material(db, { at: LATER }); store(db, second);
  const other = material(db, { portfolio: 'other' }); store(db, other);
  const before = snapshot(db);
  for (const statement of ["UPDATE listing_review_versions SET reason='changed'", 'DELETE FROM listing_review_versions',
    'DELETE FROM listing_review_heads', "UPDATE listing_review_heads SET revision=1,version_id='p:listing:review:1' WHERE portfolio_id='p'",
    "UPDATE OR REPLACE listing_review_heads SET portfolio_id='other' WHERE portfolio_id='p'"]) {
    assert.throws(() => db.exec(statement)); assert.deepEqual(snapshot(db), before);
  }
  for (const patch of [{}, { id: 'alias', audit_id: first.row.audit_id }, { id: 'alias', audit_id: 'unused-audit' },
    { id: 'alias', revision: 3, audit_id: first.row.audit_id }]) {
    assert.throws(() => insert(db, 'listing_review_versions', { ...first.row, ...patch }, 'INSERT OR REPLACE'), /cannot be replaced/);
    assert.deepEqual(snapshot(db), before);
  }
  assert.throws(() => insert(db, 'listing_review_heads', first.head, 'INSERT OR REPLACE'), /cannot be replaced/);
  assert.deepEqual(snapshot(db), before);
});

test('head changes are one revision at a time and cannot skip an unpublished version or cross portfolio identity', t => {
  const { db } = fixture(t); const first = material(db); store(db, first);
  const next = material(db, { at: LATER }); store(db, next, { head: false });
  assert.throws(() => insert(db, 'listing_review_versions', { ...next.row, id: 'orphan-next', revision: 3, audit_id: 'orphan-audit' }), /CAS/);
  for (const patch of [{ revision: 3 }, { updated_at: T }, { version_id: first.row.id }, { portfolio_id: 'other' }]) {
    assert.throws(() => insert(db, 'listing_review_heads', { ...next.head, ...patch }), /cannot be replaced|revision one/);
  }
  assert.throws(() => updateHead(db, { ...next.head, revision: 3 }), /CAS/);
  updateHead(db, next.head); assert.equal(db.prepare("SELECT revision FROM listing_review_heads WHERE portfolio_id='p'").get().revision, 2);
});

test('shared strict schema accepts explicit unknowns and rejects floating facts, extra authority and malformed identity/time', t => {
  const { db } = fixture(t), ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv);
  for (const file of readdirSync(join(root, 'contracts/v1')).filter(file => file.endsWith('.schema.json'))) ajv.addSchema(JSON.parse(readFileSync(join(root, 'contracts/v1', file))));
  const validate = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/listing-review.schema.json');
  const good = material(db).doc; assert.equal(validate(good), true, JSON.stringify(validate.errors));
  const unknown = { ...good, facts: facts({ quantity_step: null, price_step: null, fund_identifier: null, share_class_identifier: null, source_effective_date: null,
    risk_classification: { index_id: null, region: null, sector: null } }) };
  assert.equal(validate(unknown), true, JSON.stringify(validate.errors));
  for (const mutate of [v => { v.facts.quantity_step = 1; }, v => { v.facts.price_step = 0.01; }, v => { v.facts.quantity_step = true; },
    v => { v.facts.quantity_step = '0'; }, v => { v.facts.price_step = '1e-2'; }, v => { v.facts.quantity_step = '9'.repeat(39); },
    v => { v.facts.source_effective_date = '2026-02-30'; }, v => { v.facts.source_effective_date = '0000-01-01'; },
    v => { v.facts.risk_classification.weight = '1'; }, v => { v.facts.instrument_kind = 'verified_ETF'; },
    v => { delete v.facts.product_structure; }, v => { v.facts.product_structure.leverage = null; },
    v => { v.facts.product_structure.direction = 'neutral'; }, v => { v.facts.product_structure.multiplier = '1'; },
    v => { v.facts.fund_identifier = ' '; }, v => { v.facts.share_class_identifier = 'x'.repeat(161); },
    v => { v.identity_snapshot.verified_at = T; }, v => { v.identity_snapshot.market = 'OTHER'; },
    v => { v.created_by = 'human with space'; }, v => { v.created_by = 'system:verifier'; }, v => { v.review_basis = 'provider_verified'; },
    v => { v.known_at = '2026-01-05T09:00:00.000Z'; }, v => { v.known_at = '2026-01-05T09:00:00.000000+00:00'; },
    v => { v.revision = 9007199254740992; }, v => { v.revision = true; }, v => { v.extra = true; }]) {
    const invalid = clone(good); mutate(invalid); assert.equal(validate(invalid), false, canonical(invalid));
  }
});
