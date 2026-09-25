import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkbenchMixedFixture, mixedActivationRequest, mixedApprovalRequest, mixedCancelRequest, mixedLedgerRequest,
  mixedMarketRequest, mixedProposalRequest, mixedValuationRequest } from "../scripts/workbench-mixed-fixture";
import { openWorkbench } from "../src/server/workbench-db";
import { enqueueWorkbenchTask } from "../src/server/workbench-commands";
import { executeGovernanceCommand } from "../src/server/governance-commands";
import { recordFact, revision } from "../src/server/ledger/service";

const actor = { id: "owner", kind: "human" as const };
const root = path.resolve("..");
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "etf-mixed-fixture-test-"));
  const input = { filename: path.join(directory, "workbench.db"), dataDir: path.join(directory, "data"), history: 30, listings: 10, marketRows: 50 };
  try { return { directory, input, value: createWorkbenchMixedFixture(input), close: () => rmSync(directory, { recursive: true, force: true }) }; }
  catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

test("mixed fixture is fresh, bounded, current and contains no measured successful state", () => {
  const f = fixture(), db = openWorkbench(f.value.filename);
  try {
    const value = f.value;
    assert.equal(value.counts.portfolios, 4); assert.equal(value.counts.accounts, 10); assert.equal(value.counts.listings, 10);
    assert.equal(value.counts.ledger_events, 30); assert.equal(value.counts.market_observations, 50);
    for (const table of ["market_publications", "valuation_runs", "activations", "proposals", "risk_runs", "approval_events", "reservations", "csv_background_results"]) assert.equal(value.counts[table], 0, table);
    assert.deepEqual(value.revisions, { csv: 25, ledger: 1, approval: 1, valuation: 3 });
    assert.equal(value.prerequisites.real_gate_verified, false); assert.equal(value.prerequisites.job_ids.length, 2);
    assert.deepEqual(db.prepare("SELECT job_type FROM job_runs ORDER BY id").all(), [{ job_type: "governance_verification" }, { job_type: "governance_verification" }]);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM market_observations WHERE provenance='reconstructed'").get() as { n: number }).n, 50);
    assert.deepEqual(db.prepare("SELECT event_type FROM ledger_events WHERE portfolio_id=? ORDER BY ledger_revision").all(value.ids.valuation.portfolio_id),
      [{ event_type: "opening_cash" }, { event_type: "buy" }, { event_type: "settlement" }]);
    assert.deepEqual(db.prepare("SELECT quantity,cost_amount,cost_known,currency FROM position_projections WHERE account_id=? AND listing_id=?")
      .all(value.ids.valuation.account_id, value.ids.valuation.listing_id), [{ quantity: "10", cost_amount: "100", cost_known: 1, currency: "USD" }]);
    assert.equal(value.expected.valuation_cost_usd, "100");
    assert.equal(value.expected.valuation_nav_cny, "37642.5");
    assert.throws(() => createWorkbenchMixedFixture(f.input), /FRESH_DATABASE_REQUIRED/);
    for (const patch of [{ history: 5 }, { history: 50001 }, { listings: 1 }, { listings: 1001 }, { marketRows: 2000001 }, { marketRows: -1 }]) {
      assert.throws(() => createWorkbenchMixedFixture({ ...f.input, filename: path.join(f.directory, "rejected.db"), ...patch }), /INVALID_SIZE/);
    }
    assert.throws(() => createWorkbenchMixedFixture({ ...f.input, filename: "relative.db" }), /TEMP_PATH_REQUIRED/);
    assert.throws(() => createWorkbenchMixedFixture({ ...f.input, now: "2026-01-01T00:00:00.000Z" }), /CURRENT_CLOCK_REQUIRED/);
  } finally { db.close(); f.close(); }
});

test("mixed templates keep market and valuation scopes separate from approval and small ledger CAS", () => {
  const f = fixture(), db = openWorkbench(f.value.filename);
  try {
    const value = f.value;
    for (const kind of ["approval", "valuation", "fx"] as const) {
      const request = mixedMarketRequest(value, kind, 0);
      assert.equal(request.command.command_type, "market_ingest");
      assert.equal(request.command.payload.document.batch.scope, value.scopes[kind]);
      const queued = enqueueWorkbenchTask(db, actor, request.command); assert.equal(queued.status, "queued");
      assert.deepEqual(enqueueWorkbenchTask(db, actor, request.command), queued);
    }
    for (const patch of [{ metric: "unknown" }, { unit: "shares" }, { price_basis: "unadjusted" }]) {
      const invalid = mixedMarketRequest(value, "approval", 1);
      Object.assign(invalid.command.payload.document.pages[0].observations[1], patch);
      assert.throws(() => enqueueWorkbenchTask(db, actor, invalid.command), /INVALID_MARKET_BATCH/);
    }
    const small = mixedLedgerRequest(value, 1, value.revisions.ledger);
    const first = recordFact(db, actor, small.command);
    assert.equal(first.revision, 2); assert.equal(recordFact(db, actor, small.command).duplicate, true);
    assert.equal(revision(db, value.ids.approval.portfolio_id), 1); assert.equal(revision(db, value.ids.valuation.portfolio_id), 3);
    assert.equal(revision(db, value.ids.csv.portfolio_id), 25);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM market_publications").get() as { n: number }).n, 0);
  } finally { db.close(); f.close(); }
});

