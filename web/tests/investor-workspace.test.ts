import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createPortfolio } from "../src/server/ledger/service";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { observationSchema, referencePlanSchema } from "../src/server/investor/schemas";
import { illustrateLossScenarios } from "../src/server/investor/loss-scenarios";
import { investorActor as actor, investorFixture, investorNow as now, saveSyntheticProfile, seedSyntheticCandidate, syntheticProfile } from "./investor-fixture";

const currentTime = "2026-01-02T12:00:02.000Z";
const financialTables = ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"];
function count(f: ReturnType<typeof investorFixture>, table: string) { return (f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n; }

test("investor reads are private and side-effect free, with no account prerequisite", () => {
  const f = investorFixture();
  try {
    const changes = f.db.prepare("SELECT total_changes() n").get();
    const state = getInvestorState(f.db, actor, now);
    assert.equal(state.workspace_id, null); assert.equal(state.effective_outcome, "not_started");
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes);
    financialTables.forEach(table => assert.equal(count(f, table), 0));
    assert.throws(() => getInvestorState(f.db, { id: "" }, now), /UNAUTHENTICATED/);
  } finally { f.close(); }
});

test("saving four constraints retains unknown risk and budget is never cash or a strategy weight", () => {
  const f = investorFixture();
  try {
    const portfolio = createPortfolio(f.db, actor, "Synthetic existing ledger");
    const before = financialTables.map(table => count(f, table));
    saveSyntheticProfile(f, actor, { ...syntheticProfile, illustrative_budget_cny: "250000.00", planned_annual_contribution_cny: "40000" });
    const state = getInvestorState(f.db, actor, now);
    assert.equal(state.revision, 1); assert.equal(state.profile?.document.loss_tolerance, null);
    assert.equal(state.profile?.document.research_direction, "system_design");
    assert.equal(state.plan, null); assert.equal(state.effective_outcome, "insufficient_evidence");
    assert.ok(state.effective_gaps.some(g => g.code === "RISK_BUDGET_UNCONFIRMED"));
    assert.ok(state.effective_gaps.some(g => g.code === "REFERENCE_DATASET_NOT_READY"));
    assert.ok(!state.effective_gaps.some(g => g.code.includes("DIRECTION")));
    assert.equal(state.latest?.document.monitoring, "not_enabled");
    assert.deepEqual(financialTables.map(table => count(f, table)), before);
    assert.ok(f.db.prepare("SELECT id FROM portfolios WHERE id=?").get(portfolio));
    assert.equal((f.db.prepare("SELECT portfolio_id FROM audit_events WHERE action='investor_save_profile'").get() as { portfolio_id: null }).portfolio_id, null);
  } finally { f.close(); }
});

test("commands reject forged results, unknown fields, duplicate markets and unconfirmed cash", () => {
  const f = investorFixture();
  try {
    const base = { action: "save_profile", expected_revision: 0, idempotency_key: "strict", profile: syntheticProfile };
    for (const extra of [{ actor_id: "owner" }, { result: {} }, { targets: [] }, { execution_authorized: true }])
      assert.throws(() => executeInvestorCommand(f.db, actor, { ...base, ...extra }, now));
    for (const profile of [{ ...syntheticProfile, markets: ["CN", "CN"] }, { ...syntheticProfile, actual_cash: "100" },
      { ...syntheticProfile, illustrative_budget_cny: "1e6" }, { ...syntheticProfile, loss_tolerance: "0.99" }])
      assert.throws(() => executeInvestorCommand(f.db, actor, { ...base, profile }, now));
    assert.equal(count(f, "investor_workspaces"), 0);
  } finally { f.close(); }
});

test("idempotency precedes CAS but is owner scoped and a changed body never reuses a key", () => {
  const f = investorFixture();
  try {
    const input = { action: "save_profile", expected_revision: 0, idempotency_key: "stable", profile: syntheticProfile };
    const receipt = executeInvestorCommand(f.db, actor, input, now);
    assert.deepEqual(executeInvestorCommand(f.db, actor, input, now), receipt);
    assert.throws(() => executeInvestorCommand(f.db, actor, { ...input, profile: { ...syntheticProfile, horizon_years: 8 } }, now), /DUPLICATE_CONFLICT/);
    assert.throws(() => executeInvestorCommand(f.db, actor, { ...input, idempotency_key: "stale" }, now), /VERSION_CONFLICT/);
    const other = executeInvestorCommand(f.db, { id: "other" }, input, now);
    assert.notEqual(other.workspace_id, receipt.workspace_id); assert.equal(other.revision, 1);
    assert.equal(count(f, "investor_profiles"), 2); assert.equal(count(f, "investor_observations"), 2);
  } finally { f.close(); }
});

