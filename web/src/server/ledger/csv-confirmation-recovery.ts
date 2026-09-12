import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { parseStrictJson } from "../strict-json";
import { assertWritableDatabase } from "../workbench-db";
import { hash, revision } from "./service";
import { readConfirmedCsvImport } from "./csv-confirmation";
import { parseCsvReview } from "./csv-review";
import { verifyCsvEvidence, type CsvBatch } from "./csv-import-evidence";
import type { AttachmentOptions } from "./attachments";
import type { CsvConfirmationAttemptSummary, CsvConfirmationRecoveryDetail, CsvConfirmationRecoveryList, CsvConfirmationRecoverySelector, CsvRecoveryPrincipal } from "./csv-confirmation-recovery-types";

export type { CsvRecoveryPrincipal, CsvConfirmationAttemptSummary, CsvConfirmationRecoveryDetail, CsvConfirmationRecoveryList } from "./csv-confirmation-recovery-types";
export const CSV_RECOVERY_LIMITS = Object.freeze({ payload_bytes: 5 * 1024 * 1024, session_attempts: 128, session_bytes: 64 * 1024 * 1024, list_page: 20, detail_bytes: 24 * 1024 * 1024 });
const digest = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");
const text = z.string().min(1).max(2000);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const principalSchema = z.object({ actorId: z.string().min(1).max(160).refine(value => !!value.trim()), sessionHash: sha }).strict();
const payloadSchema = z.object({ action: z.literal("confirm_import"), portfolio_id: text, batch_id: text, preview_hash: sha,
  expected_revision: z.number().int().nonnegative().safe(), csv_review: z.unknown().optional() }).strict();
const cursorSchema = z.object({ created_at: z.string().datetime(), id: z.string().uuid() }).strict();
const listSchema = z.object({ cursor: z.string().min(1).max(1024).optional(), limit: z.number().int().min(1).max(CSV_RECOVERY_LIMITS.list_page).optional() }).strict();
const selectorSchema = z.union([z.object({ id: z.string().uuid() }).strict(), z.object({ batch_id: text, payload_hash: sha }).strict()]);
const statuses = new Set(["preview", "invalid", "confirmed", "cancelled"]);
const safeErrors = new Set(["CSV_RECOVERY_PRINCIPAL_INVALID", "CSV_RECOVERY_PAYLOAD_INVALID", "CSV_RECOVERY_QUERY_INVALID", "CSV_RECOVERY_CURSOR_INVALID", "CSV_RECOVERY_NOT_FOUND", "CSV_RECOVERY_NOT_CSV", "CSV_RECOVERY_PAYLOAD_TOO_LARGE", "CSV_RECOVERY_BUDGET_EXCEEDED", "CSV_RECOVERY_RESPONSE_TOO_LARGE", "CSV_RECOVERY_CLOCK_INVALID"]);
export const isCsvRecoveryClientError = (code: string): boolean => safeErrors.has(code);
const reviewErrors = new Set(["CSV_REVIEW_INVALID", "CSV_REVIEW_HASH_MISMATCH", "CSV_REVIEW_ROW_INVALID", "CSV_REVIEW_ROWS_MISMATCH", "CSV_REVIEW_LINK_NOT_EXACT", "CSV_ROW_REQUIRES_LINK"]);
interface AttemptRow {
  id: string; actor_id: string; session_hash: string; portfolio_id: string; account_id: string; batch_id: string;
  preview_hash: string; expected_revision: number; payload_text: string; payload_hash: string; created_at: string;
}
type AttemptMetadata = Omit<AttemptRow, "payload_text"> & { payload_bytes: number };
type Batch = CsvBatch & { confirmed_revision: number | null };
type Payload = z.infer<typeof payloadSchema>;

