import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrateWorkbench } from '../../scripts/migrate-workbench.mjs';
import { Database, HEADER_SIZE, LIMITS, backupWorkbench, encryptTar, inspectSnapshot, safeAttachment, sha256File, tar } from '../../scripts/backup-workbench.mjs';
import { restoreWorkbench } from '../../scripts/restore-workbench.mjs';

const passphrase = 'synthetic-backup-passphrase-not-a-real-secret-2026';
const now = '2026-01-01T00:00:00.000Z';
function attachmentApi(input) {
  const source = `
    import { openWorkbench } from './web/src/server/workbench-db';
    import { storeCsvAttachment, readCsvAttachment, readJsonAttachment } from './web/src/server/ledger/attachments';
    const input = JSON.parse(process.env.RECOVERY_ATTACHMENT_FIXTURE!);
    const db = openWorkbench(input.dbPath), actor = { id: 'synthetic-owner' };
    const options = { dataDir: input.dataDir, now: '${now}', accountId: 'a' };
    if (input.action === 'store') {
      const value = storeCsvAttachment(db, actor, { portfolio_id: 'p', account_id: 'a', bytes: Buffer.from(input.base64, 'base64') }, options);
      console.log(JSON.stringify(value));
    } else {
      const csv = readCsvAttachment(db, actor, 'p', input.id, options);
      const oldJson = readJsonAttachment(db, actor, 'p', 'attachment', options);
      const blocked = [];
      for (const [label, read] of [
        ['other-account', () => readCsvAttachment(db, actor, 'p', input.id, { ...options, accountId: 'b' })],
        ['other-portfolio', () => readCsvAttachment(db, actor, 'q', input.id, { ...options, accountId: 'c' })],
        ['wrong-media-reader', () => readJsonAttachment(db, actor, 'p', input.id, options)],
      ]) { try { read(); } catch (error) { blocked.push([label, error.message]); } }
      console.log(JSON.stringify({ csv: csv.bytes.toString('base64'), json: oldJson.bytes.toString('base64'), blocked }));
    }
    db.close();
  `;
  const result = spawnSync(fileURLToPath(new URL('../../web/node_modules/.bin/tsx', import.meta.url)), ['--eval', source], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8', env: { ...process.env, RECOVERY_ATTACHMENT_FIXTURE: JSON.stringify(input) },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function fixture(t, { attachment = true, auth = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'etf-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'data'), outputDir = join(directory, 'backups'), dbPath = join(dataDir, 'etf-workbench.db');
  mkdirSync(dataDir, { mode: 0o700 }); migrateWorkbench(dbPath);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`INSERT INTO portfolios(id,name,created_at) VALUES('p','Synthetic','${now}');
    INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES('a','p','A','Synthetic','CNY','${now}');
    INSERT INTO ledger_heads(portfolio_id,revision,updated_at) VALUES('p',1,'${now}');
    INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,recorded_at,source_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id)
      VALUES('event','p','a','deposit','${now}','${now}','synthetic','key','${'a'.repeat(64)}','{}',1,'owner');
    INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES('cash','event','a','CNY','cash_settled','1000000.000000000000000001');
    INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES('capital','event','a','CNY','external_capital','-1000000.000000000000000001');`);
  let attachmentPath;
  if (attachment) {
    const original = Buffer.from('[{"source_event_id":"synthetic-private-event","amount":"1000000.000000000000000001"}]\n');
    const digest = createHash('sha256').update(original).digest('hex'), storageKey = `attachments/${digest}.json`;
    attachmentPath = join(dataDir, storageKey); mkdirSync(join(dataDir, 'attachments'), { mode: 0o700 });
    writeFileSync(attachmentPath, original, { flag: 'wx', mode: 0o600 });
    db.prepare('INSERT INTO attachments(id,content_hash,media_type,byte_size,storage_key,created_at) VALUES(?,?,?,?,?,?)').run('attachment', digest, 'application/json', original.length, storageKey, now);
  }
  db.close();
  if (auth) {
    const authDb = new Database(join(dataDir, 'auth.sqlite'));
    authDb.exec(`CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,config_version TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER);
      CREATE TABLE login_limits(scope TEXT PRIMARY KEY,window_started INTEGER NOT NULL,attempts INTEGER NOT NULL);
      INSERT INTO sessions VALUES('old-session-hash','old-config',1,9999999999999,NULL);`);
    authDb.close();
  }
  const options = { dbPath, dataDir, outputDir, passphrase, appRef: 'test-fixture', now: () => now };
  return { directory, dataDir, dbPath, outputDir, attachmentPath, options };
}

