import { z } from "zod";
import { parseStrictJson } from "@/server/strict-json";
import type { MarketReferenceState } from "@/server/market-references/queries";

const id = z.string().min(1).max(160), digest = z.string().regex(/^[a-f0-9]{64}$/), instant = z.string().max(40), text = z.string().max(2000);
export const marketStateSchema = z.object({
  portfolios: z.array(z.object({ id, name: text }).strict()).max(1000), portfolios_truncated: z.boolean(), selected_portfolio_id: id.nullable(), ledger_revision: z.number().int().nonnegative().safe(), read_only: z.boolean(),
  sources: z.array(z.object({ id, reference: text, content_hash: digest, known_at: instant }).strict()).max(100), sources_truncated: z.boolean(),
  versions: z.array(z.object({ id, kind: z.enum(["mapping", "calendar"]), scope_key: id, version: z.number().int().positive().safe(), source_id: id, source_hash: digest, content_hash: digest, known_at: instant, audit_id: id, review_basis: z.literal("human_reviewed_not_provider_verified"), market: z.enum(["CN", "HK", "US"]), exchange: id, summary: text }).strict()).max(100), versions_truncated: z.boolean(),
  heads: z.array(z.object({ portfolio_id: id, kind: z.enum(["mapping", "calendar"]), scope_key: id, version: z.number().int().positive().safe(), version_id: id, updated_at: instant }).strict()).max(1000), heads_truncated: z.boolean(),
  listings: z.array(z.object({ id, market: text, exchange: text, ticker: text, currency: text }).strict()).max(1000), listings_truncated: z.boolean(), resource_hash: digest, review_basis: z.literal("human_reviewed_not_provider_verified"), session_binding: digest,
}).strict();
export function assertMarketState(value: unknown, portfolio: string | null, binding: string): asserts value is MarketReferenceState & { session_binding: string } {
  const parsed = marketStateSchema.safeParse(value);
  if (!parsed.success || parsed.data.session_binding !== binding || (portfolio !== null && parsed.data.selected_portfolio_id !== portfolio) || parsed.data.heads.some(row => row.portfolio_id !== parsed.data.selected_portfolio_id)) throw new Error("MARKET_RESPONSE_INVALID");
}
export type MarketDraft = { action: "store_source" | "publish_reference" | "collect_prices"; reference: string; raw: string; sourceId: string; expectedVersion: string; reason: string };
export const emptyMarketDraft = (): MarketDraft => ({ action: "store_source", reference: "", raw: "", sourceId: "", expectedVersion: "", reason: "" });
export type MarketPending = { body: string; endpoint: string; binding: string; portfolio: string; kind: MarketDraft["action"]; referenceKind: "mapping" | "calendar" | null; sourceHash: string | null; sourceId: string | null; scopeKey: string | null; version: number | null; payloadHash: string | null; byteHash: string };
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  throw new Error("MARKET_INVALID_JSON");
}
const sha = async (raw: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
export async function prepareMarketAttempt(state: MarketReferenceState, draft: MarketDraft, binding: string, key: string): Promise<MarketPending> {
  const portfolio = state.selected_portfolio_id;
  if (!portfolio || state.read_only || !digest.safeParse(binding).success || !key.trim()) throw new Error("MARKET_WRITE_LOCKED");
  let raw: unknown;
  try { raw = parseStrictJson(draft.raw); } catch { throw new Error("MARKET_INVALID_JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("MARKET_INVALID_JSON");
  let command: unknown, sourceHash: string | null = null, sourceId: string | null = null, scopeKey: string | null = null, version: number | null = null, payloadHash: string | null = null, referenceKind: "mapping" | "calendar" | null = null;
  if (draft.action === "store_source") {
    if (!draft.reference.trim() || draft.raw.startsWith("\uFEFF") || new TextEncoder().encode(draft.raw).byteLength > 1048576) throw new Error("MARKET_INVALID_SOURCE");
    sourceHash = await sha(draft.raw); command = { portfolio_id: portfolio, idempotency_key: key, reference: draft.reference, content_text: draft.raw };
  } else if (draft.action === "publish_reference") {
    const source = state.sources.find(row => row.id === draft.sourceId);
    if (!source || !draft.reason.trim() || !/^(0|[1-9][0-9]*)$/.test(draft.expectedVersion) || !Number.isSafeInteger(Number(draft.expectedVersion)) || Number(draft.expectedVersion) >= Number.MAX_SAFE_INTEGER) throw new Error("MARKET_REVIEW_REQUIRED");
    const doc = raw as { kind?: unknown; facts?: Record<string, unknown> };
    if ((doc.kind !== "mapping" && doc.kind !== "calendar") || !doc.facts || typeof doc.facts !== "object" || Array.isArray(doc.facts)) throw new Error("MARKET_INVALID_JSON");
    referenceKind = doc.kind;
    scopeKey = doc.kind === "mapping" ? String(doc.facts.listing_id ?? "") : `${doc.facts.market ?? ""}:${doc.facts.exchange ?? ""}`;
    if (!scopeKey) throw new Error("MARKET_INVALID_JSON");
    version = Number(draft.expectedVersion) + 1; sourceId = source.id; sourceHash = source.content_hash;
    command = { portfolio_id: portfolio, idempotency_key: key, expected_version: version - 1, source_id: sourceId, source_hash: sourceHash, review_reason: draft.reason, acknowledgement: true, document: raw };
  } else {
    payloadHash = await sha(canonical(raw)); command = { portfolio_id: portfolio, idempotency_key: key, expected_revision: state.ledger_revision, command_type: "market_collect_prices", payload: raw };
  }
  const body = JSON.stringify({ action: draft.action === "collect_prices" ? "enqueue_task" : draft.action, command });
  if (new TextEncoder().encode(body).byteLength > 2 * 1048576) throw new Error("MARKET_REQUEST_TOO_LARGE");
  return { body, endpoint: draft.action === "collect_prices" ? "/api/workbench" : "/api/workbench/market", binding, portfolio, kind: draft.action, referenceKind, sourceHash, sourceId, scopeKey, version, payloadHash, byteHash: await sha(body) };
}
export function assertMarketReceipt(value: unknown, pending: MarketPending) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MARKET_RECEIPT_INVALID");
  const row = value as Record<string, unknown>;
  if (pending.kind === "collect_prices") {
    if (!id.safeParse(row.request_id).success || row.command_type !== "market_collect_prices" || row.status !== "queued" || row.payload_hash !== pending.payloadHash) throw new Error("MARKET_RECEIPT_INVALID");
    return;
  }
  if (!id.safeParse(row.id).success || !id.safeParse(row.audit_id).success || row.portfolio_id !== pending.portfolio || row.session_binding !== pending.binding) throw new Error("MARKET_RECEIPT_INVALID");
  if (pending.kind === "store_source") { if (row.content_hash !== pending.sourceHash || row.verification_status !== "unreviewed") throw new Error("MARKET_RECEIPT_INVALID"); }
  else if (row.kind !== pending.referenceKind || row.source_id !== pending.sourceId || row.source_hash !== pending.sourceHash || row.scope_key !== pending.scopeKey || row.version !== pending.version || row.verification_status !== "human_reviewed_not_provider_verified" || !digest.safeParse(row.content_hash).success) throw new Error("MARKET_RECEIPT_INVALID");
}
