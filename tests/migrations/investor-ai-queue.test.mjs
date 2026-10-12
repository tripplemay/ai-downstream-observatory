import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('migration 39 preserves populated AI requests, latches, outcomes, payload and purge from version 38', t => {
  const directory = mkdtempSync(join(tmpdir(), 'investor-ai-queue-upgrade-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), prefix = join(directory, 'prefix'); mkdirSync(prefix);
  for (const migration of manifest.migrations.slice(0, 38)) cpSync(join(migrationDirectory, migration.file), join(prefix, migration.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 38) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); t.after(() => db.close()); db.pragma('foreign_keys = ON');
  const now = '2026-01-03T12:00:00.000Z', until = '2026-01-04T12:00:00.000Z', deadline = '2026-01-03T12:00:45.000Z';
  const event = (id, action, object, payload) => db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, 'fictional-owner', action, 'investor_ai_request', object, null, null, JSON.stringify(payload), now);
  db.prepare('INSERT INTO investor_workspaces VALUES(?,?,?,?)').run('w', 'fictional-owner', 0, now);
  event('profile-audit', 'fixture_profile', 'profile', {});
  db.prepare('INSERT INTO investor_profiles VALUES(?,?,?,?,?,?,?,?)').run('profile', 'w', 1, '{}', hash({}), 'fictional-owner', now, 'profile-audit');
  db.prepare('INSERT INTO investor_observations VALUES(?,?,?,?,?,?,?,?,?)')
    .run('observation', 'w', 'profile', null, 'insufficient_evidence', '{"outcome":"insufficient_evidence"}', hash({ fixture: true }), hash('fixture'), now);
  // SQL component fixtures deliberately do not claim a qualified monitor or valid model review.
  for (const id of ['retained', 'purged', 'pending']) {
    const request = { schema_version: 'investor-ai-request-v1', id, workspace_id: 'w', actor_id: 'fictional-owner', observation_id: 'observation',
      binding_hash: hash(id), source_binding_hash: hash('fixture'), context_hash: hash('context'), config_hash: hash('config'), consent_hash: hash('consent'),
      implementation_hash: hash('implementation'), created_at: now, valid_until: until };
    event(id + '-request', 'investor_ai_request', id, { content_hash: hash(request) });
    db.prepare('INSERT INTO investor_ai_requests VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, 'w', 'observation', 'fictional-owner', request.binding_hash,
      JSON.stringify(request), hash(request), now, until, id + '-request');
    if (id === 'pending') continue;
    const token = hash(id).slice(0, 48);
    event(id + '-dispatch', 'investor_ai_dispatch', id, { token, deadline });
    db.prepare('INSERT INTO investor_ai_dispatches VALUES(?,?,?,?,?)').run(id, token, now, deadline, id + '-dispatch');
    const outcome = { token, status: 'complete', reason_code: null, review_hash: hash({ fictional: id }) };
    event(id + '-outcome', 'investor_ai_outcome', id, outcome);
    db.prepare('INSERT INTO investor_ai_outcomes VALUES(?,?,?,?,?,?,?)').run(id, token, 'complete', null, outcome.review_hash, now, id + '-outcome');
    db.prepare('INSERT INTO investor_ai_payloads VALUES(?,?)').run(id, Buffer.from(JSON.stringify({ fictional: id })));
    if (id === 'purged') {
      event(id + '-purge', 'investor_ai_purge', id, { reason: 'binding_changed' });
      db.prepare('INSERT INTO investor_ai_purges VALUES(?,?,?,?,?)').run(id, 'fictional-owner', 'binding_changed', now, id + '-purge');
      db.prepare('DELETE FROM investor_ai_payloads WHERE request_id=?').run(id);
    }
  }
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  const before = snapshot(), applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  migrateWorkbench(filename); assert.equal(verifyWorkbenchSchema(db).version, manifest.migrations.length);
  assert.deepEqual(snapshot(), before); assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=38 ORDER BY version').all(), applied);
  assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  migrateWorkbench(filename); assert.deepEqual(snapshot(), before);
});
