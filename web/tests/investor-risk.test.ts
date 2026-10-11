import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { currentRiskCandidates, investorRiskIdentity, riskBudgetIntent, riskIllustrationCapital } from "../src/components/workbench/investor-risk-client";
import { InvestorRiskPanel } from "../src/components/workbench/investor-risk-panel";
import { projectRiskScenario } from "../src/server/investor/risk-scenarios";
import { formatResearchPercent } from "../src/components/workbench/research-format";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";

const binding = "a".repeat(64), now = "2026-01-02T12:00:04.000Z";
function studyState(f: ReturnType<typeof investorFixture>) {
  saveSyntheticProfile(f);
  function helper(mode: string) {
    execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", "tests.investor.queue_fixture", "--db", f.filename, "--mode", mode],
      { cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 65536 });
  }
  helper("register");
  executeInvestorCommand(f.db, actor, { action: "evaluate", expected_revision: 1, idempotency_key: "risk-fixture-evaluate" }, "2026-01-02T12:00:02.000Z");
  helper("compute");
  return getInvestorState(f.db, actor, now);
}

test("static risk amounts preserve cents and distinguish recovery from future funding", () => {
  const row = projectRiskScenario("-0.30", "1200");
  assert.equal(row.change_cny, "-360.00"); assert.equal(row.remaining_cny, "840.00");
  assert.ok(row.recovery_gain!.startsWith("0.42857142857"));
  assert.equal(row.basis, "static_hypothetical_amount_not_account_or_peak_valuation");
  assert.equal(projectRiskScenario("-0.50", "0.01").change_cny, "-0.01");
  assert.equal(projectRiskScenario("-0.50", "0.01").remaining_cny, "0.00");
  assert.equal(projectRiskScenario("0.50", "0.01").change_cny, "0.01");
  assert.equal(projectRiskScenario("-0.10", "999999999999.99").remaining_cny, "899999999999.99");
  assert.equal(projectRiskScenario("-1", "1200").recovery_gain, null);
  assert.equal(projectRiskScenario("-1", "1200").remaining_cny, "0.00");
  assert.equal(projectRiskScenario("-0.00", "0").portfolio_return, "0");
  assert.equal(projectRiskScenario("0.10", null).capital_cny, null);
  assert.equal(projectRiskScenario("0.10", null).remaining_cny, null);
  assert.equal(projectRiskScenario("0.10", null).recovery_gain, "0");
  assert.equal(projectRiskScenario("-0.4" + "9".repeat(119), "0.01").change_cny, "0.00");
  assert.doesNotThrow(() => formatResearchPercent(projectRiskScenario("-0." + "0".repeat(119) + "1", null).recovery_gain));
  assert.doesNotThrow(() => formatResearchPercent(projectRiskScenario("-0." + "9".repeat(120), null).recovery_gain));
});
test("risk projection rejects malformed, unbounded or implicit currency amounts", () => {
  for (const rate of ["NaN", "Infinity", "1e-2", "+0.2", "01", "-1.01", "1.01", " 0.2", "0." + "1".repeat(121)])
    assert.throws(() => projectRiskScenario(rate, "1200"), /SCENARIO_INVALID/);
  for (const amount of ["", "-1", "01", "1.001", "1e3", "1000000000000", "1,200", "1200 CNY"])
    assert.throws(() => projectRiskScenario("-0.2", amount), /AMOUNT_INVALID/);
});
test("rendering an unknown risk keeps all choices unselected and performs no commands", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); const state = getInvestorState(f.db, actor, now); let calls = 0;
    const markup = renderToStaticMarkup(createElement(InvestorRiskPanel, { state, binding, disabled: false, onCommand: () => { calls++; } }));
    assert.equal(calls, 0); assert.doesNotMatch(markup, /checked=""/);
    assert.equal((markup.match(/name="risk-budget"/g) ?? []).length, 5);
    assert.match(markup, /尚未确认/); assert.match(markup, /只有算术示意/); assert.match(markup, /不授权交易/);
    assert.match(markup, /暂不确定，保持未确认/); assert.equal(state.profile!.document.loss_tolerance, null);
  } finally { f.close(); }
});
test("risk illustration uses only current initial planned capital, never future additions or stale funding", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f, actor, { ...syntheticProfile, illustrative_budget_cny: "2500", planned_annual_contribution_cny: "900" });
    assert.equal(riskIllustrationCapital(getInvestorState(f.db, actor, now)), "2500");
    executeInvestorCommand(f.db, actor, { action: "save_funding_plan", expected_revision: 1, idempotency_key: "fictional-risk-funding",
      funding_plan: { schema_version: "investor-funding-plan-v1", start_date: "2026-01-01", horizon_years: 1, evaluation_timezone: "Asia/Shanghai",
        initial_capital_cny: "1200", annual_contribution_cny: "300", first_annual_date: "2026-12-31", entry_method: "three_tranches_60_days",
        actual_arrivals_confirmed: false, execution_authorized: false, live_advice_eligible: false } }, now);
    const state = getInvestorState(f.db, actor, now);
    assert.equal(riskIllustrationCapital(state), "1200");
    state.funding.status = "requires_review"; assert.equal(riskIllustrationCapital(state), "2500");
  } finally { f.close(); }
});
test("risk intent requires explicit acknowledgement and current scope, preserves every other answer", () => {
  const f = investorFixture();
  try {
    const profile = { ...syntheticProfile, exclusions: ["Fictional theme"], illustrative_budget_cny: "2500", planned_annual_contribution_cny: "900" };
    saveSyntheticProfile(f, actor, profile);
    const state = getInvestorState(f.db, actor, now), identity = investorRiskIdentity(state, binding);
    assert.throws(() => riskBudgetIntent(state, binding, identity, "0.20", false), /REVIEW_REQUIRED/);
    for (const choice of ["", "0.25", "0.2", "null", "0.60"]) assert.throws(() => riskBudgetIntent(state, binding, identity, choice, true), /INPUT_INVALID/);
    assert.throws(() => riskBudgetIntent(state, "b".repeat(64), identity, "0.20", true), /REVIEW_REQUIRED/);
    assert.throws(() => riskBudgetIntent({ ...state, revision: state.revision + 1 }, binding, identity, "0.20", true), /REVIEW_REQUIRED/);
    assert.throws(() => riskBudgetIntent({ ...state, read_only: true }, binding, identity, "0.20", true), /REVIEW_REQUIRED/);
    assert.deepEqual(riskBudgetIntent(state, binding, identity, "0.20", true), { action: "save_profile", profile: { ...profile, loss_tolerance: "0.20" } });
    assert.equal(investorRiskIdentity({ ...state, checked_at: "2026-01-02T12:00:06.000Z" }, binding), identity);
    const selected = structuredClone(state); selected.profile!.document.loss_tolerance = "0.20";
    assert.throws(() => riskBudgetIntent(selected, binding, investorRiskIdentity(selected, binding), "0.20", true), /UNCHANGED/);
  } finally { f.close(); }
});
test("risk confirmation reuses CAS and idempotency, queues research but never changes financial facts", () => {
  const f = investorFixture();
  try {
    const state = studyState(f), intent = riskBudgetIntent(state, binding, investorRiskIdentity(state, binding), "0.20", true);
    const command = { ...intent, expected_revision: state.revision, idempotency_key: "risk-fixture-confirm" };
    const receipt = executeInvestorCommand(f.db, actor, command, now);
    assert.deepEqual(executeInvestorCommand(f.db, actor, command, now), receipt);
    assert.throws(() => executeInvestorCommand(f.db, actor, { ...command, idempotency_key: "stale-second-choice" }, now), /VERSION_CONFLICT/);
    const after = getInvestorState(f.db, actor, now);
    assert.deepEqual(after.profile!.document, { ...state.profile!.document, loss_tolerance: "0.20" });
    assert.equal(after.profile!.version, state.profile!.version + 1); assert.equal(after.research_task!.status, "queued");
    assert.equal(after.research_task!.study, null); assert.equal(after.plan, null); assert.equal(after.live_advice_eligible, false);
    for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
      assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
  } finally { f.close(); }
});
test("candidate risks keep registry order, failed peers and source expiry instead of ranking or upgrading", () => {
  const f = investorFixture();
  try {
    const state = studyState(f), original = state.research_task!.study!;
    assert.deepEqual(currentRiskCandidates(state, Date.parse(now))!.candidates.map(row => row.parameters_hash), original.candidates.map(row => row.parameters_hash));
    const modified = structuredClone(state); modified.research_task!.study!.candidates[0].usable = false;
    modified.research_task!.study!.candidates[1].train_drawdown = "-1.1";
    const markup = renderToStaticMarkup(createElement(InvestorRiskPanel, { state: modified, binding, disabled: false, onCommand: () => { throw new Error("UNEXPECTED_WRITE"); } }));
    assert.match(markup, /合成数据软件测试/); assert.match(markup, /不能作为合格候选/); assert.match(markup, /比例未通过核对/);
    assert.equal((markup.match(/登记候选 \d/g) ?? []).length, 3);
    modified.research_task!.profile_id = "different-profile"; assert.equal(currentRiskCandidates(modified, Date.parse(now)), null);
    const expired = structuredClone(state);
    expired.research_task!.study!.source_context = { valid_until: now } as never;
    assert.equal(currentRiskCandidates(expired, Date.parse(now)), null);
    assert.equal(currentRiskCandidates({ ...state, research_task: null }, Date.parse(now)), null);
  } finally { f.close(); }
});