test('E-32: online snapshot + encrypted roundtrip preserves facts/attachments, revokes auth, writes read-only marker', async (t) => {
  const f = fixture(t), replicaDir = join(f.directory, 'replica');
  const before = await sha256File(f.dbPath), originalAttachment = readFileSync(f.attachmentPath);
  const result = await backupWorkbench({ ...f.options, replicaDir });
  assert.equal(result.replica.status, 'verified_copy');
  assert.equal(result.replica.independent_failure_domain_verified, false);
  assert.equal(await sha256File(result.replica.path), result.sha256);
  assert.equal(await sha256File(f.dbPath), before);
  assert.equal(readFileSync(result.path).includes(Buffer.from('synthetic-private-event')), false);
  assert.equal(statSync(result.path).mode & 0o777, 0o600);
  const target = join(f.directory, 'restored');
  const restored = await restoreWorkbench({ archivePath: result.path, targetDir: target, passphrase, incidentAt: '2026-01-01T00:10:00Z' });
  assert.equal(restored.pending_review, true);
  assert.ok(existsSync(join(target, 'RESTORE_PENDING_REVIEW')));
  const recovered = new Database(restored.database_path, { readonly: true });
  try {
    assert.equal(recovered.prepare("SELECT amount FROM postings WHERE id='cash'").get().amount, '1000000.000000000000000001');
    assert.equal(recovered.prepare("SELECT revision FROM ledger_heads WHERE portfolio_id='p'").get().revision, 1);
    assert.deepEqual(recovered.pragma('foreign_key_check'), []);
    assert.equal(recovered.pragma('quick_check', { simple: true }), 'ok');
    const attachment = recovered.prepare('SELECT storage_key FROM attachments').get();
    assert.deepEqual(readFileSync(join(target, attachment.storage_key)), originalAttachment);
  } finally { recovered.close(); }
  const auth = new Database(join(target, 'auth.sqlite'), { readonly: true });
  try { assert.equal(auth.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0); } finally { auth.close(); }
  const secretFile = readFileSync(restored.session_secret_file, 'utf8');
  assert.match(secretFile, /^WORKBENCH_SESSION_SECRET=[A-Za-z0-9_-]{64}\nWORKBENCH_MODE=read_only\n$/);
  assert.equal(statSync(restored.session_secret_file).mode & 0o777, 0o600);
  const report = JSON.parse(readFileSync(restored.report_path, 'utf8'));
  assert.equal(report.snapshot_age_at_incident_seconds, 600);
  assert.equal(report.production_readiness, 'not_verified');
  assert.equal(report.old_sessions_revoked, true);
  assert.equal(report.independent_failure_domain_verified, false);
  assert.equal(JSON.stringify(restored).includes(secretFile.split('=')[1].split('\n')[0]), false);
  assert.equal(readdirSync(f.outputDir).some((name) => name.startsWith('.workbench-backup-')), false);
});

