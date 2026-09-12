import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertMarketReceipt, assertMarketState, emptyMarketDraft, prepareMarketAttempt } from "../src/components/workbench/market-reference-client";
import type { MarketReferenceState } from "../src/server/market-references/queries";

const binding = "a".repeat(64), at = "2026-01-01T00:00:00.000000Z", digest = "b".repeat(64);
const state: MarketReferenceState = { portfolios: [{ id: "synthetic", name: "Synthetic portfolio" }], portfolios_truncated: false, selected_portfolio_id: "synthetic", ledger_revision: 3, read_only: false,
  sources: [{ id: "source", reference: "Synthetic evidence", content_hash: digest, known_at: at }], sources_truncated: false, versions: [], versions_truncated: false, heads: [], heads_truncated: false, listings: [], listings_truncated: false, resource_hash: digest, review_basis: "human_reviewed_not_provider_verified" };
test("market editor starts empty and never infers financial inputs, references or implicit review", () => {
  assert.deepEqual(emptyMarketDraft(), { action: "store_source", reference: "", raw: "", sourceId: "", expectedVersion: "", reason: "" });
});
test("reference source retry freezes exact original JSON bytes and rejects wrong response hash/session/scope", async () => {
  const raw = '{\r\n "synthetic": "测试", "value": "001.00"\r\n}\r\n';
  const pending = await prepareMarketAttempt(state, { ...emptyMarketDraft(), raw, reference: "Synthetic private evidence" }, binding, "fixed-key");
  const original = pending.body, command = JSON.parse(original).command;
  assert.equal(command.content_text, raw); assert.equal(command.idempotency_key, "fixed-key"); assert.equal(pending.sourceHash, createHash("sha256").update(raw).digest("hex"));
  const receipt = { id: "created", audit_id: "audit", portfolio_id: "synthetic", session_binding: binding, content_hash: pending.sourceHash, verification_status: "unreviewed" };
  assertMarketReceipt(receipt, pending);
  for (const patch of [{ content_hash: digest }, { session_binding: digest }, { portfolio_id: "other" }, { verification_status: "verified" }]) assert.throws(() => assertMarketReceipt({ ...receipt, ...patch }, pending), /MARKET_RECEIPT_INVALID/);
  assert.equal(pending.body, original); assert.equal(pending.byteHash, createHash("sha256").update(original).digest("hex"));
});
test("review requires an explicit source, integer CAS and reason, and receipts cannot drift to another kind or version", async () => {
  const draft = { ...emptyMarketDraft(), action: "publish_reference" as const, raw: '{"kind":"mapping","facts":{"listing_id":"CN:synthetic"}}', sourceId: "source", expectedVersion: "0", reason: "Synthetic manual review, not provider approval" };
  for (const patch of [{ sourceId: "" }, { expectedVersion: "" }, { expectedVersion: "01" }, { expectedVersion: "9007199254740991" }, { reason: " " }]) await assert.rejects(() => prepareMarketAttempt(state, { ...draft, ...patch }, binding, "key"), /MARKET_REVIEW_REQUIRED/);
  const pending = await prepareMarketAttempt(state, draft, binding, "review-key"), command = JSON.parse(pending.body).command;
  assert.equal(command.acknowledgement, true); assert.equal(command.expected_version, 0); assert.equal(command.source_hash, digest);
  const receipt = { id: "version", audit_id: "audit", portfolio_id: "synthetic", session_binding: binding, kind: "mapping", source_id: "source", source_hash: digest, scope_key: "CN:synthetic", version: 1, verification_status: "human_reviewed_not_provider_verified", content_hash: digest };
  assertMarketReceipt(receipt, pending);
  for (const patch of [{ version: 2 }, { kind: "calendar" }, { scope_key: "other" }, { source_id: "other" }]) assert.throws(() => assertMarketReceipt({ ...receipt, ...patch }, pending), /MARKET_RECEIPT_INVALID/);
});
test("price collection uses the existing immutable task envelope, never passes user transport or marks an execution successful", async () => {
  const payload = { schema_version: "market-price-collect-v1", provider: "longport", mapping_version_ids: ["mapping"], calendar_version_ids: ["calendar"], start_date: "2025-01-01", end_date: "2025-01-02", expected_publication_revision: 0, publish: false };
  const pending = await prepareMarketAttempt(state, { ...emptyMarketDraft(), action: "collect_prices", raw: JSON.stringify(payload) }, binding, "collect-key");
  assert.equal(pending.endpoint, "/api/workbench"); const envelope = JSON.parse(pending.body); assert.equal(envelope.action, "enqueue_task"); assert.equal(envelope.command.expected_revision, 3); assert.deepEqual(envelope.command.payload, payload);
  assertMarketReceipt({ request_id: "request", command_type: "market_collect_prices", status: "queued", payload_hash: pending.payloadHash }, pending);
  assert.throws(() => assertMarketReceipt({ request_id: "request", command_type: "market_collect_prices", status: "succeeded", payload_hash: pending.payloadHash }, pending), /MARKET_RECEIPT_INVALID/);
});
test("strict JSON, byte bounds and read-only state reject compilation before a request can be frozen", async () => {
  for (const raw of ['{"x":1,"x":2}', '[]', '\uFEFF{}', '{"x":"' + "界".repeat(350000) + '"}']) await assert.rejects(() => prepareMarketAttempt(state, { ...emptyMarketDraft(), raw, reference: "Synthetic" }, binding, "key"));
  await assert.rejects(() => prepareMarketAttempt({ ...state, read_only: true }, { ...emptyMarketDraft(), raw: "{}", reference: "Synthetic" }, binding, "key"), /MARKET_WRITE_LOCKED/);
});
test("runtime response validator binds current session and portfolio and bounds summary lists without originals", () => {
  const value = { ...state, session_binding: binding }; assertMarketState(value, "synthetic", binding);
  for (const changed of [{ ...value, session_binding: digest }, { ...value, selected_portfolio_id: "other" }, { ...value, raw_body: "not-public" }, { ...value, heads: [{ portfolio_id: "other", kind: "mapping", scope_key: "scope", version: 1, version_id: "v", updated_at: at }] }, { ...value, sources: Array.from({ length: 101 }, () => state.sources[0]) }]) assert.throws(() => assertMarketState(changed, "synthetic", binding), /MARKET_RESPONSE_INVALID/);
  assertMarketState({ ...value, read_only: true }, "synthetic", binding);
});
