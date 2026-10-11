import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { canonical, hash } from "../src/server/ledger/service";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { prepareInvestorAiExplanation } from "../src/server/investor/ai-explanation-context";
import { readInvestorAiExplanation, enqueueInvestorAiExplanation, explainInvestorObservation } from "../src/server/investor/ai-explanation";
import { aiMonitorContextSchema, type AiMonitorContext } from "../src/server/investor/ai-explanation-schemas";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { parseInvestorAiExplanation } from "../src/components/workbench/investor-ai-client";

type Obj = Record<string, unknown>;
type Fixture = ReturnType<typeof investorFixture>;
const initial = "2026-01-03T12:00:04.000Z", due = "2026-01-03T16:00:00.000Z", beforeDue = "2026-01-03T15:59:59.999Z";
const funding = { schema_version: "investor-funding-plan-v1" as const, start_date: "2026-01-02", horizon_years: 1,
  evaluation_timezone: "Asia/Shanghai" as const, initial_capital_cny: "100.01", annual_contribution_cny: "10.01",
  first_annual_date: "2026-01-04", entry_method: "three_tranches_60_days" as const,
  actual_arrivals_confirmed: false as const, execution_authorized: false as const, live_advice_eligible: false as const };
function helper(f: Fixture, module: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args],
    { cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 1048576, stdio: ["ignore", "pipe", "pipe"] })) as Obj;
}
function saveFunding(f: Fixture, at: string, key: string) {
  const state = getInvestorState(f.db, actor, at);
  return executeInvestorCommand(f.db, actor, { action: "save_funding_plan", funding_plan: funding,
    expected_revision: state.revision, idempotency_key: key }, at);
}
function seed(f: Fixture, fixed = true, researchAi = true, monitorAi = true) {
  saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30", illustrative_budget_cny: "98765.43" });
  helper(f, "tests.investor.evidence_fixture", [...(fixed ? ["--fixed-policy-v2"] : []), ...(researchAi ? ["--external-ai"] : [])]);
  helper(f, "tests.investor.queue_fixture", ["--mode", "core"]);
  const state = getInvestorState(f.db, actor, "2026-01-02T12:00:04.000Z");
  executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan!.id, expected_revision: state.revision,
    idempotency_key: "fund-ai-model" }, "2026-01-02T12:00:04.000Z");
  saveFunding(f, "2026-01-02T12:00:05.000Z", "fund-ai-first");
  helper(f, "tests.investor.monitor_data_fixture", ["--admit", "--monitor", "--extra-closed-day", ...(monitorAi ? ["--external-ai"] : [])]);
}
function calculate(f: Fixture, at: string) { helper(f, "tests.investor.queue_fixture", ["--mode", "core", "--now", at]); }
function protectedDigest(f: Fixture) {
  const tables = ["investor_workspaces", "investor_profiles", "investor_observations", "investor_reference_plans", "investor_plan_selections",
    "investor_models", "investor_model_controls", "investor_funding_plans", "investor_monitor_evidence_inputs",
    "investor_evidence_monitor_requests", "investor_evidence_monitor_runs", "investor_evidence_model_checkpoints",
    "investor_evidence_checkpoint_payloads", "investor_evidence_run_payloads", "outbox"];
  return hash(Object.fromEntries(tables.map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}
function noFinance(f: Fixture) {
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
}
function count(f: Fixture, table: string) { return (f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n; }
function settings(f: Fixture, clock: () => string) {
  const config = { schema_version: "readonly-ai-gateway-config-v2", base_url: "https://gateway.invalid/v1", api_key: "FICTIONAL_PRIVATE_KEY",
    model: "deepseek-flash", max_output_tokens: 1024, request_profile: "deepseek_non_thinking" };
  const config_file = path.join(f.directory, "ai.json"), consent_file = path.join(f.directory, "consent.json");
  writeFileSync(config_file, canonical(config), { mode: 0o600 });
  writeFileSync(consent_file, canonical({ schema_version: "investor-ai-sharing-consent-v1", principal_id: actor.id,
    gateway_audience_hash: hash({ base_url: config.base_url, model: config.model, request_profile: config.request_profile }), decision: "allow",
    allowed_categories: ["model_ratios", "target_deviation", "strategy_trigger_codes"], source: "explicit_user_confirmation",
    valid_from: "2026-01-03T12:00:00.000Z", valid_until: "2026-01-04T12:00:00.000Z" }), { mode: 0o600 });
  return { config_file, consent_file, clock };
}
function child(f: Fixture, options: ReturnType<typeof settings>, mode: "read" | "background" | "maintenance", at: string,
  request: { observation_id: string; binding_hash: string }) {
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "tests/investor-ai-process-fixture.ts", mode, f.filename,
    options.config_file, options.consent_file, at, request.observation_id, request.binding_hash],
  { cwd: process.cwd(), encoding: "utf8", timeout: 60000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] })) as Obj;
}
function request(f: Fixture, options: ReturnType<typeof settings>) {
  const status = readInvestorAiExplanation(f.db, actor, options);
  assert.equal(status.status, "available", status.reason_code ?? undefined);
  return { observation_id: status.observation_id!, binding_hash: status.binding_hash! };
}
function result(context: AiMonitorContext) {
  const review = { schema_version: "ai-research-review-v1" as const, facts: context.evidence, inferences: [], supporting_evidence: [], counter_evidence: [],
    risks: ["Fictional source only"], recommendation: "maintain_research" as const, reason: "Fictional opinion cannot replace the deterministic decision",
    unknowns: [], invalidation_conditions: ["Saved plan or release context changes"] };
  return { review, review_hash: hash(review), context_hash: hash(context), reported_model_hash: hash("fictional-model"), usage: null };
}
function assertClosedContext(f: Fixture, context: AiMonitorContext) {
  assert.deepEqual(aiMonitorContextSchema.parse(context), context);
  const encoded = canonical(context), saved = f.db.prepare("SELECT * FROM investor_funding_plans ORDER BY version DESC LIMIT 1").get() as Obj;
  for (const value of ["100.01", "10.01", "98765.43", "FICTIONAL_PRIVATE_KEY", String(saved.id), String(saved.content_hash),
    funding.start_date, funding.first_annual_date, "CN:ALPHA", "CN:BETA", "funding_binding", "funding_context_hash", "initial_capital_cny",
    "annual_contribution_cny", "model_nav_cny", "quantities", "cash_by_currency", "profile_hash", "loss_tolerance"])
    assert.ok(!encoded.includes(value), value);
  const independent = execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c",
    "import json,sys; from worker.ai_explanation.context import validate_monitor_context; from worker.orchestration.db import content_hash; print(content_hash(validate_monitor_context(json.load(sys.stdin))))"],
  { cwd: path.resolve(".."), input: encoded, encoding: "utf8", timeout: 10000 }).trim();
  assert.equal(independent, hash(context));
}