test('E-32: missing or changed original attachments cannot produce a successful backup', async (t) => {
  const f = fixture(t);
  rmSync(f.attachmentPath);
  await assert.rejects(backupWorkbench(f.options), /ENOENT/);
  assert.deepEqual(readdirSync(f.outputDir), []);
  writeFileSync(f.attachmentPath, 'changed data');
  await assert.rejects(backupWorkbench(f.options), /HASH_OR_SIZE|OVERSIZED|SIZE_CHANGED/);
  assert.deepEqual(readdirSync(f.outputDir), []);
});

test('E-32: actual CSV API bytes, BOM/CRLF, old JSON scope and private permissions survive encrypted recovery', async (t) => {
  const f = fixture(t, { auth: false }), sourceDb = new Database(f.dbPath);
  const old = sourceDb.prepare('SELECT * FROM attachments').get();
  sourceDb.prepare(`INSERT INTO audit_events(id,actor_id,action,object_type,object_id,portfolio_id,payload_json,created_at)
    VALUES('old-json-scope','owner','store_attachment','attachment',?,'p',?,?)`).run(old.id, JSON.stringify({ account_id: 'a', content_hash: old.content_hash, byte_size: old.byte_size }), now);
  sourceDb.exec(`INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES('b','p','B','Synthetic','CNY','${now}');
    INSERT INTO portfolios(id,name,created_at) VALUES('q','Other synthetic','${now}');
    INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES('c','q','C','Synthetic','CNY','${now}');`);
  sourceDb.close();
  const bytes = Buffer.from('\ufeffdate,amount,note\r\n2026-01-01,1000000.000000000000000001,"quoted, private \u4e2d\u6587"\r\n', 'utf8');
  const attachment = attachmentApi({ action: 'store', dbPath: f.dbPath, dataDir: f.dataDir, base64: bytes.toString('base64') });
  assert.equal(attachment.media_type, 'text/csv');
  assert.equal(attachment.storage_key, `attachments/${createHash('sha256').update(bytes).digest('hex')}.csv`);
  const sourcePath = join(f.dataDir, attachment.storage_key), hashBefore = await sha256File(f.dbPath);
  assert.deepEqual(readFileSync(sourcePath), bytes);
  assert.equal(statSync(sourcePath).mode & 0o777, 0o600);
  const result = await backupWorkbench(f.options);
  assert.equal(result.attachment_count, 2);
  assert.equal(await sha256File(f.dbPath), hashBefore);
  assert.deepEqual(readFileSync(sourcePath), bytes);
  const target = join(f.directory, 'csv-restored');
  const restored = await restoreWorkbench({ archivePath: result.path, targetDir: target, passphrase });
  const recovered = new Database(restored.database_path, { readonly: true });
  const source = new Database(f.dbPath, { readonly: true });
  try {
    assert.deepEqual(recovered.prepare('SELECT * FROM attachments ORDER BY id').all(), source.prepare('SELECT * FROM attachments ORDER BY id').all());
    assert.deepEqual(recovered.prepare("SELECT * FROM audit_events WHERE action='store_attachment' ORDER BY id").all(), source.prepare("SELECT * FROM audit_events WHERE action='store_attachment' ORDER BY id").all());
  } finally { recovered.close(); source.close(); }
  assert.deepEqual(readFileSync(join(target, attachment.storage_key)), bytes);
  assert.equal(await sha256File(join(target, attachment.storage_key)), attachment.content_hash);
  assert.equal(statSync(join(target, attachment.storage_key)).mode & 0o777, 0o600);
  assert.equal(statSync(join(target, 'attachments')).mode & 0o777, 0o700);
  const checked = attachmentApi({ action: 'read', dbPath: restored.database_path, dataDir: target, id: attachment.id });
  assert.deepEqual(Buffer.from(checked.csv, 'base64'), bytes);
  assert.deepEqual(Buffer.from(checked.json, 'base64'), readFileSync(f.attachmentPath));
  assert.deepEqual(checked.blocked, [['other-account', 'ATTACHMENT_OUT_OF_SCOPE'], ['other-portfolio', 'ATTACHMENT_OUT_OF_SCOPE'], ['wrong-media-reader', 'INVALID_ATTACHMENT_METADATA']]);
  assert.ok(existsSync(join(target, 'RESTORE_PENDING_REVIEW')));
});

