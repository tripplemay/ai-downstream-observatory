import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadMigrations, migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'web/package.json'));
const Database = require('better-sqlite3');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const now = '2026-01-01T00:00:00.000Z';
const schemaVersion = loadMigrations().length;

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'etf-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'workbench.db') };
}

function database(t, path) {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  t.after(() => db.close());
  return db;
}

function seedScopes(db) {
  for (const suffix of ['a', 'b']) {
    db.prepare('INSERT INTO portfolios(id,name,created_at) VALUES (?,?,?)').run(`p-${suffix}`, suffix, now);
    db.prepare('INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES (?,?,?,?,?,?)').run(`a-${suffix}`, `p-${suffix}`, suffix, 'synthetic', 'CNY', now);
  }
  db.prepare('INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES (?,?,?,?,?,?)').run('a-a2', 'p-a', 'internal', 'synthetic', 'CNY', now);
}

function event(db, id, { type = 'deposit', sourceId = null, environment = 'actual', account = 'a-a', portfolio = 'p-a', reversal = null } = {}) {
  db.prepare(`INSERT INTO ledger_events(id,portfolio_id,account_id,environment,event_type,effective_at,recorded_at,source_id,source_event_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id,reversal_of)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, portfolio, account, environment, type, now, now, 'fixture', sourceId, id, 'a'.repeat(64), '{}', 1, 'test', reversal);
}

test('E-01/E-29/E-31: explicit fresh migration, no seeded money, repeat is no-op', (t) => {
  const { path } = temporary(t);
  assert.equal(migrateWorkbench(path).applied, schemaVersion);
  const db = database(t, path);
  assert.equal(verifyWorkbenchSchema(db).version, schemaVersion);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  for (const table of ['portfolios', 'accounts', 'ledger_events', 'funding_plan_versions', 'policy_versions', 'activations', 'proposals']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} must be empty`);
  }
  assert.equal(migrateWorkbench(path).applied, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, schemaVersion);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
});

