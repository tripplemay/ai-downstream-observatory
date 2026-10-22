import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { getExecutionFollowupContext } from "../src/server/investor/execution-followup";
import { executionFollowupBasis, type ExecutionFollowupContext, type LinkExecutionIntent } from "../src/server/investor/execution-followup-schemas";
import { recordFact, revision } from "../src/server/ledger/service";
import { storeCsvAttachment } from "../src/server/ledger/attachments";
import { cancelRemainder } from "../src/server/governance/service";
import { governanceFixture, human, now } from "./governance-fixture";
import { syntheticProfile } from "./investor-fixture";
import { storeInvestorExecutionEvidence } from "../src/server/investor/execution-evidence";

function fixture() {
  const f = governanceFixture();
  executeInvestorCommand(f.db, human, { action: "save_profile", profile: syntheticProfile, idempotency_key: "synthetic-profile", expected_revision: 0 }, now);
  executeInvestorCommand(f.db, human, { action: "link_portfolio", portfolio_id: f.portfolio, expected_ledger_revision: revision(f.db, f.portfolio),
    idempotency_key: "synthetic-link", expected_revision: 1 }, now);
  const proposal = f.proposal(); f.approve(proposal);
  const csv = storeCsvAttachment(f.db, human, { portfolio_id: f.portfolio, account_id: f.account,
    bytes: Buffer.from("fictional,not_a_real_broker_receipt\r\n1,synthetic_only\r\n") }, f.options);
  const fact = recordFact(f.db, human, f.command({ type: "buy", account_id: f.account, listing_id: "l", currency: "CNY", quantity: "200", price: "100" }, "2026-01-05"), now);
  return { ...f, proposal, csv, fact };
}
type Fixture = ReturnType<typeof fixture>;
const financial = ["ledger_events", "ledger_heads", "postings", "position_movements", "account_projections", "position_projections", "accounts"];
const protectedRows = [...financial, "reservations", "execution_reports", "approval_events", "investor_commands", "investor_workspaces", "audit_events", "command_dedup"];
function rows(f: Fixture, tables = financial) { return tables.map(name => f.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()); }
function context(f: Fixture, at = now) { return getExecutionFollowupContext(f.db, human, f.account, at); }
function scope(c: ExecutionFollowupContext) {
  return { portfolio_id: c.portfolio_id, account_id: c.account_id, expected_ledger_revision: c.ledger_revision,
    expected_account_row_version: c.account_row_version, expected_link_id: c.link_id, expected_link_version: c.link_version,
    expected_context_hash: c.context_hash, basis: executionFollowupBasis, acknowledgement: true as const };
}
function link(f: Fixture, c = context(f)): LinkExecutionIntent {
  return { ...scope(c), action: "link_recorded_execution_fact", event_id: f.fact.event_id, proposal_item_id: f.proposal.item_ids[0], attachment_id: f.csv.id };
}
function execute(f: Fixture, input: Record<string, unknown> = link(f), key = "synthetic-execution-link", at = now) {
  return executeInvestorCommand(f.db, human, { ...input, expected_revision: getInvestorState(f.db, human, at).revision, idempotency_key: key }, at, f.options);
}

test("followup GET is zero-write, owned, source-bound historical metadata, not executable advice", () => {
  const f = fixture(); try {
    const changes = f.db.prepare("SELECT total_changes() n").get(), c = context(f);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes);
    assert.equal(c.items.length, 1); assert.equal(c.facts.length, 1); assert.equal(c.facts[0].quantity, "200");
    assert.equal(c.facts[0].link, null); assert.ok(c.evidence.some(row => row.id === f.csv.id && row.media_type === "text/csv"));
    assert.equal(c.execution_authorized, false); assert.equal(c.broker_ordering_enabled, false);
    assert.equal(context(f, "2026-01-05T12:00:01.000Z").context_hash, c.context_hash);
    assert.throws(() => getExecutionFollowupContext(f.db, { id: "synthetic-foreign" }, f.account, now), /OUT_OF_SCOPE/);
  } finally { f.close(); }
});

