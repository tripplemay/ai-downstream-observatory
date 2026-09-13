import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAccount, recordFact, revision } from "../src/server/ledger/service";
import { activatePolicy, approveProposal, cancelRemainder, createPolicyVersion, createStrategyVersion, expireProposal, getGovernanceState, prepareExecution, recordExecutionFact, recordExecutionReport, runRiskCheck } from "../src/server/governance/service";
import { governanceFixture, human, now } from "./governance-fixture";
import { registerCompletedVerification } from "../src/server/governance/verification";
import { isGovernanceClientError } from "../src/server/governance/errors";

test("E17 policy/strategy candidates require explicit semantic thresholds and human creation", () => {
  const f = governanceFixture(undefined, "0", "100000", false);
  try {
    assert.equal(getGovernanceState(f.db, { id: "synthetic-ai", kind: "ai" }, f.portfolio).activations.length, 0);
    assert.throws(() => createPolicyVersion(f.db, { id: "synthetic-ai", kind: "ai" }, { ...f.envelope(), policy: f.policy }, f.options), /GOVERNANCE_PERMISSION_DENIED/);
    assert.throws(() => createStrategyVersion(f.db, { id: "synthetic-strategy", kind: "strategy" }, { ...f.envelope(), strategy: f.strategy }, f.options), /GOVERNANCE_PERMISSION_DENIED/);
    const incomplete = { ...f.policy, limits: { ...f.policy.limits, listing_weight: undefined } };
    assert.throws(() => createPolicyVersion(f.db, human, { ...f.envelope(), policy: incomplete }, f.options));
    assert.throws(() => createPolicyVersion(f.db, human, { ...f.envelope(), policy: { ...f.policy, allocation: { core: "0.8", strategy: "0.8", defensive: "0" } } }, f.options));
    assert.throws(() => createStrategyVersion(f.db, human, { ...f.envelope(), strategy: { ...f.strategy, admission_thresholds: { ...f.strategy.admission_thresholds, min_trades: 0 } } }, f.options));
    assert.equal(revision(f.db, f.portfolio), 1);
    assert.equal(getGovernanceState(f.db, human, f.portfolio).broker_ordering_enabled, false);
  } finally { f.close(); }
});

test("G01/G03/G04 evidence must be complete, version-bound, current and non-synthetic", () => {
  const f = governanceFixture(undefined, "0", "100000", false);
  try {
    const input = f.activationCommand();
    const missing = f.gateDocument("G-03"); missing.checks.pop();
    assert.throws(() => activatePolicy(f.db, human, { ...input, gate_attachments: { ...input.gate_attachments, "G-03": f.attach(missing) } }, f.options), /GATE_CHECKS_INCOMPLETE/);
    assert.throws(() => activatePolicy(f.db, human, { ...f.activationCommand(), gate_attachments: { ...f.gates, "G-04": f.attach({ ...f.gateDocument("G-04"), source_mode: "synthetic" }) } }, f.options), /INVALID_GATE_EVIDENCE/);
    assert.throws(() => activatePolicy(f.db, human, { ...f.activationCommand(), gate_attachments: { ...f.gates, "G-01": f.attach({ ...f.gateDocument("G-01"), policy_hash: "0".repeat(64) }) } }, f.options), /GATE_EVIDENCE_OUT_OF_SCOPE/);
    assert.throws(() => activatePolicy(f.db, human, { ...f.activationCommand(), gate_attachments: { ...f.gates, "G-04": f.attach({ ...f.gateDocument("G-04"), metrics: { out_of_sample_observations: 2, forward_observations: 1, trades: 0, max_drawdown: "0.9", net_excess_return: "-1" } }) } }, f.options), /STRATEGY_EVIDENCE_METRICS_MISMATCH/);
    assert.equal(getGovernanceState(f.db, human, f.portfolio).activations.length, 0);
    assert.equal(activatePolicy(f.db, human, f.activationCommand(), f.options).status, "live_advice");
  } finally { f.close(); }
});

