import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'web/package.json'));
const Database = require('better-sqlite3'), Ajv = require('ajv/dist/2020'), addFormats = require('ajv-formats');
const sha = value => createHash('sha256').update(value).digest('hex');
const T = '2026-01-01T08:00:00.000000Z', ENABLE = '2026-01-01T09:00:00.000000Z';
const DUE = '2026-01-01T10:00:00.000000Z', DEADLINE = '2026-01-01T10:01:00.000000Z';
const insert = (db, table, row, prefix = 'INSERT') => db.prepare(`${prefix} INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?')})`).run(...Object.values(row));
const definition = patch => ({ schema_version: 'collection-schedule-v1', provider: 'ecb', feed: 'daily', currencies: ['USD'],
  frequency: 'daily', timezone: 'UTC', start_date: '2026-01-01', end_date: null, trigger: { hour: 10, minute: 0 },
  deadline_seconds: 60, max_attempts: 3, publish: true, missed_policy: 'record_no_backfill', ...patch });
const scope = currencies => 'provider:ecb:fx:daily:' + [...currencies].sort().join('-');

function copyMigrations(directory, version) {
  const target = join(directory, `migrations-${version}`); mkdirSync(target);
  const original = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), migrations = original.migrations.slice(0, version);
  assert.equal(migrations.length, version);
  for (const row of migrations) cpSync(join(migrationDirectory, row.file), join(target, row.file));
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...original, migrations }));
  return target;
}
function fixture(t, version = 18) {
  const directory = mkdtempSync(join(tmpdir(), 'collection-schedules-migration-')), path = join(directory, 'workbench.db');
  const migrations = copyMigrations(directory, version); migrateWorkbench(path, { directory: migrations });
  const db = new Database(path); db.pragma('foreign_keys=ON'); db.pragma('recursive_triggers=OFF');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const id of ['p', 'other']) insert(db, 'portfolios', { id, name: 'Synthetic scheduling fixture', created_at: T });
  return { db, directory, path, migrations };
}
function snapshot(db, names) {
  names ??= db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  return names.map(name => {
    const columns = db.pragma(`table_info(${name})`).map(row => row.name);
    const bytes = columns.map((column, n) => `typeof("${column}") AS t${n},hex(CAST("${column}" AS BLOB)) AS b${n}`).join(',');
    return { name, columns, rows: db.prepare(`SELECT ${bytes} FROM "${name}" ORDER BY rowid`).all() };
  });
}
function saveMaterial(db, { id = 'schedule', portfolio = 'p', at = T, document = definition(), raw = JSON.stringify(document, null, 2) + '\n' } = {}) {
  const old = db.prepare('SELECT * FROM collection_schedule_heads WHERE schedule_id=?').get(id);
  const oldVersion = old ? db.prepare('SELECT * FROM collection_schedule_versions WHERE id=?').get(old.current_version_id) : null;
  const revision = (old?.revision ?? 0) + 1, version = (oldVersion?.version ?? 0) + 1, versionId = `${id}:version:${version}`, auditId = `${id}:audit:${revision}`;
  const identity = { id, portfolio_id: portfolio, provider: 'ecb', scope_key: scope(document.currencies), created_by: 'synthetic-human', created_at: at };
  const row = { id: versionId, schedule_id: id, version, definition_json: raw, content_hash: sha(raw), created_by: identity.created_by, created_at: at, audit_id: auditId };
  const input = { portfolio_id: portfolio, expected_schedule_id: old ? id : null, expected_schedule_revision: revision - 1,
    definition_json: raw, idempotency_key: `${id}:save:${revision}`, reason: 'Synthetic explicit collection authorization', acknowledgement: true };
  const result = { schedule_id: id, version_id: versionId, version, schedule_revision: revision, status: 'paused', scope_key: identity.scope_key, content_hash: row.content_hash };
  const auditPayload = { actor_kind: 'human', input, result };
  const audit = { id: auditId, portfolio_id: portfolio, actor_id: identity.created_by, action: 'save_collection_schedule', object_type: 'collection_schedule', object_id: id,
    payload_json: JSON.stringify(auditPayload), created_at: at };
  const control = { schedule_id: id, revision, version_id: versionId, status: 'paused', audit_id: auditId, created_at: at };
  const head = { schedule_id: id, scope_key: identity.scope_key, current_version_id: versionId, revision, status: 'paused', last_audit_id: auditId, updated_at: at };
  return { identity: old ? null : identity, row, auditPayload, audit, control, head, old };
}
function storeSave(db, value) {
  db.transaction(() => {
    if (value.identity) insert(db, 'collection_schedules', value.identity);
    insert(db, 'audit_events', { ...value.audit, payload_json: JSON.stringify(value.auditPayload) });
    insert(db, 'collection_schedule_versions', value.row); insert(db, 'collection_schedule_controls', value.control);
    if (value.old) updateHead(db, value.head); else insert(db, 'collection_schedule_heads', value.head);
  }).immediate();
}
function updateHead(db, head, prefix = 'UPDATE') {
  db.prepare(`${prefix} collection_schedule_heads SET scope_key=@scope_key,current_version_id=@current_version_id,
    revision=@revision,status=@status,last_audit_id=@last_audit_id,updated_at=@updated_at WHERE schedule_id=@schedule_id`).run(head);
}
function statusMaterial(db, status = 'enabled', at = ENABLE, id = 'schedule') {
  const old = db.prepare('SELECT * FROM collection_schedule_heads WHERE schedule_id=?').get(id);
  const row = db.prepare('SELECT * FROM collection_schedule_versions WHERE id=?').get(old.current_version_id);
  const identity = db.prepare('SELECT * FROM collection_schedules WHERE id=?').get(id);
  const revision = old.revision + 1, auditId = `${id}:audit:${revision}`;
  const input = { portfolio_id: identity.portfolio_id, schedule_id: id, expected_schedule_revision: old.revision,
    status, idempotency_key: `${id}:status:${revision}`, reason: 'Synthetic status control', acknowledgement: true };
  const result = { schedule_id: id, version_id: row.id, version: row.version, schedule_revision: revision, status, scope_key: identity.scope_key, content_hash: row.content_hash };
  const auditPayload = { actor_kind: 'human', input, result };
  const audit = { id: auditId, portfolio_id: identity.portfolio_id, actor_id: 'synthetic-human', action: 'set_collection_schedule_status', object_type: 'collection_schedule',
    object_id: id, created_at: at, payload_json: JSON.stringify(auditPayload) };
  const control = { schedule_id: id, revision, version_id: row.id, status, audit_id: auditId, created_at: at };
  const head = { ...old, revision, status, last_audit_id: auditId, updated_at: at };
  return { auditPayload, audit, control, head };
}
function storeStatus(db, value, prefix = 'UPDATE') {
  db.transaction(() => { insert(db, 'audit_events', { ...value.audit, payload_json: JSON.stringify(value.auditPayload) });
    insert(db, 'collection_schedule_controls', value.control); updateHead(db, value.head, prefix); }).immediate();
}
function enabled(db, options) {
  const saved = saveMaterial(db, options); storeSave(db, saved);
  const status = statusMaterial(db, 'enabled', ENABLE, saved.head.schedule_id); storeStatus(db, status);
  return { saved, status };
}
function slotMaterial(db, { id = 'slot', scheduleId = 'schedule', period = '2026-01-01', at = '2026-01-01T10:00:00.000001Z', disposition = 'requested', reason = null } = {}) {
  const head = db.prepare('SELECT * FROM collection_schedule_heads WHERE schedule_id=?').get(scheduleId);
  const identity = db.prepare('SELECT * FROM collection_schedules WHERE id=?').get(scheduleId);
  const v = db.prepare('SELECT * FROM collection_schedule_versions WHERE id=?').get(head.current_version_id), doc = JSON.parse(v.definition_json);
  const payload = { provider: 'ecb', feed: 'daily', currencies: doc.currencies, expected_publication_revision: 0, publish: true };
  const request = { id: `${id}:request`, portfolio_id: identity.portfolio_id, command_type: 'market_collect', idempotency_key: `${id}:key`, payload_hash: sha(JSON.stringify(payload)),
    payload_json: JSON.stringify(payload), actor_id: 'system:collection-discovery', created_at: at };
  const slot = { id, portfolio_id: identity.portfolio_id, scope_key: identity.scope_key, period, schedule_id: scheduleId,
    schedule_version_id: v.id, authorization_audit_id: head.last_audit_id, authorization_revision: head.revision,
    scheduled_at: period + 'T10:00:00.000000Z', deadline_at: period + 'T10:01:00.000000Z', created_at: at,
    disposition, reason_code: reason, command_request_id: disposition === 'requested' ? request.id : null,
    expected_publication_revision: disposition === 'requested' ? 0 : null };
  return { slot, request: disposition === 'requested' ? request : null, payload };
}
function storeSlot(db, value) {
  db.transaction(() => { if (value.request) insert(db, 'command_requests', value.request); insert(db, 'collection_schedule_slots', value.slot); }).immediate();
}

