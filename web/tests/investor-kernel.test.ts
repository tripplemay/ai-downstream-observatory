import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { canonical, hash } from "../src/server/ledger/service";
import { modelAssessmentObservation, parseInvestorKernelOutput, verifyInvestorKernelResult } from "../src/server/investor/kernel-contracts";
import { investorProfileSchema, modelChangeSchema } from "../src/server/investor/schemas";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { investorActor, investorFixture, saveSyntheticProfile, seedSyntheticCandidate } from "./investor-fixture";
import { formatResearchMoney, formatResearchMoneyDelta } from "../src/components/workbench/research-format";
import { fixedPolicyDecisionRule } from "../src/server/investor/fixed-policy";

const python = process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3";
const root = new URL("../../", import.meta.url);
function fixture(code: string): Record<string, unknown> {
  const child = spawnSync(python, ["-c", "import json; from tests.investor.fixtures import *; " + code], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
function run(request: unknown, synthetic = false): Record<string, unknown> {
  const child = spawnSync(python, ["-m", "worker.investor", ...(synthetic ? ["--allow-synthetic"] : [])],
    { cwd: root, input: JSON.stringify(request), encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  return parseInvestorKernelOutput(request, child.stdout);
}
function researchRequest(loss: string | null): Record<string, unknown> {
  return fixture(`d,p,s=research_input(); print(json.dumps({'action':'research','dataset':d,'plan':p,'policy':s,'profile':profile(${loss === null ? "None" : JSON.stringify(loss)})}))`);
}
function monitorRequest(): { action: "monitor"; document: Record<string, unknown>; now: string } {
  return fixture("print(json.dumps({'action':'monitor','document':monitor_input(),'now':MONITOR_NOW}))") as ReturnType<typeof monitorRequest>;
}
function reseal(result: Record<string, unknown>) {
  const { result_hash: _, ...body } = result; return { ...body, result_hash: hash(body) };
}

test("Python strategy results use strict shared Node schemas; unknown risk never selects weights", () => {
  const request = researchRequest(null), result = run(request, true);
  assert.equal(result.status, "risk_options_ready");
  assert.equal(result.selected_parameters, null);
  assert.equal(result.holdout_unseen_status, "not_independently_verified");
  assert.equal(result.live_advice_eligible, false);
  assert.deepEqual(investorProfileSchema.parse(request.profile), request.profile);
  const changed = structuredClone(request); (changed.profile as Record<string, unknown>).loss_tolerance = "0.30";
  assert.throws(() => verifyInvestorKernelResult(changed, result), /RESULT_INVALID/);
  assert.throws(() => verifyInvestorKernelResult(request, { ...result, live_advice_eligible: true }), /RESULT_INVALID/);
});

test("versioned low-frequency rules cross Python and Node without approving unknown risk", () => {
  const request = fixture("d,p,s=fixed_policy_input(); print(json.dumps({'action':'research','dataset':d,'plan':p,'policy':s,'profile':profile()}))");
  const result = run(request, true);
  assert.equal(result.status, "risk_options_ready"); assert.equal(result.selected_parameters, null);
  const parameters = ((request.policy as Record<string, unknown>).candidates as Record<string, unknown>[])[0];
  const pythonRule = fixture("from worker.investor.fixed_policy import decision_rule; d,p,s=fixed_policy_input(); print(json.dumps({'rule':decision_rule(s['candidates'][0])}))");
  assert.equal(fixedPolicyDecisionRule(parameters), pythonRule.rule);
  assert.match(pythonRule.rule as string, /5 个百分点/);
  assert.equal(fixedPolicyDecisionRule({ schema_version: "research-fixed-rebalance-parameters-v1" }), undefined);
  for (const mutate of [
    (value: Record<string, unknown>) => { value.roles = { "CN:ALPHA": "defensive", "CN:BETA": "defensive" }; },
    (value: Record<string, unknown>) => { value.class_drift_threshold = "0"; },
    (value: Record<string, unknown>) => { value.minimum_days_between_rebalances = 0; },
  ]) {
    const altered = structuredClone(request), candidates = (altered.policy as Record<string, unknown>).candidates as Record<string, unknown>[];
    mutate(candidates[0]);
    const changedResult = reseal({ ...result, policy_hash: hash(altered.policy) });
    assert.throws(() => verifyInvestorKernelResult(altered, changedResult), /RESULT_INVALID/);
  }
});

test("reconstructed availability crosses Python and Node without becoming point-in-time evidence", () => {
  const request = researchRequest(null), dataset = request.dataset as Record<string, unknown>;
  dataset.mode = "reconstructed";
  for (const row of dataset.observations as Record<string, unknown>[]) {
    row.assumed_available_at = row.published_at; delete row.published_at;
  }
  const result = run(request);
  assert.equal(result.data_mode, "reconstructed"); assert.equal(result.status, "risk_options_ready");
  assert.equal(result.live_advice_eligible, false); assert.equal(result.holdout_unseen_status, "not_independently_verified");
  assert.ok((result.limits as string[]).some(value => value.includes("not a point-in-time archive")));
  assert.throws(() => verifyInvestorKernelResult(request, reseal({ ...result, data_mode: "historical_point_in_time" })), /RESULT_INVALID/);
});

test("fixed selected candidate crosses train validation holdout without schema or phase ambiguity", () => {
  const request = researchRequest("0.30"), result = run(request, true);
  assert.equal(result.status, "reference_ready");
  assert.deepEqual((result.phase_evidence as Record<string, unknown>[]).map(row => row.phase), ["train", "validation", "holdout"]);
  const tampered = structuredClone(result); (tampered.phase_evidence as Record<string, unknown>[]).reverse();
  assert.throws(() => verifyInvestorKernelResult(request, reseal(tampered)), /RESULT_INVALID/);
  const substituted = structuredClone(result); (substituted.candidates as Record<string, unknown>[])[0].weights = { "CN:ALPHA": "0.9", "CN:BETA": "0.1" };
  assert.throws(() => verifyInvestorKernelResult(request, reseal(substituted)), /RESULT_INVALID/);
});

test("resealed negative drawdown or role-shock losses cannot bypass a positive risk budget", () => {
  const request = researchRequest("0.30"), result = run(request, true);
  for (const mutate of [
    (value: Record<string, unknown>) => { (value.phase_evidence as Record<string, unknown>[])[2].max_drawdown = "-0.45"; },
    (value: Record<string, unknown>) => {
      const candidate = (value.candidates as Record<string, unknown>[]).find(row => row.risk_budget_pass === true)!;
      candidate.train = { ...(candidate.train as Record<string, unknown>), max_drawdown: "-0.45" };
    },
    (value: Record<string, unknown>) => { ((value.candidates as Record<string, unknown>[])[0].stresses as Record<string, unknown>[])[0].portfolio_return = "0"; },
  ]) {
    const changed = structuredClone(result); mutate(changed);
    assert.throws(() => verifyInvestorKernelResult(request, reseal(changed)), /RESULT_INVALID/);
  }
});

test("model kernel maps normal observation, planned funding and stale-market states into app contracts", () => {
  for (const outcome of ["observe", "decision_required", "insufficient_evidence"]) {
    const request = monitorRequest();
    if (outcome === "decision_required") request.document.funding_intent = { id: "synthetic-flow", amount_cny: "2000", expected_at: request.now };
    if (outcome === "insufficient_evidence") (request.document.quotes as Record<string, unknown>[])[1].observed_at = "2025-07-07T08:00:00.000Z";
    const result = run(request), observation = modelAssessmentObservation(request, result);
    assert.equal(observation.outcome, outcome);
    assert.equal(observation.evaluated_at, request.now);
    assert.equal(observation.monitoring, "not_enabled");
    assert.equal(observation.model_change?.assessment_hash, result.result_hash);
    assert.equal(observation.model_change?.market_cutoffs.HK, outcome === "insufficient_evidence" ? "2025-07-07T08:00:00.000Z" : "2025-07-08T08:00:00.000Z");
    if (outcome === "insufficient_evidence") assert.deepEqual(observation.gaps[0].affected_markets, ["HK"]);
  }
});

test("Node independently checks observed NAV and hypothetical cash and does not accept resealed arithmetic changes", () => {
  const request = monitorRequest(); request.document.funding_intent = { id: "synthetic-flow", amount_cny: "2000", expected_at: request.now };
  const result = run(request);
  for (const mutate of [
    (value: Record<string, unknown>) => { value.model_nav_cny = "12000"; },
    (value: Record<string, unknown>) => { value.hypothetical_cash_remaining_cny = "999"; },
    (value: Record<string, unknown>) => { value.market_cutoffs = { CN: "2025-07-08T20:00:00.000Z" }; },
    (value: Record<string, unknown>) => { (value.changes as Record<string, unknown>[])[0].proposed_change_cny = "-1"; },
    (value: Record<string, unknown>) => { value.execution_authorized = true; },
  ]) {
    const altered = structuredClone(result); mutate(altered);
    assert.throws(() => verifyInvestorKernelResult(request, reseal(altered)), /RESULT_INVALID/);
  }
  assert.throws(() => parseInvestorKernelOutput(request, '{"outcome":"observe","outcome":"decision_required"}'));
});

test("v2 monitor includes unpaid dividends in valuation but not spendable funding cash", () => {
  const value = fixture(`from tests.investor.test_model_state import model_fixture,next_snapshot; from worker.investor.model_state import advance_model; d,s=model_fixture(); first=advance_model(d,s,None,MONITOR_NOW)['checkpoint']; ex,now=next_snapshot(s); q=ex['quotes'][1]; q['close']='120'; ex['corporate_actions']=[{'id':'ex','listing_id':q['listing_id'],'kind':'dividend_ex','currency':'HKD','net_per_unit':'5','entitlement_id':'income','tax_assumption_hash':'a'*64,'effective_at':q['observed_at'],'known_at':now}]; result=advance_model(d,ex,first,now); print(json.dumps({'request':result['monitor_request'],'result':result['assessment']}))`);
  const request = value.request as { action: "monitor"; document: Record<string, unknown>; now: string }, result = value.result as Record<string, unknown>;
  assert.equal(request.document.non_cash_assets_cny, "120");
  const output = modelAssessmentObservation(request, result);
  assert.equal(output.model_change?.model_nav_cny, "10000");
  assert.equal(request.document.cash_cny, "0");
  const altered = structuredClone(request); altered.document.non_cash_assets_cny = "0";
  const forged = { ...result, input_version: hash({ document: altered.document, funding_due: false }) };
  assert.throws(() => verifyInvestorKernelResult(altered, reseal(forged)), /RESULT_INVALID/);
});

test("future-known or expired evidence cannot be resealed into no-action; precision is never rounded", () => {
  for (const kind of ["future", "stale"]) {
    const request = monitorRequest();
    (request.document.quotes as Record<string, unknown>[])[0][kind === "future" ? "known_at" : "observed_at"] = kind === "future" ? "2025-07-08T23:00:00.000001Z" : "2025-07-07T07:00:00.000Z";
    const result = run(request), fake = run(monitorRequest());
    fake.input_version = result.input_version; fake.market_cutoffs = result.market_cutoffs; fake.data_cutoff = result.data_cutoff;
    assert.throws(() => verifyInvestorKernelResult(request, reseal(fake)), /RESULT_INVALID/);
  }
  const request = monitorRequest(); request.now = "2025-07-08T23:00:00.000001Z";
  assert.throws(() => modelAssessmentObservation(request, run(request)), /RESULT_INVALID/);
});

test("computed model card survives immutable app read/review with zero actual-finance writes", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f);
    const candidate = seedSyntheticCandidate(f), request = monitorRequest(), initial = getInvestorState(f.db, investorActor, "2026-01-02T12:00:02.000Z"), profile = initial.profile!;
    request.document.profile_id = profile.id; request.document.profile_version = profile.version; request.document.profile_hash = profile.content_hash;
    request.now = "2026-01-02T12:00:03.000Z";
    for (const row of [...request.document.quotes as Record<string, string>[], ...request.document.fx as Record<string, string>[]]) {
      for (const key of ["observed_at", "known_at", "valid_until", "expected_close_at"]) if (row[key]) row[key] = row[key].replace("2025-07-08", "2026-01-01").replace("2025-07-09", "2026-01-03");
      row.known_at = request.now;
    }
    (request.document.policy as Record<string, unknown>).max_fx_age_seconds = 172800;
    request.document.funding_intent = { id: "synthetic-flow", amount_cny: "2000", expected_at: request.now };
    const generated = modelAssessmentObservation(request, run(request));
    // Isolated fixture only; production publication must additionally bind qualified sources and leases.
    const weights = request.document.after_weights as Record<string, string>;
    const plan = { ...candidate.plan, input_version: generated.input_version, data_cutoff: generated.data_cutoff!, created_at: request.now,
      targets: Object.entries(weights).map(([listing_id, weight]) => ({ listing_id, weight, symbol: listing_id, name: "Synthetic " + listing_id,
        market: listing_id.slice(0, 2), currency: listing_id.startsWith("CN") ? "CNY" : listing_id.startsWith("HK") ? "HKD" : "USD", role: "Synthetic role", overlap_summary: "Synthetic only" })) };
    const planId = "synthetic-computed-plan", observationId = "synthetic-computed-observation";
    f.db.prepare("INSERT INTO investor_reference_plans(id,workspace_id,profile_id,document_json,content_hash,created_at) VALUES(?,?,?,?,?,?)")
      .run(planId, initial.workspace_id, profile.id, canonical(plan), hash(plan), plan.created_at);
    const observation = generated;
    f.db.prepare("INSERT INTO investor_observations(id,workspace_id,profile_id,candidate_plan_id,outcome,document_json,content_hash,input_version,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(observationId, initial.workspace_id, profile.id, planId, observation.outcome, canonical(observation), hash(observation), observation.input_version, observation.evaluated_at);
    const state = getInvestorState(f.db, investorActor, "2026-01-02T12:00:04.000Z");
    assert.equal(state.effective_outcome, "decision_required");
    assert.equal(state.latest?.document.model_change?.model_nav_cny, "10000");
    assert.equal(state.plan?.document.data_mode, "synthetic");
    executeInvestorCommand(f.db, investorActor, { action: "review", expected_revision: state.revision, idempotency_key: "synthetic-review-computed", observation_id: observationId, decision: "defer", note: "Synthetic computed card only" }, "2026-01-02T12:00:05.000Z");
    assert.equal(getInvestorState(f.db, investorActor, "2026-01-02T12:00:06.000Z").decisions[0].decision, "defer");
    for (const table of ["portfolios", "accounts", "ledger_events", "approval_events", "activations", "reservations", "execution_reports"]) {
      assert.equal((f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n, 0);
    }
  } finally { f.close(); }
});

test("model change contract rejects negative costs, over-one exact weights and duplicate unchecked gates", () => {
  const request = monitorRequest(), observation = modelAssessmentObservation(request, run(request)), change = observation.model_change!;
  for (const mutate of [
    (value: typeof change) => { value.estimated_cost_cny = "-1"; },
    (value: typeof change) => { value.changes[0].after_target_weight = "1.000000000000000001"; },
    (value: typeof change) => { value.constraints_not_checked.fill("lot_size"); },
  ]) { const altered = structuredClone(change); mutate(altered); assert.equal(modelChangeSchema.safeParse(altered).success, false); }
});

test("research money presentation rounds half-even with exact cents, never floating point", () => {
  assert.equal(formatResearchMoney("10000"), "10,000.00");
  assert.equal(formatResearchMoney("3.838388"), "3.84");
  assert.equal(formatResearchMoney("1.005"), "1.00");
  assert.equal(formatResearchMoney("1.015"), "1.02");
  assert.equal(formatResearchMoney("-0.001"), "0.00");
  assert.equal(formatResearchMoney("99999999999999999999999999999999999999.995"), "100,000,000,000,000,000,000,000,000,000,000,000,000.00");
  assert.equal(formatResearchMoney(null), "未能计算");
  for (const invalid of ["NaN", "1e3", "01", " 1", "1.000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001"]) {
    assert.throws(() => formatResearchMoney(invalid));
  }
});

test("nonzero model deltas cannot masquerade as exact zero after cent display rounding", () => {
  for (const value of ["0.001", "0.005", "0." + "0".repeat(118) + "1"]) {
    assert.equal(formatResearchMoneyDelta(value), "+<0.01");
    assert.equal(formatResearchMoneyDelta("-" + value), "-<0.01");
  }
  for (const value of ["0", "0.00", "-0.000"]) assert.equal(formatResearchMoneyDelta(value), "0.00");
  assert.equal(formatResearchMoneyDelta("0.006"), "0.01");
  assert.equal(formatResearchMoneyDelta("-0.006"), "-0.01");
  assert.equal(formatResearchMoneyDelta("1200"), "1,200.00");
  assert.throws(() => formatResearchMoneyDelta("1e-50"));
});
