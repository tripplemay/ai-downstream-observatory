import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { canonical, hash } from "../src/server/ledger/service";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { verifyInvestorKernelResult } from "../src/server/investor/kernel-contracts";
import { investorActor as actor, investorFixture, saveSyntheticProfile, seedSyntheticCandidate, syntheticProfile } from "./investor-fixture";

const at = "2026-01-02T12:00:02.000Z", sourceAt = "2026-01-02T12:00:03.000Z", calculatedAt = "2026-01-02T12:00:04.000Z", checkedAt = "2026-01-02T12:00:05.000Z", binding = "a".repeat(64);
function helper(f: ReturnType<typeof investorFixture>, mode: "register" | "compute" | "core", now = mode === "register" ? sourceAt : calculatedAt, scenario = "normal") {
  const output = execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", "tests.investor.model_fixture", "--db", f.filename, "--mode", mode, "--now", now, "--scenario", scenario],
    { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 65536 });
  assert.equal(JSON.parse(output).status, "synthetic_model_fixture_complete");
}
function setup(f: ReturnType<typeof investorFixture>) {
  saveSyntheticProfile(f); const candidate = seedSyntheticCandidate(f);
  const input = { action: "save_plan", plan_id: candidate.planId, expected_revision: 1, idempotency_key: "model-once" };
  const result = executeInvestorCommand(f.db, actor, input, at);
  assert.deepEqual(executeInvestorCommand(f.db, actor, input, at), result);
  return candidate;
}
function noFinance(f: ReturnType<typeof investorFixture>) {
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
}

test("save reference creates one private independent model; GET does not schedule or calculate", () => {
  const f = investorFixture();
  try {
    setup(f);
    const before = f.db.prepare("SELECT total_changes() n").get(), state = getInvestorState(f.db, actor, at);
    assert.equal(state.model_watch?.status, "awaiting_inputs");
    assert.equal(state.model_watch?.enabled, true);
    assert.equal(state.model_watch?.model_nav_cny, null);
    assert.equal(state.model_watch?.checkpoint_sequence, 0);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_models").get() as { n: number }).n, 1);
    assert.equal(getInvestorState(f.db, { id: "other" }, at).model_watch, null);
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    const newerCandidate = seedSyntheticCandidate(f);
    const withUnsavedCandidate = getInvestorState(f.db, actor, checkedAt);
    assert.equal(withUnsavedCandidate.plan?.id, newerCandidate.planId);
    assert.equal(withUnsavedCandidate.model_watch?.plan_id, state.model_watch?.plan_id);
    assert.deepEqual(parseInvestorState({ ...withUnsavedCandidate, session_binding: binding }, binding), withUnsavedCandidate);
    noFinance(f);
  } finally { f.close(); }
});

test("core checks missing or synthetic input but never publishes no-action, checkpoints or trades", () => {
  for (const synthetic of [false, true]) {
    const f = investorFixture();
    try {
      setup(f); if (synthetic) helper(f, "register"); helper(f, "core");
      const state = getInvestorState(f.db, actor, checkedAt);
      assert.equal(state.model_watch?.status, "blocked");
      assert.equal(state.model_watch?.model_nav_cny, null);
      assert.equal(state.model_watch?.checkpoint_sequence, 0);
      assert.equal(state.effective_outcome, "insufficient_evidence");
      assert.equal(state.latest?.document.monitoring, "not_enabled");
      assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
      noFinance(f);
    } finally { f.close(); }
  }
});

test("test-only persistent model crosses Python and Node with immutable checkpoints and pause/resume", () => {
  const f = investorFixture();
  try {
    setup(f); helper(f, "register"); helper(f, "compute");
    let state = getInvestorState(f.db, actor, checkedAt);
    assert.equal(state.model_watch?.status, "synthetic_preview");
    assert.equal(state.model_watch?.model_nav_cny, "10000");
    assert.equal(state.model_watch?.checkpoint_sequence, 1);
    assert.equal(state.effective_outcome, "insufficient_evidence");
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    const pause = { action: "set_monitoring", model_id: state.model_watch!.id, enabled: false, expected_revision: state.revision, idempotency_key: "pause-once" };
    const receipt = executeInvestorCommand(f.db, actor, pause, checkedAt);
    assert.deepEqual(executeInvestorCommand(f.db, actor, pause, checkedAt), receipt);
    state = getInvestorState(f.db, actor, checkedAt);
    assert.equal(state.model_watch?.status, "paused"); assert.equal(state.model_watch?.model_nav_cny, null);
    helper(f, "compute", checkedAt);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_monitor_runs").get() as { n: number }).n, 1);
    executeInvestorCommand(f.db, actor, { action: "set_monitoring", model_id: state.model_watch!.id, enabled: true, expected_revision: state.revision, idempotency_key: "resume" }, checkedAt);
    helper(f, "compute", checkedAt);
    state = getInvestorState(f.db, actor, checkedAt);
    assert.equal(state.model_watch?.checkpoint_sequence, 2);
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    noFinance(f);
  } finally { f.close(); }
});

