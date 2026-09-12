import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getFundingState, linkFundingExecution, publishFundingPlanVersion, unlinkFundingExecution, type FundingPlan } from "../src/server/funding/service";
import { cancelRemainder, recordExecutionFact, recordExecutionReport } from "../src/server/governance/service";
import { availableResources } from "../src/server/governance/risk";
import { exact } from "../src/server/ledger/decimal";
import { revision, type LedgerCommand } from "../src/server/ledger/service";
import { correctLedger } from "../src/server/ledger/corrections";
import { governanceFixture, human, now } from "./governance-fixture";

function fixture() {
  const f = governanceFixture(), state = () => getFundingState(f.db, human, f.portfolio, f.options);
  const envelope = () => ({ portfolio_id: f.portfolio, expected_funding_revision: state().funding_revision, expected_ledger_revision: revision(f.db, f.portfolio), idempotency_key: randomUUID(), reason: "Synthetic funding attribution only" });
  const plan: FundingPlan = { schema_version: 2, title: "Synthetic reserve allocation", timezone: "Asia/Shanghai", sources: [{ id: "source", label: "Initial", kind: "initial", currency: "CNY", planned_amount: "100000", period_start: "2026-01-01", period_end: "2026-12-31", expected_arrival_date: "2026-01-01", account_id: f.account, status: "planned" }], tranches: ["one", "two"].map(id => ({ id, source_id: "source", label: id, planned_amount: "50000", account_id: f.account, invest_by: "2026-02-01", unspent_action: "Review, never automatic execution", status: "planned" })) };
  const publish = (value = plan, acknowledge_shortfall = false) => publishFundingPlanVersion(f.db, human, { ...envelope(), plan: value, acknowledge_shortfall }, f.options);
  publish();
  const link = (proposal_item_id: string, tranche_id = "one") => linkFundingExecution(f.db, human, { ...envelope(), expected_resources_hash: state().resources_hash, tranche_id, proposal_item_id }, f.options);
  return { ...f, state, fundingEnvelope: envelope, plan, publish, link };
}

test("funding links tag actual buy proposals but neither authorize trades nor reserve money", () => {
  const f = fixture();
  try {
    const proposal = f.proposal("400"), before = f.state();
    const item = f.db.prepare("SELECT id FROM proposal_items WHERE proposal_id=?").get(proposal.id) as { id: string };
    const link = f.link(item.id);
    assert.equal(f.state().tranches[0].active_reservations, "0"); assert.equal(f.state().account_cash[0].available, "100000");
    assert.equal(revision(f.db, f.portfolio), before.ledger_revision);
    assert.throws(() => f.link(item.id, "two"), /FUNDING_EXECUTION_ALREADY_LINKED/);
    assert.throws(() => f.link("not-scoped"), /FUNDING_EXECUTION_OUT_OF_SCOPE/);
    f.approve(proposal);
    assert.equal(f.state().tranches[0].active_reservations, "40000"); assert.equal(f.state().account_cash[0].available, "60000");
    assert.equal(f.state().tranches[0].execution_status, "reserved");
    const reduced = structuredClone(f.plan); reduced.tranches[0].planned_amount = "0";
    assert.throws(() => f.publish(reduced), /FUNDING_ACKNOWLEDGEMENT_REQUIRED/);
    f.publish(reduced, true);
    assert.equal(f.state().tranches[0].budget_excess, "40000"); assert.equal(f.state().tranches[0].execution_status, "over_budget");
    assert.ok(f.state().warnings.includes("FUNDING_TRANCHE_OVER_BUDGET"));
    assert.throws(() => unlinkFundingExecution(f.db, human, { ...f.fundingEnvelope(), link_id: link.id }, f.options), /FUNDING_ACTIVE_EXECUTION/);
    const cancelled = structuredClone(f.plan); cancelled.tranches[0].status = "cancelled";
    assert.throws(() => f.publish(cancelled), /FUNDING_ACTIVE_EXECUTION/);
    assert.equal(f.state().tranches[0].active_reservations, "40000"); assert.equal(f.state().plan!.tranches[0].status, "planned");
  } finally { f.close(); }
});

test("resource-only reservation changes invalidate link CAS without ledger or funding revision changes", () => {
  const f = fixture();
  try {
    const proposal = f.proposal("400"), item = f.db.prepare("SELECT id FROM proposal_items WHERE proposal_id=?").get(proposal.id) as { id: string };
    const input = { ...f.fundingEnvelope(), expected_resources_hash: f.state().resources_hash, tranche_id: "one", proposal_item_id: item.id };
    f.approve(proposal);
    assert.equal(input.expected_ledger_revision, revision(f.db, f.portfolio)); assert.equal(input.expected_funding_revision, f.state().funding_revision);
    assert.throws(() => linkFundingExecution(f.db, human, input, f.options), /RESOURCE_CONFLICT/);
    assert.equal(f.state().links.length, 0); f.link(item.id); assert.equal(f.state().tranches[0].active_reservations, "40000");
  } finally { f.close(); }
});

