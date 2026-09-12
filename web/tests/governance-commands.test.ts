import assert from "node:assert/strict";
import test from "node:test";
import { executeGovernanceCommand } from "../src/server/governance-commands";
import { governanceFixture, human } from "./governance-fixture";

test("public governance operations cannot register verifier evidence or accept a forged actor", () => {
  const f = governanceFixture(undefined, "0", "100000", false);
  try {
    for (const operation of ["registerCompletedVerification", "governance_verification", "place_order"]) {
      assert.throws(() => executeGovernanceCommand(f.db, human, { operation, command: {} }));
    }
    assert.throws(() => executeGovernanceCommand(f.db, human, { operation: "create_policy", command: {}, actor: { kind: "human" } }));
  } finally { f.close(); }
});

test("execution fact adapter derives nested ledger scope and key without accepting conflicts", () => {
  const f = governanceFixture();
  try {
    const proposal = f.proposal("100"); f.approve(proposal);
    const item = f.db.prepare("SELECT id FROM proposal_items WHERE proposal_id=?").get(proposal.id) as { id: string };
    const envelope = f.envelope();
    const raw = { operation: "record_execution_fact", command: { ...envelope, proposal_id: proposal.id, proposal_item_id: item.id, attachment_id: f.sourceEvidence,
      command: { source_id: "synthetic-adapter", source_event_id: "fill-1", effective_at: "2026-01-05", time_precision: "date", source_timezone: "Asia/Shanghai",
        fact: { type: "buy", account_id: f.account, listing_id: "l", currency: "CNY", quantity: "100", consideration: "10000", fee: "0" } } } };
    assert.throws(() => executeGovernanceCommand(f.db, human, { ...raw, command: { ...raw.command, command: { ...raw.command.command, portfolio_id: "other" } } }), /EXECUTION_FACT_OUT_OF_SCOPE/);
    assert.throws(() => executeGovernanceCommand(f.db, human, { ...raw, command: { ...raw.command, command: { ...raw.command.command, expected_revision: 999 } } }), /EXECUTION_FACT_OUT_OF_SCOPE/);
    const receipt = executeGovernanceCommand(f.db, human, raw, f.options) as { receipt: { event_id: string }; consumed: boolean };
    assert.equal(receipt.consumed, true);
    const fact = JSON.parse((f.db.prepare("SELECT payload_json FROM ledger_events WHERE id=?").get(receipt.receipt.event_id) as { payload_json: string }).payload_json);
    assert.equal(fact.portfolio_id, f.portfolio); assert.equal(fact.expected_revision, envelope.expected_revision);
    assert.match(fact.idempotency_key, /^execution:[a-f0-9]{64}$/); assert.equal(fact.reason, envelope.reason);
    assert.deepEqual(executeGovernanceCommand(f.db, human, raw, f.options), receipt);
  } finally { f.close(); }
});