test("stale, overdue, profile changes and plan expiry never expose fresh actionable model conclusions", () => {
  const f = investorFixture();
  try {
    setup(f); helper(f, "register", sourceAt, "stale"); helper(f, "compute");
    let state = getInvestorState(f.db, actor, checkedAt);
    assert.equal(state.model_watch?.status, "blocked"); assert.equal(state.model_watch?.checkpoint_sequence, 0);
    helper(f, "register", checkedAt); helper(f, "compute", checkedAt);
    state = getInvestorState(f.db, actor, checkedAt);
    assert.equal(state.model_watch?.status, "synthetic_preview");
    const overdue = getInvestorState(f.db, actor, "2026-01-02T12:15:00.000Z");
    assert.equal(overdue.model_watch?.status, "overdue"); assert.equal(overdue.model_watch?.model_nav_cny, null);
    assert.deepEqual(parseInvestorState({ ...overdue, session_binding: binding }, binding), overdue);
    executeInvestorCommand(f.db, actor, { action: "save_profile", profile: { ...syntheticProfile, horizon_years: 13 }, expected_revision: state.revision, idempotency_key: "changed-profile" }, checkedAt);
    state = getInvestorState(f.db, actor, checkedAt);
    assert.equal(state.model_watch?.status, "outdated"); assert.equal(state.model_watch?.model_nav_cny, null);
    assert.throws(() => executeInvestorCommand(f.db, actor, { action: "set_monitoring", model_id: state.model_watch!.id, enabled: true, expected_revision: state.revision, idempotency_key: "old" }, checkedAt), /PROFILE_CHANGED/);
    noFinance(f);
  } finally { f.close(); }
});

test("resealed forged monitor arithmetic is rejected before display and model commands cannot cross owners", () => {
  const f = investorFixture();
  try {
    setup(f); helper(f, "register"); helper(f, "compute");
    const state = getInvestorState(f.db, actor, checkedAt);
    saveSyntheticProfile(f, { id: "other" });
    assert.throws(() => executeInvestorCommand(f.db, { id: "other" }, { action: "set_monitoring", model_id: state.model_watch!.id, enabled: false, expected_revision: 1, idempotency_key: "cross-model" }, checkedAt), /OUT_OF_SCOPE/);
    f.db.exec("DROP TRIGGER investor_monitor_run_no_update");
    const row = f.db.prepare("SELECT document_json FROM investor_monitor_runs").get() as { document_json: string }, run = JSON.parse(row.document_json);
    const original = structuredClone(run);
    run.result.assessment.model_nav_cny = "12000";
    const { result_hash: _, ...assessment } = run.result.assessment; run.result.assessment.result_hash = hash(assessment);
    f.db.prepare("UPDATE investor_monitor_runs SET document_json=?,content_hash=?").run(canonical(run), hash(run));
    assert.throws(() => getInvestorState(f.db, actor, checkedAt), /RESULT_INVALID/);
    original.result.monitor_request.document.quotes[0].close = "110";
    original.result.assessment = JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", "worker.investor"], {
      cwd: path.resolve(process.cwd(), ".."), input: JSON.stringify(original.result.monitor_request), encoding: "utf8", timeout: 30000, maxBuffer: 1048576,
    }));
    verifyInvestorKernelResult(original.result.monitor_request, original.result.assessment);
    f.db.prepare("UPDATE investor_monitor_runs SET document_json=?,content_hash=?").run(canonical(original), hash(original));
    assert.throws(() => getInvestorState(f.db, actor, checkedAt), /EVIDENCE_INVALID/);
  } finally { f.close(); }
});
