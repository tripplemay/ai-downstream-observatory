import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrateWorkbench, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
test('migration66 rolls back late failure, then preserves a real v65 epoch and every old row/checksum without manufacturing activation or continuation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-epoch-continuation-upgrade-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = new URL('../../migrations/', import.meta.url), manifest = JSON.parse(readFileSync(new URL('manifest.json', source)));
  function copy(name, count) {
    const target = join(directory, name); mkdirSync(target);
    for (const entry of manifest.migrations.slice(0, count)) cpSync(new URL(entry.file, source), join(target, entry.file));
    writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, count) })); return target;
  }
  const prefix = copy('v65', 65), target = copy('v66', 66), filename = join(directory, 'workbench.db');
  migrateWorkbench(filename, { directory: prefix });
  const seeded = spawnSync(process.env.WORKBENCH_TEST_PYTHON || 'python3', ['-c', `
import sqlite3,sys,json
from pathlib import Path
from unittest.mock import patch
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.epoch_registration_fixture import create
from worker.orchestration.db import ROOT
def original_readonly(path,*,read_only=False):
 assert read_only is True
 reader=sqlite3.connect(Path(path).as_uri()+'?mode=ro',uri=True,isolation_level=None);reader.row_factory=sqlite3.Row
 reader.execute('PRAGMA foreign_keys=ON');reader.execute('PRAGMA query_only=ON')
 expected=json.loads((ROOT/'migrations/manifest.json').read_text())['migrations'][:65]
 assert reader.execute('PRAGMA user_version').fetchone()[0]==65
 assert [tuple(r) for r in reader.execute('SELECT version,checksum FROM schema_migrations ORDER BY version')]==[(r['version'],r['sha256']) for r in expected]
 return reader
db=sqlite3.connect(sys.argv[1],isolation_level=None);db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON')
try:
 with offline_protocol_fixture(),patch('tests.investor.test_legacy_protocol_matrix.open_database',side_effect=original_readonly):create(db,Path(sys.argv[1]))
 assert db.execute('SELECT COUNT(*) FROM investor_model_epochs').fetchone()[0]==1
 assert db.execute('SELECT COUNT(*) FROM investor_evidence_model_checkpoints').fetchone()[0]==3
finally:db.close()
`, filename], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 120000, maxBuffer: 1048576 });
  assert.ok(!seeded.error, seeded.error?.code); assert.equal(seeded.status, 0, seeded.stderr);
  const db = new Database(filename); t.after(() => db.close()); db.pragma('foreign_keys=ON');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => tables.map(table => ({ table, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${table} ORDER BY rowid`).all() }));
  const before = snapshot(), schema = db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all();
  const original = readFileSync(join(target, manifest.migrations[65].file), 'utf8'), entry = { ...manifest.migrations[65] };
  const invalid = original + "\nINSERT INTO investor_epoch_controls(id) VALUES('fictional-late-invalid');\n";
  writeFileSync(join(target, entry.file), invalid); entry.sha256 = createHash('sha256').update(invalid).digest('hex');
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations: [...manifest.migrations.slice(0, 65), entry] }));
  assert.throws(() => migrateWorkbench(filename, { directory: target }), /NOT NULL|binding differs/);
  assert.deepEqual(snapshot(), before); assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(), schema);
  assert.equal(db.pragma('user_version', { simple: true }), 65);
  writeFileSync(join(target, entry.file), original); writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 66) }));
  assert.equal(migrateWorkbench(filename, { directory: target }).applied, 1);
  assert.equal(verifyWorkbenchSchema(db, target).version, 66);
  assert.deepEqual(snapshot().filter(row => row.table !== 'schema_migrations'), before.filter(row => row.table !== 'schema_migrations'));
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=65 ORDER BY version').all(), before.find(row => row.table === 'schema_migrations').rows.map(({ _preserved_rowid, ...row }) => row));
  for (const table of ['investor_epoch_controls', 'investor_epoch_continuation_requests', 'investor_epoch_continuations'])
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ' + table).get().n, 0);
  const input = db.prepare("SELECT * FROM investor_monitor_evidence_inputs WHERE json_extract(document_json,'$.schema_version')='investor-monitor-data-input-v6'").get();
  const current = snapshot();
  for (const version of ['investor-monitor-data-input-v6', 'investor-monitor-data-input-v4']) {
    const document = JSON.parse(input.document_json), at = '2026-10-20T10:00:03.001Z';
    document.schema_version = version; document.created_at = at;
    for (const segment of document.segments) segment.snapshot.created_at = at;
    if (version.endsWith('v4')) {
      document.projection_hash = document.audited_projection_hash; document.valid_until = document.audited_valid_until;
      for (const key of ['epoch', 'audited_projection_hash', 'audited_valid_until', 'carry_hash', 'carry_count', 'funding_binding', 'funding_context_hash']) delete document[key];
    }
    const raw = JSON.stringify(document), hash = createHash('sha256').update(raw).digest('hex');
    const attempt = db.transaction(() => {
      db.prepare(`INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at)
        VALUES('fictional-unregistered-epoch-audit',?,'investor_admit_monitor_source','investor_monitor_evidence_input','fictional-unregistered-epoch-input',?,?)`)
        .run(input.actor_id, JSON.stringify({ content_hash: hash }), at);
      db.prepare(`INSERT INTO investor_monitor_evidence_inputs VALUES('fictional-unregistered-epoch-input',?,?,'owner_reviewed_reconstructed',?,?,?,?,?,'fictional-unregistered-epoch-audit')`)
        .run(input.workspace_id, input.model_id, raw, hash, input.actor_id, at, document.valid_until);
    });
    assert.throws(attempt, /registered epoch requires its own continuation protocol/);
    assert.deepEqual(snapshot(), current);
  }
  assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(migrateWorkbench(filename, { directory: target }).applied, 0);
});
