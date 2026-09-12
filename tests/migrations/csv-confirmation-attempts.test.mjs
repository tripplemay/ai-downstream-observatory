import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadMigrations, migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const Database = createRequire(join(root, 'web/package.json'))('better-sqlite3');
const now = '2026-01-01T00:00:00.000Z', sha = (text) => createHash('sha256').update(text).digest('hex');
const fields = ['id', 'actor_id', 'session_hash', 'portfolio_id', 'account_id', 'batch_id', 'preview_hash', 'expected_revision', 'payload_text', 'payload_hash', 'created_at'];
const schemaVersion = loadMigrations().length;

function fixture(t, version = schemaVersion) {
  const directory = mkdtempSync(join(tmpdir(), 'csv-attempt-migration-')), path = join(directory, 'workbench.db');
  let migrations = migrationDirectory;
  if (version !== schemaVersion) {
    migrations = join(directory, `v${version}`); mkdirSync(migrations);
    const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'), 'utf8'));
    for (const item of manifest.migrations.slice(0, version)) cpSync(join(migrationDirectory, item.file), join(migrations, item.file));
    writeFileSync(join(migrations, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, version) }));
  }
  migrateWorkbench(path, { directory: migrations });
  const db = new Database(path); db.pragma('foreign_keys=ON');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const suffix of ['a', 'b']) {
    db.prepare('INSERT INTO portfolios(id,name,created_at) VALUES(?,?,?)').run(`p-${suffix}`, 'Synthetic', now);
    db.prepare("INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES(?,?,'Synthetic','Synthetic','CNY',?)").run(`a-${suffix}`, `p-${suffix}`, now);
  }
  db.prepare("INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES('a-a2','p-a','Synthetic second','Synthetic','CNY',?)").run(now);
  return { db, path };
}

function batch(db, id, status = 'preview', expectedRevision = 0) {
  for (const [suffix, media, text] of [['mapping', 'application/json', '{}'], ['csv', 'text/csv', 'Synthetic\n1\n']]) {
    const attachment = `${id}-${suffix}`;
    db.prepare('INSERT INTO attachments(id,content_hash,media_type,byte_size,storage_key,created_at) VALUES(?,?,?,?,?,?)')
      .run(attachment, sha(text), media, Buffer.byteLength(text), `synthetic/${attachment}`, now);
    db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,portfolio_id,payload_json,created_at) VALUES(?,'synthetic-owner','store_attachment','attachment',?,'p-a',?,?)")
      .run(`audit-${attachment}`, attachment, JSON.stringify({ account_id: 'a-a', content_hash: sha(text), byte_size: Buffer.byteLength(text) }), now);
  }
  db.prepare("INSERT INTO csv_mapping_versions(id,portfolio_id,account_id,mapping_key,version,content_hash,attachment_id,definition_json,actor_id,created_at) VALUES(?,'p-a','a-a',?,1,?,?,?,'synthetic-owner',?)")
    .run(`mapping-${id}`, id, sha(id), `${id}-mapping`, JSON.stringify({ mapping_id: id, version: 1 }), now);
  const initialStatus = status === 'invalid' ? 'invalid' : 'preview';
  db.prepare("INSERT INTO import_batches(id,portfolio_id,account_id,attachment_id,content_hash,parser_version,mapping_version,status,preview_hash,expected_revision,row_count,error_count,created_by,created_at) VALUES(?,'p-a','a-a',?,?,'csv-v1',?,?,?,?,1,0,'synthetic-owner',?)")
    .run(id, `${id}-csv`, sha('Synthetic\n1\n'), `mapping-${id}`, initialStatus, sha(`preview-${id}`), expectedRevision, now);
  db.prepare("INSERT INTO import_rows(batch_id,row_number,raw_json,normalized_json,errors_json) VALUES(?,1,'{}','{}','[]')").run(id);
  db.prepare("INSERT INTO csv_import_manifests(batch_id,mapping_version_id,manifest_json,content_hash,created_at) VALUES(?,?,'{}',?,?)").run(id, `mapping-${id}`, sha(`manifest-${id}`), now);
  if (status === 'cancelled') db.prepare("UPDATE import_batches SET status='cancelled' WHERE id=?").run(id);
  if (status === 'confirmed') {
    const eventId = `event-${id}`, auditId = `confirm-audit-${id}`;
    db.prepare("INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,recorded_at,source_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id) VALUES(?,'p-a','a-a','deposit',?,?,'synthetic',?,?,'{}',?,'synthetic-owner')")
      .run(eventId, now, now, eventId, sha(eventId), expectedRevision + 1);
    db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,portfolio_id,payload_json,created_at) VALUES(?,'synthetic-owner','record_fact','ledger_event',?,'p-a','{}',?)").run(auditId, eventId, now);
    const receipt = { event_id: eventId, audit_id: auditId, revision: expectedRevision + 1, duplicate: false };
    db.prepare("INSERT INTO csv_import_outcomes(batch_id,row_number,event_id,duplicate,result_json,actor_id,created_at) VALUES(?,1,?,0,?,'synthetic-owner',?)").run(id, eventId, JSON.stringify({ receipt }), now);
    db.prepare("UPDATE import_batches SET status='confirmed',confirmed_at=?,confirmed_revision=? WHERE id=?").run(now, expectedRevision + 1, id);
  }
  return id;
}

