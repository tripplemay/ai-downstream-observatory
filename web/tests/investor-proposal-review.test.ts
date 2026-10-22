import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { executeInvestorCommand } from "../src/server/investor/service";
import { getInvestorProposalReviewContext } from "../src/server/investor/proposal-review";
import { proposalReviewBasis, type ProposalReviewContext, type ProposalReviewIntent } from "../src/server/investor/proposal-review-schemas";
import { revision } from "../src/server/ledger/service";
import { governanceFixture, human, now } from "./governance-fixture";
import { createProposal } from "../src/server/governance/service";
import { syntheticProfile } from "./investor-fixture";

function fixture(expiresAt?: string) {
  const f = governanceFixture();
  executeInvestorCommand(f.db, human, { action: "save_profile", profile: syntheticProfile, expected_revision: 0, idempotency_key: "fictional-profile" }, now);
  executeInvestorCommand(f.db, human, { action: "link_portfolio", portfolio_id: f.portfolio, expected_ledger_revision: revision(f.db, f.portfolio), expected_revision: 1, idempotency_key: "fictional-link" }, now);
  const proposal = expiresAt ? createProposal(f.db, human, { ...f.envelope(), activation_id: f.activated!.id, valuation_id: f.valuationId, expires_at: expiresAt,
    items: [{ account_id: f.account, listing_id: "l", side: "buy", currency: "CNY", quantity: "600", limit_price: "100", estimated_fees: "0" }] }, f.options) : f.proposal();
  return { ...f, proposal };
}
type Fixture = ReturnType<typeof fixture>;
function context(f: Fixture, at = now) { return getInvestorProposalReviewContext(f.db, human, f.proposal.id, at, f.options); }
function intent(c: ProposalReviewContext, operation: ProposalReviewIntent["operation"]): ProposalReviewIntent {
  return { action: "review_linked_proposal", portfolio_id: c.portfolio_id, proposal_id: c.selected!.id, expected_ledger_revision: c.ledger_revision,
    expected_link_id: c.link_id, expected_link_version: c.link_version, expected_context_hash: c.context_hash, operation,
    note: "Fictional human review only", basis: proposalReviewBasis, acknowledgement: true };
}
function execute(f: Fixture, operation: ProposalReviewIntent["operation"], at = now, key = "fictional-" + operation) {
  const c = context(f, at), body = { ...intent(c, operation), expected_revision: c.workspace_revision, idempotency_key: key };
  return { body, receipt: executeInvestorCommand(f.db, human, body, at, f.options) };
}
const financial = ["ledger_events", "ledger_heads", "postings", "position_movements", "account_projections", "position_projections", "accounts"];
function rows(f: Fixture, tables = financial) { return tables.map(name => f.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()); }

