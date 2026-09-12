import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { audit, type Actor } from "./service";
import { assertWritableDatabase } from "../workbench-db";

export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export interface Attachment {
  id: string; content_hash: string; media_type: string; byte_size: number; storage_key: string; created_at: string;
}
export interface AttachmentOptions { dataDir?: string; now?: string }
type AttachmentMediaType = "application/json" | "text/csv";
type AttachmentSuffix = "json" | "csv";

function suffixFor(mediaType: string): AttachmentSuffix {
  if (mediaType === "application/json") return "json";
  if (mediaType === "text/csv") return "csv";
  throw new Error("INVALID_ATTACHMENT_METADATA");
}

function assertUtf8(bytes: Uint8Array): void {
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("INVALID_ATTACHMENT_UTF8"); }
}

function assertEvidence(attachment: Attachment, payload: string): void {
  const evidence = JSON.parse(payload) as { content_hash: string; byte_size: number; media_type?: string; storage_key?: string };
  if (evidence.content_hash !== attachment.content_hash || evidence.byte_size !== attachment.byte_size) throw new Error("INVALID_ATTACHMENT_METADATA");
  // Pre-CSV audit records only authorized JSON; missing fields cannot authorize a MIME switch.
  if (evidence.media_type === undefined && evidence.storage_key === undefined) {
    if (attachment.media_type !== "application/json") throw new Error("INVALID_ATTACHMENT_METADATA");
  } else if (evidence.media_type !== attachment.media_type || evidence.storage_key !== attachment.storage_key) throw new Error("INVALID_ATTACHMENT_METADATA");
}

function directories(dataDir: string | undefined, create = false): { root: string; attachments: string } {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error("ATTACHMENT_DATA_DIR_REQUIRED");
  if (create) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (lstatSync(dataDir).isSymbolicLink() || !lstatSync(dataDir).isDirectory()) throw new Error("UNSAFE_ATTACHMENT_DIRECTORY");
  const root = realpathSync(dataDir);
  const attachments = path.join(root, "attachments");
  if (create) {
    try { mkdirSync(attachments, { mode: 0o700 }); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  const stat = lstatSync(attachments);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(attachments) !== attachments) throw new Error("UNSAFE_ATTACHMENT_DIRECTORY");
  if (create) {
    const fd = openSync(attachments, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fchmodSync(fd, 0o700); } finally { closeSync(fd); }
  } else if ((stat.mode & 0o777) !== 0o700) throw new Error("UNSAFE_ATTACHMENT_DIRECTORY");
  return { root, attachments };
}

function requireScope(db: Database.Database, actor: Actor, portfolioId: string, accountId?: string): void {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  const found = accountId
    ? db.prepare("SELECT id FROM accounts WHERE id=? AND portfolio_id=?").get(accountId, portfolioId)
    : db.prepare("SELECT id FROM portfolios WHERE id=?").get(portfolioId);
  if (!found) throw new Error(accountId ? "ACCOUNT_OUT_OF_SCOPE" : "PORTFOLIO_NOT_FOUND");
}

function safeRead(directory: string, hash: string, expectedSize: number, suffix: AttachmentSuffix): Buffer {
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_ATTACHMENT_BYTES) throw new Error("INVALID_ATTACHMENT_METADATA");
  const before = lstatSync(directory);
  if (before.isSymbolicLink() || !before.isDirectory() || realpathSync(directory) !== directory) throw new Error("UNSAFE_ATTACHMENT_DIRECTORY");
  const fd = openSync(path.join(directory, `${hash}.${suffix}`), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== expectedSize) throw new Error("ATTACHMENT_SIZE_MISMATCH");
    if ((stat.mode & 0o777) !== 0o600) throw new Error("UNSAFE_ATTACHMENT_PERMISSIONS");
    const buffer = Buffer.alloc(expectedSize + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      if (!read) break;
      length += read;
    }
    if (length !== expectedSize || fstatSync(fd).size !== expectedSize) throw new Error("ATTACHMENT_SIZE_MISMATCH");
    const bytes = buffer.subarray(0, length);
    const after = lstatSync(directory);
    if (after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev || realpathSync(directory) !== directory) throw new Error("UNSAFE_ATTACHMENT_DIRECTORY");
    if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("ATTACHMENT_HASH_MISMATCH");
    return bytes;
  } finally { closeSync(fd); }
}

export function storeJsonAttachment(db: Database.Database, actor: Actor, input: { portfolio_id: string; account_id: string; raw: string }, options: AttachmentOptions = {}): Attachment {
  requireScope(db, actor, input.portfolio_id, input.account_id);
  assertWritableDatabase(db);
  if (typeof input.raw !== "string") throw new Error("INVALID_ATTACHMENT_TEXT");
  const bytes = Buffer.from(input.raw, "utf8");
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("ATTACHMENT_TOO_LARGE");
  if (bytes.toString("utf8") !== input.raw) throw new Error("INVALID_ATTACHMENT_UTF8");
  return storeBytes(db, actor, input, bytes, "application/json", options);
}

