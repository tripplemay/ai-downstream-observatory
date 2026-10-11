import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { canonical, hash } from "../src/server/ledger/service";
import { executeInvestorCommand, getInvestorState, isInvestorClientError } from "../src/server/investor/service";
import { readInvestorResearchSource } from "../src/server/investor/source-inputs";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { canResumeInvestorWatch, currentPlanDisplay, currentResearchDisplay, investorPollInterval } from "../src/components/workbench/research-format";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";

const current = "2026-01-02T12:00:04.000Z", binding = "a".repeat(64);
test("fixed-policy unsupported is a bounded client conflict, not a retryable server failure or arbitrary exception leak", () => {
  assert.equal(isInvestorClientError("INVESTOR_MONITOR_FIXED_POLICY_UNSUPPORTED"), true);
  assert.equal(isInvestorClientError("INVESTOR_MONITOR_FIXED_POLICY_UNSUPPORTED:PRIVATE-DIAGNOSTIC"), false);
  assert.equal(isInvestorClientError("INVESTOR_EVIDENCE_INVALID"), false);
});
function helper(f: ReturnType<typeof investorFixture>, module: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args],
    { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] }));
}
function admitted(f: ReturnType<typeof investorFixture>) {
  saveSyntheticProfile(f);
  assert.deepEqual(helper(f, "tests.investor.evidence_fixture"), { status: "fictional_stub_evidence_fixture_complete", real_provider_called: false });
}
function calculate(f: ReturnType<typeof investorFixture>) { helper(f, "tests.investor.queue_fixture", ["--mode", "core"]); }
function request(f: ReturnType<typeof investorFixture>) {
  return f.db.prepare("SELECT id,input_id,evidence_input_id,input_version FROM investor_research_requests WHERE evidence_input_id IS NOT NULL ORDER BY rowid DESC LIMIT 1").get() as {
    id: string; input_id: string | null; evidence_input_id: string; input_version: string };
}
function noFinance(f: ReturnType<typeof investorFixture>) {
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
}

test("fictional stub transport traverses admission, default worker and independent Node replay without becoming live evidence", () => {
  const f = investorFixture();
  try {
    admitted(f); calculate(f);
    const before = f.db.prepare("SELECT total_changes() n").get();
    const state = getInvestorState(f.db, actor, current);
    assert.equal(investorPollInterval(null), null);
    assert.equal(investorPollInterval(state), 60000);
    const waiting = structuredClone(state); waiting.research_task!.status = "blocked"; waiting.research_task!.study = null;
    assert.equal(investorPollInterval(waiting), 15000);
    waiting.research_task!.status = "queued"; assert.equal(investorPollInterval(waiting), 5000);
    waiting.research_task!.status = "outdated"; assert.equal(investorPollInterval(waiting), 60000);
    assert.equal(state.research_task?.status, "calculated");
    assert.equal(state.research_task?.study?.qualification, "owner_reviewed_reconstructed");
    assert.equal(state.research_task?.study?.status, "risk_options_ready");
    assert.equal(state.research_task?.study?.source_context?.range_start, "2025-01-01");
    assert.equal(state.research_task?.study?.source_context?.listings.length, 2);
    assert.equal(state.research_task?.registry?.phases.train.completed, 3);
    assert.equal(state.research_task?.registry?.phases.validation.registered, 0);
    assert.equal(state.profile?.document.loss_tolerance, null); assert.equal(state.plan, null);
    assert.equal(state.latest?.document.monitoring, "not_enabled");
    assert.equal(state.live_advice_eligible, false);
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    const expired = structuredClone(state); expired.research_task!.study!.source_context!.valid_until = current;
    assert.throws(() => parseInvestorState({ ...expired, session_binding: binding }, binding), /RESPONSE_INVALID/);
    const unknownListing = structuredClone(state); unknownListing.research_task!.study!.candidates[0].weights = { "foreign-listing": "1" };
    assert.throws(() => parseInvestorState({ ...unknownListing, session_binding: binding }, binding), /RESPONSE_INVALID/);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    const source = readInvestorResearchSource(f.db, state.workspace_id!, request(f), "2026-01-03T00:00:00.000Z")!;
    assert.equal(hash(source.payload?.dataset), (source.document as Record<string, unknown>).dataset_hash);
    const task = state.research_task!, deadline = task.study!.source_context!.valid_until;
    assert.equal(currentResearchDisplay(task, Date.parse(deadline) - 1), task);
    const hidden = currentResearchDisplay(task, Date.parse(deadline));
    assert.equal(hidden.status, "outdated"); assert.equal(hidden.study, null); assert.equal(hidden.registry, null);
    assert.equal(task.study!.qualification, "owner_reviewed_reconstructed");
    assert.throws(() => readInvestorResearchSource(f.db, "foreign-workspace", request(f), current), /EVIDENCE_INVALID/);
    const doc = JSON.parse((f.db.prepare("SELECT document_json FROM investor_evidence_inputs").get() as { document_json: string }).document_json);
    assert.equal(doc.dataset, undefined); assert.equal(doc.observations, undefined);
    noFinance(f);
  } finally { f.close(); }
});