test('v9 to v10 preserves postings byte-for-byte and retains append-only/scope constraints', (t) => {
  const { directory, path } = temporary(t), oldDirectory = join(directory, 'v9');
  mkdirSync(oldDirectory);
  const previous = loadMigrations().slice(0, 9);
  for (const migration of previous) cpSync(join(migrationDirectory, migration.file), join(oldDirectory, migration.file));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'), 'utf8'));
  writeFileSync(join(oldDirectory, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 9) }));
  assert.equal(migrateWorkbench(path, { directory: oldDirectory }).applied, 9);
  const db = database(t, path); seedScopes(db); event(db, 'v9-deposit');
  db.prepare('INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES(?,?,?,?,?,?)').run('v9-precise', 'v9-deposit', 'a-a', 'CNY', 'cash_settled', '0.100000000000000001');
  const before = db.prepare('SELECT * FROM postings ORDER BY id').all();
  assert.equal(migrateWorkbench(path).applied, schemaVersion - 9);
  assert.deepEqual(db.prepare('SELECT * FROM postings ORDER BY id').all(), before);
  for (const table of ['security_transit_movements', 'security_transit_projections']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  assert.throws(() => db.prepare("UPDATE postings SET amount='999'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM postings').run(), /append-only/);
  assert.throws(() => db.prepare("INSERT INTO postings VALUES('cross','v9-deposit','a-b','CNY','inventory_in_transit_cost','1')").run(), /portfolio mismatch/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
});

test('E-31: legacy and unrelated databases, including symlink aliases, remain unchanged', (t) => {
  const { directory } = temporary(t);
  for (const [name, ddl] of [
    ['observatory.db', 'CREATE TABLE themes(id TEXT PRIMARY KEY); INSERT INTO themes VALUES (\'ai-downstream\')'],
    ['old-single.db', 'CREATE TABLE metrics(id TEXT); INSERT INTO metrics VALUES (\'old\')'],
    ['old-etf.db', 'CREATE TABLE paper_accounts(id TEXT); INSERT INTO paper_accounts VALUES (\'paper\')'],
    ['unrelated.db', 'CREATE TABLE secret_fixture(id TEXT); INSERT INTO secret_fixture VALUES (\'synthetic\')'],
  ]) {
    const path = join(directory, name);
    const old = new Database(path);
    old.exec(ddl); old.close();
    const before = hash(path);
    assert.throws(() => migrateWorkbench(path), /LEGACY_DATABASE_WRITE_FORBIDDEN|NON_WORKBENCH_DATABASE_REFUSED/);
    assert.equal(hash(path), before);
  }
  const alias = join(directory, 'alias.db');
  symlinkSync(join(directory, 'observatory.db'), alias);
  assert.throws(() => migrateWorkbench(alias), /LEGACY_DATABASE_WRITE_FORBIDDEN/);
  assert.throws(() => migrateWorkbench('relative.db'), /ABSOLUTE_WORKBENCH_DB_PATH_REQUIRED/);
});

test('E-31: changed migration source, history or unknown database version fails closed', (t) => {
  const { directory, path } = temporary(t);
  const clone = join(directory, 'migrations');
  cpSync(migrationDirectory, clone, { recursive: true });
  writeFileSync(join(clone, '0001_workbench.sql'), `${readFileSync(join(clone, '0001_workbench.sql'), 'utf8')}\n-- tampered\n`);
  assert.throws(() => migrateWorkbench(path, { directory: clone }), /MIGRATION_CHECKSUM_MISMATCH/);
  migrateWorkbench(path);
  const db = database(t, path);
  db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=1').run('0'.repeat(64));
  assert.throws(() => migrateWorkbench(path), /APPLIED_MIGRATION_MISMATCH/);
  assert.throws(() => verifyWorkbenchSchema(db), /APPLIED_MIGRATION_MISMATCH/);
  db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=1').run(loadMigrations()[0].sha256);
  db.pragma('user_version = 77');
  assert.throws(() => migrateWorkbench(path), /WORKBENCH_SCHEMA_VERSION_MISMATCH/);
  assert.throws(() => verifyWorkbenchSchema(db), /WORKBENCH_SCHEMA_VERSION_MISMATCH/);
});

test('E-31/E-32: interrupted or invalid pending migration rolls back all schema and versions', (t) => {
  const { directory, path } = temporary(t);
  const clone = join(directory, 'migrations');
  cpSync(migrationDirectory, clone, { recursive: true });
  const sql = 'CREATE TABLE incomplete(id TEXT); INVALID SQL HERE;';
  const filename = `${String(schemaVersion + 1).padStart(4, '0')}_failure.sql`;
  writeFileSync(join(clone, filename), sql);
  const manifest = JSON.parse(readFileSync(join(clone, 'manifest.json'), 'utf8'));
  manifest.migrations.push({ version: schemaVersion + 1, file: filename, sha256: createHash('sha256').update(sql).digest('hex') });
  writeFileSync(join(clone, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => migrateWorkbench(path, { directory: clone }), /syntax error/);
  const db = database(t, path);
  assert.equal(db.pragma('user_version', { simple: true }), 0);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), []);
  assert.equal(migrateWorkbench(path).applied, schemaVersion);
});

test('migration recovery guard refuses fresh, existing and separately configured data directories', (t) => {
  const { directory, path } = temporary(t), marker = join(directory, 'RESTORE_PENDING_REVIEW');
  writeFileSync(marker, 'synthetic recovery review');
  assert.throws(() => migrateWorkbench(path), /RESTORE_PENDING_REVIEW/);
  assert.equal(existsSync(path), false, 'pending recovery never creates an empty database');
  rmSync(marker); migrateWorkbench(path);
  const before = hash(path);
  writeFileSync(marker, 'synthetic recovery review');
  assert.throws(() => migrateWorkbench(path), /RESTORE_PENDING_REVIEW/);
  assert.equal(hash(path), before);
  rmSync(marker);
  const dataDir = join(directory, 'separate-data'); mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'RESTORE_PENDING_REVIEW'), 'synthetic recovery review');
  const prior = process.env.WORKBENCH_DATA_DIR;
  try {
    process.env.WORKBENCH_DATA_DIR = dataDir;
    assert.throws(() => migrateWorkbench(path), /RESTORE_PENDING_REVIEW/);
    assert.equal(hash(path), before);
  } finally {
    if (prior === undefined) delete process.env.WORKBENCH_DATA_DIR; else process.env.WORKBENCH_DATA_DIR = prior;
  }
});