test("saved annual plans reach v4 monitor and closed Python/Node AI context for both reference definitions, never private plan fields", t => {
  for (const fixed of [false, true]) {
    const f = investorFixture();
    try {
      seed(f, fixed);
      const future = prepareInvestorAiExplanation(f.db, actor, initial), futureState = getInvestorState(f.db, actor, initial);
      assert.equal(future.context.deterministic_outcome, futureState.effective_outcome);
      assert.equal(futureState.latest!.document.model_change!.funding_status, "not_due");
      assert.ok(!future.context.trigger_codes.includes("NEW_PLANNED_FUNDING"));
      calculate(f, due); const before = protectedDigest(f), prepared = prepareInvestorAiExplanation(f.db, actor, due);
      assert.equal(prepared.context.deterministic_outcome, "decision_required"); assertClosedContext(f, prepared.context);
      assert.ok(prepared.context.trigger_codes.includes("NEW_PLANNED_FUNDING"));
      const row = f.db.prepare("SELECT document_json FROM investor_evidence_monitor_requests ORDER BY rowid DESC LIMIT 1").get() as Obj;
      assert.equal(JSON.parse(String(row.document_json)).engine_version, "investor-evidence-model-watcher-v4");
      const session = "b".repeat(64), state = getInvestorState(f.db, actor, due);
      assert.deepEqual(parseInvestorState({ ...state, session_binding: session }, session), state);
      assert.equal(state.latest!.document.model_change!.model_nav_cny, "10000");
      assert.equal(state.latest!.document.model_change!.funding_status, "hypothetical_due");
      t.diagnostic(canonical({ definition: fixed ? "v2" : "v1", future_outcome: future.context.deterministic_outcome,
        future_trigger_codes: future.context.trigger_codes, due_trigger_codes: prepared.context.trigger_codes,
        due_outcome: prepared.context.deterministic_outcome, private_fields_excluded: true, node_python_context_hash_match: true }));
      assert.equal(protectedDigest(f), before); noFinance(f);
    } finally { f.close(); }
  }
});