test("E20 approving two 60k proposals against 100k cannot reserve twice and never creates facts", () => {
  const f = governanceFixture();
  try {
    const first = f.proposal(), second = f.proposal();
    assert.equal(first.risk.status, "pass", JSON.stringify(first.risk)); assert.equal(second.risk.status, "pass");
    const before = revision(f.db, f.portfolio), approval = f.approve(first);
    assert.equal(approval.reservations[0].amount, "60000");
    assert.throws(() => f.approve(second), /RISK_BLOCKED:INSUFFICIENT_AVAILABLE_CASH/);
    assert.equal(revision(f.db, f.portfolio), before);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM reservations WHERE status='active'").get() as { count: number }).count, 1);
    const ready = prepareExecution(f.db, human, { ...f.envelope(), proposal_id: first.id, approval_id: approval.id }, f.options);
    assert.equal(ready.broker_order_sent, false);
    assert.throws(() => f.approve(first), /PROPOSAL_ALREADY_APPROVED/);
  } finally { f.close(); }
});

test("E20 two independent processes compete for one shared cash budget", async () => {
  const f = governanceFixture();
  try {
    const proposals = [f.proposal(), f.proposal()];
    const run = (index: number) => new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("tests/governance-race-worker.ts"), f.filename, JSON.stringify(f.approvalCommand(proposals[index])), f.dataDir, now, f.options.releaseHash], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
      child.on("error", reject); child.on("exit", code => { if (code !== 0) reject(new Error(stderr)); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
    });
    const results = await Promise.all([run(0), run(1)]);
    assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
    assert.match(results.find(result => !result.ok)!.error!, /INSUFFICIENT_AVAILABLE_CASH/);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM approval_events WHERE action='approve'").get() as { count: number }).count, 1);
    assert.equal(revision(f.db, f.portfolio), 1);
  } finally { f.close(); }
});

test("E20 sell reservations stop duplicate disposal and pending sale proceeds cannot fund buys", () => {
  const f = governanceFixture(undefined, "1000", "0");
  try {
    const first = f.proposal("600", "sell"), second = f.proposal("600", "sell");
    assert.equal(first.risk.status, "pass", JSON.stringify(first.risk)); f.approve(first);
    assert.throws(() => f.approve(second), /INSUFFICIENT_AVAILABLE_SHARES/);
    const buy = f.proposal("100");
    assert.equal(buy.risk.status, "blocked"); assert.match(buy.risk.checks[0].code, /INSUFFICIENT_AVAILABLE_CASH/);
  } finally { f.close(); }
});

test("E19 ledger and market changes invalidate approvals before execution", () => {
  const f = governanceFixture();
  try {
    const proposal = f.proposal(), approved = f.approve(proposal);
    f.publish();
    assert.throws(() => prepareExecution(f.db, human, { ...f.envelope(), proposal_id: proposal.id, approval_id: approved.id }, f.options), /PROPOSAL_MARKET_CHANGED/);
    recordFact(f.db, human, f.command({ type: "deposit", account_id: f.account, currency: "CNY", amount: "1" }, "2026-01-05"), now);
    assert.throws(() => prepareExecution(f.db, human, { ...f.envelope(), proposal_id: proposal.id, approval_id: approved.id }, f.options), /APPROVAL_STALE/);
    assert.equal((f.db.prepare("SELECT status FROM reservations").get() as { status: string }).status, "active");
  } finally { f.close(); }
});

test("G02 account reconciliation and explicit permissions cannot be bypassed by human approval", () => {
  const f = governanceFixture();
  try {
    f.db.prepare("UPDATE accounts SET status='disabled' WHERE id=?").run(f.account);
    const blocked = f.proposal(); assert.equal(blocked.risk.status, "blocked"); assert.match(blocked.risk.checks[0].code, /RECONCILIATION/);
    assert.throws(() => f.approve(blocked), /RISK_APPROVAL_MISMATCH/);
    f.db.prepare("UPDATE accounts SET status='active' WHERE id=?").run(f.account);
    f.db.prepare("DELETE FROM account_capabilities WHERE account_id=?").run(f.account);
    const missing = f.proposal(); assert.equal(missing.risk.status, "blocked"); assert.match(missing.risk.checks[0].code, /CAPABILITY/);
  } finally { f.close(); }
});

