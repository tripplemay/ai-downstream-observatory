import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { NextResponse } from "next/server";
import { z } from "zod";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { AuthError, tokenHash } from "../src/server/auth/core";
import { createAccount, createPortfolio, hash, recordFact, revision } from "../src/server/ledger/service";

const root = path.resolve(".."), require = createRequire(import.meta.url);
const python = process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3";
const actor = { id: "SYNTHETIC-ROTATION-WEB-HUMAN" }, sid = "synthetic-rotation-session";
const binding = tokenHash(`workbench-client-session-v1:${sid}`), endpoint = "https://workbench.example.test/api/workbench";
const untouched = ["ledger_events", "postings", "position_movements", "security_transit_movements", "account_projections", "position_projections", "ledger_heads",
  "policy_versions", "strategy_versions", "activations", "approval_events", "reservations", "execution_reports", "proposals", "proposal_items", "risk_runs"];
const routeCode = ts.transpileModule(readFileSync(path.join(root, "web/src/app/api/workbench/route.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const bindingCode = ts.transpileModule(readFileSync(path.join(root, "web/src/server/auth/session-binding.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

interface Samples { plan: Record<string, unknown>; dataset: Record<string, unknown>; parameters: Record<string, unknown>; legacy_plan: Record<string, unknown>; legacy_dataset: Record<string, unknown>; legacy_parameters: Record<string, unknown> }
interface ResearchPortfolio { engine_version?: string; initial_equity_cny: string; contributions_cny: string; monthly_evaluation_counts?: { proposed: number; unchanged: number; blocked: number }; events: Array<{ type: string; at: string; decision_at?: string; settled_at?: string }> }
interface ResearchReport { live_advice_eligible: boolean; admission_grade?: string; strategy_gates: Record<string, { status: string }>; strategy: ResearchPortfolio; benchmark: ResearchPortfolio; result_hash: string; dataset_hash: string; plan_hash: string; parameters_hash: string }
function execute<T>(dir: string, filename: string, code: string): T {
  const child = spawnSync(python, ["-c", code, filename], { cwd: root, encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024,
    env: { NODE_ENV: "test", PATH: process.env.PATH, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: "1", TZ: "UTC", WORKBENCH_MODE: "ledger", WORKBENCH_DB_PATH: filename, WORKBENCH_DATA_DIR: dir } });
  assert.equal(child.status, 0, `Synthetic research subprocess failed: ${child.stderr || child.error?.message}`);
  return JSON.parse(child.stdout) as T;
}
function fixture(t: { after(callback: () => void): void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "etf-rotation-web-")), filename = path.join(dir, "workbench.db");
  migrateWorkbench(filename); const db = openWorkbench(filename);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const portfolio = createPortfolio(db, actor, "SYNTHETIC RESEARCH ISOLATION"), account = createAccount(db, actor, portfolio, "Synthetic account", "Synthetic only", "CNY");
  recordFact(db, actor, { portfolio_id: portfolio, expected_revision: 0, idempotency_key: "synthetic-opening", source_id: "synthetic", source_event_id: "opening",
    effective_at: "2025-01-01", time_precision: "date", source_timezone: "UTC", reason: "Synthetic real-ledger baseline, not research capital",
    fact: { type: "opening_cash", account_id: account, currency: "CNY", amount: "37.25" } });
  const samples = execute<Samples>(dir, filename, `
import json
from tests.research.rotation_fixtures import dataset, plan, parameters
from tests.research.fixtures import dataset as legacy_dataset, plan as legacy_plan, parameters as legacy_parameters
print(json.dumps(dict(dataset=dataset(), plan=plan(), parameters=parameters(), legacy_dataset=legacy_dataset(), legacy_plan=legacy_plan(), legacy_parameters=legacy_parameters())))
`);
  const snapshot = () => hash(untouched.map(table => ({ table, rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() })));
  const worker = () => execute<{ id: string; command_request_id: string; status: string; result_json: string } | null>(dir, filename, `
import json, sys
from worker.orchestration.db import open_database
from worker.orchestration.runtime import run_pending_once
db = open_database(sys.argv[1])
try:
    assert not db.in_transaction
    print(json.dumps(run_pending_once(db, 'synthetic-rotation-worker')))
finally:
    db.close()
`);
  const route = (authenticated = true) => {
    const calls: string[] = [];
    const session = async () => { calls.push("auth"); if (!authenticated) throw new AuthError("UNAUTHENTICATED", 401); return { userId: actor.id, sessionId: sid }; };
    const sessionModule = { exports: {} as { assertRequestSessionBinding(request: Request, sessionId: string): void } };
    const initializeBinding = runInNewContext(`(function(require,module,exports){${bindingCode}\n})`, { Error }) as (require: (id: string) => unknown, module: unknown, exports: unknown) => void;
    initializeBinding(id => id === "server-only" ? {} : id === "./core" ? { AuthError, tokenHash } : require(id), sessionModule, sessionModule.exports);
    const dependencies: Record<string, unknown> = { "next/server": { NextResponse }, zod: { z }, "@/server/auth/session": { requireApiSession: session, requireMutationSession: session },
      "@/server/auth/session-binding": sessionModule.exports, "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return openWorkbench(filename); } } };
    const module = { exports: {} as { POST(request: Request): Promise<Response>; GET(request: Request): Promise<Response> } };
    const initialize = runInNewContext(`(function(require,module,exports){${routeCode}\n})`, { Error, URL, Buffer, TextDecoder, console: { error() {} } }) as (require: (id: string) => unknown, module: unknown, exports: unknown) => void;
    initialize(id => id in dependencies ? dependencies[id] : require(id.startsWith("@/") ? path.join(root, "web/src", id.slice(2)) : id), module, module.exports);
    return { ...module.exports, calls };
  };
  const handler = route();
  const request = (value: unknown, headers: HeadersInit = {}) => new Request(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": binding, ...headers }, body: typeof value === "string" ? value : JSON.stringify(value) });
  const envelope = (command_type: string, payload: unknown, overrides = {}) => ({ action: "enqueue_task", command: { portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: randomUUID(), command_type, payload, ...overrides } });
  const enqueue = async (command_type: string, payload: unknown) => {
    const body = envelope(command_type, payload), response = await handler.POST(request(body)), result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.status, "queued");
    const duplicate = await handler.POST(request(body)); assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), result);
    const stored = db.prepare("SELECT actor_id,payload_json,payload_hash FROM command_requests WHERE id=?").get(result.request_id) as { actor_id: string; payload_json: string; payload_hash: string };
    assert.equal(stored.actor_id, actor.id); assert.equal(stored.payload_hash, hash(payload)); assert.deepEqual(JSON.parse(stored.payload_json), payload);
    const job = worker(); assert.ok(job); assert.equal(job.command_request_id, result.request_id);
    return { job, result: JSON.parse(job.result_json) as Record<string, unknown>, request: result };
  };
  return { db, dir, filename, portfolio, samples, snapshot, worker, route, handler, request, envelope, enqueue };
}

test("Web Request to real Python rotation trial preserves actual accounting and produces only research evidence", async t => {
  const f = fixture(t), before = f.snapshot(), experiment = "synthetic-rotation-web";
  assert.equal(f.samples.plan.schema_version, "research-plan-v2"); assert.equal(f.samples.dataset.schema_version, "research-dataset-v2");
  const registered = await f.enqueue("research_register", { experiment_id: experiment, plan: f.samples.plan, dataset: f.samples.dataset });
  assert.equal(registered.job.status, "succeeded", JSON.stringify(registered.result));
  assert.equal((f.db.prepare("SELECT created_by FROM research_experiments WHERE id=?").get(experiment) as { created_by: string }).created_by, actor.id);
  const trial = await f.enqueue("research_register_trial", { experiment_id: experiment, phase: "train", parameters: f.samples.parameters });
  assert.equal(trial.job.status, "succeeded", JSON.stringify(trial.result));
  const executed = await f.enqueue("research_trial", { trial_id: trial.result.trial_id });
  assert.equal(executed.job.status, "succeeded", JSON.stringify(executed.result)); assert.equal(executed.result.live_advice_eligible, false);
  const stored = f.db.prepare("SELECT environment,result_json FROM research_runs WHERE id=?").get(trial.result.research_run_id) as { environment: string; result_json: string };
  const report = JSON.parse(stored.result_json) as ResearchReport;
  assert.equal(stored.environment, "research"); assert.equal(report.live_advice_eligible, false); assert.notEqual(report.admission_grade, "formal_verified");
  assert.match(report.result_hash, /^[a-f0-9]{64}$/); assert.ok(report.strategy); assert.ok(report.strategy_gates);
  assert.ok(Object.values(report.strategy_gates).every(value => value && typeof value === "object" && "status" in value && ["NOT_RUN", "BLOCKED"].includes(String(value.status))), "Synthetic reports must not certify S gates");
  assert.equal(Object.keys(report.strategy_gates).length, 10);
  const { result_hash: resultHash, ...hashedReport } = report;
  assert.equal(resultHash, hash(hashedReport)); assert.equal(report.dataset_hash, hash(f.samples.dataset));
  assert.equal(report.plan_hash, hash(f.samples.plan)); assert.equal(report.parameters_hash, hash(f.samples.parameters));
  assert.equal(report.strategy.engine_version, "monthly-rotation-rebalance-v1");
  assert.equal(report.benchmark.engine_version, report.strategy.engine_version);
  assert.equal(report.strategy.initial_equity_cny, f.samples.plan.initial_capital_cny);
  assert.notEqual(report.strategy.initial_equity_cny, "37.25");
  assert.equal(report.benchmark.initial_equity_cny, report.strategy.initial_equity_cny);
  assert.equal(report.benchmark.contributions_cny, report.strategy.contributions_cny);
  for (const kind of ["evaluation", "simulated_buy", "simulated_sell", "stock_settlement", "sale_cash_settlement"])
    assert.ok(report.strategy.events.some(row => row.type === kind), `Missing actual simulated ${kind}`);
  for (const fill of report.strategy.events.filter(row => ["simulated_buy", "simulated_sell"].includes(row.type))) {
    assert.ok(fill.decision_at && fill.settled_at);
    assert.ok(Date.parse(fill.at) > Date.parse(fill.decision_at));
    assert.ok(Date.parse(fill.settled_at) > Date.parse(fill.at));
  }
  const events = f.db.prepare("SELECT COUNT(*) n FROM simulation_events").get() as { n: number }; assert.ok(events.n > 0);
  const again = await f.enqueue("research_trial", { trial_id: trial.result.trial_id }); assert.equal(again.result.result_hash, executed.result.result_hash);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM simulation_events").get() as { n: number }).n, events.n);
  const response = await f.handler.GET(new Request(`${endpoint}?portfolio=${encodeURIComponent(f.portfolio)}&view=research`));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  const view = await response.json(); assert.equal(view.live_advice_eligible, false); assert.equal(view.trials[0].result_hash, report.result_hash);
  assert.equal(view.trials[0].parameters_json, JSON.stringify(JSON.parse(view.trials[0].parameters_json)));
  assert.deepEqual(JSON.parse(view.trials[0].parameters_json), f.samples.parameters);
  for (const key of ["engine_version", "initial_equity_cny", "contributions_cny", "ending_nav_cny", "profit_cny", "fees_cny", "fx_fees_cny", "slippage_cny", "cash_rounding_cny",
    "buy_turnover_on_mean_observed_nav", "sell_turnover_on_mean_observed_nav", "total_turnover_on_mean_observed_nav", "ending_cash_ratio", "execution_failure_count", "monthly_evaluation_counts"])
    assert.deepEqual(view.trials[0][key], (report.strategy as unknown as Record<string, unknown>)[key], key);
  assert.ok(report.strategy.monthly_evaluation_counts);
  for (const outcome of ["proposed", "unchanged", "blocked"] as const)
    assert.equal(report.strategy.monthly_evaluation_counts[outcome], report.strategy.events.filter(row => row.type === "evaluation" && (row as unknown as { outcome: string }).outcome === outcome).length);
  assert.equal("events" in view.trials[0], false); assert.equal("curve" in view.trials[0], false);
  assert.equal(f.snapshot(), before, "Research must not change actual ledger, approvals, activation, proposals or reservations");
  assert.equal(f.worker(), null, "Restart must not synthesize another completed task");
});

test("unauthenticated and mismatched-session Web requests reject before body and database access", async t => {
  const f = fixture(t), before = f.snapshot(), unauthenticated = f.route(false);
  const request = f.request("not-json", { "Content-Length": "99999999" });
  assert.equal((await unauthenticated.POST(request)).status, 401); assert.equal(request.bodyUsed, false); assert.deepEqual(unauthenticated.calls, ["auth"]);
  assert.equal((await unauthenticated.GET(new Request(`${endpoint}?portfolio=${f.portfolio}&view=research`))).status, 401);
  const old = f.request("not-json", { "X-Workbench-Session-Binding": "0".repeat(64) });
  assert.equal((await f.handler.POST(old)).status, 401); assert.equal(old.bodyUsed, false); assert.equal(f.snapshot(), before);
});

test("v1/v2 plan-data mismatch and unknown request or rotation parameter fields are rejected without queueing", async t => {
  const f = fixture(t), before = f.snapshot();
  const bad = [
    { experiment_id: "bad-plan", plan: f.samples.legacy_plan, dataset: f.samples.dataset },
    { experiment_id: "bad-data", plan: f.samples.plan, dataset: f.samples.legacy_dataset },
    { experiment_id: "old-plan-new-parameters", plan: { ...f.samples.legacy_plan, parameter_candidates: [f.samples.parameters] }, dataset: f.samples.legacy_dataset },
    { experiment_id: "new-plan-old-benchmark", plan: { ...f.samples.plan, benchmark: f.samples.legacy_parameters }, dataset: f.samples.dataset },
    { experiment_id: "extra", plan: { ...f.samples.plan, auto_approve: true }, dataset: f.samples.dataset },
    { experiment_id: "extra-data", plan: f.samples.plan, dataset: { ...f.samples.dataset, execute_script: "never" } },
  ];
  for (const payload of bad) {
    const response = await f.handler.POST(f.request(f.envelope("research_register", payload)));
    assert.equal(response.status, 400, JSON.stringify(await response.json()));
  }
  for (const command of [f.envelope("research_register", { experiment_id: "bad-actor", plan: f.samples.plan, dataset: f.samples.dataset }, { actor_id: "ai" }),
    { ...f.envelope("research_register", {}), result: { status: "pass" } }]) assert.equal((await f.handler.POST(f.request(command))).status, 400);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM command_requests").get() as { n: number }).n, 0); assert.equal(f.snapshot(), before);
});

test("rotation parameter bounds and unknown fields fail Web validation instead of becoming queued work", async t => {
  const f = fixture(t), before = f.snapshot(), experiment = "parameter-validation";
  const registered = await f.enqueue("research_register", { experiment_id: experiment, plan: f.samples.plan, dataset: f.samples.dataset });
  assert.equal(registered.job.status, "succeeded", JSON.stringify(registered.result));
  const count = (f.db.prepare("SELECT COUNT(*) n FROM command_requests").get() as { n: number }).n;
  for (const patch of [{ momentum_sessions: 0 }, { momentum_sessions: 253 }, { moving_average_sessions: 1 }, { moving_average_sessions: 501 },
    { top_n: 0 }, { top_n: 101 }, { top_n: 1.5 }, { signal_basis: "unadjusted" }, { auto_approve: true }, { result: { pass: true } },
    { universe: Array.from({ length: 1001 }, (_, i) => `synthetic:${i}`) }]) {
    const response = await f.handler.POST(f.request(f.envelope("research_register_trial", { experiment_id: experiment, phase: "train", parameters: { ...f.samples.parameters, ...patch } })));
    assert.equal(response.status, 400, JSON.stringify(await response.json()));
  }
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM command_requests").get() as { n: number }).n, count);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM research_trials").get() as { n: number }).n, 0); assert.equal(f.snapshot(), before);
});

