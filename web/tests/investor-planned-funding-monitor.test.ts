import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { hash } from "../src/server/ledger/service";
import type { InvestorFundingPlan } from "../src/server/investor/funding-schemas";
import { plannedFundingContextHash, projectPlannedFundingMonitor, verifyPlannedFundingMonitor, type PlannedFundingBinding, type PlannedFundingRequest } from "../src/server/investor/planned-funding-monitor";
import { validateInvestorMonitorDataDocument } from "../src/server/investor/kernel-contracts";
import { aiMonitorContextSchema } from "../src/server/investor/ai-explanation-schemas";

function request(evaluated = "2027-01-01T00:00:00.000Z", changes: Partial<InvestorFundingPlan> = {}, binding: Partial<PlannedFundingBinding> = {}): PlannedFundingRequest {
  const plan: InvestorFundingPlan = { schema_version: "investor-funding-plan-v1", start_date: "2026-01-01", horizon_years: 10,
    evaluation_timezone: "Asia/Shanghai", initial_capital_cny: "1200", annual_contribution_cny: "300", first_annual_date: "2027-01-01",
    entry_method: "three_tranches_60_days", actual_arrivals_confirmed: false, execution_authorized: false, live_advice_eligible: false, ...changes };
  return { schema_version: "investor-planned-funding-monitor-v1", funding_plan: plan, binding: { funding_plan_id: "fictional-funding:1",
    funding_plan_hash: hash(plan), profile_hash: "a".repeat(64), model_id: "fictional-model", model_hash: "b".repeat(64),
    model_created_at: "2026-01-02T12:00:00.000Z", plan_declared_at: "2026-01-03T12:00:00.000Z", ...binding }, evaluated_at: evaluated };
}

test("annual funding is normalized hypothetical capital, never initial tranches or accounting authority", () => {
  const result = projectPlannedFundingMonitor(request(undefined, { entry_method: "immediate" }));
  assert.equal(result.due_amount_normalized_cny, "2500"); assert.equal(result.initial_notional_cny, "10000");
  assert.equal(result.status, "hypothetical_due"); assert.equal(result.releases.length, 9);
  assert.ok(result.releases.every(row => row.id.startsWith("annual:")));
  assert.equal(result.qualification, "unadmitted_planned_funding_projection");
  assert.deepEqual([result.actual_arrivals_confirmed, result.model_cash_changed, result.model_units_changed, result.execution_authorized, result.live_advice_eligible],
    [false, false, false, false, false]);
  for (const field of ["cash_cny", "quantities", "model_nav_cny", "annual_contribution_cny"]) assert.equal(field in result, false);
  assert.throws(() => validateInvestorMonitorDataDocument("input", result));
  assert.throws(() => validateInvestorMonitorDataDocument("projection", result));
  assert.equal(aiMonitorContextSchema.safeParse(result).success, false);
});

test("exact cents are pooled before rational normalization and repeated reviews do not consume them", () => {
  const changes = { initial_capital_cny: "100.01", annual_contribution_cny: "10.01" };
  const first = projectPlannedFundingMonitor(request(undefined, changes)), whole = projectPlannedFundingMonitor(request("2027-03-02T00:00:00.000Z", changes));
  assert.equal(first.due_amount_normalized_cny, "332.966703329667033296");
  assert.equal(whole.due_amount_normalized_cny, "1000.899910008999100089");
  assert.equal(whole.funding_intent!.amount_cny, whole.due_amount_normalized_cny);
  const repeated = projectPlannedFundingMonitor(request("2027-03-03T00:00:00.000Z", changes));
  assert.deepEqual(whole.funding_intent, repeated.funding_intent);
  assert.notEqual(whole.input_version, repeated.input_version);
  const anotherYear = projectPlannedFundingMonitor(request("2028-03-02T00:00:00.000Z", changes));
  assert.equal(anotherYear.due_amount_normalized_cny, "2001.799820017998200179");
  assert.notEqual(anotherYear.funding_intent!.id, whole.funding_intent!.id);
});

