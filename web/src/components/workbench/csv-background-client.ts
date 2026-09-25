import { z } from "zod";
import { parseStrictJson } from "@/server/strict-json";
import { csvMappingSchema } from "@/server/ledger/csv-schemas";
import type { LedgerCommand } from "@/server/ledger/service";
import type { CsvMappedRow } from "@/server/ledger/csv-mapping";
import type { CsvBackgroundQuery } from "@/server/csv-background/queries";
import type { CsvBackgroundPage, CsvBackgroundSummary, CsvBackgroundRowItem } from "@/server/csv-background/query-types";
import type { CsvBackgroundReceipt, CsvBackgroundCancelReceipt } from "@/server/csv-background/types";

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().safe().nonnegative(), rowNumber = integer.min(1).max(10000);
const stamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).refine(value => !value.startsWith("0000") && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19));
const cursor = z.string().min(1).max(2048).nullable(), operation = z.enum(["preview", "confirm"]), batchStatus = z.enum(["preview", "invalid", "confirmed"]);
const warnings = z.array(z.string().max(4096)).max(1024), candidateKind = z.enum(["exact_event_ids", "possible_event_ids", "exact_prior_rows", "possible_prior_rows"]);
const resultSchema = z.object({ schema_version: z.literal("csv-background-result-v1"), request_id: id, operation, input_hash: hash,
  batch_id: id, preview_hash: hash, expected_revision: integer, batch_status: batchStatus, row_count: integer.max(10000), error_count: integer.max(10001),
  review_hash: hash, required_review_count: integer.max(10000), confirmed_revision: integer.nullable(), receipts_hash: hash.nullable() }).strict();
const jobStatus = z.enum(["queued", "running", "retry_queued", "succeeded", "failed", "partial", "skipped", "cancelled"]);
const summarySchema = z.object({ request_id: id, portfolio_id: id, account_id: id, operation, input_hash: hash, expected_revision: integer,
  created_at: stamp, expires_at: stamp, status: z.enum([...jobStatus.options, "expired"]),
  job: z.object({ id, status: jobStatus, attempt_count: integer.max(3), max_attempts: z.literal(3), updated_at: stamp }).strict().nullable(),
  attempts: z.array(z.object({ attempt: integer.min(1).max(3), status: z.enum(["running", "succeeded", "partial", "failed", "skipped", "lease_expired", "cancelled"]),
    started_at: stamp, finished_at: stamp.nullable(), error_code: z.string().min(1).max(100).regex(/^[A-Z_]+$/).nullable() }).strict()).max(3),
  cancelled_at: stamp.nullable(), result_hash: hash.nullable(), result: resultSchema.nullable() }).strict();
