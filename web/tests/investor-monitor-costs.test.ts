import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { monitorCostValuesSchema, monitorCostsIntentSchema } from "../src/server/investor/monitor-cost-schemas";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { replayInvestorMonitorData } from "../src/server/investor/monitor-source";
import { InvestorMonitorCostPanel } from "../src/components/workbench/investor-monitor-cost-panel";

type Obj = Record<string, unknown>;
const binding = "a".repeat(64), at = "2026-01-02T12:05:04.000Z";
const values = { commission_bps: "1", minimum_fee_cny: "1", fx_bps: "2", slippage_bps: "3", maximum_cost_fraction: "0.01" };
function python(f: ReturnType<typeof investorFixture>, module: string, args: string[]) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args], {
    cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 262144, stdio: ["ignore", "pipe", "pipe"],
  }));
}
function fixedRows(f: ReturnType<typeof investorFixture>) {
  return ["investor_profiles","investor_reference_plans","investor_models","investor_model_controls","investor_plan_selections",
    "investor_research_requests","investor_research_runs","investor_experiments","investor_trial_intents","investor_trial_results","research_trials",
    "portfolios","accounts","ledger_events","postings","position_movements","approval_events","activations","reservations","execution_reports"]
    .map(name => ({ name, rows: f.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() }));
}
test("cost fields reject omitted, floating, hidden-grant and invalid-rate values; no default or trade authority", () => {
  assert.ok(monitorCostValuesSchema.safeParse(values).success);
  for (const change of [{ fx_bps: "" }, { fx_bps: "1e3" }, { fx_bps: 1 }, { fx_bps: "10000" }, { minimum_fee_cny: "-1" }, { minimum_fee_cny: "-0" },
    { maximum_cost_fraction: "1.000000000000000001" }, { tax_certified: true }, { assumption_hash: "b".repeat(64) }])
    assert.equal(monitorCostValuesSchema.safeParse({ ...values, ...change }).success, false);
  assert.equal(monitorCostsIntentSchema.safeParse({ action: "set_monitor_costs", model_id: "fictional", model_hash: binding,
    expected_cost_version: 0, costs: values, validity_days: 30, acknowledged_research_only: false }).success, false);
});