export function storeCsvAttachment(db: Database.Database, actor: Actor, input: { portfolio_id: string; account_id: string; bytes: Uint8Array }, options: AttachmentOptions = {}): Attachment {
  requireScope(db, actor, input.portfolio_id, input.account_id);
  assertWritableDatabase(db);
  if (!(input.bytes instanceof Uint8Array)) throw new Error("INVALID_ATTACHMENT_BYTES");
  if (!input.bytes.byteLength || input.bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("ATTACHMENT_TOO_LARGE");
  // Own a copy: offsets, BOM and line endings are evidence, not normalization input.
  return storeBytes(db, actor, input, Buffer.from(input.bytes), "text/csv", options);
}

function storeBytes(db: Database.Database, actor: Actor, input: { portfolio_id: string; account_id: string }, bytes: Buffer, mediaType: AttachmentMediaType, options: AttachmentOptions): Attachment {
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("ATTACHMENT_TOO_LARGE");
  assertUtf8(bytes);
  const suffix = suffixFor(mediaType);
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const { attachments } = directories(options.dataDir ?? process.env.WORKBENCH_DATA_DIR, true);
  const filename = path.join(attachments, `${contentHash}.${suffix}`);
  let fd: number | undefined;
  try {
    fd = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } catch (error) {
      // An incomplete file has no database reference and must never be published.
      unlinkSync(filename);
      throw error;
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
  safeRead(attachments, contentHash, bytes.length, suffix);
  const directoryFd = openSync(attachments, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  return db.transaction(() => {
    assertWritableDatabase(db);
    const key = `attachments/${contentHash}.${suffix}`;
    let attachment = db.prepare("SELECT * FROM attachments WHERE storage_key=?").get(key) as Attachment | undefined;
    const now = options.now ?? new Date().toISOString();
    if (attachment) {
      if (attachment.content_hash !== contentHash || attachment.byte_size !== bytes.length || attachment.media_type !== mediaType) throw new Error("INVALID_ATTACHMENT_METADATA");
    } else {
      const id = randomUUID();
      db.prepare("INSERT INTO attachments(id,content_hash,media_type,byte_size,storage_key,created_at) VALUES(?,?,?,?,?,?)").run(id, contentHash, mediaType, bytes.length, key, now);
      attachment = db.prepare("SELECT * FROM attachments WHERE id=?").get(id) as Attachment;
    }
    const scoped = db.prepare("SELECT payload_json FROM audit_events WHERE action='store_attachment' AND object_type='attachment' AND object_id=? AND portfolio_id=? AND json_extract(payload_json,'$.account_id')=? LIMIT 1").get(attachment.id, input.portfolio_id, input.account_id) as { payload_json: string } | undefined;
    if (scoped) assertEvidence(attachment, scoped.payload_json);
    else audit(db, actor, "store_attachment", "attachment", attachment.id, input.portfolio_id, null, { account_id: input.account_id, content_hash: contentHash, byte_size: bytes.length, media_type: mediaType, storage_key: key }, now);
    assertWritableDatabase(db);
    return attachment;
  }).immediate();
}

export function readJsonAttachment(db: Database.Database, actor: Actor, portfolioId: string, attachmentId: string, options: AttachmentOptions & { accountId?: string } = {}): { attachment: Attachment; bytes: Buffer } {
  return readTypedAttachment(db, actor, portfolioId, attachmentId, options, "application/json");
}

export function readCsvAttachment(db: Database.Database, actor: Actor, portfolioId: string, attachmentId: string, options: AttachmentOptions & { accountId?: string } = {}): { attachment: Attachment; bytes: Buffer } {
  return readTypedAttachment(db, actor, portfolioId, attachmentId, options, "text/csv");
}

export function readAttachment(db: Database.Database, actor: Actor, portfolioId: string, attachmentId: string, options: AttachmentOptions & { accountId?: string } = {}): { attachment: Attachment; bytes: Buffer } {
  return readTypedAttachment(db, actor, portfolioId, attachmentId, options);
}

function readTypedAttachment(db: Database.Database, actor: Actor, portfolioId: string, attachmentId: string, options: AttachmentOptions & { accountId?: string }, expectedType?: AttachmentMediaType): { attachment: Attachment; bytes: Buffer } {
  requireScope(db, actor, portfolioId, options.accountId);
  const scoped = db.prepare("SELECT e.payload_json FROM audit_events e JOIN accounts a ON a.id=json_extract(e.payload_json,'$.account_id') AND a.portfolio_id=e.portfolio_id WHERE e.action='store_attachment' AND e.object_type='attachment' AND e.object_id=? AND e.portfolio_id=? AND (? IS NULL OR a.id=?) LIMIT 1")
    .get(attachmentId, portfolioId, options.accountId ?? null, options.accountId ?? null) as { payload_json: string } | undefined;
  if (!scoped) throw new Error("ATTACHMENT_OUT_OF_SCOPE");
  const attachment = db.prepare("SELECT * FROM attachments WHERE id=?").get(attachmentId) as Attachment | undefined;
  if (!attachment) throw new Error("ATTACHMENT_NOT_FOUND");
  assertEvidence(attachment, scoped.payload_json);
  const suffix = suffixFor(attachment.media_type);
  if (attachment.storage_key !== `attachments/${attachment.content_hash}.${suffix}` || (expectedType && attachment.media_type !== expectedType)) throw new Error("INVALID_ATTACHMENT_METADATA");
  const { attachments } = directories(options.dataDir ?? process.env.WORKBENCH_DATA_DIR);
  const bytes = safeRead(attachments, attachment.content_hash, attachment.byte_size, suffix);
  assertUtf8(bytes);
  return { attachment, bytes };
}