test("evaluate and profile updates preserve append-only versions, and time cannot move backwards", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f);
    executeInvestorCommand(f.db, actor, { action: "evaluate", expected_revision: 1, idempotency_key: "eval" }, now);
    executeInvestorCommand(f.db, actor, { action: "save_profile", expected_revision: 2, idempotency_key: "v2", profile: { ...syntheticProfile, loss_tolerance: "0.20" } }, currentTime);
    const state = getInvestorState(f.db, actor, currentTime);
    assert.deepEqual(state.profile_history.map(p => p.version), [2, 1]); assert.equal(state.observations.length, 3);
    assert.ok(!state.effective_gaps.some(g => g.code === "RISK_BUDGET_UNCONFIRMED"));
    assert.throws(() => executeInvestorCommand(f.db, actor, { action: "evaluate", expected_revision: 3, idempotency_key: "backwards" }, now), /INVALID_CLOCK/);
    assert.throws(() => getInvestorState(f.db, actor, now), /INVALID_CLOCK/);
  } finally { f.close(); }
});

test("late recovery markers freeze every write, including an idempotent retry, and expose read-only state", () => {
  const f = investorFixture();
  try {
    const input = { action: "save_profile", expected_revision: 0, idempotency_key: "frozen", profile: syntheticProfile };
    executeInvestorCommand(f.db, actor, input, now);
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "SYNTHETIC LOCK\n");
    assert.equal(getInvestorState(f.db, actor, now).read_only, true);
    assert.throws(() => executeInvestorCommand(f.db, actor, input, now), /WORKBENCH_READ_ONLY/);
    assert.throws(() => executeInvestorCommand(f.db, actor, { action: "evaluate", expected_revision: 1, idempotency_key: "new" }, now), /WORKBENCH_READ_ONLY/);
    assert.equal(count(f, "investor_commands"), 1);
  } finally { f.close(); }
});

test("all three human decisions and plan selection persist without authorizing trades", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); const seed = seedSyntheticCandidate(f);
    for (const [i, decision] of (["accept_idea", "defer", "reject"] as const).entries())
      executeInvestorCommand(f.db, actor, { action: "review", observation_id: seed.observationId, decision, note: "Synthetic opinion", expected_revision: i + 1, idempotency_key: decision }, currentTime);
    executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: seed.planId, expected_revision: 4, idempotency_key: "selection" }, currentTime);
    const state = getInvestorState(f.db, actor, currentTime);
    assert.deepEqual(state.decisions.map(d => d.decision), ["reject", "defer", "accept_idea"]);
    assert.equal(state.plan?.saved_for_observation, true); assert.equal(state.revision, 5);
    assert.equal(state.effective_outcome, "decision_required");
    financialTables.forEach(table => assert.equal(count(f, table), 0));
    const audits = f.db.prepare("SELECT payload_json FROM audit_events WHERE action IN ('investor_review','investor_save_plan')").all() as { payload_json: string }[];
    assert.equal(audits.length, 4); audits.forEach(row => assert.equal(JSON.parse(row.payload_json).result.execution_authorized, false));
  } finally { f.close(); }
});

test("owned workspace references never cross principals", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); const seed = seedSyntheticCandidate(f);
    saveSyntheticProfile(f, { id: "other" });
    for (const input of [{ action: "review", observation_id: seed.observationId, decision: "accept_idea", note: "" }, { action: "save_plan", plan_id: seed.planId }])
      assert.throws(() => executeInvestorCommand(f.db, { id: "other" }, { ...input, expected_revision: 1, idempotency_key: input.action }, currentTime), /OUT_OF_SCOPE/);
    assert.equal(getInvestorState(f.db, { id: "other" }, currentTime).plan, null);
    assert.equal(count(f, "investor_decisions"), 0);
  } finally { f.close(); }
});

test("observe is not a reviewable decision and an older observation cannot be reviewed", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); const seed = seedSyntheticCandidate(f, "observe");
    assert.throws(() => executeInvestorCommand(f.db, actor, { action: "review", observation_id: seed.observationId, decision: "accept_idea", note: "", expected_revision: 1, idempotency_key: "observe" }, currentTime), /NO_DECISION_REQUIRED/);
    const first = seedSyntheticCandidate(f), latest = seedSyntheticCandidate(f);
    assert.equal(getInvestorState(f.db, actor, currentTime).latest?.id, latest.observationId);
    assert.throws(() => executeInvestorCommand(f.db, actor, { action: "review", observation_id: first.observationId, decision: "reject", note: "", expected_revision: 1, idempotency_key: "old" }, currentTime), /NOT_CURRENT/);
  } finally { f.close(); }
});

test("expired plans and missed review deadlines fail closed without rewriting historical conclusions", () => {
  for (const options of [{ validUntil: "2026-01-03T12:00:00.000Z" }, { nextReview: "2026-01-03T12:00:00.000Z" }]) {
    const f = investorFixture();
    try {
      saveSyntheticProfile(f); const seed = seedSyntheticCandidate(f, "decision_required", actor, options);
      const later = "2026-01-03T12:00:00.000Z", state = getInvestorState(f.db, actor, later);
      assert.equal(state.effective_outcome, "insufficient_evidence"); assert.equal(state.latest?.document.outcome, "decision_required");
      assert.ok(state.effective_gaps.length > 0);
      assert.throws(() => executeInvestorCommand(f.db, actor, { action: "review", observation_id: seed.observationId, decision: "accept_idea", note: "", expected_revision: 1, idempotency_key: "expired" }, later), /NOT_CURRENT/);
      assert.equal(count(f, "investor_decisions"), 0);
    } finally { f.close(); }
  }
});

