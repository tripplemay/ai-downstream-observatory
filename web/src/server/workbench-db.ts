import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import Database from "better-sqlite3";
import manifest from "../../../migrations/manifest.json";

export function openWorkbench(dbPath = process.env.WORKBENCH_DB_PATH): Database.Database {
  if (!dbPath || !path.isAbsolute(dbPath)) throw new Error("WORKBENCH_DB_PATH_MUST_BE_ABSOLUTE");
  const resolved = realpathSync(dbPath);
  if (path.basename(resolved).toLowerCase() === "observatory.db") throw new Error("LEGACY_DATABASE_NOT_ALLOWED");
  const readOnly = recoveryReadOnly(resolved);
  const db = new Database(resolved, { fileMustExist: true, readonly: readOnly });
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = FULL");
    if (db.pragma("journal_mode", { simple: true }) !== "wal") throw new Error("WAL_MODE_REQUIRED");
    const migrations = db.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all() as { version: number; checksum: string }[];
    if (migrations.length !== manifest.migrations.length || db.pragma("user_version", { simple: true }) !== manifest.migrations.length || migrations.some((row, i) => row.version !== manifest.migrations[i].version || row.checksum !== manifest.migrations[i].sha256)) throw new Error("SCHEMA_VERSION_MISMATCH");
    return db;
  } catch (error) { db.close(); throw error; }
}

export function assertWritableDatabase(db: Database.Database): void {
  if (db.readonly || recoveryReadOnly(db.name)) throw new Error("WORKBENCH_READ_ONLY");
}

function recoveryReadOnly(filename: string): boolean {
  const directories = new Set([path.dirname(filename), process.env.WORKBENCH_DATA_DIR].filter((value): value is string => Boolean(value)));
  return process.env.WORKBENCH_MODE === "read_only" || [...directories].some(directory => existsSync(path.join(directory, "RESTORE_PENDING_REVIEW")));
}