test("E19 policy activation switching invalidates earlier proposals without rewriting evidence", () => {
  const f = governanceFixture();
  try {
    const proposal = f.proposal(), approved = f.approve(proposal);
    const original = f.db.prepare("SELECT * FROM proposals WHERE id=?").get(proposal.id);
    activatePolicy(f.db, human, f.activationCommand(), { ...f.options, now: "2026-01-05T12:01:00.000Z" });
    assert.throws(() => prepareExecution(f.db, human, { ...f.envelope(), proposal_id: proposal.id, approval_id: approved.id }, { ...f.options, now: "2026-01-05T12:02:00.000Z" }), /NO_ACTIVE_GOVERNANCE|GOVERNANCE_VERSION_CHANGED/);
    assert.deepEqual(f.db.prepare("SELECT * FROM proposals WHERE id=?").get(proposal.id), original);
  } finally { f.close(); }
});

test("risk enforces lots, price conditions, explicit fee floors and pending concentration", () => {
  const f = governanceFixture(policy => { policy.limits.listing_weight = "0.4"; policy.limits.index_weight = "0.5"; });
  try {
    assert.match(f.proposal("101").risk.checks[0].code, /INVALID_TRADING_INCREMENT/);
    assert.match(f.proposal("100", "buy", { limit_price: "110" }).risk.checks[0].code, /PRICE_DEVIATION/);
    const first = f.proposal("300"), second = f.proposal("300");
    assert.equal(first.risk.status, "pass", JSON.stringify(first.risk)); f.approve(first);
    assert.throws(() => f.approve(second), /CONCENTRATION_LIMIT_EXCEEDED/);
  } finally { f.close(); }
  const fee = governanceFixture(policy => { policy.execution.minimum_fee_by_currency.CNY = "10"; });
  try { assert.match(fee.proposal("100").risk.checks[0].code, /FEE_BUDGET_INVALID/); }
  finally { fee.close(); }
});

test("order reports and partial-fill reports never invent cash or consume reservations", () => {
  const f = governanceFixture();
  try {
    const proposal = f.proposal(), approval = f.approve(proposal), before = revision(f.db, f.portfolio);
    for (const status of ["submitted", "partial", "filled"] as const) {
      const result = recordExecutionReport(f.db, human, { ...f.envelope(), proposal_id: proposal.id, proposal_item_id: proposal.item_ids[0], source_id: "synthetic-broker", source_event_id: `report-${status}`, status, attachment_id: f.sourceEvidence, reported_quantity: status === "submitted" ? "0" : "200" }, f.options);
      assert.equal(result.fact_confirmed, false);
    }
    assert.equal(revision(f.db, f.portfolio), before);
    assert.equal((f.db.prepare("SELECT amount FROM reservations WHERE approval_id=?").get(approval.id) as { amount: string }).amount, "60000");
    assert.throws(() => recordExecutionReport(f.db, { id: "ai", kind: "ai" }, {}, f.options), /GOVERNANCE_PERMISSION_DENIED/);
  } finally { f.close(); }
});

test("E21 actual partial fills consume remaining reservation atomically; cancel keeps facts and allows late actual fills", () => {
  const f = governanceFixture();
  try {
    const proposal = f.proposal(), approval = f.approve(proposal);
    const actual = () => f.command({ type: "buy", account_id: f.account, currency: "CNY", listing_id: "l", quantity: "200", price: "100" }, "2026-01-05");
    const first = recordExecutionFact(f.db, human, { ...f.envelope(), proposal_id: proposal.id, proposal_item_id: proposal.item_ids[0], attachment_id: f.sourceEvidence, command: actual() }, f.options);
    assert.equal(first.consumed, true);
    assert.deepEqual(f.db.prepare("SELECT amount,quantity,status FROM reservations WHERE approval_id=?").get(approval.id), { amount: "40000", quantity: "400", status: "active" });
    assert.equal((f.db.prepare("SELECT balance FROM account_projections WHERE ledger_account='trade_payable'").get() as { balance: string }).balance, "-20000");
    const before = revision(f.db, f.portfolio);
    cancelRemainder(f.db, human, { ...f.envelope(), proposal_id: proposal.id }, f.options);
    assert.equal(revision(f.db, f.portfolio), before);
    assert.equal((f.db.prepare("SELECT quantity FROM position_projections").get() as { quantity: string }).quantity, "200");
    const late = recordExecutionFact(f.db, human, { ...f.envelope(), proposal_id: proposal.id, proposal_item_id: proposal.item_ids[0], attachment_id: f.sourceEvidence, command: actual() }, f.options);
    assert.ok(late.deviations.includes("FACT_AFTER_TERMINAL_OR_EXPIRY")); assert.equal(late.consumed, false);
    assert.equal((f.db.prepare("SELECT quantity FROM position_projections").get() as { quantity: string }).quantity, "400");
    assert.equal((f.db.prepare("SELECT status FROM reservations").get() as { status: string }).status, "released");
  } finally { f.close(); }
});

