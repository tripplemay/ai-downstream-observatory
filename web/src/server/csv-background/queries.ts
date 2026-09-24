import type Database from "better-sqlite3";
import { z } from "zod";
import { assertWritableDatabase } from "../workbench-db";
import { parseStrictJson } from "../strict-json";
import { canonical, hash } from "../ledger/service";
import { readCsvManifest } from "../ledger/csv-import-evidence";
import { assertCsvBackgroundJob, csvBackgroundIdSchema as id, csvBackgroundStamp, readCsvBackgroundRequest, readCsvBackgroundResult } from "./binding";
import type { CsvBackgroundJobRow, CsvBackgroundOptions, CsvBackgroundPrincipal } from "./types";

export const CSV_BACKGROUND_QUERY_LIMITS = Object.freeze({ list: 20, rows: 25, candidates: 100, receipts: 25, response_bytes: 8 * 1024 * 1024 });
export const csvBackgroundCandidateKindSchema = z.enum(["exact_event_ids", "possible_event_ids", "exact_prior_rows", "possible_prior_rows"]);
export const csvBackgroundQuerySchema = z.object({ portfolio_id: id, request_id: id.optional(), view: z.enum(["status", "rows", "candidates", "receipts"]).optional(),
  cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(100).optional(), row: z.number().int().min(1).max(10000).optional(), kind: csvBackgroundCandidateKindSchema.optional(),
}).strict().superRefine((value, context) => {
  const invalid = () => context.addIssue({ code: z.ZodIssueCode.custom, message: "CSV_BACKGROUND_QUERY_INVALID" });
  if (!value.request_id && (value.view || value.row !== undefined || value.kind)) invalid();
  if (value.request_id && (!value.view || value.view === "status") && (value.cursor || value.limit !== undefined || value.row !== undefined || value.kind)) invalid();
  if (value.view === "candidates" ? value.row === undefined || !value.kind : value.row !== undefined || value.kind !== undefined) invalid();
  const max = !value.request_id ? 20 : value.view === "candidates" ? 100 : 25;
  if (value.limit !== undefined && value.limit > max) invalid();
});
export type CsvBackgroundQuery = z.infer<typeof csvBackgroundQuerySchema>;
const principalSchema = z.object({ actorId: z.string().regex(/^[\x21-\x7e]{1,160}$/).refine(value => !/^system(?::|$)/i.test(value)), sessionHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const cursorSchema = z.object({ scope: z.string().regex(/^[a-f0-9]{64}$/), after: z.union([z.number().int().safe().nonnegative(), z.object({ created_at: z.string(), id }).strict()]) }).strict();
const terminal = new Set(["succeeded", "failed", "partial", "skipped", "cancelled"]);
const jobStatuses = new Set(["queued", "running", "retry_queued", ...terminal]);
const safeFailures = new Set(["LEASE_EXPIRED", "VERSION_CONFLICT", "IMPORT_HAS_ERRORS", "CSV_BACKGROUND_EXPIRED", "CSV_BACKGROUND_CANCELLED", "CSV_BACKGROUND_STALE_LEASE", "CSV_BACKGROUND_EVIDENCE_INVALID", "CSV_BACKGROUND_CHILD_FAILED", "CSV_BACKGROUND_CHILD_TIMEOUT", "CSV_IMPORT_CONTEXT_CHANGED", "CSV_REVIEW_HASH_MISMATCH", "CSV_REVIEW_CONFLICT", "CSV_REVIEW_INVALID", "WORKBENCH_READ_ONLY", "RESTORE_PENDING_REVIEW"]);
function demand(value: unknown): asserts value { if (!value) throw new Error("CSV_BACKGROUND_EVIDENCE_INVALID"); }
function readOnly(db: Database.Database) { try { assertWritableDatabase(db); return false; } catch (error) { if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") return true; throw error; } }
function encode(scope: unknown, after: z.infer<typeof cursorSchema>["after"]) { return Buffer.from(canonical({ scope: hash(scope), after })).toString("base64url"); }
function decode(raw: string | undefined, scope: unknown) {
  if (!raw) return null;
  try {
    const bytes = Buffer.from(raw, "base64url"); if (bytes.toString("base64url") !== raw) throw new Error();
    const value = cursorSchema.parse(parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (value.scope !== hash(scope) || canonical(value) !== bytes.toString("utf8")) throw new Error();
    return value.after;
  } catch { throw new Error("CSV_BACKGROUND_CURSOR_INVALID"); }
}
function safeFailure(raw: string | null) {
  if (!raw) return null;
  try { const value = parseStrictJson(raw) as Record<string, unknown>; for (const candidate of [value.code, value.message]) if (typeof candidate === "string" && safeFailures.has(candidate)) return candidate; }
  catch { /* Raw worker exceptions may contain paths or source content. */ }
  return "CSV_BACKGROUND_EXECUTION_FAILED";
}
function owned(db: Database.Database, who: CsvBackgroundPrincipal, portfolio: string, request: string) {
  if (!db.prepare("SELECT 1 FROM csv_background_requests WHERE id=? AND actor_id=? AND portfolio_id=?").get(request, who.actorId, portfolio)) throw new Error("CSV_BACKGROUND_NOT_FOUND");
  return readCsvBackgroundRequest(db, request);
}
function summary(db: Database.Database, binding: ReturnType<typeof readCsvBackgroundRequest>, now: string, options: CsvBackgroundOptions) {
  const row = binding.row;
  const jobs = db.prepare("SELECT * FROM job_runs WHERE command_request_id=? LIMIT 2").all(row.id) as CsvBackgroundJobRow[];
  demand(jobs.length <= 1); const job = jobs[0] ?? null;
  if (job) { assertCsvBackgroundJob(db, binding, job); demand(jobStatuses.has(job.status) && Number.isSafeInteger(job.attempt_count) && job.attempt_count >= 0 && job.attempt_count <= job.max_attempts); }
  // Publication proof currently reads the complete sealed domain evidence. Page extraction below is SQL-bounded, not a claim of bounded proof CPU.
  const result = readCsvBackgroundResult(db, row.id, options);
  if (job?.status === "succeeded") demand(result);
  const cancellation = db.prepare("SELECT created_at FROM csv_background_cancellations WHERE request_id=?").get(row.id) as { created_at: string } | undefined;
  const attempts = job ? db.prepare("SELECT attempt,status,started_at,finished_at,error_json FROM job_attempts WHERE job_id=? ORDER BY attempt LIMIT 4").all(job.id) as { attempt: number; status: string; started_at: string; finished_at: string | null; error_json: string | null }[] : [];
  demand(attempts.length <= 3 && attempts.length === (job?.attempt_count ?? 0));
  for (const [index, attempt] of attempts.entries()) demand(attempt.attempt === index + 1 && ["running", "succeeded", "partial", "failed", "skipped", "lease_expired", "cancelled"].includes(attempt.status));
  const resultHash = result ? hash(result) : null;
  const status = result ? "succeeded" : cancellation ? "cancelled" : job && terminal.has(job.status) ? job.status : now >= row.expires_at ? "expired" : job?.status ?? "queued";
  return { request_id: row.id, portfolio_id: row.portfolio_id, account_id: row.account_id, operation: row.operation, input_hash: row.input_hash,
    expected_revision: row.expected_revision, created_at: row.created_at, expires_at: row.expires_at, status,
    job: job ? { id: job.id, status: job.status, attempt_count: job.attempt_count, max_attempts: job.max_attempts, updated_at: job.updated_at } : null,
    attempts: attempts.map(({ error_json, ...attempt }) => ({ ...attempt, error_code: safeFailure(error_json) })),
    cancelled_at: cancellation?.created_at ?? null, result_hash: resultHash, result };
}
function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > CSV_BACKGROUND_QUERY_LIMITS.response_bytes) throw new Error("CSV_BACKGROUND_RESPONSE_TOO_LARGE");
  return value;
}
function exactStoredObject(raw: string, keys: string[]) {
  let value: unknown;
  try { value = parseStrictJson(raw); } catch { throw new Error("CSV_BACKGROUND_EVIDENCE_INVALID"); }
  demand(value && typeof value === "object" && !Array.isArray(value));
  const object = value as Record<string, unknown>;
  demand(Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key)));
  return object;
}

/** Current owner may inspect restricted metadata across sessions; original request bytes never leave this API. */
export function queryCsvBackground(db: Database.Database, principal: CsvBackgroundPrincipal, input: CsvBackgroundQuery, options: CsvBackgroundOptions = {}) {
  const who = principalSchema.safeParse(principal), parsed = csvBackgroundQuerySchema.safeParse(input);
  if (!who.success) throw new Error("CSV_BACKGROUND_PRINCIPAL_INVALID");
  if (!parsed.success) throw new Error("CSV_BACKGROUND_QUERY_INVALID");
  const query = parsed.data, now = csvBackgroundStamp(options.now);
  const read = () => {
    const common = { schema_version: "csv-background-page-v1" as const, portfolio_id: query.portfolio_id, server_now: now, read_only: readOnly(db) };
    if (!query.request_id) {
      const scope = { actor: who.data.actorId, portfolio: query.portfolio_id, view: "list" }, after = decode(query.cursor, scope), limit = query.limit ?? 10;
      if (after !== null) {
        try { if (typeof after === "number" || csvBackgroundStamp(after.created_at) !== after.created_at) throw new Error(); }
        catch { throw new Error("CSV_BACKGROUND_CURSOR_INVALID"); }
      }
      const ids = db.prepare(`SELECT id,created_at FROM csv_background_requests WHERE actor_id=? AND portfolio_id=? ${after ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`)
        .all(who.data.actorId, query.portfolio_id, ...(after ? [after.created_at, after.created_at, after.id] : []), limit + 1) as { id: string; created_at: string }[];
      const page = ids.slice(0, limit), last = page.at(-1);
      return bounded({ ...common, view: "list" as const, items: page.map(item => summary(db, owned(db, who.data, query.portfolio_id, item.id), now, options)), next_cursor: ids.length > limit && last ? encode(scope, last) : null });
    }
    const binding = owned(db, who.data, query.portfolio_id, query.request_id), item = summary(db, binding, now, options);
    if (!query.view || query.view === "status") return bounded({ ...common, view: "status" as const, item });
    if (!item.result || !item.result_hash) throw new Error("CSV_BACKGROUND_RESULT_NOT_READY");
    const result = item.result, view = query.view, limit = query.limit ?? (view === "candidates" ? 20 : 25);
    const scope = { actor: who.data.actorId, portfolio: query.portfolio_id, request: query.request_id, result_hash: item.result_hash, view, row: query.row ?? null, kind: query.kind ?? null };
    const after = decode(query.cursor, scope); if (after !== null && typeof after !== "number") throw new Error("CSV_BACKGROUND_CURSOR_INVALID");
    const offset = after ?? 0, identity = { request_id: query.request_id, result_hash: item.result_hash, batch_id: result.batch_id, preview_hash: result.preview_hash, review_hash: result.review_hash };
    if (view === "candidates") {
      const manifest = readCsvManifest(db, result.batch_id), candidate = manifest.candidates.find(value => value.row === query.row);
      if (!candidate) throw new Error("CSV_BACKGROUND_ROW_NOT_FOUND");
      const values = candidate[query.kind!]; if (offset > values.length) throw new Error("CSV_BACKGROUND_CURSOR_INVALID");
      const items = values.slice(offset, offset + limit), next = offset + items.length;
      return bounded({ ...common, ...identity, view, row: query.row!, kind: query.kind!, total: values.length, items, next_cursor: next < values.length ? encode(scope, next) : null });
    }
    if (view === "receipts" && (binding.row.operation !== "confirm" || result.batch_status !== "confirmed" || !result.receipts_hash)) throw new Error("CSV_BACKGROUND_RECEIPTS_UNAVAILABLE");
    if (offset > result.row_count) throw new Error("CSV_BACKGROUND_CURSOR_INVALID");
    const rows = view === "rows"
      ? db.prepare("SELECT row_number,raw_json,normalized_json,errors_json FROM import_rows WHERE batch_id=? AND row_number>? ORDER BY row_number LIMIT ?").all(result.batch_id, offset, limit + 1) as { row_number: number; raw_json: string; normalized_json: string | null; errors_json: string }[]
      : db.prepare("SELECT row_number,result_json FROM csv_import_outcomes WHERE batch_id=? AND row_number>? ORDER BY row_number LIMIT ?").all(result.batch_id, offset, limit + 1) as { row_number: number; result_json: string }[];
    const manifest = view === "rows" ? readCsvManifest(db, result.batch_id) : null;
    const items: Record<string, unknown>[] = []; let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const stored = "raw_json" in row ? exactStoredObject(row.raw_json, ["source", "outcome"]) : exactStoredObject(row.result_json, ["receipt", "resolution"]);
      const value = "raw_json" in row ? { row: row.row_number, source: stored.source, outcome: stored.outcome, command: row.normalized_json ? parseStrictJson(row.normalized_json) : null,
        errors: parseStrictJson(row.errors_json), requires_review: manifest!.required_review_rows.includes(row.row_number) }
        : { row: row.row_number, receipt: stored.receipt, resolution: stored.resolution };
      const size = Buffer.byteLength(JSON.stringify(value), "utf8");
      if (bytes + size > CSV_BACKGROUND_QUERY_LIMITS.response_bytes - 65536) { if (!items.length) throw new Error("CSV_BACKGROUND_RESPONSE_TOO_LARGE"); break; }
      items.push(value); bytes += size;
    }
    const last = items.at(-1)?.row as number | undefined;
    demand(!rows.length || items.length > 0);
    return bounded({ ...common, ...identity, view, total: result.row_count, receipts_hash: view === "receipts" ? result.receipts_hash : null, items,
      next_cursor: last !== undefined && last < result.row_count ? encode(scope, last) : null });
  };
  return db.inTransaction ? read() : db.transaction(read).deferred();
}
