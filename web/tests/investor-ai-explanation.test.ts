import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, chmodSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { canonical, hash } from "../src/server/ledger/service";
import { getInvestorState, executeInvestorCommand } from "../src/server/investor/service";
import { prepareInvestorAiExplanation } from "../src/server/investor/ai-explanation-context";
import { aiLimitations, aiMonitorContextSchema, validateAiMonitorReview, type AiMonitorContext } from "../src/server/investor/ai-explanation-schemas";
import { readAiExplanationSettings, aiExplanationImplementationHash } from "../src/server/investor/ai-explanation-process";
import { readInvestorAiExplanation, enqueueInvestorAiExplanation, explainInvestorObservation, maintainInvestorAiExplanations } from "../src/server/investor/ai-explanation";
import { runInvestorAiBackgroundPass } from "../src/server/investor/ai-explanation-background";
import { purgeDurableAiScope } from "../src/server/investor/ai-explanation-store";
import { openWorkbench } from "../src/server/workbench-db";
import { parseInvestorAiExplanation } from "../src/components/workbench/investor-ai-client";
import type { AiExplanationMemory } from "../src/server/investor/ai-explanation-memory";
import { runHttpFixture } from "../scripts/http-fixture-process.mjs";

type F = ReturnType<typeof investorFixture>;
type Obj = Record<string, unknown>;
function cachedEntry(key: string) {
  return (globalThis as typeof globalThis & { __etfAiExplanationRuntime: { cache: AiExplanationMemory<{ status: { review: unknown } }> } })
    .__etfAiExplanationRuntime.cache.get(key);
}
const now = "2026-01-03T12:15:04.000Z", binding = "a".repeat(64);
function helper(f: F, module: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args],
    { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] })) as Obj;
}
function seed(f: F, researchAi = true, monitorAi = true, funding = false) {
  saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30", illustrative_budget_cny: "98765.43" });
  helper(f, "tests.investor.evidence_fixture", ["--fixed-policy-v2", ...(researchAi ? ["--external-ai"] : [])]);
  helper(f, "tests.investor.queue_fixture", ["--mode", "core"]);
  const state = getInvestorState(f.db, actor, "2026-01-02T12:00:04.000Z");
  assert.ok(state.plan, JSON.stringify({ status: state.research_task?.status, reasons: state.research_task?.reason_codes }));
  executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan!.id, expected_revision: state.revision,
    idempotency_key: "ai-fictional-save" }, "2026-01-02T12:00:04.000Z");
  helper(f, "tests.investor.monitor_data_fixture", ["--admit", "--monitor", "--later", ...(monitorAi ? ["--external-ai"] : []), ...(funding ? ["--funding"] : [])]);
}
function noFinance(f: F) {
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
}
function settings(f: F) {
  const config = { schema_version: "readonly-ai-gateway-config-v2", base_url: "https://gateway.invalid/v1", api_key: "FICTIONAL_PRIVATE_KEY",
    model: "deepseek-flash", max_output_tokens: 1024, request_profile: "deepseek_non_thinking" };
  const config_file = path.join(f.directory, "ai.json"), consent_file = path.join(f.directory, "consent.json");
  writeFileSync(config_file, canonical(config), { mode: 0o600 });
  const consent = { schema_version: "investor-ai-sharing-consent-v1", principal_id: actor.id,
    gateway_audience_hash: hash({ base_url: config.base_url, model: config.model, request_profile: config.request_profile }), decision: "allow",
    allowed_categories: ["model_ratios", "target_deviation", "strategy_trigger_codes"], source: "explicit_user_confirmation",
    valid_from: "2026-01-03T12:00:00.000Z", valid_until: "2026-01-04T12:00:00.000Z" };
  writeFileSync(consent_file, canonical(consent), { mode: 0o600 });
  return { config_file, consent_file, clock: () => now, config, consent };
}
function review(context: AiMonitorContext) {
  return { schema_version: "ai-research-review-v1" as const, facts: context.evidence.map(row => ({ ...row })), inferences: [
    { text: "Fictional inference, never investment advice", evidence_ids: [context.evidence[0].evidence_id] }],
    supporting_evidence: [context.evidence[0].evidence_id], counter_evidence: [], risks: ["Fictional source"], recommendation: "maintain_research" as const,
    reason: "Fictional review only", unknowns: ["No real data"], invalidation_conditions: ["Input version changes"] };
}
function transportResult(context: AiMonitorContext) {
  const value = review(context); return { review: value, review_hash: hash(value), context_hash: hash(context), reported_model_hash: hash("fictional-model"), usage: null };
}
function childArgs(f: F, options: ReturnType<typeof settings>, mode: string, request: { observation_id: string; binding_hash: string }, at = now) {
  return ["--import", "tsx", "tests/investor-ai-process-fixture.ts", mode, f.filename, options.config_file, options.consent_file, at,
    request.observation_id, request.binding_hash];
}
function child(f: F, options: ReturnType<typeof settings>, mode: string, request: { observation_id: string; binding_hash: string }) {
  return JSON.parse(execFileSync(process.execPath, childArgs(f, options, mode, request), { cwd: process.cwd(), encoding: "utf8", timeout: 60000,
    maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] })) as { status: string; reason_code: string | null; review_hash: string | null; calls: number };
}

