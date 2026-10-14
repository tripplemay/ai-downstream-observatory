import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { formatResearchPercent } from "../src/components/workbench/research-format";
import { canonical, hash } from "../src/server/ledger/service";
import { investorActor as actor, investorFixture, investorNow as now, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";

const currentTime = "2026-01-02T12:00:04.000Z", binding = "a".repeat(64);
const financialTables = ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"];
function helper(f: ReturnType<typeof investorFixture>, mode: "register" | "compute" | "core", extra: string[] = []) {
  const output = execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", "tests.investor.queue_fixture", "--db", f.filename, "--mode", mode, ...extra],
    { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 65536 });
  assert.equal(JSON.parse(output).status, "synthetic_fixture_complete");
}
function noFinance(f: ReturnType<typeof investorFixture>) {
  for (const table of financialTables) assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
}

test("saving preferences enqueues independent research; duplicate commands and same-input checks do not create extra jobs", () => {
  const f = investorFixture();
  try {
    const command = { action: "save_profile", profile: syntheticProfile, expected_revision: 0, idempotency_key: "research-once" };
    const receipt = executeInvestorCommand(f.db, actor, command, now);
    assert.deepEqual(executeInvestorCommand(f.db, actor, command, now), receipt);
    executeInvestorCommand(f.db, actor, { action: "evaluate", expected_revision: 1, idempotency_key: "same-input" }, currentTime);
    const state = getInvestorState(f.db, actor, currentTime);
    assert.equal(state.research_task?.status, "queued");
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_research_requests").get() as { n: number }).n, 1);
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    assert.equal(getInvestorState(f.db, { id: "other" }, currentTime).research_task, null);
    noFinance(f);
  } finally { f.close(); }
});

test("real core worker commits typed input gaps atomically and exposes completed progress without pretending to monitor", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); helper(f, "core");
    const state = getInvestorState(f.db, actor, currentTime);
    assert.equal(state.revision, 2);
    assert.equal(state.research_task?.status, "blocked");
    assert.equal(state.research_task?.completed_at, "2026-01-02T12:00:03.000Z");
    assert.equal(state.research_task?.study, null);
    assert.equal(state.latest?.document.monitoring, "not_enabled");
    assert.equal(state.latest?.document.input_version, state.research_task?.input_version);
    assert.equal(state.effective_outcome, "insufficient_evidence");
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    assert.throws(() => executeInvestorCommand(f.db, actor, { action: "evaluate", expected_revision: 1, idempotency_key: "stale-client" }, currentTime), /VERSION_CONFLICT/);
    noFinance(f);
  } finally { f.close(); }
});

test("isolated cross-language calculation publishes train-only loss options without selecting unknown risk", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); helper(f, "register");
    assert.equal(getInvestorState(f.db, actor, currentTime).research_task?.status, "outdated");
    executeInvestorCommand(f.db, actor, { action: "evaluate", expected_revision: 1, idempotency_key: "new-input" }, "2026-01-02T12:00:02.000Z");
    helper(f, "compute");
    const state = getInvestorState(f.db, actor, currentTime);
    assert.equal(state.research_task?.status, "calculated");
    assert.equal(state.research_task?.study?.status, "risk_options_ready");
    assert.equal(state.research_task?.study?.qualification, "synthetic_test_only");
    assert.equal(state.research_task?.study?.candidates.length, 3);
    assert.deepEqual(state.research_task?.study?.phase_checks, []);
    assert.deepEqual(state.research_task?.registry?.phases, { train: { registered: 3, completed: 3 }, validation: { registered: 0, completed: 0 }, holdout: { registered: 0, completed: 0 } });
    assert.equal(state.research_task?.registry?.freeze_hash, null);
    assert.equal(state.research_task?.registry?.holdout_status, "not_independently_verified");
    assert.equal(state.profile?.document.loss_tolerance, null);
    assert.equal(state.plan, null);
    assert.equal(state.effective_outcome, "insufficient_evidence");
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    for (const weight of ["invalid1", "-0.2", "1.2"]) {
      const invalid = structuredClone(state); invalid.research_task!.study!.candidates[0].weights = { "CN:ALPHA": weight };
      assert.throws(() => parseInvestorState({ ...invalid, session_binding: binding }, binding), /RESPONSE_INVALID/);
    }
    const future = structuredClone(state); future.research_task!.completed_at = "2027-01-01T00:00:00.000Z";
    assert.throws(() => parseInvestorState({ ...future, session_binding: binding }, binding), /RESPONSE_INVALID/);
    noFinance(f);
  } finally { f.close(); }
});

test("research records are hash-bound and failed runs cannot masquerade as completed studies", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); helper(f, "core");
    f.db.exec("DROP TRIGGER investor_research_run_no_update");
    f.db.prepare("UPDATE investor_research_runs SET content_hash=?").run("b".repeat(64));
    assert.throws(() => getInvestorState(f.db, actor, currentTime), /EVIDENCE_INVALID/);
  } finally { f.close(); }
});

test("percentage display preserves exact decimal half-even rounding without binary floating point", () => {
  assert.equal(formatResearchPercent("0.12345"), "12.34%");
  assert.equal(formatResearchPercent("0.12355"), "12.36%");
  assert.equal(formatResearchPercent("-0.2850000000000000000000000001"), "-28.50%");
  assert.equal(formatResearchPercent(null), "未能计算");
});

