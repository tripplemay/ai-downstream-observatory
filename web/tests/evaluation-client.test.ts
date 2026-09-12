import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { assertEvaluationReceipt, assertEvaluationState, emptyEvaluationDraft, evaluationProposalId, evaluationTemplate,
  EvaluationRequestGate, prepareEvaluationAttempt, sealEvaluationAttempt } from "../src/components/workbench/evaluation-client";
import type { EvaluationState, EvaluationScheduleDefinition, EvaluationCycleSummary } from "../src/server/evaluation/types";
import { governanceFixture, human, now } from "./governance-fixture";
import { getEvaluationState, saveSchedule, setScheduleStatus } from "../src/server/evaluation/service";

const binding = "a".repeat(64), at = "2026-01-06T12:00:00.000000Z";
const definition: EvaluationScheduleDefinition = { schema_version: "evaluation-schedule-v1", frequency: "monthly", environment: "actual", policy_version_id: "p", strategy_version_id: "s", activation_id: "a",
  timezone: "UTC", start_month: "2026-01", end_month: "2026-12", trigger: { day: 6, hour: 12, minute: 0 }, deadline_seconds: 86400, max_attempts: 3,
  targets: { method: "manual_weight_targets_v1", weight_basis: "portfolio_nav", rows: [{ account_id: "account", listing_id: "l", currency: "CNY", weight: "0.25" }], absolute_tolerance_cny: "1", weight_tolerance: "0.001",
    tolerance_rule: "max_absolute_or_weight", unlisted_strategy_positions: "block", pending_activity: "block", price_rule: "close_rounded_to_step", quantity_rule: "floor_to_step" } };
const state = (): EvaluationState => ({ schema_version: "monthly-evaluations-v1", portfolios: [{ id: "portfolio", name: "Synthetic" }], selected_portfolio_id: "portfolio", ledger_revision: 4,
  read_only: false, schedules: [], schedules_truncated: false, cycles: [], next_cursor: null, detail: null });
const cycle = (): EvaluationCycleSummary => ({ id: "cycle", portfolio_id: "portfolio", period: "2026-01", status: "blocked", outcome: "blocked", schedule_version_id: "v",
  scheduled_at: at, cutoff_at: at, knowledge_at: at, deadline_at: "2026-01-07T12:00:00.000000Z", created_at: at, state_revision: 3, terminal_attempt_id: "attempt", completed_at: at });

test("empty input and explicit structural template contain no configured amounts, weights, dates or authorization", () => {
  assert.deepEqual(emptyEvaluationDraft(), { action: "save_schedule", scheduleId: "", cycleId: "", definitionJson: "", reason: "" });
  const template = JSON.parse(evaluationTemplate());
  assert.equal(template.targets.rows[0].weight, ""); assert.equal(template.targets.absolute_tolerance_cny, ""); assert.equal(template.targets.weight_tolerance, "");
  assert.equal(template.timezone, ""); assert.equal(template.start_month, ""); assert.equal(template.end_month, ""); assert.equal(template.trigger.day, null);
  assert.throws(() => prepareEvaluationAttempt(state(), { ...emptyEvaluationDraft(), definitionJson: evaluationTemplate(), reason: "Synthetic" }, binding, "key"), /DEFINITION_INVALID/);
});

test("real human service DTO and save/enable receipts round trip through UI contract without trusting a client PASS", async t => {
  const f = governanceFixture(); t.after(f.close);
  const value = { ...definition, policy_version_id: f.policyVersion.id, strategy_version_id: f.strategyVersion.id, activation_id: f.activated!.id,
    targets: { ...definition.targets, rows: [{ account_id: f.account, listing_id: "l", currency: "CNY", weight: "0.25" }] } };
  const initial = getEvaluationState(f.db, human, { portfolio_id: f.portfolio }); assertEvaluationState(initial, { portfolioId: f.portfolio });
  const raw = ` ${JSON.stringify(value, null, 2)}\n`, attempt = await sealEvaluationAttempt(prepareEvaluationAttempt(initial, { ...emptyEvaluationDraft(), definitionJson: raw, reason: "Synthetic explicit target" }, binding, randomUUID()));
  const parsed = JSON.parse(attempt.body); assert.equal(parsed.command.definition_json, raw); assert.equal(parsed.command.expected_schedule_revision, 0); assert.ok(!("actor" in parsed.command));
  const saved = saveSchedule(f.db, human, parsed.command, { now }); assertEvaluationReceipt(saved, attempt);
  assert.equal(saved.content_hash, createHash("sha256").update(raw).digest("hex"));
  const current = getEvaluationState(f.db, human, { portfolio_id: f.portfolio }); assertEvaluationState(current, { portfolioId: f.portfolio });
  const enable = prepareEvaluationAttempt(current, { ...emptyEvaluationDraft(), action: "enable", scheduleId: saved.schedule_id, reason: "Synthetic future only" }, binding, randomUUID());
  const enabled = setScheduleStatus(f.db, human, JSON.parse(enable.body).command, { now }); assertEvaluationReceipt(enabled, enable);
  assert.throws(() => assertEvaluationReceipt({ ...enabled, status: "paused" }, enable), /RECEIPT_INVALID/);
  assert.throws(() => assertEvaluationReceipt({ ...saved, status: "enabled" }, attempt), /RECEIPT_INVALID/);
  assert.throws(() => assertEvaluationReceipt({ ...saved, content_hash: "0".repeat(64) }, attempt), /RECEIPT_INVALID/);
  assert.throws(() => assertEvaluationReceipt({ ...saved, version: 2 }, attempt), /RECEIPT_INVALID/);
});