test('E-24/E-32: attachment names are fixed hash JSON/CSV or a distinct legacy archive', () => {
  const hash = 'a'.repeat(64);
  for (const name of [`attachments/${hash}.json`, `attachments/${hash}.csv`, `attachments/legacy-${hash}.sqlite`]) assert.equal(safeAttachment(name), true);
  for (const name of [`attachments/${hash}.html`, `attachments/${hash}.json.csv`, `attachments/${hash}.CSV`,
    `attachments/nested/${hash}.csv`, `attachments/${hash}.sqlite`, `attachments/legacy-${hash}.json`,
    `attachments/${hash.toUpperCase()}.csv`, `attachments/../${hash}.json`]) assert.equal(safeAttachment(name), false, name);
});

test('E-32: backup rejects media/suffix/hash disguise and unreferenced legacy attachments', async (t) => {
  for (const [name, values] of [
    ['csv-disguised-as-json', { media_type: 'text/csv' }],
    ['unknown-media', { media_type: 'text/html' }],
    ['charset-not-canonical', { media_type: 'application/json; charset=utf-8' }],
    ['wrong-hash-name', { storage_key: `attachments/${'f'.repeat(64)}.json` }],
    ['double-suffix', { storage_key: `attachments/${'f'.repeat(64)}.csv.json` }],
    ['unreferenced-legacy', { legacy: true }],
  ]) {
    await t.test(name, async (t) => {
      const f = fixture(t, { auth: false }), db = new Database(f.dbPath);
      const attachment = db.prepare('SELECT * FROM attachments').get();
      if (values.legacy) db.prepare('UPDATE attachments SET id=?,media_type=?,storage_key=?').run(`legacy-${attachment.content_hash}`, 'application/vnd.sqlite3', `attachments/legacy-${attachment.content_hash}.sqlite`);
      else for (const [key, value] of Object.entries(values)) db.prepare(`UPDATE attachments SET ${key}=?`).run(value);
      db.close();
      await assert.rejects(backupWorkbench(f.options), /INVALID_ATTACHMENT_METADATA|LEGACY_ATTACHMENT_REFERENCE_REQUIRED/);
      assert.deepEqual(readdirSync(f.outputDir), []);
    });
  }
});

test('E-24/E-32: symlink attachments and legacy databases are not followed', async (t) => {
  const f = fixture(t);
  const original = readFileSync(f.attachmentPath), other = join(f.directory, 'unrelated-private-fixture.json');
  writeFileSync(other, original); rmSync(f.attachmentPath); symlinkSync(other, f.attachmentPath);
  await assert.rejects(backupWorkbench(f.options), /SYMLINK/);
  const old = join(f.directory, 'observatory.db'); writeFileSync(old, 'legacy fixture');
  await assert.rejects(backupWorkbench({ ...f.options, dbPath: old }), /LEGACY_DATABASE/);
  assert.equal(readFileSync(other, 'utf8'), original.toString('utf8'));
  assert.equal(readFileSync(old, 'utf8'), 'legacy fixture');
});

test('E-32: corrupt/truncated ciphertext and wrong secret fail before extraction, leave no target', async (t) => {
  const f = fixture(t), result = await backupWorkbench(f.options);
  const encrypted = readFileSync(result.path);
  const corrupted = Buffer.from(encrypted); corrupted[HEADER_SIZE + 128] ^= 0x01;
  const cases = [
    ['corrupt', corrupted, passphrase], ['truncated', encrypted.subarray(0, encrypted.length - 8), passphrase],
    ['wrong-secret', encrypted, `${passphrase}-wrong`],
  ];
  for (const [name, bytes, secret] of cases) {
    const archive = join(f.directory, `${name}.backup`), target = join(f.directory, name);
    writeFileSync(archive, bytes);
    await assert.rejects(restoreWorkbench({ archivePath: archive, targetDir: target, passphrase: secret }), /AUTHENTICATION_FAILED/);
    assert.equal(existsSync(target), false);
  }
  assert.equal(readdirSync(f.directory).some((name) => name.startsWith('.workbench-restore-')), false);
});