test("expiry releases only unfilled remainder, not facts, and stale proposals never revive", () => {
  const f = governanceFixture();
  try {
    const proposal = f.proposal(); f.approve(proposal);
    assert.throws(() => expireProposal(f.db, human, { ...f.envelope(), proposal_id: proposal.id }, f.options), /PROPOSAL_NOT_EXPIRED/);
    const expiredOptions = { ...f.options, now: "2026-01-05T12:31:00.000Z" };
    const result = expireProposal(f.db, human, { ...f.envelope(), proposal_id: proposal.id }, expiredOptions);
    assert.equal(result.facts_changed, false); assert.equal(result.released, 1);
    assert.equal((f.db.prepare("SELECT status,amount,quantity FROM reservations").get() as { status: string }).status, "expired");
    assert.throws(() => approveProposal(f.db, human, f.approvalCommand(proposal), expiredOptions), /PROPOSAL_TERMINAL/);
  } finally { f.close(); }
});

test("auth, cross-account scope, restoration freeze and immutable approval chains hold", () => {
  const f = governanceFixture();
  try {
    const proposal = f.proposal();
    assert.throws(() => approveProposal(f.db, { id: "", kind: "human" }, f.approvalCommand(proposal), f.options), /UNAUTHENTICATED/);
    assert.throws(() => approveProposal(f.db, { id: "ai", kind: "ai" }, f.approvalCommand(proposal), f.options), /GOVERNANCE_PERMISSION_DENIED/);
    f.approve(proposal);
    assert.throws(() => f.db.prepare("UPDATE approval_events SET actor_id='ai'").run(), /append-only/);
    assert.throws(() => f.db.prepare("DELETE FROM proposal_items").run(), /append-only/);
    const unrelated = createAccount(f.db, human, f.portfolio, "not authorized", "synthetic", "CNY", now);
    const wrong = f.proposal("100", "buy", { account_id: unrelated });
    assert.equal(wrong.risk.status, "blocked"); assert.match(wrong.risk.checks[0].code, /ACCOUNT_NOT_AUTHORIZED/);
    writeFileSync(path.join(f.dataDir, "RESTORE_PENDING_REVIEW"), "Synthetic restore");
    assert.throws(() => runRiskCheck(f.db, human, { ...f.envelope(), proposal_id: proposal.id }, f.options), /WORKBENCH_READ_ONLY/);
  } finally { f.close(); }
});

test("PASS text alone, wrong runtime source version, synthetic runs and NOT_RUN never activate actual advice", () => {
  const f = governanceFixture(undefined, "0", "100000", false);
  try {
    assert.throws(() => activatePolicy(f.db, human, f.activationCommand(), { dataDir: f.dataDir, now, releaseHash: undefined }), /RUNTIME_RELEASE_MANIFEST_REQUIRED/);
    assert.throws(() => activatePolicy(f.db, human, f.activationCommand(), { ...f.options, releaseHash: "0".repeat(64) }), /VERIFICATION_VERSION_MISMATCH/);
    const unsupported = f.gateDocument("G-03"); unsupported.verification_ids = [];
    assert.throws(() => activatePolicy(f.db, human, { ...f.activationCommand(), gate_attachments: { ...f.gates, "G-03": f.attach(unsupported) } }, f.options), /TRUSTED_VERIFICATION_REQUIRED/);
    for (const [provenance, status] of [["synthetic", "pass"], ["authoritative", "not_run"]]) {
      const id = f.seedVerification("G-03", provenance, status);
      const document = { ...f.gateDocument("G-03"), verification_ids: [id] };
      assert.throws(() => activatePolicy(f.db, human, { ...f.activationCommand(), gate_attachments: { ...f.gates, "G-03": f.attach(document) } }, f.options), /VERIFICATION_NOT_ACTUAL_PASS/);
    }
    assert.throws(() => f.db.prepare("UPDATE governance_verification_runs SET status='pass'").run(), /append-only/);
    assert.throws(() => registerCompletedVerification(f.db, "human-uploaded-result", now), /TRUSTED_VERIFICATION_JOB_REQUIRED/);
  } finally { f.close(); }
});

