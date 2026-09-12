import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020";
import scheduleContract from "../../contracts/v1/evaluation-schedule.schema.json";
import { governanceFixture, human, now } from "./governance-fixture";
import { audit, canonical, createAccount, createPortfolio, hash, revision } from "../src/server/ledger/service";
import { evaluationScheduleSchema, type EvaluationScheduleDefinition } from "../src/server/evaluation/schemas";
import { getEvaluationState, parseEvaluationDefinition, retryEvaluation, saveSchedule, setScheduleStatus, verifyEvaluationAuthorization } from "../src/server/evaluation/service";
import { checkRisk, evaluateRisk, loadProposal } from "../src/server/governance/risk";
import { createStrategyVersion } from "../src/server/governance/service";

const cycleAt = "2026-01-06T12:00:00.000Z", finishedAt = "2026-01-06T12:01:00.000Z", retryAt = "2026-01-06T12:02:00.000Z";
function fixture(t: { after(callback: () => void): void }) {
  const f = governanceFixture(); t.after(f.close);
  const definition: EvaluationScheduleDefinition = {
    schema_version: "evaluation-schedule-v1", environment: "actual", frequency: "monthly", policy_version_id: f.policyVersion.id, strategy_version_id: f.strategyVersion.id, activation_id: f.activated!.id,
    timezone: "UTC", start_month: "2026-01", end_month: "2026-12", trigger: { day: 6, hour: 12, minute: 0 }, deadline_seconds: 86400, max_attempts: 3,
    targets: { method: "manual_weight_targets_v1", weight_basis: "portfolio_nav", rows: [{ account_id: f.account, listing_id: "l", currency: "CNY", weight: "0.25" }],
      absolute_tolerance_cny: "1", weight_tolerance: "0.001", tolerance_rule: "max_absolute_or_weight", unlisted_strategy_positions: "block", pending_activity: "block", price_rule: "close_rounded_to_step", quantity_rule: "floor_to_step" },
  };
  const saveCommand = (value = JSON.stringify(definition), expected = 0) => ({ ...f.envelope(), expected_schedule_id: expected ? (f.db.prepare("SELECT id FROM evaluation_schedules WHERE portfolio_id=? AND strategy_key=?").get(f.portfolio, f.strategy.strategy_key) as { id: string } | undefined)?.id ?? null : null, expected_schedule_revision: expected, definition_json: value });
  const save = (value = JSON.stringify(definition), expected = 0) => saveSchedule(f.db, human, saveCommand(value, expected), { now });
  const statusCommand = (id: string, expected: number, status: "enabled" | "paused") => ({ ...f.envelope(), schedule_id: id, expected_schedule_revision: expected, status });
  const enable = () => { const saved = save(); return { ...saved, ...setScheduleStatus(f.db, human, statusCommand(saved.schedule_id, 1, "enabled"), { now }) }; };
  return { ...f, definition, saveCommand, save, statusCommand, enable };
}
type Fixture = ReturnType<typeof fixture>;
function insert(f: Fixture, table: string, row: Record<string, unknown>) { f.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?")})`).run(...Object.values(row)); }
function seedCycle(f: Fixture, schedule: ReturnType<Fixture["enable"]>, period = "2026-01", created = cycleAt) {
  const id = randomUUID(), command = randomUUID(), payload = canonical({ cycle_id: id });
  insert(f, "evaluation_cycles", { id, portfolio_id: f.portfolio, strategy_version_id: f.strategyVersion.id, policy_version_id: f.policyVersion.id, scope: "actual:portfolio", period, status: "pending", schedule_version_id: schedule.version_id, environment: "actual", strategy_key: f.strategy.strategy_key, scope_key: "portfolio", scheduled_at: cycleAt, cutoff_at: cycleAt, knowledge_at: cycleAt, deadline_at: "2026-01-07T12:00:00.000Z", created_at: created, state_revision: 1 });
  insert(f, "command_requests", { id: command, portfolio_id: f.portfolio, command_type: "monthly_evaluation", idempotency_key: command, payload_hash: hash({ cycle_id: id }), payload_json: payload, actor_id: "system:monthly-discovery", created_at: created });
  insert(f, "evaluation_cycle_requests", { command_request_id: command, cycle_id: id, generation: 1, requested_by: "system:monthly-discovery", reason: "SYNTHETIC discovery from an explicit test schedule", created_at: created });
  return { id, command };
}
function terminal(f: Fixture, cycleId: string, request: string, state: "blocked" | "failed" | "completed" = "blocked", attempt = 1) {
  const job = randomUUID(), jobAttempt = randomUUID(), domain = randomUUID(), status = state === "completed" ? "succeeded" : state;
  insert(f, "job_runs", { id: job, command_request_id: request, job_type: "monthly_evaluation", scope: f.portfolio, period: "2026-01", input_version: request, status: "running", max_attempts: 3, not_before: cycleAt, created_at: cycleAt, updated_at: cycleAt, lease_owner: "synthetic-worker", lease_until: "2026-01-06T13:00:00.000Z", fencing_token: 1, attempt_count: 1 });
  insert(f, "job_attempts", { id: jobAttempt, job_id: job, attempt: 1, fencing_token: 1, status: "running", started_at: cycleAt });
  f.db.prepare("UPDATE evaluation_cycles SET status='running',state_revision=state_revision+1 WHERE id=?").run(cycleId);
  const input = { synthetic: true, cycle_id: cycleId }, result = { synthetic: true, outcome: state === "completed" ? "unchanged" : state };
  insert(f, "evaluation_attempts", { id: domain, cycle_id: cycleId, attempt, input_manifest: canonical(input), status, result_json: canonical(result), created_at: cycleAt, job_attempt_id: jobAttempt, input_hash: hash(input), result_hash: hash(result), completed_at: finishedAt });
  f.db.prepare("UPDATE evaluation_cycles SET status=?,outcome=?,completed_at=?,terminal_attempt_id=?,state_revision=state_revision+1 WHERE id=?").run(state, state === "completed" ? "unchanged" : state === "blocked" ? "blocked" : null, finishedAt, domain, cycleId);
  f.db.prepare("UPDATE job_attempts SET status='succeeded',finished_at=? WHERE id=?").run(finishedAt, jobAttempt);
  f.db.prepare("UPDATE job_runs SET status='succeeded',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(finishedAt, job);
  return { job, jobAttempt, domain };
}

test("strict versioned definition and JSON contract accept explicit decimals without supplying economic defaults", t => {
  const f = fixture(t), validate = new Ajv2020({ strict: true }).compile(scheduleContract);
  assert.equal(validate(f.definition), true); assert.deepEqual(evaluationScheduleSchema.parse(f.definition), f.definition);
  for (const value of [{ ...f.definition, pass: true }, { ...f.definition, frequency: "daily" }, { ...f.definition, targets: { ...f.definition.targets, rows: [] } },
    { ...f.definition, targets: { ...f.definition.targets, rows: [{ ...f.definition.targets.rows[0], weight: 0.25 }] } }]) {
    assert.equal(validate(value), false); assert.equal(evaluationScheduleSchema.safeParse(value).success, false);
  }
  for (const value of [{ ...f.definition, timezone: "Not/AZone" }, { ...f.definition, end_month: "2025-12" },
    { ...f.definition, targets: { ...f.definition.targets, rows: [...f.definition.targets.rows, ...f.definition.targets.rows] } },
    { ...f.definition, targets: { ...f.definition.targets, absolute_tolerance_cny: "1e3" } }]) assert.equal(evaluationScheduleSchema.safeParse(value).success, false);
  for (const text of ["{}", '{"a":1,"a":2}', "\ufeff" + JSON.stringify(f.definition), JSON.stringify(f.definition).replace('"monthly"', '"monthly","frequency":"monthly"')]) assert.throws(() => parseEvaluationDefinition(text), /EVALUATION_DEFINITION_INVALID/);
});

test("save preserves exact original UTF8/hash, creates paused versions, and never books or reserves", t => {
  const f = fixture(t), raw = " \n" + JSON.stringify(f.definition, null, 2) + "\n", command = f.saveCommand(raw), before = revision(f.db, f.portfolio);
  const first = saveSchedule(f.db, human, command, { now });
  assert.equal(first.status, "paused"); assert.equal(first.content_hash, createHash("sha256").update(raw).digest("hex"));
  assert.deepEqual(saveSchedule(f.db, human, { ...command, expected_revision: 0, expected_schedule_revision: 999 }, { now }), first);
  const stored = f.db.prepare("SELECT definition_json FROM evaluation_schedule_versions WHERE id=?").get(first.version_id) as { definition_json: string }; assert.equal(stored.definition_json, raw);
  setScheduleStatus(f.db, human, f.statusCommand(first.schedule_id, 1, "enabled"), { now });
  const second = f.save(JSON.stringify({ ...f.definition, targets: { ...f.definition.targets, weight_tolerance: "0.002" } }), 2);
  assert.equal(second.schedule_id, first.schedule_id); assert.equal(second.version, 2); assert.equal(second.status, "paused");
  assert.equal(revision(f.db, f.portfolio), before);
  for (const table of ["proposals", "reservations", "evaluation_cycles"]) assert.equal((f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n, 0);
  const view = getEvaluationState(f.db, human, { portfolio_id: f.portfolio }); assert.equal(view.schedules[0].current_version.content_hash, second.content_hash);
});

test("human-only commands, account/listing/version scope, budget and CAS are enforced independently of ledger changes", t => {
  const f = fixture(t), input = f.saveCommand();
  for (const kind of ["strategy", "ai"] as const) assert.throws(() => saveSchedule(f.db, { id: "synthetic-other", kind }, input, { now }), /EVALUATION_PERMISSION_DENIED/);
  assert.throws(() => saveSchedule(f.db, human, { ...input, actor: "human" }, { now }), /EVALUATION_COMMAND_INVALID/);
  const other = createPortfolio(f.db, human, "Synthetic out-of-scope", now), account = createAccount(f.db, human, other, "Synthetic", "No broker", "CNY", now);
  for (const [patch, error] of [
    [{ ...f.definition, policy_version_id: "unknown" }, "EVALUATION_VERSION_OUT_OF_SCOPE"],
    [{ ...f.definition, targets: { ...f.definition.targets, rows: [{ ...f.definition.targets.rows[0], account_id: account }] } }, "EVALUATION_ACCOUNT_OUT_OF_SCOPE"],
    [{ ...f.definition, targets: { ...f.definition.targets, rows: [{ ...f.definition.targets.rows[0], currency: "USD" }] } }, "EVALUATION_TARGET_OUT_OF_SCOPE"],
    [{ ...f.definition, targets: { ...f.definition.targets, rows: [{ ...f.definition.targets.rows[0], weight: "0.6" }, { ...f.definition.targets.rows[0], listing_id: "l2", weight: "0.6" }] } }, "EVALUATION_TARGET_BUDGET_EXCEEDED"],
    [{ ...f.definition, start_month: "2025-12" }, "EVALUATION_START_MONTH_PAST"],
  ] as const) assert.throws(() => f.save(JSON.stringify(patch)), new RegExp(error));
  const saved = f.save(); assert.throws(() => f.save(), /EVALUATION_SCHEDULE_CONFLICT/);
  const change = f.statusCommand(saved.schedule_id, 1, "enabled"); setScheduleStatus(f.db, human, change, { now });
  assert.throws(() => setScheduleStatus(f.db, human, { ...f.statusCommand(saved.schedule_id, 1, "paused") }, { now }), /EVALUATION_SCHEDULE_CONFLICT/);
  assert.throws(() => saveSchedule(f.db, human, { ...input, definition_json: JSON.stringify({ ...f.definition, max_attempts: 4 }) }, { now }), /EVALUATION_SCHEDULE_CONFLICT/);
  const dedup = f.saveCommand(JSON.stringify(f.definition), 2); saveSchedule(f.db, human, dedup, { now });
  assert.throws(() => saveSchedule(f.db, human, { ...dedup, reason: "A different explicit intent" }, { now }), /EVALUATION_IDEMPOTENCY_CONFLICT/);
});

test("enable records actual human authorization and only the next non-past local trigger", t => {
  const f = fixture(t), definition = { ...f.definition, trigger: { day: 1, hour: 0, minute: 0 } }, saved = f.save(JSON.stringify(definition));
  const enabled = setScheduleStatus(f.db, human, f.statusCommand(saved.schedule_id, 1, "enabled"), { now });
  assert.equal(enabled.first_scheduled_at, "2026-02-01T00:00:00.000Z");
  const view = getEvaluationState(f.db, human, { portfolio_id: f.portfolio }).schedules[0];
  const audit = f.db.prepare("SELECT payload_json FROM audit_events WHERE id=?").get(view.last_audit_id) as { payload_json: string };
  const payload = JSON.parse(audit.payload_json); assert.equal(payload.actor_kind, "human"); assert.equal(payload.result.version_id, saved.version_id); assert.equal(payload.result.schedule_revision, 2);
  setScheduleStatus(f.db, human, f.statusCommand(saved.schedule_id, 2, "paused"), { now });
  assert.throws(() => setScheduleStatus(f.db, human, f.statusCommand(saved.schedule_id, 3, "paused"), { now }), /EVALUATION_STATUS_UNCHANGED/);
  const replaced = f.save(JSON.stringify({ ...definition, end_month: "2026-01" }), 3);
  assert.throws(() => setScheduleStatus(f.db, human, f.statusCommand(saved.schedule_id, replaced.schedule_revision, "enabled"), { now }), /EVALUATION_NO_FUTURE_TRIGGER/);
});

test("nonexistent and ambiguous first authorized local trigger times fail rather than picking a DST offset", t => {
  const f = fixture(t);
  for (const [month, day, hour] of [["2026-03", 8, 2], ["2026-11", 1, 1]] as const) {
    const current = (f.db.prepare("SELECT revision FROM evaluation_schedule_heads").get() as { revision: number } | undefined)?.revision ?? 0;
    const saved = f.save(JSON.stringify({ ...f.definition, timezone: "America/New_York", start_month: month, trigger: { day, hour, minute: 30 } }), current);
    assert.throws(() => setScheduleStatus(f.db, human, f.statusCommand(saved.schedule_id, saved.schedule_revision, "enabled"), { now }), /EVALUATION_TRIGGER_TIME_INVALID/);
  }
});

test("explicit retries retain original month/version/cutoff/knowledge/deadline and deduplicate after state advances", t => {
  const f = fixture(t), schedule = f.enable(), cycle = seedCycle(f, schedule); terminal(f, cycle.id, cycle.command);
  const before = f.db.prepare("SELECT * FROM evaluation_cycles WHERE id=?").get(cycle.id) as Record<string, unknown>;
  const input = { ...f.envelope(), cycle_id: cycle.id, expected_state_revision: 3 };
  const result = retryEvaluation(f.db, human, input, { now: retryAt });
  assert.equal(result.generation, 2); assert.equal(result.state_revision, 4); assert.equal(result.status, "pending");
  assert.deepEqual(retryEvaluation(f.db, human, { ...input, expected_state_revision: 999 }, { now: retryAt }), result);
  const after = f.db.prepare("SELECT * FROM evaluation_cycles WHERE id=?").get(cycle.id) as Record<string, unknown>;
  for (const key of ["period", "schedule_version_id", "scheduled_at", "cutoff_at", "knowledge_at", "deadline_at", "created_at"]) assert.equal(after[key], before[key]);
  const request = f.db.prepare("SELECT payload_json FROM command_requests WHERE id=?").get(result.request_id) as { payload_json: string }; assert.equal(request.payload_json, canonical({ cycle_id: cycle.id }));
  assert.throws(() => retryEvaluation(f.db, human, { ...f.envelope(), cycle_id: cycle.id, expected_state_revision: 4 }, { now: retryAt }), /EVALUATION_NOT_RETRYABLE/);
  assert.throws(() => retryEvaluation(f.db, human, { ...input, cutoff_at: retryAt }, { now: retryAt }), /EVALUATION_COMMAND_INVALID/);
});

test("completed cycles, expired deadlines, paused or replaced schedules cannot be retried", t => {
  const f = fixture(t), schedule = f.enable(), cycle = seedCycle(f, schedule); terminal(f, cycle.id, cycle.command);
  const input = () => ({ ...f.envelope(), cycle_id: cycle.id, expected_state_revision: 3 });
  assert.throws(() => retryEvaluation(f.db, human, input(), { now: "2026-01-07T12:00:00.000Z" }), /EVALUATION_DEADLINE_EXPIRED/);
  setScheduleStatus(f.db, human, f.statusCommand(schedule.schedule_id, 2, "paused"), { now: retryAt });
  assert.throws(() => retryEvaluation(f.db, human, input(), { now: retryAt }), /EVALUATION_SCHEDULE_PAUSED/);
  setScheduleStatus(f.db, human, f.statusCommand(schedule.schedule_id, 3, "enabled"), { now: retryAt });
  assert.equal(retryEvaluation(f.db, human, input(), { now: retryAt }).status, "pending");
  const generation2 = f.db.prepare("SELECT command_request_id FROM evaluation_cycle_requests WHERE cycle_id=? AND generation=2").get(cycle.id) as { command_request_id: string };
  terminal(f, cycle.id, generation2.command_request_id, "completed", 2);
  assert.throws(() => retryEvaluation(f.db, human, { ...f.envelope(), cycle_id: cycle.id, expected_state_revision: 6 }, { now: retryAt }), /EVALUATION_NOT_RETRYABLE/);
});

test("retry rejects injected historical cycles without a true original human authorization", t => {
  const f = fixture(t), saved = f.save(), enabled = setScheduleStatus(f.db, human, f.statusCommand(saved.schedule_id, 1, "enabled"), { now: "2026-01-06T12:00:01.000Z" });
  const cycle = seedCycle(f, { ...saved, ...enabled }); terminal(f, cycle.id, cycle.command);
  assert.throws(() => retryEvaluation(f.db, human, { ...f.envelope(), cycle_id: cycle.id, expected_state_revision: 3 }, { now: retryAt }), /EVALUATION_EVIDENCE_INVALID/);
});

test("list/detail use bounded scoped keysets and keep complete attempt evidence out of list responses", t => {
  const f = fixture(t), schedule = f.enable(), cycles = [seedCycle(f, schedule), seedCycle(f, schedule, "2026-02"), seedCycle(f, schedule, "2026-03")];
  terminal(f, cycles[0].id, cycles[0].command);
  const first = getEvaluationState(f.db, human, { portfolio_id: f.portfolio, limit: 2 }); assert.equal(first.cycles.length, 2); assert.ok(first.next_cursor); assert.equal(first.detail, null);
  assert.equal("input_manifest_json" in first.cycles[0], false);
  const second = getEvaluationState(f.db, human, { portfolio_id: f.portfolio, limit: 2, cursor: first.next_cursor! }); assert.deepEqual(second.cycles.map(row => row.id), [cycles[0].id]);
  const detail = getEvaluationState(f.db, human, { portfolio_id: f.portfolio, cycle_id: cycles[0].id }); assert.equal(detail.cycles.length, 0); assert.equal(detail.detail!.attempts.length, 1); assert.equal(detail.detail!.requests.length, 1); assert.equal(detail.detail!.jobs.length, 1);
  const other = createPortfolio(f.db, human, "Synthetic other scope", now);
  assert.throws(() => getEvaluationState(f.db, human, { portfolio_id: other, cursor: first.next_cursor! }), /EVALUATION_CURSOR_INVALID/);
  assert.throws(() => getEvaluationState(f.db, human, { portfolio_id: other, cycle_id: cycles[0].id }), /EVALUATION_CYCLE_NOT_FOUND/);
  for (const value of [{ limit: 51 }, { cycle_id: cycles[0].id }, { portfolio_id: f.portfolio, actor: "attacker" }, { cursor: "bad" }]) assert.throws(() => getEvaluationState(f.db, human, value), /EVALUATION_(QUERY|CURSOR)_INVALID/);
});

test("restore marker blocks every write including commit-time marker creation, while GET makes no writes", t => {
  const f = fixture(t), saved = f.save(), marker = path.join(f.dataDir, "RESTORE_PENDING_REVIEW"), before = f.db.prepare("SELECT total_changes() n").get();
  writeFileSync(marker, "SYNTHETIC RESTORE REVIEW", { mode: 0o600 });
  assert.equal(getEvaluationState(f.db, human, { portfolio_id: f.portfolio }).read_only, true); assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  assert.throws(() => f.save(JSON.stringify(f.definition), 1), /WORKBENCH_READ_ONLY/);
  assert.throws(() => setScheduleStatus(f.db, human, f.statusCommand(saved.schedule_id, 1, "enabled"), { now }), /WORKBENCH_READ_ONLY/);
  rmSync(marker);
  f.db.function("synthetic_restore_marker", () => { writeFileSync(marker, "SYNTHETIC RESTORE REVIEW", { mode: 0o600 }); return 1; });
  f.db.exec("CREATE TRIGGER synthetic_restore_during_schedule AFTER INSERT ON evaluation_schedule_versions BEGIN SELECT synthetic_restore_marker(); END;");
  assert.throws(() => f.save(JSON.stringify(f.definition), 1), /WORKBENCH_READ_ONLY/);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM evaluation_schedule_versions").get() as { n: number }).n, 1); assert.equal(getEvaluationState(f.db, human, { portfolio_id: f.portfolio }).schedules[0].schedule_revision, 1);
});

test("changed stored definition bytes/hash fail closed before enable and disclosure", t => {
  const f = fixture(t), saved = f.save();
  f.db.exec("DROP TRIGGER evaluation_schedule_version_no_update;"); f.db.prepare("UPDATE evaluation_schedule_versions SET definition_json=definition_json || ' ' WHERE id=?").run(saved.version_id);
  assert.throws(() => getEvaluationState(f.db, human, { portfolio_id: f.portfolio }), /EVALUATION_EVIDENCE_INVALID/);
  assert.throws(() => setScheduleStatus(f.db, human, f.statusCommand(saved.schedule_id, 1, "enabled"), { now }), /EVALUATION_EVIDENCE_INVALID/);
});

test("evaluateRisk extraction preserves persisted proposal result and supports no-write virtual empty items", t => {
  const f = fixture(t), proposal = f.proposal("100"), loaded = loadProposal(f.db, f.portfolio, proposal.id), before = f.db.prepare("SELECT total_changes() n").get();
  assert.deepEqual(evaluateRisk(f.db, human, loaded.proposal, loaded.items, loaded.context, f.options, now), checkRisk(f.db, human, f.portfolio, proposal.id, f.options, now));
  const noAction = evaluateRisk(f.db, human, { ...loaded.proposal, id: "synthetic-virtual-no-action" }, [], loaded.context, f.options, now);
  assert.equal(noAction.status, "pass"); assert.deepEqual(noAction.budgets, []); assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM proposals").get() as { n: number }).n, 1);
});

function syntheticMicrosecondStatus(f: Fixture, schedule: ReturnType<Fixture["enable"]>, status: "enabled" | "paused", at: string) {
  const head = f.db.prepare("SELECT revision FROM evaluation_schedule_heads WHERE schedule_id=?").get(schedule.schedule_id) as { revision: number };
  const payload = { actor_kind: "human", input: { portfolio_id: f.portfolio, schedule_id: schedule.schedule_id, status, expected_schedule_revision: head.revision }, result: { schedule_id: schedule.schedule_id, version_id: schedule.version_id, schedule_revision: head.revision + 1, status } };
  const id = audit(f.db, human, "set_evaluation_schedule_status", "evaluation_schedule", schedule.schedule_id, f.portfolio, revision(f.db, f.portfolio), payload, at);
  f.db.prepare("UPDATE evaluation_schedule_heads SET status=?,revision=revision+1,last_audit_id=?,updated_at=? WHERE schedule_id=?").run(status, id, at, schedule.schedule_id);
  return id;
}

test("readonly authorization proof preserves the original approval across later same-millisecond pause and re-enable", t => {
  const f = fixture(t), schedule = f.enable(), original = getEvaluationState(f.db, human, { portfolio_id: f.portfolio }).schedules[0].last_audit_id;
  const cycle = seedCycle(f, schedule, "2026-01", "2026-01-06T12:00:00.000001Z");
  syntheticMicrosecondStatus(f, schedule, "paused", "2026-01-06T12:00:00.000002Z");
  const latest = syntheticMicrosecondStatus(f, schedule, "enabled", "2026-01-06T12:00:00.000003Z");
  const before = f.db.prepare("SELECT total_changes() n").get(), proof = verifyEvaluationAuthorization(f.db, { portfolio_id: f.portfolio, cycle_id: cycle.id });
  assert.equal(proof.original_authorization_audit_id, original); assert.equal(proof.authorization_audit_id, latest); assert.equal(proof.schedule_revision, 4);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
});

test("an enable occurring one microsecond after the original scheduled knowledge cutoff cannot authorize that old cycle", t => {
  const f = fixture(t), schedule = f.enable();
  syntheticMicrosecondStatus(f, schedule, "paused", "2026-01-06T11:59:59.999999Z");
  syntheticMicrosecondStatus(f, schedule, "enabled", "2026-01-06T12:00:00.000001Z");
  const cycle = seedCycle(f, schedule, "2026-01", "2026-01-06T12:00:00.000002Z");
  assert.throws(() => verifyEvaluationAuthorization(f.db, { portfolio_id: f.portfolio, cycle_id: cycle.id }), /EVALUATION_EVIDENCE_INVALID/);
});

test("current head and human approval timestamps must agree through six fractional digits", t => {
  const f = fixture(t), schedule = f.enable(), cycle = seedCycle(f, schedule);
  syntheticMicrosecondStatus(f, schedule, "paused", "2026-01-06T12:00:01.000001Z");
  syntheticMicrosecondStatus(f, schedule, "enabled", "2026-01-06T12:00:01.000002Z");
  f.db.exec("DROP TRIGGER evaluation_schedule_head_update;");
  f.db.prepare("UPDATE evaluation_schedule_heads SET updated_at=? WHERE schedule_id=?").run("2026-01-06T12:00:01.000003Z", schedule.schedule_id);
  assert.throws(() => verifyEvaluationAuthorization(f.db, { portfolio_id: f.portfolio, cycle_id: cycle.id }), /EVALUATION_EVIDENCE_INVALID/);
});

test("required save identity blocks equal-revision cross-schedule writes and preserves same-key strategy version upgrades", t => {
  const f = fixture(t), first = f.save();
  const newStrategy = (key: string, at: string) => {
    const strategy = createStrategyVersion(f.db, human, { ...f.envelope(), strategy: { ...f.strategy, strategy_key: key } }, { ...f.options, now: at });
    const activationId = randomUUID();
    // Disposable authorization fixture only; this does not certify real admission evidence.
    f.db.prepare("UPDATE activations SET valid_to=? WHERE portfolio_id=? AND valid_to IS NULL").run(at, f.portfolio);
    f.db.prepare("INSERT INTO activations(id,portfolio_id,policy_version_id,strategy_version_id,mode,valid_from,valid_to,evidence_json,approved_by,created_at) VALUES(?,?,?,?,'live_advice',?,NULL,'{}',?,?)")
      .run(activationId, f.portfolio, f.policyVersion.id, strategy.id, at, human.id, at);
    return { ...f.definition, strategy_version_id: strategy.id, activation_id: activationId };
  };
  const secondAt = "2026-01-05T12:01:00.000Z", secondDefinition = newStrategy("synthetic-second", secondAt);
  const second = saveSchedule(f.db, human, { ...f.envelope(), expected_schedule_id: null, expected_schedule_revision: 0, definition_json: JSON.stringify(secondDefinition) }, { now: secondAt });
  assert.equal(first.schedule_revision, second.schedule_revision);
  const counts = () => ["evaluation_schedule_versions", "audit_events", "command_dedup"].map(table => (f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n);
  const before = counts();
  const wrong = { ...f.envelope(), expected_schedule_id: first.schedule_id, expected_schedule_revision: 1, definition_json: JSON.stringify(secondDefinition) };
  assert.throws(() => saveSchedule(f.db, human, wrong, { now: secondAt }), /EVALUATION_SCHEDULE_CONFLICT/);
  assert.throws(() => saveSchedule(f.db, human, { ...wrong, expected_schedule_id: null }, { now: secondAt }), /EVALUATION_SCHEDULE_CONFLICT/);
  const { expected_schedule_id: _omitted, ...missing } = wrong;
  assert.throws(() => saveSchedule(f.db, human, missing, { now: secondAt }), /EVALUATION_COMMAND_INVALID/);
  assert.deepEqual(counts(), before);
  const upgradeAt = "2026-01-05T12:02:00.000Z", upgraded = newStrategy("synthetic-second", upgradeAt);
  const result = saveSchedule(f.db, human, { ...f.envelope(), expected_schedule_id: second.schedule_id, expected_schedule_revision: 1, definition_json: JSON.stringify(upgraded) }, { now: upgradeAt });
  assert.equal(result.schedule_id, second.schedule_id); assert.equal(result.version, 2); assert.equal(result.status, "paused");
  const view = getEvaluationState(f.db, human, { portfolio_id: f.portfolio });
  const head = view.schedules.find(row => row.id === second.schedule_id)!;
  assert.equal(head.current_version.strategy_version_id, upgraded.strategy_version_id);
  const stored = f.db.prepare("SELECT payload_json FROM audit_events WHERE id=?").get(head.last_audit_id) as { payload_json: string };
  assert.equal(JSON.parse(stored.payload_json).input.expected_schedule_id, second.schedule_id);
});
