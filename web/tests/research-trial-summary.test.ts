import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createPortfolio, hash } from "../src/server/ledger/service";
import { getResearchState } from "../src/server/research-queries";
import { researchTrialSummary } from "../src/components/workbench/research-trial-summary";

const actor = { id: "SYNTHETIC-RESEARCH-SUMMARY" };
const strategy = {
  engine_version: "monthly-rotation-rebalance-v1", initial_equity_cny: "9007199254740993.01", contributions_cny: "0.02",
  ending_nav_cny: "9007199254740990.02", profit_cny: "-3.01", fees_cny: "0.2", fx_fees_cny: "0", slippage_cny: "0.01", cash_rounding_cny: "-0.001",
  buy_turnover_on_mean_observed_nav: "0.5", sell_turnover_on_mean_observed_nav: "0.25", total_turnover_on_mean_observed_nav: "0.75",
  ending_cash_ratio: "0.125", execution_failure_count: 2, monthly_evaluation_counts: { proposed: 1, unchanged: 0, blocked: 2 },
  twr: "-0.01", max_drawdown: "-0.015",
};
function fixture(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "etf-research-summary-")), filename = path.join(directory, "workbench.db");
  migrateWorkbench(filename); const db = openWorkbench(filename);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const portfolio = createPortfolio(db, actor, "Synthetic summary"), other = createPortfolio(db, actor, "Synthetic other");
  let number = 0;
  const insert = (options: { version?: string; parameters?: unknown; result?: unknown; status?: string; scope?: string } = {}) => {
    const id = `synthetic-${String(++number).padStart(4, "0")}`, scope = options.scope ?? portfolio;
    const plan = { schema_version: options.version ?? "research-plan-v2", hypothesis: "Synthetic presentation only", trial_budgets: { train: 1 } };
    const parameters = JSON.stringify(options.parameters ?? { schema_version: "research-rotation-parameters-v1", universe: ["synthetic:listing"] });
    db.prepare("INSERT INTO research_experiments(id,portfolio_id,plan_json,plan_hash,dataset_manifest_json,dataset_hash,created_by,created_at) VALUES(?,?,?,?,?,?,?,'2025-01-01T00:00:00Z')")
      .run(id, scope, JSON.stringify(plan), hash(plan), JSON.stringify({ dataset: { mode: "synthetic" } }), hash({ synthetic: true }), actor.id);
    db.prepare("INSERT INTO research_runs(id,portfolio_id,environment,input_manifest,experiment_plan_json,status,result_json,created_at) VALUES(?,?,'research','{}',?,?,?,'2025-01-01T00:00:00Z')")
      .run(id, scope, JSON.stringify(plan), options.status ?? "succeeded", options.result === undefined ? null : JSON.stringify(options.result));
    db.prepare("INSERT INTO research_trials(id,experiment_id,run_id,trial_number,phase,parameters_json,parameters_hash,idempotency_key,created_at) VALUES(?,?,?,1,'train',?,?,?,'2025-01-01T00:00:00Z')")
      .run(id, id, id, parameters, hash(JSON.parse(parameters)), id);
    return id;
  };
  return { db, filename, portfolio, other, insert, state: () => getResearchState(db, actor, portfolio) };
}

test("research query returns exact original parameters and bounded scalars, never result curves or event payloads", t => {
  const f = fixture(t), parameters = { schema_version: "research-rotation-parameters-v1", target_fraction: "0.123456789012345678", universe: ["synthetic:listing"] };
  const bulk = Array.from({ length: 2000 }, () => ({ private_simulation_detail: "SYNTHETIC-NOT-FOR-LIST".repeat(30) }));
  f.insert({ parameters, result: { strategy: { ...strategy, curve: bulk, events: bulk }, benchmark: { twr: "0.02", curve: bulk }, data_mode: "synthetic", result_hash: "f".repeat(64) } });
  const [trial] = f.state().trials;
  assert.deepEqual(JSON.parse(trial.parameters_json), parameters); assert.equal(trial.parameters_json, JSON.stringify(parameters));
  for (const [key, value] of Object.entries(strategy)) assert.deepEqual(trial[key as keyof typeof trial], value, key);
  assert.equal(trial.plan_schema_version, "research-plan-v2"); assert.equal(trial.benchmark_twr, "0.02");
  assert.ok(Buffer.byteLength(JSON.stringify(trial)) < 4000);
  for (const forbidden of ["curve", "events", "result_json", "SYNTHETIC-NOT-FOR-LIST"]) assert.equal(JSON.stringify(trial).includes(forbidden), false);
});