test("closed current observation context crosses Python; no private amounts, IDs, quotes or arbitrary text leave replay", () => {
  const f = investorFixture();
  try {
    seed(f); const before = f.db.prepare("SELECT total_changes() n").get();
    const prepared = prepareInvestorAiExplanation(f.db, actor, now), raw = canonical(prepared.context);
    assert.equal(prepared.context.deterministic_outcome, "observe"); assert.equal(prepared.context.evidence.length, 2);
    assert.ok(Date.parse(prepared.valid_until) > Date.parse(now));
    for (const value of ["98765.43", "FICTIONAL_PRIVATE_PREFERENCE", "CN:ALPHA", "CN:BETA", prepared.workspace_id, prepared.observation_id, "model_nav_cny", "account_region", "provider_symbol", "profile_hash"])
      assert.ok(!raw.includes(value), value);
    assert.equal(aiExplanationImplementationHash().length, 64);
    const output = execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c", "import json,sys; from worker.ai_explanation.context import validate_monitor_context; from worker.orchestration.db import content_hash; v=validate_monitor_context(json.load(sys.stdin)); print(content_hash(v))"],
      { cwd: path.resolve(process.cwd(), ".."), input: raw, encoding: "utf8" }).trim();
    assert.equal(output, prepared.context_hash); assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); noFinance(f);
  } finally { f.close(); }
});

test("both historical research and current monitor source rights are required; original false manifest is not rewritten", () => {
  for (const [researchAi, monitorAi] of [[false, true], [true, false]]) {
    const f = investorFixture();
    try {
      seed(f, researchAi, monitorAi);
      assert.throws(() => prepareInvestorAiExplanation(f.db, actor, now), /SOURCE_SHARING_NOT_APPROVED/);
      const sources = f.db.prepare("SELECT document_json FROM investor_evidence_inputs").all() as { document_json: string }[];
      assert.ok(sources.every(row => JSON.parse(row.document_json).snapshot.external_ai_authorized === false));
      noFinance(f);
    } finally { f.close(); }
  }
});

