import assert from "node:assert/strict";
import test from "node:test";
import { assertPriceScheduleDetail, assertPriceScheduleReceipt, assertPriceScheduleState, draftFromDefinition, emptyPriceScheduleDraft, preparePriceScheduleAttempt } from "../src/components/workbench/price-schedule-client";
import { priceBinding as binding, priceDefinition, priceDetail, priceDraft, priceReceipt, priceState } from "./price-schedule-test-fixture";

test("price draft has no default market, reference, dates, timing, personal parameters or acknowledgement", () => {
  const draft = emptyPriceScheduleDraft();
  assert.deepEqual(draft, { operation: "save", scheduleId: "", market: "", mappingIds: [], calendarIds: [], startDate: "", endDate: "", hour: "", minute: "", deadline: "", maxAttempts: "", reason: "" });
  assert.deepEqual(draftFromDefinition("s", priceDefinition()), { ...priceDraft(), scheduleId: "s", reason: "" });
});
test("typed explicit fields save paused with fixed definition, complete refs and exact byte hash receipt", async () => {
  const pending = await preparePriceScheduleAttempt(priceState(), priceDraft(), binding, "synthetic-key"), envelope = JSON.parse(pending.body);
  assert.equal(envelope.action, "save_schedule"); assert.equal(envelope.command.acknowledgement, true); assert.equal(envelope.command.expected_schedule_revision, 0);
  assert.deepEqual(JSON.parse(envelope.command.definition_json), priceDefinition()); assert.equal(pending.expected.status, "paused");
  assertPriceScheduleReceipt(priceReceipt(pending.body), pending);
  for (const change of [{ status: "enabled" }, { schedule_revision: 2 }, { scope_key: "foreign" }, { content_hash: "f".repeat(64) }, { session_binding: "b".repeat(64) }, { extra: true }])
    assert.throws(() => assertPriceScheduleReceipt({ ...priceReceipt(pending.body), ...change }, pending), /RECEIPT_INVALID/);
});
test("strict typed draft rejects missing/invalid finite range, numeric coercions, incomplete or unavailable refs and reasons", async () => {
  for (const change of [{ market: "" }, { mappingIds: [] }, { calendarIds: [] }, { mappingIds: ["mapping-synthetic", "mapping-synthetic"] }, { calendarIds: ["missing"] },
    { startDate: "2030-02-30" }, { endDate: "" }, { endDate: "2029-12-31" }, { endDate: "2050-01-01" }, { hour: "" }, { hour: "2e0" }, { minute: "60" }, { deadline: "59" }, { maxAttempts: "6" },
    { reason: " " }, { reason: "x\ud800" }, { reason: "x\udfff" }, { reason: "x\u0000" }]) {
    await assert.rejects(preparePriceScheduleAttempt(priceState(), { ...priceDraft(), ...change } as ReturnType<typeof priceDraft>, binding, "key"), /PRICE_SCHEDULE_/);
  }
  await preparePriceScheduleAttempt(priceState(), { ...priceDraft(), reason: "SYNTHETIC \ud83d\ude00" }, binding, "key");
  for (const mutate of [(s: ReturnType<typeof priceState>) => { s.reference_candidates[0].market = "US"; }, (s: ReturnType<typeof priceState>) => { s.reference_candidates[1].range_end = "2030-01-03"; },
    (s: ReturnType<typeof priceState>) => { s.reference_candidates[1].exchange = "FOREIGN"; }, (s: ReturnType<typeof priceState>) => { s.reference_candidates[0].range_end = "2030-01-04"; }]) {
    const state = priceState(); mutate(state); await assert.rejects(preparePriceScheduleAttempt(state, priceDraft(), binding, "key"), /REFERENCES_REQUIRED/);
  }
});
test("status enable and pause require explicit saved schedule, fresh CAS, human reason and reviewed scope", async () => {
  for (const operation of ["enabled", "paused"] as const) {
    const state = priceState("p", true), draft = { ...priceDraft(), scheduleId: "schedule-synthetic", operation };
    const pending = await preparePriceScheduleAttempt(state, draft, binding, "key"), body = JSON.parse(pending.body);
    assert.equal(body.action, "set_status"); assert.equal(body.command.status, operation); assert.equal(body.command.expected_schedule_revision, 1);
    assert.equal("definition_json" in body.command, false); assertPriceScheduleReceipt(priceReceipt(pending.body), pending);
  }
  const stale = priceState("p", true); stale.schedules[0].reference_status = "changed";
  await assert.rejects(preparePriceScheduleAttempt(stale, { ...priceDraft(), scheduleId: "schedule-synthetic", operation: "enabled" }, binding, "key"), /REFERENCES_REQUIRED/);
  await preparePriceScheduleAttempt(stale, { ...priceDraft(), scheduleId: "schedule-synthetic", operation: "paused" }, binding, "key");
  stale.read_only = true; await assert.rejects(preparePriceScheduleAttempt(stale, priceDraft(), binding, "key"), /WRITE_LOCKED/);
  await assert.rejects(preparePriceScheduleAttempt(priceState("p", true), priceDraft(), binding, "key"), /CONFLICT/);
});
test("state and historical detail are strict, scoped, binding-checked and independently hash-checked", async () => {
  const state = { ...priceState("p", true, true), session_binding: binding }, detail = { ...priceDetail(), session_binding: binding };
  await assertPriceScheduleState(state, "p", null, binding); await assertPriceScheduleDetail(detail, "p", "slot-synthetic", binding);
  for (const mutate of [(s: typeof state) => { s.session_binding = "b".repeat(64); }, (s: typeof state) => { s.selected_portfolio_id = "q"; },
    (s: typeof state) => { s.schedules[0].current_version.definition_json += " "; }, (s: typeof state) => { s.schedules[0].current_version.reference_binding.portfolio_id = "q"; },
    (s: typeof state) => { s.slots[0].reference_binding_hash = "f".repeat(64); }, (s: typeof state) => { s.slots[0].portfolio_id = "q"; },
    (s: typeof state) => { s.slots[0].disposition = "missed"; }, (s: typeof state) => { s.schedules[0].next_target_date = "2030-01-02"; },
    (s: typeof state) => { s.schedules[0].scope_key = "foreign-scope"; }, (s: typeof state) => { s.slots[0].scope_key = "foreign-scope"; }]) {
    const changed = structuredClone(state); mutate(changed); await assert.rejects(assertPriceScheduleState(changed, "p", null, binding), /RESPONSE_INVALID/);
  }
  await assert.rejects(assertPriceScheduleState({ ...state, extra: true }, "p", null, binding), /RESPONSE_INVALID/);
  await assert.rejects(assertPriceScheduleDetail(detail, "q", "slot-synthetic", binding), /RESPONSE_INVALID/);
  await assert.rejects(assertPriceScheduleDetail(detail, "p", "wrong", binding), /RESPONSE_INVALID/);
});
test("skipped/blocked/missed do not masquerade as requests or published price captures", async () => {
  for (const disposition of ["skipped", "blocked", "missed"] as const) {
    const state = priceState("p", true, true); Object.assign(state.slots[0], { disposition, reason_code: disposition === "skipped" ? "MARKET_CLOSED" : "SYNTHETIC_REASON", command_request_id: null, expected_publication_revision: null, job: null, capture: null });
    await assertPriceScheduleState({ ...state, session_binding: binding }, "p", null, binding);
    state.slots[0].capture = priceState("p", true, true).slots[0].capture;
    await assert.rejects(assertPriceScheduleState({ ...state, session_binding: binding }, "p", null, binding), /RESPONSE_INVALID/);
  }
});