test("a mutable researcher success label cannot turn exploratory output into formal strategy evidence", () => {
  const f = governanceFixture(undefined, "0", "100000", false);
  try {
    f.db.prepare("UPDATE research_runs SET result_json=?").run(JSON.stringify({ admission_grade: "exploratory", admission_metrics: f.gateDocument("G-04").metrics }));
    assert.throws(() => activatePolicy(f.db, human, f.activationCommand(), f.options), /FORMAL_STRATEGY_EVIDENCE_REQUIRED/);
  } finally { f.close(); }
});

test("available cash subtracts actual payables, explicit holds and existing reservations exactly", () => {
  const f = governanceFixture();
  try {
    f.approve(f.proposal("100"));
    // Directly seed projection dimensions for this arithmetic fixture; no broker or actual ledger is used.
    f.db.prepare("INSERT INTO account_projections(account_id,currency,ledger_account,balance,ledger_revision) VALUES(?,'CNY','trade_payable','-20000',1)").run(f.account);
    f.db.prepare("INSERT INTO account_projections(account_id,currency,ledger_account,balance,ledger_revision) VALUES(?,'CNY','cash_hold','15000',1)").run(f.account);
    const blocked = f.proposal("600");
    assert.equal(blocked.risk.status, "blocked"); assert.equal(blocked.risk.checks[0].code, "INSUFFICIENT_AVAILABLE_CASH");
    assert.equal(f.proposal("500").risk.status, "pass");
    assert.equal((f.db.prepare("SELECT balance FROM account_projections WHERE ledger_account='cash_settled'").get() as { balance: string }).balance, "100000");
  } finally { f.close(); }
});

test("missing AI review, suspended listing and unknown fee assumptions fail closed", () => {
  const ai = governanceFixture(policy => { policy.ai_mode = "required_block_on_missing"; });
  try { assert.equal(ai.proposal("100").risk.checks[0].code, "AI_REVIEW_REQUIRED"); }
  finally { ai.close(); }
  const f = governanceFixture();
  try {
    f.reviewListing("l", { lifecycle_status: "suspended" });
    assert.equal(f.proposal("100").risk.checks[0].code, "LISTING_REVIEW_NOT_ACTIVE");
  } finally { f.close(); }
});

test("reservation mutation and actual fact insertion roll back together when recovery freezes mid-transaction", () => {
  const f = governanceFixture();
  try {
    const proposal = f.proposal(); f.approve(proposal);
    const before = revision(f.db, f.portfolio);
    f.db.function("synthetic_freeze", () => { writeFileSync(path.join(f.dataDir, "RESTORE_PENDING_REVIEW"), "Synthetic restore"); return 1; });
    f.db.exec("CREATE TEMP TRIGGER freeze_after_reservation AFTER UPDATE ON reservations BEGIN SELECT synthetic_freeze(); END");
    const command = f.command({ type: "buy", account_id: f.account, currency: "CNY", listing_id: "l", quantity: "200", price: "100" }, "2026-01-05");
    assert.throws(() => recordExecutionFact(f.db, human, { ...f.envelope(), proposal_id: proposal.id, proposal_item_id: proposal.item_ids[0], attachment_id: f.sourceEvidence, command }, f.options), /WORKBENCH_READ_ONLY/);
    assert.equal(revision(f.db, f.portfolio), before);
    assert.equal((f.db.prepare("SELECT amount FROM reservations").get() as { amount: string }).amount, "60000");
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM position_projections").get() as { count: number }).count, 0);
  } finally { f.close(); }
});