test("on-demand explanation rechecks bindings; reads and duplicates never invoke transport or mutate finance", async () => {
  const f = investorFixture();
  try {
    seed(f); const options = settings(f);
    const researchRows = () => hash(Object.fromEntries(["investor_workspaces", "investor_profiles", "investor_observations", "investor_models", "investor_model_controls"]
      .map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
    const before = researchRows(); let calls = 0;
    const ready = readInvestorAiExplanation(f.db, actor, options); assert.equal(ready.status, "available");
    const request = { observation_id: ready.observation_id!, binding_hash: ready.binding_hash! };
    const result = await explainInvestorObservation(f.db, actor, request, { ...options, transport: async context => { calls++; return transportResult(context); } });
    assert.equal(result.status, "complete"); assert.equal(result.narrative_verified, false);
    assert.deepEqual(parseInvestorAiExplanation({ ...result, session_binding: binding }, binding, result.observation_id, Date.parse(now)), result);
    const metadataChanges = f.db.prepare("SELECT total_changes() n").get();
    await explainInvestorObservation(f.db, actor, request, { ...options, transport: async context => { calls++; return transportResult(context); } });
    assert.equal(calls, 1); assert.equal(readInvestorAiExplanation(f.db, actor, options).status, "complete");
    const retained = cachedEntry(result.binding_hash!); assert.ok(retained?.status.review);
    assert.equal(readInvestorAiExplanation(f.db, actor, { ...options, clock: () => result.valid_until! }).status, "blocked");
    assert.equal(cachedEntry(result.binding_hash!), undefined); assert.equal(retained.status.review, null);
    assert.throws(() => parseInvestorAiExplanation({ ...result, session_binding: binding }, binding, result.observation_id, Date.parse(result.valid_until!)), /NOT_CURRENT/);
    assert.throws(() => parseInvestorAiExplanation({ ...result, session_binding: "b".repeat(64) }, binding, result.observation_id, Date.parse(now)), /RESPONSE_INVALID/);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), metadataChanges);
    assert.equal(researchRows(), before); noFinance(f);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_requests").get() as { n: number }).n, 1);
    assert.equal(maintainInvestorAiExplanations(f.db, actor, { ...options, clock: () => result.valid_until! }), 1);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_payloads").get() as { n: number }).n, 0);
  } finally { f.close(); }
});

test("new-funding explanation remains a decision and a paused model discards output generated in flight", async () => {
  const f = investorFixture();
  try {
    seed(f, true, true, true); const options = settings(f), current = prepareInvestorAiExplanation(f.db, actor, now);
    assert.equal(current.context.deterministic_outcome, "decision_required");
    assert.ok(current.context.trigger_codes.includes("PLANNED_FUNDING_REVIEW_OPEN"));
    assert.ok(!canonical(current.context).includes("1000"));
    const ready = readInvestorAiExplanation(f.db, actor, options); let calls = 0;
    const result = await explainInvestorObservation(f.db, actor, { observation_id: ready.observation_id!, binding_hash: ready.binding_hash! }, {
      ...options, transport: async context => {
        calls++; const state = getInvestorState(f.db, actor, now);
        executeInvestorCommand(f.db, actor, { action: "set_monitoring", model_id: state.model_watch!.id, enabled: false, expected_revision: state.revision,
          idempotency_key: "ai-pause-inflight" }, now);
        return transportResult(context);
      },
    });
    assert.equal(calls, 1); assert.equal(result.status, "blocked"); assert.equal(result.review, null); noFinance(f);
  } finally { f.close(); }
});

test("private consent is audience, principal, time and category bound; files and unknown output cannot self-certify", () => {
  const f = investorFixture();
  try {
    const options = settings(f); assert.equal(readAiExplanationSettings(options.config_file, options.consent_file, actor, now).config_hash, hash(options.config));
    for (const update of [{ principal_id: "someone-else" }, { gateway_audience_hash: "b".repeat(64) }, { valid_until: now }, { valid_from: "2026-01-04T00:00:00.000Z" }]) {
      writeFileSync(options.consent_file, canonical({ ...options.consent, ...update }));
      assert.throws(() => readAiExplanationSettings(options.config_file, options.consent_file, actor, now), /CONSENT_NOT_CURRENT/);
    }
    writeFileSync(options.consent_file, canonical({ ...options.consent, allowed_categories: [...options.consent.allowed_categories, "raw_quotes"] }));
    assert.throws(() => readAiExplanationSettings(options.config_file, options.consent_file, actor, now), /CONFIG_UNAVAILABLE/);
    writeFileSync(options.consent_file, canonical(options.consent)); chmodSync(options.consent_file, 0o644);
    assert.throws(() => readAiExplanationSettings(options.config_file, options.consent_file, actor, now), /CONFIG_UNAVAILABLE/);
    const link = path.join(f.directory, "link.json"); symlinkSync(options.config_file, link);
    assert.throws(() => readAiExplanationSettings(link, options.consent_file, actor, now), /CONFIG_UNAVAILABLE/);
  } finally { f.close(); }
});

