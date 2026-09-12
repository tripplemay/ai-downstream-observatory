import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { canonical, hash, revision } from "../src/server/ledger/service";
import { checkRisk, currentPublications, requireValuation } from "../src/server/governance/risk";
import { valuationFreshness } from "../src/server/valuation-freshness";
import { governanceFixture, human, now } from "./governance-fixture";

test("governance accepts explicit v3 cash/position/FX evidence with market-standard FX units", () => {
  for (const currency of ["CNY", "USD", "HKD"]) {
    const f = governanceFixture(undefined, "100", "100000", true, currency);
    try {
      const valuation = f.db.prepare("SELECT * FROM valuation_runs WHERE id=?").get(f.valuationId) as { id: string; ledger_revision: number; market_manifest: string };
      assert.deepEqual(valuationFreshness(f.db, valuation, revision(f.db, f.portfolio)), []);
      const proposal = f.proposal("400"); assert.equal(proposal.risk.status, "pass");
      assert.equal(proposal.risk.budgets[0].amount, "40000"); f.approve(proposal);
      assert.equal((f.db.prepare("SELECT amount FROM reservations WHERE proposal_item_id=?").get(proposal.risk.budgets[0].item_id) as { amount: string }).amount, "40000");
    } finally { f.close(); }
  }
});

test("actual risk rejects wrong FX unit rather than reinterpreting or silently inverting its value", () => {
  for (const unit of ["CNY", "USD_per_CNY", "HKD", "bps"]) {
    const f = governanceFixture(undefined, "0", "100000", true, "USD");
    try {
      const proposal = f.proposal("400"); assert.equal(proposal.risk.status, "pass");
      // Adversarial corruption fixture: append a conflicting quote in the disposable staged batch.
      // The persisted valuation still binds its original valid observation; order risk must inspect its own quote.
      const id = randomUUID();
      f.db.prepare("INSERT INTO market_observations(id,batch_id,source_id,series_key,metric,value,unit,observed_at,published_at,ingested_at,time_precision,source_timezone,price_basis,revision_id,raw_hash,parser_version,provenance) SELECT ?,batch_id,source_id,series_key,metric,value,?,'2026-01-05T01:30:00.000Z','2026-01-05T01:30:00.000Z','2026-01-05T01:30:00.000Z',time_precision,source_timezone,price_basis,?,raw_hash,parser_version,provenance FROM market_observations WHERE metric='fx_cny_per_unit' LIMIT 1").run(id, unit, id);
      f.db.prepare("INSERT INTO market_batch_members(batch_id,observation_id) SELECT batch_id,id FROM market_observations WHERE id=?").run(id);
      const risk = checkRisk(f.db, human, f.portfolio, proposal.id, f.options, now);
      assert.equal(risk.status, "blocked"); assert.equal(risk.checks[0].code, "INVALID_FX_RATE");
      assert.equal((f.db.prepare("SELECT COUNT(*) n FROM reservations").get() as { n: number }).n, 0);
    } finally { f.close(); }
  }
});

test("complete/head labels cannot admit obsolete valuation methods or invalid v3 evidence", () => {
  const f = governanceFixture(undefined, "100", "100000", false, "USD");
  try {
    const original = f.db.prepare("SELECT * FROM valuation_runs WHERE id=?").get(f.valuationId) as { market_manifest: string; method_version: string };
    const publications = currentPublications(f.db, f.policy, now);
    let sequence = 0;
    const clone = (method: string, manifest = JSON.parse(original.market_manifest), evidence?: string) => {
      const id = randomUUID();
      f.db.prepare("INSERT INTO valuation_runs(id,portfolio_id,ledger_revision,market_manifest,method_version,cutoff_at,quality,nav_cny,created_at) SELECT ?,portfolio_id,ledger_revision,?,?,?,quality,nav_cny,created_at FROM valuation_runs WHERE id=?").run(id, canonical(manifest), method, new Date(Date.parse("2026-01-05T02:00:00.000Z") + ++sequence * 1000).toISOString(), f.valuationId);
      const items = f.db.prepare("SELECT id FROM valuation_items WHERE run_id=?").all(f.valuationId) as { id: string }[];
      for (const item of items) f.db.prepare("INSERT INTO valuation_items(id,run_id,account_id,listing_id,item_type,currency,amount,fx_rate,value_cny,quality,evidence_json) SELECT ?,?,account_id,listing_id,item_type,currency,amount,fx_rate,value_cny,quality,COALESCE(?,evidence_json) FROM valuation_items WHERE id=?").run(randomUUID(), id, evidence ?? null, item.id);
      return id;
    };
    for (const method of ["synthetic-fixture-v1", "decimal-nav-cny-v1:restated", "decimal-nav-cny-v2:restated"]) assert.throws(() => requireValuation(f.db, f.portfolio, clone(method), f.policy, publications, now), /CURRENT_COMPLETE_VALUATION_REQUIRED/);
    assert.throws(() => requireValuation(f.db, f.portfolio, clone(original.method_version, undefined, "{}"), f.policy, publications, now), /CURRENT_COMPLETE_VALUATION_REQUIRED/);
    for (const patch of ["unapproved", "hash", "publication"] as const) {
      const manifest = JSON.parse(original.market_manifest);
      if (patch === "unapproved") { manifest.rules.approved = false; manifest.rules_hash = hash(manifest.rules); }
      if (patch === "hash") manifest.rules_hash = "a".repeat(64);
      if (patch === "publication") manifest.publications.FX.revision = 999;
      assert.throws(() => requireValuation(f.db, f.portfolio, clone(original.method_version, manifest), f.policy, publications, now), /CURRENT_COMPLETE_VALUATION_REQUIRED|VALUATION_MARKET_CHANGED/);
    }
  } finally { f.close(); }
});
