import { z } from "zod";
import { parseStrictJson } from "../../server/strict-json";
import type { CsvConfirmationRecoveryDetailResponse, CsvConfirmationRecoveryListResponse } from "../../server/ledger/csv-confirmation-recovery-types";

const INVALID = "CSV_RECOVERY_RESPONSE_INVALID", SESSION_CHANGED = "CSV_RECOVERY_SESSION_CHANGED";
const PAYLOAD_BYTES = 5 * 1024 * 1024, DETAIL_BYTES = 24 * 1024 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const integer = z.number().int().safe().nonnegative();
const id = z.string().min(1).max(160), hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/)
  .refine(value => !value.startsWith("0000") && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const status = z.enum(["preview", "invalid", "confirmed", "cancelled"]);
const summary = z.object({
  id, portfolio_id: id, account_id: id, batch_id: id, preview_hash: hash, expected_revision: integer,
  payload_hash: hash, payload_bytes: integer.min(1).max(PAYLOAD_BYTES), created_at: instant,
  batch_status: status, current_revision: integer, confirmed_revision: integer.nullable(),
}).strict();
const listSchema = z.object({
  schema_version: z.literal("csv-confirmation-recovery-v1"), session_binding: hash,
  attempts: z.array(summary).max(20), next_cursor: z.string().min(1).max(1024).nullable(), read_only: z.boolean(),
}).strict();
const receipt = z.object({ event_id: id, audit_id: id, revision: integer,
  warnings: z.array(z.string().max(128)).max(16), duplicate: z.boolean().optional() }).strict();
const detailSchema = z.object({
  schema_version: z.literal("csv-confirmation-recovery-v1"), session_binding: hash, attempt: summary,
  payload_text: z.string().min(1).max(PAYLOAD_BYTES), read_only: z.boolean(),
  batch: z.object({ id, portfolio_id: id, account_id: id, status, parser_version: z.literal("csv-v1"), preview_hash: hash,
    expected_revision: integer, confirmed_revision: integer.nullable(), row_count: integer.max(10000) }).strict(),
  confirmation: z.discriminatedUnion("status", [
    z.object({ status: z.literal("unconfirmed"), attempt_matches: z.null() }).strict(),
    z.object({ status: z.literal("confirmed"), attempt_matches: z.boolean(), revision: integer,
      receipts: z.array(receipt).min(1).max(10000), duplicate: z.literal(true) }).strict(),
  ]),
  review_error: z.enum(["CSV_REVIEW_INVALID", "CSV_REVIEW_HASH_MISMATCH", "CSV_REVIEW_ROW_INVALID", "CSV_REVIEW_ROWS_MISMATCH", "CSV_REVIEW_LINK_NOT_EXACT", "CSV_ROW_REQUIRES_LINK"]).nullable(),
}).strict();
const envelope = z.object({ action: z.literal("confirm_import"), portfolio_id: id, batch_id: id, preview_hash: hash,
  expected_revision: integer, csv_review: z.unknown().optional() }).strict();
const rowNumber = integer.min(1).max(10000), reason = z.string().min(1).max(2000).refine(value => !!value.trim());
const row = z.discriminatedUnion("action", [
  z.object({ row: rowNumber, action: z.literal("record_distinct"), reason }).strict(),
  z.object({ row: rowNumber, action: z.literal("link_existing"), reason, event_id: id }).strict(),
  z.object({ row: rowNumber, action: z.literal("link_prior_row"), reason, prior_row: rowNumber }).strict(),
]);
const reviewSchema = z.object({ acknowledge_unverified_mapping: z.literal(true), review_hash: hash, rows: z.array(row).max(10000) }).strict();
type Review = z.infer<typeof reviewSchema>;
export interface CsvRecoveredResolutionDraft { action: "" | "record_distinct" | "link_existing" | "link_prior_row"; reason: string; event_id: string; prior_row: string }

function demand(value: unknown): asserts value { if (!value) throw new Error(INVALID); }
function invalid(error: unknown): never {
  if (error instanceof Error && error.message === SESSION_CHANGED) throw error;
  throw new Error(INVALID);
}
function bindSession(value: unknown, expected: string) {
  demand(hash.safeParse(expected).success && value !== null && typeof value === "object" && !Array.isArray(value));
  const binding = (value as Record<string, unknown>).session_binding;
  demand(hash.safeParse(binding).success);
  if (binding !== expected) throw new Error(SESSION_CHANGED);
}
function rawPayload(text: string) {
  const bytes = encoder.encode(text);
  demand(bytes.length > 0 && bytes.length <= PAYLOAD_BYTES && decoder.decode(bytes) === text);
  return { bytes, value: envelope.parse(parseStrictJson(text.startsWith("\ufeff") ? text.slice(1) : text)) };
}
function structuredReview(value: unknown): Review | null {
  const parsed = reviewSchema.safeParse(value); if (!parsed.success) return null;
  const rows = parsed.data.rows;
  if (new Set(rows.map(item => item.row)).size !== rows.length || rows.some(item => item.action === "link_prior_row" && item.prior_row >= item.row)) return null;
  return parsed.data;
}
function checkSummary(value: z.infer<typeof summary>) {
  demand(value.current_revision >= value.expected_revision);
  if (value.batch_status === "confirmed") demand(value.confirmed_revision !== null && value.confirmed_revision >= value.expected_revision && value.confirmed_revision <= value.current_revision);
  else demand(value.confirmed_revision === null);
}
function parseCursor(cursor: string) {
  demand(/^[A-Za-z0-9_-]+$/.test(cursor));
  const raw = atob(cursor.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - cursor.length % 4) % 4));
  const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
  const value = z.object({ created_at: instant, id }).strict().parse(parseStrictJson(decoder.decode(bytes)));
  const canonicalBytes = encoder.encode(JSON.stringify(value));
  const canonical = btoa(String.fromCharCode(...canonicalBytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  demand(canonical === cursor);
  return value;
}

export function parseCsvRecoveryList(value: unknown, sessionBinding: string): CsvConfirmationRecoveryListResponse {
  try {
    bindSession(value, sessionBinding); demand(encoder.encode(JSON.stringify(value)).length <= 256 * 1024);
    const result = listSchema.parse(value), seen = new Set<string>();
    for (const [index, item] of result.attempts.entries()) {
      checkSummary(item); demand(!seen.has(item.id)); seen.add(item.id);
      const previous = result.attempts[index - 1];
      if (previous) demand(previous.created_at > item.created_at || previous.created_at === item.created_at && previous.id > item.id);
    }
    if (result.next_cursor !== null) {
      const cursor = parseCursor(result.next_cursor), last = result.attempts.at(-1);
      demand(last && cursor.id === last.id && cursor.created_at === last.created_at);
    }
    return result;
  } catch (error) { return invalid(error); }
}

export async function parseCsvRecoveryDetail(value: unknown, sessionBinding: string): Promise<CsvConfirmationRecoveryDetailResponse> {
  try {
    bindSession(value, sessionBinding); demand(encoder.encode(JSON.stringify(value)).length <= DETAIL_BYTES);
    const result = detailSchema.parse(value), { attempt, batch, confirmation } = result;
    checkSummary(attempt);
    demand(batch.id === attempt.batch_id && batch.portfolio_id === attempt.portfolio_id && batch.account_id === attempt.account_id
      && batch.status === attempt.batch_status && batch.preview_hash === attempt.preview_hash
      && batch.expected_revision === attempt.expected_revision && batch.confirmed_revision === attempt.confirmed_revision);
    const payload = rawPayload(result.payload_text);
    demand(payload.bytes.length === attempt.payload_bytes);
    const digest = await crypto.subtle.digest("SHA-256", payload.bytes);
    demand([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("") === attempt.payload_hash);
    demand(payload.value.portfolio_id === attempt.portfolio_id && payload.value.batch_id === attempt.batch_id
      && payload.value.preview_hash === attempt.preview_hash && payload.value.expected_revision === attempt.expected_revision);
    if (!structuredReview(payload.value.csv_review)) demand(result.review_error !== null);
    if (batch.status === "confirmed") {
      demand(confirmation.status === "confirmed" && batch.row_count > 0);
      demand(confirmation.revision === batch.confirmed_revision && confirmation.receipts.length === batch.row_count);
      demand(confirmation.receipts.every(item => item.revision <= confirmation.revision));
      if (confirmation.attempt_matches) demand(result.review_error === null);
    } else demand(confirmation.status === "unconfirmed");
    return result;
  } catch (error) { return invalid(error); }
}

/** Drafts are an audit reconstruction only; retries must use the unchanged retained payload. */
export function recoveryResolutionDrafts(payload: string): { drafts: Record<number, CsvRecoveredResolutionDraft>; acknowledged: boolean } {
  try {
    const review = structuredReview(rawPayload(payload).value.csv_review);
    if (!review) return { drafts: {}, acknowledged: false };
    const drafts: Record<number, CsvRecoveredResolutionDraft> = {};
    for (const item of review.rows) drafts[item.row] = { action: item.action, reason: item.reason,
      event_id: item.action === "link_existing" ? item.event_id : "", prior_row: item.action === "link_prior_row" ? String(item.prior_row) : "" };
    return { drafts, acknowledged: true };
  } catch { return { drafts: {}, acknowledged: false }; }
}
