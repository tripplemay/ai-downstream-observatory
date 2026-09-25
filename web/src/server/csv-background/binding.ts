import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { parseStrictJson } from "../strict-json";
import { canonical, hash } from "../ledger/service";
import { parseCsvMapping, CSV_MAPPING_MAX_BYTES } from "../ledger/csv-mapping";
import { CSV_LIMITS } from "../ledger/csv";
import { verifyCsvEvidence, type CsvBatch } from "../ledger/csv-import-evidence";
import { parseCsvReview } from "../ledger/csv-review";
import { readConfirmedCsvImportEvidence } from "../ledger/csv-confirmation";
import type { CsvBackgroundConfirmationPayload, CsvBackgroundJobResult, CsvBackgroundJobRow, CsvBackgroundLease, CsvBackgroundOptions,
  CsvBackgroundRequestBinding, CsvBackgroundRequestRow, CsvBackgroundResult, CsvBackgroundResultRow } from "./types";

export const CSV_BACKGROUND_LIMITS = Object.freeze({ session_requests: 128, session_bytes: 64 * 1024 * 1024, payload_bytes: 5 * 1024 * 1024, deadline_seconds: 900, max_attempts: 3 });
export const csvBackgroundIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const id = csvBackgroundIdSchema, digest = z.string().regex(/^[a-f0-9]{64}$/), integer = z.number().int().safe().nonnegative();
const previewSchema = z.object({ filename: z.string().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value) && Buffer.from(value).toString() === value), mapping: z.string().min(1), csv_sha256: digest }).strict();
const confirmSchema = z.object({ payload_hash: digest }).strict();
const confirmationSchema = z.object({ action: z.literal("confirm_import"), portfolio_id: id, batch_id: id, preview_hash: digest, expected_revision: integer, csv_review: z.unknown().optional() }).strict();
const resultSchema = z.object({ schema_version: z.literal("csv-background-result-v1"), request_id: id, operation: z.enum(["preview", "confirm"]), input_hash: digest,
  batch_id: id, preview_hash: digest, expected_revision: integer, batch_status: z.enum(["preview", "invalid", "confirmed"]), row_count: integer.max(CSV_LIMITS.data_rows),
  error_count: integer.max(CSV_LIMITS.data_rows + 1), review_hash: digest, required_review_count: integer.max(CSV_LIMITS.data_rows), confirmed_revision: integer.nullable(), receipts_hash: digest.nullable() }).strict();
