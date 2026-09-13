import assert from "node:assert/strict";
import test from "node:test";
import { governanceFixture } from "./governance-fixture";
import { catalogRevision, storeCatalogSource, publishCatalogProfile } from "../src/server/catalog/service";
import { human } from "./governance-fixture";

test("risk input includes metadata of a listing held only by another active buy reservation", () => {
  const f = governanceFixture();
  try {
    const reserved = f.proposal("100", "buy", { listing_id: "l2" });
    assert.equal(reserved.risk.status, "pass"); f.approve(reserved);
    const candidate = f.proposal("100"); assert.equal(candidate.risk.status, "pass");
    const original = f.db.prepare("SELECT * FROM reservations ORDER BY id").all();
    f.reviewListing("l2", { price_step: "0.02" });
    assert.throws(() => f.approve(candidate), /RISK_INPUT_CHANGED/);
    assert.deepEqual(f.db.prepare("SELECT * FROM reservations ORDER BY id").all(), original);
  } finally { f.close(); }
});

test("research profile publication does not change the independently validated governance input", () => {
  const f = governanceFixture();
  try {
    const candidate = f.proposal("100"); assert.equal(candidate.risk.status, "pass");
    const source = storeCatalogSource(f.db, human, { portfolio_id: f.portfolio, expected_catalog_revision: catalogRevision(f.db, f.portfolio), idempotency_key: "catalog-source", reference: "Synthetic research only", document: { not_live_verified: true } }, f.options);
    publishCatalogProfile(f.db, human, { portfolio_id: f.portfolio, expected_catalog_revision: catalogRevision(f.db, f.portfolio), idempotency_key: "catalog-profile", listing_id: "l", expected_profile_version: 0, source_id: source.id, as_of: "2026-01-01", profile: { issuer: null, index_id: "Unverified research index", domicile: null, underlying_asset_class: "unknown", economic_regions: ["Unverified"], sectors: [], annual_expense_ratio: null, distribution: "unknown", replication: "unknown" } }, f.options);
    assert.doesNotThrow(() => f.approve(candidate));
  } finally { f.close(); }
});
