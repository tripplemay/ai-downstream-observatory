import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadMigrations, migrateWorkbench, migrationDirectory } from '../../scripts/migrate-workbench.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const Database = createRequire(join(root, 'web/package.json'))('better-sqlite3');
const now = '2026-01-01T00:00:00.000Z', digest = 'a'.repeat(64);
function fixture(t, previous = false) {
  const directory = mkdtempSync(join(tmpdir(), 'etf-catalog-migration-')), path = join(directory, 'workbench.db');
  if (previous) {
    const old = join(directory, 'v12'); mkdirSync(old);
    const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'), 'utf8'));
    for (const item of manifest.migrations.slice(0, 12)) cpSync(join(migrationDirectory, item.file), join(old, item.file));
    writeFileSync(join(old, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 12) }));
    migrateWorkbench(path, { directory: old });
  } else migrateWorkbench(path);
  const db = new Database(path); db.pragma('foreign_keys=ON');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const id of ['p', 'q']) db.prepare('INSERT INTO portfolios(id,name,created_at) VALUES(?,?,?)').run(id, 'Synthetic', now);
  db.prepare("INSERT INTO instruments(id,name,created_at) VALUES('i','Synthetic ETF',?)").run(now);
  db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('l','i','CN','SYNTHETIC','000001','CNY',?)").run(now);
  return { db, path };
}
function entries(db) {
  for (const portfolio of ['p', 'q']) {
    db.prepare('INSERT INTO catalog_entries VALUES(?,?,?)').run(portfolio, 'l', now);
    db.prepare("INSERT INTO catalog_sources VALUES(?,?,?,'application/json',?,?,?,?)").run(`source:${portfolio}`, portfolio, 'Synthetic reference', '{}', digest, now, 'synthetic-actor');
  }
}
function profile(db, id, portfolio = 'p', source = 'source:p', version = 1) {
  return db.prepare('INSERT INTO etf_profile_versions VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, portfolio, 'l', version, source, '2025-12-31', now, '{}', digest, 'synthetic-actor');
}
function holding(db, id, portfolio = 'p', source = 'source:p', patch = {}, version = 1) {
  const snapshot = { schema_version: 'holdings-disclosure-v1', snapshot_id: id, portfolio_id: portfolio, listing_id: 'l', version, as_of: '2025-12-31', known_at: now, weight_basis: 'net_assets_long_only', complete: false, coverage: '0.00', items: [], content_hash: digest, ...patch };
  return db.prepare('INSERT INTO etf_holdings_versions VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, portfolio, 'l', version, source, '2025-12-31', now, JSON.stringify(snapshot), digest, 'synthetic-actor');
}

test('v12 to v13 preserves existing facts, source identity and ledger revision; repeat migration is a no-op', t => {
  const { db, path } = fixture(t, true);
  db.prepare("INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES('a','p','Synthetic','synthetic','CNY',?)").run(now);
  db.prepare("INSERT INTO ledger_heads VALUES('p',1,?)").run(now);
  db.prepare("INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,recorded_at,source_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id) VALUES('event','p','a','deposit',?,?,'synthetic','event',?,'{}',1,'synthetic')").run(now, now, digest);
  db.prepare("INSERT INTO postings VALUES('posting','event','a','CNY','cash_settled','0.100000000000000001')").run();
  const tables = ['portfolios', 'instruments', 'listings', 'ledger_heads', 'ledger_events', 'postings'];
  const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
  assert.equal(migrateWorkbench(path).applied, loadMigrations().length - 12);
  assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()), before);
  for (const table of ['catalog_entries', 'catalog_sources', 'etf_profile_versions', 'etf_holdings_versions', 'catalog_heads']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  assert.equal(migrateWorkbench(path).applied, 0);
  entries(db); profile(db, 'profile'); holding(db, 'holding');
  db.prepare("INSERT INTO catalog_heads VALUES('p',1,?)").run(now);
  db.prepare("UPDATE catalog_heads SET revision=2 WHERE portfolio_id='p'").run();
  assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()), before);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
});

test('catalog source and version compound foreign keys prevent cross-portfolio overwrite or reuse', t => {
  const { db } = fixture(t); entries(db);
  profile(db, 'p-profile'); profile(db, 'q-profile', 'q', 'source:q');
  holding(db, 'p-holding'); holding(db, 'q-holding', 'q', 'source:q');
  assert.throws(() => profile(db, 'cross-profile', 'p', 'source:q', 2), /FOREIGN KEY/);
  assert.throws(() => holding(db, 'cross-holding', 'p', 'source:q', {}, 2), /FOREIGN KEY/);
  assert.throws(() => profile(db, 'duplicate-version'), /UNIQUE/);
  assert.throws(() => holding(db, 'duplicate-version'), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO catalog_entries VALUES('p','unknown',?)").run(now), /FOREIGN KEY/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger_events').get().n, 0);
});

test('original structured JSON, catalog membership and published versions are immutable; head increments once', t => {
  const { db } = fixture(t); entries(db); profile(db, 'profile'); holding(db, 'holding');
  for (const [table, field] of [['catalog_sources', 'reference'], ['catalog_entries', 'created_at'], ['etf_profile_versions', 'profile_json'], ['etf_holdings_versions', 'snapshot_json']]) {
    assert.throws(() => db.prepare(`UPDATE ${table} SET ${field}=${field}`).run(), /append-only/);
    assert.throws(() => db.prepare(`DELETE FROM ${table}`).run(), /append-only/);
  }
  db.prepare("INSERT INTO catalog_heads VALUES('p',0,?)").run(now);
  for (const revision of [0, 2, -1]) assert.throws(() => db.prepare("UPDATE catalog_heads SET revision=? WHERE portfolio_id='p'").run(revision), /advance once/);
  db.prepare("UPDATE catalog_heads SET revision=1 WHERE portfolio_id='p'").run();
  assert.throws(() => db.prepare('DELETE FROM catalog_heads').run(), /cannot be deleted/);
});

test('stored snapshot metadata is bound to row identity, revision, scope, dates and content hash', t => {
  const { db } = fixture(t); entries(db);
  for (const patch of [{ schema_version: 'wrong' }, { snapshot_id: 'wrong' }, { portfolio_id: 'q' }, { listing_id: 'wrong' }, { version: '1' }, { version: 2 }, { as_of: '2025-12-30' }, { known_at: '2026-01-02T00:00:00Z' }, { content_hash: 'b'.repeat(64) }, { content_hash: null }]) {
    assert.throws(() => holding(db, 'held', 'p', 'source:p', patch), /CHECK/);
  }
  holding(db, 'held');
  assert.equal(JSON.parse(db.prepare('SELECT snapshot_json FROM etf_holdings_versions').get().snapshot_json).coverage, '0.00');
});

test('catalog original size is measured in UTF8 bytes and only JSON objects are accepted', t => {
  const { db } = fixture(t);
  const insert = db.prepare("INSERT INTO catalog_sources VALUES(?,'p','Synthetic','application/json',?,?,?,'synthetic')");
  for (const document of ['[]', 'null', 'broken', JSON.stringify({ text: '中'.repeat(349526) })]) assert.throws(() => insert.run('bad', document, digest, now), /CHECK|malformed JSON/);
  insert.run('exact', JSON.stringify({ text: 'a'.repeat(1048565) }), digest, now);
  assert.equal(db.prepare("SELECT length(CAST(content_text AS BLOB)) bytes FROM catalog_sources WHERE id='exact'").get().bytes, 1048576);
  assert.throws(() => insert.run('too-large', JSON.stringify({ text: 'a'.repeat(1048566) }), digest, now), /CHECK/);
});
