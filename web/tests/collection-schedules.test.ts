import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createPortfolio, audit, canonical, hash } from "../src/server/ledger/service";
import { saveCollectionSchedule, setCollectionScheduleStatus } from "../src/server/market-schedules/service";
import { collectionReadOnly, firstFutureTrigger, parseCollectionDefinition, readCollectionHistory } from "../src/server/market-schedules/core";
import { verifyScheduledCollectionRequest, type CollectionRequestRow } from "../src/server/market-schedules/verification";
import { getCollectionScheduleState, getCollectionSlot } from "../src/server/market-schedules/queries";

const actor = { id: "synthetic-owner", kind: "human" as const }, now = "2026-01-01T00:00:00.000000Z";
const definition = { schema_version: "collection-schedule-v1", provider: "ecb", feed: "daily", currencies: ["USD", "CNY"], frequency: "daily", timezone: "UTC", start_date: "2026-01-01", end_date: null, trigger: { hour: 12, minute: 30 }, deadline_seconds: 3600, max_attempts: 2, publish: true, missed_policy: "record_no_backfill" };
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "collection-schedule-")), filename = path.join(directory, "workbench.db"); migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, actor, "Synthetic schedule portfolio"), other = createPortfolio(db, actor, "Synthetic other portfolio");
  const input = (patch = {}) => ({ portfolio_id: portfolio, expected_schedule_id: null, expected_schedule_revision: 0, definition_json: JSON.stringify(definition, null, 2) + "\n", reason: "Synthetic fixed reference collection, not investment approval", acknowledgement: true, idempotency_key: "save", ...patch });
  const saved = saveCollectionSchedule(db, actor, input(), { now });
  const status = (patch = {}) => ({ portfolio_id: portfolio, schedule_id: saved.schedule_id, expected_schedule_revision: 1, status: "enabled", reason: "Explicit synthetic collection authorization only", acknowledgement: true, idempotency_key: "enable", ...patch });
  return { db, directory, portfolio, other, input, saved, status, close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test("explicit raw schedule saves paused without creating slots, jobs, investment permissions or financial facts", () => {
  const f = fixture(); try {
    assert.equal(f.saved.status, "paused"); assert.equal(f.saved.scope_key, "provider:ecb:fx:daily:CNY-USD");
    const h = readCollectionHistory(f.db, f.portfolio, f.saved.schedule_id);
    assert.equal(h.versions.get(f.saved.version_id)?.definition_json, f.input().definition_json);
    assert.deepEqual(saveCollectionSchedule(f.db, actor, f.input(), { now }), f.saved);
    for (const table of ["collection_schedule_slots", "command_requests", "job_runs", "ledger_events", "activations", "approval_events", "account_capabilities"]) assert.equal((f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n, 0);
  } finally { f.close(); }
});
test("enable, pause and new-version-paused controls are immutable, exact retries do not toggle state", () => {
  const f = fixture(); try {
    const enabled = setCollectionScheduleStatus(f.db, actor, f.status(), { now: "2026-01-01T00:00:00.000001Z" }); assert.equal(enabled.status, "enabled");
    const paused = setCollectionScheduleStatus(f.db, actor, f.status({ expected_schedule_revision: 2, status: "paused", idempotency_key: "pause" }), { now: "2026-01-01T01:00:00.000000Z" }); assert.equal(paused.schedule_revision, 3);
    assert.deepEqual(setCollectionScheduleStatus(f.db, actor, f.status(), { now: "2026-01-01T02:00:00.000000Z" }), enabled);
    assert.equal(readCollectionHistory(f.db, f.portfolio, f.saved.schedule_id).head.status, "paused");
    const next = saveCollectionSchedule(f.db, actor, f.input({ expected_schedule_id: f.saved.schedule_id, expected_schedule_revision: 3, idempotency_key: "version2" }), { now: "2026-01-01T03:00:00.000000Z" }); assert.equal(next.version, 2); assert.equal(next.status, "paused");
    assert.equal(readCollectionHistory(f.db, f.portfolio, f.saved.schedule_id).controls.length, 4);
  } finally { f.close(); }
});
test("explicit same-status commands append new authorization controls; identical retries append nothing", () => {
  const f = fixture(); try {
    const pause = f.status({ status: "paused", idempotency_key: "same-paused" });
    const paused = setCollectionScheduleStatus(f.db, actor, pause, { now });
    assert.equal(paused.schedule_revision, 2); assert.equal(paused.status, "paused"); assert.equal(paused.version_id, f.saved.version_id);
    assert.deepEqual(setCollectionScheduleStatus(f.db, actor, pause, { now }), paused);
    const enable = f.status({ expected_schedule_revision: 2, idempotency_key: "enable-after-pause" });
    setCollectionScheduleStatus(f.db, actor, enable, { now });
    const reauthorize = f.status({ expected_schedule_revision: 3, idempotency_key: "same-enabled" });
    const renewed = setCollectionScheduleStatus(f.db, actor, reauthorize, { now: "2026-01-01T01:00:00.000000Z" });
    assert.equal(renewed.schedule_revision, 4); assert.equal(renewed.status, "enabled"); assert.equal(renewed.version_id, f.saved.version_id);
    assert.deepEqual(setCollectionScheduleStatus(f.db, actor, reauthorize, { now: "2026-01-01T02:00:00.000000Z" }), renewed);
    const history = readCollectionHistory(f.db, f.portfolio, f.saved.schedule_id);
    assert.equal(history.controls.length, 4); assert.notEqual(history.controls[2].audit_id, history.controls[3].audit_id);
    assert.equal(history.controls[3].created_at, "2026-01-01T01:00:00.000000Z");
  } finally { f.close(); }
});
test("idempotency fingerprints bind the expected revision as well as every other parsed command field", () => {
  const f = fixture(); try {
    assert.throws(() => saveCollectionSchedule(f.db, actor, f.input({ expected_schedule_revision: 1 }), { now }), /COLLECTION_IDEMPOTENCY_CONFLICT/);
    const enabled = setCollectionScheduleStatus(f.db, actor, f.status(), { now });
    for (const patch of [{ expected_schedule_revision: 2 }, { reason: "Changed synthetic reason" }, { status: "paused" }]) assert.throws(() => setCollectionScheduleStatus(f.db, actor, f.status(patch), { now }), /COLLECTION_IDEMPOTENCY_CONFLICT/);
    assert.deepEqual(setCollectionScheduleStatus(f.db, actor, f.status(), { now }), enabled);
    assert.equal(readCollectionHistory(f.db, f.portfolio, f.saved.schedule_id).controls.length, 2);
  } finally { f.close(); }
});
test("schema, human acknowledgement, same-CAS identity, scope uniqueness and monotonic control time fail closed", () => {
  const f = fixture(); try {
    for (const patch of [{ acknowledgement: false }, { reason: " " }, { verified: true }, { known_at: now }]) assert.throws(() => setCollectionScheduleStatus(f.db, actor, f.status(patch), { now }), /COLLECTION_INVALID_COMMAND/);
    assert.throws(() => setCollectionScheduleStatus(f.db, { ...actor, kind: "ai" }, f.status(), { now }), /COLLECTION_PERMISSION_DENIED/);
    assert.throws(() => saveCollectionSchedule(f.db, actor, f.input({ expected_schedule_id: null, expected_schedule_revision: 1, idempotency_key: "identity-conflict" }), { now }), /COLLECTION_SCHEDULE_CONFLICT/);
    assert.throws(() => saveCollectionSchedule(f.db, actor, f.input({ expected_schedule_id: f.saved.schedule_id, expected_schedule_revision: 1, idempotency_key: "scope-conflict", definition_json: JSON.stringify({ ...definition, currencies: ["EUR"] }) }), { now }), /COLLECTION_SCHEDULE_CONFLICT/);
    const other = saveCollectionSchedule(f.db, actor, f.input({ portfolio_id: f.other, idempotency_key: "other" }), { now });
    setCollectionScheduleStatus(f.db, actor, f.status(), { now });
    assert.throws(() => setCollectionScheduleStatus(f.db, actor, f.status({ portfolio_id: f.other, schedule_id: other.schedule_id }), { now }), /COLLECTION_SCOPE_CONFLICT/);
    assert.throws(() => setCollectionScheduleStatus(f.db, actor, f.status({ portfolio_id: f.other }), { now }), /COLLECTION_OUT_OF_SCOPE/);
    assert.throws(() => setCollectionScheduleStatus(f.db, actor, f.status({ expected_schedule_revision: 2, status: "paused", idempotency_key: "clock" }), { now: "2025-12-31T23:59:59.999999Z" }), /COLLECTION_INVALID_CLOCK/);
  } finally { f.close(); }
});
test("future triggers never backfill old dates and parsing preserves neither caller metadata nor invalid dates", () => {
  const d = parseCollectionDefinition(JSON.stringify(definition));
  assert.equal(firstFutureTrigger(d, "2026-01-01T12:30:00.000000Z"), "2026-01-01T12:30:00.000000Z");
  assert.equal(firstFutureTrigger(d, "2026-01-01T12:30:00.000001Z"), "2026-01-02T12:30:00.000000Z");
  assert.equal(firstFutureTrigger({ ...d, end_date: "2026-01-01" }, "2026-01-01T12:30:00.000001Z"), null);
  for (const raw of ["\uFEFF{}", '{"x":1,"x":2}', JSON.stringify({ ...definition, currencies: ["USD", "USD"] }), JSON.stringify({ ...definition, timezone: "Europe/Berlin" }), JSON.stringify({ ...definition, start_date: "2026-02-30" }), JSON.stringify({ ...definition, publish: false }), JSON.stringify({ ...definition, url: "https://synthetic.invalid" }), JSON.stringify({ ...definition, max_attempts: 6 })]) assert.throws(() => parseCollectionDefinition(raw), /COLLECTION_INVALID_DEFINITION/);
});
test("last-day enable permits the exact trigger instant but never one microsecond after it", () => {
  const f = fixture(); try {
    const d = { ...definition, end_date: "2026-01-01" }, at = "2026-01-01T12:30:00.000000Z", after = "2026-01-01T12:30:00.000001Z";
    saveCollectionSchedule(f.db, actor, f.input({ expected_schedule_id: f.saved.schedule_id, expected_schedule_revision: 1, definition_json: JSON.stringify(d), idempotency_key: "last-day" }), { now });
    assert.equal(firstFutureTrigger(parseCollectionDefinition(JSON.stringify(d)), at), at);
    assert.equal(firstFutureTrigger(parseCollectionDefinition(JSON.stringify(d)), after), null);
    assert.throws(() => setCollectionScheduleStatus(f.db, actor, f.status({ expected_schedule_revision: 2, idempotency_key: "too-late" }), { now: after }), /COLLECTION_NO_FUTURE_TRIGGER/);
    const receipt = setCollectionScheduleStatus(f.db, actor, f.status({ expected_schedule_revision: 2, idempotency_key: "on-time" }), { now: at });
    assert.equal(receipt.status, "enabled");
    assert.equal(getCollectionScheduleState(f.db, { portfolio_id: f.portfolio }, { now: at }).schedules[0].next_trigger_at, at);
    assert.equal(getCollectionScheduleState(f.db, { portfolio_id: f.portfolio }, { now: after }).schedules[0].next_trigger_at, null);
  } finally { f.close(); }
});
test("restore marker denies exact retry and pause but history reads remain zero-write", () => {
  const f = fixture(); try {
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "Synthetic restore guard\n");
    const before = f.db.prepare("SELECT total_changes() n").get();
    assert.throws(() => saveCollectionSchedule(f.db, actor, f.input(), { now }), /WORKBENCH_READ_ONLY/);
    assert.throws(() => setCollectionScheduleStatus(f.db, actor, f.status(), { now }), /WORKBENCH_READ_ONLY/);
    assert.equal(collectionReadOnly(f.db), true); assert.equal(readCollectionHistory(f.db, f.portfolio, f.saved.schedule_id).head.status, "paused");
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  } finally { f.close(); }
});
test("scheduled request verifies its original enabled interval; later pause never invents a replacement authorization", () => {
  const f = fixture(); try {
    const enabled = setCollectionScheduleStatus(f.db, actor, f.status(), { now: "2026-01-01T01:00:00.000000Z" });
    const head = readCollectionHistory(f.db, f.portfolio, f.saved.schedule_id).head;
    const payload = { provider: "ecb", feed: "daily", currencies: definition.currencies, expected_publication_revision: 0, publish: true };
    const request: CollectionRequestRow = { id: "synthetic-request", portfolio_id: f.portfolio, actor_id: "system:collection-discovery", command_type: "market_collect", payload_hash: hash(payload), payload_json: canonical(payload), created_at: "2026-01-01T12:30:00.000000Z" };
    f.db.prepare("INSERT INTO command_requests(id,portfolio_id,actor_id,command_type,payload_hash,payload_json,created_at,idempotency_key) VALUES(@id,@portfolio_id,@actor_id,@command_type,@payload_hash,@payload_json,@created_at,'synthetic-slot')").run(request);
    assert.throws(() => verifyScheduledCollectionRequest(f.db, request), /COLLECTION_EVIDENCE_INVALID/);
    f.db.prepare("INSERT INTO collection_schedule_slots(id,portfolio_id,scope_key,period,schedule_id,schedule_version_id,authorization_audit_id,authorization_revision,scheduled_at,deadline_at,created_at,disposition,reason_code,command_request_id,expected_publication_revision) VALUES(?,?,?,'2026-01-01',?,?,?,2,'2026-01-01T12:30:00.000000Z','2026-01-01T13:30:00.000000Z',?,'requested',NULL,?,0)").run("synthetic-slot", f.portfolio, enabled.scope_key, enabled.schedule_id, enabled.version_id, head.last_audit_id, request.created_at, request.id);
    assert.equal(verifyScheduledCollectionRequest(f.db, request)?.authorization.ended_at, null);
    setCollectionScheduleStatus(f.db, actor, f.status({ expected_schedule_revision: 2, status: "enabled", idempotency_key: "renew" }), { now: "2026-01-01T12:45:00.000000Z" });
    assert.equal(verifyScheduledCollectionRequest(f.db, request)?.authorization.ended_at, "2026-01-01T12:45:00.000000Z");
    setCollectionScheduleStatus(f.db, actor, f.status({ expected_schedule_revision: 3, status: "paused", idempotency_key: "pause" }), { now: "2026-01-01T13:00:00.000000Z" });
    assert.equal(verifyScheduledCollectionRequest(f.db, request)?.authorization.ended_at, "2026-01-01T12:45:00.000000Z");
    assert.throws(() => verifyScheduledCollectionRequest(f.db, { ...request, actor_id: actor.id }), /COLLECTION_EVIDENCE_INVALID/);
  } finally { f.close(); }
});

test("bounded consistent queries show explicit empty states, preserve scope and perform no writes in recovery", () => {
  const f = fixture(); try {
    const state = getCollectionScheduleState(f.db, { portfolio_id: f.portfolio }, { now });
    assert.equal(state.schedules[0].current_version.definition_json, f.input().definition_json);
    assert.equal(state.schedules[0].status, "paused"); assert.equal(state.schedules[0].next_trigger_at, null);
    assert.deepEqual(state.slots, []); assert.equal(state.next_cursor, null);
    assert.deepEqual(getCollectionScheduleState(f.db, { portfolio_id: f.other }, { now }).schedules, []);
    assert.throws(() => getCollectionScheduleState(f.db, { portfolio_id: f.other, schedule_id: f.saved.schedule_id }, { now }), /COLLECTION_OUT_OF_SCOPE/);
    for (const input of [{ limit: 51 }, { cursor: "not-a-cursor" }, { unknown: true }]) assert.throws(() => getCollectionScheduleState(f.db, { portfolio_id: f.portfolio, ...input }, { now }), /COLLECTION_INVALID_QUERY/);
    assert.throws(() => getCollectionSlot(f.db, { portfolio_id: f.portfolio, slot_id: "absent" }, { now }), /COLLECTION_SLOT_NOT_FOUND/);
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "Synthetic marker\n");
    const count = f.db.prepare("SELECT total_changes() n").get();
    assert.equal(getCollectionScheduleState(f.db, { portfolio_id: f.portfolio }, { now }).read_only, true);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), count);
  } finally { f.close(); }
});

