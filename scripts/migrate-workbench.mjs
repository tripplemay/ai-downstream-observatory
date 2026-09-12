import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'web/package.json'));
const Database = require('better-sqlite3');
export const migrationDirectory = join(root, 'migrations');

export function loadMigrations(directory = migrationDirectory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format_version !== 1 || !Array.isArray(manifest.migrations) || !manifest.migrations.length) {
    throw new Error('INVALID_MIGRATION_MANIFEST');
  }
  const migrations = manifest.migrations.map((entry, index) => {
    if (entry.version !== index + 1 || !/^\d{4}_[a-z0-9_]+\.sql$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error('INVALID_MIGRATION_ENTRY');
    }
    const sql = readFileSync(join(directory, entry.file), 'utf8');
    if (createHash('sha256').update(sql).digest('hex') !== entry.sha256) {
      throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${entry.file}`);
    }
    return { ...entry, sql };
  });
  const files = readdirSync(directory).filter((file) => file.endsWith('.sql')).sort();
  if (JSON.stringify(files) !== JSON.stringify(migrations.map((entry) => entry.file).sort())) {
    throw new Error('UNMANIFESTED_MIGRATION');
  }
  return migrations;
}

function assertPath(path) {
  if (!path || !isAbsolute(path) || path === ':memory:') throw new Error('ABSOLUTE_WORKBENCH_DB_PATH_REQUIRED');
  const canonical = existsSync(path) ? realpathSync(path) : path;
  if (basename(canonical).toLowerCase() === 'observatory.db' || basename(path).toLowerCase() === 'observatory.db') {
    throw new Error('LEGACY_DATABASE_WRITE_FORBIDDEN');
  }
}

function assertNoRecovery(path) {
  const canonical = existsSync(path) ? realpathSync(path) : path;
  const directories = new Set([dirname(path), dirname(canonical), process.env.WORKBENCH_DATA_DIR].filter(Boolean));
  if ([...directories].some((directory) => existsSync(join(directory, 'RESTORE_PENDING_REVIEW')))) {
    throw new Error('RESTORE_PENDING_REVIEW');
  }
}

function readApplied(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
  if (!tables.length) return [];
  if (!tables.includes('schema_migrations')) throw new Error('NON_WORKBENCH_DATABASE_REFUSED');
  if (tables.some((name) => ['themes', 'snapshots', 'paper_accounts', 'strategy_params'].includes(name))) {
    throw new Error('LEGACY_DATABASE_WRITE_FORBIDDEN');
  }
  return db.prepare('SELECT version, filename, checksum FROM schema_migrations ORDER BY version').all();
}

function assertApplied(applied, migrations) {
  for (const [index, row] of applied.entries()) {
    const expected = migrations[index];
    if (!expected || row.version !== index + 1 || row.version !== expected.version || row.filename !== expected.file || row.checksum !== expected.sha256) {
      throw new Error('APPLIED_MIGRATION_MISMATCH');
    }
  }
}

export function verifyWorkbenchSchema(db, directory = migrationDirectory) {
  const migrations = loadMigrations(directory);
  const applied = readApplied(db);
  assertApplied(applied, migrations);
  if (applied.length !== migrations.length || db.pragma('user_version', { simple: true }) !== migrations.length) {
    throw new Error('WORKBENCH_SCHEMA_VERSION_MISMATCH');
  }
  if (db.pragma('foreign_key_check').length) throw new Error('WORKBENCH_FOREIGN_KEY_CHECK_FAILED');
  return { version: migrations.length, checksums: migrations.map(({ sha256 }) => sha256) };
}

export function migrateWorkbench(path, { directory = migrationDirectory } = {}) {
  assertPath(path);
  // An explicit migration may initialize a read-only deployment, never a pending recovery.
  assertNoRecovery(path);
  const migrations = loadMigrations(directory);
  assertNoRecovery(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  try {
    // Inspect before changing journal mode, especially for misconfigured legacy paths.
    const applied = readApplied(db);
    assertApplied(applied, migrations);
    const currentVersion = db.pragma('user_version', { simple: true });
    if (currentVersion !== applied.length) throw new Error('WORKBENCH_SCHEMA_VERSION_MISMATCH');
    assertNoRecovery(path);
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    if (db.pragma('journal_mode = WAL', { simple: true }) !== 'wal') throw new Error('WAL_REQUIRED');
    db.pragma('synchronous = FULL');
    let count = 0;
    db.transaction(() => {
      assertNoRecovery(path);
      db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, filename TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
      const lockedApplied = readApplied(db);
      assertApplied(lockedApplied, migrations);
      if (db.pragma('user_version', { simple: true }) !== lockedApplied.length) throw new Error('WORKBENCH_SCHEMA_VERSION_MISMATCH');
      const insert = db.prepare('INSERT INTO schema_migrations(version, filename, checksum, applied_at) VALUES (?, ?, ?, ?)');
      for (const migration of migrations.slice(lockedApplied.length)) {
        db.exec(migration.sql);
        insert.run(migration.version, migration.file, migration.sha256, new Date().toISOString());
        db.pragma(`user_version = ${migration.version}`);
        count += 1;
      }
      if (db.pragma('foreign_key_check').length) throw new Error('WORKBENCH_FOREIGN_KEY_CHECK_FAILED');
      assertNoRecovery(path);
    }).immediate();
    const result = verifyWorkbenchSchema(db, directory);
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('WORKBENCH_QUICK_CHECK_FAILED');
    return { ...result, applied: count, path };
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const path = args.length === 2 && args[0] === '--db' ? args[1] : args.length === 0 ? process.env.WORKBENCH_DB_PATH : undefined;
  try {
    if (!path) throw new Error('Usage: node scripts/migrate-workbench.mjs --db /absolute/path/etf-workbench.db');
    process.stdout.write(`${JSON.stringify(migrateWorkbench(path))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'MIGRATION_FAILED'}\n`);
    process.exitCode = 1;
  }
}