export const rawCsvBackgroundHash = (raw: string | Uint8Array) => createHash("sha256").update(raw).digest("hex");
export function csvBackgroundStamp(raw = new Date().toISOString()): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(raw);
  if (!match || raw.startsWith("0000")) throw new Error("CSV_BACKGROUND_INVALID_CLOCK");
  const value = Date.parse(match[1] + "Z");
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 19) !== match[1]) throw new Error("CSV_BACKGROUND_INVALID_CLOCK");
  return `${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z`;
}
export function csvBackgroundExpires(now: string) {
  const result = new Date(Date.parse(now) + CSV_BACKGROUND_LIMITS.deadline_seconds * 1000).toISOString();
  return csvBackgroundStamp(result).slice(0, 20) + csvBackgroundStamp(now).slice(20);
}
export function parseCsvBackgroundConfirmation(raw: string): CsvBackgroundConfirmationPayload {
  try {
    if (typeof raw !== "string" || Buffer.from(raw, "utf8").toString("utf8") !== raw || Buffer.byteLength(raw, "utf8") > CSV_BACKGROUND_LIMITS.payload_bytes) throw new Error();
    return confirmationSchema.parse(parseStrictJson(raw.startsWith("\ufeff") ? raw.slice(1) : raw));
  } catch { throw new Error("CSV_BACKGROUND_INVALID_CONFIRMATION"); }
}
function requireTrue(value: unknown): asserts value { if (!value) throw new Error("CSV_BACKGROUND_EVIDENCE_INVALID"); }
export function csvBackgroundReceipt(row: CsvBackgroundRequestRow) { return { request_id: row.id, operation: row.operation, input_hash: row.input_hash, status: "queued" as const }; }
export function csvBackgroundAuditInput(row: CsvBackgroundRequestRow) {
  return { portfolio_id: row.portfolio_id, account_id: row.account_id, operation: row.operation, idempotency_key: row.idempotency_key,
    expected_revision: row.expected_revision, input_hash: row.input_hash, session_hash: row.session_hash, acknowledge_background_execution: true };
}
export function csvBackgroundCommand(row: CsvBackgroundRequestRow) { return { schema_version: "csv-background-command-v1", request_id: row.id, input_hash: row.input_hash }; }
export function readCsvBackgroundRequest(db: Database.Database, requestId: string, _options: CsvBackgroundOptions = {}): CsvBackgroundRequestBinding {
  const row = db.prepare("SELECT * FROM csv_background_requests WHERE id=?").get(requestId) as CsvBackgroundRequestRow | undefined;
  if (!row) throw new Error("CSV_BACKGROUND_NOT_FOUND");
  try {
    requireTrue([row.id, row.portfolio_id, row.account_id, row.idempotency_key, row.command_request_id, row.approval_audit_id].every(value => id.safeParse(value).success));
    requireTrue(typeof row.actor_id === "string" && /^[\x21-\x7e]{1,160}$/.test(row.actor_id) && !/^system(?::|$)/i.test(row.actor_id));
    requireTrue(digest.safeParse(row.session_hash).success && digest.safeParse(row.input_hash).success && integer.safeParse(row.expected_revision).success);
    requireTrue(csvBackgroundStamp(row.created_at) === row.created_at && csvBackgroundExpires(row.created_at) === row.expires_at);
    requireTrue(db.prepare("SELECT 1 FROM accounts WHERE id=? AND portfolio_id=?").get(row.account_id, row.portfolio_id));
    requireTrue(typeof row.input_json === "string" && Buffer.byteLength(row.input_json, "utf8") <= 1572864);
    const input = row.operation === "preview" ? previewSchema.parse(parseStrictJson(row.input_json)) : row.operation === "confirm" ? confirmSchema.parse(parseStrictJson(row.input_json)) : undefined;
    requireTrue(input && canonical(input) === row.input_json);
    requireTrue(hash({ operation: row.operation, portfolio_id: row.portfolio_id, account_id: row.account_id, expected_revision: row.expected_revision, input }) === row.input_hash);
    let confirmation: CsvBackgroundRequestBinding["confirmation"] = null;
    if (row.operation === "preview") {
      const data = previewSchema.parse(input);
      requireTrue(Buffer.isBuffer(row.csv_bytes) && row.csv_bytes.length > 0 && row.csv_bytes.length <= CSV_LIMITS.bytes && rawCsvBackgroundHash(row.csv_bytes) === data.csv_sha256);
      requireTrue(Buffer.from(data.mapping, "utf8").toString("utf8") === data.mapping && Buffer.byteLength(data.mapping, "utf8") <= CSV_MAPPING_MAX_BYTES);
      parseCsvMapping(data.mapping); requireTrue(row.confirmation_attempt_id === null && row.batch_id === null);
    } else {
      const data = confirmSchema.parse(input);
      requireTrue(row.csv_bytes === null && id.safeParse(row.confirmation_attempt_id).success && id.safeParse(row.batch_id).success);
      const attempt = db.prepare("SELECT * FROM csv_confirmation_attempts WHERE id=?").get(row.confirmation_attempt_id) as Record<string, unknown> | undefined;
      requireTrue(attempt && attempt.actor_id === row.actor_id && attempt.session_hash === row.session_hash && attempt.portfolio_id === row.portfolio_id && attempt.account_id === row.account_id
        && attempt.batch_id === row.batch_id && attempt.expected_revision === row.expected_revision && attempt.payload_hash === data.payload_hash && typeof attempt.payload_text === "string"
        && rawCsvBackgroundHash(attempt.payload_text) === data.payload_hash && csvBackgroundStamp(String(attempt.created_at)) <= row.created_at);
      const payload = parseCsvBackgroundConfirmation(attempt.payload_text);
      requireTrue(payload.portfolio_id === row.portfolio_id && payload.batch_id === row.batch_id && payload.expected_revision === row.expected_revision && payload.preview_hash === attempt.preview_hash);
      const batch = db.prepare("SELECT * FROM import_batches WHERE id=?").get(row.batch_id) as CsvBatch | undefined;
      requireTrue(batch && batch.portfolio_id === row.portfolio_id && batch.account_id === row.account_id && batch.parser_version === "csv-v1" && batch.expected_revision === row.expected_revision && batch.preview_hash === payload.preview_hash);
      confirmation = { payload_text: attempt.payload_text, payload };
    }
    const audit = db.prepare("SELECT * FROM audit_events WHERE id=?").get(row.approval_audit_id) as Record<string, unknown> | undefined;
    requireTrue(audit && audit.actor_id === row.actor_id && audit.portfolio_id === row.portfolio_id && audit.action === "request_csv_background" && audit.object_type === "csv_background_request"
      && audit.object_id === row.id && audit.ledger_revision === row.expected_revision && audit.created_at === row.created_at && typeof audit.payload_json === "string");
    requireTrue(canonical(parseStrictJson(audit.payload_json)) === canonical({ actor_kind: "human", input: csvBackgroundAuditInput(row), result: csvBackgroundReceipt(row) }));
    const command = db.prepare("SELECT * FROM command_requests WHERE id=?").get(row.command_request_id) as Record<string, unknown> | undefined;
    const commandBody = canonical(csvBackgroundCommand(row));
    requireTrue(row.command_request_id === row.id && command && command.id === row.id && command.portfolio_id === row.portfolio_id && command.command_type === `csv_import_${row.operation}_v1`
      && command.actor_id === "system:csv-background" && command.idempotency_key === row.id && command.created_at === row.created_at && command.payload_json === commandBody && command.payload_hash === hash(csvBackgroundCommand(row)));
    return { row, input, confirmation };
  } catch { throw new Error("CSV_BACKGROUND_EVIDENCE_INVALID"); }
}
export function assertCsvBackgroundJob(db: Database.Database, binding: CsvBackgroundRequestBinding, job: CsvBackgroundJobRow) {
  const row = binding.row;
  requireTrue(job.command_request_id === row.id && job.job_type === `csv_import_${row.operation}_v1` && job.scope === row.portfolio_id && job.period === row.created_at.slice(0, 10)
    && job.input_version === `${row.id}:${hash(csvBackgroundCommand(row))}` && job.max_attempts === CSV_BACKGROUND_LIMITS.max_attempts);
  requireTrue(csvBackgroundStamp(job.created_at) >= row.created_at);
}
export function assertCsvBackgroundLease(db: Database.Database, lease: CsvBackgroundLease, now: string) {
  requireTrue(id.safeParse(lease.job_id).success && typeof lease.owner === "string" && lease.owner.length > 0 && lease.owner.length <= 160
    && Number.isSafeInteger(lease.fencing_token) && lease.fencing_token > 0 && Number.isSafeInteger(lease.attempt) && lease.attempt > 0 && lease.attempt <= CSV_BACKGROUND_LIMITS.max_attempts);
  const job = db.prepare("SELECT * FROM job_runs WHERE id=?").get(lease.job_id) as CsvBackgroundJobRow | undefined;
  if (!job || job.status !== "running" || job.lease_owner !== lease.owner || job.fencing_token !== lease.fencing_token || job.attempt_count !== lease.attempt
    || !job.lease_until || csvBackgroundStamp(job.lease_until) <= now) throw new Error("CSV_BACKGROUND_STALE_LEASE");
  const binding = readCsvBackgroundRequest(db, job.command_request_id); assertCsvBackgroundJob(db, binding, job);
  if (now < binding.row.created_at || now >= binding.row.expires_at) throw new Error("CSV_BACKGROUND_EXPIRED");
  if (db.prepare("SELECT 1 FROM csv_background_cancellations WHERE request_id=?").get(binding.row.id)) throw new Error("CSV_BACKGROUND_CANCELLED");
  const attempt = db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=?").get(job.id, lease.attempt) as { id: string; status: string; fencing_token: number; started_at: string } | undefined;
  requireTrue(attempt && attempt.status === "running" && attempt.fencing_token === lease.fencing_token && csvBackgroundStamp(attempt.started_at) >= binding.row.created_at && csvBackgroundStamp(attempt.started_at) <= now);
  return { ...binding, job, attempt };
}
export function readCsvBackgroundResult(db: Database.Database, requestId: string, options: CsvBackgroundOptions = {}): CsvBackgroundResult | null {
  const stored = db.prepare("SELECT * FROM csv_background_results WHERE request_id=?").get(requestId) as CsvBackgroundResultRow | undefined;
  if (!stored) return null;
  try {
    const binding = readCsvBackgroundRequest(db, requestId), request = binding.row;
    const result = resultSchema.parse(parseStrictJson(stored.result_json));
    requireTrue(canonical(result) === stored.result_json && hash(result) === stored.result_hash && result.request_id === requestId && result.operation === request.operation
      && result.input_hash === request.input_hash && result.batch_id === stored.batch_id && result.expected_revision === request.expected_revision);
    const job = db.prepare("SELECT * FROM job_runs WHERE id=?").get(stored.job_id) as CsvBackgroundJobRow | undefined;
    requireTrue(job); assertCsvBackgroundJob(db, binding, job);
    const attempt = db.prepare("SELECT * FROM job_attempts WHERE id=?").get(stored.job_attempt_id) as Record<string, unknown> | undefined;
    const jobResult: CsvBackgroundJobResult = { schema_version: "csv-background-job-result-v1", request_id: requestId, operation: request.operation, batch_id: result.batch_id, result_hash: stored.result_hash };
    requireTrue(job.status === "succeeded" && job.lease_owner === null && job.lease_until === null && job.result_json === canonical(jobResult) && job.updated_at === stored.completed_at
      && attempt && attempt.job_id === job.id && attempt.attempt === job.attempt_count && attempt.fencing_token === job.fencing_token && attempt.status === "succeeded"
      && attempt.finished_at === stored.completed_at && typeof attempt.started_at === "string" && csvBackgroundStamp(attempt.started_at) >= request.created_at && csvBackgroundStamp(attempt.started_at) <= stored.completed_at
      && csvBackgroundStamp(stored.completed_at) === stored.completed_at && stored.completed_at < request.expires_at);
    requireTrue(!db.prepare("SELECT 1 FROM csv_background_cancellations WHERE request_id=?").get(requestId));
    const batch = db.prepare("SELECT * FROM import_batches WHERE id=?").get(result.batch_id) as CsvBatch & { confirmed_revision: number | null } | undefined;
    requireTrue(batch && batch.portfolio_id === request.portfolio_id && batch.account_id === request.account_id && batch.parser_version === "csv-v1" && batch.preview_hash === result.preview_hash && batch.expected_revision === result.expected_revision);
    const confirmed = request.operation === "confirm" ? readConfirmedCsvImportEvidence(db, { id: request.actor_id }, request.portfolio_id, result.batch_id, options) : null;
    const { manifest, rows } = confirmed ?? verifyCsvEvidence(db, { id: request.actor_id }, batch, options, false);
    requireTrue(result.row_count === rows.length && result.row_count === batch.row_count && result.error_count === batch.error_count
      && result.review_hash === manifest.review_hash && result.required_review_count === manifest.required_review_rows.length);
    if (request.operation === "preview") {
      const data = previewSchema.parse(binding.input);
      requireTrue(result.batch_status === (batch.error_count ? "invalid" : "preview") && result.confirmed_revision === null && result.receipts_hash === null
        && manifest.content_hash === data.csv_sha256 && hash(parseCsvMapping(data.mapping)) === manifest.mapping_hash);
      const audits = db.prepare("SELECT action,payload_json,created_at FROM audit_events WHERE actor_id=? AND portfolio_id=? AND object_id=? AND action IN ('preview_csv_import','repeat_csv_upload') AND julianday(created_at)>=julianday(?) AND julianday(created_at)<=julianday(?)")
        .all(request.actor_id, request.portfolio_id, batch.id, String(attempt.started_at), stored.completed_at) as { action: string; payload_json: string; created_at: string }[];
      requireTrue(audits.some(audit => {
        if (csvBackgroundStamp(audit.created_at) < csvBackgroundStamp(String(attempt.started_at)) || csvBackgroundStamp(audit.created_at) > stored.completed_at) return false;
        const payload = parseStrictJson(audit.payload_json) as Record<string, unknown>;
        return audit.action === "preview_csv_import" ? manifest.original_filename === data.filename && payload.manifest_hash === hash(manifest) && payload.preview_hash === batch.preview_hash
          : payload.original_filename === data.filename && payload.attachment_id === manifest.attachment_id;
      }));
    } else {
      requireTrue(result.batch_id === request.batch_id && result.batch_status === "confirmed" && batch.status === "confirmed");
      const actual = confirmed!.result;
      const resolutions = parseCsvReview(binding.confirmation!.payload.csv_review, manifest.required_review_rows, manifest.candidates, manifest.review_hash);
      const review = { acknowledge_unverified_mapping: true, review_hash: manifest.review_hash, rows: [...resolutions.values()].sort((a, b) => a.row - b.row) };
      requireTrue(actual.csv_review_hash === hash(review) && result.confirmed_revision === actual.revision && result.receipts_hash === hash(actual.receipts));
    }
    return result;
  } catch { throw new Error("CSV_BACKGROUND_EVIDENCE_INVALID"); }
}
