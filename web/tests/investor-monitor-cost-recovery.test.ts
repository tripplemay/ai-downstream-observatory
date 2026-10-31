import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type Database from "better-sqlite3";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { openWorkbench } from "../src/server/workbench-db";
import { readInvestorMonitorEvidenceSource } from "../src/server/investor/monitor-source";
import { parseInvestorState } from "../src/components/workbench/investor-client";

type Obj = Record<string, unknown>;
const at = "2026-01-02T12:05:04.000Z", appliedAt = "2026-01-02T12:05:04.001Z";
function python(filename: string, module: string, args: string[]) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", filename, ...args], {
    cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 262144, stdio: ["ignore", "pipe", "pipe"],
  }));
}
function snapshot(db: Database.Database) {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map(row => row.name);
  return names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM "${name}" ORDER BY rowid`).all() }));
}

test("populated cost receipts, v3 evidence and checkpoints survive one encrypted temporary restore with independent read-only replay", async () => {
  const { backupWorkbench } = await import("../../scripts/backup-workbench.mjs");
  const { restoreWorkbench } = await import("../../scripts/restore-workbench.mjs");
  const f = investorFixture();
  try {
    saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
    python(f.filename, "tests.investor.managed_fx_monitor_fixture", ["--stage", "history", "--fixed-policy-v2"]);
    python(f.filename, "tests.investor.queue_fixture", ["--mode", "core"]);
    const first = getInvestorState(f.db, actor, "2026-01-02T12:00:04.000Z"); assert.ok(first.plan);
    executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: first.plan.id, expected_revision: first.revision,
      idempotency_key: "fictional-recovery-model" }, "2026-01-02T12:00:04.000Z");
    python(f.filename, "tests.investor.managed_fx_monitor_fixture", ["--stage", "seed"]);
    const initial = getInvestorState(f.db, actor, at); assert.ok(initial.monitor_costs);
    executeInvestorCommand(f.db, actor, { action: "set_monitor_costs", model_id: initial.model_watch!.id,
      model_hash: initial.monitor_costs.model_hash, expected_cost_version: 0, expected_revision: initial.revision,
      idempotency_key: "fictional-recovery-costs", costs: { commission_bps: "1", minimum_fee_cny: "1", fx_bps: "2", slippage_bps: "3", maximum_cost_fraction: "0.01" },
      validity_days: 7, acknowledged_research_only: true }, at);
    python(f.filename, "tests.investor.queue_fixture", ["--mode", "core", "--now", appliedAt]);
    const known = getInvestorState(f.db, actor, appliedAt); assert.equal(known.monitor_costs?.status, "known");
    const input = f.db.prepare("SELECT * FROM investor_monitor_evidence_inputs ORDER BY created_at DESC,rowid DESC LIMIT 1").get() as Obj;
    assert.equal(JSON.parse(input.document_json as string).schema_version, "investor-monitor-data-input-v3");
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_monitor_cost_assumptions").get() as { n: number }).n, 1);
    assert.ok((f.db.prepare("SELECT count(*) n FROM investor_evidence_model_checkpoints").get() as { n: number }).n > 0);
    const original = readInvestorMonitorEvidenceSource(f.db, known.workspace_id!, known.model_watch!.id, input.id as string, appliedAt);
    assert.equal(original.unavailable_reason, null);
    const before = snapshot(f.db), outputDir = path.join(f.directory, "backups"), passphrase = "fictional-cost-recovery-test-only-passphrase";
    const archive = await backupWorkbench({ dbPath: f.filename, dataDir: f.directory, outputDir, passphrase,
      appRef: "offline-monitor-cost-fixture", replicaDir: undefined, now: () => appliedAt });
    assert.equal(readdirSync(outputDir).filter(name => name.endsWith(".etfbackup")).length, 1);
    const restored = await restoreWorkbench({ archivePath: archive.path, targetDir: path.join(f.directory, "restored"), passphrase, incidentAt: undefined });
    assert.equal(restored.pending_review, true); assert.ok(existsSync(path.join(f.directory, "restored", "RESTORE_PENDING_REVIEW")));
    const db = openWorkbench(restored.database_path);
    try {
      assert.equal(db.readonly, true); assert.deepEqual(snapshot(db), before);
      const current = getInvestorState(db, actor, appliedAt);
      const costState = current.monitor_costs; assert.ok(costState);
      assert.equal(current.read_only, true); assert.equal(costState.status, "known");
      assert.equal(costState.editable, false); assert.deepEqual(costState.costs, known.monitor_costs.costs);
      assert.deepEqual(parseInvestorState({ ...current, session_binding: "a".repeat(64) }, "a".repeat(64)), current);
      const replay = readInvestorMonitorEvidenceSource(db, current.workspace_id!, current.model_watch!.id, input.id as string, appliedAt);
      assert.equal(replay.unavailable_reason, null); assert.deepEqual(replay.projection, original.projection);
      assert.throws(() => executeInvestorCommand(db, actor, { action: "set_monitor_costs", model_id: current.model_watch!.id,
        model_hash: costState.model_hash, expected_cost_version: 1, expected_revision: current.revision,
        idempotency_key: "fictional-restored-write-forbidden", costs: null, validity_days: null, acknowledged_research_only: true }, appliedAt), /WORKBENCH_READ_ONLY/);
      assert.deepEqual(db.pragma("foreign_key_check"), []); assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      const child = JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c", `
import json,socket,sys
from worker.orchestration.db import open_database,WorkbenchError
from worker.orchestration.runtime import run_pending_once
from worker.investor.monitor_costs import policy_at
from worker.investor.monitor_data import resolve_monitor_data
from worker.investor.evidence_monitor_runtime import resolve_checkpoint
def forbidden(*a,**k):raise AssertionError('OFFLINE_FIXTURE_NETWORK_FORBIDDEN')
socket.create_connection=forbidden
socket.getaddrinfo=forbidden
db=open_database(sys.argv[1]); at=sys.argv[2]
model=db.execute('SELECT * FROM investor_models').fetchone(); definition=json.loads(model['document_json'])
source=db.execute('SELECT * FROM investor_monitor_evidence_inputs ORDER BY created_at DESC,rowid DESC LIMIT 1').fetchone()
selected=policy_at(db,model['workspace_id'],definition,at)
assert selected['document']['version']==1
value=resolve_monitor_data(db,model['workspace_id'],definition,json.loads(source['document_json']),now=at)
assert value['unavailable_reason'] is None
for checkpoint in db.execute('SELECT id FROM investor_evidence_model_checkpoints'):
 resolve_checkpoint(db,model['workspace_id'],definition,checkpoint['id'],at)
for role in ('core','longport','verifier'):
 try:run_pending_once(db,'fictional-restored-'+role,role=role,clock=lambda:at)
 except WorkbenchError as e:assert str(e)=='RESTORE_PENDING_REVIEW'
 else:raise AssertionError('restored runtime permitted work')
print(json.dumps({'costs':selected['costs'],'projection':value['projection'],'real_provider_called':False}))
db.close()
`, restored.database_path, appliedAt], { cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 262144,
        env: { PATH: process.env.PATH, NODE_ENV: "test", NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"] }));
      assert.equal(child.real_provider_called, false); assert.deepEqual(child.costs, known.monitor_costs.costs);
      assert.deepEqual(child.projection, original.projection); assert.deepEqual(snapshot(db), before);
      for (const name of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
        assert.equal((db.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n, 0);
    } finally { db.close(); }
    assert.deepEqual(snapshot(f.db), before);
  } finally { f.close(); }
});