test("equal-trigger authorization is valid while historical prefix excludes unrelated later controls", () => {
  const f = fixture(); try {
    const at = "2026-01-01T12:30:00.000000Z";
    setCollectionScheduleStatus(f.db, actor, f.status(), { now: at });
    const head = readCollectionHistory(f.db, f.portfolio, f.saved.schedule_id).head;
    const payload = { provider: "ecb", feed: "daily", currencies: definition.currencies, expected_publication_revision: 0, publish: true };
    const request: CollectionRequestRow = { id: "equal-request", portfolio_id: f.portfolio, actor_id: "system:collection-discovery", command_type: "market_collect", payload_hash: hash(payload), payload_json: canonical(payload), created_at: at };
    f.db.prepare("INSERT INTO command_requests(id,portfolio_id,actor_id,command_type,payload_hash,payload_json,created_at,idempotency_key) VALUES(@id,@portfolio_id,@actor_id,@command_type,@payload_hash,@payload_json,@created_at,'equal-slot')").run(request);
    f.db.prepare("INSERT INTO collection_schedule_slots VALUES(?,?,?,'2026-01-01',?,?,?,2,?,'2026-01-01T13:30:00.000000Z',?,'requested',NULL,?,0)").run("equal-slot", f.portfolio, f.saved.scope_key, f.saved.schedule_id, f.saved.version_id, head.last_audit_id, at, at, request.id);
    assert.equal(verifyScheduledCollectionRequest(f.db, request)?.authorization.created_at, at);
    assert.equal(getCollectionSlot(f.db, { portfolio_id: f.portfolio, slot_id: "equal-slot" }, { now: at }).slot.job, null);
    assert.throws(() => getCollectionSlot(f.db, { portfolio_id: f.other, slot_id: "equal-slot" }, { now: at }), /COLLECTION_OUT_OF_SCOPE/);
    setCollectionScheduleStatus(f.db, actor, f.status({ expected_schedule_revision: 2, status: "paused", idempotency_key: "end-original" }), { now: "2026-01-01T12:45:00.000000Z" });
    setCollectionScheduleStatus(f.db, actor, f.status({ expected_schedule_revision: 3, idempotency_key: "later-enable" }), { now: "2026-01-02T00:00:00.000000Z" });
    const later = readCollectionHistory(f.db, f.portfolio, f.saved.schedule_id).head.last_audit_id;
    for (const row of f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_events'").all() as { name: string }[]) f.db.exec(`DROP TRIGGER "${row.name.replaceAll('"', '""')}"`);
    f.db.prepare("UPDATE audit_events SET payload_json='{}' WHERE id=?").run(later);
    assert.throws(() => readCollectionHistory(f.db, f.portfolio, f.saved.schedule_id), /COLLECTION_EVIDENCE_INVALID/);
    assert.equal(verifyScheduledCollectionRequest(f.db, request)?.authorization.ended_at, "2026-01-01T12:45:00.000000Z");
    assert.equal(getCollectionSlot(f.db, { portfolio_id: f.portfolio, slot_id: "equal-slot" }, { now: "2026-01-02T00:00:00.000000Z" }).version.id, f.saved.version_id);
    f.db.prepare("UPDATE audit_events SET payload_json='{}' WHERE id=?").run(head.last_audit_id);
    assert.throws(() => verifyScheduledCollectionRequest(f.db, request), /COLLECTION_EVIDENCE_INVALID/);
  } finally { f.close(); }
});

test("missed-slot reason follows the first deadline and bounded keyset pages cannot move across portfolio scope", () => {
  for (const ends of ["2026-01-01T13:00:00.000000Z", "2026-01-01T13:30:00.000000Z", "2026-01-01T14:00:00.000000Z"]) {
    const f = fixture(); try {
      setCollectionScheduleStatus(f.db, actor, f.status(), { now });
      const head = readCollectionHistory(f.db, f.portfolio, f.saved.schedule_id).head;
      setCollectionScheduleStatus(f.db, actor, f.status({ expected_schedule_revision: 2, status: "paused", idempotency_key: "end" }), { now: ends });
      const reason = ends < "2026-01-01T13:30:00.000000Z" ? "AUTHORIZATION_ENDED" : "DEADLINE_EXPIRED";
      f.db.prepare("INSERT INTO collection_schedule_slots VALUES(?,?,?,'2026-01-01',?,?,?,2,'2026-01-01T12:30:00.000000Z','2026-01-01T13:30:00.000000Z','2026-01-01T15:00:00.000000Z','missed',?,NULL,NULL)").run("missed-slot", f.portfolio, f.saved.scope_key, f.saved.schedule_id, f.saved.version_id, head.last_audit_id, reason);
      const detail = () => getCollectionSlot(f.db, { portfolio_id: f.portfolio, slot_id: "missed-slot" }, { now: "2026-01-01T15:00:00.000000Z" });
      assert.equal(detail().slot.reason_code, reason); assert.deepEqual(detail().attempts, []);
      for (const row of f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='collection_schedule_slots'").all() as { name: string }[]) f.db.exec(`DROP TRIGGER "${row.name.replaceAll('"', '""')}"`);
      f.db.prepare("UPDATE collection_schedule_slots SET reason_code=?").run(reason === "AUTHORIZATION_ENDED" ? "DEADLINE_EXPIRED" : "AUTHORIZATION_ENDED");
      assert.throws(detail, /COLLECTION_EVIDENCE_INVALID/);
    } finally { f.close(); }
  }
  const f = fixture(); try {
    setCollectionScheduleStatus(f.db, actor, f.status(), { now });
    const head = readCollectionHistory(f.db, f.portfolio, f.saved.schedule_id).head;
    for (const day of ["2026-01-01", "2026-01-02", "2026-01-03"]) f.db.prepare("INSERT INTO collection_schedule_slots VALUES(?,?,?,?,?,?,?,2,?,?,?,'missed','DEADLINE_EXPIRED',NULL,NULL)").run(`missed-${day}`, f.portfolio, f.saved.scope_key, day, f.saved.schedule_id, f.saved.version_id, head.last_audit_id, `${day}T12:30:00.000000Z`, `${day}T13:30:00.000000Z`, `${day}T13:30:00.000000Z`);
    const first = getCollectionScheduleState(f.db, { portfolio_id: f.portfolio, limit: 1 }, { now: "2026-01-04T00:00:00.000000Z" });
    assert.equal(first.slots[0].period, "2026-01-03"); assert.ok(first.next_cursor);
    const second = getCollectionScheduleState(f.db, { portfolio_id: f.portfolio, limit: 1, cursor: first.next_cursor }, { now: "2026-01-04T00:00:00.000000Z" });
    assert.equal(second.slots[0].period, "2026-01-02");
    assert.throws(() => getCollectionScheduleState(f.db, { portfolio_id: f.other, cursor: first.next_cursor }, { now }), /COLLECTION_INVALID_QUERY/);
    assert.throws(() => getCollectionScheduleState(f.db, { portfolio_id: f.portfolio, schedule_id: f.saved.schedule_id, cursor: first.next_cursor }, { now }), /COLLECTION_INVALID_QUERY/);
  } finally { f.close(); }
});

