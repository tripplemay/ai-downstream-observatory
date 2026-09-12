import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, createReadStream, createWriteStream, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { Database, LIMITS, assertAbsolute, attachmentKind, decryptTar, error, inspectSnapshot, readPassphrase, regularFile, safeAttachment, sha256File, syncDirectory, syncFile, tar, validateAuthDatabase } from './backup-workbench.mjs';

function validateManifest(manifest) {
  if (!manifest || manifest.format !== 'etf-workbench-backup-v1' || typeof manifest.backup_id !== 'string'
    || typeof manifest.app_ref !== 'string' || !Array.isArray(manifest.files) || manifest.files.length > LIMITS.files
    || !Array.isArray(manifest.attachments) || !Array.isArray(manifest.ledger_heads) || !Array.isArray(manifest.market_publications)
    || !manifest.schema || !Number.isSafeInteger(manifest.schema.version) || typeof manifest.auth_included !== 'boolean'
    || !Number.isFinite(Date.parse(manifest.snapshot_completed_at))) throw error('INVALID_BACKUP_MANIFEST');
  const files = new Map(); let total = 0;
  for (const file of manifest.files) {
    if (!file || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || files.has(file.path)) throw error('INVALID_MANIFEST_FILE');
    const allowed = file.role === 'database' && file.path === 'etf-workbench.db' && file.bytes <= LIMITS.database
      || file.role === 'auth' && file.path === 'auth.sqlite' && file.bytes <= LIMITS.attachment
      || file.role === 'attachment' && safeAttachment(file.path) && file.bytes <= LIMITS.attachment;
    if (!allowed || (total += file.bytes) > LIMITS.archive) throw error('UNSAFE_MANIFEST_FILE');
    files.set(file.path, file);
  }
  if (!files.has('etf-workbench.db') || files.has('auth.sqlite') !== manifest.auth_included) throw error('MANIFEST_DATABASE_MISSING');
  if (manifest.attachments.length !== [...files.values()].filter((file) => file.role === 'attachment').length) throw error('MANIFEST_ATTACHMENT_COUNT_MISMATCH');
  const ids = new Set(), paths = new Set();
  for (const attachment of manifest.attachments) {
    attachmentKind(attachment);
    const file = files.get(attachment.storage_key);
    if (ids.has(attachment.id) || paths.has(attachment.storage_key) || !file || file.role !== 'attachment'
      || file.attachment_id !== attachment.id || file.bytes !== attachment.byte_size || file.sha256 !== attachment.content_hash) throw error('ATTACHMENT_LEDGER_MANIFEST_MISMATCH');
    ids.add(attachment.id); paths.add(attachment.storage_key);
  }
  return files;
}

