import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt as scryptCallback } from 'node:crypto';
import { constants, createReadStream, createWriteStream, appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyWorkbenchSchema } from './migrate-workbench.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'web/package.json'));
export const Database = require('better-sqlite3');
export const tar = require('tar-stream');
const scrypt = promisify(scryptCallback);
export const MAGIC = Buffer.from('ETFWBK1\n');
export const HEADER_SIZE = MAGIC.length + 16 + 12;
export const TAG_SIZE = 16;
export const LIMITS = Object.freeze({ archive: 32 * 1024 ** 3, database: 16 * 1024 ** 3, attachment: 256 * 1024 ** 2, manifest: 32 * 1024 ** 2, files: 100000 });

export function error(code) { return new Error(code); }
export function assertAbsolute(value, code = 'ABSOLUTE_PATH_REQUIRED') {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw error(code);
  return resolve(value);
}
export function safeMember(name) {
  return typeof name === 'string' && name.length <= 240 && !name.includes('\\') && !name.includes('\0')
    && name.split('/').every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== '.' && part !== '..');
}
export function safeAttachment(name) {
  return typeof name === 'string' && /^attachments\/(?:[a-f0-9]{64}\.(?:json|csv)|legacy-[a-f0-9]{64}\.sqlite)$/.test(name);
}
export function attachmentKind(attachment) {
  if (!attachment || typeof attachment.id !== 'string' || !attachment.id.length
    || !/^[a-f0-9]{64}$/.test(attachment.content_hash ?? '') || !Number.isSafeInteger(attachment.byte_size)
    || attachment.byte_size < 0 || attachment.byte_size > LIMITS.attachment) throw error('INVALID_ATTACHMENT_METADATA');
  const hash = attachment.content_hash;
  if (attachment.media_type === 'application/json' && attachment.storage_key === `attachments/${hash}.json`) return 'json';
  if (attachment.media_type === 'text/csv' && attachment.storage_key === `attachments/${hash}.csv`) return 'csv';
  if (attachment.media_type === 'application/vnd.sqlite3' && attachment.id === `legacy-${hash}`
    && attachment.storage_key === `attachments/legacy-${hash}.sqlite`) return 'legacy';
  throw error('INVALID_ATTACHMENT_METADATA');
}
export function regularFile(path, limit = LIMITS.archive) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size > limit) throw error('UNSAFE_OR_OVERSIZED_FILE');
  return stat;
}
export function insideFile(directory, member, limit = LIMITS.attachment) {
  if (!safeAttachment(member)) throw error('INVALID_ATTACHMENT_STORAGE_KEY');
  const realRoot = realpathSync(directory), path = join(realRoot, member);
  let current = realRoot;
  for (const part of member.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw error('SYMLINK_NOT_ALLOWED');
  }
  if (relative(realRoot, realpathSync(path)).startsWith('..')) throw error('ATTACHMENT_OUTSIDE_DATA_DIRECTORY');
  regularFile(path, limit);
  return path;
}
export function syncFile(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) hash.update(chunk);
  return hash.digest('hex');
}
export async function copyVerified(source, destination, expected) {
  regularFile(source, expected.bytes);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const hash = createHash('sha256');
  let size = 0;
  const inspect = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > expected.bytes) return callback(error('FILE_SIZE_CHANGED'));
    hash.update(chunk); callback(null, chunk);
  } });
  await pipeline(createReadStream(source, { flags: constants.O_RDONLY | constants.O_NOFOLLOW }), inspect, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  if (size !== expected.bytes || hash.digest('hex') !== expected.sha256) throw error('FILE_HASH_OR_SIZE_MISMATCH');
  syncFile(destination);
}
export async function readPassphrase(env = process.env) {
  const methods = [env.WORKBENCH_BACKUP_PASSPHRASE !== undefined, Boolean(env.WORKBENCH_BACKUP_PASSPHRASE_FILE), env.WORKBENCH_BACKUP_SECRET_STDIN === '1'];
  if (methods.filter(Boolean).length !== 1) throw error('EXACTLY_ONE_BACKUP_SECRET_SOURCE_REQUIRED');
  let secret;
  if (methods[0]) secret = env.WORKBENCH_BACKUP_PASSPHRASE;
  else if (methods[1]) {
    const path = assertAbsolute(env.WORKBENCH_BACKUP_PASSPHRASE_FILE);
    const stat = regularFile(path, 2048);
    if ((stat.mode & 0o077) !== 0) throw error('SECRET_FILE_PERMISSIONS_MUST_BE_0600');
    secret = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  } else {
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 2048) throw error('BACKUP_SECRET_TOO_LARGE'); chunks.push(chunk); }
    secret = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  validatePassphrase(secret);
  return secret;
}
function validatePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 32 || Buffer.byteLength(passphrase) > 1024) throw error('BACKUP_PASSPHRASE_LENGTH');
}
async function deriveKey(passphrase, salt) {
  validatePassphrase(passphrase);
  return scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export async function encryptTar(readable, destination, passphrase) {
  const salt = randomBytes(16), nonce = randomBytes(12), header = Buffer.concat([MAGIC, salt, nonce]);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_SIZE });
  cipher.setAAD(header);
  writeFileSync(destination, header, { flag: 'wx', mode: 0o600 });
  let bytes = 0;
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > LIMITS.archive ? error('ARCHIVE_TOO_LARGE') : null, chunk);
  } });
  try {
    await pipeline(readable, limit, cipher, createWriteStream(destination, { flags: 'a', mode: 0o600 }));
    appendFileSync(destination, cipher.getAuthTag());
    syncFile(destination);
  } finally { key.fill(0); }
}