function attempt(id = 'attempt', batchId = 'batch', payload = '\ufeff{ "action":"confirm_import", "synthetic":true }\r\n') {
  return { id, actor_id: 'synthetic-owner', session_hash: sha('synthetic-session'), portfolio_id: 'p-a', account_id: 'a-a',
    batch_id: batchId, preview_hash: sha(`preview-${batchId}`), expected_revision: 0, payload_text: payload, payload_hash: sha(payload), created_at: now };
}
function insert(db, value, prefix = 'INSERT') {
  return db.prepare(`${prefix} INTO csv_confirmation_attempts(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`).run(...fields.map(key => value[key]));
}
function tables(db) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'schema_migrations' ORDER BY name").all())
    .map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() }));
}

test('v13 to v14 preserves all original facts and CSV evidence, starts empty and is repeatable', t => {
  const f = fixture(t, 13); batch(f.db, 'historical', 'confirmed');
  const before = tables(f.db);
  assert.equal(migrateWorkbench(f.path).applied, schemaVersion - 13);
  for (const { name, rows } of before) assert.deepEqual(f.db.prepare(`SELECT * FROM "${name}"`).all(), rows, name);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM csv_confirmation_attempts').get().n, 0);
  assert.equal(verifyWorkbenchSchema(f.db).version, schemaVersion); assert.equal(migrateWorkbench(f.path).applied, 0);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []); assert.equal(f.db.pragma('quick_check', { simple: true }), 'ok');
});

test('attempts retain BOM and exact UTF8 text independently of JSON syntax and never mark a batch confirmed', t => {
  const f = fixture(t); batch(f.db, 'batch');
  const value = attempt(), before = tables(f.db).filter(row => row.name !== 'csv_confirmation_attempts');
  insert(f.db, value);
  assert.deepEqual(f.db.prepare('SELECT * FROM csv_confirmation_attempts WHERE id=?').get(value.id), value);
  assert.equal(f.db.prepare('SELECT hex(CAST(payload_text AS BLOB)) bytes FROM csv_confirmation_attempts').get().bytes, Buffer.from(value.payload_text).toString('hex').toUpperCase());
  insert(f.db, attempt('syntax-is-service-owned', 'batch', '{not valid JSON'));
  for (const { name, rows } of before) assert.deepEqual(f.db.prepare(`SELECT * FROM "${name}"`).all(), rows, name);
  assert.equal(f.db.prepare("SELECT status FROM import_batches WHERE id='batch'").get().status, 'preview');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ledger_events').get().n, 0);
});

