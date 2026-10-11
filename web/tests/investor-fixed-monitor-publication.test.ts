import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { canonical, hash } from "../src/server/ledger/service";
import { getInvestorState, executeInvestorCommand } from "../src/server/investor/service";
import { readEvidenceCheckpoint, readEvidenceMonitorRun } from "../src/server/investor/evidence-monitor";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { replayEvidenceModel } from "../src/server/investor/evidence-model-state";
import { modelDefinitionHash } from "../src/server/investor/fixed-policy";

type Obj = Record<string, unknown>;
const now = "2026-01-03T12:00:04.000Z", binding = "a".repeat(64);
function helper(f: ReturnType<typeof investorFixture>, module: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args],
    { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] })) as Obj;
}
function saved(f: ReturnType<typeof investorFixture>) {
  saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
  helper(f, "tests.investor.evidence_fixture", ["--fixed-policy-v2"]);
  helper(f, "tests.investor.queue_fixture", ["--mode", "core"]);
  const state = getInvestorState(f.db, actor, "2026-01-02T12:00:04.000Z");
  assert.equal(state.plan!.document.schema_version, "investor-reference-plan-v2");
  executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan!.id, expected_revision: state.revision,
    idempotency_key: "fixed-monitor-save" }, "2026-01-02T12:00:04.000Z");
  return getInvestorState(f.db, actor, "2026-01-02T12:00:04.000Z");
}
function noFinance(f: ReturnType<typeof investorFixture>) {
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
}
function rows(f: ReturnType<typeof investorFixture>) { return f.db.prepare("SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence").all(); }
function latest(f: ReturnType<typeof investorFixture>) { return (f.db.prepare("SELECT * FROM investor_evidence_monitor_runs ORDER BY rowid DESC LIMIT 1").get() as Obj); }
function definition(f: ReturnType<typeof investorFixture>) { const model = f.db.prepare("SELECT * FROM investor_models").get() as Obj; return { model, document: JSON.parse(String(model.document_json)) as Obj }; }

test("new frozen reference reaches default core and independent Node/strict-client replay without legacy rules", () => {
  const f = investorFixture();
  try {
    const waiting = saved(f); assert.equal(waiting.model_watch!.enabled, true);
    assert.equal(waiting.model_watch!.status, "awaiting_inputs"); assert.equal(waiting.model_watch!.model_nav_cny, null);
    assert.ok(!waiting.effective_gaps.some(gap => gap.code === "INVESTOR_MONITOR_FIXED_POLICY_UNSUPPORTED"));
    const value = helper(f, "tests.investor.monitor_data_fixture", ["--admit", "--monitor", "--later"]);
    assert.equal(value.real_provider_called, false);
    const before = f.db.prepare("SELECT total_changes() n").get(), state = getInvestorState(f.db, actor, "2026-01-03T12:15:04.000Z");
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    assert.equal(state.model_watch!.status, "research_observe"); assert.equal(state.latest!.document.monitoring, "active");
    assert.equal(state.latest!.document.model_change!.policy_evaluation!.class_drift.length, 2);
    assert.equal(rows(f).length, 1); assert.equal((f.db.prepare("SELECT count(*) n FROM investor_monitor_requests").get() as { n: number }).n, 0);
    const { model, document } = definition(f), row = latest(f);
    const checkpoint = readEvidenceCheckpoint(f.db, state.workspace_id!, model, document, row.checkpoint_id, "2026-01-03T12:15:04.000Z").checkpoint!;
    assert.equal(checkpoint.schema_version, "investor-evidence-model-checkpoint-v2");
    assert.ok((checkpoint.policy_state as Obj).last_review_at);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); noFinance(f);
  } finally { f.close(); }
});