// GCM plaintext is written only to a private staging file; callers must await
// authentication before passing that file to a TAR parser.
export async function decryptTar(source, destination, passphrase) {
  const stat = regularFile(source, LIMITS.archive + HEADER_SIZE + TAG_SIZE);
  if (stat.size <= HEADER_SIZE + TAG_SIZE) throw error('INVALID_ENCRYPTED_BACKUP');
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let header, tag;
  try {
    const { readSync } = await import('node:fs');
    header = Buffer.alloc(HEADER_SIZE); tag = Buffer.alloc(TAG_SIZE);
    if (readSync(fd, header, 0, header.length, 0) !== header.length || readSync(fd, tag, 0, tag.length, stat.size - TAG_SIZE) !== tag.length || !header.subarray(0, MAGIC.length).equals(MAGIC)) throw error('INVALID_ENCRYPTED_BACKUP');
  } finally { closeSync(fd); }
  const key = await deriveKey(passphrase, header.subarray(MAGIC.length, MAGIC.length + 16));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length + 16), { authTagLength: TAG_SIZE });
    decipher.setAAD(header); decipher.setAuthTag(tag);
    await pipeline(createReadStream(source, { start: HEADER_SIZE, end: stat.size - TAG_SIZE - 1, flags: constants.O_RDONLY | constants.O_NOFOLLOW }), decipher, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    syncFile(destination);
  } catch {
    rmSync(destination, { force: true });
    throw error('BACKUP_AUTHENTICATION_FAILED');
  } finally { key.fill(0); }
}