test('E-32: existing recovery target and newer financial facts are never overwritten', async (t) => {
  const f = fixture(t), result = await backupWorkbench(f.options);
  const existing = join(f.directory, 'existing'); mkdirSync(existing);
  writeFileSync(join(existing, 'etf-workbench.db'), 'newer irreversible financial facts');
  const before = await sha256File(join(existing, 'etf-workbench.db'));
  await assert.rejects(restoreWorkbench({ archivePath: result.path, targetDir: existing, passphrase }), /ALREADY_EXISTS/);
  assert.equal(await sha256File(join(existing, 'etf-workbench.db')), before);
  await assert.rejects(restoreWorkbench({ archivePath: result.path, targetDir: f.dataDir, passphrase }), /ALREADY_EXISTS/);
  const restored = join(f.directory, 'restored');
  await restoreWorkbench({ archivePath: result.path, targetDir: restored, passphrase });
  await assert.rejects(restoreWorkbench({ archivePath: result.path, targetDir: restored, passphrase }), /ALREADY_EXISTS/);
});

async function maliciousArchive(f, entries, alterManifest = (value) => value) {
  const db = new Database(f.dbPath, { readonly: true });
  let snapshot;
  try { snapshot = inspectSnapshot(db); } finally { db.close(); }
  const manifest = alterManifest({
    format: 'etf-workbench-backup-v1', backup_id: 'malicious-fixture', app_ref: 'test', snapshot_completed_at: now,
    ...snapshot, auth_included: false,
    files: [{ path: 'etf-workbench.db', role: 'database', bytes: statSync(f.dbPath).size, sha256: await sha256File(f.dbPath) }],
  });
  const archive = join(f.directory, `malicious-${Math.random().toString(16).slice(2)}.backup`);
  const pack = tar.pack(), encryption = encryptTar(pack, archive, passphrase);
  pack.entry({ name: 'manifest.json' }, JSON.stringify(manifest));
  for (const entry of entries) pack.entry(entry.header, entry.body ?? '');
  pack.finalize(); await encryption;
  return archive;
}

test('E-24/E-32: even authenticated malicious archives reject traversal, links, missing files and oversized declarations', async (t) => {
  const f = fixture(t, { attachment: false, auth: false });
  for (const [label, entries] of [
    ['traversal', [{ header: { name: '../escape', type: 'file' }, body: 'x' }]],
    ['symlink', [{ header: { name: 'etf-workbench.db', type: 'symlink', linkname: '../escape' } }]],
    ['hardlink', [{ header: { name: 'etf-workbench.db', type: 'link', linkname: '../escape' } }]],
    ['missing', []],
  ]) {
    const archive = await maliciousArchive(f, entries), targetDir = join(f.directory, label);
    await assert.rejects(restoreWorkbench({ archivePath: archive, targetDir, passphrase }), /UNSAFE|UNEXPECTED|MISSING/);
    assert.equal(existsSync(targetDir), false);
  }
  const oversized = await maliciousArchive(f, [], (manifest) => ({ ...manifest, files: [{ ...manifest.files[0], bytes: LIMITS.database + 1 }] }));
  await assert.rejects(restoreWorkbench({ archivePath: oversized, targetDir: join(f.directory, 'oversized'), passphrase }), /UNSAFE_MANIFEST/);
  assert.equal(existsSync(join(f.directory, 'escape')), false);
});

