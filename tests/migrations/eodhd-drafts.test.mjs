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
  const directory = mkdtempSync(join(tmpdir(), 'eodhd-upgrade-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json')));
  const oldRoot = join(directory, 'v51'), prefix = join(oldRoot, 'migrations'), current = join(directory, 'v52');
  mkdirSync(prefix, { recursive: true }); mkdirSync(current);
  for (const entry of manifest.migrations.slice(0, 52)) cpSync(join(migrationDirectory, entry.file), join(current, entry.file));
  for (const entry of manifest.migrations.slice(0, 51)) cpSync(join(migrationDirectory, entry.file), join(prefix, entry.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 51) }));
  writeFileSync(join(current, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 52) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? 'python3', ['-c', `
from pathlib import Path
import socket,sys
import worker.orchestration.db as backend
from worker.investor import issuer_sources as s
from worker.orchestration.jobs import enqueue_job
from tests.investor.test_issuer_sources import policy,Collector,NOW,LATER
def forbidden(*a,**k):raise AssertionError('OFFLINE_FIXTURE_NETWORK_FORBIDDEN')
socket.create_connection=forbidden;socket.getaddrinfo=forbidden
original=backend.ROOT;backend.ROOT=Path(sys.argv[2])
db=backend.open_database(sys.argv[1]);backend.ROOT=original
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,?)",(NOW,))
g=s.register_authority(db,'w','synthetic-investor',policy(),now=NOW)
s.set_authority_enabled(db,'w','synthetic-investor',g['id'],True,now=NOW)
for at,key in ((NOW,'a'*32),(LATER,'b'*32)):
 assert s.collect_issuer_draft(db,'w','synthetic-investor',g['id'],key,'2025-01-01','2026-01-02',now=at,test_collector=Collector(at))['status']=='captured'
enqueue_job(db,'fictional-unrelated','w','fictional','v1',now=NOW)
db.close()
`, filename, oldRoot], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH } });
  assert.equal(child.status, 0, child.stderr);
  const db = new Database(filename); db.pragma('foreign_keys=ON'); t.after(() => db.close());
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  return { db, filename, current, snapshot, before: snapshot(), migrations: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all() };
}

test('migration 52 preserves populated schema 51 rows, rowids, jobs and shared source bytes; six new tables remain empty', t => {
  const f = fixture(t);
  assert.equal(migrateWorkbench(f.filename, { directory: f.current }).applied, 1);
  assert.equal(verifyWorkbenchSchema(f.db, f.current).version, 52); assert.deepEqual(f.snapshot(), f.before);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=51 ORDER BY version').all(), f.migrations);
  for (const name of ['authorities', 'controls', 'requests', 'captures', 'payloads', 'purges'])
    assert.equal(f.db.prepare(`SELECT count(*) n FROM investor_eodhd_${name}`).get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM investor_issuer_payloads').get().n, 1);
  assert.match(f.db.prepare('EXPLAIN QUERY PLAN SELECT count(*) FROM investor_eodhd_requests WHERE source_day=?').get('2026-11-01').detail,
    /COVERING INDEX investor_eodhd_request_day/);
  const job = f.db.prepare("SELECT id FROM job_runs WHERE job_type='fictional-unrelated'").get();
  f.db.prepare("UPDATE job_runs SET max_attempts=4 WHERE id=?").run(job.id);
  f.db.prepare('DELETE FROM job_runs WHERE id=?').run(job.id);
  assert.equal(migrateWorkbench(f.filename, { directory: f.current }).applied, 0);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []); assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
});

test('late migration 52 failure atomically restores schema 51 metadata, every old row and migration checksums', t => {
  const f = fixture(t), schema = f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all();
  const manifestPath = join(f.current, 'manifest.json'), manifest = JSON.parse(readFileSync(manifestPath)), entry = manifest.migrations.at(-1);
  const sql = readFileSync(join(f.current, entry.file), 'utf8') + "\nCREATE TABLE fictional_eodhd_bad_fk(id TEXT REFERENCES investor_workspaces(id));INSERT INTO fictional_eodhd_bad_fk VALUES('missing');\n";
  writeFileSync(join(f.current, entry.file), sql); entry.sha256 = createHash('sha256').update(sql).digest('hex'); writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => migrateWorkbench(f.filename, { directory: f.current }), /FOREIGN KEY/);
  assert.deepEqual(f.snapshot(), f.before); assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(), schema);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), f.migrations);
  assert.equal(f.db.pragma('user_version', { simple: true }), 51); assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});