test("an explicit funding explanation completes in a cold background process once, while an opposing AI opinion cannot change the decision", async () => {
  const f = investorFixture();
  try {
    seed(f); calculate(f, due); const options = settings(f, () => due), current = request(f, options), before = protectedDigest(f);
    assert.equal((await enqueueInvestorAiExplanation(f.db, actor, current, options)).status, "queued");
    assert.equal(count(f, "investor_ai_dispatches"), 0);
    assert.deepEqual(child(f, options, "background", due, current), { purged: 0, processed: true, calls: 1 });
    const completed = readInvestorAiExplanation(f.db, actor, options);
    assert.equal(completed.status, "complete"); assert.equal(completed.review!.recommendation, "maintain_research");
    const session = "b".repeat(64);
    assert.deepEqual(parseInvestorAiExplanation({ ...completed, session_binding: session }, session, current.observation_id, Date.parse(due)), completed);
    assert.equal(child(f, options, "read", due, current).review_hash, hash(completed.review));
    assert.deepEqual(child(f, options, "background", due, current), { purged: 0, processed: false, calls: 0 });
    for (const table of ["investor_ai_requests", "investor_ai_dispatches", "investor_ai_outcomes", "investor_ai_payloads"]) assert.equal(count(f, table), 1);
    assert.equal(protectedDigest(f), before); assert.equal(getInvestorState(f.db, actor, due).effective_outcome, "decision_required"); noFinance(f);
  } finally { f.close(); }
});

test("crossing the exact annual release boundary purges an old queued intent before dispatch and requires a fresh explicit request", async () => {
  const f = investorFixture();
  try {
    seed(f); calculate(f, beforeDue); let at = beforeDue;
    const options = settings(f, () => at), old = request(f, options);
    assert.equal(readInvestorAiExplanation(f.db, actor, options).valid_until, due);
    await enqueueInvestorAiExplanation(f.db, actor, old, options); at = due;
    assert.deepEqual(child(f, options, "background", at, old), { purged: 1, processed: false, calls: 0 });
    assert.equal(count(f, "investor_ai_dispatches"), 0); assert.equal(count(f, "investor_ai_payloads"), 0);
    assert.equal(readInvestorAiExplanation(f.db, actor, options).status, "blocked");
    calculate(f, at); const current = request(f, options); assert.notEqual(current.binding_hash, old.binding_hash);
    await assert.rejects(enqueueInvestorAiExplanation(f.db, actor, old, options), /BINDING_CHANGED/);
    assert.deepEqual(child(f, options, "background", at, current), { purged: 0, processed: false, calls: 0 });
    await enqueueInvestorAiExplanation(f.db, actor, current, options);
    assert.deepEqual(child(f, options, "background", at, current), { purged: 0, processed: true, calls: 1 });
    assert.equal(count(f, "investor_ai_requests"), 2); assert.equal(count(f, "investor_ai_dispatches"), 1);
    assert.equal(count(f, "investor_ai_purges"), 1); noFinance(f);
  } finally { f.close(); }
});

