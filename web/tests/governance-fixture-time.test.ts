import assert from "node:assert/strict";
import test from "node:test";
import { governanceFixture, human, now } from "./governance-fixture";
import { executeInvestorCommand } from "../src/server/investor/service";
import { getInvestorProposalReviewContext } from "../src/server/investor/proposal-review";
import { revision } from "../src/server/ledger/service";
import { syntheticProfile } from "./investor-fixture";

for (const at of [now, "2026-10-22T00:00:01.000Z", "2026-10-22T07:59:59.000Z", "2026-10-22T18:00:00.000Z"]) {
  test("synthetic fixture constructs an internally consistent real-time-readable timeline at " + at, () => {
    const f = governanceFixture(undefined, "0", "100000", true, "CNY", undefined, [], at);
    try {
      assert.equal(f.options.now, at);
      executeInvestorCommand(f.db, human, { action: "save_profile", profile: syntheticProfile, expected_revision: 0, idempotency_key: "fictional-profile" }, at);
      executeInvestorCommand(f.db, human, { action: "link_portfolio", portfolio_id: f.portfolio, expected_ledger_revision: revision(f.db, f.portfolio),
        expected_revision: 1, idempotency_key: "fictional-link" }, at);
      const p = f.proposal(); assert.equal(p.risk.status, "pass", JSON.stringify(p.risk));
      const c = getInvestorProposalReviewContext(f.db, human, p.id, new Date(Date.parse(at) + 1000).toISOString(), f.options);
      assert.equal(c.selected!.current_risk.status, "pass"); assert.ok(c.selected!.allowed_operations.includes("approve"));
      assert.equal(Date.parse(c.selected!.expires_at) - Date.parse(at), 30 * 60 * 1000);
      assert.equal((f.db.prepare("SELECT count(*) n FROM reservations").get() as { n: number }).n, 0);
      if (at === now) assert.equal(c.selected!.created_at, now);
    } finally { f.close(); }
  });
}
test("fresh synthetic FX and later-price rows retain coherent timestamps and no process clock is replaced", () => {
  const at = "2026-10-22T18:00:00.000Z", before = Date.now();
  const f = governanceFixture(undefined, "0", "100000", true, "USD", "125", [], at);
  try {
    const rows = f.db.prepare("SELECT observed_at,published_at,ingested_at FROM market_observations").all() as { observed_at: string; published_at: string; ingested_at: string }[];
    assert.ok(rows.length > 10); assert.ok(rows.every(row => row.observed_at <= row.published_at && row.published_at <= row.ingested_at && row.ingested_at <= at));
    assert.ok(Date.now() >= before);
  } finally { f.close(); }
  for (const invalid of ["invalid", "2026-02-30T12:00:00.000Z", "2026-10-22T18:00:00.123Z", "2026-10-22T18:00:00Z"])
    assert.throws(() => governanceFixture(undefined, "0", "100000", true, "CNY", undefined, [], invalid));
});