function principal(input: CsvRecoveryPrincipal): CsvRecoveryPrincipal {
  const value = principalSchema.safeParse(input); if (!value.success) throw new Error("CSV_RECOVERY_PRINCIPAL_INVALID"); return value.data;
}
function parsePayload(raw: string): Payload {
  if (typeof raw !== "string" || !raw || Buffer.from(raw, "utf8").toString("utf8") !== raw) throw new Error("CSV_RECOVERY_PAYLOAD_INVALID");
  if (Buffer.byteLength(raw, "utf8") > CSV_RECOVERY_LIMITS.payload_bytes) throw new Error("CSV_RECOVERY_PAYLOAD_TOO_LARGE");
  try {
    // Match the original HTTP UTF-8 decoder's single leading BOM removal, while retaining its bytes for retry.
    return payloadSchema.parse(parseStrictJson(raw.startsWith("\ufeff") ? raw.slice(1) : raw));
  } catch { throw new Error("CSV_RECOVERY_PAYLOAD_INVALID"); }
}
function readOnly(db: Database.Database): boolean {
  try { assertWritableDatabase(db); return false; }
  catch (error) { if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") return true; throw error; }
}
function batchFor(db: Database.Database, portfolio: string, id: string): Batch {
  const batch = db.prepare("SELECT * FROM import_batches WHERE id=? AND portfolio_id=?").get(id, portfolio) as Batch | undefined;
  if (!batch) throw new Error("IMPORT_NOT_FOUND");
  if (batch.parser_version !== "csv-v1") throw new Error("CSV_RECOVERY_NOT_CSV");
  if (!statuses.has(batch.status) || !Number.isSafeInteger(batch.expected_revision) || batch.expected_revision < 0
    || (batch.status === "confirmed" ? !Number.isSafeInteger(batch.confirmed_revision) || batch.confirmed_revision! < batch.expected_revision : batch.confirmed_revision !== null)) throw new Error("CSV_RECOVERY_EVIDENCE_INVALID");
  if (!db.prepare("SELECT 1 FROM accounts WHERE id=? AND portfolio_id=?").get(batch.account_id, portfolio)) throw new Error("ACCOUNT_OUT_OF_SCOPE");
  return batch;
}
function metadata(input: Payload, batch: Batch): void {
  if (input.preview_hash !== batch.preview_hash) throw new Error("PREVIEW_HASH_MISMATCH");
  if (input.expected_revision !== batch.expected_revision) throw new Error("VERSION_CONFLICT");
}
function validateMetadata(db: Database.Database, who: CsvRecoveryPrincipal, row: AttemptMetadata): Batch {
  if (row.actor_id !== who.actorId || row.session_hash !== who.sessionHash) throw new Error("CSV_RECOVERY_NOT_FOUND");
  try {
    const batch = batchFor(db, row.portfolio_id, row.batch_id);
    if (!sha.safeParse(row.payload_hash).success || row.account_id !== batch.account_id || row.preview_hash !== batch.preview_hash || row.expected_revision !== batch.expected_revision
      || !Number.isSafeInteger(row.payload_bytes) || row.payload_bytes < 1 || row.payload_bytes > CSV_RECOVERY_LIMITS.payload_bytes
      || !cursorSchema.safeParse({ id: row.id, created_at: row.created_at }).success || new Date(row.created_at).toISOString() !== row.created_at) throw new Error("invalid");
    return batch;
  } catch { throw new Error("CSV_RECOVERY_EVIDENCE_INVALID"); }
}
function validateStored(db: Database.Database, who: CsvRecoveryPrincipal, row: AttemptRow): { batch: Batch; payload: Payload } {
  if (row.actor_id !== who.actorId || row.session_hash !== who.sessionHash) throw new Error("CSV_RECOVERY_NOT_FOUND");
  try {
    const payload = parsePayload(row.payload_text), batch = validateMetadata(db, who, { ...row, payload_bytes: Buffer.byteLength(row.payload_text, "utf8") });
    if (row.payload_hash !== digest(row.payload_text) || row.portfolio_id !== payload.portfolio_id || row.batch_id !== payload.batch_id
      || row.preview_hash !== payload.preview_hash || row.expected_revision !== payload.expected_revision) throw new Error("invalid");
    return { batch, payload };
  } catch { throw new Error("CSV_RECOVERY_EVIDENCE_INVALID"); }
}
function summary(db: Database.Database, row: AttemptRow | AttemptMetadata, batch: Batch): CsvConfirmationAttemptSummary {
  return { id: row.id, portfolio_id: row.portfolio_id, account_id: row.account_id, batch_id: row.batch_id, preview_hash: row.preview_hash,
    expected_revision: row.expected_revision, payload_hash: row.payload_hash, payload_bytes: "payload_bytes" in row ? row.payload_bytes : Buffer.byteLength(row.payload_text, "utf8"), created_at: row.created_at,
    batch_status: batch.status as CsvConfirmationAttemptSummary["batch_status"], current_revision: revision(db, row.portfolio_id), confirmed_revision: batch.confirmed_revision };
}

/** This independent durable commit records a request, not approval, successful validation or ledger execution. */
export function saveCsvConfirmationAttempt(db: Database.Database, inputPrincipal: CsvRecoveryPrincipal, rawPayload: string, options: AttachmentOptions = {}): CsvConfirmationAttemptSummary {
  const who = principal(inputPrincipal);
  assertWritableDatabase(db);
  if (db.inTransaction) throw new Error("CSV_RECOVERY_INDEPENDENT_TRANSACTION_REQUIRED");
  const input = parsePayload(rawPayload), payloadHash = digest(rawPayload);
  const instant = options.now ?? new Date().toISOString(), parsedTime = new Date(instant);
  if (!Number.isFinite(parsedTime.getTime())) throw new Error("CSV_RECOVERY_CLOCK_INVALID");
  const now = parsedTime.toISOString();
  return db.transaction(() => {
    assertWritableDatabase(db);
    const batch = batchFor(db, input.portfolio_id, input.batch_id); metadata(input, batch);
    const existing = db.prepare("SELECT * FROM csv_confirmation_attempts WHERE actor_id=? AND session_hash=? AND portfolio_id=? AND batch_id=? AND payload_hash=?")
      .get(who.actorId, who.sessionHash, input.portfolio_id, input.batch_id, payloadHash) as AttemptRow | undefined;
    if (existing) {
      validateStored(db, who, existing);
      if (existing.payload_text !== rawPayload) throw new Error("CSV_RECOVERY_EVIDENCE_INVALID");
      assertWritableDatabase(db); return summary(db, existing, batch);
    }
    const used = db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(payload_text AS BLOB))),0) AS bytes FROM csv_confirmation_attempts WHERE actor_id=? AND session_hash=?")
      .get(who.actorId, who.sessionHash) as { count: number; bytes: number };
    if (used.count >= CSV_RECOVERY_LIMITS.session_attempts || used.bytes + Buffer.byteLength(rawPayload, "utf8") > CSV_RECOVERY_LIMITS.session_bytes) throw new Error("CSV_RECOVERY_BUDGET_EXCEEDED");
    const row: AttemptRow = { id: randomUUID(), actor_id: who.actorId, session_hash: who.sessionHash, portfolio_id: input.portfolio_id, account_id: batch.account_id,
      batch_id: input.batch_id, preview_hash: input.preview_hash, expected_revision: input.expected_revision, payload_text: rawPayload, payload_hash: payloadHash, created_at: now };
    db.prepare("INSERT INTO csv_confirmation_attempts(id,actor_id,session_hash,portfolio_id,account_id,batch_id,preview_hash,expected_revision,payload_text,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(row.id, row.actor_id, row.session_hash, row.portfolio_id, row.account_id, row.batch_id, row.preview_hash, row.expected_revision, row.payload_text, row.payload_hash, row.created_at);
    assertWritableDatabase(db); return summary(db, row, batch);
  }).immediate();
}

