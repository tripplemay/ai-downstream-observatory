import assert from "node:assert/strict";
import test from "node:test";
import { approveProposal, createProposal, expireProposal, prepareExecution, recordExecutionFact, recordExecutionReport } from "../src/server/governance/service";
import { checkRisk } from "../src/server/governance/risk";
import { compareProposalInstants, proposalExpiryWithinTtl } from "../src/server/governance/proposal-time";
import { governanceFixture, human, now } from "./governance-fixture";

function input(f: ReturnType<typeof governanceFixture>, expires_at: string) {
  return { ...f.envelope(), activation_id: f.activated!.id, valuation_id: f.valuationId, expires_at,
    items: [{ account_id: f.account, listing_id: "l", side: "buy", currency: "CNY", quantity: "600", limit_price: "100", estimated_fees: "0" }] };
}
for (const expiry of ["2026-01-05T12:30:00Z", "2026-01-05T12:30:00.000Z", "2026-01-05T12:30:00.000000Z", "2026-01-05T12:30:00.000000000Z"]) {
  test("proposal risk and explicit expiry agree at the same deadline regardless of original precision: " + expiry, () => {
    const f = governanceFixture(); try {
      const p = createProposal(f.db, human, input(f, expiry), f.options), approved = f.approve(p);
      const at = "2026-01-05T12:30:00.000Z", risk = checkRisk(f.db, human, f.portfolio, p.id, f.options, at, true);
      assert.equal(risk.status, "blocked"); assert.equal(risk.checks[0].code, "PROPOSAL_EXPIRED");
      assert.throws(() => prepareExecution(f.db, human, { ...f.envelope(), proposal_id: p.id, approval_id: approved.id }, { ...f.options, now: at }), /PROPOSAL_EXPIRED/);
      const before = f.db.prepare("SELECT * FROM ledger_events ORDER BY rowid").all();
      expireProposal(f.db, human, { ...f.envelope(), proposal_id: p.id }, { ...f.options, now: at });
      assert.deepEqual(f.db.prepare("SELECT * FROM ledger_events ORDER BY rowid").all(), before);
      assert.deepEqual(f.db.prepare("SELECT quantity,amount,status FROM reservations").get(), { quantity: "0", amount: "0", status: "expired" });
      assert.equal((f.db.prepare("SELECT expires_at FROM proposals WHERE id=?").get(p.id) as { expires_at: string }).expires_at, expiry);
    } finally { f.close(); }
  });
}
test("a fractional future deadline cannot expire early, including below-millisecond precision", () => {
  for (const suffix of ["000001", "000000001"]) {
    const f = governanceFixture(); try {
      const p = createProposal(f.db, human, input(f, `2026-01-05T12:30:00.${suffix}Z`), f.options); f.approve(p);
      const at = "2026-01-05T12:30:00.000Z", before = f.db.prepare("SELECT * FROM reservations").all();
      assert.equal(checkRisk(f.db, human, f.portfolio, p.id, f.options, at, true).status, "pass");
      assert.throws(() => expireProposal(f.db, human, { ...f.envelope(), proposal_id: p.id }, { ...f.options, now: at }), /PROPOSAL_NOT_EXPIRED/);
      assert.deepEqual(f.db.prepare("SELECT * FROM reservations").all(), before);
    } finally { f.close(); }
  }
});

test("exact comparisons preserve arbitrary fractional precision, equivalent zeros and calendar ordering", () => {
  const fractions = ["", "0", "000", "000000", "000000000", "000000001", "000001", "001", "01", "1", "100000000", "100000001", "11", "9", "999999999"];
  for (const left of fractions) for (const right of fractions) {
    const expected = BigInt((left || "0").padEnd(9, "0")) - BigInt((right || "0").padEnd(9, "0"));
    const time = (fraction: string) => `2026-01-05T12:30:00${fraction ? "." + fraction : ""}Z`;
    assert.equal(compareProposalInstants(time(left), time(right)), expected === 0n ? 0 : expected < 0n ? -1 : 1);
  }
  assert.equal(compareProposalInstants("2026-01-05T12:30:00.0000000000000000000000001Z", "2026-01-05T12:30:00Z"), 1);
  assert.equal(compareProposalInstants("2025-12-31T23:59:59.999999999Z", "2026-01-01T00:00:00Z"), -1);
  assert.equal(compareProposalInstants("2024-02-29T23:59:59Z", "2024-03-01T00:00:00Z"), -1);
  for (const value of ["2026-02-29T12:00:00Z", "2026-04-31T12:00:00Z", "2026-01-05T24:00:00Z", "2026-01-05T12:00:60Z",
    "2026-01-05T12:00:00+00:00", "2026-01-05T12:00:00.Z", "2026-01-05", "not-a-date"]) {
    assert.throws(() => compareProposalInstants(value, now), /INVALID_PROPOSAL_EXPIRY/);
    assert.throws(() => compareProposalInstants(now, value), /INVALID_PROPOSAL_EXPIRY/);
  }
});