test('migration rolls back pending DDL and version when recovery starts before commit', (t) => {
  const { directory, path } = temporary(t); migrateWorkbench(path);
  const clone = join(directory, 'migrations'); cpSync(migrationDirectory, clone, { recursive: true });
  const sql = 'CREATE TABLE recovery_guard_probe(id TEXT);';
  const file = `${String(schemaVersion + 1).padStart(4, '0')}_recovery_probe.sql`;
  writeFileSync(join(clone, file), sql);
  const manifest = JSON.parse(readFileSync(join(clone, 'manifest.json'), 'utf8'));
  manifest.migrations.push({ version: schemaVersion + 1, file, sha256: createHash('sha256').update(sql).digest('hex') });
  writeFileSync(join(clone, 'manifest.json'), JSON.stringify(manifest));
  const original = Database.prototype.exec;
  let injected = false;
  try {
    Database.prototype.exec = function (text) {
      const result = original.call(this, text);
      if (text === sql) { injected = true; writeFileSync(join(directory, 'RESTORE_PENDING_REVIEW'), 'synthetic concurrent recovery'); }
      return result;
    };
    assert.throws(() => migrateWorkbench(path, { directory: clone }), /RESTORE_PENDING_REVIEW/);
  } finally { Database.prototype.exec = original; }
  assert.equal(injected, true);
  const db = database(t, path);
  assert.equal(db.pragma('user_version', { simple: true }), schemaVersion);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n, schemaVersion);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='recovery_guard_probe'").get(), undefined);
  assert.equal(verifyWorkbenchSchema(db).version, schemaVersion);
});

test('explicit first migration may initialize a read_only deployment without seeding funds', (t) => {
  const { path } = temporary(t), prior = process.env.WORKBENCH_MODE;
  try {
    process.env.WORKBENCH_MODE = 'read_only';
    assert.equal(migrateWorkbench(path).applied, schemaVersion);
    const db = database(t, path);
    for (const table of ['portfolios', 'accounts', 'ledger_events', 'activations', 'command_requests']) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
    }
  } finally {
    if (prior === undefined) delete process.env.WORKBENCH_MODE; else process.env.WORKBENCH_MODE = prior;
  }
});