test('attempt scope requires a CSV manifest plus exact portfolio, account, preview hash and revision', t => {
  const f = fixture(t); batch(f.db, 'batch');
  f.db.prepare("INSERT INTO import_batches(id,portfolio_id,account_id,content_hash,parser_version,status,preview_hash,expected_revision,created_by,created_at) VALUES('json','p-a','a-a',?,'json-v1','preview',?,0,'synthetic-owner',?)").run(sha('json'), sha('preview-json'), now);
  for (const patch of [
    { account_id: 'a-a2' }, { portfolio_id: 'p-b', account_id: 'a-b' }, { portfolio_id: 'p-b' },
    { batch_id: 'missing' }, { batch_id: 'json', preview_hash: sha('preview-json') },
    { preview_hash: sha('other') }, { expected_revision: 1 },
  ]) assert.throws(() => insert(f.db, { ...attempt(), ...patch }), /scope mismatch|FOREIGN KEY/);
  insert(f.db, attempt());
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('failed, cancelled and already confirmed CSV batches can retain an attempt without changing status or outcomes', t => {
  const f = fixture(t);
  for (const status of ['preview', 'invalid', 'cancelled', 'confirmed']) batch(f.db, status, status);
  const before = tables(f.db).filter(row => row.name !== 'csv_confirmation_attempts');
  for (const status of ['preview', 'invalid', 'cancelled', 'confirmed']) insert(f.db, attempt(`attempt-${status}`, status));
  for (const { name, rows } of before) assert.deepEqual(f.db.prepare(`SELECT * FROM "${name}"`).all(), rows, name);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM csv_confirmation_attempts').get().n, 4);
});

test('attempt identity is immutable and deduplication is isolated by actor and authenticated session', t => {
  const f = fixture(t); batch(f.db, 'batch'); const value = attempt(); insert(f.db, value);
  assert.throws(() => insert(f.db, { ...value, id: 'same-payload-other-id' }), /UNIQUE|append-only/);
  insert(f.db, { ...value, id: 'other-actor', actor_id: 'synthetic-other' });
  insert(f.db, { ...value, id: 'other-session', session_hash: sha('another-session') });
  insert(f.db, attempt('changed-payload', 'batch', ' {"synthetic":"different explicit request"} '));
  assert.throws(() => f.db.prepare("UPDATE csv_confirmation_attempts SET payload_text='{}' WHERE id=?").run(value.id), /append-only/);
  assert.throws(() => f.db.prepare('DELETE FROM csv_confirmation_attempts WHERE id=?').run(value.id), /append-only/);
  assert.deepEqual(f.db.prepare('SELECT * FROM csv_confirmation_attempts WHERE id=?').get(value.id), value);
});

test('SQLite replacement conflict modes cannot bypass attempt append-only guards with recursive triggers disabled', t => {
  const f = fixture(t); batch(f.db, 'batch'); const value = attempt(); insert(f.db, value);
  f.db.pragma('recursive_triggers=OFF');
  assert.throws(() => insert(f.db, { ...value, payload_text: '{"synthetic":"replaced"}', payload_hash: sha('changed') }, 'INSERT OR REPLACE'), /append-only/);
  assert.throws(() => insert(f.db, { ...value, id: 'replacement-id' }, 'INSERT OR REPLACE'), /append-only/);
  assert.deepEqual(f.db.prepare('SELECT * FROM csv_confirmation_attempts').all(), [value]);
});

test('payload bounds count UTF8 bytes and hashes/revisions enforce text lowercase hex and safe integers', t => {
  const f = fixture(t); batch(f.db, 'batch');
  for (const patch of [
    { id: null }, { actor_id: '' }, { actor_id: '   ' }, { session_hash: 'A'.repeat(64) }, { session_hash: 'a'.repeat(63) },
    { payload_hash: 'g'.repeat(64) }, { payload_hash: Buffer.alloc(64, 'a') }, { preview_hash: 'f'.repeat(65) },
    { expected_revision: -1 }, { expected_revision: 0.5 }, { expected_revision: 9007199254740992 },
    { payload_text: '' }, { payload_text: Buffer.from('{}') }, { payload_text: 'x'.repeat(5242881) },
    { payload_text: '\u4e2d'.repeat(Math.floor(5242880 / 3) + 1) },
  ]) assert.throws(() => insert(f.db, { ...attempt(), ...patch }), /CHECK|NOT NULL|scope mismatch/);
  const exact = attempt('max-bytes', 'batch', '\ufeff' + 'x'.repeat(5242880 - 3)); insert(f.db, exact);
  assert.equal(f.db.prepare('SELECT length(CAST(payload_text AS BLOB)) n FROM csv_confirmation_attempts WHERE id=?').get(exact.id).n, 5242880);
  batch(f.db, 'safe-revision', 'preview', Number.MAX_SAFE_INTEGER);
  insert(f.db, { ...attempt('safe-integer', 'safe-revision'), expected_revision: Number.MAX_SAFE_INTEGER });
});

test('session keyset pagination uses the ordered index and handles identical timestamps without gaps', t => {
  const f = fixture(t); batch(f.db, 'batch');
  for (const id of ['a', 'b', 'c', 'd', 'e']) insert(f.db, attempt(id, 'batch', `{"synthetic":"${id}"}`));
  insert(f.db, { ...attempt('hidden', 'batch'), session_hash: sha('other-session') });
  const query = `SELECT id,created_at FROM csv_confirmation_attempts WHERE actor_id=? AND session_hash=?
    AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?`;
  const params = ['synthetic-owner', sha('synthetic-session'), '9999-12-31T00:00:00.000Z', 'z', 2];
  const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params).map(row => row.detail).join('\n');
  assert.match(plan, /csv_confirmation_attempts_session/); assert.doesNotMatch(plan, /USE TEMP B-TREE/);
  const seen = [];
  for (;;) {
    const page = f.db.prepare(query).all(...params); if (!page.length) break;
    seen.push(...page.map(row => row.id)); params[2] = page.at(-1).created_at; params[3] = page.at(-1).id;
  }
  assert.deepEqual(seen, ['e', 'd', 'c', 'b', 'a']);
});