test("TTL uses exact elapsed seconds across a day boundary without millisecond rounding", () => {
  const current = "2026-12-31T23:30:00.123456789Z";
  assert.equal(proposalExpiryWithinTtl("2027-01-01T00:30:00.1234567890Z", current, 3600), true);
  assert.equal(proposalExpiryWithinTtl("2027-01-01T00:30:00.123456788Z", current, 3600), true);
  assert.equal(proposalExpiryWithinTtl("2027-01-01T00:30:00.1234567891Z", current, 3600), false);
  assert.equal(proposalExpiryWithinTtl(current, current, 3600), false);
  assert.equal(proposalExpiryWithinTtl("2026-12-31T23:30:00.123456788Z", current, 3600), false);
  for (const ttl of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => proposalExpiryWithinTtl(current, current, ttl), /INVALID_PROPOSAL_EXPIRY/);
});

test("deadline approval cannot create a grant and rejection leaves all transactional state untouched", () => {
  const f = governanceFixture(); try {
    const p = createProposal(f.db, human, input(f, "2026-01-05T12:30:00Z"), f.options);
    const tables = ["approval_events", "reservations", "ledger_events", "audit_events", "command_dedup"];
    const rows = () => tables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before = rows();
    assert.throws(() => approveProposal(f.db, human, f.approvalCommand(p), { ...f.options, now: "2026-01-05T12:30:00.000Z" }), /RISK_BLOCKED:PROPOSAL_EXPIRED/);
    assert.deepEqual(rows(), before);
  } finally { f.close(); }
});

test("report expiry labels use exact instants and late broker facts still consume their actual remaining grant", () => {
  for (const expiry of ["2026-01-05T12:30:00Z", "2026-01-05T12:30:00.000000001Z"]) {
    const f = governanceFixture(); try {
      const p = createProposal(f.db, human, input(f, expiry), f.options); f.approve(p);
      const report = recordExecutionReport(f.db, human, { ...f.envelope(), proposal_id: p.id, proposal_item_id: p.item_ids[0], source_id: "synthetic-broker",
        source_event_id: "fictional-report", status: "partial", attachment_id: f.sourceEvidence, reported_quantity: "200" }, { ...f.options, now: "2026-01-05T12:30:00.000Z" });
      assert.equal(report.deviations.includes("REPORTED_AFTER_TERMINAL_OR_EXPIRY"), expiry.endsWith("00Z"));
      assert.deepEqual(f.db.prepare("SELECT amount,quantity,status FROM reservations").get(), { amount: "60000", quantity: "600", status: "active" });
      const body = { ...f.envelope(), proposal_id: p.id, proposal_item_id: p.item_ids[0], attachment_id: f.sourceEvidence,
        command: f.command({ type: "buy", account_id: f.account, currency: "CNY", listing_id: "l", quantity: "200", price: "100" }, "2026-01-05") };
      const result = recordExecutionFact(f.db, human, body, { ...f.options, now: "2026-01-05T12:30:00.000Z" });
      assert.equal(result.deviations.includes("FACT_AFTER_TERMINAL_OR_EXPIRY"), expiry.endsWith("00Z"));
      assert.equal(result.consumed, true);
      assert.deepEqual(f.db.prepare("SELECT amount,quantity,status FROM reservations").get(), { amount: "40000", quantity: "400", status: "active" });
      const after = f.db.prepare("SELECT total_changes() n").get();
      assert.deepEqual(recordExecutionFact(f.db, human, body, { ...f.options, now: "2026-01-05T12:30:01.000Z" }), result);
      assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), after);
    } finally { f.close(); }
  }
});
test("creation rejects an already reached deadline and even fractional excess over the existing TTL", () => {
  const f = governanceFixture(); try {
    const before = f.db.prepare("SELECT count(*) n FROM proposals").get();
    for (const expiry of [now, "2026-01-05T12:00:00Z", "2026-01-05T12:00:00.000000Z", "2026-01-05T13:00:00.000001Z", "2026-01-05T13:00:00.000000001Z"])
      assert.throws(() => createProposal(f.db, human, input(f, expiry), f.options), /INVALID_PROPOSAL_EXPIRY/);
    assert.deepEqual(f.db.prepare("SELECT count(*) n FROM proposals").get(), before);
    assert.equal(createProposal(f.db, human, input(f, "2026-01-05T13:00:00.000000Z"), f.options).risk.status, "pass");
  } finally { f.close(); }
});
