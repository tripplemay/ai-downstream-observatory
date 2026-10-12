import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { investorActor as actor, investorFixture, saveSyntheticProfile, seedSyntheticCandidate, syntheticProfile } from "./investor-fixture";
import { canonical, hash, audit } from "../src/server/ledger/service";
import { getInvestorState, executeInvestorCommand } from "../src/server/investor/service";
import { openWorkbench } from "../src/server/workbench-db";
import { readInvestorNotifications, readInvestorNotification } from "../src/server/investor/notifications";
import { parseInvestorInbox, verifyInvestorNoticeReceipt } from "../src/components/workbench/investor-notifications-client";

type F = ReturnType<typeof investorFixture>;
const now = "2026-01-03T12:15:04.000Z", binding = "a".repeat(64);
function helper(f: F, module: string, args: string[] = []) {
  execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args],
    { cwd: path.resolve(".."), timeout: 90000, maxBuffer: 1048576, stdio: ["ignore", "pipe", "pipe"] });
}
function seed(f: F, funding = false, series = 0) {
  saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
  helper(f, "tests.investor.evidence_fixture", ["--fixed-policy-v2"]);
  helper(f, "tests.investor.queue_fixture", ["--mode", "core"]);
  const state = getInvestorState(f.db, actor, "2026-01-02T12:00:04.000Z"); assert.ok(state.plan);
  executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan.id, expected_revision: state.revision,
    idempotency_key: "fictional-notification-save" }, "2026-01-02T12:00:04.000Z");
  helper(f, "tests.investor.monitor_data_fixture", ["--admit", "--monitor", "--later", ...(funding ? ["--funding"] : []), ...(series ? ["--notification-series", String(series)] : [])]);
}
function protectedState(f: F) {
  return hash(Object.fromEntries(["investor_workspaces", "investor_profiles", "investor_models", "investor_model_controls", "investor_observations",
    "investor_decisions", "job_runs", "outbox", "investor_ai_requests"].map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}
function noFinance(f: F) {
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
}

test("no preference, missing evidence and unqualified synthetic previews never fabricate publication notices", () => {
  const f = investorFixture();
  try {
    const changes = (f.db.prepare("SELECT total_changes() n").get() as { n: number }).n;
    const empty = readInvestorNotifications(f.db, actor, now); assert.equal(empty.workspace_id, null); assert.deepEqual(empty.entries, []);
    assert.equal((f.db.prepare("SELECT total_changes() n").get() as { n: number }).n, changes);
    saveSyntheticProfile(f); seedSyntheticCandidate(f);
    const workspace = readInvestorNotifications(f.db, actor, now); assert.ok(workspace.workspace_id); assert.deepEqual(workspace.entries, []);
    assert.equal(workspace.visible_unread_count, 0); assert.equal(workspace.external_delivery_configured, false); noFinance(f);
  } finally { f.close(); }
});

test("actual core publication metadata is owner bound; reading, acknowledging and reconnecting never alter finance, revision, decisions or outbox delivery", () => {
  const f = investorFixture();
  try {
    seed(f); const before = protectedState(f), feed = readInvestorNotifications(f.db, actor, now);
    assert.equal(feed.entries.length, 2); assert.equal(feed.visible_unread_count, 2);
    assert.deepEqual(parseInvestorInbox({ ...feed, session_binding: binding }, binding, feed.workspace_id), feed);
    const notice = feed.entries[0]; assert.equal(notice.recorded_outcome, "observe"); assert.equal(notice.is_current_conclusion, false);
    assert.equal(notice.observation_id, getInvestorState(f.db, actor, now).latest!.id);
    const input = { notice_id: notice.id, publication_hash: notice.publication_hash }, changes = (f.db.prepare("SELECT total_changes() n").get() as { n: number }).n;
    const receipt = readInvestorNotification(f.db, actor, input, now);
    assert.equal((f.db.prepare("SELECT total_changes() n").get() as { n: number }).n, changes + 1);
    assert.deepEqual(readInvestorNotification(f.db, actor, input, now), receipt);
    assert.equal((f.db.prepare("SELECT total_changes() n").get() as { n: number }).n, changes + 1);
    assert.deepEqual(verifyInvestorNoticeReceipt({ ...receipt, session_binding: binding }, binding, notice), { ...receipt, session_binding: binding });
    const second = openWorkbench(f.filename);
    try { assert.equal(readInvestorNotifications(second, actor, now).entries[0].read_at, now); }
    finally { second.close(); }
    assert.equal(readInvestorNotifications(f.db, actor, now).visible_unread_count, 1); assert.equal(protectedState(f), before); noFinance(f);
    const sql = f.db.prepare("SELECT payload_json,portfolio_id,ledger_revision FROM audit_events WHERE id=?").get(receipt.audit_id) as { payload_json: string; portfolio_id: unknown; ledger_revision: unknown };
    assert.equal(sql.payload_json, canonical({ workspace_id: feed.workspace_id, publication_hash: notice.publication_hash }));
    assert.equal(sql.portfolio_id, null); assert.equal(sql.ledger_revision, null);
  } finally { f.close(); }
});

test("new funding notices stay historical decisions; withdrawal/expiry can leave the metadata but never current advice", () => {
  const f = investorFixture();
  try {
    seed(f, true); const feed = readInvestorNotifications(f.db, actor, now); assert.ok(feed.entries.every(row => row.recorded_outcome === "decision_required"));
    const expired = readInvestorNotifications(f.db, actor, "2027-02-01T00:00:00.000Z");
    assert.deepEqual(expired.entries, feed.entries); assert.ok(expired.entries.every(row => row.is_current_conclusion === false && row.live_advice_eligible === false));
    assert.equal(getInvestorState(f.db, actor, "2027-02-01T00:00:00.000Z").effective_outcome, "insufficient_evidence");
    noFinance(f);
  } finally { f.close(); }
});

test("foreign owners, stale hashes, arbitrary body fields, future clocks and recovery locks cannot acknowledge notices", () => {
  const f = investorFixture();
  try {
    seed(f); const feed = readInvestorNotifications(f.db, actor, now), notice = feed.entries[0], input = { notice_id: notice.id, publication_hash: notice.publication_hash };
    const before = protectedState(f);
    assert.deepEqual(readInvestorNotifications(f.db, { id: "other-owner" }, now).entries, []);
    assert.throws(() => readInvestorNotification(f.db, { id: "other-owner" }, input, now), /NOT_FOUND/);
    assert.throws(() => readInvestorNotification(f.db, actor, { ...input, publication_hash: "b".repeat(64) }, now), /CHANGED/);
    assert.throws(() => readInvestorNotification(f.db, actor, { ...input, actor_id: actor.id }, now));
    assert.throws(() => readInvestorNotifications(f.db, actor, "2026-01-03T11:00:00.000Z"), /EVIDENCE_INVALID/);
    assert.throws(() => audit(f.db, { id: "other-owner" }, "investor_notification_read", "investor_notification", notice.id, null, null,
      { workspace_id: feed.workspace_id, publication_hash: notice.publication_hash }, now), /binding is invalid/);
    for (const [type, revision, payload] of [["foreign-object", null, { workspace_id: feed.workspace_id, publication_hash: notice.publication_hash }],
      ["investor_notification", 0, { workspace_id: feed.workspace_id, publication_hash: notice.publication_hash }],
      ["investor_notification", null, { workspace_id: "foreign", publication_hash: notice.publication_hash }],
      ["investor_notification", null, { workspace_id: feed.workspace_id, publication_hash: notice.publication_hash, accepted: true }],
      ["investor_notification", null, { workspace_id: feed.workspace_id, publication_hash: "C".repeat(64) }]] as const)
      assert.throws(() => audit(f.db, actor, "investor_notification_read", type, notice.id, null, revision, payload, now), /binding is invalid/);
    const marker = path.join(f.directory, "RESTORE_PENDING_REVIEW"); writeFileSync(marker, "Fictional recovery lock");
    try {
      assert.equal(readInvestorNotifications(f.db, actor, now).read_only, true);
      assert.throws(() => readInvestorNotification(f.db, actor, input, now), /READ_ONLY/);
    } finally { unlinkSync(marker); }
    assert.equal(protectedState(f), before); noFinance(f);
  } finally { f.close(); }
});

test("mutable outbox or job tampering never becomes a trusted message or read audit", () => {
  const f = investorFixture();
  try {
    seed(f); const feed = readInvestorNotifications(f.db, actor, now), notice = feed.entries[0];
    const original = (f.db.prepare("SELECT payload_json FROM outbox WHERE id=?").get(notice.id) as { payload_json: string }).payload_json;
    const payload = JSON.parse(original), input = { notice_id: notice.id, publication_hash: notice.publication_hash };
    for (const raw of ["{", canonical({ ...payload, workspace_id: "foreign" }), canonical({ ...payload, outcome: "decision_required" }), canonical({ ...payload, raw_quotes: [] })]) {
      f.db.prepare("UPDATE outbox SET payload_json=? WHERE id=?").run(raw, notice.id);
      assert.throws(() => readInvestorNotifications(f.db, actor, now)); assert.throws(() => readInvestorNotification(f.db, actor, input, now));
    }
    f.db.prepare("UPDATE outbox SET payload_json=? WHERE id=?").run(original, notice.id);
    const timestamp = (f.db.prepare("SELECT created_at FROM outbox WHERE id=?").get(notice.id) as { created_at: string }).created_at;
    for (const value of [notice.published_at, timestamp.replace("000Z", "001Z"), "2027-01-01T00:00:00.000000Z"]) {
      f.db.prepare("UPDATE outbox SET created_at=? WHERE id=?").run(value, notice.id);
      assert.throws(() => readInvestorNotifications(f.db, actor, now), /EVIDENCE_INVALID/);
      assert.throws(() => audit(f.db, actor, "investor_notification_read", "investor_notification", notice.id, null, null,
        { workspace_id: feed.workspace_id, publication_hash: notice.publication_hash }, now), /binding is invalid/);
    }
    f.db.prepare("UPDATE outbox SET created_at=? WHERE id=?").run(timestamp, notice.id);
    assert.equal(readInvestorNotifications(f.db, actor, now).entries[0].read_at, null);
    const row = f.db.prepare("SELECT job_id FROM investor_evidence_monitor_runs WHERE id=?").get(notice.publication_id) as { job_id: string };
    const job = f.db.prepare("SELECT result_json FROM job_runs WHERE id=?").get(row.job_id) as { result_json: string };
    f.db.prepare("UPDATE job_runs SET result_json='{}' WHERE id=?").run(row.job_id);
    assert.throws(() => readInvestorNotifications(f.db, actor, now), /EVIDENCE_INVALID/);
    f.db.prepare("UPDATE job_runs SET result_json=? WHERE id=?").run(job.result_json, row.job_id);
    assert.equal((f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='investor_notification_read'").get() as { n: number }).n, 0);
    noFinance(f);
  } finally { f.close(); }
});

test("inbox scan is index bounded to 20, counts only visible unread and permits an exact older publication acknowledgement", () => {
  const f = investorFixture(), checked = "2026-01-03T16:01:00.000Z";
  try {
    seed(f, false, 19); const before = protectedState(f), feed = readInvestorNotifications(f.db, actor, checked);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_evidence_monitor_runs").get() as { n: number }).n, 21);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_evidence_monitor_runs WHERE status='blocked'").get() as { n: number }).n, 19);
    assert.equal(getInvestorState(f.db, actor, checked).effective_outcome, "insufficient_evidence");
    assert.equal(feed.entries.length, 20); assert.equal(feed.has_more, true); assert.equal(feed.visible_unread_count, 20);
    assert.deepEqual(parseInvestorInbox({ ...feed, session_binding: binding }, binding, feed.workspace_id), feed);
    const scan = f.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM investor_evidence_monitor_runs WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT 21").all(feed.workspace_id);
    assert.match(JSON.stringify(scan), /investor_evidence_notifications_by_workspace/); assert.doesNotMatch(JSON.stringify(scan), /TEMP B-TREE/);
    const readIndex = f.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM audit_events WHERE actor_id=? AND action='investor_notification_read' AND object_type=? AND object_id=?")
      .all(actor.id, "investor_notification", feed.entries[0].id);
    assert.match(JSON.stringify(readIndex), /investor_notification_read_once/);
    const row = f.db.prepare(`SELECT r.id publication_id,r.workspace_id,r.model_id,r.observation_id,r.created_at published_at,r.status,
      o.id FROM investor_evidence_monitor_runs r JOIN outbox o ON o.dedup_key='investor-monitor:' || r.id ORDER BY r.created_at,r.id LIMIT 1`).get() as Record<string, string>;
    const identity = { id: row.id, publication_id: row.publication_id, workspace_id: row.workspace_id, model_id: row.model_id,
      observation_id: row.observation_id, recorded_outcome: row.status === "blocked" ? "insufficient_evidence" : row.status, published_at: row.published_at };
    assert.ok(!feed.entries.some(entry => entry.id === row.id));
    const input = { notice_id: row.id, publication_hash: hash(identity) }, receipt = readInvestorNotification(f.db, actor, input, checked);
    const second = openWorkbench(f.filename);
    try { assert.deepEqual(readInvestorNotification(second, actor, input, checked), receipt); }
    finally { second.close(); }
    assert.equal(readInvestorNotifications(f.db, actor, checked).visible_unread_count, 20);
    assert.throws(() => audit(f.db, actor, "investor_notification_read", "investor_notification", row.id, null, null,
      { workspace_id: row.workspace_id, publication_hash: input.publication_hash }, checked), /UNIQUE/);
    assert.equal(protectedState(f), before); noFinance(f);
  } finally { f.close(); }
});

test("browser validation rejects foreign scope, future read flags, duplicate publications, advice promotion and stale receipts", () => {
  const f = investorFixture();
  try {
    seed(f); const feed = readInvestorNotifications(f.db, actor, now), notice = feed.entries[0];
    for (const update of [{ workspace_id: "foreign" }, { session_binding: "b".repeat(64) }, { visible_unread_count: 0 },
      { entries: [notice, notice] }, { entries: [{ ...notice, read_at: "2027-01-01T00:00:00.000Z" }] },
      { entries: [{ ...notice, is_current_conclusion: true }] }, { entries: [{ ...notice, live_advice_eligible: true }] }])
      assert.throws(() => parseInvestorInbox({ ...feed, session_binding: binding, ...update }, binding, feed.workspace_id), /RESPONSE_INVALID/);
    const receipt = readInvestorNotification(f.db, actor, { notice_id: notice.id, publication_hash: notice.publication_hash }, now);
    for (const update of [{ session_binding: "b".repeat(64) }, { notice_id: "other" }, { publication_hash: "b".repeat(64) }, { financial_state_changed: true }])
      assert.throws(() => verifyInvestorNoticeReceipt({ ...receipt, session_binding: binding, ...update }, binding, notice), /RECEIPT_INVALID/);
  } finally { f.close(); }
});