test('v17 to v18 preserves all old value bytes, adds only empty scheduling tables, and repeat migration writes nothing', t => {
  const f = fixture(t, 17);
  const raw = '{\n "synthetic": true, "spelling": "001.00"\n}\n';
  insert(f.db, 'market_reference_sources', { id: 'old-source', portfolio_id: 'p', reference: 'Synthetic retained original', content_text: raw, content_hash: sha(raw), known_at: T, created_by: 'synthetic-human' });
  insert(f.db, 'command_requests', { id: 'old-request', portfolio_id: 'p', command_type: 'market_collect', idempotency_key: 'synthetic-old',
    payload_json: '{"provider":"ecb","feed":"daily","currencies":["USD"],"expected_publication_revision":0,"publish":true}', payload_hash: sha('synthetic-old'), actor_id: 'synthetic-human', created_at: T });
  const before = snapshot(f.db).filter(row => row.name !== 'schema_migrations'), migrations = copyMigrations(f.directory, 18);
  assert.equal(migrateWorkbench(f.path, { directory: migrations }).applied, 1); assert.deepEqual(snapshot(f.db, before.map(row => row.name)), before);
  for (const table of ['collection_schedules', 'collection_schedule_versions', 'collection_schedule_controls', 'collection_schedule_heads', 'collection_schedule_slots',
    'accounts', 'ledger_events', 'postings', 'proposals', 'approval_events', 'reservations']) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  f.db.pragma('wal_checkpoint(TRUNCATE)'); const physical = sha(readFileSync(f.path)), all = snapshot(f.db);
  assert.equal(migrateWorkbench(f.path, { directory: migrations }).applied, 0); assert.equal(sha(readFileSync(f.path)), physical); assert.deepEqual(snapshot(f.db), all);
  assert.equal(verifyWorkbenchSchema(f.db, migrations).version, 18); assert.deepEqual(f.db.pragma('foreign_key_check'), []); assert.equal(f.db.pragma('quick_check', { simple: true }), 'ok');
});

