import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { hash } from "../src/server/ledger/service";
import { fundingHistoryProjection, prepareFundedHistory, verifyFundedHistoryBinding, type FundedHistoryInput } from "../src/server/investor/funded-history";

function python(script: string, input?: unknown) {
  const result = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3", ["-c", script],
    { cwd: path.resolve(".."), input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function fixture(): FundedHistoryInput {
  return python("import json; from tests.investor.funded_history_fixtures import funded_input; print(json.dumps(funded_input()))");
}
function calculated(input: FundedHistoryInput) {
  return python("import json,sys; from worker.investor.funded_history import calculate_funded_history; print(json.dumps(calculate_funded_history(json.load(sys.stdin),allow_synthetic=True)))", input);
}
function seal(object: Record<string, unknown>) { const { result_hash: ignored, ...body } = object; void ignored; object.result_hash = hash(body); }

test("reconstructed availability is retained as an assumption and both languages reject after-cutoff ingestion", () => {
  const input = fixture(); input.dataset.mode = "reconstructed";
  for (const row of input.dataset.observations as Record<string, unknown>[]) {
    row.assumed_available_at = row.published_at; delete row.published_at; row.provenance = "reconstructed";
  }
  const independent = python("import json,sys; from worker.investor.funded_history import prepare_funded_history; p,k=prepare_funded_history(json.load(sys.stdin)); print(json.dumps({'projection':p,'input':k}))", input);
  assert.deepEqual(prepareFundedHistory(input), independent);
  assert.equal("published_at" in independent.input.dataset.observations[0], false);
  (input.dataset.observations as Record<string, unknown>[])[0].ingested_at = "2026-10-09T00:00:00Z";
  assert.throws(() => prepareFundedHistory(input), /INVESTOR_FUNDED_HISTORY_INVALID/);
});

test("future planned dates map to an explicit same-month/day past calendar without changing principal or registration", () => {
  const input = fixture(), before = structuredClone(input), prepared = prepareFundedHistory(input);
  assert.deepEqual(input, before);
  assert.equal(prepared.projection.total_assumed_principal_cny, "1500.00");
  assert.deepEqual(prepared.projection.window, { start: "2014-12-31T16:00:00.000000Z", end: "2015-12-31T15:59:59.999000Z" });
  assert.equal(prepared.input.plan.parameters_recorded_at, input.context.parameters_recorded_at);
  assert.equal("parameters_frozen_at" in prepared.input.plan, false);
  assert.equal(prepared.input.plan.study_basis, "retrospective_exploratory");
  assert.equal(prepared.projection.lots[1].staged_releases.filter(row => row.within_window).length, 1);
});

test("Node and Python independently map calendars, DST, same-day lots and exact cents", () => {
  const base = fixture(), same = structuredClone(base), zero = structuredClone(base), ny = structuredClone(base), hk = structuredClone(base), leap = structuredClone(base);
  same.funding_plan = { ...same.funding_plan, first_annual_date: same.funding_plan.start_date, initial_capital_cny: "100.01", annual_contribution_cny: "100.01" };
  zero.funding_plan = { ...zero.funding_plan, first_annual_date: null, annual_contribution_cny: "0", entry_method: "immediate" };
  ny.funding_plan = { ...zero.funding_plan, start_date: "2026-03-08", evaluation_timezone: "America/New_York" }; ny.historical_start_date = "2015-03-08";
  hk.funding_plan = { ...zero.funding_plan, start_date: "2026-10-29", evaluation_timezone: "Asia/Hong_Kong" }; hk.historical_start_date = "1972-10-29";
  leap.funding_plan = { ...zero.funding_plan, start_date: "2028-02-29", horizon_years: 4 }; leap.historical_start_date = "2020-02-29";
  const vectors = [base, same, zero, ny, hk, leap];
  const result = python("import json,sys; from worker.investor.funded_history import funding_history_projection; print(json.dumps([funding_history_projection(p) for p in json.load(sys.stdin)]))", vectors);
  assert.deepEqual(vectors.map(fundingHistoryProjection), result);
  assert.equal(result[3].lots[0].staged_releases[1].at, "2015-04-07T04:00:00.000000Z");
  assert.deepEqual(result[1].lots.map((row: { staged_releases: { amount_cny: string }[] }) => row.staged_releases.map(tranche => tranche.amount_cny)),
    [["33.33", "33.33", "33.35"], ["33.33", "33.33", "33.35"]]);
});

test("Node and Python prepare the same continuous v2 input while original v1 remains a separate contract", () => {
  for (const first of ["2026-01-01", "2026-12-31"]) {
    const input = fixture(); input.funding_plan.first_annual_date = first;
    const independent = python("import json,sys; from worker.investor.funded_history import prepare_funded_history; p,k=prepare_funded_history(json.load(sys.stdin),allow_synthetic=True); print(json.dumps({'projection':p,'input':k}))", input);
    assert.deepEqual(prepareFundedHistory(input), independent);
  }
});

test("binding replay checks actual result hashes, separate lot schedules, principal and registration without conferring publication", () => {
  const input = fixture(), result = calculated(input), binding = verifyFundedHistoryBinding(input, result);
  assert.equal(binding.economics_independently_replayed, false); assert.equal(binding.publication_eligible, false);
  const mutations = [
    (r: typeof result) => { r.projection.lots[1].arrival_at = r.projection.lots[0].arrival_at; },
    (r: typeof result) => { r.comparison.parameters_recorded_at = "2014-01-01T00:00:00Z"; },
    (r: typeof result) => { r.comparison.plan_hash = "a".repeat(64); },
    (r: typeof result) => { r.comparison.runs.staged.principal_cny = "1501"; },
    (r: typeof result) => { r.comparison.runs.immediate.profit_cny = "100"; },
    (r: typeof result) => { r.comparison.runs.staged.funding_schedule[0].tranches[0].amount_cny = "401"; },
    (r: typeof result) => { r.comparison.runs.staged.funding_schedule[1].tranches[1].within_window = true; },
    (r: typeof result) => { r.live_advice_eligible = true; },
    (r: typeof result) => { r.economics_independently_replayed = true; },
  ];
  for (const mutate of mutations) {
    const altered = structuredClone(result); mutate(altered); seal(altered.comparison); seal(altered);
    assert.throws(() => verifyFundedHistoryBinding(input, altered), /INVESTOR_FUNDED_HISTORY_INVALID/);
  }
  const coherentButUnreplayed = structuredClone(result);
  coherentButUnreplayed.comparison.runs.immediate.ending_nav_cny = "1600";
  coherentButUnreplayed.comparison.runs.immediate.profit_cny = "100";
  seal(coherentButUnreplayed.comparison); seal(coherentButUnreplayed);
  assert.equal(verifyFundedHistoryBinding(input, coherentButUnreplayed).publication_eligible, false);
});

test("mapping rejects invented permissions, month/day shifts, impossible leap translations and zero-sized comparison tranches", () => {
  const base = fixture();
  for (const mutate of [(r: FundedHistoryInput) => { r.historical_start_date = "2015-02-01"; },
    (r: FundedHistoryInput) => { r.funding_plan.execution_authorized = true as never; },
    (r: FundedHistoryInput) => { r.funding_plan = { ...r.funding_plan, entry_method: "immediate", initial_capital_cny: "0.01" }; },
    (r: FundedHistoryInput) => { r.funding_plan = { ...r.funding_plan, start_date: "2024-03-01", horizon_years: 4, first_annual_date: "2028-02-29" }; r.historical_start_date = "2015-03-01"; }]) {
    const input = structuredClone(base); mutate(input); assert.throws(() => fundingHistoryProjection(input));
  }
});

test("future windows, evidence beyond cutoff, duplicate decisions and unobserved close decisions fail before preparation", () => {
  const base = fixture();
  for (const quantum of ["0.05", "0.02", "1"]) {
    const input = structuredClone(base); input.context.execution.cash_quantum = quantum;
    assert.throws(() => prepareFundedHistory(input), /INVESTOR_FUNDED_HISTORY_INVALID/);
  }
  const equivalent = structuredClone(base); equivalent.context.execution.cash_quantum = "0.010";
  assert.deepEqual(prepareFundedHistory(equivalent), python("import json,sys; from worker.investor.funded_history import prepare_funded_history; p,k=prepare_funded_history(json.load(sys.stdin),allow_synthetic=True); print(json.dumps({'projection':p,'input':k}))", equivalent));
  for (const mutate of [(r: FundedHistoryInput) => { r.context.information_cutoff_at = "2015-01-01T00:00:00Z"; },
    (r: FundedHistoryInput) => { r.context.parameters_recorded_at = "2026-10-09T00:00:00Z"; },
    (r: FundedHistoryInput) => { (r.dataset.observations as Record<string, string>[])[0].ingested_at = "2026-10-09T00:00:00Z"; },
    (r: FundedHistoryInput) => { (r.dataset.settlements as Record<string, string>[])[0].ingested_at = "2026-10-09T00:00:00Z"; },
    (r: FundedHistoryInput) => { r.context.decision_times[1] = r.context.decision_times[0]; },
    (r: FundedHistoryInput) => { r.context.decision_times[0] = (r.dataset.sessions as Record<string, string>[])[0].close_at; },
    (r: FundedHistoryInput) => { r.context.parameters_recorded_at = "2026-10-08T00:00:00.0000001Z"; }]) {
    const input = structuredClone(base); mutate(input); assert.throws(() => prepareFundedHistory(input), /INVESTOR_FUNDED_HISTORY_INVALID/);
  }
});