test("reports are not executed capital; partial actual fills, cancellation and correction remain distinct", () => {
  const f = fixture();
  try {
    const proposal = f.proposal("400"), item = f.db.prepare("SELECT id FROM proposal_items WHERE proposal_id=?").get(proposal.id) as { id: string };
    f.approve(proposal); const link = f.link(item.id);
    recordExecutionReport(f.db, human, { ...f.envelope(), proposal_id: proposal.id, proposal_item_id: item.id, attachment_id: f.sourceEvidence, source_id: "synthetic", source_event_id: "report-one", status: "partial", reported_quantity: "100" }, f.options);
    assert.equal(f.state().tranches[0].executed_amount, "0"); assert.equal(f.state().tranches[0].active_reservations, "40000");
    const command = f.command({ type: "buy", account_id: f.account, listing_id: "l", currency: "CNY", quantity: "100", price: "100", fee: "1" }, "2026-01-05");
    const fill = recordExecutionFact(f.db, human, { ...f.envelope(), proposal_id: proposal.id, proposal_item_id: item.id, attachment_id: f.sourceEvidence, command }, f.options);
    assert.equal(f.state().tranches[0].executed_amount, "10001"); assert.equal(f.state().tranches[0].active_reservations, "30000");
    assert.equal(f.state().tranches[0].execution_status, "partially_executed");
    assert.equal(f.state().account_cash[0].settled, "100000"); assert.equal(f.state().account_cash[0].trade_payable, "-10001"); assert.equal(f.state().account_cash[0].available, "59999");
    cancelRemainder(f.db, human, { ...f.envelope(), proposal_id: proposal.id }, f.options);
    assert.equal(f.state().tranches[0].active_reservations, "0"); assert.equal(f.state().tranches[0].executed_amount, "10001"); assert.equal(f.state().account_cash[0].available, "89999");
    const completed = structuredClone(f.plan); completed.tranches[0].planned_amount = "10001";
    f.publish(completed); assert.equal(f.state().tranches[0].execution_status, "budget_executed");
    const cancelled = structuredClone(completed); cancelled.tranches[0].status = "cancelled";
    assert.throws(() => f.publish(cancelled), /FUNDING_ACKNOWLEDGEMENT_REQUIRED/);
    f.publish(cancelled, true); assert.equal(f.state().tranches[0].execution_status, "cancelled_with_execution");
    assert.equal(f.state().tranches[0].executed_amount, "10001"); assert.ok(f.state().warnings.includes("CANCELLED_TRANCHE_HAS_EXECUTED_FACTS"));
    f.publish(completed);
    const correction = correctLedger(f.db, human, { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: randomUUID(), attachment_id: f.sourceEvidence, reason: "Synthetic fill fee correction", changes: [{ action: "replace", event_id: fill.receipt.event_id, replacement: { effective_at: command.effective_at, time_precision: command.time_precision, source_timezone: command.source_timezone, fact: { ...command.fact, fee: "2" } } }] }, f.options);
    assert.equal(f.state().tranches[0].needs_review_count, 1); assert.equal(f.state().tranches[0].due_status, "needs_review");
    assert.ok(f.state().warnings.includes("FUNDING_LINKS_REQUIRE_REVIEW"));
    const replacement = correction.replacements.find(row => row.original_event_id === fill.receipt.event_id)!;
    const replacementCommand = JSON.parse((f.db.prepare("SELECT payload_json FROM ledger_events WHERE id=?").get(replacement.event_id) as { payload_json: string }).payload_json) as LedgerCommand;
    recordExecutionFact(f.db, human, { ...f.envelope(), proposal_id: proposal.id, proposal_item_id: item.id, attachment_id: f.sourceEvidence, command: { ...replacementCommand, expected_revision: revision(f.db, f.portfolio), idempotency_key: randomUUID() } }, f.options);
    assert.equal(f.state().tranches[0].executed_amount, "10002"); assert.equal(f.state().tranches[0].needs_review_count, 0);
    assert.equal(f.state().tranches[0].budget_excess, "1"); assert.equal(f.state().tranches[0].execution_status, "over_budget");
    correctLedger(f.db, human, { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: randomUUID(), attachment_id: f.sourceEvidence, reason: "Synthetic void has no replacement", changes: [{ action: "void", event_id: replacement.event_id }] }, f.options);
    assert.ok(f.state().tranches[0].needs_review_count > 0); assert.equal(f.state().tranches[0].executed_amount, "0");
    const before = revision(f.db, f.portfolio);
    unlinkFundingExecution(f.db, human, { ...f.fundingEnvelope(), link_id: link.id }, f.options);
    assert.equal(revision(f.db, f.portfolio), before); assert.equal(f.state().links[0].status, "released");
    assert.equal(f.state().link_history.length, 2);
  } finally { f.close(); }
});

test("available resources use exact settled cash, signed payables, holds and reservations, never planned funding", () => {
  const account_id = "a", currency = "USD";
  const balances = Object.entries({ cash_settled: "100", trade_payable: "-20.1", other_liability: "-3", cash_hold: "2.2", trade_receivable: "400" }).map(([ledger_account, balance]) => ({ account_id, currency, ledger_account, balance }));
  const reservations = [{ id: "r", proposal_item_id: "p", account_id, currency, listing_id: "l", side: "buy", amount: "10.3", quantity: "1", row_version: 0 }];
  const result = availableResources(balances, [], reservations);
  assert.equal(exact(result.available.get("a:USD")!), "64.4");
  assert.throws(() => availableResources([{ account_id, currency, ledger_account: "trade_payable", balance: "1" }], [], []), /INVALID_LEDGER_LIABILITY/);
  assert.throws(() => availableResources([{ account_id, currency, ledger_account: "cash_hold", balance: "-1" }], [], []), /INVALID_CASH_HOLD/);
  assert.equal(now, "2026-01-05T12:00:00.000Z");
});
