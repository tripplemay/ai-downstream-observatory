import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { fundingPlanSchema, fundingTimeline, type InvestorFundingPlan } from "../src/server/investor/funding-schemas";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { InvestorFundingPanel } from "../src/components/workbench/investor-funding-panel";
import { investorActor as actor, investorFixture, investorNow as now, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";

const plan: InvestorFundingPlan = { schema_version: "investor-funding-plan-v1", start_date: "2026-01-01", horizon_years: 10,
  evaluation_timezone: "Asia/Shanghai", initial_capital_cny: "1200", annual_contribution_cny: "300", first_annual_date: "2027-01-01",
  entry_method: "three_tranches_60_days", actual_arrivals_confirmed: false, execution_authorized: false, live_advice_eligible: false };
const binding = "a".repeat(64), later = "2026-01-02T12:00:02.000Z";
function command(expected_revision = 1, idempotency_key = "fictional-funding", funding_plan = plan) {
  return { action: "save_funding_plan", expected_revision, idempotency_key, funding_plan };
}
function financial(db: ReturnType<typeof investorFixture>["db"]) {
  return ["portfolios", "accounts", "ledger_heads", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"]
    .map(table => ({ table, rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() }));
}
test("private timeline conserves cents, excludes the end date and never calls plans returns", () => {
  const timeline = fundingTimeline(plan);
  assert.equal(timeline.horizon_end_exclusive, "2036-01-01"); assert.equal(timeline.total_planned_principal_cny, "3900.00");
  assert.equal(timeline.lots.length, 10); assert.equal(timeline.lots[9].arrival_date, "2035-01-01");
  assert.deepEqual(fundingTimeline({ ...plan, initial_capital_cny: "100.01", annual_contribution_cny: "0", first_annual_date: null }).lots[0].tranches.map(row => row.amount_cny), ["33.33", "33.33", "33.35"]);
  assert.equal(fundingTimeline({ ...plan, first_annual_date: plan.start_date }).lots.length, 11);
  const outside = fundingTimeline({ ...plan, horizon_years: 1, first_annual_date: "2026-12-31" }).lots.at(-1)!;
  assert.deepEqual(outside.tranches.map(row => row.within_horizon), [true, false, false]);
  assert.equal("profit_cny" in timeline, false);
});
test("funding contracts reject unknown grants, invalid dates, missing arrivals and zero-sized tranches", () => {
  for (const change of [{ actual_arrivals_confirmed: true }, { execution_authorized: true }, { live_advice_eligible: true }, { source_certified: true },
    { initial_capital_cny: "0" }, { initial_capital_cny: "0.02" }, { annual_contribution_cny: "0", first_annual_date: "2027-01-01" },
    { annual_contribution_cny: "300", first_annual_date: null }, { first_annual_date: "2036-01-01" }, { first_annual_date: "2025-01-01" },
    { horizon_years: 11 }, { start_date: "2024-02-29", horizon_years: 1 }, { start_date: "2026-02-30" },
    { start_date: "2023-01-01", first_annual_date: "2024-02-29" }, { evaluation_timezone: "+01:00" }])
    assert.equal(fundingPlanSchema.safeParse({ ...plan, ...change }).success, false, JSON.stringify(change));
});
test("Node and Python independently produce the same bounded planned timeline from the shared closed contract", () => {
  const vectors = [plan, { ...plan, first_annual_date: plan.start_date }, { ...plan, entry_method: "immediate" as const },
    { ...plan, initial_capital_cny: "100.01", annual_contribution_cny: "0", first_annual_date: null },
    { ...plan, evaluation_timezone: "America/New_York" as const, horizon_years: 1, first_annual_date: "2026-12-31" }];
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3", ["-c",
    "import json,sys; from worker.investor.funding_plan import funding_timeline; print(json.dumps([funding_timeline(p) for p in json.load(sys.stdin)]))"],
    { cwd: path.resolve(".."), input: JSON.stringify(vectors), encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), vectors.map(fundingTimeline));
  const contract = JSON.parse(readFileSync(path.resolve("../contracts/v1/investor-funding-plan.schema.json"), "utf8"));
  assert.equal(contract.additionalProperties, false);
});
test("funding saves are owner scoped, audited, immutable, idempotent and independent of research and financial facts", () => {
  const f = investorFixture();
  try {
    assert.throws(() => executeInvestorCommand(f.db, actor, command(0), now), /PROFILE_REQUIRED/);
    assert.equal(getInvestorState(f.db, actor, now).workspace_id, null);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_workspaces").get() as { n: number }).n, 0);
    saveSyntheticProfile(f); const before = getInvestorState(f.db, actor, later), facts = financial(f.db);
    const receipt = executeInvestorCommand(f.db, actor, command(), later);
    assert.deepEqual(executeInvestorCommand(f.db, actor, command(), later), receipt);
    assert.throws(() => executeInvestorCommand(f.db, actor, command(1, "fictional-funding", { ...plan, initial_capital_cny: "1201" }), later), /DUPLICATE_CONFLICT/);
    assert.throws(() => executeInvestorCommand(f.db, actor, command(1, "stale"), later), /VERSION_CONFLICT/);
    const state = getInvestorState(f.db, actor, later);
    assert.equal(state.revision, 2); assert.equal(state.funding.status, "planned"); assert.equal(state.funding.plan?.version, 1);
    assert.equal(state.profile?.document.loss_tolerance, null);
    assert.deepEqual([state.latest, state.research_task, state.model_watch], [before.latest, before.research_task, before.model_watch]);
    assert.deepEqual(financial(f.db), facts); assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    assert.equal(getInvestorState(f.db, { id: "other-owner" }, later).funding.status, "not_configured");
    for (const sql of ["DELETE FROM investor_funding_plans", "UPDATE investor_funding_plans SET version=version+1",
      "INSERT OR REPLACE INTO investor_funding_plans SELECT * FROM investor_funding_plans"])
      assert.throws(() => f.db.exec(sql));
    executeInvestorCommand(f.db, actor, command(2, "second"), later);
    assert.equal(getInvestorState(f.db, actor, later).funding.plan?.version, 2);
  } finally { f.close(); }
});
test("profile changes require funding review; saved amounts never silently follow illustrative profile amounts", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); executeInvestorCommand(f.db, actor, command(), later);
    executeInvestorCommand(f.db, actor, { action: "save_profile", profile: { ...syntheticProfile, horizon_years: 5, illustrative_budget_cny: "900" }, expected_revision: 2, idempotency_key: "profile-change" }, later);
    const state = getInvestorState(f.db, actor, later);
    assert.equal(state.funding.status, "requires_review"); assert.equal(state.funding.plan?.document.initial_capital_cny, "1200");
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    assert.throws(() => executeInvestorCommand(f.db, actor, command(3, "too-long"), later), /FUNDING_HORIZON_CONFLICT/);
    assert.equal(getInvestorState(f.db, actor, later).revision, 3);
    executeInvestorCommand(f.db, actor, command(3, "reviewed", { ...plan, horizon_years: 5 }), later);
    assert.equal(getInvestorState(f.db, actor, later).funding.status, "planned");
  } finally { f.close(); }
});
test("private funding client rejects fabricated totals, dates, current-profile bindings, future records and permission flags", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); executeInvestorCommand(f.db, actor, command(), later);
    const state = getInvestorState(f.db, actor, later);
    for (const change of [(s: typeof state) => { s.funding.plan!.timeline.total_planned_principal_cny = "9999.00"; },
      (s: typeof state) => { s.funding.plan!.timeline.lots[0].tranches[0].release_date = "2026-01-02"; },
      (s: typeof state) => { s.funding.plan!.profile_hash = "b".repeat(64); },
      (s: typeof state) => { s.funding.plan!.created_at = "2027-01-01T00:00:00.000Z"; },
      (s: typeof state) => { s.funding.status = "requires_review"; },
      (s: typeof state) => { s.funding.actual_cash_linked = true as never; }]) {
      const altered = structuredClone(state); change(altered);
      assert.throws(() => parseInvestorState({ ...altered, session_binding: binding }, binding), /RESPONSE_INVALID/);
    }
  } finally { f.close(); }
});
test("corrupt optional funding audit is unavailable without breaking independent research or overwriting history", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); const receipt = executeInvestorCommand(f.db, actor, command(), later);
    const triggers = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_events' AND sql LIKE '%UPDATE%'").all() as { name: string }[];
    for (const row of triggers) f.db.exec(`DROP TRIGGER ${row.name}`);
    f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run('{"input":{},"result":{}}', receipt.audit_id);
    const state = getInvestorState(f.db, actor, later);
    assert.equal(state.funding.status, "unavailable"); assert.equal(state.funding.plan, null); assert.ok(state.profile); assert.ok(state.research_task);
    assert.throws(() => executeInvestorCommand(f.db, actor, command(2, "overwrite"), later), /FUNDING_EVIDENCE_INVALID/);
    assert.equal(getInvestorState(f.db, actor, later).revision, 2);
  } finally { f.close(); }
});
test("private funding is readable but not mutable during restore mode and SSR never labels principal as performance", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); executeInvestorCommand(f.db, actor, command(), later);
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "FICTIONAL FUNDING RECOVERY LOCK\n");
    const state = getInvestorState(f.db, actor, later); assert.equal(state.read_only, true); assert.equal(state.funding.status, "planned");
    assert.throws(() => executeInvestorCommand(f.db, actor, command(2, "read-only"), later), /WORKBENCH_READ_ONLY/);
    const markup = renderToStaticMarkup(createElement(InvestorFundingPanel, { state: state.funding, profile: state.profile!, disabled: true, onCommand() {}, onEditingChange() {} }));
    assert.match(markup, /长期投入安排/); assert.match(markup, /3900.00/); assert.match(markup, /没有预测收益/); assert.match(markup, /disabled/);
  } finally { f.close(); }
});
