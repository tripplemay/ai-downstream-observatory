import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { canonical, createPortfolio, hash } from "../src/server/ledger/service";
import { registerListing } from "../src/server/workbench-commands";
import { addCatalogEntry } from "../src/server/catalog/service";
import { storeMarketReferenceSource } from "../src/server/market-references/service";
import { currentListingIdentity, publishListingReview, reviewedListingAt } from "../src/server/listing-reviews/service";
import { getListingReviewState } from "../src/server/listing-reviews/queries";
import type { ListingReviewFacts } from "../src/server/listing-reviews/types";
const actor = { id: "synthetic-review-owner", kind: "human" as const }, now = "2026-01-02T12:00:00.000000Z";
const facts: ListingReviewFacts = { instrument_kind: "ETF", lifecycle_status: "active", quantity_step: "1.00", price_step: "0.000000000000000001", source_effective_date: "2026-01-02", fund_identifier: null, share_class_identifier: null, risk_classification: { index_id: "SYNTHETIC:INDEX", region: "synthetic-region", sector: "synthetic-sector" }, product_structure: { leverage: "unleveraged", direction: "long_only" } };
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "listing-reviews-")), filename = path.join(dir, "workbench.db"); migrateWorkbench(filename); const db = openWorkbench(filename);
  const portfolio = createPortfolio(db, actor, "Synthetic review portfolio", now), other = createPortfolio(db, actor, "Synthetic other", now);
  const listing = registerListing(db, actor, { portfolio_id: portfolio, expected_revision: 0, idempotency_key: "register", name: "Synthetic security, not real issuer", market: "US", exchange: "XNAS", ticker: "SYNTH", currency: "USD", asset_class: "unknown", source_evidence: "Synthetic identity record" }, now).listing_id;
  addCatalogEntry(db, actor, { portfolio_id: portfolio, listing_id: listing, expected_catalog_revision: 0, idempotency_key: "catalog" }, { now });
  const source = storeMarketReferenceSource(db, { ...actor, id: "synthetic-other-human" }, { portfolio_id: portfolio, idempotency_key: "source", reference: "Synthetic human review evidence, no real issuer data", content_text: '{\r\n"synthetic":true,"fact":"no real security"\r\n}\r\n' }, { now });
  const command = (key = "review", revision = 0, patch: Partial<ListingReviewFacts> = {}) => ({ portfolio_id: portfolio, listing_id: listing, expected_review_revision: revision, expected_identity_hash: hash(currentListingIdentity(db, portfolio, listing)), source_id: source.id, source_hash: source.content_hash, facts: { ...facts, ...patch }, review_until: "2026-03-02T12:00:00.000000Z", reason: "Synthetic explicit human review, not trading permission", acknowledgement: true as const, idempotency_key: key });
  const read = (knowledge_at = now, clock = knowledge_at) => reviewedListingAt(db, { portfolio_id: portfolio, listing_id: listing, knowledge_at, now: clock });
  const snapshot = () => Object.fromEntries(["instruments", "listings", "ledger_heads", "ledger_events", "postings", "account_capabilities", "approval_events", "activations", "market_observations"].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  return { db, dir, filename, portfolio, other, listing, source, command, read, snapshot, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test("actual registration/catalog/source/review services preserve exact decimals and change no financial or global identity", () => {
  const f = fixture(); try {
    const before = f.snapshot(); assert.deepEqual(f.read().issues, ["LISTING_REVIEW_MISSING"]);
    const receipt = publishListingReview(f.db, actor, f.command(), { now }), proof = f.read();
    assert.equal(proof.quality, "complete"); assert.equal(proof.row?.id, receipt.id); assert.equal(proof.document?.facts.quantity_step, "1.00"); assert.equal(proof.document?.facts.price_step, facts.price_step);
    assert.equal(proof.document?.review_basis, "human_reviewed_not_provider_verified"); assert.equal(proof.source?.created_by, "synthetic-other-human"); assert.equal(hash(proof.document), receipt.content_hash); assert.match(proof.proof_hash!, /^[a-f0-9]{64}$/);
    assert.deepEqual(f.snapshot(), before); assert.equal((f.db.prepare("SELECT status FROM listings WHERE id=?").get(f.listing) as { status: string }).status, "unverified");
  } finally { f.close(); }
});
test("same exact command dedups before CAS; changed CAS, identity, facts or reason cannot borrow the old receipt", () => {
  const f = fixture(); try {
    const command = f.command(), first = publishListingReview(f.db, actor, command, { now }); publishListingReview(f.db, actor, f.command("next", 1), { now });
    assert.deepEqual(publishListingReview(f.db, actor, command, { now }), first);
    for (const patch of [{ expected_review_revision: 1 }, { expected_identity_hash: "a".repeat(64) }, { reason: "Different synthetic reason" }, { facts: { ...facts, lifecycle_status: "unknown" } }]) assert.throws(() => publishListingReview(f.db, actor, { ...command, ...patch }, { now }), /LISTING_REVIEW_DUPLICATE_CONFLICT/);
    assert.throws(() => publishListingReview(f.db, actor, f.command("stale", 0), { now }), /LISTING_REVIEW_VERSION_CONFLICT/);
  } finally { f.close(); }
});
test("identity TOCTOU rejects atomically; a new explicit snapshot repairs quality without editing global records", () => {
  const f = fixture(); try {
    publishListingReview(f.db, actor, f.command(), { now }); const stale = f.command("stale-identity", 1);
    f.db.prepare("UPDATE listings SET ticker='OTHER' WHERE id=?").run(f.listing); const before = f.db.prepare("SELECT total_changes() n").get();
    assert.throws(() => publishListingReview(f.db, actor, stale, { now }), /LISTING_REVIEW_IDENTITY_CONFLICT/); assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    assert.deepEqual(f.read().issues, ["LISTING_REVIEW_IDENTITY_CHANGED"]); publishListingReview(f.db, actor, f.command("repaired", 1), { now }); assert.equal(f.read().quality, "complete");
  } finally { f.close(); }
});
test("nullable unknown latest review blocks and never falls back; same-microsecond revisions select the highest", () => {
  const f = fixture(); try {
    publishListingReview(f.db, actor, f.command(), { now });
    const latest = publishListingReview(f.db, actor, f.command("unknown", 1, { instrument_kind: "unknown", lifecycle_status: "suspended", quantity_step: null, price_step: null, risk_classification: { index_id: null, region: null, sector: null }, product_structure: { leverage: "unknown", direction: "unknown" } }), { now });
    assert.equal(f.read().row?.id, latest.id); assert.equal(f.read().quality, "blocked"); assert.deepEqual(f.read().issues, ["LISTING_REVIEW_NOT_ACTIVE", "LISTING_REVIEW_NOT_ETF", "LISTING_REVIEW_PRODUCT_STRUCTURE_UNKNOWN", "LISTING_REVIEW_RISK_CLASSIFICATION_MISSING", "LISTING_REVIEW_TRADING_UNITS_MISSING"]);
  } finally { f.close(); }
});
test("historical proof hashes survive future head updates, while expiry uses current exact microsecond", () => {
  const f = fixture(); try {
    publishListingReview(f.db, actor, f.command(), { now }); const historical = f.read(), later = "2026-01-02T12:00:00.000001Z";
    publishListingReview(f.db, actor, f.command("next", 1, { lifecycle_status: "delisted" }), { now: later });
    assert.deepEqual(f.read(), historical); assert.deepEqual(f.read(later).issues, ["LISTING_REVIEW_NOT_ACTIVE"]);
    assert.deepEqual(f.read(now, f.command().review_until).issues, ["LISTING_REVIEW_EXPIRED"]);
    assert.equal(f.read(now, "2026-03-02T11:59:59.999999Z").quality, "complete");
  } finally { f.close(); }
});
test("unsupported product wins over unknown; no missing trading steps or leveraged product is silently normalized", () => {
  const f = fixture(); try {
    const latest = publishListingReview(f.db, actor, f.command("inverse", 0, { product_structure: { leverage: "unknown", direction: "inverse" }, quantity_step: null }), { now });
    assert.equal(latest.revision, 1); assert.deepEqual(f.read().issues, ["LISTING_REVIEW_PRODUCT_NOT_SUPPORTED", "LISTING_REVIEW_TRADING_UNITS_MISSING"]);
    for (const step of ["0", "0.000", "-1", "1e2", "01", "1,000", "0.0000000000000000001", "1".repeat(39)]) assert.throws(() => publishListingReview(f.db, actor, f.command("bad", 1, { quantity_step: step }), { now }), /LISTING_REVIEW_INVALID_COMMAND/);
  } finally { f.close(); }
});
test("human authority, catalog/source scopes, strict input and UTF8 source integrity fail closed", () => {
  const f = fixture(); try {
    for (const who of [{ ...actor, kind: "worker" as const }, { ...actor, id: "system:forged-human" }]) assert.throws(() => publishListingReview(f.db, who, f.command(), { now }), /LISTING_REVIEW_PERMISSION_DENIED/);
    for (const extra of [{ expected_identity_hash: undefined }, { actor_id: actor.id }, { acknowledgement: false }, { verified: true }, { known_at: now }, { reason: "\u00a0" }, { reason: "\uD800" }]) assert.throws(() => publishListingReview(f.db, actor, { ...f.command(), ...extra }, { now }), /LISTING_REVIEW_INVALID_COMMAND/);
    assert.throws(() => publishListingReview(f.db, actor, { ...f.command(), portfolio_id: f.other }, { now }), /LISTING_REVIEW_OUT_OF_SCOPE/);
    addCatalogEntry(f.db, actor, { portfolio_id: f.other, listing_id: f.listing, expected_catalog_revision: 0, idempotency_key: "other-entry" }, { now });
    assert.throws(() => publishListingReview(f.db, actor, { ...f.command(), portfolio_id: f.other }, { now }), /LISTING_REVIEW_SOURCE_OUT_OF_SCOPE/);
    assert.throws(() => publishListingReview(f.db, actor, { ...f.command(), source_hash: "a".repeat(64) }, { now }), /LISTING_REVIEW_SOURCE_CONFLICT/);
  } finally { f.close(); }
});
test("future effective dates use each market local day rather than UTC date", () => {
  const f = fixture(); try {
    const clock = "2026-01-03T01:00:00.000000Z";
    assert.throws(() => publishListingReview(f.db, actor, f.command("future", 0, { source_effective_date: "2026-01-03" }), { now: clock }), /LISTING_REVIEW_INVALID_COMMAND/);
    assert.equal(publishListingReview(f.db, actor, f.command("us-local", 0, { source_effective_date: "2026-01-02" }), { now: clock }).revision, 1);
    f.db.prepare("UPDATE listings SET market='HK',exchange='XHKG' WHERE id=?").run(f.listing);
    assert.equal(publishListingReview(f.db, actor, f.command("hk-local", 1, { source_effective_date: "2026-01-03" }), { now: clock }).revision, 2);
  } finally { f.close(); }
});
test("self-rehashing row/doc cannot change review without its exact source and human audit", () => {
  const f = fixture(); try {
    const receipt = publishListingReview(f.db, actor, f.command(), { now }), doc = f.read().document!;
    f.db.exec("DROP TRIGGER listing_review_version_no_update"); doc.facts.lifecycle_status = "delisted";
    f.db.prepare("UPDATE listing_review_versions SET facts_json=?,document_json=?,content_hash=? WHERE id=?").run(canonical(doc.facts), canonical(doc), hash(doc), receipt.id);
    assert.throws(() => f.read(), /LISTING_REVIEW_EVIDENCE_INVALID/);
  } finally { f.close(); }
});
test("restore marker blocks first mutation and exact retries; bounded public reads omit raw source and remain zero-write", () => {
  const f = fixture(); try {
    publishListingReview(f.db, actor, f.command(), { now }); writeFileSync(path.join(f.dir, "RESTORE_PENDING_REVIEW"), "synthetic read only\n"); const before = f.db.prepare("SELECT total_changes() n").get();
    assert.throws(() => publishListingReview(f.db, actor, f.command(), { now }), /WORKBENCH_READ_ONLY/);
    const value = getListingReviewState(f.db, { portfolio_id: f.portfolio, listing_id: f.listing }, { now });
    assert.equal(value.read_only, true); assert.equal(value.selected?.current?.document.revision, 1); assert.equal(value.history.length, 1); assert.equal(value.rows.length, 1);
    assert.doesNotMatch(JSON.stringify(value), /content_text|document_json|identity_json|facts_json|payload_json|no real security/); assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    assert.throws(() => getListingReviewState(f.db, { portfolio_id: f.other, listing_id: f.listing }, { now }), /LISTING_REVIEW_OUT_OF_SCOPE/);
  } finally { f.close(); }
});
test("catalog keyset pages bind scope/revision, retain explicit selection beyond the page and reject stale cursors", () => {
  const f = fixture(); try {
    const add = (ticker: string, revision: number) => {
      const listing = registerListing(f.db, actor, { portfolio_id: f.portfolio, expected_revision: 0, idempotency_key: `register-${ticker}`, name: "Synthetic paginated identity", market: "US", exchange: "XNAS", ticker, currency: "USD", asset_class: "unknown", source_evidence: "Synthetic fixture" }, now).listing_id;
      addCatalogEntry(f.db, actor, { portfolio_id: f.portfolio, listing_id: listing, expected_catalog_revision: revision, idempotency_key: `catalog-${ticker}` }, { now }); return listing;
    };
    add("PAGE2", 1); const first = getListingReviewState(f.db, { portfolio_id: f.portfolio, listing_id: f.listing, limit: 1 }, { now });
    assert.ok(first.next_cursor); const second = getListingReviewState(f.db, { portfolio_id: f.portfolio, listing_id: f.listing, limit: 1, cursor: first.next_cursor }, { now });
    assert.notEqual(first.rows[0].identity.listing_id, second.rows[0].identity.listing_id); assert.equal(second.selected?.identity.listing_id, f.listing); assert.equal(second.next_cursor, null);
    assert.throws(() => getListingReviewState(f.db, { portfolio_id: f.other, cursor: first.next_cursor }, { now }), /LISTING_REVIEW_INVALID_QUERY/);
    add("PAGE3", 2); assert.throws(() => getListingReviewState(f.db, { portfolio_id: f.portfolio, cursor: first.next_cursor }, { now }), /LISTING_REVIEW_CURSOR_STALE/);
    for (const raw of [{ limit: 51 }, { cursor: "not-a-cursor" }, { actor_id: "other" }]) assert.throws(() => getListingReviewState(f.db, raw, { now }), /LISTING_REVIEW_INVALID_QUERY/);
  } finally { f.close(); }
});
test("query caps source/history payloads explicitly without loading source body into its DTO", () => {
  const f = fixture(); try {
    for (let n = 0; n < 21; n++) publishListingReview(f.db, actor, f.command(`version-${n}`, n), { now });
    for (let n = 0; n < 100; n++) storeMarketReferenceSource(f.db, actor, { portfolio_id: f.portfolio, idempotency_key: `source-${n}`, reference: "Synthetic page boundary", content_text: '{"synthetic":true}' }, { now });
    const value = getListingReviewState(f.db, { portfolio_id: f.portfolio, listing_id: f.listing }, { now });
    assert.equal(value.history.length, 20); assert.equal(value.history_truncated, true); assert.equal(value.sources.length, 100); assert.equal(value.sources_truncated, true); assert.equal(value.selected?.current?.document.revision, 21);
    assert.doesNotMatch(JSON.stringify(value), /content_text|document_json|payload_json/);
  } finally { f.close(); }
});
