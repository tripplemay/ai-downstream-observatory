import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json')));
const tables = ['authorities','controls','requests','captures','payloads','purges','publications'].map(name => `investor_fx_${name}`);
const at = '2026-01-03T12:00:03.000Z';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'managed-fx-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const copy = (name, count) => {
    const target = join(directory, name); mkdirSync(target);
    for (const entry of manifest.migrations.slice(0, count)) cpSync(join(migrationDirectory, entry.file), join(target, entry.file));
    writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, count) }));
    return target;
  };
  const prefix = copy('v47', 47), target = copy('v48', 48), filename = join(directory, 'workbench.db');
  migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); db.pragma('foreign_keys=ON'); t.after(() => db.close());
  db.exec(`INSERT INTO portfolios(rowid,id,name,created_at) VALUES(71,'fictional-book','Fictional','${at}');
    INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES('fictional-account','fictional-book','Fictional','Fictional','CNY','${at}');
    INSERT INTO ledger_heads VALUES('fictional-book',1,'${at}');
    INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,recorded_at,source_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id)
      VALUES('fictional-event','fictional-book','fictional-account','deposit','${at}','${at}','fixture','fixture','${'a'.repeat(64)}','{}',1,'fictional');
    INSERT INTO postings VALUES('fictional-cash','fictional-event','fictional-account','CNY','cash_settled','0.100000000000000001');
    INSERT INTO postings VALUES('fictional-capital','fictional-event','fictional-account','CNY','external_capital','-0.100000000000000001');
    INSERT INTO investor_workspaces VALUES('w','fictional',9,'${at}');
    INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('fictional-audit','fictional','fixture','fixture','fixture','{}','${at}');
    INSERT INTO investor_profiles(rowid,id,workspace_id,version,document_json,content_hash,actor_id,created_at,audit_id)
      VALUES(37,'fictional-profile','w',1,'{}','${'b'.repeat(64)}','fictional','${at}','fictional-audit');`);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const rows = () => names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  const objects = () => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  return { filename, db, target, rows, objects };
}

test('migration 48 preserves all v47 data, rowids, objects and decimal facts while adding only empty FX storage', t => {
  const f = fixture(t), before = f.rows(), objects = f.objects(), applied = f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  assert.equal(migrateWorkbench(f.filename, { directory: f.target }).applied, 1);
  assert.equal(verifyWorkbenchSchema(f.db, f.target).version, 48); assert.deepEqual(f.rows(), before);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=47 ORDER BY version').all(), applied);
  const after = f.objects();
  for (const object of objects) assert.deepEqual(after.find(row => row.name === object.name && row.type === object.type), object);
  for (const name of tables) assert.equal(f.db.prepare(`SELECT count(*) n FROM ${name}`).get().n, 0);
  assert.equal(migrateWorkbench(f.filename, { directory: f.target }).applied, 0); assert.deepEqual(f.rows(), before);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []); assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
});

test('late migration 48 failure atomically restores old schema, version and every row', t => {
  const f = fixture(t), before = f.rows(), objects = f.objects(), applied = f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  const changed = JSON.parse(readFileSync(join(f.target, 'manifest.json'))), entry = changed.migrations.at(-1);
  const sql = readFileSync(join(f.target, entry.file), 'utf8') + '\nSELECT * FROM fictional_missing_failure_table;\n';
  writeFileSync(join(f.target, entry.file), sql); entry.sha256 = createHash('sha256').update(sql).digest('hex');
  writeFileSync(join(f.target, 'manifest.json'), JSON.stringify(changed));
  assert.throws(() => migrateWorkbench(f.filename, { directory: f.target }), /fictional_missing_failure_table/);
  assert.deepEqual(f.rows(), before); assert.deepEqual(f.objects(), objects);
  assert.equal(f.db.pragma('user_version', { simple: true }), 47);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), applied);
});

test('FX schema rejects orphan bytes, missing audit and unbound purge records', t => {
  const f = fixture(t); migrateWorkbench(f.filename, { directory: f.target });
  assert.throws(() => f.db.prepare('INSERT INTO investor_fx_payloads VALUES(?,?,?,?,?)').run('w','a'.repeat(64),2,Buffer.from('{}'),at), /requires capture/);
  assert.throws(() => f.db.prepare('INSERT INTO investor_fx_authorities VALUES(?,?,?,?,?,?,?)').run('a','w','{}','b'.repeat(64),'fictional',at,'missing'), /audit differs|CHECK/);
  assert.throws(() => f.db.prepare('INSERT INTO investor_fx_purges VALUES(?,?,?,?,?,?)').run('missing','w','retention_expired','fictional',at,'missing'), /audit differs|FOREIGN KEY/);
  for (const name of tables) assert.equal(f.db.prepare(`SELECT count(*) n FROM ${name}`).get().n, 0);
});