test("financially invalid but structurally valid rotation inputs leave genuine failed worker jobs, not a PASS", async t => {
  const f = fixture(t), before = f.snapshot();
  const invalid: Array<{ plan: Record<string, unknown>; dataset: Record<string, unknown>; code: string }> = [
    ...["0", "-0.1", "1.1"].map(target_fraction => ({ plan: { ...f.samples.plan, parameter_candidates: [{ ...f.samples.parameters, target_fraction }] }, dataset: f.samples.dataset, code: "INVALID_RESEARCH_TARGET_FRACTION" })),
    { plan: { ...f.samples.plan, parameter_candidates: [{ ...f.samples.parameters, tolerance: { absolute_cny: "-1", weight: "0" } }] }, dataset: f.samples.dataset, code: "INVALID_RESEARCH_TARGET_TOLERANCE" },
    { plan: { ...f.samples.plan, parameter_candidates: [{ ...f.samples.parameters, momentum_floor: "-1.01" }] }, dataset: f.samples.dataset, code: "INVALID_RESEARCH_MOMENTUM_FLOOR" },
    { plan: { ...f.samples.plan, parameter_candidates: [{ ...f.samples.parameters, universe: ["synthetic:unregistered"] }] }, dataset: f.samples.dataset, code: "INVALID_RESEARCH_UNIVERSE" },
    { plan: f.samples.plan, dataset: { ...f.samples.dataset, settlements: (f.samples.dataset.settlements as unknown[]).slice(1) }, code: "INCOMPLETE_RESEARCH_SETTLEMENT_CALENDAR" },
  ];
  for (const [index, input] of invalid.entries()) {
    const outcome = await f.enqueue("research_register", { experiment_id: `invalid-semantics-${index}`, plan: input.plan, dataset: input.dataset });
    assert.equal(outcome.job.status, "failed"); assert.equal(outcome.result.code, input.code); assert.equal(outcome.result.live_advice_eligible, false);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM job_attempts WHERE job_id=? AND status='failed'").get(outcome.job.id) as { n: number }).n, 1);
  }
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM research_experiments").get() as { n: number }).n, 0);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM research_runs").get() as { n: number }).n, 0);
  assert.equal(f.worker(), null, "Semantic failures cannot automatically retry into success"); assert.equal(f.snapshot(), before);
});

