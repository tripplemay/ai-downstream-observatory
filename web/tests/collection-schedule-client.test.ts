import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertCollectionReceipt, assertCollectionState, emptyCollectionDraft, prepareCollectionAttempt } from "../src/components/workbench/collection-schedule-client";
import type { CollectionScheduleDefinition, CollectionScheduleState } from "../src/server/market-schedules/types";

const binding = "a".repeat(64), now = "2026-01-01T00:00:00.000000Z";
const definition: CollectionScheduleDefinition = { schema_version: "collection-schedule-v1", provider: "ecb", feed: "daily", currencies: ["USD"], frequency: "daily", timezone: "UTC", start_date: "2026-01-02", end_date: null, trigger: { hour: 12, minute: 1 }, deadline_seconds: 600, max_attempts: 2, publish: true, missed_policy: "record_no_backfill" };
const raw = JSON.stringify(definition, null, 2) + "\n", digest = createHash("sha256").update(raw).digest("hex");
function state(existing = false): CollectionScheduleState {
  return { schema_version: "collection-schedules-v1", portfolios: [{ id: "p", name: "Synthetic only" }], portfolios_truncated: false, selected_portfolio_id: "p", read_only: false, server_now: now, schedules: existing ? [{ id: "s", portfolio_id: "p", scope_key: "provider:ecb:fx:daily:USD", schedule_revision: 2, status: "enabled", current_version: { id: "v", version: 1, definition_json: raw, definition, content_hash: digest, created_by: "synthetic-human", created_at: now, audit_id: "a" }, last_audit_id: "b", updated_at: now, next_trigger_at: "2026-01-02T12:01:00.000000Z" }] : [], schedules_truncated: false, slots: [], next_cursor: null };
}
test("empty draft contains no currencies, time or consent; explicit save freezes exact UTF8 hash and paused identity", async () => {
  assert.deepEqual(emptyCollectionDraft(), { operation: "save", scheduleId: "", definitionJson: "", reason: "" });
  const attempt = await prepareCollectionAttempt(state(), { ...emptyCollectionDraft(), definitionJson: raw, reason: "Explicit synthetic polling" }, binding, "key");
  assert.equal(attempt.expected.status, "paused"); assert.equal(attempt.expected.version, 1); assert.equal(attempt.expected.content_hash, digest);
  const command = JSON.parse(attempt.body).command;
  assert.equal(command.expected_schedule_id, null); assert.equal(command.expected_schedule_revision, 0); assert.equal(command.definition_json, raw);
  assert.equal(command.acknowledgement, true); assert.equal(command.reason, "Explicit synthetic polling");
  assert.doesNotMatch(attempt.body, /ledger_revision|source_mode|pass|token|secret/);
});
test("read-only, absent reason, scope-changing edits and malformed raw text fail without guessing", async () => {
  const draft = { ...emptyCollectionDraft(), definitionJson: raw, reason: "Synthetic" };
  await assert.rejects(prepareCollectionAttempt({ ...state(), read_only: true }, draft, binding, "key"), /COLLECTION_WRITE_LOCKED/);
  await assert.rejects(prepareCollectionAttempt(state(), { ...draft, reason: " " }, binding, "key"), /COLLECTION_REASON_REQUIRED/);
  await assert.rejects(prepareCollectionAttempt(state(true), draft, binding, "key"), /COLLECTION_SCHEDULE_CONFLICT/);
  await assert.rejects(prepareCollectionAttempt(state(true), { ...draft, scheduleId: "s", definitionJson: JSON.stringify({ ...definition, currencies: ["EUR"] }) }, binding, "key"), /COLLECTION_SCHEDULE_CONFLICT/);
  for (const text of ["SYNTHETIC_PRIVATE_MARKER", '{"x":1,"x":2}', JSON.stringify({ ...definition, publish: false }), JSON.stringify({ ...definition, max_attempts: 6 }), JSON.stringify({ ...definition, trigger: { hour: 1, minute: 0, automatic: true } })]) {
    await assert.rejects(prepareCollectionAttempt(state(), { ...draft, definitionJson: text }, binding, "key"), error => error instanceof Error && error.message === "COLLECTION_INVALID_DEFINITION");
  }
});
test("save receipts must match frozen hash, version, scope, status, CAS and session; no approximate success", async () => {
  const attempt = await prepareCollectionAttempt(state(true), { ...emptyCollectionDraft(), scheduleId: "s", definitionJson: raw, reason: "Explicit next version" }, binding, "key");
  const receipt = { ...attempt.expected, version_id: "v2", session_binding: binding };
  assert.doesNotThrow(() => assertCollectionReceipt(receipt, attempt));
  for (const patch of [{ content_hash: "b".repeat(64) }, { version: 1 }, { schedule_revision: 2 }, { status: "enabled" }, { schedule_id: "other" }, { scope_key: "provider:ecb:fx:daily:EUR" }, { session_binding: "b".repeat(64) }, { unexpected: true }]) assert.throws(() => assertCollectionReceipt({ ...receipt, ...patch }, attempt), /COLLECTION_RECEIPT_INVALID/);
});
test("pause keeps identity and version; cap allows only final pause and cannot manufacture a new authorization", async () => {
  const value = state(true); value.schedules[0].schedule_revision = 1023;
  const draft = { operation: "paused" as const, scheduleId: "s", definitionJson: "", reason: "Stop synthetic polling" };
  const attempt = await prepareCollectionAttempt(value, draft, binding, "pause");
  assert.equal(attempt.expected.schedule_revision, 1024); assert.equal(attempt.expected.version_id, "v"); assert.equal(attempt.expected.content_hash, digest);
  await assert.rejects(prepareCollectionAttempt(value, { ...draft, operation: "save", definitionJson: raw }, binding, "save"), /COLLECTION_LIMIT_REACHED/);
  value.schedules[0].schedule_revision = 1024; value.schedules[0].status = "paused";
  await assert.rejects(prepareCollectionAttempt(value, { ...draft, operation: "enabled" }, binding, "enable"), /COLLECTION_LIMIT_REACHED/);
});
test("same-enabled and same-paused explicit commands retain version but freeze a new control revision", async () => {
  for (const status of ["enabled", "paused"] as const) {
    const value = state(true); value.schedules[0].status = status;
    const attempt = await prepareCollectionAttempt(value, { operation: status, scheduleId: "s", definitionJson: "", reason: "Explicit synthetic control renewal" }, binding, `same-${status}`);
    assert.equal(attempt.expected.status, status); assert.equal(attempt.expected.version_id, "v"); assert.equal(attempt.expected.schedule_revision, 3);
    const command = JSON.parse(attempt.body).command;
    assert.equal(command.expected_schedule_revision, 2); assert.equal(command.status, status); assert.equal(command.acknowledgement, true);
  }
});
test("runtime response validator rejects cross-portfolio, session, malformed rows, bounds and raw capture body", () => {
  const response = { ...state(true), session_binding: binding };
  assert.doesNotThrow(() => assertCollectionState(response, "p", binding));
  assert.throws(() => assertCollectionState(response, "other", binding), /COLLECTION_RESPONSE_INVALID/);
  assert.throws(() => assertCollectionState(response, "p", "b".repeat(64)), /COLLECTION_RESPONSE_INVALID/);
  for (const patch of [{ schedules: [{ ...response.schedules[0], portfolio_id: "other" }] }, { schedules: Array(21).fill(response.schedules[0]) }, { slots: [{}] }, { raw_body: "not exposed" }, { schedules: [{ ...response.schedules[0], current_version: { ...response.schedules[0].current_version, definition: { ...definition, provider: "other" } } }] }]) assert.throws(() => assertCollectionState({ ...response, ...patch }, "p", binding), /COLLECTION_RESPONSE_INVALID/);
});