async function extractAuthenticatedTar(archive, destination) {
  const extract = tar.extract();
  let manifest, expected;
  const seen = new Set();
  extract.on('entry', (header, stream, next) => {
    (async () => {
      if (header.type !== 'file' || header.linkname || !Number.isSafeInteger(header.size) || header.size < 0 || seen.has(header.name)) throw error('UNSAFE_OR_DUPLICATE_ARCHIVE_ENTRY');
      seen.add(header.name);
      if (!manifest) {
        if (header.name !== 'manifest.json' || header.size > LIMITS.manifest) throw error('MANIFEST_MUST_BE_FIRST');
        const chunks = []; let bytes = 0;
        for await (const chunk of stream) { bytes += chunk.length; if (bytes > LIMITS.manifest) throw error('MANIFEST_TOO_LARGE'); chunks.push(chunk); }
        try { manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw error('INVALID_BACKUP_MANIFEST'); }
        expected = validateManifest(manifest);
        writeFileSync(join(destination, 'backup-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        return;
      }
      const file = expected.get(header.name);
      if (!file || header.size !== file.bytes) throw error('UNEXPECTED_OR_MISMATCHED_ARCHIVE_ENTRY');
      const path = join(destination, file.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const hash = createHash('sha256'); let bytes = 0;
      const inspect = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > file.bytes) return callback(error('ARCHIVE_ENTRY_TOO_LARGE'));
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(stream, inspect, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
      if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw error('RESTORED_FILE_HASH_MISMATCH');
      syncFile(path);
    })().then(() => next(), (cause) => next(cause));
  });
  await pipeline(createReadStream(archive), extract);
  if (!manifest || seen.size !== expected.size + 1 || [...expected.keys()].some((name) => !seen.has(name))) throw error('ARCHIVE_FILES_MISSING');
  return manifest;
}

function verifyRestoredDatabase(directory, manifest) {
  const db = new Database(join(directory, 'etf-workbench.db'), { readonly: true, fileMustExist: true });
  let state;
  try { state = inspectSnapshot(db); } finally { db.close(); }
  for (const field of ['schema', 'ledger_heads', 'market_publications', 'attachments']) {
    if (JSON.stringify(state[field]) !== JSON.stringify(manifest[field])) throw error(`SNAPSHOT_MANIFEST_MISMATCH:${field}`);
  }
  const files = new Map(manifest.files.map((file) => [file.path, file]));
  for (const attachment of state.attachments) {
    const file = files.get(attachment.storage_key);
    if (!file || file.role !== 'attachment' || file.attachment_id !== attachment.id || file.bytes !== attachment.byte_size || file.sha256 !== attachment.content_hash) throw error('ATTACHMENT_LEDGER_MANIFEST_MISMATCH');
  }
  if (manifest.auth_included) {
    const auth = new Database(join(directory, 'auth.sqlite'), { readonly: true, fileMustExist: true });
    try { validateAuthDatabase(auth); } finally { auth.close(); }
  }
  return state;
}

function resetAuthentication(directory) {
  const authPath = join(directory, 'auth.sqlite');
  // Credentials live outside this database. Recreate the small auth store so no
  // backed-up session, trigger or login-state page can accidentally survive.
  if (existsSync(authPath)) unlinkSync(authPath);
  const auth = new Database(authPath);
  try {
    auth.pragma('journal_mode = WAL'); auth.pragma('synchronous = FULL');
    auth.exec(`CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, config_version TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE login_limits (scope TEXT PRIMARY KEY, window_started INTEGER NOT NULL, attempts INTEGER NOT NULL);`);
    auth.pragma('wal_checkpoint(TRUNCATE)');
  } finally { auth.close(); }
  chmodSync(authPath, 0o600);
  writeFileSync(join(directory, 'recovery-session.env'), `WORKBENCH_SESSION_SECRET=${randomBytes(48).toString('base64url')}\nWORKBENCH_MODE=read_only\n`, { flag: 'wx', mode: 0o600 });
}

// Files are linked into an exclusively created destination. Unlike rename of a
// directory, this cannot replace even an empty target created by another actor.
function publishNewDirectory(source, target) {
  mkdirSync(target, { mode: 0o700 });
  const createdFiles = [], createdDirectories = [];
  const install = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const destination = join(target, name), original = join(source, name);
      if (entry.isDirectory()) { mkdirSync(destination, { mode: 0o700 }); createdDirectories.push(destination); install(original, name); }
      else if (entry.isFile()) { linkSync(original, destination); createdFiles.push(destination); }
      else throw error('UNSAFE_STAGED_FILE');
    }
  };
  try { install(source); syncDirectory(target); syncDirectory(dirname(target)); }
  catch (cause) {
    for (const path of createdFiles.reverse()) unlinkSync(path);
    for (const path of createdDirectories.reverse()) { try { rmdirSync(path); } catch {} }
    try { rmdirSync(target); } catch {}
    throw cause;
  }
}

export async function restoreWorkbench({ archivePath, targetDir, passphrase, incidentAt, now = () => new Date().toISOString() }) {
  const started = performance.now(), startedAt = now();
  archivePath = assertAbsolute(archivePath); targetDir = assertAbsolute(targetDir);
  regularFile(archivePath, LIMITS.archive + 64);
  // lstat also catches a dangling symlink that existsSync would otherwise miss.
  try { lstatSync(targetDir); throw error('RESTORE_TARGET_ALREADY_EXISTS'); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  mkdirSync(dirname(targetDir), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(targetDir), '.workbench-restore-'));
  const plaintext = join(staging, 'authenticated.tar'), payload = join(staging, 'payload');
  mkdirSync(payload, { mode: 0o700 });
  try {
    await decryptTar(archivePath, plaintext, passphrase);
    const manifest = await extractAuthenticatedTar(plaintext, payload);
    const state = verifyRestoredDatabase(payload, manifest);
    resetAuthentication(payload);
    const verifiedAt = now();
    let rpoSeconds = null;
    if (incidentAt !== undefined) {
      const incident = Date.parse(incidentAt), snapshot = Date.parse(manifest.snapshot_completed_at);
      if (!Number.isFinite(incident) || incident < snapshot) throw error('INVALID_RECOVERY_INCIDENT_TIME');
      rpoSeconds = (incident - snapshot) / 1000;
    }
    const report = {
      format: 'etf-workbench-recovery-v1', backup_id: manifest.backup_id, app_ref: manifest.app_ref,
      encrypted_archive_sha256: await sha256File(archivePath), schema: state.schema, ledger_heads: state.ledger_heads,
      snapshot_completed_at: manifest.snapshot_completed_at, restore_started_at: startedAt, restore_verified_at: verifiedAt,
      process_duration_ms: Math.ceil(performance.now() - started), incident_at: incidentAt ?? null, snapshot_age_at_incident_seconds: rpoSeconds,
      old_sessions_revoked: true, new_session_secret_generated: true, session_secret_applied_to_runtime: false, new_session_secret_file: 'recovery-session.env',
      auth_configuration_must_be_applied: true, operator_reconciliation_required: true, production_readiness: 'not_verified',
      independent_failure_domain_verified: false, attachment_count: state.attachments.length,
    };
    writeFileSync(join(payload, 'recovery-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(join(payload, 'RESTORE_PENDING_REVIEW'), JSON.stringify({ backup_id: manifest.backup_id, reason: 'Reconcile tail facts, apply the rotated session secret and explicitly approve recovery before enabling writes or investment advice.' }) + '\n', { flag: 'wx', mode: 0o600 });
    for (const name of ['auth.sqlite', 'recovery-session.env', 'recovery-report.json', 'RESTORE_PENDING_REVIEW', 'backup-manifest.json']) syncFile(join(payload, name));
    publishNewDirectory(payload, targetDir);
    return { target_dir: targetDir, database_path: join(targetDir, 'etf-workbench.db'), backup_id: manifest.backup_id, schema_version: state.schema.version, report_path: join(targetDir, 'recovery-report.json'), session_secret_file: join(targetDir, 'recovery-session.env'), pending_review: true, old_sessions_revoked: true, process_duration_ms: report.process_duration_ms };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw error('RESTORE_ARGUMENTS_FORBIDDEN_USE_ENVIRONMENT');
    const result = await restoreWorkbench({ archivePath: process.env.WORKBENCH_RESTORE_ARCHIVE, targetDir: process.env.WORKBENCH_RESTORE_TARGET_DIR, passphrase: await readPassphrase(), incidentAt: process.env.WORKBENCH_RECOVERY_INCIDENT_AT });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (cause) { process.stderr.write(`${cause instanceof Error ? cause.message : 'RESTORE_FAILED'}\n`); process.exitCode = 1; }
}
