import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { hash } from "../src/server/ledger/service";
import { Decimal } from "../src/server/ledger/decimal";
import { modelAssessmentObservation, parseInvestorKernelOutput, verifyInvestorKernelResult } from "../src/server/investor/kernel-contracts";
import { replayEvidenceAssessment } from "../src/server/investor/evidence-model-assessment";

type Obj = Record<string, unknown>;
type Request = { action: "monitor"; document: Obj; now: string };
const python = process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3";
const root = new URL("../../", import.meta.url);
const fixture = spawnSync(python, ["-c", "import json; from tests.investor.policy_monitor_fixtures import vectors; print(json.dumps(vectors()))"],
  { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 });
assert.equal(fixture.status, 0, fixture.stderr);
const vectors = JSON.parse(fixture.stdout) as { name: string; request: Request }[];
const cases = new Map(vectors.map(row => [row.name, row.request]));
function run(request: Request) {
  const child = spawnSync(python, ["-m", "worker.investor"], { cwd: root, input: JSON.stringify(request), encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  return parseInvestorKernelOutput(request, child.stdout);
}
function reseal(value: Obj) { const { result_hash: _, ...body } = value; return { ...body, result_hash: hash(body) }; }
const results = new Map<string, Obj>();
for (const { name, request } of vectors) {
  test(`fixed-policy independent Python/Node replay: ${name}`, () => {
    const before = structuredClone(request), result = run(request);
    const independent: Obj = replayEvidenceAssessment(request.document, request.now, result.implementation_hash as string);
    assert.deepEqual(result, independent);
    assert.deepEqual(request, before);
    assert.equal(result.schema_version, "investor-model-assessment-v2");
    assert.equal(result.execution_authorized, false); assert.equal(result.actual_holdings_linked, false); assert.equal(result.live_advice_eligible, false);
    const observation = modelAssessmentObservation(request, result);
    assert.equal(observation.outcome, result.outcome);
    assert.equal(observation.monitoring, "not_enabled");
    results.set(name, result);
  });
}

test("frozen class rules, source failures and unexecuted ideas have independent replay assertions", () => {
  assert.equal(results.get("within-class-swap")!.outcome, "observe");
  assert.equal(results.get("inclusive-class-threshold")!.outcome, "decision_required");
  assert.equal(results.get("below-class-threshold")!.outcome, "observe");
  assert.deepEqual(results.get("cooldown-breach")!.reason_codes, ["POLICY_COOLDOWN_NO_NEW_ADVICE", "CLASS_WEIGHT_BREACH"]);
  assert.equal((results.get("dst-local-days-not-48-hours")!.policy_evaluation as Obj).cooldown_active, false);
  for (const name of ["missing-costs", "cost-cap", "stale-market", "expired-exact-boundary"]) {
    assert.equal(results.get(name)!.outcome, "insufficient_evidence");
    assert.deepEqual(results.get(name)!.next_policy_state, (cases.get(name)!.document.fixed_policy as Obj).state);
  }
  for (const name of ["open-funding-keeps-anchor", "equivalent-funding-spelling-keeps-anchor", "open-model-cash-keeps-anchor"]) {
    const state = (cases.get(name)!.document.fixed_policy as Obj).state as Obj;
    assert.equal(results.get(name)!.outcome, "decision_required");
    assert.equal((results.get(name)!.next_policy_state as Obj).last_proposed_at, state.last_proposed_at);
  }
});

test("model CNY cash uses one NAV and reserves costs without treating foreign valuation as available cash", () => {
  const result = results.get("new-model-cash-no-double-funding")!, changes = result.changes as Obj[];
  assert.equal(result.model_nav_cny, "11000"); assert.equal(result.funding_status, "none");
  assert.equal(changes.reduce((sum, row) => sum.add(row.hypothetical_target_value_cny as string), new Decimal(0)).toFixed(), "11000");
  assert.equal(changes.reduce((sum, row) => sum.add(row.proposed_change_cny as string), new Decimal(0))
    .add(result.estimated_cost_cny as string).add(result.hypothetical_cash_remaining_cny as string).toFixed(), "1000");
  assert.equal(results.get("foreign-cash-is-not-cny-repair")!.allocation_method, "band_rebalance_research_not_executable");
});

test("resealing policy anchors, class calculations, cost budgets or proposal amounts does not pass verification", () => {
  const request = cases.get("new-funding-bypasses-cooldown")!, original = results.get("new-funding-bypasses-cooldown")!;
  const mutations = [
    (value: Obj) => { (value.next_policy_state as Obj).last_proposed_at = "2025-07-01T23:00:00Z"; },
    (value: Obj) => { (value.next_policy_state as Obj).last_funding_hash = "e".repeat(64); },
    (value: Obj) => { (value.policy_evaluation as Obj).parameters_hash = "f".repeat(64); },
    (value: Obj) => { (value.policy_evaluation as Obj).cooldown_active = false; },
    (value: Obj) => { ((value.policy_evaluation as Obj).class_drift as Obj[])[0].threshold_breached = false; },
    (value: Obj) => { value.model_nav_cny = "12000"; },
    (value: Obj) => { value.estimated_cost_cny = "0"; },
    (value: Obj) => { (value.changes as Obj[])[0].proposed_change_cny = "-1"; },
    (value: Obj) => { value.next_policy_state = (request.document.fixed_policy as Obj).state; },
    (value: Obj) => { value.execution_authorized = true; },
  ];
  for (const mutate of mutations) { const altered = structuredClone(original); mutate(altered); assert.throws(() => verifyInvestorKernelResult(request, reseal(altered)), /RESULT_INVALID/); }
});

test("frozen tolerance and private chronology cannot be replaced by legacy bands or caller assertions", () => {
  const request = cases.get("balanced")!, result = results.get("balanced")!;
  const changes = [
    (value: Request) => { (value.document.policy as Obj).weight_band = "0"; },
    (value: Request) => { ((value.document.fixed_policy as Obj).state as Obj).last_proposed_at = value.now; },
    (value: Request) => { ((value.document.fixed_policy as Obj).state as Obj).last_review_at = "2025-07-09T00:00:00Z"; },
    (value: Request) => { ((value.document.fixed_policy as Obj).parameters as Obj).class_drift_threshold = "0.0500000000000000001"; },
    (value: Request) => { (value.document.fixed_policy as Obj).evaluation_timezone = "Private/NotAZone"; },
    (value: Request) => { ((value.document.fixed_policy as Obj).parameters as Obj).roles = { "CN:ALPHA": "growth" }; },
  ];
  for (const mutate of changes) { const altered = structuredClone(request); mutate(altered); assert.throws(() => verifyInvestorKernelResult(altered, result), /RESULT_INVALID/); }
});

test("invalid costs, duplicate scope and negative assets cannot hide behind a stale-data result", () => {
  const request = cases.get("stale-market")!, result = results.get("stale-market")!;
  const changes = [
    (value: Request) => { (value.document.quantities as Obj)["CN:ALPHA"] = "-1"; },
    (value: Request) => { value.document.cash_cny = "-1"; },
    (value: Request) => { (value.document.quotes as Obj[]).push(structuredClone((value.document.quotes as Obj[])[0])); },
    (value: Request) => { (value.document.fx as Obj[]).push(structuredClone((value.document.fx as Obj[])[0])); },
    (value: Request) => { ((value.document.policy as Obj).costs as Obj).commission_bps = "10000"; },
    (value: Request) => { ((value.document.policy as Obj).costs as Obj).minimum_fee_cny = "-1"; },
    (value: Request) => { value.document.funding_intent = { id: "negative", amount_cny: "-1", expected_at: value.now }; },
  ];
  for (const mutate of changes) {
    const altered = structuredClone(request); mutate(altered);
    const forged = reseal({ ...result, input_version: hash({ document: altered.document, funding_due: altered.document.funding_intent !== null }) });
    assert.throws(() => verifyInvestorKernelResult(altered, forged), /RESULT_INVALID/);
  }
});