test("explicit owner costs cross normal command/core and independent replay; expiry and replacement never rewrite models or ancestors", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
    python(f, "tests.investor.managed_fx_monitor_fixture", ["--stage", "history"]);
    python(f, "tests.investor.queue_fixture", ["--mode", "core"]);
    const first = getInvestorState(f.db, actor, "2026-01-02T12:00:04.000Z"); assert.ok(first.plan);
    executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: first.plan.id, expected_revision: first.revision, idempotency_key: "fictional-cost-model" }, "2026-01-02T12:00:04.000Z");
    python(f, "tests.investor.managed_fx_monitor_fixture", ["--stage", "seed"]);
    const before = getInvestorState(f.db, actor, at), stable = fixedRows(f); assert.ok(before.monitor_costs?.editable);
    assert.equal(before.monitor_costs.status, "unknown"); assert.equal(before.effective_outcome, "insufficient_evidence");
    const command = { action: "set_monitor_costs", expected_revision: before.revision, idempotency_key: "fictional-explicit-costs",
      model_id: before.model_watch!.id, model_hash: before.monitor_costs.model_hash, expected_cost_version: 0,
      costs: values, validity_days: 1, acknowledged_research_only: true };
    for (const changed of [{ ...command, model_hash: "0".repeat(64) }, { ...command, validity_days: null }])
      assert.throws(() => executeInvestorCommand(f.db, actor, changed, at));
    assert.throws(() => executeInvestorCommand(f.db, { id: "foreign-owner" }, { ...command, expected_revision: 0 }, at));
    const receipt = executeInvestorCommand(f.db, actor, command, at);
    assert.deepEqual(executeInvestorCommand(f.db, actor, command, at), receipt);
    assert.throws(() => executeInvestorCommand(f.db, actor, { ...command, costs: { ...values, fx_bps: "4" } }, at), /DUPLICATE_CONFLICT/);
    const pending = getInvestorState(f.db, actor, at);
    assert.equal(pending.monitor_costs?.status, "pending"); assert.equal(pending.model_watch?.model_nav_cny, null);
    assert.equal(pending.effective_outcome, "insufficient_evidence"); assert.deepEqual(parseInvestorState({ ...pending, session_binding: binding }, binding), pending);
    const appliedAt = "2026-01-02T12:05:04.001Z";
    python(f, "tests.investor.queue_fixture", ["--mode", "core", "--now", appliedAt]);
    const known = getInvestorState(f.db, actor, appliedAt);
    assert.equal(known.monitor_costs?.status, "known"); assert.ok(["observe", "decision_required"].includes(known.effective_outcome));
    assert.notEqual(known.model_watch?.model_nav_cny, null); assert.deepEqual(parseInvestorState({ ...known, session_binding: binding }, binding), known);
    const source = f.db.prepare("SELECT * FROM investor_monitor_evidence_inputs ORDER BY created_at DESC,rowid DESC LIMIT 1").get() as Obj;
    const document = JSON.parse(source.document_json as string), model = f.db.prepare("SELECT document_json FROM investor_models").get() as Obj;
    assert.equal(document.schema_version, "investor-monitor-data-input-v4"); assert.ok(document.settings.cost_assumptions);
    assert.ok((source.valid_until as string) > known.monitor_costs!.valid_until!);
    const checkpoint = f.db.prepare("SELECT * FROM investor_evidence_model_checkpoints").get() as Obj;
    assert.ok((checkpoint.valid_until as string) > known.monitor_costs!.valid_until!);
    const nextAt = "2026-01-02T12:05:05.000Z";
    executeInvestorCommand(f.db, actor, { ...command, expected_revision: known.revision, idempotency_key: "fictional-cost-replacement", expected_cost_version: 1,
      costs: { ...values, fx_bps: "4" }, validity_days: 7 }, nextAt);
    python(f, "tests.investor.queue_fixture", ["--mode", "core", "--now", "2026-01-02T12:05:05.001Z"]);
    const replacement = getInvestorState(f.db, actor, "2026-01-02T12:05:05.001Z");
    assert.equal(replacement.monitor_costs?.status, "known"); assert.equal(replacement.monitor_costs.version, 2);
    const expiry = known.monitor_costs!.valid_until!;
    const oldReplay = replayInvestorMonitorData(f.db, known.workspace_id!, JSON.parse(model.document_json as string), known.plan!.document.targets, document, expiry, appliedAt);
    assert.equal(oldReplay.unavailable_reason, null); assert.equal((oldReplay.projection?.policy.costs as Obj).fx_bps, "2");
    assert.deepEqual(fixedRows(f), stable);
    assert.deepEqual(f.db.prepare("SELECT * FROM investor_evidence_model_checkpoints WHERE id=?").get(checkpoint.id), checkpoint);
    for (const sql of ["UPDATE investor_monitor_cost_assumptions SET version=version+1", "DELETE FROM investor_monitor_cost_assumptions",
      "INSERT OR REPLACE INTO investor_monitor_cost_assumptions SELECT * FROM investor_monitor_cost_assumptions"])
      assert.throws(() => f.db.exec(sql));
    const clearAt = "2026-01-02T12:05:06.000Z";
    const clear = { ...command, expected_revision: replacement.revision, idempotency_key: "fictional-clear-costs", expected_cost_version: 2,
      costs: null, validity_days: null };
    const marker = path.join(f.directory, "RESTORE_PENDING_REVIEW"); writeFileSync(marker, "FICTIONAL RESTORE\n");
    assert.throws(() => executeInvestorCommand(f.db, actor, clear, clearAt), /READ_ONLY/); unlinkSync(marker);
    executeInvestorCommand(f.db, actor, clear, clearAt);
    python(f, "tests.investor.queue_fixture", ["--mode", "core", "--now", "2026-01-02T12:05:06.001Z"]);
    const unknown = getInvestorState(f.db, actor, "2026-01-02T12:05:06.001Z");
    assert.equal(unknown.monitor_costs?.status, "unknown"); assert.equal(unknown.monitor_costs.version, 3);
    assert.equal(unknown.effective_outcome, "insufficient_evidence"); assert.equal(unknown.model_watch?.model_nav_cny, null);
    assert.deepEqual(fixedRows(f), stable); assert.deepEqual(parseInvestorState({ ...unknown, session_binding: binding }, binding), unknown);
    const html = renderToStaticMarkup(createElement(InvestorMonitorCostPanel, { state: unknown.monitor_costs, disabled: false,
      nowMs: Date.parse(clearAt), onCommand() {}, onEditingChange() {} }));
    assert.match(html, /研究监测费用假设/); assert.match(html, /不是券商费率认证/); assert.doesNotMatch(html, /value="0"/);
    f.db.exec("DROP TRIGGER investor_monitor_cost_update");
    f.db.prepare("UPDATE investor_monitor_cost_assumptions SET content_hash=? WHERE version=3").run("0".repeat(64));
    const bad = getInvestorState(f.db, actor, "2026-01-02T12:05:06.002Z");
    assert.equal(bad.effective_outcome, "insufficient_evidence"); assert.equal(bad.model_watch?.model_nav_cny, null);
    assert.throws(() => executeInvestorCommand(f.db, actor, { ...clear, expected_revision: bad.revision, idempotency_key: "do-not-cover-corruption", expected_cost_version: 3 }, "2026-01-02T12:05:07.000Z"));
    assert.deepEqual(fixedRows(f), stable);
  } finally { f.close(); }
});