test("future intent and half-open validity change only at the exact local release boundary", () => {
  const future = projectPlannedFundingMonitor(request("2026-12-31T15:59:59.999Z")), due = projectPlannedFundingMonitor(request("2026-12-31T16:00:00.000Z"));
  assert.equal(future.status, "not_due"); assert.equal(future.due_amount_normalized_cny, "0");
  assert.equal(future.valid_until, due.evaluated_at); assert.equal(due.status, "hypothetical_due");
  assert.deepEqual(future.funding_intent, due.funding_intent);
});

test("stable context ignores poll time but fences exact release boundaries and the exclusive horizon end", () => {
  const before = request("2026-12-31T15:59:59.998Z"), almost = request("2026-12-31T15:59:59.999Z"), due = request("2026-12-31T16:00:00.000Z");
  assert.notEqual(projectPlannedFundingMonitor(before).input_version, projectPlannedFundingMonitor(almost).input_version);
  assert.equal(plannedFundingContextHash(before), plannedFundingContextHash(almost));
  assert.notEqual(plannedFundingContextHash(almost), plannedFundingContextHash(due));
  assert.equal(plannedFundingContextHash(due), plannedFundingContextHash(request()));
  assert.notEqual(plannedFundingContextHash(request()), plannedFundingContextHash(request("2027-01-30T16:00:00.000Z")));
  const short = { horizon_years: 1, first_annual_date: "2026-12-31" };
  assert.notEqual(plannedFundingContextHash(request("2026-12-31T15:59:59.999Z", short)),
    plannedFundingContextHash(request("2026-12-31T16:00:00.000Z", short)));
});

test("context is rebuilt from the closed plan request and includes every frozen identity", () => {
  const value = request(), before = structuredClone(value), original = plannedFundingContextHash(value);
  assert.deepEqual(value, before);
  for (const change of [{ funding_plan_id: "fictional-funding:2" }, { profile_hash: "c".repeat(64) }, { model_id: "different-model" },
    { model_hash: "d".repeat(64) }, { model_created_at: "2026-01-03T12:00:00.000Z" }, { plan_declared_at: "2026-01-04T12:00:00.000Z" }])
    assert.notEqual(original, plannedFundingContextHash(request(undefined, {}, change)));
  assert.notEqual(original, plannedFundingContextHash(request(undefined, { annual_contribution_cny: "301" })));
  for (const bad of [projectPlannedFundingMonitor(value), { ...value, context_hash: original }, request(undefined, {}, { funding_plan_hash: "e".repeat(64) })])
    assert.throws(() => plannedFundingContextHash(bad));
});

test("later model or registration anchor excludes past releases even one millisecond earlier", () => {
  for (const field of ["model_created_at", "plan_declared_at"] as const) {
    const result = projectPlannedFundingMonitor(request("2027-01-16T00:00:00.000Z", {}, { [field]: "2027-01-15T00:00:00.000Z" }));
    assert.equal(result.status, "not_due"); assert.equal(result.releases[0].status, "excluded_before_anchor");
    assert.equal(result.funding_intent!.expected_at, "2027-01-30T16:00:00.000Z");
  }
  for (const [delta, expected] of [["000", "due"], ["001", "excluded_before_anchor"]]) {
    const result = projectPlannedFundingMonitor(request(undefined, {}, { plan_declared_at: `2026-12-31T16:00:00.${delta}Z` }));
    assert.equal(result.releases[0].status, expected);
  }
});