test('save starts paused, preserves raw UTF8 spelling, and each human enable/pause has immutable controls', t => {
  const { db } = fixture(t); const first = saveMaterial(db); storeSave(db, first);
  assert.equal(db.prepare('SELECT status FROM collection_schedule_heads').get().status, 'paused');
  assert.equal(db.prepare('SELECT definition_json FROM collection_schedule_versions').get().definition_json, first.row.definition_json);
  storeStatus(db, statusMaterial(db)); storeStatus(db, statusMaterial(db, 'enabled', '2026-01-01T09:00:00.999999Z'));
  storeStatus(db, statusMaterial(db, 'paused', '2026-01-01T09:01:00.000000Z'));
  assert.deepEqual(db.prepare('SELECT revision,status FROM collection_schedule_controls ORDER BY revision').all(), [
    { revision: 1, status: 'paused' }, { revision: 2, status: 'enabled' }, { revision: 3, status: 'enabled' }, { revision: 4, status: 'paused' }]);
});

test('new definition advances its version and the head revision, requires pause, and cannot change scope', t => {
  const { db } = fixture(t); enabled(db);
  const next = saveMaterial(db, { at: '2026-01-01T09:30:00.000000Z', document: definition({ max_attempts: 4 }) });
  storeSave(db, next); assert.equal(next.row.version, 2); assert.equal(next.head.revision, 3);
  assert.equal(db.prepare('SELECT status FROM collection_schedule_heads').get().status, 'paused');
  const before = snapshot(db);
  assert.throws(() => storeSave(db, saveMaterial(db, { at: '2026-01-01T09:31:00.000000Z', document: definition({ currencies: ['CNY'] }) })), /scope mismatch/);
  assert.deepEqual(snapshot(db), before);
});

