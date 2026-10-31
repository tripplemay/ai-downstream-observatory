import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const Database = createRequire(new URL('../../web/package.json', import.meta.url))('better-sqlite3');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'issuer-schedule-upgrade-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json')));
  const oldRoot = join(directory, 'v49'), prefix = join(oldRoot, 'migrations'), current = join(directory, 'v50');
  mkdirSync(prefix, { recursive: true }); mkdirSync(current);
  for (const entry of manifest.migrations.slice(0, 50)) cpSync(join(migrationDirectory, entry.file), join(current, entry.file));
  for (const entry of manifest.migrations.slice(0, 49)) cpSync(join(migrationDirectory, entry.file), join(prefix, entry.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 49) }));
  writeFileSync(join(current, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 50) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? 'python3', ['-c', `
from pathlib import Path
import socket,sys
import worker.orchestration.db as backend
from worker.investor import issuer_sources as s
from tests.investor.test_issuer_sources import policy,Collector,NOW,LATER
def forbidden(*a,**k):raise AssertionError('OFFLINE_FIXTURE_NETWORK_FORBIDDEN')
socket.create_connection=forbidden; socket.getaddrinfo=forbidden
original=backend.ROOT; backend.ROOT=Path(sys.argv[2])
db=backend.open_database(sys.argv[1]); backend.ROOT=original
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,?)",(NOW,))
g=s.register_authority(db,'w','synthetic-investor',policy(),now=NOW)
s.set_authority_enabled(db,'w','synthetic-investor',g['id'],True,now=NOW)
for at,key in ((NOW,'a'*32),(LATER,'b'*32)):
 assert s.collect_issuer_draft(db,'w','synthetic-investor',g['id'],key,'2025-01-01','2026-01-02',now=at,test_collector=Collector(at))['status']=='captured'
db.close()
`, filename, oldRoot], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH } });
  assert.equal(child.status, 0, child.stderr);
  const db = new Database(filename); db.pragma('foreign_keys=ON'); t.after(() => db.close());
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  return { db, filename, current, snapshot, before: snapshot(), migrations: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all() };
}
test('migration 50 preserves populated legacy issuer dedup bytes, every old row/rowid and checksums without scheduling anything', t => {
  const f = fixture(t);
  assert.equal(migrateWorkbench(f.filename, { directory: f.current }).applied, 1);
  assert.equal(verifyWorkbenchSchema(f.db, f.current).version, 50); assert.deepEqual(f.snapshot(), f.before);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=49 ORDER BY version').all(), f.migrations);
  assert.equal(f.db.prepare('SELECT count(*) n FROM investor_issuer_captures').get().n, 2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM investor_issuer_payloads').get().n, 1);
  for (const name of ['schedules','schedule_controls','schedule_requests','schedule_results']) assert.equal(f.db.prepare(`SELECT count(*) n FROM investor_issuer_${name}`).get().n, 0);
  assert.equal(migrateWorkbench(f.filename, { directory: f.current }).applied, 0);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []); assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
});
test('late migration 50 failure restores the original populated v49 schema and history atomically', t => {
  const f = fixture(t), schema = f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all();
  const manifestPath = join(f.current, 'manifest.json'), manifest = JSON.parse(readFileSync(manifestPath)), entry = manifest.migrations.at(-1);
  const sql = readFileSync(join(f.current, entry.file), 'utf8') + "\nCREATE TABLE fictional_issuer_bad_fk(id TEXT REFERENCES investor_workspaces(id));INSERT INTO fictional_issuer_bad_fk VALUES('missing');\n";
  writeFileSync(join(f.current, entry.file), sql); entry.sha256 = createHash('sha256').update(sql).digest('hex'); writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => migrateWorkbench(f.filename, { directory: f.current }), /FOREIGN KEY/);
  assert.deepEqual(f.snapshot(), f.before); assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(), schema);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), f.migrations);
  assert.equal(f.db.pragma('user_version', { simple: true }), 49); assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});