test("risk errors never disclose native SQL or original attachment filesystem paths", () => {
  const f = governanceFixture();
  try {
    const proposal = f.proposal();
    const metadata = f.db.prepare("SELECT storage_key FROM attachments WHERE id=?").get(f.gates["G-03"]) as { storage_key: string };
    rmSync(path.join(f.dataDir, metadata.storage_key));
    const risk = runRiskCheck(f.db, human, { ...f.envelope(), proposal_id: proposal.id }, f.options);
    assert.equal(risk.status, "blocked"); assert.ok(!JSON.stringify(risk).includes(f.dataDir));
    assert.equal(isGovernanceClientError("no such column: secret"), false);
    assert.equal(isGovernanceClientError(`RISK_BLOCKED:ENOENT ${f.dataDir}`), false);
    assert.equal(isGovernanceClientError("RISK_BLOCKED:INSUFFICIENT_AVAILABLE_CASH"), true);
  } finally { f.close(); }
});

test("execution preparation rechecks the exact approval input hash, including other reservations", () => {
  const f = governanceFixture();
  try {
    const first = f.proposal("100"), approvedFirst = f.approve(first);
    const second = f.proposal("100"), approvedSecond = f.approve(second);
    assert.throws(() => prepareExecution(f.db, human, { ...f.envelope(), proposal_id: first.id, approval_id: approvedFirst.id }, f.options), /APPROVAL_STALE/);
    assert.equal(prepareExecution(f.db, human, { ...f.envelope(), proposal_id: second.id, approval_id: approvedSecond.id }, f.options).status, "ready_for_manual_execution");
  } finally { f.close(); }
});

test("execution report source retries deduplicate without silently overwriting conflicting reports", () => {
  const f = governanceFixture();
  try {
    const proposal = f.proposal(); f.approve(proposal);
    const input = { ...f.envelope(), proposal_id: proposal.id, proposal_item_id: proposal.item_ids[0], source_id: "synthetic-broker", source_event_id: "report-one", status: "partial", attachment_id: f.sourceEvidence, reported_quantity: "100" };
    const first = recordExecutionReport(f.db, human, input, f.options);
    const retry = recordExecutionReport(f.db, human, { ...input, idempotency_key: "second-report-import" }, f.options);
    assert.equal(retry.id, first.id);
    assert.throws(() => recordExecutionReport(f.db, human, { ...input, idempotency_key: "conflict-report", reported_quantity: "200" }, f.options), /EXECUTION_REPORT_DUPLICATE_CONFLICT/);
    assert.equal(revision(f.db, f.portfolio), 1);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM execution_reports").get() as { count: number }).count, 1);
  } finally { f.close(); }
});

test("a human-created job cannot be promoted into trusted verification by internal import or direct table insertion", () => {
  const f = governanceFixture(undefined, "0", "100000", false);
  try {
    f.db.exec("INSERT INTO command_requests(id,portfolio_id,command_type,idempotency_key,payload_hash,payload_json,actor_id,created_at) SELECT 'human-request',portfolio_id,command_type,'human-key',payload_hash,payload_json,'SYNTHETIC-HUMAN',created_at FROM command_requests WHERE command_type='governance_verification' LIMIT 1");
    f.db.exec("INSERT INTO job_runs(id,command_request_id,job_type,scope,period,input_version,status,not_before,result_json,created_at,updated_at) SELECT 'human-job','human-request',job_type,scope,'human-period',input_version,status,not_before,result_json,created_at,updated_at FROM job_runs WHERE job_type='governance_verification' LIMIT 1");
    assert.throws(() => registerCompletedVerification(f.db, "human-job", now), /TRUSTED_VERIFICATION_JOB_REQUIRED/);
    assert.throws(() => f.db.exec("INSERT INTO governance_verification_runs SELECT 'forged-run',portfolio_id,'human-job',gate,policy_hash,strategy_hash,suite_version,tool_version,source_manifest_json,source_manifest_hash,execution_manifest_json,manifest_hash,checks_json,metrics_json,research_run_id,provenance,status,executed_at,recorded_at FROM governance_verification_runs LIMIT 1"), /requires trusted completed job/);
  } finally { f.close(); }
});
