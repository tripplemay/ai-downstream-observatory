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
  const directory = mkdtempSync(join(tmpdir(), 'action-maintenance-upgrade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json')));
  const oldRoot = join(directory, 'v52'), prefix = join(oldRoot, 'migrations'), target = join(directory, 'v53');
  mkdirSync(prefix, { recursive: true }); mkdirSync(target);
  for (const entry of manifest.migrations.slice(0, 52)) cpSync(join(migrationDirectory, entry.file), join(prefix, entry.file));
  for (const entry of manifest.migrations.slice(0, 53)) cpSync(join(migrationDirectory, entry.file), join(target, entry.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 52) }));
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 53) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? 'python3', ['-c', `
from pathlib import Path
import socket,sys,unittest
import worker.orchestration.db as backend
from tests.investor.test_managed_actions import ManagedActionTests
from tests.investor.action_reconciliation_fixture import REGISTER
from worker.orchestration.jobs import enqueue_job
def forbidden(*a,**k):raise AssertionError('OFFLINE_FIXTURE_NETWORK_FORBIDDEN')
socket.create_connection=forbidden;socket.getaddrinfo=forbidden
original=backend.ROOT;backend.ROOT=Path(sys.argv[2])
db=backend.open_database(sys.argv[1]);backend.ROOT=original
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,?)",(REGISTER,))
case=unittest.TestCase();case.db=db;ManagedActionTests.prepare(case)
enqueue_job(db,'fictional-unrelated','w','fictional','v1',now=REGISTER)
db.close()
`, filename, oldRoot], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH } });
  assert.equal(child.status, 0, child.stderr);
  const db = new Database(filename); db.pragma('foreign_keys=ON'); t.after(() => db.close());
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const rows = () => names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  const objects = () => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  return { db, filename, target, rows, objects };
}

test('migration 53 preserves populated schema 52, original human reviews and rowids; maintenance defaults empty', t => {
  const f = fixture(t), before = f.rows(), objects = f.objects(), applied = f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  assert.equal(migrateWorkbench(f.filename, { directory: f.target }).applied, 1);
  assert.equal(verifyWorkbenchSchema(f.db, f.target).version, 53); assert.deepEqual(f.rows(), before);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=52 ORDER BY version').all(), applied);
  const after = f.objects();
  for (const object of objects) assert.deepEqual(after.find(row => row.type === object.type && row.name === object.name), object);
  for (const name of ['authorities', 'controls', 'requests', 'publications'])
    assert.equal(f.db.prepare(`SELECT count(*) n FROM investor_action_${name}`).get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM investor_action_unavailable_headers').get().n, 0);
  const columns = f.db.pragma('table_info(investor_data_reviews)').map(row => row.name).join(',');
  assert.deepEqual(f.db.prepare(`SELECT ${columns} FROM investor_review_headers ORDER BY id`).all(),
    f.db.prepare(`SELECT ${columns} FROM investor_data_reviews ORDER BY id`).all());
  assert.equal(migrateWorkbench(f.filename, { directory: f.target }).applied, 0);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []); assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
});

test('late migration 53 failure restores all original rows, objects and migration checksums', t => {
  const f = fixture(t), before = f.rows(), objects = f.objects(), applied = f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  const path = join(f.target, 'manifest.json'), manifest = JSON.parse(readFileSync(path)), entry = manifest.migrations.at(-1);
  const sql = readFileSync(join(f.target, entry.file), 'utf8') + '\nSELECT * FROM fictional_action_maintenance_failure;\n';
  writeFileSync(join(f.target, entry.file), sql); entry.sha256 = createHash('sha256').update(sql).digest('hex');
  writeFileSync(path, JSON.stringify(manifest));
  assert.throws(() => migrateWorkbench(f.filename, { directory: f.target }), /fictional_action_maintenance_failure/);
  assert.deepEqual(f.rows(), before); assert.deepEqual(f.objects(), objects);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), applied);
  assert.equal(f.db.pragma('user_version', { simple: true }), 52); assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});