test("no annual plan, wholly excluded releases, and expired plan remain distinct", () => {
  const none = projectPlannedFundingMonitor(request(undefined, { annual_contribution_cny: "0", first_annual_date: null }));
  assert.equal(none.status, "none"); assert.deepEqual(none.releases, []); assert.equal(none.funding_intent, null);
  const excluded = projectPlannedFundingMonitor(request("2026-12-01T00:00:00.000Z", { horizon_years: 1, first_annual_date: "2026-01-01" },
    { plan_declared_at: "2026-04-01T00:00:00.000Z" }));
  assert.equal(excluded.status, "no_eligible_releases"); assert.equal(excluded.funding_intent, null);
  const short = { horizon_years: 1, first_annual_date: "2026-12-31" };
  const before = projectPlannedFundingMonitor(request("2026-12-31T00:00:00.000Z", short));
  assert.deepEqual(before.releases.map(row => row.status), ["due", "excluded_outside_horizon", "excluded_outside_horizon"]);
  const expired = projectPlannedFundingMonitor(request(before.valid_until!, short));
  assert.equal(expired.status, "expired"); assert.equal(expired.funding_intent, null); assert.equal(expired.valid_until, null); assert.equal(expired.next_release_at, null);
});

test("new plan, model or profile version changes the intent identity but never shifts the model units", () => {
  const before = projectPlannedFundingMonitor(request());
  for (const change of [{ funding_plan_id: "fictional-funding:2" }, { model_hash: "c".repeat(64) }, { profile_hash: "d".repeat(64) }]) {
    const after = projectPlannedFundingMonitor(request(undefined, {}, change));
    assert.notEqual(before.funding_intent!.id, after.funding_intent!.id); assert.equal(before.funding_intent!.amount_cny, after.funding_intent!.amount_cny);
    assert.equal(after.model_units_changed, false); assert.equal(after.model_cash_changed, false);
  }
});

test("closed input rejects unknown permissions, invalid clocks, plan mismatches and invalid money", () => {
  const value = request();
  for (const changed of [{ ...value, actual_cash_linked: true }, { ...value, evaluated_at: "2027-02-30T00:00:00.000Z" },
    { ...value, evaluated_at: "2027-01-01T00:00:00.000001Z" }, request(undefined, {}, { funding_plan_hash: "c".repeat(64) }),
    request(undefined, {}, { model_created_at: "2028-01-01T00:00:00.000Z" }), request(undefined, { initial_capital_cny: "0" }),
    request(undefined, { annual_contribution_cny: "0", first_annual_date: "2027-01-01" }), request(undefined, { execution_authorized: true as never })])
    assert.throws(() => projectPlannedFundingMonitor(changed));
});

test("verifier independently rebuilds membership and math even when the attacker rehashes a result", () => {
  const input = request(), original = structuredClone(input), result = projectPlannedFundingMonitor(input);
  assert.deepEqual(verifyPlannedFundingMonitor(input, result), result); assert.deepEqual(input, original);
  for (const change of [{ due_amount_normalized_cny: "999" }, { anchor_at: "2026-01-01T00:00:00.000Z" },
    { qualification: "owner_reviewed_reconstructed" }, { execution_authorized: true }]) {
    const { result_hash: _, ...body } = { ...result, ...change };
    assert.throws(() => verifyPlannedFundingMonitor(input, { ...body, result_hash: hash(body) }));
  }
  const altered = structuredClone(result); altered.releases[0].status = "scheduled";
  const { result_hash: _, ...body } = altered;
  assert.throws(() => verifyPlannedFundingMonitor(input, { ...body, result_hash: hash(body) }));
  result.binding.model_id = "changed"; assert.deepEqual(input, original);
});

