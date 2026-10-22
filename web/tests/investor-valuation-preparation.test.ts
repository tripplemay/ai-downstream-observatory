import assert from "node:assert/strict";
import test from "node:test";
import { canonical, revision } from "../src/server/ledger/service";
import { storeMarketReferenceSource, publishMarketReference, type CalendarFacts } from "../src/server/market-references/service";
import { enqueueWorkbenchTask, registerListing } from "../src/server/workbench-commands";
import { getInvestorValuationContext } from "../src/server/investor/valuation";
import { getInvestorHoldings } from "../src/server/investor/holdings";
import { executeInvestorCommand } from "../src/server/investor/service";
import { preparedValuationDraft, buildValuationIntent } from "../src/components/workbench/investor-valuation-client";
import { completedCalendarSession } from "../src/server/valuation-calendars";
import { holdingsPython, investorHoldingsFixture } from "./investor-holdings-fixture";
import { publishValuationFixtureMarket, valuationAt as at } from "./investor-valuation-market-fixture";

type Fixture = ReturnType<typeof investorHoldingsFixture>;
function calendar(f: Fixture, version = 0, now = at(0), facts: Partial<CalendarFacts> = {}, owner = f.actor) {
  const actor = { ...owner, kind: "human" as const }, micros = now.replace("Z", "000Z");
  const document = { kind: "calendar" as const, facts: { market: "CN" as const, exchange: "SSE", timezone: "Asia/Shanghai", range_start: "2026-01-01", range_end: "2026-01-02",
    days: [{ date: "2026-01-01", kind: "full" as const, close_at: "2026-01-01T07:00:00.000000Z" },
      { date: "2026-01-02", kind: "half" as const, close_at: "2026-01-02T03:00:00.000000Z" }], ...facts } };
  const source = storeMarketReferenceSource(f.db, actor, { portfolio_id: f.portfolio, idempotency_key: "cal-source-" + document.facts.exchange + version,
    reference: "Fictional human-reviewed calendar, not an exchange certification", content_text: canonical(document) }, { now: micros });
  return publishMarketReference(f.db, actor, { portfolio_id: f.portfolio, idempotency_key: "cal-review-" + document.facts.exchange + version,
    expected_version: version, source_id: source.id, source_hash: source.content_hash, review_reason: "Fictional explicit review", acknowledgement: true, document }, { now: micros });
}
const context = (f: Fixture, second = 2) => getInvestorValuationContext(f.db, f.actor, at(second), f.readOptions);
function input(f: Fixture) { const c = context(f); return { ...buildValuationIntent(c, { ...preparedValuationDraft(c), fxAge: "86400", acknowledged: true }), expected_revision: c.workspace_revision, idempotency_key: "fictional-prepared-valuation" }; }

test("read-only preparation derives audited half-day sessions and unique whole-market/FX coverage, never approval or FX tolerance", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    f.reconcile(); publishValuationFixtureMarket(f); const proof = calendar(f), before = f.db.prepare("SELECT total_changes() n").get(), c = context(f);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    assert.equal(c.preparation.markets[0].expected_session, "2026-01-02"); assert.equal(c.preparation.markets[0].suggested_scope, "FICTIONAL:prices");
    assert.equal(c.preparation.markets[0].calendar_checks[0].version_id, proof.id); assert.deepEqual(c.preparation.markets[0].gaps, []);
    assert.equal(c.preparation.fx.suggested_scope, "FICTIONAL:fx"); assert.equal(c.preparation.fx.candidates[0].oldest_age_seconds, 11);
    const draft = preparedValuationDraft(c); assert.equal(draft.fxAge, ""); assert.equal(draft.acknowledged, false); assert.match(draft.reference, /待人工核查/);
    const command = input(f), financial = f.db.prepare("SELECT count(*) n FROM ledger_events").get(); executeInvestorCommand(f.db, f.actor, command, at(3), f.readOptions);
    holdingsPython(f, "tests.investor.valuation_fixture", ["--now", at(4)]);
    assert.equal(getInvestorHoldings(f.db, f.actor, at(5), f.readOptions).snapshot?.nav_cny, "260"); assert.deepEqual(f.db.prepare("SELECT count(*) n FROM ledger_events").get(), financial);
    const manifest = JSON.parse((f.db.prepare("SELECT market_manifest FROM valuation_runs").get() as { market_manifest: string }).market_manifest);
    assert.equal(manifest.rules.calendar_checks[0].version_id, proof.id); assert.equal(manifest.rules.calendar_checks[0].content_hash, proof.content_hash);
  } finally { f.close(); }
});