test("funding and pause/resume preserve model units and repeated open proposal anchor; human review is not execution", () => {
  const f = investorFixture();
  try {
    saved(f); helper(f, "tests.investor.monitor_data_fixture", ["--admit", "--monitor", "--funding", "--later"]);
    let state = getInvestorState(f.db, actor, "2026-01-03T12:15:04.000Z");
    assert.equal(state.effective_outcome, "decision_required"); assert.equal(state.model_watch!.status, "research_decision");
    assert.equal(state.latest!.document.model_change!.policy_evaluation!.new_funding, false);
    assert.equal(rows(f).length, 1);
    const original = rows(f), { model, document } = definition(f), run = latest(f);
    const checkpoint = readEvidenceCheckpoint(f.db, state.workspace_id!, model, document, run.checkpoint_id, "2026-01-03T12:15:04.000Z").checkpoint!;
    assert.ok((checkpoint.policy_state as Obj).last_funding_hash);
    for (const enabled of [false, true]) {
      executeInvestorCommand(f.db, actor, { action: "set_monitoring", model_id: model.id, enabled, expected_revision: state.revision,
        idempotency_key: `fixed-control-${enabled}` }, "2026-01-03T12:15:04.000Z");
      state = getInvestorState(f.db, actor, "2026-01-03T12:15:04.000Z");
    }
    helper(f, "tests.investor.queue_fixture", ["--mode", "core", "--now", "2026-01-03T12:15:05.000Z"]);
    state = getInvestorState(f.db, actor, "2026-01-03T12:15:06.000Z");
    assert.equal(state.effective_outcome, "decision_required"); assert.deepEqual(rows(f), original);
    assert.ok(state.latest!.document.reasons.some(reason => reason.includes("不重复延后冷却起点")));
    executeInvestorCommand(f.db, actor, { action: "review", observation_id: state.latest!.id, decision: "accept_idea", note: "Fictional review only",
      expected_revision: state.revision, idempotency_key: "fixed-human-review" }, "2026-01-03T12:15:06.000Z");
    assert.deepEqual(rows(f), original); noFinance(f);
  } finally { f.close(); }
});

test("resealed checkpoint policy clock cannot pass full source and ancestor replay", () => {
  const f = investorFixture();
  try {
    const savedState = saved(f); helper(f, "tests.investor.monitor_data_fixture", ["--admit", "--monitor"]);
    const { model, document } = definition(f), header = rows(f)[0] as Obj;
    const data = f.db.prepare("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?").get(header.id) as { payload: Buffer };
    const checkpoint = JSON.parse(data.payload.toString()) as Obj;
    (checkpoint.policy_state as Obj).last_review_at = "2026-01-03T11:59:03.000000Z";
    f.db.exec("DROP TRIGGER investor_evidence_checkpoint_no_update; DROP TRIGGER investor_evidence_checkpoint_payload_update;");
    f.db.prepare("UPDATE investor_evidence_checkpoint_payloads SET payload=? WHERE checkpoint_id=?").run(Buffer.from(canonical(checkpoint)), header.id);
    f.db.prepare("UPDATE investor_evidence_model_checkpoints SET content_hash=? WHERE id=?").run(hash(checkpoint), header.id);
    assert.throws(() => readEvidenceCheckpoint(f.db, savedState.workspace_id!, model, document, header.id, now), /EVIDENCE_INVALID/); noFinance(f);
  } finally { f.close(); }
});

test("changing and resealing frozen model rules or crossing checkpoint versions does not upgrade a plan", () => {
  const f = investorFixture();
  try {
    const state = saved(f), value = helper(f, "tests.investor.monitor_data_fixture", ["--admit", "--monitor"]), { document } = definition(f);
    const header = rows(f)[0] as Obj, data = f.db.prepare("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?").get(header.id) as { payload: Buffer };
    const checkpoint = JSON.parse(data.payload.toString()) as Obj, altered = structuredClone(document);
    ((altered.fixed_policy as Obj).parameters as Obj).minimum_days_between_rebalances = 1;
    altered.target_definition_hash = modelDefinitionHash(altered as Parameters<typeof modelDefinitionHash>[0]);
    assert.throws(() => replayEvidenceModel(altered, value.projection, checkpoint, now, "b".repeat(64), true), /EVIDENCE_INVALID/);
    const mixed: Obj = { ...checkpoint, schema_version: "investor-evidence-model-checkpoint-v1" }; delete mixed.policy_state;
    assert.throws(() => replayEvidenceModel(document, value.projection, mixed, now, "b".repeat(64), true), /EVIDENCE_INVALID/);
    f.db.exec("DROP TRIGGER investor_model_no_update");
    f.db.prepare("UPDATE investor_models SET document_json=?,content_hash=?").run(canonical(altered), hash(altered));
    assert.throws(() => readEvidenceMonitorRun(f.db, state.workspace_id!, String(latest(f).id), now), /EVIDENCE_INVALID/); noFinance(f);
  } finally { f.close(); }
});