export function listCsvConfirmationAttempts(db: Database.Database, inputPrincipal: CsvRecoveryPrincipal, input: { cursor?: string; limit?: number } = {}): CsvConfirmationRecoveryList {
  const who = principal(inputPrincipal), parsed = listSchema.safeParse(input);
  if (!parsed.success) throw new Error("CSV_RECOVERY_QUERY_INVALID");
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (parsed.data.cursor) {
    try {
      const raw = Buffer.from(parsed.data.cursor, "base64url");
      if (raw.toString("base64url") !== parsed.data.cursor) throw new Error("encoding");
      cursor = cursorSchema.parse(parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
      if (new Date(cursor.created_at).toISOString() !== cursor.created_at) throw new Error("instant");
    } catch { throw new Error("CSV_RECOVERY_CURSOR_INVALID"); }
  }
  const limit = parsed.data.limit ?? 10;
  const read = (): CsvConfirmationRecoveryList => {
    // The list is discovery metadata, not proof of the original command's integrity. Detail verifies that proof.
    const rows = db.prepare(`SELECT id,actor_id,session_hash,portfolio_id,account_id,batch_id,preview_hash,expected_revision,payload_hash,created_at,
      length(CAST(payload_text AS BLOB)) AS payload_bytes FROM csv_confirmation_attempts WHERE actor_id=? AND session_hash=?
      ${cursor ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(who.actorId, who.sessionHash, ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []), limit + 1) as AttemptMetadata[];
    const page = rows.slice(0, limit), last = page.at(-1);
    const attempts = page.map(row => summary(db, row, validateMetadata(db, who, row)));
    return { schema_version: "csv-confirmation-recovery-v1", attempts, next_cursor: rows.length > limit && last
      ? Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString("base64url") : null, read_only: readOnly(db) };
  };
  return db.inTransaction ? read() : db.transaction(read).deferred();
}

export function getCsvConfirmationAttempt(db: Database.Database, inputPrincipal: CsvRecoveryPrincipal, selector: CsvConfirmationRecoverySelector, options: AttachmentOptions = {}): CsvConfirmationRecoveryDetail {
  const who = principal(inputPrincipal), parsed = selectorSchema.safeParse(selector);
  if (!parsed.success) throw new Error("CSV_RECOVERY_QUERY_INVALID");
  const read = (): CsvConfirmationRecoveryDetail => {
    const key = parsed.data;
    const row = ("id" in key ? db.prepare("SELECT * FROM csv_confirmation_attempts WHERE actor_id=? AND session_hash=? AND id=?").get(who.actorId, who.sessionHash, key.id)
      : db.prepare("SELECT * FROM csv_confirmation_attempts WHERE actor_id=? AND session_hash=? AND batch_id=? AND payload_hash=?").get(who.actorId, who.sessionHash, key.batch_id, key.payload_hash)) as AttemptRow | undefined;
    if (!row) throw new Error("CSV_RECOVERY_NOT_FOUND");
    const { batch, payload } = validateStored(db, who, row);
    const { manifest, rows } = verifyCsvEvidence(db, { id: who.actorId }, batch, options, false);
    let reviewHash: string | null = null, reviewError: string | null = null;
    try {
      const resolutions = parseCsvReview(payload.csv_review, manifest.required_review_rows, manifest.candidates, manifest.review_hash);
      if (rows.some(item => item.outcome.kind === "link_only" && (!resolutions.has(item.row) || resolutions.get(item.row)!.action === "record_distinct"))) throw new Error("CSV_ROW_REQUIRES_LINK");
      reviewHash = hash({ acknowledge_unverified_mapping: true, review_hash: manifest.review_hash, rows: [...resolutions.values()].sort((a, b) => a.row - b.row) });
    } catch (error) {
      if (!(error instanceof Error) || !reviewErrors.has(error.message)) throw error;
      reviewError = error.message;
    }
    let confirmation: CsvConfirmationRecoveryDetail["confirmation"] = { status: "unconfirmed", attempt_matches: null };
    if (batch.status === "confirmed") {
      const actual = readConfirmedCsvImport(db, { id: who.actorId }, batch.portfolio_id, batch.id, options);
      confirmation = { status: "confirmed", attempt_matches: reviewHash === actual.csv_review_hash, revision: actual.revision, receipts: actual.receipts, duplicate: true };
    }
    const result: CsvConfirmationRecoveryDetail = { schema_version: "csv-confirmation-recovery-v1", attempt: summary(db, row, batch), payload_text: row.payload_text, read_only: readOnly(db),
      batch: { id: batch.id, portfolio_id: batch.portfolio_id, account_id: batch.account_id, status: batch.status as CsvConfirmationAttemptSummary["batch_status"], parser_version: "csv-v1",
        preview_hash: batch.preview_hash, expected_revision: batch.expected_revision, confirmed_revision: batch.confirmed_revision, row_count: batch.row_count },
      confirmation, review_error: reviewError };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > CSV_RECOVERY_LIMITS.detail_bytes) throw new Error("CSV_RECOVERY_RESPONSE_TOO_LARGE");
    return result;
  };
  return db.inTransaction ? read() : db.transaction(read).deferred();
}
