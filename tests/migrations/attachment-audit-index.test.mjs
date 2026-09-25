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
const sha = value => createHash('sha256').update(value).digest('hex');
const indexName = 'audit_attachment_scope_lookup';
const stamp = '2026-09-25T00:00:00.000Z';
const storeQuery = "SELECT payload_json FROM audit_events WHERE action='store_attachment' AND object_type='attachment' AND object_id=? AND portfolio_id=? AND json_extract(payload_json,'$.account_id')=? LIMIT 1";
const readQuery = "SELECT e.payload_json FROM audit_events e JOIN accounts a ON a.id=json_extract(e.payload_json,'$.account_id') AND a.portfolio_id=e.portfolio_id WHERE e.action='store_attachment' AND e.object_type='attachment' AND e.object_id=? AND e.portfolio_id=? AND (? IS NULL OR a.id=?) LIMIT 1";

function copyMigrations(directory, version) {
  const target = join(directory, `v${version}`); mkdirSync(target);
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json')));
  assert.ok(manifest.migrations.length >= version);
  const migrations = manifest.migrations.slice(0, version);
  for (const row of migrations) cpSync(join(migrationDirectory, row.file), join(target, row.file));
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations }));
  return target;
}
function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations' ORDER BY name").all()
    .map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'attachment-audit-index-')), filename = join(directory, 'workbench.db');
  migrateWorkbench(filename, { directory: copyMigrations(directory, 23) });
  const db = new Database(filename); db.pragma('foreign_keys=ON');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const audit = db.prepare('INSERT INTO audit_events(id,actor_id,action,object_type,object_id,portfolio_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (const portfolio of ['portfolio-a', 'portfolio-b']) db.prepare('INSERT INTO portfolios(id,name,created_at) VALUES(?,?,?)').run(portfolio, 'Synthetic index fixture', stamp);
    for (const [id, portfolio] of [['account-a', 'portfolio-a'], ['account-a2', 'portfolio-a'], ['account-b', 'portfolio-b']]) {
      db.prepare("INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,status,created_at) VALUES(?,?,?,'Synthetic','CNY','reconciliation_required',?)").run(id, portfolio, id, stamp);
    }
    for (let i = 0; i < 2048; i++) audit.run(`noise-${i}`, 'owner', 'record_fact', 'ledger_event', `event-${i}`, 'portfolio-a', '{"synthetic":true}', stamp);
    audit.run('wrong-action', 'owner', 'inspect_attachment', 'attachment', 'shared-attachment', 'portfolio-a', '{"account_id":"account-a2"}', stamp);
    audit.run('wrong-type', 'owner', 'store_attachment', 'not_attachment', 'shared-attachment', 'portfolio-a', '{"account_id":"account-a2"}', stamp);
    for (const [id, portfolio, account] of [['stored-a', 'portfolio-a', 'account-a'], ['stored-b', 'portfolio-b', 'account-b']]) {
      audit.run(id, 'owner', 'store_attachment', 'attachment', 'shared-attachment', portfolio, JSON.stringify({ account_id: account, synthetic: true }), stamp);
    }
  }).immediate();
  return { db, directory, filename, audit };
}

test('v24 adds only the attachment audit lookup index and preserves all v1-v23 bytes and audit data', t => {
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json')));
  assert.equal(sha(JSON.stringify(manifest.migrations.slice(0, 23))), 'a0f8ded39f091c49f4f15e3fe2321ca5c9252ab9fbf4570551435f0513bc90ec');
  for (const row of manifest.migrations.slice(0, 23)) assert.equal(sha(readFileSync(join(migrationDirectory, row.file))), row.sha256);
  const { db, directory, filename } = fixture(t), before = tables(db);
  const schema = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  const target = copyMigrations(directory, 24);
  assert.equal(migrateWorkbench(filename, { directory: target }).applied, 1);
  assert.deepEqual(tables(db), before);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=23 ORDER BY version').all(), applied);
  for (const row of schema) assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=?').get(row.name), row);
  const added = db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().filter(row => !schema.some(old => old.name === row.name));
  assert.deepEqual(added, [{ type: 'index', name: indexName }]);
  assert.equal(verifyWorkbenchSchema(db, target).version, 24);
  assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  assert.throws(() => db.prepare("UPDATE audit_events SET actor_id='changed' WHERE id='stored-a'").run(), /audit events are append-only/);
  assert.throws(() => db.prepare("DELETE FROM audit_events WHERE id='stored-a'").run(), /audit events are append-only/);
  assert.deepEqual(tables(db), before);
  db.pragma('wal_checkpoint(TRUNCATE)'); const bytes = sha(readFileSync(filename));
  assert.equal(migrateWorkbench(filename, { directory: target }).applied, 0);
  assert.equal(sha(readFileSync(filename)), bytes);
});