test("frozen retry keeps exact original payload/key/revisions after reads change and cannot rewrite economic cutoffs", () => {
  const current = state(); current.cycles = [cycle()];
  const pending = prepareEvaluationAttempt(current, { ...emptyEvaluationDraft(), action: "retry_evaluation", cycleId: "cycle", reason: "Synthetic retry" }, binding, "fixed-key");
  const body = pending.body; current.ledger_revision = 12; current.cycles[0].state_revision = 9;
  assert.equal(pending.body, body);
  assert.deepEqual(JSON.parse(body), { action: "retry_evaluation", command: { portfolio_id: "portfolio", expected_revision: 4, idempotency_key: "fixed-key", reason: "Synthetic retry", cycle_id: "cycle", expected_state_revision: 3 } });
  assertEvaluationReceipt({ cycle_id: "cycle", request_id: "request", generation: 2, state_revision: 4, status: "pending" }, pending);
  for (const bad of [{ cycle_id: "other" }, { state_revision: 10 }, { status: "completed" }, { request_id: null }]) {
    assert.throws(() => assertEvaluationReceipt({ cycle_id: "cycle", request_id: "request", generation: 2, state_revision: 4, status: "pending", ...bad }, pending), /RECEIPT_INVALID/);
  }
});

test("read-only, absent or changed scope, blank reason, completed cycle and malformed session binding cannot create commands", () => {
  const value = state(), draft = { ...emptyEvaluationDraft(), definitionJson: JSON.stringify(definition), reason: "Synthetic" };
  assert.throws(() => prepareEvaluationAttempt({ ...value, read_only: true }, draft, binding, "key"), /WRITE_UNAVAILABLE/);
  assert.throws(() => prepareEvaluationAttempt({ ...value, selected_portfolio_id: null }, draft, binding, "key"), /WRITE_UNAVAILABLE/);
  assert.throws(() => prepareEvaluationAttempt(value, draft, "not-a-binding", "key"), /WRITE_UNAVAILABLE/);
  assert.throws(() => prepareEvaluationAttempt(value, { ...draft, reason: "   " }, binding, "key"));
  assert.throws(() => prepareEvaluationAttempt(value, { ...draft, scheduleId: "other" }, binding, "key"), /SCHEDULE_NOT_FOUND/);
  value.cycles = [{ ...cycle(), status: "completed", outcome: "unchanged" }];
  assert.throws(() => prepareEvaluationAttempt(value, { ...draft, action: "retry_evaluation", cycleId: "cycle" }, binding, "key"), /NOT_RETRYABLE/);
});

test("original definition validation rejects duplicate keys, unknown fields, number amounts and implicit absolute values", () => {
  const attempt = (raw: string) => prepareEvaluationAttempt(state(), { ...emptyEvaluationDraft(), definitionJson: raw, reason: "Synthetic" }, binding, "key");
  for (const raw of ['{"schema_version":"evaluation-schedule-v1","schema_version":"evaluation-schedule-v1"}', JSON.stringify({ ...definition, actor: "human" }),
    JSON.stringify({ ...definition, targets: { ...definition.targets, absolute_tolerance_cny: -1 } }), JSON.stringify({ ...definition, targets: { ...definition.targets, weight_tolerance: "-0.1" } })]) {
    assert.throws(() => attempt(raw), /DEFINITION_INVALID/);
  }
});

test("bounded DTO validator admits empty/readonly/detail microsecond states and rejects malformed pagination or cross-scope rows", () => {
  assertEvaluationState({ ...state(), read_only: true });
  assertEvaluationState({ ...state(), portfolios: [], selected_portfolio_id: null, ledger_revision: null });
  const detail = { ...state(), detail: { cycle: cycle(), attempts: [], requests: [], jobs: [], requests_truncated: false, next_attempt_cursor: null } };
  assertEvaluationState(detail, { portfolioId: "portfolio", cycleId: "cycle" });
  for (const value of [{ ...state(), read_only: "false" }, { ...state(), next_cursor: "x".repeat(1025) }, { ...state(), cycles: Array.from({ length: 51 }, cycle) },
    { ...state(), cycles: [{ ...cycle(), portfolio_id: "another" }] }, { ...state(), cycles: [cycle(), cycle()] }, { ...detail, detail: { ...detail.detail, jobs: [{ status: "running" }] } }]) {
    assert.throws(() => assertEvaluationState(value), /RESPONSE_INVALID/);
  }
  assert.throws(() => assertEvaluationState(detail, { cycleId: "other" }), /RESPONSE_INVALID/);
  assert.throws(() => assertEvaluationState(state(), { portfolioId: "other" }), /RESPONSE_INVALID/);
});

test("request generation invalidates blur/unmount/refresh and A-to-B-to-A responses even when scope strings match", () => {
  const gate = new EvaluationRequestGate(), oldA = gate.next(); assert.equal(gate.current(oldA), true);
  gate.invalidate(); assert.equal(gate.current(oldA), false);
  const b = gate.next(), newA = gate.next(); assert.equal(gate.current(oldA), false); assert.equal(gate.current(b), false); assert.equal(gate.current(newA), true);
  gate.invalidate(); assert.equal(gate.current(newA), false);
});

test("proposal references are only IDs and never interpreted as links, markup or successful approval", () => {
  assert.equal(evaluationProposalId('{"proposal_id":"synthetic-proposal"}'), "synthetic-proposal");
  assert.equal(evaluationProposalId('{"proposal_id":null}'), null); assert.equal(evaluationProposalId('{"proposal_id":13}'), null);
  assert.equal(evaluationProposalId('{"proposal_id":"x","proposal_id":"y"}'), null);
});