export function inspectSnapshot(db) {
  const schema = verifyWorkbenchSchema(db);
  if (db.pragma('quick_check', { simple: true }) !== 'ok') throw error('DATABASE_QUICK_CHECK_FAILED');
  const attachments = db.prepare('SELECT id,content_hash,byte_size,media_type,storage_key FROM attachments ORDER BY id').all();
  for (const attachment of attachments) {
    if (attachmentKind(attachment) !== 'legacy') continue;
    // Legacy SQLite is an existing dedicated archive format, not a user upload.
    const referenced = db.prepare('SELECT provenance_json FROM legacy_archives WHERE source_database_hash=?').all(attachment.content_hash).some((row) => {
      try { const evidence = JSON.parse(row.provenance_json); return evidence?.environment === 'legacy' && evidence?.source_archive === attachment.id; }
      catch { return false; }
    });
    if (!referenced) throw error('LEGACY_ATTACHMENT_REFERENCE_REQUIRED');
  }
  return {
    schema,
    ledger_heads: db.prepare('SELECT portfolio_id,revision,updated_at FROM ledger_heads ORDER BY portfolio_id').all(),
    market_publications: db.prepare('SELECT scope,batch_id,manifest_hash,revision,published_at FROM market_publications ORDER BY scope').all(),
    attachments,
  };
}
export function validateAuthDatabase(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  if (JSON.stringify(tables) !== JSON.stringify(['login_limits', 'sessions'])) throw error('UNSUPPORTED_AUTH_DATABASE');
  const columns = db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name);
  if (JSON.stringify(columns) !== JSON.stringify(['token_hash', 'config_version', 'created_at', 'expires_at', 'revoked_at'])) throw error('UNSUPPORTED_AUTH_DATABASE');
  if (db.pragma('quick_check', { simple: true }) !== 'ok') throw error('AUTH_DATABASE_QUICK_CHECK_FAILED');
}

async function packEncrypted(directory, files, destination, passphrase) {
  const pack = tar.pack();
  let encryptionError;
  const encryption = encryptTar(pack, destination, passphrase).catch((cause) => { encryptionError = cause; pack.destroy(cause); });
  try {
    for (const file of files) {
      const path = join(directory, file.path), stat = regularFile(path, LIMITS.database);
      const entry = pack.entry({ name: file.path, size: stat.size, type: 'file', mode: 0o600, uid: 0, gid: 0, mtime: new Date(0) });
      await pipeline(createReadStream(path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW }), entry);
    }
    pack.finalize();
    await encryption;
    if (encryptionError) throw encryptionError;
  } catch (cause) { pack.destroy(cause); await encryption; throw cause; }
}