test("new reviewed calendar invalidates draft, queued calculation and an already displayed snapshot without deleting history", () => {
  for (const phase of ["draft", "queued", "displayed"] as const) {
    const f = investorHoldingsFixture({ securities: true }); try {
      f.reconcile(); publishValuationFixtureMarket(f); calendar(f); const command = input(f);
      const receipt = phase === "draft" ? null : executeInvestorCommand(f.db, f.actor, command, at(3), f.readOptions);
      if (phase === "displayed") { holdingsPython(f, "tests.investor.valuation_fixture", ["--now", at(4)]); assert.ok(getInvestorHoldings(f.db, f.actor, at(5), f.readOptions).snapshot); }
      calendar(f, 1, phase === "displayed" ? at(6) : at(3));
      if (phase === "draft") assert.throws(() => executeInvestorCommand(f.db, f.actor, command, at(4), f.readOptions), /CONTEXT_CONFLICT/);
      if (phase === "queued") { holdingsPython(f, "tests.investor.valuation_fixture", ["--now", at(4)]);
        const job = f.db.prepare("SELECT status,result_json FROM job_runs WHERE command_request_id=?").get(receipt!.resource_id) as { status: string; result_json: string };
        assert.equal(job.status, "skipped"); assert.equal(JSON.parse(job.result_json).code, "VALUATION_CALENDAR_INPUTS_CHANGED"); }
      const result = getInvestorHoldings(f.db, f.actor, at(7), f.readOptions); assert.equal(result.snapshot, null);
      assert.equal((f.db.prepare("SELECT count(*) n FROM valuation_runs").get() as { n: number }).n, phase === "displayed" ? 1 : 0);
    } finally { f.close(); }
  }
});

test("missing, foreign-authored, out-of-range or contradictory exchange calendars never become an automatic date", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    f.reconcile(); publishValuationFixtureMarket(f); assert.equal(context(f).preparation.markets[0].expected_session, null);
    calendar(f, 0, at(0), {}, { id: "foreign" }); assert.equal(context(f).preparation.markets[0].expected_session, null);
    calendar(f, 1, at(1), { range_end: "2026-01-01", days: [{ date: "2026-01-01", kind: "full", close_at: "2026-01-01T07:00:00.000000Z" }] });
    assert.ok(context(f).preparation.markets[0].gaps.includes("CALENDAR_UNUSABLE"));
    calendar(f, 2, at(1)); f.db.prepare("UPDATE listings SET exchange='SZSE' WHERE id=?").run(f.outside);
    calendar(f, 0, at(1), { exchange: "SZSE", days: [{ date: "2026-01-01", kind: "full", close_at: "2026-01-01T07:00:00.000000Z" }, { date: "2026-01-02", kind: "closed", close_at: null }] });
    assert.ok(context(f).preparation.markets[0].gaps.includes("CALENDAR_SESSIONS_DIFFER")); assert.equal(context(f).preparation.markets[0].expected_session, null);
  } finally { f.close(); }
});

test("multiple owner publications remain ambiguous and other actors' submissions cannot become choices", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    f.reconcile(); const documents = publishValuationFixtureMarket(f); calendar(f);
    const second = JSON.parse(JSON.stringify(documents[0])); second.batch.id = "fictional:other"; second.batch.scope = "fictional:other";
    for (const page of second.pages) for (const row of page.observations) { row.batch_id = second.batch.id; row.id += ":other"; }
    enqueueWorkbenchTask(f.db, f.actor, { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: "other-prices",
      command_type: "market_ingest", payload: { document: second, publish: true } }, at(0)); holdingsPython(f, "tests.investor.valuation_fixture", ["--now", at(1)]);
    const c = context(f); assert.equal(c.preparation.markets[0].candidate_scopes.length, 2); assert.equal(c.preparation.markets[0].suggested_scope, null);
    assert.ok(c.preparation.markets[0].gaps.includes("PRICE_SOURCE_AMBIGUOUS"));
    const original = c.sources;
    f.db.prepare("UPDATE command_requests SET actor_id='foreign' WHERE command_type='market_ingest'").run(); assert.deepEqual(context(f).sources, []);
    assert.equal(original.length, 3);
  } finally { f.close(); }
});

