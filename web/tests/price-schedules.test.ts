import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonical, hash } from "../src/server/ledger/service";
import { firstFuturePriceTrigger, parsePriceCollectionDefinition, priceTriggerAt, readPriceCollectionHistory } from "../src/server/price-schedules/core";
import { savePriceCollectionSchedule, setPriceCollectionScheduleStatus } from "../src/server/price-schedules/service";
import { getPriceCollectionScheduleState, getPriceCollectionSlot } from "../src/server/price-schedules/queries";
import { verifyScheduledPriceCollectionRequest, type PriceCollectionRequestRow } from "../src/server/price-schedules/verification";
import { priceActor as actor, priceNow as now, priceDue as due, priceScheduleFixture as fixture } from "./price-schedule-service-fixture";

function discover(f: ReturnType<typeof fixture>, at = due) {
  const script = "import json,sys;from worker.orchestration.db import open_database;from worker.orchestration.price_collections import discover_due_price_collections;d=open_database(sys.argv[1]);print(json.dumps(discover_due_price_collections(d,now=sys.argv[2])));d.close()";
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.PYTHON ?? "python3", ["-c", script, f.filename, at], { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 30000 })) as string[];
}
test("future reviewed price range saves paused and exact raw bytes without any recurring work or investment facts", () => {
  const f = fixture(); try {
    const state = getPriceCollectionScheduleState(f.db, { portfolio_id: f.portfolio }, { now });
    assert.equal(state.schedules[0].status, "paused"); assert.equal(state.schedules[0].next_trigger_at, null);
    assert.equal(state.reference_candidates.length, 2); assert.equal(state.schedules[0].reference_status, "current");
    assert.equal(state.schedules[0].current_version.definition_json, f.input().definition_json);
    assert.equal(state.schedules[0].current_version.reference_binding.known_at, now);
    assert.equal(f.saved.scope_key, "provider:longport:prices:" + hash({ portfolio_id: f.portfolio, market: "CN", listing_ids: ["CN:PRICE"] }));
    assert.deepEqual(savePriceCollectionSchedule(f.db, actor, f.input(), { now }), f.saved);
    for (const name of ["price_collection_schedule_slots", "command_requests", "job_runs", "market_sdk_captures", "ledger_events", "activations", "approval_events"]) assert.equal((f.db.prepare(`SELECT COUNT(*) n FROM ${name}`).get() as { n: number }).n, 0, name);
  } finally { f.close(); }
});
test("explicit enable/pause/edit keep immutable authorization intervals and idempotent replay never reenables", () => {
  const f = fixture(); try {
    const enabled = f.enable();
    assert.equal(getPriceCollectionScheduleState(f.db, { portfolio_id: f.portfolio }, { now }).schedules[0].next_trigger_at, due);
    const pause = f.status({ expected_schedule_revision: 2, status: "paused", idempotency_key: "pause" });
    setPriceCollectionScheduleStatus(f.db, actor, pause, { now: "2026-01-01T01:00:00.000000Z" });
    assert.deepEqual(setPriceCollectionScheduleStatus(f.db, actor, f.status(), { now: "2026-01-01T02:00:00.000000Z" }), enabled);
    assert.equal(readPriceCollectionHistory(f.db, f.portfolio, f.saved.schedule_id).head.status, "paused");
    const next = savePriceCollectionSchedule(f.db, actor, f.input({ expected_schedule_id: f.saved.schedule_id, expected_schedule_revision: 3, idempotency_key: "version2" }), { now: "2026-01-01T03:00:00.000000Z" });
    assert.equal(next.version, 2); assert.equal(next.schedule_revision, 4); assert.equal(next.scope_key, f.saved.scope_key); assert.equal(next.status, "paused");
  } finally { f.close(); }
});
test("definition timing is next local calendar day; DST gaps folds and overlapping windows reject before authorization", () => {
  const f = fixture(); try {
    const d = parsePriceCollectionDefinition(f.input().definition_json);
    assert.equal(priceTriggerAt(d, "2026-01-02"), due);
    assert.deepEqual(firstFuturePriceTrigger(d, due), { period: "2026-01-02", scheduled_at: due });
    assert.equal(firstFuturePriceTrigger(d, "2026-01-02T16:00:00.000001Z")?.period, "2026-01-03");
    const us = { ...d, market: "US", timezone: "America/New_York" };
    for (const [start_date, trigger_local] of [["2026-03-07", { hour: 2, minute: 30 }], ["2026-10-31", { hour: 1, minute: 30 }]] as const)
      assert.throws(() => parsePriceCollectionDefinition(JSON.stringify({ ...us, start_date, end_date: start_date, trigger_local })), /INVALID_TRIGGER/);
    assert.throws(() => parsePriceCollectionDefinition(JSON.stringify({ ...us, start_date: "2026-03-06", end_date: "2026-03-07", trigger_local: { hour: 4, minute: 0 }, deadline_seconds: 86400 })), /OVERLAPPING_WINDOWS/);
    assert.equal(priceTriggerAt(parsePriceCollectionDefinition(JSON.stringify({ ...us, start_date: "2026-03-07", end_date: "2026-03-07", trigger_local: { hour: 4, minute: 0 } })), "2026-03-07"), "2026-03-08T08:00:00.000000Z");
  } finally { f.close(); }
});
test("strict finite definition rejects invalid ranges duplicates timezone drift raw JSON and provider authority fields", () => {
  const f = fixture(); try {
    for (const patch of [{ timezone: "UTC" }, { end_date: null }, { end_date: "2026-01-01" }, { end_date: "2040-01-01" }, { start_date: "2026-02-30" }, { publish: false }, { provider: "ecb" }, { mapping_version_ids: [f.mapped.id, f.mapped.id] }, { trigger_local: { hour: 24, minute: 0 } }, { url: "https://synthetic.invalid" }]) assert.throws(() => parsePriceCollectionDefinition(JSON.stringify({ ...f.definition, ...patch })), /INVALID_DEFINITION/);
    for (const raw of ["\uFEFF" + f.input().definition_json, f.input().definition_json.replace('"provider": "longport"', '"provider":"longport","provider":"longport"')]) assert.throws(() => parsePriceCollectionDefinition(raw), /INVALID_DEFINITION/);
    assert.throws(() => parsePriceCollectionDefinition(" ".repeat(65537)), /DEFINITION_TOO_LARGE/);
  } finally { f.close(); }
});
test("save verifies future full reference coverage and private ownership rather than merely trusting version IDs", () => {
  const f = fixture(); try {
    for (const patch of [{ end_date: "2026-01-06" }, { mapping_version_ids: [f.calendared.id] }, { calendar_version_ids: [f.mapped.id] }, { mapping_version_ids: ["missing"] }, { market: "US", timezone: "America/New_York" }])
      assert.throws(() => savePriceCollectionSchedule(f.db, actor, f.input({ idempotency_key: "bad", definition_json: JSON.stringify({ ...f.definition, ...patch }) }), { now }), /REFERENCE_INVALID/);
    assert.throws(() => savePriceCollectionSchedule(f.db, actor, f.input({ portfolio_id: f.other, idempotency_key: "foreign" }), { now }), /REFERENCE_INVALID/);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM price_collection_schedules").get() as { n: number }).n, 1);
  } finally { f.close(); }
});
test("reference revision pauses no existing history but blocks old-version enabling and forces explicit reauthorization", () => {
  const f = fixture(); try {
    f.enable();
    const updated = f.review(f.mapping, "mapping-next", 1, "2026-01-01T01:00:00.000000Z");
    const state = getPriceCollectionScheduleState(f.db, { portfolio_id: f.portfolio }, { now: "2026-01-01T02:00:00.000000Z" });
    assert.equal(state.schedules[0].reference_status, "changed");
    assert.throws(() => setPriceCollectionScheduleStatus(f.db, actor, f.status({ expected_schedule_revision: 2, idempotency_key: "reenable" }), { now: "2026-01-01T02:00:00.000000Z" }), /REFERENCE_CHANGED/);
    const receipt = savePriceCollectionSchedule(f.db, actor, f.input({ expected_schedule_id: f.saved.schedule_id, expected_schedule_revision: 2, idempotency_key: "new-mapping", definition_json: JSON.stringify({ ...f.definition, mapping_version_ids: [updated.id] }) }), { now: "2026-01-01T02:00:00.000000Z" });
    assert.equal(receipt.scope_key, f.saved.scope_key); assert.equal(receipt.status, "paused");
    assert.deepEqual(savePriceCollectionSchedule(f.db, actor, f.input(), { now: "2026-01-01T03:00:00.000000Z" }), f.saved);
  } finally { f.close(); }
});
test("human identity acknowledgement reason codepoints CAS and idempotency are authoritative and atomic", () => {
  const f = fixture(); try {
    for (const id of ["system", "SYSTEM:operator", "", "x".repeat(161)]) assert.throws(() => setPriceCollectionScheduleStatus(f.db, { ...actor, id }, f.status(), { now }), /PERMISSION_DENIED/);
    assert.throws(() => setPriceCollectionScheduleStatus(f.db, { ...actor, kind: "ai" }, f.status(), { now }), /PERMISSION_DENIED/);
    for (const patch of [{ acknowledgement: false }, { reason: " " }, { reason: "x\0y" }, { reason: "\ud800" }, { reason: "x\u0085y" }, { reason: "x".repeat(1001) }, { idempotency_key: "bad/key" }, { at: now }]) assert.throws(() => setPriceCollectionScheduleStatus(f.db, actor, f.status(patch), { now }), /INVALID_COMMAND/);
    assert.equal(setPriceCollectionScheduleStatus(f.db, actor, f.status({ reason: "😀".repeat(1000) }), { now }).status, "enabled");
    assert.throws(() => setPriceCollectionScheduleStatus(f.db, actor, f.status({ idempotency_key: "new", expected_schedule_revision: 1 }), { now }), /SCHEDULE_CONFLICT/);
    assert.throws(() => savePriceCollectionSchedule(f.db, actor, f.input({ expected_schedule_revision: 1 }), { now }), /IDEMPOTENCY_CONFLICT/);
  } finally { f.close(); }
});
test("dedup alias replacement cannot replay a different command or actor as a valid human authorization", () => {
  const f = fixture(); try {
    const original = f.db.prepare("SELECT * FROM command_dedup WHERE scope=? AND idempotency_key='save'").get(`price-collection:save:${f.portfolio}`) as Record<string, unknown>;
    for (const selectedActor of [actor, { ...actor, id: "another-human" }]) {
      const input = f.input({ idempotency_key: "alias", reason: "Changed authorization request" }); const { idempotency_key, ...semantic } = input;
      f.db.prepare("INSERT OR REPLACE INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(original.scope, idempotency_key, hash({ actor_id: selectedActor.id, input: semantic }), original.result_json, original.created_at);
      assert.throws(() => savePriceCollectionSchedule(f.db, selectedActor, input, { now }), /IDEMPOTENCY_CONFLICT/);
    }
  } finally { f.close(); }
});
test("ordinary provider-role discovery yields scoped immutable requested closed half-day and missed history", () => {
  const f = fixture(); try {
    f.enable(); assert.equal(discover(f).length, 1); assert.deepEqual(discover(f), []);
    const [slot] = getPriceCollectionScheduleState(f.db, { portfolio_id: f.portfolio }, { now: due }).slots;
    assert.equal(slot.period, "2026-01-02"); assert.equal(slot.disposition, "requested"); assert.equal(slot.job, null);
    const request = f.db.prepare("SELECT * FROM command_requests WHERE id=?").get(slot.command_request_id) as PriceCollectionRequestRow;
    assert.equal(verifyScheduledPriceCollectionRequest(f.db, request)?.authorization.ended_at, null);
    assert.equal(getPriceCollectionSlot(f.db, { portfolio_id: f.portfolio, slot_id: slot.id }, { now: due }).attempts.length, 0);
    assert.throws(() => getPriceCollectionSlot(f.db, { portfolio_id: f.other, slot_id: slot.id }, { now: due }), /OUT_OF_SCOPE/);
    discover(f, "2026-01-03T16:00:00.000000Z"); discover(f, "2026-01-04T16:00:00.000000Z"); discover(f, "2026-01-05T18:00:00.000000Z");
    const state = getPriceCollectionScheduleState(f.db, { portfolio_id: f.portfolio }, { now: "2026-01-05T18:00:00.000000Z" });
    assert.deepEqual(state.slots.map(item => [item.period, item.disposition, item.reason_code]), [["2026-01-05", "missed", "DEADLINE_EXPIRED"], ["2026-01-04", "requested", null], ["2026-01-03", "skipped", "MARKET_CLOSED"], ["2026-01-02", "requested", null]]);
    const page = getPriceCollectionScheduleState(f.db, { portfolio_id: f.portfolio, limit: 2 }, { now: "2026-01-05T18:00:00.000000Z" }); assert.ok(page.next_cursor);
    assert.equal(getPriceCollectionScheduleState(f.db, { portfolio_id: f.portfolio, limit: 2, cursor: page.next_cursor! }, { now: "2026-01-05T18:00:00.000000Z" }).slots[0].period, "2026-01-03");
    assert.throws(() => getPriceCollectionScheduleState(f.db, { portfolio_id: f.other, cursor: page.next_cursor! }, { now: due }), /INVALID_QUERY/);
  } finally { f.close(); }
});
test("pause preserves original requested interval and prevents new writes in read-only recovery", () => {
  const f = fixture(); try {
    f.enable(); discover(f);
    const request = f.db.prepare("SELECT * FROM command_requests").get() as PriceCollectionRequestRow;
    setPriceCollectionScheduleStatus(f.db, actor, f.status({ expected_schedule_revision: 2, idempotency_key: "pause", status: "paused" }), { now: "2026-01-02T16:00:01.000000Z" });
    assert.equal(verifyScheduledPriceCollectionRequest(f.db, request)?.authorization.ended_at, "2026-01-02T16:00:01.000000Z");
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "Synthetic restore guard\n"); const before = f.db.prepare("SELECT total_changes() n").get();
    assert.throws(() => savePriceCollectionSchedule(f.db, actor, f.input(), { now }), /WORKBENCH_READ_ONLY/);
    assert.equal(getPriceCollectionScheduleState(f.db, { portfolio_id: f.portfolio }, { now: "2026-01-02T17:00:00.000000Z" }).read_only, true);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  } finally { f.close(); }
});
test("self-rehashed saved reference binding and forged closed disposition cannot become independently verified history", () => {
  const f = fixture(); try {
    const version = readPriceCollectionHistory(f.db, f.portfolio, f.saved.schedule_id).versions.get(f.saved.version_id)!;
    const forged = { ...version.reference_binding, known_at: "2026-01-01T00:00:00.000001Z" };
    f.db.exec("DROP TRIGGER price_collection_version_no_update");
    f.db.prepare("UPDATE price_collection_schedule_versions SET reference_binding_json=?,reference_binding_hash=? WHERE id=?").run(canonical(forged), hash(forged), f.saved.version_id);
    assert.throws(() => getPriceCollectionScheduleState(f.db, { portfolio_id: f.portfolio }, { now }), /EVIDENCE_INVALID/);
  } finally { f.close(); }
});