test("normal enqueue and real core CLI publish market and USD valuation before normal governance approve and cancel", { timeout: 60000 }, () => {
  const f = fixture(), db = openWorkbench(f.value.filename);
  try {
    const value = f.value, python = process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3";
    const run = (command: ReturnType<typeof mixedMarketRequest>["command"] | ReturnType<typeof mixedValuationRequest>["command"]) => {
      const request = enqueueWorkbenchTask(db, actor, command);
      const child = spawnSync(python, ["-m", "worker.orchestration", "--db", value.filename, "--once", "--role", "core"], {
        cwd: root, env: { NODE_ENV: "test", PATH: process.env.PATH, TZ: "UTC", PYTHONDONTWRITEBYTECODE: "1", WORKBENCH_DB_PATH: value.filename, WORKBENCH_DATA_DIR: value.dataDir },
        encoding: "utf8", timeout: 15000, maxBuffer: 65536,
      });
      assert.equal(child.status, 0, child.stderr || child.stdout || String(child.error));
      const job = db.prepare("SELECT status,result_json,command_request_id FROM job_runs WHERE command_request_id=?").get(request.request_id) as { status: string; result_json: string };
      assert.equal(job.status, "succeeded"); return JSON.parse(job.result_json);
    };
    for (const kind of ["approval", "valuation", "fx"] as const) {
      const result = run(mixedMarketRequest(value, kind, 0).command); assert.equal(result.batch_status, "published");
      assert.equal((db.prepare("SELECT revision FROM market_publications WHERE scope=?").get(value.scopes[kind]) as { revision: number }).revision, 1);
    }
    const approvalValuation = run(mixedValuationRequest(value, "approval", 0).command);
    assert.equal(approvalValuation.quality, "complete"); assert.equal(approvalValuation.nav_cny, value.expected.approval_cash_cny);
    const valuation = run(mixedValuationRequest(value, "valuation", 0).command);
    assert.equal(valuation.quality, "complete"); assert.equal(valuation.nav_cny, value.expected.valuation_nav_cny);
    const options = { dataDir: value.dataDir, releaseHash: value.releaseHash };
    const execute = (request: ReturnType<typeof mixedActivationRequest>) => executeGovernanceCommand(db, actor, request.command, options) as Record<string, unknown>;
    const activation = execute(mixedActivationRequest(value, approvalValuation.valuation_id));
    const proposal = execute(mixedProposalRequest(value, String(activation.id), approvalValuation.valuation_id, 0)) as unknown as { id: string; risk: { id: string; status: string; input_hash: string } };
    assert.equal(proposal.risk.status, "pass", JSON.stringify(proposal));
    const approvalRequest = mixedApprovalRequest(value, proposal, 0);
    assert.throws(() => executeGovernanceCommand(db, { id: "synthetic-ai", kind: "ai" }, approvalRequest.command, options), /GOVERNANCE_PERMISSION_DENIED/);
    assert.throws(() => executeGovernanceCommand(db, actor, approvalRequest.command, { ...options, releaseHash: "0".repeat(64) }), /RISK_BLOCKED:VERIFICATION_VERSION_MISMATCH/);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM reservations").get() as { n: number }).n, 0);
    const approved = execute(mixedApprovalRequest(value, proposal, 0)); assert.equal(approved.status, "approved_pending_manual_execution"); assert.equal(approved.broker_order_sent, false);
    assert.deepEqual(db.prepare("SELECT amount,quantity,status FROM reservations").all(), [{ amount: "10000", quantity: "100", status: "active" }]);
    execute(mixedCancelRequest(value, proposal.id, 0));
    assert.equal((db.prepare("SELECT COUNT(*) n FROM reservations WHERE status='active'").get() as { n: number }).n, 0);
    assert.equal(revision(db, value.ids.approval.portfolio_id), 1);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM ledger_events").get() as { n: number }).n, value.expected.seed_facts);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM approval_events").get() as { n: number }).n, 2);
  } finally { db.close(); f.close(); }
});