test('the two actual attachment predicates use the partial index without changing scope or JSON account filtering', t => {
  const source = readFileSync(join(root, 'web/src/server/ledger/attachments.ts'), 'utf8');
  assert.ok(source.includes(`prepare("${storeQuery}")`)); assert.ok(source.includes(`prepare("${readQuery}")`));
  const { db, directory, filename, audit } = fixture(t);
  const cases = [
    [storeQuery, ['shared-attachment', 'portfolio-a', 'account-a']],
    [storeQuery, ['shared-attachment', 'portfolio-a', 'account-a2']],
    [storeQuery, ['shared-attachment', 'portfolio-a', 'account-b']],
    [storeQuery, ['shared-attachment', 'portfolio-b', 'account-b']],
    [readQuery, ['shared-attachment', 'portfolio-a', null, null]],
    [readQuery, ['shared-attachment', 'portfolio-a', 'account-a', 'account-a']],
    [readQuery, ['shared-attachment', 'portfolio-a', 'account-a2', 'account-a2']],
    [readQuery, ['shared-attachment', 'portfolio-a', 'account-b', 'account-b']],
    [readQuery, ['shared-attachment', 'portfolio-b', 'account-b', 'account-b']],
    [readQuery, ['missing', 'portfolio-a', null, null]],
  ];
  for (const [name, sql, args] of [['store before v24', storeQuery, cases[0][1]], ['read before v24', readQuery, cases[4][1]]]) {
    t.diagnostic(`${name}: ${db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail).join('; ')}`);
  }
  const before = cases.map(([sql, args]) => db.prepare(sql).get(...args));
  assert.ok(before[0]); assert.equal(before[1], undefined); assert.equal(before[2], undefined); assert.ok(before[3]);
  assert.ok(before[4]); assert.ok(before[5]); assert.equal(before[6], undefined); assert.equal(before[7], undefined); assert.ok(before[8]); assert.equal(before[9], undefined);
  migrateWorkbench(filename, { directory: copyMigrations(directory, 24) });
  assert.deepEqual(cases.map(([sql, args]) => db.prepare(sql).get(...args)), before);
  assert.deepEqual(db.pragma(`index_info(${indexName})`).map(row => row.name), ['object_id', 'portfolio_id']);
  assert.equal(db.pragma('index_list(audit_events)').find(row => row.name === indexName).partial, 1);
  const reported = new Set();
  for (const [sql, args] of cases) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail).join('\n');
    assert.match(plan, new RegExp(`SEARCH (?:audit_events|e) USING INDEX ${indexName} \\(object_id=\\? AND portfolio_id=\\?\\)`));
    if (!reported.has(sql)) { t.diagnostic(`after v24: ${plan.replaceAll('\n', '; ')}`); reported.add(sql); }
  }
  const indexedCount = () => db.prepare(`SELECT COUNT(*) n FROM audit_events INDEXED BY ${indexName} WHERE action='store_attachment' AND object_type='attachment'`).get().n;
  assert.equal(indexedCount(), 2);
  audit.run('stored-new', 'owner', 'store_attachment', 'attachment', 'new-attachment', 'portfolio-a', '{"account_id":"account-a2","synthetic":true}', stamp);
  assert.equal(indexedCount(), 3);
  assert.equal(JSON.parse(db.prepare(readQuery).get('new-attachment', 'portfolio-a', 'account-a2', 'account-a2').payload_json).account_id, 'account-a2');
});