test("in-flight de-duplication and consent withdrawal prevent a second request or stale publication", async () => {
  const f = investorFixture();
  try {
    seed(f); const options = settings(f), ready = readInvestorAiExplanation(f.db, actor, options);
    const request = { observation_id: ready.observation_id!, binding_hash: ready.binding_hash! };
    let release!: () => void, entered!: () => void, calls = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const transport = async (context: AiMonitorContext) => { calls++; entered(); await waiting; return transportResult(context); };
    const first = explainInvestorObservation(f.db, actor, request, { ...options, transport });
    await started;
    assert.equal(readInvestorAiExplanation(f.db, actor, options).status, "running");
    assert.equal((await explainInvestorObservation(f.db, actor, request, { ...options, transport })).status, "running");
    assert.equal(calls, 1); unlinkSync(options.consent_file); release();
    const result = await first; assert.equal(result.status, "blocked"); assert.equal(result.review, null);
    assert.equal(readInvestorAiExplanation(f.db, actor, options).review, null); noFinance(f);
  } finally { f.close(); }
});

test("unsupported resealed AI facts fail without retry; later source withdrawal hides all cached text", async () => {
  const f = investorFixture();
  try {
    seed(f); const options = settings(f), ready = readInvestorAiExplanation(f.db, actor, options); let calls = 0;
    const request = { observation_id: ready.observation_id!, binding_hash: ready.binding_hash! };
    const transport = async (context: AiMonitorContext) => {
      calls++; const value = transportResult(context); value.review.facts[0].value = "0.999"; value.review_hash = hash(value.review); return value;
    };
    const failed = await explainInvestorObservation(f.db, actor, request, { ...options, transport });
    assert.equal(failed.status, "failed"); assert.equal(failed.review, null);
    await explainInvestorObservation(f.db, actor, request, { ...options, transport }); assert.equal(calls, 1);
    execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c", `from worker.orchestration.db import open_database
from worker.investor.data_evidence import review_source
import sys
db=open_database(sys.argv[1])
source=db.execute("SELECT id FROM investor_data_sources WHERE kind='rights' ORDER BY rowid LIMIT 1").fetchone()[0]
workspace=db.execute("SELECT id FROM investor_workspaces").fetchone()[0]
review_source(db,workspace,'synthetic-investor',source,'withdrawn',None,'Fictional AI test withdrawal','2027-01-01T00:00:00.000Z',now='2026-01-03T12:15:04.000Z')
db.close()`, f.filename], { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
    const hidden = readInvestorAiExplanation(f.db, actor, options); assert.equal(hidden.status, "blocked"); assert.equal(hidden.review, null);
    assert.equal(getInvestorState(f.db, actor, now).effective_outcome, "insufficient_evidence"); noFinance(f);
  } finally { f.close(); }
});

test("withdrawal aborts an in-flight call but retains its concurrency slot until the transport finishes", async () => {
  const f = investorFixture();
  try {
    seed(f); const options = settings(f), ready = readInvestorAiExplanation(f.db, actor, options);
    const request = { observation_id: ready.observation_id!, binding_hash: ready.binding_hash! };
    let release!: () => void, entered!: () => void, sentSignal: AbortSignal | undefined, calls = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const first = explainInvestorObservation(f.db, actor, request, { ...options, transport: async (context, _, signal) => {
      calls++; sentSignal = signal; entered(); await waiting; return transportResult(context);
    } });
    try {
      await started; unlinkSync(options.consent_file);
      assert.equal(readInvestorAiExplanation(f.db, actor, options).status, "blocked");
      assert.equal(sentSignal?.aborted, true); assert.equal(cachedEntry(request.binding_hash), undefined);
      writeFileSync(options.consent_file, canonical(options.consent), { mode: 0o600 });
      const restored = readInvestorAiExplanation(f.db, actor, options); assert.equal(restored.status, "running");
      assert.equal((await explainInvestorObservation(f.db, actor, request, { ...options,
        transport: async context => { calls++; return transportResult(context); } })).status, "running");
      writeFileSync(options.consent_file, canonical({ ...options.consent, valid_until: "2026-01-04T11:59:00.000Z" }));
      const renewed = readInvestorAiExplanation(f.db, actor, options); assert.equal(renewed.status, "available");
      await assert.rejects(explainInvestorObservation(f.db, actor, { observation_id: renewed.observation_id!, binding_hash: renewed.binding_hash! }, { ...options,
        transport: async context => { calls++; return transportResult(context); } }), /INVESTOR_AI_BUSY/);
      assert.equal(calls, 1);
    } finally { release(); }
    const result = await first;
    assert.equal(result.status, "available"); assert.equal(result.review, null); assert.equal(cachedEntry(request.binding_hash), undefined);
    noFinance(f);
  } finally { f.close(); }
});

test("a separate live process cannot resend a claimed request and a cold process replays its completed result", async () => {
  const f = investorFixture();
  try {
    seed(f); const options = settings(f), ready = readInvestorAiExplanation(f.db, actor, options);
    const request = { observation_id: ready.observation_id!, binding_hash: ready.binding_hash! };
    let release!: () => void, entered!: () => void, calls = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const first = explainInvestorObservation(f.db, actor, request, { ...options, transport: async context => {
      calls++; entered(); await waiting; return transportResult(context);
    } });
    try {
      await started;
      assert.deepEqual(child(f, options, "duplicate", request), { status: "running", reason_code: null, review_hash: null, calls: 0 });
    } finally { release(); }
    const completed = await first; assert.equal(completed.status, "complete"); assert.equal(calls, 1);
    assert.deepEqual(child(f, options, "read", request), { status: "complete", reason_code: null, review_hash: hash(completed.review), calls: 0 });
    assert.deepEqual(child(f, options, "duplicate", request), { status: "complete", reason_code: null, review_hash: hash(completed.review), calls: 0 });
    noFinance(f);
  } finally { f.close(); }
});

test("a process crash after durable dispatch becomes unknown, with no automatic request replay or financial writes", async () => {
  const f = investorFixture();
  try {
    seed(f); const options = settings(f), ready = readInvestorAiExplanation(f.db, actor, options);
    const request = { observation_id: ready.observation_id!, binding_hash: ready.binding_hash! };
    const crashed = spawnSync(process.execPath, childArgs(f, options, "crash", request), { cwd: process.cwd(), encoding: "utf8", timeout: 60000, maxBuffer: 65536 });
    assert.equal(crashed.status, 73); assert.equal(crashed.signal, null);
    assert.equal(readInvestorAiExplanation(f.db, actor, options).status, "running");
    const afterDeadline = { ...options, clock: () => "2026-01-03T12:15:50.000Z" };
    assert.equal(readInvestorAiExplanation(f.db, actor, afterDeadline).reason_code, "INVESTOR_AI_OUTCOME_UNKNOWN");
    let calls = 0;
    const status = await explainInvestorObservation(f.db, actor, request, { ...afterDeadline,
      transport: async context => { calls++; return transportResult(context); } });
    assert.equal(status.reason_code, "INVESTOR_AI_OUTCOME_UNKNOWN"); assert.equal(calls, 0);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_requests").get() as { n: number }).n, 1);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_dispatches").get() as { n: number }).n, 1);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_payloads").get() as { n: number }).n, 0); noFinance(f);
  } finally { f.close(); }
});

test("two simultaneously launched cold processes produce one dispatch and one fictional external attempt", async () => {
  const f = investorFixture();
  try {
    seed(f); const options = settings(f), ready = readInvestorAiExplanation(f.db, actor, options);
    const request = { observation_id: ready.observation_id!, binding_hash: ready.binding_hash! };
    const start = () => runHttpFixture(process.execPath, childArgs(f, options, "race", request),
      { cwd: process.cwd(), encoding: "utf8", timeout: 60000, maxBuffer: 65536 });
    const first = start(), second = start();
    const a = await first, b = await second;
    assert.equal(a.status, 0); assert.equal(b.status, 0);
    const results = [JSON.parse(a.stdout), JSON.parse(b.stdout)] as { status: string; calls: number }[];
    assert.equal(results.reduce((total, row) => total + row.calls, 0), 1);
    assert.ok(results.every(row => ["complete", "running"].includes(row.status)));
    assert.equal(readInvestorAiExplanation(f.db, actor, options).status, "complete");
    for (const table of ["investor_ai_requests", "investor_ai_dispatches", "investor_ai_outcomes", "investor_ai_payloads"])
      assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 1);
    noFinance(f);
  } finally { f.close(); }
});

test("strict context and review reject relabelled amounts, extra fields, altered evidence and executable permissions", () => {
  const context = aiMonitorContextSchema.parse({ schema_version: "ai-monitor-context-v1", deterministic_outcome: "observe", evaluated_at: now,
    evidence: [{ evidence_id: "derived:max_abs_target_gap", metric: "model.max_abs_target_gap", value: "0.01", as_of: now },
      { evidence_id: "derived:target_change_count", metric: "model.target_change_count", value: "0", as_of: now }],
    trigger_codes: ["FIXED_POLICY_WITHIN_CLASS_BANDS"], limitations: aiLimitations, strategy_gates: { investment_gate_passed: false, live_advice_eligible: false } });
  for (const change of [(value: Obj) => { value.raw_quotes = []; }, (value: Obj) => { (value.strategy_gates as Obj).live_advice_eligible = true; },
    (value: Obj) => { (value.evidence as Obj[])[0].value = "1000000"; }, (value: Obj) => { (value.evidence as Obj[])[0].metric = "model.nav_cny"; },
    (value: Obj) => { (value.evidence as Obj[])[0].value = "1.000000000000000001"; }, (value: Obj) => { (value.evidence as Obj[])[1].value = "01"; }]) {
    const value = structuredClone(context) as unknown as Obj; change(value); assert.equal(aiMonitorContextSchema.safeParse(value).success, false);
  }
  assert.deepEqual(validateAiMonitorReview(review(context), context), review(context));
  for (const change of [(value: ReturnType<typeof review>) => { value.facts[0].value = "0.010"; },
    (value: ReturnType<typeof review>) => { value.facts.pop(); }, (value: ReturnType<typeof review>) => { value.facts[1] = value.facts[0]; },
    (value: ReturnType<typeof review>) => { value.inferences[0].evidence_ids = ["unknown:id"]; }]) {
    const value = review(context); change(value); assert.throws(() => validateAiMonitorReview(value, context));
  }
});

test("explicit intent is durable without transport; cold workers finish it without an HTTP session or browser", async () => {
  const f = investorFixture();
  try {
    seed(f); const options = settings(f), ready = readInvestorAiExplanation(f.db, actor, options);
    const request = { observation_id: ready.observation_id!, binding_hash: ready.binding_hash! };
    let sessions = 0, calls = 0;
    const queued = await enqueueInvestorAiExplanation(f.db, actor, request, { ...options,
      assert_session: async () => { sessions++; }, transport: async context => { calls++; return transportResult(context); } });
    assert.equal(queued.status, "queued"); assert.equal(sessions, 1); assert.equal(calls, 0);
    const changes = f.db.prepare("SELECT total_changes() n").get();
    assert.equal((await enqueueInvestorAiExplanation(f.db, actor, request, options)).status, "queued");
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_dispatches").get() as { n: number }).n, 0);
    const dry = JSON.parse(execFileSync(process.execPath, childArgs(f, options, "maintenance", request), { encoding: "utf8", timeout: 60000 }));
    assert.deepEqual(dry, { purged: 0, processed: false, calls: 0 });
    const start = () => runHttpFixture(process.execPath, childArgs(f, options, "background", request),
      { cwd: process.cwd(), encoding: "utf8", timeout: 60000, maxBuffer: 65536 });
    const first = start(), second = start(), a = await first, b = await second;
    assert.equal(a.status, 0); assert.equal(b.status, 0);
    assert.equal([JSON.parse(a.stdout), JSON.parse(b.stdout)].reduce((total, row) => total + row.calls, 0), 1);
    assert.equal(readInvestorAiExplanation(f.db, actor, options).status, "complete");
    for (const table of ["investor_ai_requests", "investor_ai_dispatches", "investor_ai_outcomes", "investor_ai_payloads"])
      assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 1);
    noFinance(f);
  } finally { f.close(); }
});

test("queued consent withdrawal or monitoring pause is purged before a worker can send", async () => {
  for (const revoke of ["consent", "monitor"] as const) {
    const f = investorFixture();
    try {
      seed(f); const options = settings(f), ready = readInvestorAiExplanation(f.db, actor, options);
      await enqueueInvestorAiExplanation(f.db, actor, { observation_id: ready.observation_id!, binding_hash: ready.binding_hash! }, options);
      if (revoke === "consent") writeFileSync(options.consent_file, canonical({ ...options.consent, decision: "deny" }));
      else {
        const state = getInvestorState(f.db, actor, now);
        executeInvestorCommand(f.db, actor, { action: "set_monitoring", model_id: state.model_watch!.id, enabled: false,
          expected_revision: state.revision, idempotency_key: "ai-queued-pause" }, now);
      }
      let calls = 0;
      assert.deepEqual(await runInvestorAiBackgroundPass(f.db, actor, true, { ...options,
        transport: async context => { calls++; return transportResult(context); } }), { purged: 1, processed: false });
      assert.equal(calls, 0); assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_dispatches").get() as { n: number }).n, 0);
      assert.equal(readInvestorAiExplanation(f.db, actor, options).status, "blocked"); noFinance(f);
    } finally { f.close(); }
  }
});

test("an idle cold process purges expired text without a UI read or gateway request", async () => {
  const f = investorFixture();
  try {
    seed(f); const options = settings(f), ready = readInvestorAiExplanation(f.db, actor, options);
    const request = { observation_id: ready.observation_id!, binding_hash: ready.binding_hash! };
    const completed = await explainInvestorObservation(f.db, actor, request, { ...options, transport: async context => transportResult(context) });
    assert.equal(completed.status, "complete");
    const output = execFileSync(process.execPath, childArgs(f, options, "maintenance", request, completed.valid_until!), { encoding: "utf8", timeout: 60000 });
    assert.deepEqual(JSON.parse(output), { purged: 1, processed: false, calls: 0 });
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_payloads").get() as { n: number }).n, 0);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_outcomes").get() as { n: number }).n, 1); noFinance(f);
  } finally { f.close(); }
});

test("worker runtime verification fences changed code before sending and again before publishing", async () => {
  const f = investorFixture();
  try {
    seed(f); const options = settings(f), ready = readInvestorAiExplanation(f.db, actor, options);
    await enqueueInvestorAiExplanation(f.db, actor, { observation_id: ready.observation_id!, binding_hash: ready.binding_hash! }, options);
    let calls = 0, checks = 0;
    await assert.rejects(runInvestorAiBackgroundPass(f.db, actor, true, { ...options,
      assert_runtime: () => { throw new Error("FICTIONAL_SOURCE_CHANGED"); }, transport: async context => { calls++; return transportResult(context); } }));
    assert.equal(calls, 0); assert.equal(readInvestorAiExplanation(f.db, actor, options).status, "queued");
    await runInvestorAiBackgroundPass(f.db, actor, true, { ...options,
      assert_runtime: () => { if (++checks === 2) throw new Error("FICTIONAL_SOURCE_CHANGED"); }, transport: async context => { calls++; return transportResult(context); } });
    assert.equal(calls, 1); assert.equal(checks, 2); assert.equal(readInvestorAiExplanation(f.db, actor, options).status, "failed");
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_payloads").get() as { n: number }).n, 0);
    assert.deepEqual(await runInvestorAiBackgroundPass(f.db, actor, true, options), { purged: 0, processed: false }); noFinance(f);
  } finally { f.close(); }
});

test("another connection's purge also clears this process's retained text on an idle maintenance pass", async () => {
  const f = investorFixture();
  try {
    seed(f); const options = settings(f), ready = readInvestorAiExplanation(f.db, actor, options);
    const result = await explainInvestorObservation(f.db, actor, { observation_id: ready.observation_id!, binding_hash: ready.binding_hash! },
      { ...options, transport: async context => transportResult(context) });
    const entry = cachedEntry(result.binding_hash!); assert.ok(entry?.status.review);
    // The storage layer changes SQLite only, as an independent worker does; it cannot clear this local cache.
    const other = openWorkbench(f.filename);
    try { assert.equal(purgeDurableAiScope(other, actor, now, null), 1); } finally { other.close(); }
    assert.ok(entry.status.review);
    assert.equal(maintainInvestorAiExplanations(f.db, actor, options), 0);
    assert.equal(entry.status.review, null); assert.equal(cachedEntry(result.binding_hash!), undefined);
    assert.equal(readInvestorAiExplanation(f.db, actor, options).reason_code, "INVESTOR_AI_RESULT_PURGED"); noFinance(f);
  } finally { f.close(); }
});