test("explicit CSV-backed linkage consumes only the original remaining reservation and adds no facts or settlement", () => {
  const f = fixture(); try {
    const before = rows(f), input = link(f), ws = getInvestorState(f.db, human, now).revision, receipt = execute(f, input);
    assert.deepEqual(rows(f), before);
    assert.deepEqual(f.db.prepare("SELECT amount,quantity,status FROM reservations WHERE proposal_item_id=?").get(input.proposal_item_id),
      { amount: "40000", quantity: "400", status: "active" });
    const linked = context(f).facts[0].link!; assert.equal(linked.proposal_item_id, input.proposal_item_id); assert.equal(linked.consumed, true);
    assert.ok(linked.deviations.includes("FACT_AGAINST_STALE_PROPOSAL"));
    const changes = f.db.prepare("SELECT total_changes() n").get();
    assert.deepEqual(executeInvestorCommand(f.db, human, { ...input, expected_revision: ws, idempotency_key: "synthetic-execution-link" }, now, f.options), receipt);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes);
    execute(f, link(f), "same-explicit-link-new-command"); assert.deepEqual(rows(f), before);
    assert.equal((f.db.prepare("SELECT quantity FROM reservations").get() as { quantity: string }).quantity, "400");
    assert.equal((f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='execution_fact_link'").get() as { n: number }).n, 1);
  } finally { f.close(); }
});

test("status reports, including filled, stay separate from confirmed facts and never consume a reservation", () => {
  const f = fixture(); try {
    const before = rows(f, [...financial, "reservations"]);
    for (const status of ["submitted", "partial", "filled", "cancelled", "rejected"] as const) {
      const c = context(f);
      execute(f, { ...scope(c), action: "record_linked_execution_report", proposal_item_id: f.proposal.item_ids[0], attachment_id: f.csv.id,
        source_id: "SYNTHETIC-BROKER", source_event_id: "report-" + status, status, reported_quantity: status === "submitted" ? "0" : "200",
        reason: "Fictional state report, not proof of execution" }, "report-" + status);
    }
    assert.deepEqual(rows(f, [...financial, "reservations"]), before);
    assert.equal(context(f).reports.length, 5); assert.ok(context(f).reports.every(row => !row.fact_confirmed));
    assert.equal(context(f).facts[0].link, null);
    const snapshot = rows(f, protectedRows);
    assert.throws(() => execute(f, { ...scope(context(f)), action: "record_linked_execution_report", proposal_item_id: f.proposal.item_ids[0],
      attachment_id: f.csv.id, source_id: "SYNTHETIC-BROKER", source_event_id: "report-filled", status: "filled", reported_quantity: "300", reason: "Conflict" }, "conflicting-report"), /REPORT_DUPLICATE_CONFLICT/);
    assert.deepEqual(rows(f, protectedRows), snapshot);
  } finally { f.close(); }
});

test("late facts can be associated after cancellation without reviving released resources", () => {
  const f = fixture(); try {
    const old = link(f); cancelRemainder(f.db, human, { ...f.envelope(), proposal_id: f.proposal.id }, f.options);
    assert.throws(() => execute(f, old), /CONTEXT_CONFLICT/);
    const before = rows(f, [...financial, "reservations"]);
    execute(f, link(f), "late-link", "2026-01-05T12:31:00.000Z");
    assert.deepEqual(rows(f, [...financial, "reservations"]), before);
    const saved = context(f, "2026-01-05T12:31:00.000Z").facts[0].link!;
    assert.equal(saved.consumed, false); assert.ok(saved.deviations.includes("FACT_AFTER_TERMINAL_OR_EXPIRY"));
  } finally { f.close(); }
});

test("scope, acknowledgement, source selection, direction, stale drafts and readonly guards fail atomically", () => {
  const f = fixture(); try {
    const input = link(f), before = rows(f, protectedRows);
    for (const [index, patch] of [{ expected_context_hash: "f".repeat(64) }, { expected_link_version: input.expected_link_version + 1 },
      { account_id: "foreign" }, { portfolio_id: "foreign" }, { event_id: "foreign" }, { proposal_item_id: "foreign" },
      { attachment_id: "foreign" }, { acknowledgement: false }, { owner_id: "injected" }, { command: { fact: "forbidden" } }].entries()) {
      assert.throws(() => execute(f, { ...input, ...patch }, "invalid-" + index)); assert.deepEqual(rows(f, protectedRows), before);
    }
    writeFileSync(path.join(f.dataDir, "RESTORE_PENDING_REVIEW"), "SYNTHETIC RECOVERY");
    assert.equal(context(f).read_only, true); assert.throws(() => execute(f, link(f)), /WORKBENCH_READ_ONLY/);
    assert.deepEqual(rows(f, protectedRows), before);
  } finally { f.close(); }
});

test("an edited original, corrupted quantity or late audit failure cannot partially consume resources", () => {
  for (const failure of ["attachment", "quantity", "audit"] as const) {
    const f = fixture(); try {
      const input = link(f);
      if (failure === "attachment") writeFileSync(path.join(f.dataDir, f.csv.storage_key), "Fictional corruption");
      if (failure === "quantity") {
        for (const trigger of f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='position_movements'").all() as { name: string }[])
          f.db.exec(`DROP TRIGGER "${trigger.name}"`);
        f.db.prepare("UPDATE position_movements SET quantity='201' WHERE event_id=?").run(f.fact.event_id);
      }
      if (failure === "audit") f.db.exec("CREATE TRIGGER synthetic_link_failure BEFORE INSERT ON audit_events WHEN NEW.action='investor_link_recorded_execution_fact' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
      const before = rows(f, protectedRows); assert.throws(() => execute(f, input)); assert.deepEqual(rows(f, protectedRows), before);
    } finally { f.close(); }
  }
});

test("raw evidence upload is bounded, byte-preserving, scoped and durably idempotent without changing finances or workspace", () => {
  const f = fixture(); try {
    const c = context(f), { basis: _, acknowledgement: __, ...fields } = scope(c);
    const input = { ...fields, expected_workspace_revision: c.workspace_revision };
    const bytes = Buffer.from("\ufefforiginal,fictional\r\n1,NOT REAL EVIDENCE\r\n"), upload = { bytes, media_type: "text/csv" as const, idempotency_key: "synthetic-source-upload" };
    const before = rows(f, [...financial, "reservations", "execution_reports", "investor_commands", "investor_workspaces"]);
    const receipt = storeInvestorExecutionEvidence(f.db, human, input, upload, now, f.options);
    assert.equal(receipt.byte_size, bytes.length); assert.ok(context(f).evidence.some(row => row.id === receipt.attachment_id));
    assert.notEqual(context(f).context_hash, c.context_hash); assert.deepEqual(rows(f, [...financial, "reservations", "execution_reports", "investor_commands", "investor_workspaces"]), before);
    const changes = f.db.prepare("SELECT total_changes() n").get();
    assert.deepEqual(storeInvestorExecutionEvidence(f.db, human, input, upload, now, f.options), receipt);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes);
    assert.throws(() => storeInvestorExecutionEvidence(f.db, human, input, { ...upload, bytes: Buffer.from("Changed") }, now, f.options), /UPLOAD_DUPLICATE_CONFLICT/);
    assert.throws(() => storeInvestorExecutionEvidence(f.db, human, input, { ...upload, idempotency_key: "stale-new-upload" }, now, f.options), /CONTEXT_CONFLICT/);
    assert.throws(() => storeInvestorExecutionEvidence(f.db, { id: "foreign" }, input, upload, now, f.options), /OUT_OF_SCOPE/);
    const fresh = context(f), { basis: ___, acknowledgement: ____, ...next } = scope(fresh);
    for (const bad of [new Uint8Array(), new Uint8Array([0xc3, 0x28]), new Uint8Array(4 * 1024 * 1024 + 1)])
      assert.throws(() => storeInvestorExecutionEvidence(f.db, human, { ...next, expected_workspace_revision: fresh.workspace_revision }, { ...upload, bytes: bad, idempotency_key: "bad" }, now, f.options), /UPLOAD_INVALID/);
    writeFileSync(path.join(f.dataDir, "RESTORE_PENDING_REVIEW"), "SYNTHETIC RECOVERY");
    assert.throws(() => storeInvestorExecutionEvidence(f.db, human, input, upload, now, f.options), /WORKBENCH_READ_ONLY/);
  } finally { f.close(); }
});