test("pre-registered parameter hashes, sealed holdout and trial budgets are enforced by the real worker", async t => {
  const f = fixture(t), before = f.snapshot(), experiment = "bounded-search";
  const plan = { ...f.samples.plan, trial_budgets: { train: 1, validation: 1, holdout: 1 } };
  assert.equal((await f.enqueue("research_register", { experiment_id: experiment, plan, dataset: f.samples.dataset })).job.status, "succeeded");
  const outside = await f.enqueue("research_register_trial", { experiment_id: experiment, phase: "train", parameters: { ...f.samples.parameters, top_n: 2 } });
  assert.equal(outside.job.status, "failed"); assert.equal(outside.result.code, "PARAMETERS_OUTSIDE_PREREGISTERED_SEARCH_SPACE");
  const sealed = await f.enqueue("research_register_trial", { experiment_id: experiment, phase: "holdout", parameters: f.samples.parameters });
  assert.equal(sealed.job.status, "failed"); assert.equal(sealed.result.code, "HOLDOUT_SEALED_OR_CANDIDATE_MISMATCH");
  const first = await f.enqueue("research_register_trial", { experiment_id: experiment, phase: "train", parameters: f.samples.parameters });
  assert.equal(first.job.status, "succeeded");
  const exhausted = await f.enqueue("research_register_trial", { experiment_id: experiment, phase: "train", parameters: f.samples.parameters });
  assert.equal(exhausted.job.status, "failed"); assert.equal(exhausted.result.code, "PREREGISTERED_TRIAL_BUDGET_EXHAUSTED");
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM research_trials").get() as { n: number }).n, 1);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM research_holdout_events").get() as { n: number }).n, 0); assert.equal(f.snapshot(), before);
});

