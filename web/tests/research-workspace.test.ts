import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createPortfolio } from "../src/server/ledger/service";
import { enqueueWorkbenchTask } from "../src/server/workbench-commands";
import { getResearchState } from "../src/server/research-queries";

const actor = { id: "synthetic-owner" };
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "etf-research-web-"));
  const filename = path.join(directory, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename);
  const portfolio = createPortfolio(db, actor, "Synthetic research"), other = createPortfolio(db, actor, "Other");
  db.prepare("INSERT INTO research_experiments(id,portfolio_id,plan_json,plan_hash,dataset_manifest_json,dataset_hash,created_by,created_at) VALUES('experiment',?,?,?,?,?,'test','2026-01-01T00:00:00Z')")
    .run(portfolio, JSON.stringify({ hypothesis: "Synthetic scope fixture", trial_budgets: { train: 1, validation: 1, holdout: 1 } }), "fixture-plan", JSON.stringify({ dataset: { mode: "synthetic" } }), "fixture-data");
  db.prepare("INSERT INTO research_runs(id,portfolio_id,environment,input_manifest,experiment_plan_json,status,created_at) VALUES('run',?,'research','{}','{}','queued','2026-01-01T00:00:00Z')").run(portfolio);
  db.prepare("INSERT INTO research_trials(id,experiment_id,run_id,trial_number,phase,parameters_json,parameters_hash,idempotency_key,created_at) VALUES('trial','experiment','run',1,'train','{}','fixture-parameters','fixture-trial','2026-01-01T00:00:00Z')").run();
  return { db, directory, portfolio, other, close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("research requests retain authenticated context and never accept prepared results or a forged actor", () => {
  const f = fixture();
  try {
    const command = { portfolio_id: f.portfolio, expected_revision: 0, idempotency_key: "web-trial", command_type: "research_trial", payload: { trial_id: "trial" } };
    const first = enqueueWorkbenchTask(f.db, actor, command);
    assert.equal(first.status, "queued");
    assert.deepEqual(enqueueWorkbenchTask(f.db, actor, command), first);
    const row = f.db.prepare("SELECT actor_id,payload_json FROM command_requests WHERE id=?").get(first.request_id) as { actor_id: string; payload_json: string };
    assert.equal(row.actor_id, actor.id); assert.deepEqual(JSON.parse(row.payload_json), { trial_id: "trial" });
    for (const extra of [{ actor: "human" }, { actor_id: "owner" }, { portfolio_id: f.portfolio }, { prepared: {} }, { result: { status: "PASS" } }]) {
      assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...command, payload: { ...command.payload, ...extra } }), /INVALID_RESEARCH_COMMAND/);
    }
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM ledger_events").get() as { n: number }).n, 0);
  } finally { f.close(); }
});

test("research references and read summaries stay in the selected portfolio", () => {
  const f = fixture();
  try {
    const base = { portfolio_id: f.other, expected_revision: 0, idempotency_key: "scope" };
    for (const command of [
      { command_type: "research_trial", payload: { trial_id: "trial" } },
      { command_type: "research_ai_context", payload: { run_id: "run" } },
      { command_type: "research_unseal", payload: { experiment_id: "experiment", reason: "Not authorized across portfolios" } },
      { command_type: "research_freeze", payload: { experiment_id: "experiment", validation_trial_id: "trial", reason: "Not authorized across portfolios" } },
    ]) assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...base, ...command }), /RESEARCH_OUT_OF_SCOPE/);
    const state = getResearchState(f.db, actor, f.portfolio);
    assert.equal(state.live_advice_eligible, false); assert.equal(state.trials.length, 1);
    assert.equal(state.trials[0].twr, null); assert.equal(state.trials[0].status, "queued");
    assert.deepEqual(JSON.parse(state.experiments[0].trial_budgets_json!), { train: 1, validation: 1, holdout: 1 });
    assert.deepEqual(getResearchState(f.db, actor, f.other).trials, []);
    assert.deepEqual(getResearchState(f.db, actor, f.other).experiments, []);
    assert.throws(() => getResearchState(f.db, { id: "" }, f.portfolio), /UNAUTHENTICATED/);
    assert.throws(() => getResearchState(f.db, actor, "missing"), /PORTFOLIO_NOT_FOUND/);
  } finally { f.close(); }
});

test("research submissions obey stale revisions and restoration freeze", () => {
  const f = fixture();
  try {
    const command = { portfolio_id: f.portfolio, expected_revision: 1, idempotency_key: "frozen", command_type: "research_trial", payload: { trial_id: "trial" } };
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, command), /VERSION_CONFLICT/);
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "Synthetic lock\n");
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...command, expected_revision: 0 }), /WORKBENCH_READ_ONLY/);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM command_requests").get() as { n: number }).n, 0);
  } finally { f.close(); }
});
