import type Database from "better-sqlite3";
import { z } from "zod";
import { assertWritableDatabase } from "../workbench-db";
import { parseStrictJson } from "../strict-json";
import { canonical, hash, revision } from "../ledger/service";
import { readCsvManifest } from "../ledger/csv-import-evidence";
import { assertCsvBackgroundJob, csvBackgroundIdSchema as id, csvBackgroundStamp, readCsvBackgroundRequest, readCsvBackgroundResult } from "./binding";
import type { CsvBackgroundJobRow, CsvBackgroundOptions, CsvBackgroundPrincipal } from "./types";
import type { CsvBackgroundPage, CsvBackgroundPreviewMetadata, CsvBackgroundReceiptItem, CsvBackgroundRowItem, CsvBackgroundSummary } from "./query-types";

export const CSV_BACKGROUND_QUERY_LIMITS = Object.freeze({ list: 20, rows: 25, candidates: 100, receipts: 25, response_bytes: 8 * 1024 * 1024 });
export const csvBackgroundCandidateKindSchema = z.enum(["exact_event_ids", "possible_event_ids", "exact_prior_rows", "possible_prior_rows"]);
export const csvBackgroundQuerySchema = z.object({ portfolio_id: id, request_id: id.optional(), view: z.enum(["status", "preview", "rows", "candidates", "receipts"]).optional(),
  cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(100).optional(), row: z.number().int().min(1).max(10000).optional(), kind: csvBackgroundCandidateKindSchema.optional(),
  review_only: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  const invalid = () => context.addIssue({ code: z.ZodIssueCode.custom, message: "CSV_BACKGROUND_QUERY_INVALID" });
  if (!value.request_id && (value.view || value.row !== undefined || value.kind)) invalid();
  if (value.request_id && (!value.view || value.view === "status" || value.view === "preview") && (value.cursor || value.limit !== undefined || value.row !== undefined || value.kind)) invalid();
  if (value.view === "candidates" ? value.row === undefined || !value.kind : value.row !== undefined || value.kind !== undefined) invalid();
  if (value.review_only !== undefined && value.view !== "rows") invalid();
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
function summary(db: Database.Database, binding: ReturnType<typeof readCsvBackgroundRequest>, now: string, options: CsvBackgroundOptions): CsvBackgroundSummary {
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
export function queryCsvBackground(db: Database.Database, principal: CsvBackgroundPrincipal, input: CsvBackgroundQuery, options: CsvBackgroundOptions = {}): CsvBackgroundPage {
  const who = principalSchema.safeParse(principal), parsed = csvBackgroundQuerySchema.safeParse(input);
  if (!who.success) throw new Error("CSV_BACKGROUND_PRINCIPAL_INVALID");
  if (!parsed.success) throw new Error("CSV_BACKGROUND_QUERY_INVALID");
  const query = parsed.data, now = csvBackgroundStamp(options.now);
  const read = (): CsvBackgroundPage => {
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
    const identity = { request_id: query.request_id, result_hash: item.result_hash, batch_id: result.batch_id, preview_hash: result.preview_hash, review_hash: result.review_hash };
    if (view === "preview") {
      const manifest = readCsvManifest(db, result.batch_id);
      const batch = db.prepare("SELECT status,confirmed_revision FROM import_batches WHERE id=? AND portfolio_id=?").get(result.batch_id, query.portfolio_id) as { status: string; confirmed_revision: number | null } | undefined;
      const attachment = db.prepare("SELECT content_hash FROM attachments WHERE id=?").get(manifest.mapping_attachment_id) as { content_hash: string } | undefined;
      demand(batch && ["preview", "invalid", "confirmed"].includes(batch.status)); demand(attachment && /^[a-f0-9]{64}$/.test(attachment.content_hash));
      const preview: CsvBackgroundPreviewMetadata = {
        account_id: binding.row.account_id, expected_revision: result.expected_revision, current_revision: revision(db, query.portfolio_id),
        batch_status: batch.status as CsvBackgroundPreviewMetadata["batch_status"], confirmed_revision: batch.confirmed_revision,
        original_filename: manifest.original_filename, attachment_id: manifest.attachment_id, content_hash: manifest.content_hash,
        mapping_version_id: manifest.mapping_version_id, mapping_id: manifest.mapping_id, mapping_version: manifest.mapping_version, mapping_hash: manifest.mapping_hash,
        mapping_attachment_id: manifest.mapping_attachment_id, mapping_attachment_hash: attachment.content_hash,
        parser_version: manifest.parser_version, mapper_version: manifest.mapper_version, headers: manifest.headers, document_errors: manifest.document_errors,
        warnings: manifest.warnings, broker_format_verified: false, row_count: result.row_count, error_count: result.error_count, required_review_count: result.required_review_count,
      };
      return bounded({ ...common, ...identity, view, preview });
    }
    const reviewOnly = view === "rows" && query.review_only === true;
    const scope = { actor: who.data.actorId, portfolio: query.portfolio_id, request: query.request_id, result_hash: item.result_hash, view, row: query.row ?? null, kind: query.kind ?? null,
      ...(view === "rows" ? { review_only: reviewOnly } : {}) };
    const after = decode(query.cursor, scope); if (after !== null && typeof after !== "number") throw new Error("CSV_BACKGROUND_CURSOR_INVALID");
    const offset = after ?? 0;
    if (view === "candidates") {
      const manifest = readCsvManifest(db, result.batch_id), candidate = manifest.candidates.find(value => value.row === query.row);
      if (!candidate) throw new Error("CSV_BACKGROUND_ROW_NOT_FOUND");
      const values = candidate[query.kind!]; if (offset > values.length) throw new Error("CSV_BACKGROUND_CURSOR_INVALID");
      const items = values.slice(offset, offset + limit), next = offset + items.length;
      return bounded({ ...common, ...identity, view, row: query.row!, kind: query.kind!, total: values.length, items, next_cursor: next < values.length ? encode(scope, next) : null });
    }
    if (view === "receipts" && (binding.row.operation !== "confirm" || result.batch_status !== "confirmed" || !result.receipts_hash)) throw new Error("CSV_BACKGROUND_RECEIPTS_UNAVAILABLE");
    if (offset > result.row_count) throw new Error("CSV_BACKGROUND_CURSOR_INVALID");
    const manifest = view === "rows" ? readCsvManifest(db, result.batch_id) : null;
    const rows = view === "rows"
      ? db.prepare(`SELECT row_number,raw_json,normalized_json,errors_json FROM import_rows WHERE batch_id=? AND row_number>?${reviewOnly ? " AND row_number IN (SELECT value FROM json_each(?))" : ""} ORDER BY row_number LIMIT ?`)
        .all(result.batch_id, offset, ...(reviewOnly ? [canonical(manifest!.required_review_rows)] : []), limit + 1) as { row_number: number; raw_json: string; normalized_json: string | null; errors_json: string }[]
      : db.prepare("SELECT row_number,result_json FROM csv_import_outcomes WHERE batch_id=? AND row_number>? ORDER BY row_number LIMIT ?").all(result.batch_id, offset, limit + 1) as { row_number: number; result_json: string }[];
    const candidates = new Map(manifest?.candidates.map(candidate => [candidate.row, candidate]));
    const required = new Set(manifest?.required_review_rows);
    const items: (CsvBackgroundRowItem | CsvBackgroundReceiptItem)[] = []; let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const stored = "raw_json" in row ? exactStoredObject(row.raw_json, ["source", "outcome"]) : exactStoredObject(row.result_json, ["receipt", "resolution"]);
      let value: CsvBackgroundRowItem | CsvBackgroundReceiptItem;
      if ("raw_json" in row) {
        const candidate = candidates.get(row.row_number); demand(candidate);
        value = { row: row.row_number, source: stored.source as CsvBackgroundRowItem["source"], outcome: stored.outcome as CsvBackgroundRowItem["outcome"],
          command: row.normalized_json ? parseStrictJson(row.normalized_json) as CsvBackgroundRowItem["command"] : null, errors: parseStrictJson(row.errors_json) as string[],
          requires_review: required.has(row.row_number), missing_source_id: candidate.missing_source_id,
          candidate_counts: { exact_event_ids: candidate.exact_event_ids.length, possible_event_ids: candidate.possible_event_ids.length,
            exact_prior_rows: candidate.exact_prior_rows.length, possible_prior_rows: candidate.possible_prior_rows.length } };
      } else value = { row: row.row_number, receipt: stored.receipt as CsvBackgroundReceiptItem["receipt"], resolution: stored.resolution as CsvBackgroundReceiptItem["resolution"] };
      const size = Buffer.byteLength(JSON.stringify(value), "utf8");
      if (bytes + size > CSV_BACKGROUND_QUERY_LIMITS.response_bytes - 65536) { if (!items.length) throw new Error("CSV_BACKGROUND_RESPONSE_TOO_LARGE"); break; }
      items.push(value); bytes += size;
    }
    const last = items.at(-1)?.row;
    demand(!rows.length || items.length > 0);
    const next_cursor = last !== undefined && rows.length > items.length ? encode(scope, last) : null;
    return view === "rows"
      ? bounded({ ...common, ...identity, view, review_only: reviewOnly, total: reviewOnly ? result.required_review_count : result.row_count,
        receipts_hash: null, items: items as CsvBackgroundRowItem[], next_cursor })
      : bounded({ ...common, ...identity, view: "receipts", total: result.row_count, receipts_hash: result.receipts_hash!, items: items as CsvBackgroundReceiptItem[], next_cursor });
  };
  return db.inTransaction ? read() : db.transaction(read).deferred();
}