test("owned proposal reads independently verify source/audit/risk but never persist a check, approve, reserve or order", () => {
  const f = fixture(); try {
    const before = f.db.prepare("SELECT total_changes() n").get(), c = context(f);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    assert.equal(c.selected!.current_risk.status, "pass"); assert.equal(c.selected!.recorded_risk!.matches_current, true);
    assert.ok(c.selected!.allowed_operations.includes("approve")); assert.equal(c.selected!.approval, null); assert.equal(c.selected!.reservations.length, 0);
    assert.equal(c.broker_ordering_enabled, false); assert.equal(c.automated_execution_enabled, false);
    assert.equal(context(f, "2026-01-05T12:00:01.000Z").context_hash, c.context_hash);
    assert.throws(() => getInvestorProposalReviewContext(f.db, { id: "foreign" }, f.proposal.id, now, f.options), /OUT_OF_SCOPE/);
    assert.throws(() => getInvestorProposalReviewContext(f.db, human, "foreign", now, f.options), /SELECTION_INVALID/);
  } finally { f.close(); }
});
test("explicit recheck, human approval, pre-execution recheck and remainder release reuse original services without ledger facts", () => {
  const f = fixture(); try {
    const before = rows(f);
    execute(f, "risk_check", "2026-01-05T12:00:01.000Z");
    const approved = execute(f, "approve", "2026-01-05T12:00:02.000Z"), c = context(f, "2026-01-05T12:00:02.000Z");
    assert.deepEqual(rows(f), before); assert.equal(c.selected!.reservations.length, 1); assert.equal(c.selected!.reservations[0].quantity, "600");
    assert.ok(c.selected!.approval); assert.ok(!c.selected!.allowed_operations.includes("approve")); assert.ok(c.selected!.allowed_operations.includes("prepare"));
    const changes = f.db.prepare("SELECT total_changes() n").get();
    assert.deepEqual(executeInvestorCommand(f.db, human, approved.body, "2026-01-05T12:00:03.000Z", f.options), approved.receipt);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes);
    execute(f, "prepare", "2026-01-05T12:00:04.000Z"); assert.deepEqual(rows(f), before);
    assert.ok(context(f, "2026-01-05T12:00:04.000Z").selected!.preparation);
    execute(f, "cancel_remainder", "2026-01-05T12:00:05.000Z"); assert.deepEqual(rows(f), before);
    const remaining = f.db.prepare("SELECT amount,quantity,status FROM reservations").get(); assert.deepEqual(remaining, { amount: "0", quantity: "0", status: "released" });
    assert.equal(getInvestorProposalReviewContext(f.db, human, null, "2026-01-05T12:00:05.000Z", f.options).proposals.length, 0);
  } finally { f.close(); }
});
test("a stale quote publication or risk result cannot authorize approval, while cancellation never needs a price recovery", () => {
  const f = fixture(); try {
    const c = context(f), body = { ...intent(c, "approve"), expected_revision: c.workspace_revision, idempotency_key: "old-approval" };
    f.publish("manual_verified", "101");
    assert.throws(() => executeInvestorCommand(f.db, human, body, now, f.options), /CONTEXT_CONFLICT/);
    const fresh = context(f); assert.equal(fresh.selected!.current_risk.status, "blocked"); assert.ok(!fresh.selected!.allowed_operations.includes("approve"));
    assert.throws(() => execute(f, "approve"), /OPERATION_BLOCKED/);
    execute(f, "cancel_remainder"); assert.equal((f.db.prepare("SELECT count(*) n FROM reservations").get() as { n: number }).n, 0);
  } finally { f.close(); }
});
test("expired reserved lists remain discoverable for explicit release without reviving an approval", () => {
  const f = fixture(); try {
    execute(f, "approve"); const late = "2026-01-05T12:31:00.000Z", c = context(f, late);
    assert.equal(c.proposals.length, 1); assert.equal(c.selected!.current_risk.status, "blocked");
    assert.ok(c.selected!.allowed_operations.includes("expire")); assert.ok(!c.selected!.allowed_operations.includes("prepare"));
    const before = rows(f); execute(f, "expire", late); assert.deepEqual(rows(f), before);
    assert.deepEqual(f.db.prepare("SELECT amount,quantity,status FROM reservations").get(), { amount: "0", quantity: "0", status: "expired" });
  } finally { f.close(); }
});
test("same-second fractional deadlines stay discoverable and exact-deadline expiry uses the original service", () => {
  for (const expiry of ["2026-01-05T12:30:00Z", "2026-01-05T12:30:00.000000Z", "2026-01-05T12:30:00.000001Z"]) {
    const f = fixture(expiry); try {
      const before = rows(f), at = "2026-01-05T12:30:00.000Z";
      const list = getInvestorProposalReviewContext(f.db, human, null, at, f.options);
      assert.equal(list.proposals.length, expiry.endsWith("000001Z") ? 1 : 0);
      execute(f, "approve");
      const selected = context(f, at).selected!;
      assert.equal(selected.current_risk.status, expiry.endsWith("000001Z") ? "pass" : "blocked");
      if (expiry.endsWith("000001Z")) {
        assert.ok(selected.allowed_operations.includes("prepare")); assert.ok(!selected.allowed_operations.includes("expire"));
        execute(f, "prepare", at); assert.throws(() => execute(f, "expire", at), /OPERATION_BLOCKED/);
      } else {
        assert.ok(selected.allowed_operations.includes("expire")); assert.ok(!selected.allowed_operations.includes("prepare"));
        execute(f, "expire", at);
        assert.deepEqual(f.db.prepare("SELECT amount,quantity,status FROM reservations").get(), { amount: "0", quantity: "0", status: "expired" });
      }
      assert.deepEqual(rows(f), before);
    } finally { f.close(); }
  }
});
test("a partially remaining original grant cannot prepare the old full list even without a ledger revision change", () => {
  const f = fixture(); try {
    execute(f, "approve"); const beforeRevision = revision(f.db, f.portfolio), before = rows(f);
    // Synthetic fault injection isolates the remaining-grant guard from ledger CAS.
    f.db.prepare("UPDATE reservations SET quantity='400',amount='40000',row_version=row_version+1 WHERE status='active'").run();
    const c = context(f);
    assert.equal(revision(f.db, f.portfolio), beforeRevision); assert.equal(c.selected!.current_risk.status, "pass");
    assert.equal(c.selected!.approval!.input_hash, c.selected!.current_risk.input_hash);
    assert.ok(!c.selected!.allowed_operations.includes("prepare"));
    assert.throws(() => execute(f, "prepare"), /OPERATION_BLOCKED/); assert.deepEqual(rows(f), before);
    execute(f, "cancel_remainder"); assert.deepEqual(rows(f), before);
    assert.deepEqual(f.db.prepare("SELECT quantity,amount,status FROM reservations").get(), { quantity: "0", amount: "0", status: "released" });
  } finally { f.close(); }
});
test("invalid scope, arbitrary governance payloads and late investor-audit failure cannot partially approve or reserve", () => {
  const f = fixture(); try {
    const c = context(f), input = intent(c, "approve"), tables = [...financial, "reservations", "approval_events", "risk_runs", "investor_commands", "investor_workspaces", "audit_events", "command_dedup"];
    const before = rows(f, tables);
    for (const [i, patch] of [{ portfolio_id: "foreign" }, { expected_context_hash: "f".repeat(64) }, { expected_link_version: c.link_version + 1 },
      { acknowledgement: false }, { releaseHash: "f".repeat(64) }, { command: {} }, { actor: "injected" }].entries()) {
      assert.throws(() => executeInvestorCommand(f.db, human, { ...input, ...patch, expected_revision: c.workspace_revision, idempotency_key: "bad-" + i }, now, f.options));
      assert.deepEqual(rows(f, tables), before);
    }
    f.db.exec("CREATE TRIGGER fictional_proposal_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action='investor_review_linked_proposal' BEGIN SELECT RAISE(ABORT,'fictional late audit failure'); END");
    assert.throws(() => execute(f, "approve"), /fictional late audit failure/); assert.deepEqual(rows(f, tables), before);
  } finally { f.close(); }
});
test("restore barrier blocks new and original successful approvals, and GET never offers mutations in recovery mode", () => {
  const f = fixture(); try {
    const approved = execute(f, "approve");
    writeFileSync(path.join(f.dataDir, "RESTORE_PENDING_REVIEW"), "FICTIONAL RECOVERY ONLY");
    assert.deepEqual(context(f).selected!.allowed_operations, []);
    assert.throws(() => executeInvestorCommand(f.db, human, approved.body, now, f.options), /WORKBENCH_READ_ONLY/);
    assert.throws(() => execute(f, "prepare"), /WORKBENCH_READ_ONLY/);
  } finally { f.close(); }
});