test("control cap reserves the final revision for pause; exact retries survive cap and same-status audit history remains valid", () => {
  const f = fixture(); try {
    f.db.transaction(() => {
      for (let revision = 2; revision <= 1023; revision++) {
        const input = f.status({ expected_schedule_revision: revision - 1, idempotency_key: `bounded-${revision}` });
        const result = { ...f.saved, schedule_revision: revision, status: "enabled" };
        const auditId = audit(f.db, actor, "set_collection_schedule_status", "collection_schedule", f.saved.schedule_id, f.portfolio, null, { actor_kind: "human", input, result }, now);
        f.db.prepare("INSERT INTO collection_schedule_controls VALUES(?,?,?,'enabled',?,?)").run(f.saved.schedule_id, revision, f.saved.version_id, auditId, now);
        f.db.prepare("UPDATE collection_schedule_heads SET revision=?,status='enabled',last_audit_id=?,updated_at=? WHERE schedule_id=?").run(revision, auditId, now, f.saved.schedule_id);
      }
    }).immediate();
    assert.equal(readCollectionHistory(f.db, f.portfolio, f.saved.schedule_id).controls.length, 1023);
    assert.throws(() => saveCollectionSchedule(f.db, actor, f.input({ expected_schedule_id: f.saved.schedule_id, expected_schedule_revision: 1023, idempotency_key: "cap-save" }), { now }), /COLLECTION_LIMIT_REACHED/);
    assert.throws(() => setCollectionScheduleStatus(f.db, actor, f.status({ expected_schedule_revision: 1023, idempotency_key: "cap-enable" }), { now }), /COLLECTION_LIMIT_REACHED/);
    const pause = f.status({ expected_schedule_revision: 1023, status: "paused", idempotency_key: "final-pause" });
    const receipt = setCollectionScheduleStatus(f.db, actor, pause, { now });
    assert.equal(receipt.schedule_revision, 1024); assert.equal(receipt.status, "paused");
    assert.equal(readCollectionHistory(f.db, f.portfolio, f.saved.schedule_id).controls.length, 1024);
    assert.deepEqual(setCollectionScheduleStatus(f.db, actor, pause, { now }), receipt);
    assert.deepEqual(saveCollectionSchedule(f.db, actor, f.input(), { now }), f.saved);
    assert.throws(() => setCollectionScheduleStatus(f.db, actor, f.status({ expected_schedule_revision: 1024, idempotency_key: "exhausted" }), { now }), /COLLECTION_LIMIT_REACHED/);
  } finally { f.close(); }
});
