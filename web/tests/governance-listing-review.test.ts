import assert from "node:assert/strict";
import test from "node:test";
import { governanceFixture, human, now } from "./governance-fixture";
import { createPortfolio, hash, revision } from "../src/server/ledger/service";
import { addCatalogEntry } from "../src/server/catalog/service";
import { evaluationListing } from "../src/server/governance/risk";
import { prepareExecution } from "../src/server/governance/service";

test("private sourced reviews replace legacy global verified flags without mutating global identities", () => {
  const f = governanceFixture(); try {
    const original = f.db.prepare("SELECT * FROM listings ORDER BY id").all();
    assert.ok(original.every(row => (row as { status: string }).status === "unverified"));
    const listing = evaluationListing(f.db, "l", f.policy, now, f.portfolio);
    assert.equal(listing.asset_class, "ETF"); assert.equal(listing.status, "active"); assert.equal(listing.quantity_step, "100");
    assert.equal(listing.review.review_basis, "human_reviewed_not_provider_verified");
    assert.equal(f.proposal("100").risk.status, "pass");
    f.reviewListing("l", { price_step: "0.02" });
    assert.deepEqual(f.db.prepare("SELECT * FROM listings ORDER BY id").all(), original);
    assert.equal(evaluationListing(f.db, "l", f.policy, now, f.portfolio).price_step, "0.02");
    assert.equal((f.db.prepare("SELECT index_id FROM instruments WHERE id='i'").get() as { index_id: string | null }).index_id, null);
  } finally { f.close(); }
});
test("another portfolio cannot reuse a private review or bypass it with legacy global approval flags", () => {
  const f = governanceFixture(); try {
    const other = createPortfolio(f.db, human, "Synthetic unrelated portfolio", now);
    addCatalogEntry(f.db, human, { portfolio_id: other, listing_id: "l", expected_catalog_revision: 0, idempotency_key: "synthetic-private-review-scope" }, { now });
    f.db.exec("UPDATE listings SET status='active',quantity_step='100',price_step='0.01',verified_at='2025-01-01T00:00:00.000Z'; UPDATE instruments SET asset_class='ETF',index_id='synthetic-index',exposure_json='{\"region\":\"CN\",\"sector\":\"broad\"}'");
    assert.throws(() => evaluationListing(f.db, "l", f.policy, now, other), /LISTING_REVIEW_MISSING/);
    assert.equal(evaluationListing(f.db, "l", f.policy, now, f.portfolio).review.revision, 1);
  } finally { f.close(); }
});
test("a new private review invalidates an approved proposal without releasing reservations or changing facts", () => {
  const f = governanceFixture(); try {
    const proposal = f.proposal("100"), approval = f.approve(proposal);
    const tables = ["ledger_events", "approval_events", "reservations", "position_projections", "account_projections", "valuation_runs"];
    const before = Object.fromEntries(tables.map(table => [table, hash(f.db.prepare(`SELECT * FROM ${table}`).all())]));
    f.reviewListing("l", { price_step: "0.02" });
    assert.throws(() => prepareExecution(f.db, human, { ...f.envelope(), proposal_id: proposal.id, approval_id: approval.id }, f.options), /RISK_INPUT_CHANGED|APPROVAL_STALE/);
    for (const table of tables) assert.equal(hash(f.db.prepare(`SELECT * FROM ${table}`).all()), before[table], table);
  } finally { f.close(); }
});
for (const [patch, issue] of [
  [{ instrument_kind: "ETN" }, "LISTING_REVIEW_NOT_ETF"],
  [{ lifecycle_status: "suspended" }, "LISTING_REVIEW_NOT_ACTIVE"],
  [{ lifecycle_status: "delisted" }, "LISTING_REVIEW_NOT_ACTIVE"],
  [{ quantity_step: null }, "LISTING_REVIEW_TRADING_UNITS_MISSING"],
  [{ product_structure: { leverage: "leveraged", direction: "long_only" } }, "LISTING_REVIEW_PRODUCT_NOT_SUPPORTED"],
  [{ product_structure: { leverage: "unleveraged", direction: "inverse" } }, "LISTING_REVIEW_PRODUCT_NOT_SUPPORTED"],
  [{ product_structure: { leverage: "unknown", direction: "long_only" } }, "LISTING_REVIEW_PRODUCT_STRUCTURE_UNKNOWN"],
  [{ risk_classification: { index_id: null, region: "CN", sector: "broad" } }, "LISTING_REVIEW_RISK_CLASSIFICATION_MISSING"],
] as const) test(`latest ${issue} review blocks without falling back or deleting an actual holding`, () => {
  const f = governanceFixture(undefined, "100"); try {
    const before = revision(f.db, f.portfolio), positions = f.db.prepare("SELECT * FROM position_projections").all();
    f.reviewListing("l", patch);
    const result = f.proposal("100"); assert.equal(result.risk.status, "blocked"); assert.equal(result.risk.checks[0].code, issue);
    assert.equal(revision(f.db, f.portfolio), before); assert.deepEqual(f.db.prepare("SELECT * FROM position_projections").all(), positions);
  } finally { f.close(); }
});
test("review expiry stops execution even without a new market or ledger revision", () => {
  const f = governanceFixture(); try {
    f.reviewListing("l", {}, "2026-01-05T12:00:00.000000Z", "2026-01-05T12:00:01.000000Z");
    const proposal = f.proposal("100"), approval = f.approve(proposal), before = revision(f.db, f.portfolio);
    assert.throws(() => prepareExecution(f.db, human, { ...f.envelope(), proposal_id: proposal.id, approval_id: approval.id }, { ...f.options, now: "2026-01-05T12:00:01.000Z" }), /LISTING_REVIEW_EXPIRED/);
    assert.equal(revision(f.db, f.portfolio), before);
    assert.equal((f.db.prepare("SELECT status FROM reservations WHERE approval_id=?").get(approval.id) as { status: string }).status, "active");
  } finally { f.close(); }
});
test("execution cannot truncate an explicit review expiry by one microsecond", () => {
  const f = governanceFixture(); try {
    f.reviewListing("l", {}, "2026-01-05T12:00:00.000000Z", "2026-01-05T12:00:00.000001Z");
    const proposal = f.proposal("100"), approval = f.approve(proposal);
    assert.throws(() => prepareExecution(f.db, human, { ...f.envelope(), proposal_id: proposal.id, approval_id: approval.id }, { ...f.options, now: "2026-01-05T12:00:00.000001Z" }), /LISTING_REVIEW_EXPIRED/);
  } finally { f.close(); }
});
test("historical review knowledge cannot override a newer active review in a current decision", () => {
  const f = governanceFixture(); try {
    const later = "2026-01-05T12:00:01.000000Z";
    f.reviewListing("l", { price_step: "0.02" }, later);
    assert.throws(() => evaluationListing(f.db, "l", f.policy, later, f.portfolio, now), /LISTING_REVIEW_CHANGED/);
    assert.equal(evaluationListing(f.db, "l", f.policy, now, f.portfolio).review.revision, 1);
  } finally { f.close(); }
});