test('audits cannot forge actor, scope, operation, acknowledgement, raw bytes, receipt hash or control CAS', t => {
  const { db } = fixture(t);
  for (const change of [v => { v.audit.actor_id = 'other'; }, v => { v.audit.portfolio_id = 'other'; }, v => { v.audit.object_id = 'other'; },
    v => { v.audit.object_type = 'other'; }, v => { v.audit.action = 'other'; }, v => { v.audit.ledger_revision = 0; }, v => { v.audit.created_at = ENABLE; },
    v => { v.auditPayload.actor_kind = 'ai'; }, v => { v.auditPayload.input.acknowledgement = false; }, v => { v.auditPayload.input.expected_schedule_id = 'schedule'; },
    v => { v.auditPayload.input.expected_schedule_revision = 1; }, v => { v.auditPayload.input.definition_json += ' '; },
    v => { v.auditPayload.result.content_hash = sha('different'); }, v => { v.auditPayload.result.version_id = 'other'; }, v => { v.control.revision = 2; },
    v => { v.head.status = 'enabled'; }]) {
    const value = saveMaterial(db); change(value); assert.throws(() => storeSave(db, value));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM collection_schedules').get().n, 0);
  }
  enabled(db); const before = snapshot(db);
  for (const change of [v => { v.auditPayload.input.schedule_id = 'other'; }, v => { v.auditPayload.input.status = 'enabled'; },
    v => { v.auditPayload.result.scope_key = 'other'; }, v => { v.auditPayload.result.content_hash = sha('other'); }, v => { v.control.version_id = 'other'; },
    v => { v.head.last_audit_id = 'schedule:audit:1'; }, v => { v.head.updated_at = T; }]) {
    const value = statusMaterial(db, 'paused', '2026-01-01T09:10:00.000000Z'); change(value); assert.throws(() => storeStatus(db, value)); assert.deepEqual(snapshot(db), before);
  }
});

test('direct SQL cannot label system actors or non-strict audit documents as human collection authorization', t => {
  const { db } = fixture(t);
  const changes = [
    v => { v.identity.created_by = v.row.created_by = v.audit.actor_id = 'system:synthetic-discovery'; },
    v => { v.auditPayload.extra = true; },
    v => { v.auditPayload.input.extra = true; },
    v => { v.auditPayload.result.extra = true; },
    v => { v.auditPayload.input.reason = ''; },
    v => { v.auditPayload.input.reason = '\uFEFF\u00A0'; },
    v => { v.auditPayload.input.reason = 'x'.repeat(2001); },
    v => { v.auditPayload.input.idempotency_key = 'synthetic key'; },
    v => { v.auditPayload.input.idempotency_key = 'x'.repeat(161); },
    v => { v.auditPayload.input.expected_schedule_revision = false; },
    v => { v.auditPayload.result.version = true; },
  ];
  for (const change of changes) {
    const value = saveMaterial(db); change(value);
    assert.throws(() => storeSave(db, value));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM collection_schedules').get().n, 0);
  }
  enabled(db);
  const before = snapshot(db);
  for (const change of [v => { v.audit.actor_id = 'system:synthetic-discovery'; },
    v => { v.auditPayload.extra = true; }, v => { v.auditPayload.input.definition_json = '{}'; },
    v => { v.auditPayload.result.extra = true; }, v => { v.auditPayload.input.reason = '\uFEFF'; }]) {
    const value = statusMaterial(db, 'paused', DUE); change(value);
    assert.throws(() => storeStatus(db, value)); assert.deepEqual(snapshot(db), before);
  }
  const valid = statusMaterial(db, 'paused', DUE);
  valid.auditPayload.input.reason = '\u{1F9EA}'.repeat(1000);
  storeStatus(db, valid);
  const duplicate = statusMaterial(db, 'enabled', DEADLINE);
  duplicate.audit.payload_json = JSON.stringify(duplicate.auditPayload).replace('"actor_kind":"human"', '"actor_kind":"ai","actor_kind":"human"');
  assert.throws(() => insert(db, 'audit_events', duplicate.audit));
});

