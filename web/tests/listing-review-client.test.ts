import assert from "node:assert/strict";
import test from "node:test";
import { hash } from "../src/server/ledger/service";
import { assertListingReviewReceipt, assertListingReviewState, emptyListingReviewDraft, prepareListingReviewAttempt } from "../src/components/workbench/listing-review-client";
import type { ListingReviewDocument, ListingReviewState } from "../src/server/listing-reviews/types";
const binding = "b".repeat(64), now = "2026-01-02T12:00:00.000000Z";
const identity = { listing_id: "synthetic-listing", instrument_id: "synthetic-instrument", market: "CN" as const, exchange: "XSHG", ticker: "000001", currency: "CNY" };
function state(): ListingReviewState {
  const row = { identity, identity_hash: hash(identity), name: "Synthetic ETF", review_revision: 0, quality: "blocked" as const, issues: ["LISTING_REVIEW_MISSING"], current: null };
  return { schema_version: "listing-review-state-v1", portfolios: [{ id: "synthetic-portfolio", name: "Synthetic portfolio" }], portfolios_truncated: false, selected_portfolio_id: "synthetic-portfolio", selected_listing_id: identity.listing_id, catalog_revision: 1, read_only: false, checked_at: now, resource_hash: "c".repeat(64), rows: [row], next_cursor: null, selected: row, sources: [{ id: "synthetic-source", portfolio_id: "synthetic-portfolio", reference: "Synthetic not real issuer", content_hash: "a".repeat(64), known_at: now, created_by: "synthetic-author" }], sources_truncated: false, history: [], history_truncated: false };
}
const draft = () => ({ ...emptyListingReviewDraft(), sourceId: "synthetic-source", sourceHash: "a".repeat(64), instrumentKind: "ETF", lifecycleStatus: "active", leverage: "unleveraged", direction: "long_only", quantityStep: "1.00", priceStep: "0.001", indexId: "SYNTHETIC:INDEX", region: "synthetic-region", sector: "synthetic-sector", reviewUntil: "2026-02-02T12:00:00.000000Z", reason: "Synthetic human review only" });
function receipt() {
  const pending = prepareListingReviewAttempt(state(), draft(), binding, "synthetic-key"), c = pending.command;
  const document: ListingReviewDocument = { schema_version: "listing-review-v1", id: "synthetic-review", portfolio_id: c.portfolio_id, listing_id: c.listing_id, revision: 1, source_id: c.source_id, source_hash: c.source_hash, source_known_at: now, identity_snapshot: identity, identity_hash: hash(identity), known_at: now, created_by: "synthetic-owner", review_until: c.review_until, reason: c.reason, review_basis: "human_reviewed_not_provider_verified", facts: c.facts };
  return { pending, result: { id: document.id, portfolio_id: c.portfolio_id, listing_id: c.listing_id, revision: 1, content_hash: hash(document), identity_hash: document.identity_hash, source_id: c.source_id, source_hash: c.source_hash, known_at: now, review_until: c.review_until, review_basis: "human_reviewed_not_provider_verified", audit_id: "synthetic-audit", document, session_binding: binding } };
}
test("empty human review draft contains no economic, product, identity or expiry defaults", () => {
  assert.ok(Object.values(emptyListingReviewDraft()).every(value => value === ""));
  assert.throws(() => prepareListingReviewAttempt(state(), emptyListingReviewDraft(), binding, "key"), /LISTING_REVIEW_INVALID_COMMAND/);
});
test("explicit choices freeze the exact identity hash, revision, decimal bytes, null unknowns and same original retry body", () => {
  const value = prepareListingReviewAttempt(state(), draft(), binding, "synthetic-key"), body = value.body;
  assert.equal(value.command.expected_identity_hash, hash(identity)); assert.equal(value.command.expected_review_revision, 0); assert.equal(value.command.facts.quantity_step, "1.00"); assert.equal(value.command.facts.source_effective_date, null);
  const changed = state(); changed.selected!.review_revision = 9; changed.selected!.identity.ticker = "OTHER";
  assert.equal(value.body, body); assert.equal(value.identity.ticker, "000001"); assert.equal(value.command.expected_review_revision, 0);
  identity.ticker = "000001";
});
test("draft requires explicit enums, positive decimal fields, future expiry and same source hash while readonly blocks", () => {
  for (const patch of [{ leverage: "" }, { direction: "" }, { quantityStep: "0" }, { priceStep: "1e-2" }, { reviewUntil: now }, { reason: " " }]) assert.throws(() => prepareListingReviewAttempt(state(), { ...draft(), ...patch }, binding, "key"), /LISTING_REVIEW_INVALID_COMMAND/);
  assert.throws(() => prepareListingReviewAttempt(state(), { ...draft(), sourceHash: "f".repeat(64) }, binding, "key"), /LISTING_REVIEW_SOURCE_CONFLICT/);
  assert.throws(() => prepareListingReviewAttempt({ ...state(), read_only: true }, draft(), binding, "key"), /LISTING_REVIEW_WRITE_LOCKED/);
  const manual = prepareListingReviewAttempt({ ...state(), sources_truncated: true }, { ...draft(), sourceId: "synthetic-outside-page" }, binding, "key"); assert.equal(manual.sourceKnownAt, null);
});
test("consumer rejects malformed/bounded/cross-portfolio responses without printing private response contents", () => {
  const good = { ...state(), session_binding: binding }; assertListingReviewState(good, good.selected_portfolio_id, identity.listing_id, binding);
  for (const patch of [{ session_binding: "c".repeat(64) }, { rows: [good.rows[0], good.rows[0]] }, { rows: Array(51).fill(good.rows[0]) }, { sources: [{ ...good.sources[0], portfolio_id: "other" }] }, { selected_listing_id: "other" }, { history: [{ arbitrary: "SYNTHETIC_PRIVATE_MARKER" }] }]) assert.throws(() => assertListingReviewState({ ...good, ...patch }, good.selected_portfolio_id, identity.listing_id, binding), /^Error: LISTING_REVIEW_RESPONSE_INVALID$/);
});
test("receipt proves exact command and wrapper UTF8 hash, not merely a plausible digest/version", async () => {
  const { pending, result } = receipt(); await assertListingReviewReceipt(result, pending);
  for (const patch of [{ content_hash: "a".repeat(64) }, { revision: 2 }, { identity_hash: "a".repeat(64) }, { session_binding: "a".repeat(64) }, { review_until: now }]) await assert.rejects(() => assertListingReviewReceipt({ ...result, ...patch }, pending), /LISTING_REVIEW_RESPONSE_INVALID/);
  const forged = { ...result.document, facts: { ...result.document.facts, quantity_step: "2" } };
  await assert.rejects(() => assertListingReviewReceipt({ ...result, document: forged, content_hash: hash(forged) }, pending), /LISTING_REVIEW_RESPONSE_INVALID/);
  assert.equal(JSON.parse(pending.body).command.facts.quantity_step, "1.00");
});