test("saving a new plan purges queued or completed funding explanations in a cold worker without a browser read or automatic replacement", async () => {
  for (const state of ["queued", "complete"] as const) {
    const f = investorFixture();
    try {
      seed(f); calculate(f, due); let at = due;
      const options = settings(f, () => at), old = request(f, options);
      await enqueueInvestorAiExplanation(f.db, actor, old, options);
      if (state === "complete") assert.deepEqual(child(f, options, "background", at, old), { purged: 0, processed: true, calls: 1 });
      const dispatches = count(f, "investor_ai_dispatches"), outcomes = count(f, "investor_ai_outcomes");
      at = "2026-01-03T16:01:00.000Z"; saveFunding(f, at, "fund-ai-new-plan"); const before = protectedDigest(f);
      assert.deepEqual(child(f, options, "background", at, old), { purged: 1, processed: false, calls: 0 });
      assert.equal(protectedDigest(f), before); assert.equal(count(f, "investor_ai_payloads"), 0);
      assert.equal(count(f, "investor_ai_dispatches"), dispatches); assert.equal(count(f, "investor_ai_outcomes"), outcomes);
      assert.equal(count(f, "investor_ai_requests"), 1); assert.equal(count(f, "investor_ai_purges"), 1);
      calculate(f, at); const current = request(f, options);
      assert.notEqual(current.binding_hash, old.binding_hash);
      assert.deepEqual(child(f, options, "background", at, current), { purged: 0, processed: false, calls: 0 });
      await assert.rejects(enqueueInvestorAiExplanation(f.db, actor, old, options), /BINDING_CHANGED/); noFinance(f);
    } finally { f.close(); }
  }
});

test("a plan change while funding explanation is in flight discards the old output without a UI read or deterministic state mutation", async () => {
  const f = investorFixture();
  try {
    seed(f); calculate(f, due); let at = due;
    const options = settings(f, () => at), current = request(f, options);
    let release!: () => void, entered!: () => void, calls = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const running = explainInvestorObservation(f.db, actor, current, { ...options, transport: async context => {
      calls++; entered(); assertClosedContext(f, context); await waiting; return result(context);
    } });
    let after = "";
    try {
      await started; at = "2026-01-03T16:01:00.000Z"; saveFunding(f, at, "fund-ai-in-flight-plan"); after = protectedDigest(f);
    } finally { release(); }
    const finished = await running;
    assert.equal(finished.status, "blocked"); assert.equal(finished.review, null); assert.equal(calls, 1);
    assert.equal(protectedDigest(f), after); assert.equal(count(f, "investor_ai_payloads"), 0);
    assert.equal(count(f, "investor_ai_outcomes"), 1);
    assert.deepEqual(child(f, options, "maintenance", at, current), { purged: 1, processed: false, calls: 0 }); noFinance(f);
  } finally { f.close(); }
});

test("a saved funding trigger never bypasses either original research or monitoring external-AI rights", () => {
  for (const [researchAi, monitorAi] of [[false, true], [true, false]]) {
    const f = investorFixture();
    try {
      seed(f, true, researchAi, monitorAi); calculate(f, due); const before = protectedDigest(f), options = settings(f, () => due);
      assert.equal(getInvestorState(f.db, actor, due).effective_outcome, "decision_required");
      assert.throws(() => prepareInvestorAiExplanation(f.db, actor, due), /SOURCE_SHARING_NOT_APPROVED/);
      const status = readInvestorAiExplanation(f.db, actor, options);
      assert.equal(status.status, "blocked"); assert.equal(status.reason_code, "INVESTOR_AI_SOURCE_SHARING_NOT_APPROVED");
      assert.equal(count(f, "investor_ai_requests"), 0); assert.equal(count(f, "investor_ai_dispatches"), 0);
      assert.equal(protectedDigest(f), before); noFinance(f);
    } finally { f.close(); }
  }
});