test('only one portfolio can enable an exact publication scope, including UPDATE OR REPLACE', t => {
  const { db } = fixture(t); enabled(db); storeSave(db, saveMaterial(db, { id: 'second', portfolio: 'other' }));
  const before = snapshot(db);
  for (const prefix of ['UPDATE', 'UPDATE OR REPLACE']) {
    assert.throws(() => storeStatus(db, statusMaterial(db, 'enabled', ENABLE, 'second'), prefix)); assert.deepEqual(snapshot(db), before);
  }
  storeStatus(db, statusMaterial(db, 'paused', '2026-01-01T09:30:00.000000Z'));
  storeStatus(db, statusMaterial(db, 'enabled', '2026-01-01T09:31:00.000000Z', 'second'));
  assert.equal(db.prepare("SELECT schedule_id FROM collection_schedule_heads WHERE status='enabled'").get().schedule_id, 'second');
  enabled(db, { id: 'different', currencies: ['CNY'], document: definition({ currencies: ['CNY'] }) });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM collection_schedule_heads WHERE status='enabled'").get().n, 2);
});

test('requested slot freezes due authorization and one real command without a duplicate runtime status', t => {
  const { db } = fixture(t); enabled(db); const value = slotMaterial(db); storeSlot(db, value);
  const row = db.prepare('SELECT * FROM collection_schedule_slots').get(); assert.equal(row.command_request_id, value.request.id);
  assert.equal(row.expected_publication_revision, 0); assert.equal(row.status, undefined); assert.equal(row.job_id, undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_runs').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger_events').get().n, 0); assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('slot request rejects cross scope, forged actor/payload, stale publication revision and closed time boundaries', t => {
  const { db } = fixture(t); enabled(db); const before = snapshot(db);
  for (const change of [v => { v.slot.portfolio_id = 'other'; }, v => { v.slot.scope_key = scope(['CNY']); }, v => { v.slot.authorization_revision = 1; },
    v => { v.slot.authorization_audit_id = 'schedule:audit:1'; }, v => { v.slot.schedule_version_id = 'other'; }, v => { v.slot.scheduled_at = '2026-01-01T10:00:00.000001Z'; },
    v => { v.slot.deadline_at = '2026-01-01T10:01:00.000001Z'; }, v => { v.slot.created_at = '2026-01-01T09:59:59.999999Z'; v.request.created_at = v.slot.created_at; },
    v => { v.slot.created_at = DEADLINE; v.request.created_at = DEADLINE; }, v => { v.slot.expected_publication_revision = 1; },
    v => { v.request.actor_id = 'human'; }, v => { v.request.portfolio_id = 'other'; }, v => { v.request.command_type = 'valuation'; },
    v => { v.request.created_at = T; }, v => { v.payload.publish = false; }, v => { v.payload.currencies = ['CNY']; },
    v => { v.payload.expected_publication_revision = 2; }, v => { v.payload.raw = 'synthetic'; }]) {
    const value = slotMaterial(db); change(value); value.request.payload_json = JSON.stringify(value.payload);
    assert.throws(() => storeSlot(db, value)); assert.deepEqual(snapshot(db), before);
  }
  const atStart = slotMaterial(db, { at: DUE }); storeSlot(db, atStart);
});

test('daily slot uniqueness survives pause, version changes and portfolio ownership changes', t => {
  const { db } = fixture(t); enabled(db); storeSlot(db, slotMaterial(db));
  storeStatus(db, statusMaterial(db, 'paused', '2026-01-01T10:00:10.000000Z'));
  storeSave(db, saveMaterial(db, { at: '2026-01-01T10:00:20.000000Z', document: definition({ trigger: { hour: 10, minute: 30 } }) }));
  storeStatus(db, statusMaterial(db, 'enabled', '2026-01-01T10:00:30.000000Z'));
  const changedVersion = slotMaterial(db, { id: 'new-version-slot', at: '2026-01-01T10:30:00.000000Z' });
  changedVersion.slot.scheduled_at = '2026-01-01T10:30:00.000000Z'; changedVersion.slot.deadline_at = '2026-01-01T10:31:00.000000Z';
  assert.throws(() => storeSlot(db, changedVersion), /daily slot/);
  storeStatus(db, statusMaterial(db, 'paused', '2026-01-01T10:10:00.000000Z'));
  storeSave(db, saveMaterial(db, { id: 'other-schedule', portfolio: 'other', at: '2026-01-01T10:11:00.000000Z', document: definition({ trigger: { hour: 10, minute: 30 } }) }));
  storeStatus(db, statusMaterial(db, 'enabled', '2026-01-01T10:12:00.000000Z', 'other-schedule'));
  const before = snapshot(db);
  const newOwner = slotMaterial(db, { id: 'other-slot', scheduleId: 'other-schedule', at: '2026-01-01T10:30:00.000000Z' });
  newOwner.slot.scheduled_at = changedVersion.slot.scheduled_at; newOwner.slot.deadline_at = changedVersion.slot.deadline_at;
  assert.throws(() => storeSlot(db, newOwner), /daily slot/);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM collection_schedule_slots').get().n, 1);
});

test('two SQLite connections with the same pre-read slot cannot commit a second command or slot', t => {
  const f = fixture(t); enabled(f.db);
  const other = new Database(f.path); other.pragma('foreign_keys=ON'); other.pragma('recursive_triggers=OFF');
  try {
    const first = slotMaterial(f.db, { id: 'writer-a' }), second = slotMaterial(other, { id: 'writer-b' });
    storeSlot(f.db, first); assert.throws(() => storeSlot(other, second), /daily slot/);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM command_requests').get().n, 1);
    assert.equal(other.prepare('SELECT COUNT(*) n FROM collection_schedule_slots').get().n, 1);
  } finally { other.close(); }
});

test('an enabled current schedule records deadline-missed history without request, job or publication', t => {
  const { db } = fixture(t); enabled(db);
  const missed = slotMaterial(db, { disposition: 'missed', reason: 'DEADLINE_EXPIRED', at: DEADLINE }); storeSlot(db, missed);
  for (const table of ['command_requests', 'job_runs', 'market_publications', 'ledger_events']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  assert.equal(db.prepare('SELECT reason_code FROM collection_schedule_slots').get().reason_code, 'DEADLINE_EXPIRED');
});

test('historical missed reason is determined by the first authorization close versus deadline, including equality and microseconds', t => {
  for (const [closed, reason] of [['2026-01-01T10:00:59.999999Z', 'AUTHORIZATION_ENDED'], [DEADLINE, 'DEADLINE_EXPIRED'], ['2026-01-01T10:01:00.000001Z', 'DEADLINE_EXPIRED']]) {
    const { db } = fixture(t); enabled(db);
    const old = slotMaterial(db, { disposition: 'missed', reason, at: '2026-01-01T11:00:00.000000Z' });
    storeStatus(db, statusMaterial(db, 'paused', closed));
    const before = snapshot(db), wrong = { ...old, slot: { ...old.slot, reason_code: reason === 'AUTHORIZATION_ENDED' ? 'DEADLINE_EXPIRED' : 'AUTHORIZATION_ENDED' } };
    assert.throws(() => storeSlot(db, wrong)); assert.deepEqual(snapshot(db), before); storeSlot(db, old);
    assert.equal(db.prepare('SELECT reason_code FROM collection_schedule_slots').get().reason_code, reason);
  }
});

test('future, pre-enable and exactly ended authorization cannot fabricate a due slot', t => {
  for (const close of ['2026-01-01T09:59:59.999999Z', DUE]) {
    const { db } = fixture(t); enabled(db); const old = slotMaterial(db, { disposition: 'missed', reason: 'AUTHORIZATION_ENDED', at: DEADLINE });
    storeStatus(db, statusMaterial(db, 'paused', close)); assert.throws(() => storeSlot(db, old), /frozen due authorization/);
  }
  const { db } = fixture(t); storeSave(db, saveMaterial(db)); storeStatus(db, statusMaterial(db, 'enabled', '2026-01-01T10:00:00.000001Z'));
  assert.throws(() => storeSlot(db, slotMaterial(db, { disposition: 'missed', reason: 'DEADLINE_EXPIRED', at: DEADLINE })), /frozen due authorization/);
});

test('identity, versions, controls and slots reject update/delete/replacement aliases with recursive triggers OFF', t => {
  const { db } = fixture(t); const { saved, status } = enabled(db); const value = slotMaterial(db); storeSlot(db, value);
  const before = snapshot(db);
  for (const [table, key, rows] of [
    ['collection_schedules', 'id', [saved.identity, { ...saved.identity, id: 'alias' }]],
    ['collection_schedule_versions', 'id', [saved.row, { ...saved.row, id: 'alias' }, { ...saved.row, id: 'alias', version: 2 }]],
    ['collection_schedule_controls', 'schedule_id', [status.control, { ...status.control, revision: 3 }]],
    ['collection_schedule_slots', 'id', [value.slot, { ...value.slot, id: 'alias' }, { ...value.slot, id: 'alias', period: '2026-01-02' }]],
  ]) {
    for (const row of rows) assert.throws(() => insert(db, table, row, 'INSERT OR REPLACE'), table);
    assert.throws(() => db.exec(`UPDATE ${table} SET ${key}=${key}`), table); assert.throws(() => db.exec(`DELETE FROM ${table}`), table);
  }
  assert.throws(() => insert(db, 'collection_schedule_heads', status.head, 'INSERT OR REPLACE'));
  assert.throws(() => db.exec('DELETE FROM collection_schedule_heads')); assert.deepEqual(snapshot(db), before);
});

test('strict raw definitions reject duplicate/unknown fields, wrong provider/timezone, float ranges, dates and oversized bytes', t => {
  const { db } = fixture(t);
  const invalid = [definition({ provider: 'longport' }), definition({ feed: 'hist_90d' }), definition({ timezone: 'Europe/Berlin' }),
    definition({ publish: false }), definition({ deadline_seconds: 59 }), definition({ deadline_seconds: 86401 }), definition({ max_attempts: true }),
    definition({ max_attempts: 2.5 }), definition({ trigger: { hour: 10, minute: 0.5 } }), definition({ currencies: ['USD', 'USD'] }),
    definition({ start_date: '0000-01-01' }), definition({ start_date: '2026-02-30' }), definition({ end_date: '2025-12-31' }),
    definition({ url: 'https://synthetic.invalid' }), definition({ expected_publication_revision: 0 })];
  for (const document of invalid) assert.throws(() => storeSave(db, saveMaterial(db, { document })));
  const raw = JSON.stringify(definition());
  for (const spelling of [raw.replace('"provider":"ecb"', '"provider":"other","provider":"ecb"'),
    raw.replace('"minute":0', '"minute":1,"minute":0'), raw + ' '.repeat(65536), '\ufeff' + raw])
    assert.throws(() => storeSave(db, saveMaterial(db, { raw: spelling })));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM collection_schedules').get().n, 0);
  const exact = raw.replace('"max_attempts":3', '"max_attempts":3.0'); storeSave(db, saveMaterial(db, { raw: exact }));
  assert.equal(db.prepare('SELECT definition_json FROM collection_schedule_versions').get().definition_json, exact);
});

test('collection-schedule shared schema accepts explicit daily ECB only and rejects caller authority/transport fields', () => {
  const ajv = new Ajv({ allErrors: true, strict: true }); addFormats(ajv);
  for (const name of readdirSync(join(root, 'contracts/v1')).filter(name => name.endsWith('.schema.json'))) ajv.addSchema(JSON.parse(readFileSync(join(root, 'contracts/v1', name))));
  const check = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/collection-schedule.schema.json');
  assert.equal(check(definition()), true, JSON.stringify(check.errors));
  for (const field of Object.keys(definition())) { const missing = definition(); delete missing[field]; assert.equal(check(missing), false, field); }
  for (const patch of [{ provider: 'longport' }, { feed: 'hist_90d' }, { timezone: 'Europe/Berlin' }, { publish: false }, { currencies: ['USD', 'USD'] },
    { currencies: [] }, { deadline_seconds: 59 }, { deadline_seconds: 86401 }, { max_attempts: 0 }, { max_attempts: 6 }, { max_attempts: true },
    { start_date: '2026-02-30' }, { start_date: '0000-01-01' }, { trigger: { hour: 24, minute: 0 } }, { trigger: { hour: 10, minute: 0, second: 0 } },
    { url: 'https://synthetic.invalid' }, { token: 'SYNTHETIC-NOT-A-SECRET' }, { expected_publication_revision: 0 }, { actor_id: 'system' }, { known_at: T }])
    assert.equal(check(definition(patch)), false, JSON.stringify(patch));
});

test('SQL proof budget reserves revision 1024 solely for the last human pause and caps versions at 1023', t => {
  const { db } = fixture(t); enabled(db);
  // Seed only the boundary in this temporary SQL-guard fixture, not a claimed valid 1023-control proof.
  const names = ['collection_control_insert', 'collection_head_update', 'collection_audit_insert'];
  const triggers = names.map(name => db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name).sql);
  for (const name of names) db.exec(`DROP TRIGGER ${name}`);
  const head = db.prepare('SELECT * FROM collection_schedule_heads').get();
  insert(db, 'audit_events', { id: 'synthetic-budget-seed', portfolio_id: 'p', actor_id: 'synthetic-human', action: 'set_collection_schedule_status',
    object_type: 'collection_schedule', object_id: 'schedule', payload_json: '{"synthetic_boundary_seed":true}', created_at: ENABLE });
  insert(db, 'collection_schedule_controls', { schedule_id: 'schedule', revision: 1023, version_id: head.current_version_id, status: 'enabled', audit_id: 'synthetic-budget-seed', created_at: ENABLE });
  updateHead(db, { ...head, revision: 1023, last_audit_id: 'synthetic-budget-seed' });
  for (const sql of triggers) db.exec(sql);
  const before = snapshot(db);
  assert.throws(() => storeStatus(db, statusMaterial(db, 'enabled', DUE)), /proof budget/);
  assert.throws(() => storeSave(db, saveMaterial(db, { at: DUE })), /proof budget/);
  const oversizedVersion = saveMaterial(db, { at: DUE }); oversizedVersion.row.version = 1024;
  assert.throws(() => storeSave(db, oversizedVersion), /version proof budget/);
  assert.deepEqual(snapshot(db), before);
  storeStatus(db, statusMaterial(db, 'paused', DUE));
  assert.deepEqual(db.prepare('SELECT revision,status FROM collection_schedule_heads').get(), { revision: 1024, status: 'paused' });
  const paused = snapshot(db);
  assert.throws(() => storeStatus(db, statusMaterial(db, 'enabled', DEADLINE)), /proof budget/);
  assert.throws(() => storeStatus(db, statusMaterial(db, 'paused', DEADLINE)), /proof budget/);
  assert.deepEqual(snapshot(db), paused); assert.deepEqual(db.pragma('foreign_key_check'), []);
});
