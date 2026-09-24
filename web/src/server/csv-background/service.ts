import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { assertWritableDatabase } from "../workbench-db";
import { audit, canonical, hash, revision } from "../ledger/service";
import { CSV_LIMITS } from "../ledger/csv";
import { CSV_MAPPING_MAX_BYTES, parseCsvMapping } from "../ledger/csv-mapping";
import { saveCsvConfirmationAttempt } from "../ledger/csv-confirmation-recovery";
import { CSV_BACKGROUND_LIMITS, csvBackgroundIdSchema as id, csvBackgroundStamp, csvBackgroundExpires, rawCsvBackgroundHash,
  parseCsvBackgroundConfirmation, csvBackgroundAuditInput, csvBackgroundReceipt, csvBackgroundCommand, readCsvBackgroundRequest } from "./binding";
import type { CsvBackgroundPrincipal, CsvBackgroundPreviewInput, CsvBackgroundConfirmationInput, CsvBackgroundCancelInput,
  CsvBackgroundOptions, CsvBackgroundRequestRow, CsvBackgroundReceipt, CsvBackgroundCancelReceipt } from "./types";

const principalSchema = z.object({ actorId: z.string().regex(/^[\x21-\x7e]{1,160}$/).refine(value => !/^system(?::|$)/i.test(value)), sessionHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const previewSchema = z.object({ portfolio_id: id, account_id: id, expected_revision: z.number().int().safe().nonnegative(), idempotency_key: id,
  filename: z.string().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value) && Buffer.from(value).toString() === value), mapping: z.string().min(1),
  bytes: z.instanceof(Uint8Array), acknowledge_background_execution: z.literal(true) }).strict();
