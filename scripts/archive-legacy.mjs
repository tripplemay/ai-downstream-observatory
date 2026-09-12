import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database, LIMITS, assertAbsolute, copyVerified, insideFile, regularFile, sha256File, syncDirectory, syncFile } from './backup-workbench.mjs';
import { verifyWorkbenchSchema } from './migrate-workbench.mjs';

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
function encode(value) {
  if (typeof value === 'bigint') return { sqlite_integer: value.toString() };
  if (typeof value === 'number' && !Number.isFinite(value)) return { sqlite_real: String(value) };
  if (Buffer.isBuffer(value)) return { sqlite_blob_base64: value.toString('base64') };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  return value;
}
const digest = (value) => createHash('sha256').update(value).digest('hex');

export async function archiveLegacy({ sourcePath, archiveDir, dbPath, dataDir, appRef, sourceQuiesced = false, now = () => new Date().toISOString() }) {
  sourcePath = assertAbsolute(sourcePath); archiveDir = assertAbsolute(archiveDir);
  regularFile(sourcePath, LIMITS.database);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(appRef ?? '')) throw new Error('APPLICATION_REFERENCE_REQUIRED');
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(archiveDir, '.legacy-snapshot-'));
  try {
    let readableSource = sourcePath;
    if (sourceQuiesced) {
      // A closed WAL database on a read-only mount cannot create its -shm file.
      // Only after all original writers stop, stage every recovery file together.
      readableSource = join(temporary, 'quiesced.sqlite');
      const files = [];
      for (const suffix of ['', '-wal', '-journal']) {
        const path = `${sourcePath}${suffix}`;
        if (suffix && !existsSync(path)) continue;
        const bytes = regularFile(path, LIMITS.database).size, sha256 = await sha256File(path);
        files.push({ path, suffix, bytes, sha256 });
      }
      for (const file of files) await copyVerified(file.path, `${readableSource}${file.suffix}`, file);
      for (const file of files) if (regularFile(file.path, LIMITS.database).size !== file.bytes || await sha256File(file.path) !== file.sha256) throw new Error('QUIESCED_LEGACY_SOURCE_CHANGED');
      for (const suffix of ['-wal', '-journal']) if (existsSync(`${sourcePath}${suffix}`) !== files.some((file) => file.suffix === suffix)) throw new Error('QUIESCED_LEGACY_SOURCE_CHANGED');
    }
    const temporaryDb = join(temporary, 'legacy.sqlite'), source = new Database(readableSource, { readonly: !sourceQuiesced, fileMustExist: true });
    try {
      const tables = source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
      if (tables.includes('schema_migrations') || !tables.some((name) => ['themes','metrics','snapshots','signals','paper_accounts'].includes(name))) throw new Error('LEGACY_SOURCE_SCHEMA_NOT_RECOGNIZED');
      await source.backup(temporaryDb);
    } finally { source.close(); }
    chmodSync(temporaryDb, 0o600);
    syncFile(temporaryDb);
    const sourceHash = await sha256File(temporaryDb), archivePath = join(archiveDir, `${sourceHash}.sqlite`);
    if (!existsSync(archivePath)) linkSync(temporaryDb, archivePath);
    else if (await sha256File(archivePath) !== sourceHash) throw new Error('LEGACY_ARCHIVE_HASH_CONFLICT');
    const snapshot = new Database(archivePath, { readonly: true, fileMustExist: true });
    let target;
    try {
      if (snapshot.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('LEGACY_QUICK_CHECK_FAILED');
      const definitions = snapshot.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const tables = definitions.map((table) => ({ name: table.name, schema_hash: digest(table.sql ?? ''), rows: snapshot.prepare(`SELECT COUNT(*) AS n FROM ${quote(table.name)}`).get().n }));
      let imported = 0, reused = 0;
      if (dbPath !== undefined) {
        dbPath = assertAbsolute(dbPath); dataDir = assertAbsolute(dataDir);
        const assertWritable = () => {
          if (dbPath === sourcePath || [dataDir, dirname(dbPath)].some((directory) => existsSync(join(directory, 'RESTORE_PENDING_REVIEW')))) throw new Error('UNSAFE_LEGACY_IMPORT_TARGET');
        };
        assertWritable();
        target = new Database(dbPath, { fileMustExist: true });
        target.pragma('foreign_keys=ON'); target.pragma('busy_timeout=5000'); target.pragma('synchronous=FULL');
        verifyWorkbenchSchema(target);
        const archiveSize = statSync(archivePath).size;
        if (archiveSize > LIMITS.attachment) throw new Error('LEGACY_ARCHIVE_EXCEEDS_ATTACHMENT_LIMIT');
        const storageKey = `attachments/legacy-${sourceHash}.sqlite`, attachmentPath = join(dataDir, storageKey);
        const attachmentDir = join(dataDir, 'attachments');
        mkdirSync(attachmentDir, { recursive: true, mode: 0o700 });
        const directoryStat = lstatSync(attachmentDir);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077)) throw new Error('UNSAFE_LEGACY_ATTACHMENT_DIRECTORY');
        if (!existsSync(attachmentPath)) await copyVerified(archivePath, attachmentPath, { bytes: archiveSize, sha256: sourceHash });
        else if (await sha256File(insideFile(dataDir, storageKey)) !== sourceHash) throw new Error('LEGACY_ATTACHMENT_HASH_CONFLICT');
        if (regularFile(attachmentPath).mode & 0o077) throw new Error('UNSAFE_LEGACY_ATTACHMENT_PERMISSIONS');
        const timestamp = now(), beforeFacts = target.prepare('SELECT COUNT(*) AS n FROM ledger_events').get().n;
        target.transaction(() => {
          assertWritable();
          const attachmentId = `legacy-${sourceHash}`;
          target.prepare('INSERT INTO attachments(id,content_hash,media_type,byte_size,storage_key,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(attachmentId, sourceHash, 'application/vnd.sqlite3', archiveSize, storageKey, timestamp);
          const attachment = target.prepare('SELECT content_hash,byte_size,media_type,storage_key FROM attachments WHERE id=?').get(attachmentId);
          if (attachment.content_hash !== sourceHash || attachment.byte_size !== archiveSize || attachment.media_type !== 'application/vnd.sqlite3' || attachment.storage_key !== storageKey) throw new Error('LEGACY_ATTACHMENT_METADATA_CONFLICT');
          const insert = target.prepare('INSERT INTO legacy_archives(id,source_database_hash,source_table,source_key,source_row_json,content_hash,provenance_json,archived_at) VALUES(?,?,?,?,?,?,?,?)');
          const existing = target.prepare('SELECT content_hash FROM legacy_archives WHERE source_database_hash=? AND source_table=? AND source_key=?');
          for (const table of definitions) {
            const columns = snapshot.prepare(`PRAGMA table_info(${quote(table.name)})`).all();
            let alias = '__etf_archive_rowid__';
            while (columns.some((column) => column.name === alias)) alias = `_${alias}`;
            let statement, rowid = true;
            try { statement = snapshot.prepare(`SELECT rowid AS ${quote(alias)}, * FROM ${quote(table.name)} ORDER BY rowid`).safeIntegers(); }
            catch {
              rowid = false;
              const primary = columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
              if (!primary.length) throw new Error('LEGACY_TABLE_WITHOUT_STABLE_KEY');
              statement = snapshot.prepare(`SELECT * FROM ${quote(table.name)} ORDER BY ${primary.map((column) => quote(column.name)).join(',')}`).safeIntegers();
            }
            let ordinal = 0;
            for (const row of statement.iterate()) {
              const sourceKey = rowid ? `rowid:${row[alias]}` : `ordered-primary-key:${++ordinal}`;
              if (rowid) delete row[alias];
              const raw = JSON.stringify(encode(row)), contentHash = digest(raw), old = existing.get(sourceHash, table.name, sourceKey);
              if (old) { if (old.content_hash !== contentHash) throw new Error('LEGACY_MAPPING_CONTENT_CONFLICT'); reused++; continue; }
              const provenance = { environment: 'legacy', source_archive: attachmentId, app_ref: appRef, historical_price_basis: 'unverified', historical_availability: 'unverified', numeric_precision: 'legacy_source_types_preserved_not_promoted_to_financial_facts' };
              insert.run(digest(`${sourceHash}\0${table.name}\0${sourceKey}`), sourceHash, table.name, sourceKey, raw, contentHash, JSON.stringify(provenance), timestamp); imported++;
            }
          }
          if (target.prepare('SELECT COUNT(*) AS n FROM ledger_events').get().n !== beforeFacts) throw new Error('LEGACY_IMPORT_MODIFIED_ACTUAL_FACTS');
          target.prepare('INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), 'release-operator', 'archive_legacy', 'legacy_archive', sourceHash, JSON.stringify({ tables, imported, reused, app_ref: appRef }), timestamp);
          assertWritable();
        }).immediate();
      }
      const manifest = { format: 'legacy-observatory-archive-v1', source_sha256: sourceHash, snapshot_file: `${sourceHash}.sqlite`, app_ref: appRef, archived_at: now(), environment: 'legacy', tables, actual_fact_count_added: 0 };
      const manifestPath = join(archiveDir, `${sourceHash}.json`);
      if (!existsSync(manifestPath)) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      syncDirectory(archiveDir);
      return { archive_path: archivePath, manifest_path: manifestPath, source_sha256: sourceHash, tables: tables.length, source_rows: tables.reduce((sum, table) => sum + table.rows, 0), imported, reused, actual_fact_count_added: 0 };
    } finally { target?.close(); snapshot.close(); }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('LEGACY_ARCHIVE_ARGUMENTS_FORBIDDEN_USE_ENVIRONMENT');
    const result = await archiveLegacy({ sourcePath: process.env.WORKBENCH_LEGACY_SOURCE, archiveDir: process.env.WORKBENCH_LEGACY_ARCHIVE_DIR, dbPath: process.env.WORKBENCH_DB_PATH || undefined, dataDir: process.env.WORKBENCH_DATA_DIR, appRef: process.env.WORKBENCH_RELEASE_REF, sourceQuiesced: process.env.WORKBENCH_LEGACY_QUIESCED === '1' });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (cause) { process.stderr.write(`${cause instanceof Error ? cause.message : 'LEGACY_ARCHIVE_FAILED'}\n`); process.exitCode = 1; }
}
