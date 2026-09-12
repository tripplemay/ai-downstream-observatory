import path from "node:path";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { openWorkbench } from "@/server/workbench-db";

declare global {
  var __obsDb: Database.Database | undefined;
  var __obsArchiveIdentity: string | undefined;
}

function legacySource(): { filename: string; hash?: string; size?: number } {
  if (process.env.WORKBENCH_DB_PATH) {
    const db = openWorkbench();
    try {
      const row = db.prepare("SELECT e.object_id hash,a.content_hash,a.storage_key,a.byte_size FROM audit_events e JOIN attachments a ON a.id='legacy-'||e.object_id WHERE e.action='archive_legacy' AND e.object_type='legacy_archive' ORDER BY e.created_at DESC,e.rowid DESC LIMIT 1")
        .get() as { hash: string; content_hash: string; storage_key: string; byte_size: number } | undefined;
      if (!row) throw new Error("LEGACY_ARCHIVE_NOT_AVAILABLE");
      if (!/^[a-f0-9]{64}$/.test(row.hash) || row.content_hash !== row.hash || row.storage_key !== `attachments/legacy-${row.hash}.sqlite`
        || !Number.isSafeInteger(row.byte_size) || row.byte_size < 1 || row.byte_size > 256 * 1024 * 1024) throw new Error("INVALID_LEGACY_ARCHIVE_METADATA");
      const root = realpathSync(process.env.WORKBENCH_DATA_DIR ?? path.dirname(db.name));
      const directory = path.join(root, "attachments");
      if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) throw new Error("UNSAFE_LEGACY_ARCHIVE_PATH");
      return { filename: path.join(root, row.storage_key), hash: row.hash, size: row.byte_size };
    } finally { db.close(); }
  }
  const filename = process.env.DB_PATH ?? path.resolve(process.cwd(), "..", "data", "observatory.db");
  if (!path.isAbsolute(filename)) throw new Error("LEGACY_DB_PATH_MUST_BE_ABSOLUTE");
  return { filename };
}

function verifyArchive(filename: string, hash: string, size: number): string {
  const before = lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== size) throw new Error("UNSAFE_LEGACY_ARCHIVE_PATH");
  const identity = `${filename}:${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
  if (globalThis.__obsDb?.open && globalThis.__obsArchiveIdentity === identity) return identity;
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW), digest = createHash("sha256");
  try {
    const stat = fstatSync(fd);
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== size) throw new Error("LEGACY_ARCHIVE_CHANGED");
    const buffer = Buffer.alloc(1024 * 1024);
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count));
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || digest.digest("hex") !== hash) throw new Error("LEGACY_ARCHIVE_HASH_MISMATCH");
  } finally { closeSync(fd); }
  return identity;
}

/** Legacy research is an archive, never an initializer or actual ledger. */
export function getDb(): Database.Database {
  const source = legacySource(), { filename } = source;
  const identity = source.hash ? verifyArchive(filename, source.hash, source.size!) : filename;
  if (!globalThis.__obsDb?.open || globalThis.__obsDb.name !== filename || (source.hash && globalThis.__obsArchiveIdentity !== identity)) {
    globalThis.__obsDb?.close();
    const db = new Database(filename, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    globalThis.__obsDb = db;
    globalThis.__obsArchiveIdentity = identity;
  }
  return globalThis.__obsDb;
}