export async function backupWorkbench({ dbPath, dataDir, outputDir, passphrase, appRef, replicaDir, now = () => new Date().toISOString() }) {
  validatePassphrase(passphrase);
  dbPath = assertAbsolute(dbPath); dataDir = assertAbsolute(dataDir); outputDir = assertAbsolute(outputDir);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(appRef ?? '')) throw error('EXPLICIT_APPLICATION_REFERENCE_REQUIRED');
  regularFile(dbPath, LIMITS.database);
  if (basename(realpathSync(dbPath)).toLowerCase() === 'observatory.db') throw error('LEGACY_DATABASE_BACKUP_REFUSED');
  if (!lstatSync(dataDir).isDirectory() || lstatSync(dataDir).isSymbolicLink()) throw error('INVALID_DATA_DIRECTORY');
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(outputDir, '.workbench-backup-'));
  const id = randomUUID(), destination = join(outputDir, `workbench-${id}.etfbackup`);
  const encrypted = join(staging, 'encrypted.tmp'), payload = join(staging, 'payload');
  mkdirSync(payload, { mode: 0o700 });
  try {
    const startedAt = now(), snapshotPath = join(payload, 'etf-workbench.db');
    const source = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { verifyWorkbenchSchema(source); await source.backup(snapshotPath); } finally { source.close(); }
    const completedAt = now();
    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    let state;
    try { state = inspectSnapshot(snapshot); } finally { snapshot.close(); }
    const files = [{ path: 'etf-workbench.db', role: 'database', bytes: regularFile(snapshotPath, LIMITS.database).size, sha256: await sha256File(snapshotPath) }];
    if (state.attachments.length > LIMITS.files - 3) throw error('TOO_MANY_ATTACHMENTS');
    for (const attachment of state.attachments) {
      const sourceFile = insideFile(dataDir, attachment.storage_key);
      const file = { path: attachment.storage_key, role: 'attachment', bytes: attachment.byte_size, sha256: attachment.content_hash, attachment_id: attachment.id };
      await copyVerified(sourceFile, join(payload, file.path), file); files.push(file);
    }
    const authPath = join(dataDir, 'auth.sqlite');
    let authIncluded = false;
    if (existsSync(authPath)) {
      regularFile(authPath, LIMITS.attachment);
      const auth = new Database(authPath, { readonly: true, fileMustExist: true });
      try { validateAuthDatabase(auth); await auth.backup(join(payload, 'auth.sqlite')); } finally { auth.close(); }
      files.push({ path: 'auth.sqlite', role: 'auth', bytes: regularFile(join(payload, 'auth.sqlite'), LIMITS.attachment).size, sha256: await sha256File(join(payload, 'auth.sqlite')) });
      authIncluded = true;
    }
    const manifest = {
      format: 'etf-workbench-backup-v1', backup_id: id, app_ref: appRef,
      snapshot_started_at: startedAt, snapshot_completed_at: completedAt,
      schema: state.schema, ledger_heads: state.ledger_heads, market_publications: state.market_publications,
      attachments: state.attachments, files, auth_included: authIncluded,
      authentication_restore_policy: 'revoke_all_sessions_and_generate_new_session_secret',
      encryption: 'AES-256-GCM; scrypt N=32768 r=8 p=1; random 16-byte salt and 12-byte nonce',
    };
    const raw = JSON.stringify(manifest, null, 2) + '\n';
    if (Buffer.byteLength(raw) > LIMITS.manifest) throw error('MANIFEST_TOO_LARGE');
    writeFileSync(join(payload, 'manifest.json'), raw, { flag: 'wx', mode: 0o600 });
    await packEncrypted(payload, [{ path: 'manifest.json' }, ...files], encrypted, passphrase);
    renameSync(encrypted, destination); syncDirectory(outputDir);
    const encryptedHash = await sha256File(destination);
    let replica = { status: 'not_configured', independent_failure_domain_verified: false };
    if (replicaDir) {
      replicaDir = assertAbsolute(replicaDir);
      mkdirSync(replicaDir, { recursive: true, mode: 0o700 });
      if (realpathSync(replicaDir) === realpathSync(outputDir)) throw error('REPLICA_DIRECTORY_MUST_DIFFER');
      const replicaPath = join(replicaDir, basename(destination)), temporary = join(replicaDir, `.${id}.tmp`);
      try {
        await copyVerified(destination, temporary, { bytes: statSync(destination).size, sha256: encryptedHash });
        renameSync(temporary, replicaPath); syncDirectory(replicaDir);
        replica = { status: 'verified_copy', path: replicaPath, independent_failure_domain_verified: false };
      } catch { rmSync(temporary, { force: true }); throw error(`REPLICA_COPY_FAILED_LOCAL_ARTIFACT_RETAINED:${destination}`); }
    }
    return { path: destination, sha256: encryptedHash, bytes: statSync(destination).size, backup_id: id, schema_version: state.schema.version, snapshot_completed_at: completedAt, attachment_count: state.attachments.length, replica };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw error('BACKUP_ARGUMENTS_FORBIDDEN_USE_ENVIRONMENT');
    const result = await backupWorkbench({ dbPath: process.env.WORKBENCH_DB_PATH, dataDir: process.env.WORKBENCH_DATA_DIR, outputDir: process.env.WORKBENCH_BACKUP_DIR, passphrase: await readPassphrase(), appRef: process.env.WORKBENCH_RELEASE_REF, replicaDir: process.env.WORKBENCH_BACKUP_REPLICA_DIR });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (cause) { process.stderr.write(`${cause instanceof Error ? cause.message : 'BACKUP_FAILED'}\n`); process.exitCode = 1; }
}