test("old v1 experiments cannot accept new rotation parameters and valid legacy trials retain their old engine", async t => {
  const f = fixture(t), before = f.snapshot(), experiment = "legacy-version-boundary";
  assert.equal((await f.enqueue("research_register", { experiment_id: experiment, plan: f.samples.legacy_plan, dataset: f.samples.legacy_dataset })).job.status, "succeeded");
  const outcome = await f.enqueue("research_register_trial", { experiment_id: experiment, phase: "train", parameters: { ...f.samples.parameters, universe: ["CN:TEST"] } });
  assert.equal(outcome.job.status, "failed"); assert.equal(outcome.result.code, "PARAMETERS_OUTSIDE_PREREGISTERED_SEARCH_SPACE");
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM research_trials").get() as { n: number }).n, 0);
  const trial = await f.enqueue("research_register_trial", { experiment_id: experiment, phase: "train", parameters: f.samples.legacy_parameters });
  assert.equal(trial.job.status, "succeeded");
  const run = await f.enqueue("research_trial", { trial_id: trial.result.trial_id }); assert.equal(run.job.status, "succeeded");
  const report = JSON.parse((f.db.prepare("SELECT result_json FROM research_runs WHERE id=?").get(trial.result.research_run_id) as { result_json: string }).result_json) as ResearchReport;
  assert.equal(report.strategy.engine_version, "fixed-weight-cash-deployment-v1");
  assert.ok(report.strategy.events.every(row => !["sale_cash_settlement", "simulated_sell"].includes(row.type)));
  assert.equal(report.live_advice_eligible, false); assert.equal(f.snapshot(), before);
});