const location = { record_number: integer.positive(), line_start: integer.positive(), line_end: integer.positive(), byte_start: integer, byte_end: integer };
const issue = z.object({ code: z.string().min(1).max(160), column: integer.optional(), field: z.string().max(256).optional() }).strict();
const documentIssue = issue.extend(Object.fromEntries(Object.entries(location).map(([key, value]) => [key, value.optional()]))).strict();
// Browser projection only: no AJV runtime code generation or server database imports.
// Accounting semantics and the complete immutable evidence remain independently proved on the server.
const decimal = z.string().regex(/^-?(?=(?:[0-9]\.?){1,38}$)(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/), currency = z.string().regex(/^[A-Z]{3}$/);
const factBase = { account_id: id, currency };
const fact = z.union([
  z.object({ ...factBase, type: z.enum(["opening_cash", "deposit", "withdrawal", "fee"]), amount: decimal }).strict(),
  z.object({ ...factBase, type: z.literal("opening_position"), listing_id: id, quantity: decimal, cost_amount: decimal.optional() }).strict(),
  z.object({ ...factBase, type: z.enum(["buy", "sell"]), listing_id: id, quantity: decimal, price: decimal.optional(), consideration: decimal.optional(), fee: decimal.optional() }).strict().refine(value => value.price !== undefined || value.consideration !== undefined),
  z.object({ ...factBase, type: z.literal("settlement"), direction: z.enum(["buy", "sell"]), related_event_id: id, amount: decimal }).strict(),
  z.object({ ...factBase, type: z.enum(["dividend_accrual", "dividend"]), amount: decimal, tax: decimal.optional(), tax_status: z.enum(["unknown", "estimated", "confirmed"]).optional(), listing_id: id.optional() }).strict()
    .refine(value => value.tax_status === "unknown" ? value.tax === undefined : value.tax_status === "estimated" || value.tax_status === "confirmed" ? value.tax !== undefined : true),
  z.object({ ...factBase, type: z.literal("dividend_payment"), related_event_id: id, amount: decimal, listing_id: id.optional() }).strict(),
  z.object({ ...factBase, type: z.literal("transfer_in"), related_event_id: id, amount: decimal }).strict(),
  z.object({ ...factBase, type: z.literal("fx"), target_currency: currency, target_account_id: id.optional(), amount: decimal, received_amount: decimal, fee: decimal.optional() }).strict(),
  z.object({ ...factBase, type: z.literal("transfer_out"), target_account_id: id, amount: decimal, fee: decimal.optional() }).strict(),
  z.object({ ...factBase, type: z.literal("split"), listing_id: id, split_numerator: decimal, split_denominator: decimal }).strict(),
]);
const mappedFields = { source_id: id, source_event_id: id.optional(), effective_at: z.string().min(1).max(40), time_precision: z.enum(["date", "second"]),
  source_timezone: z.string().min(1).max(80), reason: z.string().min(1).max(4000).refine(value => [...value].length <= 2000), fact };
const mappedCommand: z.ZodType<NonNullable<CsvMappedRow["command"]>> = z.object(mappedFields).strict();
const commandSchema: z.ZodType<LedgerCommand> = z.object({ ...mappedFields, portfolio_id: id, expected_revision: integer, idempotency_key: id }).strict();
const source = z.object({ ...location, cells: z.array(z.string().max(65536)).max(128), formula_columns: z.array(integer.min(1).max(128)).max(128),
  errors: z.array(issue).max(1024), command: mappedCommand.nullable(), warnings: z.array(issue).max(1024) }).strict();
const rowSchema = z.object({ row: rowNumber, source, outcome: z.object({ kind: z.enum(["new", "already_recorded", "same_file_row", "link_only", "invalid"]),
  event_id: id.optional(), prior_row: rowNumber.optional(), warnings }).strict(), command: commandSchema.nullable(), errors: warnings,
  requires_review: z.boolean(), missing_source_id: z.boolean(), candidate_counts: z.object({ exact_event_ids: integer, possible_event_ids: integer,
    exact_prior_rows: integer.max(9999), possible_prior_rows: integer.max(9999) }).strict() }).strict();
const reason = z.string().min(1).max(2000).refine(value => !!value.trim());
const resolution = z.discriminatedUnion("action", [
  z.object({ row: rowNumber, action: z.literal("record_distinct"), reason }).strict(),
  z.object({ row: rowNumber, action: z.literal("link_existing"), event_id: id, reason }).strict(),
  z.object({ row: rowNumber, action: z.literal("link_prior_row"), prior_row: rowNumber, reason }).strict(),
]);
const receipt = z.object({ event_id: id, revision: integer, audit_id: id, warnings, duplicate: z.boolean().optional() }).strict();
const common = { schema_version: z.literal("csv-background-page-v1"), portfolio_id: id, server_now: stamp, read_only: z.boolean(), session_binding: hash };
const identity = { request_id: id, result_hash: hash, batch_id: id, preview_hash: hash, review_hash: hash };
const pageSchema = z.discriminatedUnion("view", [
  z.object({ ...common, view: z.literal("list"), items: z.array(summarySchema).max(20), next_cursor: cursor }).strict(),
  z.object({ ...common, view: z.literal("status"), item: summarySchema }).strict(),
  z.object({ ...common, ...identity, view: z.literal("preview"), preview: z.object({ account_id: id, expected_revision: integer, current_revision: integer,
    batch_status: batchStatus, confirmed_revision: integer.nullable(), original_filename: z.string().min(1).max(200), attachment_id: id, content_hash: hash,
    mapping_version_id: id, mapping_id: z.string().min(1).max(120), mapping_version: integer.positive(), mapping_hash: hash, mapping_attachment_id: id, mapping_attachment_hash: hash,
    parser_version: z.literal("strict-csv-utf8-v1"), mapper_version: z.literal("explicit-csv-mapping-v1"), headers: z.array(z.string().max(65536)).max(128), document_errors: z.array(documentIssue).max(10001),
    warnings, broker_format_verified: z.literal(false), row_count: integer.max(10000), error_count: integer.max(10001), required_review_count: integer.max(10000) }).strict() }).strict(),
  z.object({ ...common, ...identity, view: z.literal("rows"), review_only: z.boolean(), total: integer.max(10000), receipts_hash: z.null(),
    items: z.array(rowSchema).max(25), next_cursor: cursor }).strict(),
  z.object({ ...common, ...identity, view: z.literal("candidates"), row: rowNumber, kind: candidateKind, total: integer,
    items: z.array(z.union([id, rowNumber])).max(100), next_cursor: cursor }).strict(),
  z.object({ ...common, ...identity, view: z.literal("receipts"), total: integer.max(10000), receipts_hash: hash,
    items: z.array(z.object({ row: rowNumber, receipt, resolution: resolution.nullable() }).strict()).max(25), next_cursor: cursor }).strict(),
]);
const encoder = new TextEncoder();
function invalid(): never { throw new Error("CSV_BACKGROUND_RESPONSE_INVALID"); }
function demand(value: unknown): asserts value { if (!value) invalid(); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function sha(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function decodeCursor(raw: string) {
  demand(/^[A-Za-z0-9_-]+$/.test(raw) && raw.length <= 2048);
  const binary = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
  demand(btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === raw);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
  const value = z.object({ scope: hash, after: z.union([integer, z.object({ created_at: stamp, id }).strict()]) }).strict().parse(parseStrictJson(text));
  demand(canonical(value) === text); return value;
}
async function verifySummary(value: CsvBackgroundSummary, portfolio: string) {
  demand(value.portfolio_id === portfolio && value.expires_at > value.created_at && Date.parse(value.expires_at) - Date.parse(value.created_at) === 900000);
  demand(value.attempts.length === (value.job?.attempt_count ?? 0) && value.attempts.every((attempt, index) => attempt.attempt === index + 1));
  demand((value.result === null) === (value.result_hash === null));
  if (!value.result) { demand(value.status !== "succeeded" && value.job?.status !== "succeeded"); return; }
  const result = value.result;
  const last = value.attempts.at(-1);
  demand(value.status === "succeeded" && value.cancelled_at === null && value.job?.status === "succeeded" && last?.status === "succeeded"
    && last.finished_at === value.job.updated_at && last.error_code === null && last.started_at >= value.created_at
    && last.started_at <= last.finished_at && last.finished_at < value.expires_at);
  demand(await sha(canonical(result)) === value.result_hash && result.request_id === value.request_id && result.operation === value.operation
    && result.input_hash === value.input_hash && result.expected_revision === value.expected_revision && result.required_review_count <= result.row_count);
  demand(result.operation === "confirm" ? result.batch_status === "confirmed" && result.confirmed_revision !== null && result.confirmed_revision >= result.expected_revision && result.receipts_hash !== null
    : result.batch_status !== "confirmed" && result.confirmed_revision === null && result.receipts_hash === null);
}

export type CsvBackgroundFetchOptions = { sessionBinding: string; isCurrent: () => boolean; signal?: AbortSignal;
  expected?: CsvBackgroundSummary; expectedRow?: CsvBackgroundRowItem };
export async function assertCsvBackgroundPage(raw: unknown, query: CsvBackgroundQuery, binding: string,
  expected?: CsvBackgroundSummary, expectedRow?: CsvBackgroundRowItem): Promise<CsvBackgroundPage> {
  try {
    const page = pageSchema.parse(raw), view = query.request_id ? query.view ?? "status" : "list";
    demand(page.session_binding === binding && page.portfolio_id === query.portfolio_id && page.view === view);
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const next = "next_cursor" in page && page.next_cursor ? decodeCursor(page.next_cursor) : null;
    if (after && next) demand(after.scope === next.scope && query.cursor !== (page as { next_cursor: string }).next_cursor);
    if (page.view === "list") {
      demand(page.items.length <= (query.limit ?? 10) && new Set(page.items.map(item => item.request_id)).size === page.items.length);
      let previous = after?.after ?? null;
      for (const item of page.items) {
        demand(previous === null || typeof previous !== "number" && (item.created_at < previous.created_at || item.created_at === previous.created_at && item.request_id < previous.id));
        await verifySummary(item, query.portfolio_id); previous = { created_at: item.created_at, id: item.request_id };
      }
      if (next) demand(page.items.length > 0 && canonical(next.after) === canonical(previous));
    } else if (page.view === "status") {
      demand(page.item.request_id === query.request_id); await verifySummary(page.item, query.portfolio_id);
    } else {
      demand(expected && expected.result && expected.result_hash); await verifySummary(summarySchema.parse(expected), query.portfolio_id);
      const result = expected.result;
      demand(page.request_id === query.request_id && expected.request_id === query.request_id && page.result_hash === expected.result_hash
        && page.batch_id === result.batch_id && page.preview_hash === result.preview_hash && page.review_hash === result.review_hash);
      if (page.view === "preview") {
        const data = page.preview;
        demand(data.account_id === expected.account_id && data.expected_revision === result.expected_revision && data.current_revision >= data.expected_revision
          && data.row_count === result.row_count && data.error_count === result.error_count && data.required_review_count === result.required_review_count);
        demand(data.batch_status === "confirmed" ? data.confirmed_revision !== null && data.confirmed_revision >= data.expected_revision && data.confirmed_revision <= data.current_revision
          : data.confirmed_revision === null && data.batch_status === result.batch_status);
        if (expected.operation === "confirm") demand(data.batch_status === "confirmed" && data.confirmed_revision === result.confirmed_revision);
      } else {
        demand(page.items.length <= (query.limit ?? (page.view === "candidates" ? 20 : 25)) && page.items.length <= page.total);
        demand(after === null || typeof after.after === "number");
        const start = typeof after?.after === "number" ? after.after : 0;
        if (page.view === "candidates") {
          demand(page.row === query.row && page.kind === query.kind && page.row <= result.row_count && start <= page.total);
          const prior = page.kind.endsWith("prior_rows");
          demand(page.items.every(item => prior ? typeof item === "number" && item < page.row : typeof item === "string") && new Set(page.items).size === page.items.length);
          if (expectedRow) demand(expectedRow.row === page.row && expectedRow.candidate_counts[page.kind] === page.total);
          demand(start + page.items.length <= page.total && (next !== null) === (start + page.items.length < page.total));
          if (next) demand(next.after === start + page.items.length && page.items.length > 0);
        } else {
          demand(page.total === (page.view === "rows" && page.review_only ? result.required_review_count : result.row_count));
          if (page.view === "rows") demand(page.review_only === (query.review_only ?? false));
          else demand(expected.operation === "confirm" && page.receipts_hash === result.receipts_hash);
          let previous = start;
          for (const item of page.items) {
            demand(item.row > previous && item.row <= result.row_count); previous = item.row;
            if (page.view === "rows" && "source" in item) {
              demand(!page.review_only || item.requires_review);
              demand(item.source.line_end >= item.source.line_start && item.source.byte_end >= item.source.byte_start);
              demand(new Set(item.source.formula_columns).size === item.source.formula_columns.length && item.source.formula_columns.every(column => column <= item.source.cells.length));
              if (item.command) demand(item.command.portfolio_id === query.portfolio_id && item.command.expected_revision === result.expected_revision);
              demand((item.source.command === null) === (item.command === null));
              if (item.command) {
                const { portfolio_id: _p, expected_revision: _r, idempotency_key: _i, ...mapped } = item.command;
                demand(canonical(mapped) === canonical(item.source.command));
              }
            } else if ("receipt" in item) {
              demand(item.receipt.revision <= result.confirmed_revision! && (item.resolution === null || item.resolution.row === item.row));
              if (item.resolution?.action === "link_prior_row") demand(item.resolution.prior_row < item.row);
            }
          }
          if (next) demand(page.items.length > 0 && next.after === previous && previous < result.row_count);
          // Filtered rows need not be contiguous; the server proves the full sealed manifest before projection.
          if (page.view === "receipts" || !page.review_only) {
            demand(page.items.every((item, index) => item.row === start + index + 1));
            demand((next !== null) === (previous < result.row_count));
          }
        }
      }
    }
    return page as CsvBackgroundPage;
  } catch { return invalid(); }
}

const previewInput = z.object({ portfolioId: id, accountId: id, revision: integer, mapping: z.string().min(1), idempotencyKey: id, acknowledge: z.literal(true) }).strict();
type PreviewInput = z.infer<typeof previewInput> & { file: File };
export type CsvBackgroundPreparedPreview = Readonly<z.infer<typeof previewInput> & { kind: "preview"; file: File; contentHash: string; inputHash: string; body: Blob; contentType: string; filenameBase64url: string }>;
export type CsvBackgroundPreparedConfirmation = Readonly<{ kind: "confirm"; portfolioId: string; accountId: string; idempotencyKey: string; payloadText: string; body: string; inputHash: string }>;
export type CsvBackgroundPreparedCancellation = Readonly<{ kind: "cancel"; portfolioId: string; requestId: string; body: string }>;
export type CsvBackgroundPrepared = CsvBackgroundPreparedPreview | CsvBackgroundPreparedConfirmation | CsvBackgroundPreparedCancellation;
function utf8(raw: string, maximum: number) {
  const bytes = encoder.encode(raw);
  if (!bytes.length || bytes.length > maximum || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== raw) throw new Error("CSV_BACKGROUND_INPUT_INVALID");
  return bytes;
}
export async function prepareCsvBackgroundPreview(input: PreviewInput): Promise<CsvBackgroundPreparedPreview> {
  const { file, ...rest } = input, value = previewInput.parse(rest);
  if (!(file instanceof File) || file.size < 1 || file.size > 4 * 1024 * 1024 || !file.name || file.name.length > 200 || /[\u0000-\u001f\u007f]/.test(file.name)) throw new Error("CSV_BACKGROUND_INPUT_INVALID");
  const filenameBytes = utf8(file.name, 800); utf8(value.mapping, 256 * 1024);
  csvMappingSchema.parse(parseStrictJson(value.mapping));
  const bytes = new Uint8Array(await file.arrayBuffer()), contentHash = await sha(bytes);
  const inputHash = await sha(canonical({ operation: "preview", portfolio_id: value.portfolioId, account_id: value.accountId, expected_revision: value.revision,
    input: { filename: file.name, mapping: value.mapping, csv_sha256: contentHash } }));
  // Native FormData string parts normalize LF to CRLF. Construct immutable wire bytes
  // instead, so multiline mapping JSON has the exact hash the server authorizes.
  const binary = new TextDecoder("latin1").decode(bytes);
  let boundary = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `csv-background-${crypto.randomUUID()}`;
    if (!binary.includes(candidate) && !value.mapping.includes(candidate) && !file.name.includes(candidate)) { boundary = candidate; break; }
  }
  if (!boundary) throw new Error("CSV_BACKGROUND_INPUT_INVALID");
  const part = (name: string, raw: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${raw}\r\n`;
  // Multipart filename decoding differs across runtimes, including literal %22.
  // Keep its header inert; the strict background-only header preserves original UTF-8.
  const filenameBase64url = btoa(String.fromCharCode(...filenameBytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const body = new Blob([part("portfolio_id", value.portfolioId), part("account_id", value.accountId), part("expected_revision", String(value.revision)), part("mapping", value.mapping),
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.csv"\r\nContent-Type: text/csv\r\n\r\n`, bytes, `\r\n--${boundary}--\r\n`]);
  return Object.freeze({ ...value, kind: "preview", file: new File([bytes], file.name, { type: "text/csv" }), contentHash, inputHash, body,
    contentType: `multipart/form-data; boundary=${boundary}`, filenameBase64url });
}
export async function prepareCsvBackgroundConfirmation(input: { portfolioId: string; accountId: string; idempotencyKey: string; payloadText: string; acknowledge: true }): Promise<CsvBackgroundPreparedConfirmation> {
  const value = z.object({ portfolioId: id, accountId: id, idempotencyKey: id, payloadText: z.string().min(1), acknowledge: z.literal(true) }).strict().parse(input);
  utf8(value.payloadText, 5 * 1024 * 1024);
  const payload = z.object({ action: z.literal("confirm_import"), portfolio_id: id, batch_id: id, preview_hash: hash, expected_revision: integer,
    csv_review: z.object({ acknowledge_unverified_mapping: z.literal(true), review_hash: hash, rows: z.array(resolution).max(10000) }).strict() }).strict().parse(parseStrictJson(value.payloadText.replace(/^\ufeff/, "")));
  if (payload.portfolio_id !== value.portfolioId || new Set(payload.csv_review.rows.map(row => row.row)).size !== payload.csv_review.rows.length
    || payload.csv_review.rows.some(row => row.action === "link_prior_row" && row.prior_row >= row.row)) throw new Error("CSV_BACKGROUND_INVALID_CONFIRMATION");
  const inputHash = await sha(canonical({ operation: "confirm", portfolio_id: value.portfolioId, account_id: value.accountId, expected_revision: payload.expected_revision,
    input: { payload_hash: await sha(value.payloadText) } }));
  const body = JSON.stringify({ action: "confirm", command: { portfolio_id: value.portfolioId, account_id: value.accountId, idempotency_key: value.idempotencyKey,
    payload_text: value.payloadText, acknowledge_background_execution: true } });
  return Object.freeze({ kind: "confirm", portfolioId: value.portfolioId, accountId: value.accountId, idempotencyKey: value.idempotencyKey, payloadText: value.payloadText, body, inputHash });
}
export function prepareCsvBackgroundCancellation(input: { portfolioId: string; requestId: string; reason: string }): CsvBackgroundPreparedCancellation {
  const value = z.object({ portfolioId: id, requestId: id, reason: z.string().refine(value => !!value.trim() && [...value].length <= 1000 && !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value)) }).strict().parse(input);
  return Object.freeze({ kind: "cancel", portfolioId: value.portfolioId, requestId: value.requestId,
    body: JSON.stringify({ action: "cancel", command: { portfolio_id: value.portfolioId, request_id: value.requestId, reason: value.reason } }) });
}
type DeadlineOptions = CsvBackgroundFetchOptions & { checkDeadline?: () => void };
function discard(response?: Response) {
  if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
}
function guard(options: DeadlineOptions, response?: Response) {
  try { options.checkDeadline?.(); } catch (error) { discard(response); throw error; }
  if (options.signal?.aborted || !options.isCurrent()) {
    discard(response);
    throw new Error("CSV_BACKGROUND_REQUEST_STALE");
  }
}
async function withinDeadline<T>(options: CsvBackgroundFetchOptions, run: (bounded: DeadlineOptions) => Promise<T>): Promise<T> {
  guard(options);
  const controller = new AbortController(), deadline = performance.now() + 30000;
  let finished = false, failure: Error | undefined, rejectOperation!: (error: Error) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectOperation = reject; });
  const stop = (error: Error) => {
    if (finished || failure) return;
    failure = error; controller.abort(); rejectOperation(error);
  };
  const timeout = () => stop(new Error("CSV_BACKGROUND_REQUEST_TIMEOUT"));
  const abort = () => stop(new Error("CSV_BACKGROUND_REQUEST_STALE"));
  const bounded: DeadlineOptions = { ...options, signal: controller.signal,
    isCurrent: () => !finished && !failure && performance.now() < deadline && options.isCurrent(),
    checkDeadline: () => { if (!failure && performance.now() >= deadline) timeout(); if (failure) throw failure; } };
  const timer = setTimeout(timeout, 30000);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) abort();
    // Race once for the complete operation, including both session probes and proof hashing.
    const value = await Promise.race([Promise.resolve().then(() => { guard(bounded); return run(bounded); }), interrupted]);
    guard(bounded); return value;
  } finally {
    finished = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); controller.abort();
  }
}
function sessionChanged(): never {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("workbench:session-invalidated"));
  throw new Error("UNAUTHENTICATED");
}
async function readJson(response: Response, options: DeadlineOptions, maximum = 8 * 1024 * 1024): Promise<unknown> {
  guard(options, response);
  if (response.status === 401) { discard(response); sessionChanged(); }
  if (!/application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "") || Number(response.headers.get("content-length") ?? 0) > maximum || !response.body) { discard(response); invalid(); }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true }), chunks: string[] = []; let size = 0;
  let cancelled = false;
  const cancel = () => { if (!cancelled) { cancelled = true; void reader.cancel().catch(() => {}); } };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    guard(options);
    while (true) {
      const { value, done } = await reader.read(); guard(options); if (done) break;
      size += value.byteLength; if (size > maximum) invalid(); chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (error) { cancel(); throw error; }
  finally { options.signal?.removeEventListener("abort", cancel); reader.releaseLock(); }
  const raw = parseStrictJson(chunks.join("")); guard(options);
  if (!response.ok) {
    const parsed = z.object({ error: z.string().min(1).max(100).regex(/^[A-Z_]+$/) }).strict().safeParse(raw);
    throw new Error(parsed.success ? parsed.data.error : "CSV_BACKGROUND_REQUEST_FAILED");
  }
  return raw;
}
async function verifySession(options: DeadlineOptions) {
  guard(options); hash.parse(options.sessionBinding);
  const response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin", signal: options.signal }); guard(options, response);
  const raw = await readJson(response, options, 4096); guard(options);
  const parsed = z.object({ authenticated: z.literal(true), session_binding: hash }).strict().safeParse(raw);
  if (!parsed.success || parsed.data.session_binding !== options.sessionBinding) sessionChanged();
}
export async function fetchCsvBackground(query: CsvBackgroundQuery, options: CsvBackgroundFetchOptions): Promise<CsvBackgroundPage> {
  return withinDeadline(options, async options => {
    guard(options);
    const params = new URLSearchParams({ portfolio: query.portfolio_id });
    for (const [key, value] of Object.entries(query)) if (key !== "portfolio_id" && value !== undefined) params.set(key === "request_id" ? "request" : key, String(value));
    await verifySession(options); guard(options);
    const response = await fetch(`/api/workbench/csv/jobs?${params}`, { cache: "no-store", credentials: "same-origin", headers: { "X-Workbench-Session-Binding": options.sessionBinding }, signal: options.signal }); guard(options, response);
    const raw = await readJson(response, options); guard(options);
    const page = await assertCsvBackgroundPage(raw, query, options.sessionBinding, options.expected, options.expectedRow); guard(options);
    await verifySession(options); guard(options); return page;
  });
}
export async function sendCsvBackground(prepared: CsvBackgroundPrepared, options: CsvBackgroundFetchOptions): Promise<CsvBackgroundReceipt | CsvBackgroundCancelReceipt> {
  return withinDeadline(options, async options => {
    guard(options); await verifySession(options); guard(options);
    const headers: Record<string, string> = { "X-Workbench-Session-Binding": options.sessionBinding };
    let body: BodyInit;
    if (prepared.kind === "preview") {
      headers["Content-Type"] = prepared.contentType;
      headers["X-CSV-Original-Filename"] = prepared.filenameBase64url;
      headers["X-CSV-Idempotency-Key"] = prepared.idempotencyKey; headers["X-CSV-Background-Acknowledged"] = "true"; body = prepared.body;
    } else { headers["Content-Type"] = "application/json"; body = prepared.body; }
    guard(options);
    const response = await fetch("/api/workbench/csv/jobs", { method: "POST", credentials: "same-origin", cache: "no-store", headers, body, signal: options.signal }); guard(options, response);
    const raw = await readJson(response, options, 4096); guard(options);
    const result = prepared.kind === "cancel"
      ? z.object({ request_id: z.literal(prepared.requestId), status: z.literal("cancelled"), session_binding: z.literal(options.sessionBinding) }).strict().safeParse(raw)
      : z.object({ request_id: id, status: z.literal("queued"), operation: z.literal(prepared.kind), input_hash: z.literal(prepared.inputHash), session_binding: z.literal(options.sessionBinding) }).strict().safeParse(raw);
    if (!result.success) invalid();
    await verifySession(options); guard(options); return result.data;
  });
}