test('E-07/E-13/E-22: source identity, immutable facts, reversal uniqueness and portfolio isolation', (t) => {
  const { path } = temporary(t);
  migrateWorkbench(path);
  const db = database(t, path);
  seedScopes(db);
  event(db, 'deposit-1', { sourceId: 'broker-1' });
  assert.throws(() => event(db, 'duplicate', { sourceId: 'broker-1' }), /UNIQUE/);
  event(db, 'settlement-same-source', { type: 'settlement', sourceId: 'broker-1' });
  event(db, 'equal-amount-distinct-source', { sourceId: 'broker-2' });
  assert.throws(() => event(db, 'simulation-contamination', { environment: 'simulation' }), /CHECK/);
  assert.throws(() => event(db, 'scope-error', { portfolio: 'p-b' }), /FOREIGN KEY/);
  assert.throws(() => db.prepare('UPDATE ledger_events SET payload_json=? WHERE id=?').run('{"tampered":true}', 'deposit-1'), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM ledger_events WHERE id=?').run('deposit-1'), /append-only/);
  event(db, 'reversal-1', { type: 'reversal', reversal: 'deposit-1' });
  assert.throws(() => event(db, 'reversal-2', { type: 'reversal', reversal: 'deposit-1' }), /UNIQUE/);
  const insert = db.prepare('INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES (?,?,?,?,?,?)');
  insert.run('post-1', 'deposit-1', 'a-a', 'CNY', 'cash_settled', '0.100000000000000001');
  insert.run('post-internal', 'deposit-1', 'a-a2', 'CNY', 'transfer_in_transit', '-0.100000000000000001');
  assert.throws(() => insert.run('post-cross', 'deposit-1', 'a-b', 'CNY', 'cash_settled', '1'), /portfolio mismatch/);
  assert.equal(db.prepare('SELECT amount FROM postings WHERE id=?').get('post-1').amount, '0.100000000000000001');
  assert.throws(() => db.prepare('UPDATE postings SET amount=? WHERE id=?').run('9', 'post-1'), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM postings WHERE id=?').run('post-1'), /append-only/);
});

test('E-11/E-12: price basis and revisions coexist and publication cannot reference absent batches', (t) => {
  const { path } = temporary(t);
  migrateWorkbench(path);
  const db = database(t, path);
  db.prepare('INSERT INTO market_batches(id,source_id,batch_type,scope,status,started_at) VALUES (?,?,?,?,?,?)').run('batch-1', 'fixture', 'prices', 'CN', 'staging', now);
  const insert = db.prepare(`INSERT INTO market_observations(id,batch_id,source_id,series_key,metric,value,unit,observed_at,ingested_at,price_basis,revision_id,raw_hash,parser_version,provenance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run('raw', 'batch-1', 'fixture', '000001', 'close', '10.000000000000000001', 'CNY', now, now, 'unadjusted', 'r1', 'a'.repeat(64), 'v1', 'reconstructed');
  insert.run('adjusted', 'batch-1', 'fixture', '000001', 'close', '9', 'CNY', now, now, 'forward_adjusted', 'r1', 'b'.repeat(64), 'v1', 'reconstructed');
  insert.run('revised', 'batch-1', 'fixture', '000001', 'close', '10.1', 'CNY', now, now, 'unadjusted', 'r2', 'c'.repeat(64), 'v1', 'reconstructed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_observations').get().n, 3);
  assert.throws(() => db.prepare('UPDATE market_observations SET value=? WHERE id=?').run('42', 'raw'), /append-only/);
  const publish = db.prepare('INSERT INTO market_publications(scope,batch_id,manifest_hash,revision,published_at) VALUES (?,?,?,?,?)');
  assert.throws(() => publish.run('CN', 'absent', 'd'.repeat(64), 1, now), /FOREIGN KEY|validated/);
  assert.throws(() => publish.run('CN', 'batch-1', 'd'.repeat(64), 1, now), /validated/);
  db.prepare('UPDATE market_batches SET status=?,manifest_hash=? WHERE id=?').run('validated', 'd'.repeat(64), 'batch-1');
  assert.throws(() => publish.run('CN', 'batch-1', 'a'.repeat(64), 1, now), /matching manifest/);
  publish.run('CN', 'batch-1', 'd'.repeat(64), 1, now);
  assert.throws(() => db.prepare('UPDATE market_publications SET revision=1 WHERE scope=?').run('CN'), /newer/);
});

test('E-17/E-22: funding plans and research cannot become real facts via schema defaults', (t) => {
  const { path } = temporary(t);
  migrateWorkbench(path);
  const db = database(t, path);
  seedScopes(db);
  db.prepare('INSERT INTO funding_plan_versions(id,portfolio_id,version,plan_json,content_hash,actor_id,created_at) VALUES (?,?,?,?,?,?,?)').run('plan', 'p-a', 1, '{"initial_budget":"80000"}', 'a'.repeat(64), 'user', now);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_events').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_projections').get().n, 0);
  const research = db.prepare('INSERT INTO research_runs(id,portfolio_id,environment,input_manifest,experiment_plan_json,status,created_at) VALUES (?,?,?,?,?,?,?)');
  assert.throws(() => research.run('actual-run', 'p-a', 'actual', '{}', '{}', 'queued', now), /CHECK/);
  research.run('research-run', 'p-a', 'research', '{}', '{}', 'queued', now);
  assert.throws(() => db.prepare('INSERT INTO simulation_events(id,run_id,environment,sequence,event_type,effective_at,payload_json) VALUES (?,?,?,?,?,?,?)').run('actual-event', 'research-run', 'actual', 1, 'buy', now, '{}'), /CHECK|environment mismatch/);
});

test('E-17/E-19: policy activation is scoped, non-overlapping and cannot rewrite approval history', (t) => {
  const { path } = temporary(t);
  migrateWorkbench(path);
  const db = database(t, path);
  seedScopes(db);
  for (const suffix of ['a', 'b']) {
    db.prepare('INSERT INTO policy_versions(id,portfolio_id,version,policy_json,content_hash,created_by,created_at) VALUES (?,?,?,?,?,?,?)').run(`policy-${suffix}`, `p-${suffix}`, 1, '{}', 'a'.repeat(64), 'user', now);
  }
  const activate = db.prepare('INSERT INTO activations(id,portfolio_id,policy_version_id,mode,valid_from,valid_to,evidence_json,approved_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
  assert.throws(() => activate.run('wrong', 'p-a', 'policy-b', 'simulation', now, null, '{}', 'user', now), /portfolio mismatch/);
  activate.run('approved', 'p-a', 'policy-a', 'simulation', now, '2026-02-01T00:00:00.000Z', '{}', 'user', now);
  assert.throws(() => activate.run('overlap', 'p-a', 'policy-a', 'simulation', '2026-01-15T00:00:00.000Z', null, '{}', 'user', now), /overlaps/);
  activate.run('next', 'p-a', 'policy-a', 'simulation', '2026-02-01T00:00:00.000Z', null, '{}', 'user', now);
  assert.throws(() => db.prepare('UPDATE activations SET approved_by=? WHERE id=?').run('AI', 'next'), /closing/);
  db.prepare('UPDATE activations SET valid_to=? WHERE id=?').run('2026-03-01T00:00:00.000Z', 'next');
  assert.throws(() => db.prepare('UPDATE activations SET valid_to=NULL WHERE id=?').run('next'), /closing/);
  assert.throws(() => db.prepare('DELETE FROM activations WHERE id=?').run('next'), /cannot be deleted/);
  assert.throws(() => db.prepare('UPDATE policy_versions SET policy_json=? WHERE id=?').run('{"risk":"unlimited"}', 'policy-a'), /append-only/);
});

test('E-10/E-12: market page originals, reused membership and historical publications are immutable', (t) => {
  const { path } = temporary(t);
  migrateWorkbench(path);
  const db = database(t, path);
  const batch = db.prepare('INSERT INTO market_batches(id,source_id,batch_type,scope,status,expected_pages,started_at) VALUES (?,?,?,?,?,?,?)');
  const page = db.prepare('INSERT INTO market_batch_pages(batch_id,page_number,payload_hash,observations_json,received_at) VALUES (?,?,?,?,?)');
  const member = db.prepare('INSERT INTO market_batch_members(batch_id,observation_id) VALUES (?,?)');
  const history = db.prepare('INSERT INTO market_publication_events(scope,revision,batch_id,manifest_hash,published_at) VALUES (?,?,?,?,?)');
  const digest = 'a'.repeat(64);
  batch.run('one', 'fixture', 'prices', 'CN', 'staging', 1, now);
  assert.throws(() => batch.run('bad-start', 'fixture', 'prices', 'CN', 'published', 1, now), /begin staging/);
  assert.throws(() => page.run('one', 2, digest, '[]', now), /expected page/);
  page.run('one', 1, digest, '[]', now);
  assert.throws(() => db.prepare('UPDATE market_batch_pages SET observations_json=? WHERE batch_id=?').run('["changed"]', 'one'), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM market_batch_pages WHERE batch_id=?').run('one'), /append-only/);
  db.prepare(`INSERT INTO market_observations(id,batch_id,source_id,series_key,metric,value,unit,observed_at,ingested_at,price_basis,revision_id,raw_hash,parser_version,provenance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('observation', 'one', 'fixture', '000001', 'close', '10', 'CNY', now, now, 'unadjusted', 'r1', digest, 'v1', 'reconstructed');
  member.run('one', 'observation');
  db.prepare('UPDATE market_batches SET status=?,manifest_hash=? WHERE id=?').run('validated', digest, 'one');
  assert.throws(() => page.run('one', 1, digest, '[]', now), /staging/);
  history.run('CN', 1, 'one', digest, now);
  db.prepare("UPDATE market_batches SET status='published' WHERE id='one'").run();
  assert.throws(() => db.prepare("UPDATE market_batches SET row_count=99 WHERE id='one'").run(), /frozen/);
  batch.run('two', 'fixture', 'prices', 'CN', 'staging', 1, now);
  member.run('two', 'observation');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_observations').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_batch_members').get().n, 2);
  db.prepare('UPDATE market_batches SET status=?,manifest_hash=? WHERE id=?').run('validated', digest, 'two');
  assert.throws(() => history.run('CN', 3, 'two', digest, '2026-01-02T00:00:00Z'), /next revision/);
  history.run('CN', 2, 'two', digest, '2026-01-02T00:00:00Z');
  assert.equal(db.prepare('SELECT batch_id FROM market_publication_events WHERE scope=? AND published_at<=? ORDER BY revision DESC LIMIT 1').get('CN', now).batch_id, 'one');
  assert.throws(() => db.prepare("UPDATE market_publication_events SET manifest_hash='changed'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM market_batch_members').run(), /append-only/);
});

test('E-13/E-31: v4 to v5 preserves exact postings, identities, foreign keys, indexes and append-only guards', (t) => {
  const { directory, path } = temporary(t);
  const clone = join(directory, 'v4-migrations');
  cpSync(migrationDirectory, clone, { recursive: true });
  const current = JSON.parse(readFileSync(join(clone, 'manifest.json'), 'utf8'));
  for (const migration of current.migrations.filter((entry) => entry.version > 4)) rmSync(join(clone, migration.file));
  writeFileSync(join(clone, 'manifest.json'), JSON.stringify({ ...current, migrations: current.migrations.filter((entry) => entry.version <= 4) }));
  assert.equal(migrateWorkbench(path, { directory: clone }).version, 4);
  let db = new Database(path);
  db.pragma('foreign_keys = ON');
  seedScopes(db);
  event(db, 'old-event');
  const insert = db.prepare('INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES (?,?,?,?,?,?)');
  insert.run('original-cash', 'old-event', 'a-a', 'CNY', 'cash_settled', '12345678901234567890.000000000000000001');
  insert.run('original-capital', 'old-event', 'a-a', 'CNY', 'external_capital', '-12345678901234567890.000000000000000001');
  const original = db.prepare('SELECT * FROM postings ORDER BY id').all();
  const originalEvent = db.prepare('SELECT * FROM ledger_events').all();
  assert.throws(() => insert.run('not-supported-yet', 'old-event', 'a-a', 'CNY', 'unclassified_income', '-10'), /CHECK/);
  db.close();
  assert.equal(migrateWorkbench(path).applied, schemaVersion - 4);
  db = new Database(path);
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  assert.deepEqual(db.prepare('SELECT * FROM postings ORDER BY id').all(), original);
  assert.deepEqual(db.prepare('SELECT * FROM ledger_events').all(), originalEvent);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='postings_event'").get());
  const upgradedInsert = db.prepare('INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES (?,?,?,?,?,?)');
  upgradedInsert.run('unclassified', 'old-event', 'a-a', 'CNY', 'unclassified_income', '-10');
  assert.throws(() => upgradedInsert.run('bad-event', 'absent', 'a-a', 'CNY', 'income', '1'), /FOREIGN KEY/);
  assert.throws(() => upgradedInsert.run('cross-scope', 'old-event', 'a-b', 'CNY', 'income', '1'), /portfolio mismatch/);
  assert.throws(() => db.prepare("UPDATE postings SET amount='0' WHERE id='original-cash'").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM postings WHERE id='original-cash'").run(), /append-only/);
});

test('E-31/performance: latest chronology and linked settlement lookups use expression indexes', (t) => {
  const { path } = temporary(t);
  migrateWorkbench(path);
  const db = database(t, path);
  seedScopes(db);
  event(db, 'event-1');
  const latest = db.prepare('EXPLAIN QUERY PLAN SELECT effective_at FROM ledger_events WHERE portfolio_id=? ORDER BY julianday(effective_at) DESC,ledger_revision DESC LIMIT 1').all('p-a').map((row) => row.detail).join('\n');
  assert.match(latest, /USING INDEX ledger_events_latest_effective/);
  assert.doesNotMatch(latest, /TEMP B-TREE|SCAN ledger_events/);
  const children = db.prepare("EXPLAIN QUERY PLAN SELECT payload_json FROM ledger_events WHERE portfolio_id=? AND json_extract(payload_json,'$.fact.related_event_id')=? AND reversal_of IS NULL").all('p-a', 'event-1').map((row) => row.detail).join('\n');
  assert.match(children, /USING INDEX ledger_events_related_outstanding/);
  assert.doesNotMatch(children, /SCAN ledger_events/);
});