test("legacy and queued trials retain unavailable new metrics without inventing zero or a rotation version", t => {
  const f = fixture(t);
  f.insert({ version: "research-plan-v1", parameters: { weights: { "synthetic:listing": "1" }, deployment_fraction: "1", allocation: "fixed_split" }, status: "queued" });
  const [trial] = f.state().trials;
  for (const key of ["engine_version", "initial_equity_cny", "contributions_cny", "ending_nav_cny", "profit_cny", "fees_cny", "fx_fees_cny", "slippage_cny", "cash_rounding_cny",
    "buy_turnover_on_mean_observed_nav", "sell_turnover_on_mean_observed_nav", "total_turnover_on_mean_observed_nav", "ending_cash_ratio", "execution_failure_count", "monthly_evaluation_counts"] as const) assert.equal(trial[key], null, key);
  const summary = researchTrialSummary(trial);
  assert.match(summary.method, /v1.*不卖出再平衡/); assert.doesNotMatch(summary.method, /v2|排名轮动/);
  assert.ok(summary.metrics.every(row => row.value === "未提供 / 不可用")); assert.match(summary.monthly, /不视为零次阻断/);
});

test("read-only presentation distinguishes rotation, fixed rebalance and unknown parameter versions", t => {
  const f = fixture(t); f.insert({ result: { strategy } }); const [trial] = f.state().trials;
  assert.match(researchTrialSummary(trial).method, /v2.*排名轮动/);
  assert.match(researchTrialSummary({ ...trial, parameters_json: JSON.stringify({ schema_version: "research-fixed-rebalance-parameters-v1" }) }).method, /v2.*固定权重再平衡/);
  for (const parameters_json of ["null", "not-json", "{}", JSON.stringify({ schema_version: "future-unverified-version" })])
    assert.equal(researchTrialSummary({ ...trial, parameters_json }).method, "研究方法版本未核实");
  assert.equal(researchTrialSummary({ ...trial, plan_schema_version: "research-plan-v1" }).method, "研究方法版本未核实");
});

test("summary preserves high precision money, negative profit and explicit zero costs, and exposes blocked and execution failures", t => {
  const f = fixture(t); f.insert({ result: { strategy } }); const summary = researchTrialSummary(f.state().trials[0]);
  const values = Object.fromEntries(summary.metrics.map(row => [row.label, row.value]));
  assert.equal(values["研究初始资金"], "9007199254740993.01 CNY"); assert.equal(values["研究净利润"], "-3.01 CNY");
  assert.equal(values["研究换汇费用"], "0 CNY"); assert.equal(values["总换手率"], "75.00%"); assert.equal(values["期末现金比例"], "12.50%");
  assert.equal(values["现金舍入成本（负值为益）"], "-0.001 CNY");
  assert.equal(values["执行跳过 / 过期次数"], "2"); assert.match(summary.monthly, /提出计划 1 \/ 无需动作 0 \/ 阻断 2/);
});

test("invalid monthly counts are unavailable and failed research jobs expose diagnostic codes without fabricated metrics", t => {
  const f = fixture(t);
  f.insert({ status: "failed", result: { error: "WorkbenchError", code: "SYNTHETIC_MISSING_DATA" } });
  for (const monthly_evaluation_counts of [{ proposed: 1, unchanged: 0, blocked: -1 }, { proposed: 1, unchanged: 0 }, { proposed: 1, unchanged: 0, blocked: 0, pass: true }])
    f.insert({ result: { strategy: { monthly_evaluation_counts } } });
  const state = f.state(); assert.ok(state.trials.every(row => row.monthly_evaluation_counts === null));
  const failed = state.trials.find(row => row.status === "failed")!;
  assert.equal(failed.error_code, "SYNTHETIC_MISSING_DATA"); assert.equal(failed.error, "WorkbenchError"); assert.equal(failed.profit_cny, null);
});

test("summary queries stay portfolio-scoped and limited to 100 records, including on a physically read-only connection", t => {
  const f = fixture(t); for (let index = 0; index < 102; index++) f.insert(); f.insert({ scope: f.other });
  const before = f.db.prepare("SELECT total_changes() n").get();
  const state = f.state(); assert.equal(state.trials.length, 100); assert.equal(state.experiments.length, 100);
  assert.deepEqual(f.state().trials.map(row => row.id), state.trials.map(row => row.id));
  assert.equal(getResearchState(f.db, actor, f.other).trials.length, 1); assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  const readonly = new Database(f.filename, { readonly: true });
  try { const result = getResearchState(readonly, actor, f.portfolio); assert.equal(result.read_only, true); assert.deepEqual(result.trials, state.trials); }
  finally { readonly.close(); }
});