function confirmedStudy(f: ReturnType<typeof investorFixture>) {
  executeInvestorCommand(f.db, actor, { action: "save_profile", profile: { ...syntheticProfile, loss_tolerance: "0.30" }, expected_revision: 0, idempotency_key: "confirmed-fixture-only" }, now);
  helper(f, "register");
  executeInvestorCommand(f.db, actor, { action: "evaluate", expected_revision: 1, idempotency_key: "confirmed-input" }, "2026-01-02T12:00:02.000Z");
  helper(f, "compute");
  return getInvestorState(f.db, actor, currentTime);
}

test("confirmed synthetic research binds persisted train freeze and three phase receipts without investment admission", () => {
  const f = investorFixture();
  try {
    const state = confirmedStudy(f), registry = state.research_task!.registry!;
    assert.equal(registry.phases.train.completed, 3);
    assert.equal(registry.phases.validation.completed, 1);
    assert.equal(registry.phases.holdout.completed, 1);
    assert.deepEqual(state.research_task?.study?.phase_checks, ["train", "validation", "holdout"].map(phase => ({
      phase, execution_failure_count: 0, benchmark_execution_failure_count: 0,
    })));
    assert.match(registry.freeze_hash!, /^[a-f0-9]{64}$/);
    assert.equal(registry.holdout_status, "not_independently_verified");
    assert.equal(state.plan, null);
    assert.equal(state.effective_outcome, "insufficient_evidence");
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    const before = f.db.prepare("SELECT count(*) n FROM investor_trial_intents").get();
    getInvestorState(f.db, actor, currentTime);
    assert.deepEqual(f.db.prepare("SELECT count(*) n FROM investor_trial_intents").get(), before);
    noFinance(f);
  } finally { f.close(); }
});

test("a genuine synthetic next-close budget gap exposes verified phase counts without promoting, retrying or opening holdout", () => {
  const f = investorFixture();
  try {
    executeInvestorCommand(f.db, actor, { action: "save_profile", profile: { ...syntheticProfile, loss_tolerance: "0.30" },
      expected_revision: 0, idempotency_key: "gap-fixture-only" }, now);
    helper(f, "register", ["--validation-execution-gap"]);
    executeInvestorCommand(f.db, actor, { action: "evaluate", expected_revision: 1, idempotency_key: "gap-input" }, "2026-01-02T12:00:02.000Z");
    helper(f, "compute");
    const before = f.db.prepare("SELECT total_changes() n FROM investor_research_runs").get();
    const state = getInvestorState(f.db, actor, currentTime), task = state.research_task!;
    assert.equal(task.status, "calculated"); assert.equal(task.study!.status, "insufficient_evidence");
    assert.ok(task.reason_codes.includes("SELECTED_CANDIDATE_FAILED_VALIDATION"));
    assert.deepEqual(task.study!.phase_checks!.map(row => row.phase), ["train", "validation"]);
    assert.ok(task.study!.phase_checks![1].execution_failure_count > 0);
    assert.deepEqual(task.registry!.phases.holdout, { registered: 0, completed: 0 });
    assert.equal(state.plan, null); assert.equal(state.model_watch, null);
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n FROM investor_research_runs").get(), before);
    for (const alter of [
      (value: typeof state) => { value.research_task!.study!.phase_checks![1].execution_failure_count = -1; },
      (value: typeof state) => { value.research_task!.study!.phase_checks![1].phase = "holdout"; },
      (value: typeof state) => { value.research_task!.study!.phase_checks!.push({ phase: "holdout", execution_failure_count: 0, benchmark_execution_failure_count: 0 }); },
    ]) {
      const forged = structuredClone(state); alter(forged);
      assert.throws(() => parseInvestorState({ ...forged, session_binding: binding }, binding), /RESPONSE_INVALID/);
    }
    noFinance(f);
  } finally { f.close(); }
});

test("a rehashed publication cannot invent trial completion or erase the persisted candidate freeze", () => {
  const f = investorFixture();
  try {
    confirmedStudy(f);
    const row = f.db.prepare("SELECT id,document_json FROM investor_research_runs WHERE status='calculated'").get() as { id: string; document_json: string };
    const run = JSON.parse(row.document_json);
    run.registry.phases.holdout.completed = 0;
    f.db.exec("DROP TRIGGER investor_research_run_no_update");
    f.db.prepare("UPDATE investor_research_runs SET document_json=?,content_hash=? WHERE id=?").run(canonical(run), hash(run), row.id);
    assert.throws(() => getInvestorState(f.db, actor, currentTime), /EVIDENCE_INVALID/);
    run.registry.phases.holdout.completed = 1; run.registry.freeze_hash = "c".repeat(64);
    f.db.prepare("UPDATE investor_research_runs SET document_json=?,content_hash=? WHERE id=?").run(canonical(run), hash(run), row.id);
    assert.throws(() => getInvestorState(f.db, actor, currentTime), /EVIDENCE_INVALID/);
    noFinance(f);
  } finally { f.close(); }
});

test("published train summaries must match retained immutable trial receipts, not just a valid output hash", () => {
  const f = investorFixture();
  try {
    confirmedStudy(f);
    const row = f.db.prepare("SELECT id,document_json FROM investor_research_runs WHERE status='calculated'").get() as { id: string; document_json: string };
    const run = JSON.parse(row.document_json), candidate = run.result.candidates[0];
    candidate.train.result_hash = "d".repeat(64);
    const { result_hash: _, ...body } = run.result; run.result.result_hash = hash(body);
    f.db.exec("DROP TRIGGER investor_research_run_no_update");
    f.db.prepare("UPDATE investor_research_runs SET document_json=?,content_hash=? WHERE id=?").run(canonical(run), hash(run), row.id);
    assert.throws(() => getInvestorState(f.db, actor, currentTime), /EVIDENCE_INVALID/);
  } finally { f.close(); }
});