test("frozen low-frequency reference renders rule parity but cannot activate the legacy monitor", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
    helper(f, "tests.investor.evidence_fixture", ["--fixed-policy-v2"]);
    helper(f, "tests.investor.queue_fixture", ["--mode", "core", "--legacy-fixed-reference"]);
    const state = getInvestorState(f.db, actor, current);
    assert.equal(state.research_task?.study?.status, "reference_ready");
    assert.ok(state.research_task?.study?.candidates.every(row => row.decision_rule?.includes("每半年复核")));
    assert.match(state.plan!.document.strategy_version, /\+fixed-policy-v2$/);
    assert.ok(state.plan!.document.strategy_evidence.includes("当前持续监测尚不支持此规则"));
    assert.ok(state.effective_gaps.some(row => row.code === "INVESTOR_MONITOR_FIXED_POLICY_UNSUPPORTED"));
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan!.id, expected_revision: state.revision, idempotency_key: "save-low-frequency" }, current);
    const saved = getInvestorState(f.db, actor, current);
    assert.equal(saved.model_watch?.enabled, false); assert.equal(saved.model_watch?.model_nav_cny, null);
    assert.equal(canResumeInvestorWatch(saved), false);
    const before = f.db.prepare("SELECT total_changes() n").get();
    assert.throws(() => executeInvestorCommand(f.db, actor, { action: "set_monitoring", model_id: saved.model_watch!.id,
      enabled: true, expected_revision: saved.revision, idempotency_key: "unsupported-monitor" }, current), /FIXED_POLICY_UNSUPPORTED/);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    noFinance(f);
  } finally { f.close(); }
});

test("confirmed fictional risk keeps independently replayed reconstructed freeze and three phase audit exploratory", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
    helper(f, "tests.investor.evidence_fixture"); calculate(f);
    const state = getInvestorState(f.db, actor, current);
    assert.equal(state.research_task?.study?.status, "reference_ready");
    assert.equal(state.research_task?.study?.qualification, "owner_reviewed_reconstructed");
    assert.equal(state.research_task?.registry?.phases.validation.completed, 1);
    assert.equal(state.research_task?.registry?.phases.holdout.completed, 1);
    assert.ok(state.research_task?.registry?.freeze_hash);
    assert.equal(state.research_task?.registry?.holdout_status, "not_independently_verified");
    assert.ok(state.plan); assert.equal(state.plan.document.data_mode, "reconstructed");
    assert.equal(state.plan.document.reference_evidence?.result_hash, state.research_task?.study?.result_hash);
    assert.equal(state.plan.saved_for_observation, false); assert.equal(state.model_watch, null);
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    assert.equal(currentPlanDisplay(state.plan, Date.parse(state.plan.document.valid_until)), null);
    executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan.id, expected_revision: state.revision, idempotency_key: "save-reconstructed-reference" }, current);
    const saved = getInvestorState(f.db, actor, current);
    assert.equal(saved.plan?.saved_for_observation, true); assert.equal(saved.model_watch?.status, "awaiting_inputs");
    assert.equal(saved.model_watch?.model_nav_cny, null); assert.equal(saved.effective_outcome, "insufficient_evidence");
    assert.equal(canResumeInvestorWatch(saved), true);
    assert.equal(canResumeInvestorWatch(saved, Date.parse(saved.plan!.document.valid_until)), false);
    helper(f, "tests.investor.model_fixture", ["--mode", "core", "--now", current]);
    const monitored = getInvestorState(f.db, actor, current);
    assert.equal(monitored.model_watch?.status, "blocked"); assert.equal(monitored.latest?.document.gaps[0].code, "MONITOR_DATASET_NOT_READY");
    assert.throws(() => helper(f, "tests.investor.model_fixture", ["--mode", "register", "--now", current]), /SYNTHETIC_REQUIRED/);
    assert.deepEqual(parseInvestorState({ ...monitored, session_binding: binding }, binding), monitored);
    const expired = getInvestorState(f.db, actor, saved.plan!.document.valid_until);
    assert.equal(expired.plan, null); assert.equal(expired.model_watch?.status, "expired");
    assert.equal(expired.model_watch?.model_nav_cny, null);
    assert.equal(canResumeInvestorWatch(expired), false);
    assert.deepEqual(parseInvestorState({ ...expired, session_binding: binding }, binding), expired);
    for (const sql of ["UPDATE investor_reference_evidence SET result_hash='x'", "DELETE FROM investor_reference_evidence"]) assert.throws(() => f.db.exec(sql), /immutable/);
    noFinance(f);
  } finally { f.close(); }
});