test("incomplete prices, reconstructed observations, missing currencies and FX older than the maximum legal rule are excluded from suggestions", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    f.reconcile(); const documents = publishValuationFixtureMarket(f); calendar(f);
    for (const [index, kind] of ["incomplete", "reconstructed", "currency", "stale"].entries()) {
      const document = JSON.parse(JSON.stringify(documents[index < 2 ? 0 : 1])), identity = "fictional:" + kind;
      document.batch.id = identity; document.batch.scope = identity;
      if (kind === "incomplete") document.pages[0].observations = document.pages[0].observations.slice(0, 1);
      if (kind === "reconstructed") document.pages[0].observations[0].provenance = "reconstructed";
      if (kind === "currency") document.pages[0].observations[0].series_key = "FX:HKD";
      if (kind === "stale") document.pages[0].observations[0].observed_at = "2025-11-29T12:00:00.000Z";
      document.batch.expected_rows = document.pages[0].observations.length;
      for (const row of document.pages[0].observations) { row.batch_id = identity; row.id += ":" + kind; row.revision_id = identity; }
      enqueueWorkbenchTask(f.db, f.actor, { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: identity,
        command_type: "market_ingest", payload: { document, publish: true } }, at(0));
    }
    holdingsPython(f, "tests.investor.valuation_fixture", ["--now", at(1)]); const c = context(f);
    assert.deepEqual(c.preparation.markets[0].candidate_scopes, ["FICTIONAL:prices"]);
    assert.deepEqual(c.preparation.fx.candidates.map(row => row.scope), ["FICTIONAL:fx"]);
    assert.equal(c.sources.length, 6);
  } finally { f.close(); }
});

test("calendar close boundary is microsecond exact, includes half-days/closed days and respects US DST", () => {
  const facts: CalendarFacts = { market: "US", exchange: "XNAS", timezone: "America/New_York", range_start: "2026-03-06", range_end: "2026-03-09",
    days: [{ date: "2026-03-06", kind: "full", close_at: "2026-03-06T21:00:00.000000Z" }, { date: "2026-03-07", kind: "closed", close_at: null },
      { date: "2026-03-08", kind: "closed", close_at: null }, { date: "2026-03-09", kind: "half", close_at: "2026-03-09T17:00:00.000000Z" }] };
  assert.equal(completedCalendarSession(facts, "2026-03-09T16:59:59.999999Z"), "2026-03-06");
  assert.equal(completedCalendarSession(facts, "2026-03-09T17:00:00.000000Z"), "2026-03-09");
  assert.equal(completedCalendarSession(facts, "2026-03-08T15:00:00.000000Z"), "2026-03-06");
  assert.throws(() => completedCalendarSession(facts, "2026-03-10T17:00:00.000000Z"));
});

test("a foreign security's currency remains an FX requirement even with zero recorded cost and no foreign cash", () => {
  const f = investorHoldingsFixture(); try {
    const listing = registerListing(f.db, f.actor, { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: "fictional-free-security",
      market: "US", exchange: "XNAS", ticker: "FICTIONAL", currency: "USD", name: "Fictional zero cost position", asset_class: "unknown", source_evidence: "Fictional test only" }, at(0));
    f.record({ type: "opening_position", account_id: f.account, listing_id: listing.listing_id, currency: "USD", quantity: "1", cost_amount: "0" });
    const c = context(f); assert.deepEqual(c.currencies, ["CNY", "USD"]); assert.equal(c.preparation.fx.required, true);
    assert.equal(c.preparation.fx.suggested_scope, null); assert.equal(c.preparation.fx.gap, "FX_SOURCE_REQUIRED");
  } finally { f.close(); }
});
