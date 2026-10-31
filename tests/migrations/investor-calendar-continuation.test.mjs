import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), at = '2026-01-03T12:00:03.000Z';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-continuation-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const copy = (name, count) => {
    const target = join(directory, name); mkdirSync(target);
    for (const entry of manifest.migrations.slice(0, count)) cpSync(join(migrationDirectory, entry.file), join(target, entry.file));
    writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, count) })); return target;
  };
  const prefix = copy('v50', 50), target = copy('v51', 51), filename = join(directory, 'workbench.db');
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

test('migration 51 preserves every v50 row, rowid, object and decimal fact and approves no calendars', t => {
  const f = fixture(t), rows = f.rows(), objects = f.objects(), applied = f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  assert.equal(migrateWorkbench(f.filename, { directory: f.target }).applied, 1);
  assert.equal(verifyWorkbenchSchema(f.db, f.target).version, 51); assert.deepEqual(f.rows(), rows);
  for (const object of objects) assert.deepEqual(f.objects().find(row => row.name === object.name && row.type === object.type), object);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=50 ORDER BY version').all(), applied);
  assert.equal(f.db.prepare('SELECT count(*) n FROM investor_calendar_continuations').get().n, 0);
  assert.equal(migrateWorkbench(f.filename, { directory: f.target }).applied, 0); assert.deepEqual(f.rows(), rows);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []); assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
});

test('late migration 51 failure atomically preserves the old schema, version and rows', t => {
  const f = fixture(t), rows = f.rows(), objects = f.objects(), applied = f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  const changed = JSON.parse(readFileSync(join(f.target, 'manifest.json'))), entry = changed.migrations.at(-1);
  const sql = readFileSync(join(f.target, entry.file), 'utf8') + '\nSELECT * FROM fictional_missing_calendar_failure;\n';
  writeFileSync(join(f.target, entry.file), sql); entry.sha256 = createHash('sha256').update(sql).digest('hex');
  writeFileSync(join(f.target, 'manifest.json'), JSON.stringify(changed));
  assert.throws(() => migrateWorkbench(f.filename, { directory: f.target }), /fictional_missing_calendar_failure/);
  assert.deepEqual(f.rows(), rows); assert.deepEqual(f.objects(), objects);
  assert.equal(f.db.pragma('user_version', { simple: true }), 50);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), applied);
});

test('calendar continuation storage rejects orphan or unapproved relationships', t => {
  const f = fixture(t); migrateWorkbench(f.filename, { directory: f.target });
  assert.throws(() => f.db.prepare('INSERT INTO investor_calendar_continuations VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('edge','w','missing','previous','next','{}','a'.repeat(64),'fictional',at,'missing'), /binding differs|CHECK|FOREIGN KEY/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM investor_calendar_continuations').get().n, 0);
});