test("new user preferences automatically bind admitted evidence and expired sources remain editable normal gaps", () => {
  const f = investorFixture();
  try {
    admitted(f); calculate(f);
    let state = getInvestorState(f.db, actor, current);
    executeInvestorCommand(f.db, actor, { action: "save_profile", expected_revision: state.revision, idempotency_key: "new-evidence-profile",
      profile: { ...syntheticProfile, horizon_years: 13 } }, current);
    const second = request(f); assert.equal(second.input_id, null);
    assert.ok(second.evidence_input_id); assert.equal(getInvestorState(f.db, actor, current).research_task?.status, "queued");
    const expiry = (f.db.prepare("SELECT valid_until FROM investor_evidence_inputs").get() as { valid_until: string }).valid_until;
    state = getInvestorState(f.db, actor, expiry);
    assert.equal(state.research_task?.status, "outdated"); assert.equal(state.research_task?.study, null);
    assert.ok(state.effective_gaps.some(value => value.code === "REFERENCE_SOURCE_EXPIRED"));
    executeInvestorCommand(f.db, actor, { action: "save_profile", expected_revision: state.revision, idempotency_key: "expired-but-editable",
      profile: { ...syntheticProfile, horizon_years: 14 } }, expiry);
    state = getInvestorState(f.db, actor, expiry);
    assert.equal(state.profile?.version, 3); assert.equal(state.research_task?.status, "outdated");
    noFinance(f);
  } finally { f.close(); }
});

test("tampered retained quote bytes or an admission hash never reaches a displayed study", () => {
  for (const target of ["payload", "admission"]) {
    const f = investorFixture();
    try {
      admitted(f); calculate(f);
      if (target === "payload") {
        f.db.exec("DROP TRIGGER investor_price_payload_no_update");
        f.db.prepare("UPDATE investor_price_payloads SET projection=?").run(Buffer.from("{}"));
      } else {
        f.db.exec("DROP TRIGGER investor_evidence_input_no_update");
        f.db.prepare("UPDATE investor_evidence_inputs SET content_hash=?").run("b".repeat(64));
      }
      assert.throws(() => getInvestorState(f.db, actor, current), /EVIDENCE_INVALID/);
    } finally { f.close(); }
  }
});

