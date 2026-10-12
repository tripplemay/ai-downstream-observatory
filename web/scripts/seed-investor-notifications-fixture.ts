import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hash } from "../src/server/ledger/service";
import { openWorkbench } from "../src/server/workbench-db";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";

const [filename, mode] = process.argv.slice(2);
assert.ok(filename && ["seed", "summary"].includes(mode), "SYNTHETIC_NOTIFICATION_MODE_REQUIRED");
const target = realpathSync(filename), temporary = realpathSync(os.tmpdir());
assert.ok(path.dirname(path.dirname(target)) === temporary
  && /^etf-browser-fixture-[A-Za-z0-9]+$/.test(path.basename(path.dirname(target)))
  && path.basename(target) === "workbench.db", "ONLY_TEMPORARY_BROWSER_FIXTURE_ALLOWED");
const db = openWorkbench(target), actor = { id: "owner" };
const finance = ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"];
const protectedTables = [...finance, "investor_workspaces", "investor_profiles", "investor_reference_plans", "investor_plan_selections",
  "investor_models", "investor_model_controls", "investor_observations", "investor_decisions", "investor_monitor_evidence_inputs",
  "investor_model_checkpoints", "investor_evidence_model_checkpoints", "investor_evidence_checkpoint_payloads",
  "investor_evidence_monitor_runs", "investor_evidence_run_payloads", "job_runs", "outbox", "investor_ai_requests"];
function helper(mode: "research" | "monitor") {
  const result = JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3",
    ["-m", "tests.investor.browser_notifications_fixture", "--db", target, "--mode", mode],
    { cwd: path.resolve(".."), env: { PATH: process.env.PATH, TMPDIR: temporary, NODE_ENV: "test" }, timeout: 90000, maxBuffer: 1048576,
      stdio: ["ignore", "pipe", "pipe"] }).toString());
  assert.equal(result.real_provider_called, false);
}
try {
  for (const table of finance) assert.equal((db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
  if (mode === "seed") {
    assert.equal(getInvestorState(db, actor).workspace_id, null, "EMPTY_BROWSER_WORKSPACE_REQUIRED");
    executeInvestorCommand(db, actor, { action: "save_profile", expected_revision: 0, idempotency_key: "fictional-browser-notifications-profile",
      profile: { schema_version: "investor-profile-v1", horizon_years: 7, loss_tolerance: "0.30", liquidity_need: "none_in_horizon",
        markets: ["CN"], product_scope: "unleveraged_long_only_etfs", research_direction: "system_design",
        exclusions: [], illustrative_budget_cny: null, planned_annual_contribution_cny: null } }, "2026-01-02T12:00:00.000Z");
    helper("research");
    const state = getInvestorState(db, actor, "2026-01-02T12:00:04.000Z");
    assert.ok(state.plan);
    executeInvestorCommand(db, actor, { action: "save_plan", plan_id: state.plan.id, expected_revision: state.revision,
      idempotency_key: "fictional-browser-notifications-save" }, "2026-01-02T12:00:04.000Z");
    helper("monitor");
  }
  const publications = db.prepare("SELECT id,observation_id,created_at,status FROM investor_evidence_monitor_runs ORDER BY created_at DESC,id DESC").all();
  assert.equal(publications.length, 2);
  const reads = db.prepare("SELECT object_id,payload_json,created_at FROM audit_events WHERE action='investor_notification_read' ORDER BY object_id").all();
  const counts = Object.fromEntries(finance.map(table => [table, (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n]));
  console.log(JSON.stringify({ synthetic_fixture_only: true, mode, publications, reads, financial_counts: counts,
    protected_state_hash: hash(Object.fromEntries(protectedTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))) }));
} finally { db.close(); }