test('E-24/E-32: authenticated manifests cannot disguise CSV media, arbitrary suffixes or duplicate identities', async (t) => {
  const f = fixture(t, { attachment: false, auth: false }), hash = 'c'.repeat(64);
  for (const defect of ['wrong-media', 'wrong-suffix', 'duplicate-id', 'wrong-file-binding']) {
    const archive = await maliciousArchive(f, [], (manifest) => {
      const attachment = { id: 'csv-fixture', content_hash: hash, byte_size: 1, media_type: 'text/csv', storage_key: `attachments/${hash}.csv` };
      if (defect === 'wrong-media') attachment.media_type = 'application/json';
      if (defect === 'wrong-suffix') attachment.storage_key = `attachments/${hash}.html`;
      manifest.attachments.push(attachment);
      manifest.files.push({ path: attachment.storage_key, role: 'attachment', bytes: 1, sha256: hash, attachment_id: defect === 'wrong-file-binding' ? 'another-id' : attachment.id });
      if (defect === 'duplicate-id') {
        manifest.attachments.push({ ...attachment, media_type: 'application/json', storage_key: `attachments/${hash}.json` });
        manifest.files.push({ ...manifest.files[1], path: `attachments/${hash}.json` });
      }
      return manifest;
    });
    const targetDir = join(f.directory, defect);
    await assert.rejects(restoreWorkbench({ archivePath: archive, targetDir, passphrase }), /INVALID_ATTACHMENT_METADATA|UNSAFE_MANIFEST_FILE|ATTACHMENT_LEDGER_MANIFEST_MISMATCH/);
    assert.equal(existsSync(targetDir), false);
  }
});

test('E-32: WAL writes during online backup restore a complete committed ledger head, never a torn transaction', async (t) => {
  const f = fixture(t, { attachment: false, auth: false });
  const writer = new Database(f.dbPath);
  writer.pragma('journal_mode = WAL'); writer.pragma('synchronous = FULL');
  const padding = JSON.stringify({ fixture: 'x'.repeat(512 * 1024) });
  const insertPlan = writer.prepare('INSERT INTO funding_plan_versions(id,portfolio_id,version,plan_json,content_hash,actor_id,created_at) VALUES (?,?,?,?,?,?,?)');
  writer.transaction(() => { for (let n = 1; n <= 24; n++) insertPlan.run(`plan-${n}`, 'p', n, padding, 'a'.repeat(64), 'test', now); })();
  const append = writer.transaction((n) => {
    writer.prepare(`INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,recorded_at,source_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(`tail-${n}`, 'p', 'a', 'deposit', now, now, 'fixture', `tail-key-${n}`, 'b'.repeat(64), '{}', n + 1, 'owner');
    writer.prepare('INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES (?,?,?,?,?,?)').run(`tail-cash-${n}`, `tail-${n}`, 'a', 'CNY', 'cash_settled', '1');
    writer.prepare('INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES (?,?,?,?,?,?)').run(`tail-capital-${n}`, `tail-${n}`, 'a', 'CNY', 'external_capital', '-1');
    writer.prepare('UPDATE ledger_heads SET revision=? WHERE portfolio_id=?').run(n + 1, 'p');
  });
  let writes = 0;
  const timer = setInterval(() => { append(++writes); if (writes === 5) clearInterval(timer); }, 1);
  let result;
  try { result = await backupWorkbench(f.options); }
  finally { clearInterval(timer); writer.close(); }
  assert.ok(writes > 0, 'the concurrent writer actually ran');
  const restored = await restoreWorkbench({ archivePath: result.path, targetDir: join(f.directory, 'concurrent-restored'), passphrase });
  const db = new Database(restored.database_path, { readonly: true });
  try {
    const head = db.prepare("SELECT revision FROM ledger_heads WHERE portfolio_id='p'").get().revision;
    assert.equal(db.prepare('SELECT MAX(ledger_revision) AS n FROM ledger_events').get().n, head);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_events').get().n, head);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM postings').get().n, 2 * head);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM funding_plan_versions').get().n, 24);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});