test("current review withdrawal hides calculated weights without losing immutable local trial history", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" }); helper(f, "tests.investor.evidence_fixture"); calculate(f);
    const ready = getInvestorState(f.db, actor, current);
    executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: ready.plan!.id, expected_revision: ready.revision, idempotency_key: "saved-before-withdrawal" }, current);
    const state = getInvestorState(f.db, actor, current), before = f.db.prepare("SELECT count(*) n FROM investor_trial_intents").get();
    const row = f.db.prepare("SELECT r.* FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id WHERE s.kind='rights'").get() as Record<string, unknown>;
    const id = "fictional-withdrawal", audit = "fictional-withdrawal-audit", doc = JSON.parse(row.document_json as string);
    Object.assign(doc, { decision: "withdrawn", version: 2, facts: null, reason: "Fictional test withdrawal" });
    f.db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,?,'investor_review_data_source','investor_data_review',?,?,?)")
      .run(audit, actor.id, id, canonical({ content_hash: hash(doc) }), current);
    f.db.prepare("INSERT INTO investor_data_reviews(id,workspace_id,source_id,version,decision,document_json,content_hash,actor_id,created_at,valid_until,audit_id) VALUES(?,?,?,2,'withdrawn',?,?,?,?,?,?)")
      .run(id, state.workspace_id, row.source_id, canonical(doc), hash(doc), actor.id, current, row.valid_until, audit);
    const withdrawn = getInvestorState(f.db, actor, current);
    assert.equal(withdrawn.research_task?.status, "outdated"); assert.equal(withdrawn.research_task?.study, null);
    assert.equal(withdrawn.research_task?.registry, null);
    assert.equal(withdrawn.plan, null); assert.equal(withdrawn.model_watch?.status, "outdated");
    assert.throws(() => executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan!.id,
      expected_revision: withdrawn.revision, idempotency_key: "cannot-resave-withdrawn" }, current), /PLAN_SOURCE_UNAVAILABLE/);
    executeInvestorCommand(f.db, actor, { action: "set_monitoring", model_id: withdrawn.model_watch!.id, enabled: false,
      expected_revision: withdrawn.revision, idempotency_key: "pause-withdrawn-model" }, current);
    const paused = getInvestorState(f.db, actor, current);
    assert.equal(paused.model_watch?.status, "paused");
    assert.equal(canResumeInvestorWatch(paused), false);
    assert.throws(() => executeInvestorCommand(f.db, actor, { action: "set_monitoring", model_id: paused.model_watch!.id, enabled: true,
      expected_revision: paused.revision, idempotency_key: "no-resume-invalid-source" }, current), /PLAN_SOURCE_UNAVAILABLE/);
    assert.ok(withdrawn.effective_gaps.some(value => value.code === "REFERENCE_SOURCE_NO_LONGER_CURRENT"));
    assert.deepEqual(f.db.prepare("SELECT count(*) n FROM investor_trial_intents").get(), before);
    assert.deepEqual(parseInvestorState({ ...withdrawn, session_binding: binding }, binding), withdrawn);
  } finally { f.close(); }
});

test("resealed reference weights, explanations or missing provenance cannot be selected", () => {
  for (const mutation of ["weights", "explanation", "mode", "missing_link"]) {
    const f = investorFixture();
    try {
      saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" }); helper(f, "tests.investor.evidence_fixture"); calculate(f);
      const state = getInvestorState(f.db, actor, current), plan = state.plan!;
      if (mutation === "missing_link") {
        f.db.exec("DROP TRIGGER investor_reference_evidence_no_delete"); f.db.prepare("DELETE FROM investor_reference_evidence WHERE plan_id=?").run(plan.id);
        assert.throws(() => executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: plan.id,
          expected_revision: state.revision, idempotency_key: "unproven-plan" }, current), /EVIDENCE_INVALID/);
      } else {
        const document = structuredClone(plan.document);
        if (mutation === "weights") { document.targets[0].weight = "0.4"; document.targets[1].weight = "0.6"; }
        else if (mutation === "mode") { document.data_mode = "synthetic"; delete document.reference_evidence; }
        else document.strategy_evidence = "Fabricated future profitability assurance";
        f.db.exec("DROP TRIGGER investor_plan_no_update");
        f.db.prepare("UPDATE investor_reference_plans SET document_json=?,content_hash=? WHERE id=?").run(canonical(document), hash(document), plan.id);
        assert.throws(() => getInvestorState(f.db, actor, current), /EVIDENCE_INVALID/);
      }
      assert.equal((f.db.prepare("SELECT count(*) n FROM investor_plan_selections").get() as { n: number }).n, 0);
      noFinance(f);
    } finally { f.close(); }
  }
});