test("both engines reject nonexistent historical local midnight instead of silently shifting release time", () => {
  const values = ([["Asia/Shanghai", "1919-04-13"], ["Asia/Hong_Kong", "1941-12-25"]] as const).map(([evaluation_timezone, day]) => {
    const year = day.slice(0, 4);
    return request(year + "-12-31T00:00:00.000Z", { start_date: year + "-01-01", horizon_years: 1, first_annual_date: day,
      evaluation_timezone, entry_method: "immediate" }, { model_created_at: year + "-01-02T00:00:00.000Z", plan_declared_at: year + "-01-03T00:00:00.000Z" });
  });
  for (const value of values) assert.throws(() => projectPlannedFundingMonitor(value));
  const output = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c",
    "import json,sys; from worker.investor.planned_funding_monitor import project_planned_funding_monitor; out=[]\nfor v in json.load(sys.stdin):\n try: project_planned_funding_monitor(v); out.append(False)\n except ValueError: out.append(True)\nprint(json.dumps(out))"],
    { cwd: path.resolve(".."), input: JSON.stringify(values), encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
  assert.equal(output.status, 0, output.stderr); assert.deepEqual(JSON.parse(output.stdout), [true, true]);
});

test("Python and Node independently match all normalized releases, DST, negative epochs, horizons and extreme amounts", () => {
  const vectors: PlannedFundingRequest[] = [request(), request("2026-12-31T15:59:59.999Z"), request("2026-12-31T16:00:00.000Z"),
    request("2027-03-02T00:00:00.000Z", { initial_capital_cny: "100.01", annual_contribution_cny: "10.01" }),
    request(undefined, { annual_contribution_cny: "0", first_annual_date: null }),
    request("2026-12-01T00:00:00.000Z", { horizon_years: 1, first_annual_date: "2026-01-01" }, { plan_declared_at: "2026-04-01T00:00:00.000Z" }),
    request("2026-12-31T16:00:00.000Z", { horizon_years: 1, first_annual_date: "2026-12-31" })];
  for (const evaluation_timezone of ["Asia/Shanghai", "Asia/Hong_Kong", "America/New_York"] as const)
    for (const first_annual_date of ["2027-03-13", "2027-11-06"])
      vectors.push(request(first_annual_date + "T12:00:00.000Z", { evaluation_timezone, first_annual_date }));
  for (const initial_capital_cny of ["0.01", "3", "999999999999.99"])
    for (const annual_contribution_cny of ["0.01", "2", "999999999999.99"])
      vectors.push(request("2035-12-31T00:00:00.000Z", { initial_capital_cny, annual_contribution_cny, entry_method: "immediate", first_annual_date: "2026-01-01" },
        { model_created_at: "2025-12-31T16:00:00.000Z", plan_declared_at: "2025-12-31T16:00:00.000Z" }));
  for (const evaluation_timezone of ["Asia/Shanghai", "Asia/Hong_Kong", "America/New_York"] as const)
    vectors.push(request("1969-12-31T12:00:00.000Z", { start_date: "1969-01-01", first_annual_date: "1969-12-31", evaluation_timezone },
      { model_created_at: "1969-01-01T00:00:00.000Z", plan_declared_at: "1969-01-01T00:00:00.000Z" }));
  for (const evaluation_timezone of ["Asia/Shanghai", "Asia/Hong_Kong", "America/New_York"] as const)
    vectors.push(request("1900-01-03T00:00:00.000Z", { start_date: "1900-01-01", horizon_years: 1, first_annual_date: "1900-01-03", evaluation_timezone,
      entry_method: "immediate" }, { model_created_at: "1900-01-01T00:00:00.000Z", plan_declared_at: "1900-01-02T00:00:00.000Z" }));
  vectors.push(request(undefined, {}, { plan_declared_at: "2027-01-01T00:00:00.000Z" }));
  const output = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c",
    "import json,sys; from worker.investor.planned_funding_monitor import planned_funding_context_hash,project_planned_funding_monitor; print(json.dumps([{'projection':project_planned_funding_monitor(v),'context_hash':planned_funding_context_hash(v)} for v in json.load(sys.stdin)]))"],
    { cwd: path.resolve(".."), input: JSON.stringify(vectors), encoding: "utf8", timeout: 30000, maxBuffer: 1048576 });
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(JSON.parse(output.stdout), vectors.map(value => ({ projection: projectPlannedFundingMonitor(value), context_hash: plannedFundingContextHash(value) })));
  assert.equal(vectors.length, 29);
});