test("updated constraints invalidate saved references without turning them into current holdings", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); const seed = seedSyntheticCandidate(f);
    executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: seed.planId, expected_revision: 1, idempotency_key: "save" }, currentTime);
    executeInvestorCommand(f.db, actor, { action: "save_profile", expected_revision: 2, idempotency_key: "profile", profile: { ...syntheticProfile, horizon_years: 6 } }, "2026-01-02T12:00:03.000Z");
    const state = getInvestorState(f.db, actor, "2026-01-02T12:00:03.000Z");
    assert.equal(state.plan?.quality, "different_profile"); assert.equal(state.effective_outcome, "insufficient_evidence");
    assert.throws(() => executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: seed.planId, expected_revision: 3, idempotency_key: "resave" }, "2026-01-02T12:00:03.000Z"), /PROFILE_CHANGED/);
  } finally { f.close(); }
});

test("canonical hashes, row metadata and observation input bindings are checked before display", () => {
  for (const options of [{ rowCreatedAt: now }, { observationInputVersion: "a".repeat(64) }]) {
    const f = investorFixture();
    try {
      saveSyntheticProfile(f); seedSyntheticCandidate(f, "observe", actor, options);
      assert.throws(() => getInvestorState(f.db, actor, currentTime), /EVIDENCE_INVALID/);
    } finally { f.close(); }
  }
  const f = investorFixture();
  try {
    saveSyntheticProfile(f);
    f.db.exec("DROP TRIGGER investor_profile_no_update");
    f.db.prepare("UPDATE investor_profiles SET content_hash=?").run("b".repeat(64));
    assert.throws(() => getInvestorState(f.db, actor, now), /EVIDENCE_INVALID/);
  } finally { f.close(); }
});

test("research history rejects update, delete and INSERT OR REPLACE at the storage boundary", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); const seed = seedSyntheticCandidate(f);
    executeInvestorCommand(f.db, actor, { action: "review", observation_id: seed.observationId, decision: "defer", note: "", expected_revision: 1, idempotency_key: "review" }, currentTime);
    executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: seed.planId, expected_revision: 2, idempotency_key: "save" }, currentTime);
    for (const table of ["investor_workspaces", "investor_profiles", "investor_reference_plans", "investor_observations", "investor_decisions", "investor_plan_selections", "investor_commands"]) {
      const columns = (f.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name).join(",");
      const field = table === "investor_commands" ? "owner_id" : "id";
      assert.throws(() => f.db.exec(`UPDATE ${table} SET ${field}=${field}`));
      assert.throws(() => f.db.exec(`DELETE FROM ${table}`));
      assert.throws(() => f.db.exec(`INSERT OR REPLACE INTO ${table}(${columns}) SELECT ${columns} FROM ${table} LIMIT 1`));
    }
    assert.equal((f.db.pragma("foreign_key_check") as unknown[]).length, 0);
  } finally { f.close(); }
});

test("plan weights use exact decimal arithmetic and positive positions, not floating tolerances", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); const { plan, observation } = seedSyntheticCandidate(f);
    for (const weights of [["0.59999999", "0.4"], ["0.6", "0.40000001"], ["0.00000000", "1"], ["-0.1", "1.1"]])
      assert.equal(referencePlanSchema.safeParse({ ...plan, targets: plan.targets.map((t, i) => ({ ...t, weight: weights[i] })) }).success, false);
    assert.equal(referencePlanSchema.safeParse({ ...plan, targets: plan.targets.map((t, i) => ({ ...t, weight: ["0.66666667", "0.33333333"][i] })) }).success, true);
    assert.equal(observationSchema.safeParse({ ...observation, data_cutoff: null }).success, false);
    assert.equal(observationSchema.safeParse({ ...observation, next_review_at: now }).success, false);
  } finally { f.close(); }
});

test("loss scenarios are explicit arithmetic and never assign a risk band or forecast", () => {
  const rows = illustrateLossScenarios("12345.67");
  assert.deepEqual(rows.map(r => r.loss_percent), [10, 20, 30, 40, 50]);
  assert.deepEqual(rows[1], { loss_percent: 20, recovery_gain_percent: "25.0", loss_cny: "2469.13", remaining_cny: "9876.54" });
  assert.equal(rows[4].recovery_gain_percent, "100.0");
  for (const input of [null, "-1", "1e6", "10.001", "1000000000000"])
    assert.ok(illustrateLossScenarios(input).every(r => r.loss_cny === null && r.remaining_cny === null));
  assert.equal(illustrateLossScenarios("0.01")[4].loss_cny, "0.01");
  assert.equal(illustrateLossScenarios("999999999999.99")[4].remaining_cny, "499999999999.99");
});