const confirmSchema = z.object({ portfolio_id: id, account_id: id, idempotency_key: id, payload_text: z.string().min(1), acknowledge_background_execution: z.literal(true) }).strict();
const reviewAcknowledgementSchema = z.object({ acknowledge_unverified_mapping: z.literal(true), review_hash: z.string().regex(/^[a-f0-9]{64}$/), rows: z.array(z.unknown()).max(CSV_LIMITS.data_rows) }).strict();
const cancelSchema = z.object({ portfolio_id: id, request_id: id, reason: z.string().refine(value => !!value.trim() && [...value].length <= 1000 && !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value)) }).strict();
function parsed<T>(schema: z.ZodType<T>, raw: unknown, code = "CSV_BACKGROUND_INPUT_INVALID"): T { const value = schema.safeParse(raw); if (!value.success) throw new Error(code); return value.data; }
const safeCodes = new Set(["CSV_BACKGROUND_INPUT_INVALID", "CSV_BACKGROUND_PRINCIPAL_INVALID", "CSV_BACKGROUND_INVALID_CONFIRMATION", "CSV_BACKGROUND_BUDGET_EXCEEDED", "CSV_BACKGROUND_IDEMPOTENCY_CONFLICT", "CSV_BACKGROUND_NOT_FOUND", "CSV_BACKGROUND_ALREADY_TERMINAL", "CSV_BACKGROUND_CONFIRM_REQUIRED", "CSV_FILE_ALREADY_CONFIRMED"]);
export const isCsvBackgroundClientError = (code: string) => safeCodes.has(code);
function scope(db: Database.Database, portfolio: string, account: string) {
  if (!db.prepare("SELECT 1 FROM accounts WHERE id=? AND portfolio_id=?").get(account, portfolio)) throw new Error("ACCOUNT_OUT_OF_SCOPE");
}
function prior(db: Database.Database, row: CsvBackgroundRequestRow): CsvBackgroundReceipt | null {
  const old = db.prepare("SELECT id FROM csv_background_requests WHERE actor_id=? AND session_hash=? AND portfolio_id=? AND operation=? AND idempotency_key=?")
    .get(row.actor_id, row.session_hash, row.portfolio_id, row.operation, row.idempotency_key) as { id: string } | undefined;
  if (!old) return null;
  const stored = readCsvBackgroundRequest(db, old.id).row;
  if (stored.account_id !== row.account_id || stored.expected_revision !== row.expected_revision || stored.input_json !== row.input_json || stored.input_hash !== row.input_hash
    || (stored.csv_bytes === null ? row.csv_bytes !== null : !row.csv_bytes || !stored.csv_bytes.equals(row.csv_bytes))) throw new Error("CSV_BACKGROUND_IDEMPOTENCY_CONFLICT");
  return csvBackgroundReceipt(stored);
}
function insert(db: Database.Database, row: CsvBackgroundRequestRow): CsvBackgroundReceipt {
  const used = db.prepare("SELECT COUNT(*) count,COALESCE(SUM(length(CAST(input_json AS BLOB))+COALESCE(length(csv_bytes),0)),0) bytes FROM csv_background_requests WHERE actor_id=? AND session_hash=?")
    .get(row.actor_id, row.session_hash) as { count: number; bytes: number };
  if (used.count >= CSV_BACKGROUND_LIMITS.session_requests || used.bytes + Buffer.byteLength(row.input_json) + (row.csv_bytes?.length ?? 0) > CSV_BACKGROUND_LIMITS.session_bytes) throw new Error("CSV_BACKGROUND_BUDGET_EXCEEDED");
  const command = csvBackgroundCommand(row);
  db.prepare("INSERT INTO command_requests(id,portfolio_id,actor_id,idempotency_key,command_type,payload_json,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(row.id, row.portfolio_id, "system:csv-background", row.id, `csv_import_${row.operation}_v1`, canonical(command), hash(command), row.created_at);
  row.approval_audit_id = audit(db, { id: row.actor_id }, "request_csv_background", "csv_background_request", row.id, row.portfolio_id, row.expected_revision,
    { actor_kind: "human", input: csvBackgroundAuditInput(row), result: csvBackgroundReceipt(row) }, row.created_at);
  db.prepare(`INSERT INTO csv_background_requests(id,portfolio_id,account_id,actor_id,session_hash,operation,idempotency_key,expected_revision,input_json,input_hash,csv_bytes,confirmation_attempt_id,batch_id,command_request_id,approval_audit_id,created_at,expires_at)
    VALUES(@id,@portfolio_id,@account_id,@actor_id,@session_hash,@operation,@idempotency_key,@expected_revision,@input_json,@input_hash,@csv_bytes,@confirmation_attempt_id,@batch_id,@command_request_id,@approval_audit_id,@created_at,@expires_at)`).run(row);
  readCsvBackgroundRequest(db, row.id); assertWritableDatabase(db); return csvBackgroundReceipt(row);
}
function base(who: CsvBackgroundPrincipal, operation: "preview" | "confirm", input: { portfolio_id: string; account_id: string; idempotency_key: string; expected_revision: number }, data: unknown, now: string): CsvBackgroundRequestRow {
  const requestId = randomUUID();
  return { id: requestId, actor_id: who.actorId, session_hash: who.sessionHash, operation, portfolio_id: input.portfolio_id, account_id: input.account_id, idempotency_key: input.idempotency_key, expected_revision: input.expected_revision,
    input_json: canonical(data), input_hash: hash({ operation, portfolio_id: input.portfolio_id, account_id: input.account_id, expected_revision: input.expected_revision, input: data }),
    csv_bytes: null, confirmation_attempt_id: null, batch_id: null, command_request_id: requestId, approval_audit_id: "", created_at: now, expires_at: csvBackgroundExpires(now) };
}
export function requestCsvBackgroundPreview(db: Database.Database, principal: CsvBackgroundPrincipal, input: CsvBackgroundPreviewInput, options: CsvBackgroundOptions = {}): CsvBackgroundReceipt {
  const who = parsed(principalSchema, principal, "CSV_BACKGROUND_PRINCIPAL_INVALID"), value = parsed(previewSchema, input);
  if (!value.bytes.length || value.bytes.length > CSV_LIMITS.bytes || Buffer.byteLength(value.mapping) > CSV_MAPPING_MAX_BYTES || Buffer.from(value.mapping).toString() !== value.mapping) throw new Error("CSV_BACKGROUND_INPUT_INVALID");
  parseCsvMapping(value.mapping);
  const now = csvBackgroundStamp(options.now), bytes = Buffer.from(value.bytes), row = base(who, "preview", value, { filename: value.filename, mapping: value.mapping, csv_sha256: rawCsvBackgroundHash(bytes) }, now);
  row.csv_bytes = bytes;
  assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db); scope(db, row.portfolio_id, row.account_id);
    const existing = prior(db, row); if (existing) return existing;
    if (revision(db, row.portfolio_id) !== row.expected_revision) throw new Error("VERSION_CONFLICT");
    return insert(db, row);
  }).immediate();
}
export function requestCsvBackgroundConfirmation(db: Database.Database, principal: CsvBackgroundPrincipal, input: CsvBackgroundConfirmationInput, options: CsvBackgroundOptions = {}): CsvBackgroundReceipt {
  const who = parsed(principalSchema, principal, "CSV_BACKGROUND_PRINCIPAL_INVALID"), value = parsed(confirmSchema, input), payload = parseCsvBackgroundConfirmation(value.payload_text);
  if (payload.portfolio_id !== value.portfolio_id) throw new Error("CSV_BACKGROUND_INPUT_INVALID");
  const now = csvBackgroundStamp(options.now), row = base(who, "confirm", { ...value, expected_revision: payload.expected_revision }, { payload_hash: rawCsvBackgroundHash(value.payload_text) }, now);
  scope(db, row.portfolio_id, row.account_id); assertWritableDatabase(db);
  const batch = db.prepare("SELECT account_id FROM import_batches WHERE id=? AND portfolio_id=?").get(payload.batch_id, row.portfolio_id) as { account_id: string } | undefined;
  if (!batch || batch.account_id !== row.account_id) throw new Error("ACCOUNT_OUT_OF_SCOPE");
  // This independent archive is deliberately not authorization or dispatch.
  const saved = saveCsvConfirmationAttempt(db, who, value.payload_text, { ...options, now });
  row.confirmation_attempt_id = saved.id; row.batch_id = payload.batch_id;
  return db.transaction(() => {
    assertWritableDatabase(db);
    const existing = prior(db, row); if (existing) return existing;
    const batch = db.prepare("SELECT status,error_count,preview_hash,expected_revision FROM import_batches WHERE id=? AND portfolio_id=? AND account_id=?")
      .get(row.batch_id, row.portfolio_id, row.account_id) as { status: string; error_count: number; preview_hash: string; expected_revision: number } | undefined;
    if (!batch || batch.preview_hash !== payload.preview_hash || batch.expected_revision !== row.expected_revision) throw new Error("PREVIEW_HASH_MISMATCH");
    if (batch.status === "confirmed") throw new Error("CSV_FILE_ALREADY_CONFIRMED");
    if (batch.status !== "preview" || batch.error_count) throw new Error("IMPORT_HAS_ERRORS");
    parsed(reviewAcknowledgementSchema, payload.csv_review, "CSV_REVIEW_INVALID");
    if (revision(db, row.portfolio_id) !== row.expected_revision) throw new Error("VERSION_CONFLICT");
    return insert(db, row);
  }).immediate();
}
export function cancelCsvBackgroundRequest(db: Database.Database, principal: CsvBackgroundPrincipal, input: CsvBackgroundCancelInput, options: CsvBackgroundOptions = {}): CsvBackgroundCancelReceipt {
  const who = parsed(principalSchema, principal, "CSV_BACKGROUND_PRINCIPAL_INVALID"), value = parsed(cancelSchema, input), now = csvBackgroundStamp(options.now);
  assertWritableDatabase(db);
  return db.transaction((): CsvBackgroundCancelReceipt => {
    assertWritableDatabase(db);
    const owner = db.prepare("SELECT id FROM csv_background_requests WHERE id=? AND actor_id=? AND portfolio_id=?").get(value.request_id, who.actorId, value.portfolio_id);
    if (!owner) throw new Error("CSV_BACKGROUND_NOT_FOUND");
    const request = readCsvBackgroundRequest(db, value.request_id).row;
    const old = db.prepare("SELECT reason FROM csv_background_cancellations WHERE request_id=?").get(request.id) as { reason: string } | undefined;
    if (old) { if (old.reason !== value.reason) throw new Error("CSV_BACKGROUND_IDEMPOTENCY_CONFLICT"); return { request_id: request.id, status: "cancelled" }; }
    if (now < request.created_at) throw new Error("CSV_BACKGROUND_INVALID_CLOCK");
    if (db.prepare("SELECT 1 FROM csv_background_results WHERE request_id=?").get(request.id) || db.prepare("SELECT 1 FROM job_runs WHERE command_request_id=? AND status IN ('succeeded','failed','partial','skipped','cancelled')").get(request.id)) throw new Error("CSV_BACKGROUND_ALREADY_TERMINAL");
    db.prepare("INSERT INTO csv_background_cancellations(request_id,actor_id,session_hash,reason,created_at) VALUES(?,?,?,?,?)").run(request.id, who.actorId, who.sessionHash, value.reason, now);
    audit(db, { id: who.actorId }, "cancel_csv_background", "csv_background_request", request.id, request.portfolio_id, null, { reason: value.reason, session_hash: who.sessionHash }, now);
    assertWritableDatabase(db); return { request_id: request.id, status: "cancelled" };
  }).immediate();
}