test("research experiment and trial scope cannot be moved to another actual portfolio via Web commands", async t => {
  const f = fixture(t), experiment = "scope-isolation";
  assert.equal((await f.enqueue("research_register", { experiment_id: experiment, plan: f.samples.plan, dataset: f.samples.dataset })).job.status, "succeeded");
  const trial = await f.enqueue("research_register_trial", { experiment_id: experiment, phase: "train", parameters: f.samples.parameters });
  const other = createPortfolio(f.db, actor, "Synthetic other scope"), before = f.snapshot();
  const count = (f.db.prepare("SELECT COUNT(*) n FROM command_requests").get() as { n: number }).n;
  for (const [type, payload] of [["research_register_trial", { experiment_id: experiment, phase: "train", parameters: f.samples.parameters }],
    ["research_trial", { trial_id: trial.result.trial_id }]] as const) {
    const response = await f.handler.POST(f.request(f.envelope(type, payload, { portfolio_id: other, expected_revision: 0 })));
    assert.equal(response.status, 403); assert.equal((await response.json()).error, "RESEARCH_OUT_OF_SCOPE");
  }
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM command_requests").get() as { n: number }).n, count); assert.equal(f.snapshot(), before);
});

test("oversized Web body, stale ledger and restore freeze reject rotation registration without side effects", async t => {
  const f = fixture(t), before = f.snapshot(), payload = { experiment_id: "bounds", plan: f.samples.plan, dataset: f.samples.dataset };
  const oversized = await f.handler.POST(f.request(f.envelope("research_register", payload), { "Content-Length": String(5 * 1024 * 1024 + 1) }));
  assert.equal(oversized.status, 413);
  assert.equal((await f.handler.POST(f.request(f.envelope("research_register", payload, { expected_revision: 99 })))).status, 409);
  writeFileSync(path.join(f.dir, "RESTORE_PENDING_REVIEW"), "Synthetic test freeze\n", { mode: 0o600 });
  assert.equal((await f.handler.POST(f.request(f.envelope("research_register", payload)))).status, 423);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM command_requests").get() as { n: number }).n, 0); assert.equal(f.snapshot(), before);
});
