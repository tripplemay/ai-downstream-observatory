import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { assertWritableDatabase } from "../workbench-db";
import { parseStrictJson } from "../strict-json";
import { audit, canonical, hash, revision } from "../ledger/service";
import { amount, Decimal } from "../ledger/decimal";
import { activation } from "../governance/core";
import { evaluationQuerySchema, evaluationScheduleSchema, retryEvaluationSchema, saveScheduleSchema, setScheduleStatusSchema, type EvaluationScheduleDefinition } from "./schemas";
import type { EvaluationActor, EvaluationAttemptView, EvaluationCycleSummary, EvaluationOptions, EvaluationScheduleView, EvaluationState, ScheduleVersionView } from "./types";

export type { EvaluationActor, EvaluationOptions, EvaluationState } from "./types";
const MAX_DEFINITION_BYTES = 262144, MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const safeErrors = new Set([
  "EVALUATION_PERMISSION_DENIED", "EVALUATION_COMMAND_INVALID", "EVALUATION_DEFINITION_INVALID", "EVALUATION_DEFINITION_TOO_LARGE", "EVALUATION_QUERY_INVALID", "EVALUATION_CURSOR_INVALID", "EVALUATION_CLOCK_INVALID",
  "EVALUATION_SCHEDULE_NOT_FOUND", "EVALUATION_CYCLE_NOT_FOUND", "EVALUATION_PORTFOLIO_NOT_FOUND", "EVALUATION_SCHEDULE_CONFLICT", "EVALUATION_CYCLE_CONFLICT", "EVALUATION_IDEMPOTENCY_CONFLICT", "EVALUATION_LEDGER_CONFLICT",
  "EVALUATION_ACTIVATION_REQUIRED", "EVALUATION_ACTIVATION_CHANGED", "EVALUATION_POLICY_EXPIRED", "EVALUATION_VERSION_OUT_OF_SCOPE", "EVALUATION_ACCOUNT_OUT_OF_SCOPE", "EVALUATION_TARGET_OUT_OF_SCOPE", "EVALUATION_TARGET_BUDGET_EXCEEDED",
  "EVALUATION_STRATEGY_NOT_MONTHLY", "EVALUATION_START_MONTH_PAST", "EVALUATION_NO_FUTURE_TRIGGER", "EVALUATION_TRIGGER_TIME_INVALID", "EVALUATION_STATUS_UNCHANGED", "EVALUATION_SCHEDULE_PAUSED", "EVALUATION_SCHEDULE_REPLACED",
  "EVALUATION_NOT_RETRYABLE", "EVALUATION_DEADLINE_EXPIRED", "EVALUATION_JOB_PENDING", "EVALUATION_RESPONSE_TOO_LARGE",
]);
export const isEvaluationClientError = (code: string): boolean => safeErrors.has(code);
const rawHash = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");
function human(actor: EvaluationActor): void {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  if (actor.kind !== "human" || actor.id.length > 200) throw new Error("EVALUATION_PERMISSION_DENIED");
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw); if (!result.success) throw new Error("EVALUATION_COMMAND_INVALID"); return result.data;
}
function clock(options: EvaluationOptions): string {
  const now = new Date(options.now ?? Date.now()); if (!Number.isFinite(now.getTime())) throw new Error("EVALUATION_CLOCK_INVALID"); return now.toISOString();
}
function instantMicros(raw: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(raw);
  if (!match) throw new Error("EVALUATION_EVIDENCE_INVALID");
  const time = new Date(`${match[1]}.000Z`);
  if (!Number.isFinite(time.getTime()) || time.toISOString().slice(0, 19) !== match[1]) throw new Error("EVALUATION_EVIDENCE_INVALID");
  return BigInt(time.getTime()) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
function readOnly(db: Database.Database): boolean {
  try { assertWritableDatabase(db); return false; }
  catch (error) { if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") return true; throw error; }
}
export function parseEvaluationDefinition(raw: string): EvaluationScheduleDefinition {
  if (typeof raw !== "string" || Buffer.from(raw, "utf8").toString("utf8") !== raw) throw new Error("EVALUATION_DEFINITION_INVALID");
  if (Buffer.byteLength(raw, "utf8") > MAX_DEFINITION_BYTES) throw new Error("EVALUATION_DEFINITION_TOO_LARGE");
  try { return evaluationScheduleSchema.parse(parseStrictJson(raw)); }
  catch { throw new Error("EVALUATION_DEFINITION_INVALID"); }
}
function localParts(at: Date, timezone: string): number[] {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at);
  return ["year", "month", "day", "hour", "minute", "second"].map(type => Number(parts.find(part => part.type === type)!.value));
}
function localMonth(now: string, timezone: string): string { const [year, month] = localParts(new Date(now), timezone); return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`; }
function nextMonth(month: string): string {
  const [year, value] = month.split("-").map(Number); return value === 12 ? `${year + 1}-01` : `${year}-${String(value + 1).padStart(2, "0")}`;
}
function triggerInstant(month: string, definition: EvaluationScheduleDefinition): string {
  const [year, value] = month.split("-").map(Number), { day, hour, minute } = definition.trigger;
  const desired = [year, value, day, hour, minute, 0], naive = Date.UTC(year, value - 1, day, hour, minute), offsets = new Set<number>();
  // Sample both sides of a clock transition, then accept exactly one round-tripping local instant.
  for (let delta = -48; delta <= 48; delta += 3) {
    const at = new Date(naive + delta * 3600000), p = localParts(at, definition.timezone);
    offsets.add(Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]) - at.getTime());
  }
  const matches = [...offsets].map(offset => new Date(naive - offset)).filter(at => localParts(at, definition.timezone).every((value, index) => value === desired[index]));
  if (matches.length !== 1) throw new Error("EVALUATION_TRIGGER_TIME_INVALID");
  return matches[0].toISOString();
}
function firstFutureTrigger(definition: EvaluationScheduleDefinition, now: string): string {
  let month = definition.start_month > localMonth(now, definition.timezone) ? definition.start_month : localMonth(now, definition.timezone);
  if (definition.end_month !== null && month > definition.end_month) throw new Error("EVALUATION_NO_FUTURE_TRIGGER");
  let trigger = triggerInstant(month, definition);
  if (Date.parse(trigger) < Date.parse(now)) { month = nextMonth(month); if (definition.end_month !== null && month > definition.end_month) throw new Error("EVALUATION_NO_FUTURE_TRIGGER"); trigger = triggerInstant(month, definition); }
  return trigger;
}
interface HeadRow {
  id: string; portfolio_id: string; strategy_key: string; current_version_id: string; revision: number; status: "enabled" | "paused"; last_audit_id: string; updated_at: string;
  version: number; policy_version_id: string; strategy_version_id: string; definition_json: string; content_hash: string; version_created_at: string;
}
const headSql = `SELECT s.id,s.portfolio_id,s.strategy_key,h.current_version_id,h.revision,h.status,h.last_audit_id,h.updated_at,
  v.version,v.policy_version_id,v.strategy_version_id,v.definition_json,v.content_hash,v.created_at AS version_created_at
  FROM evaluation_schedules s JOIN evaluation_schedule_heads h ON h.schedule_id=s.id JOIN evaluation_schedule_versions v ON v.id=h.current_version_id AND v.schedule_id=s.id`;
function head(db: Database.Database, portfolio: string, id: string): HeadRow {
  const row = db.prepare(`${headSql} WHERE s.id=? AND s.portfolio_id=?`).get(id, portfolio) as HeadRow | undefined;
  if (!row) throw new Error("EVALUATION_SCHEDULE_NOT_FOUND"); validateHeadAudit(db, row); return row;
}
function validateHeadAudit(db: Database.Database, row: HeadRow): void {
  const stored = db.prepare("SELECT actor_id,action,payload_json,created_at FROM audit_events WHERE id=? AND portfolio_id=? AND object_type='evaluation_schedule' AND object_id=?").get(row.last_audit_id, row.portfolio_id, row.id) as { actor_id: string; action: string; payload_json: string; created_at: string } | undefined;
  if (!stored || !stored.actor_id.trim() || !["save_evaluation_schedule", "set_evaluation_schedule_status"].includes(stored.action) || instantMicros(stored.created_at) !== instantMicros(row.updated_at)) throw new Error("EVALUATION_EVIDENCE_INVALID");
  const payload = parseStrictJson(stored.payload_json) as { actor_kind?: string; input?: Record<string, unknown>; result?: Record<string, unknown> };
  if (payload.actor_kind !== "human" || payload.input?.portfolio_id !== row.portfolio_id || payload.result?.schedule_id !== row.id || payload.result?.version_id !== row.current_version_id || payload.result?.schedule_revision !== row.revision || payload.result?.status !== row.status
    || !Number.isSafeInteger(payload.input?.expected_schedule_revision) || Number(payload.input?.expected_schedule_revision) + 1 !== row.revision
    || (stored.action === "save_evaluation_schedule" ? row.status !== "paused" || payload.input?.definition_json !== row.definition_json
      || payload.input?.expected_schedule_id !== (row.version === 1 ? null : row.id) : payload.input?.schedule_id !== row.id || payload.input?.status !== row.status)) throw new Error("EVALUATION_EVIDENCE_INVALID");
}
function definitionFor(row: HeadRow): EvaluationScheduleDefinition {
  try {
    const value = parseEvaluationDefinition(row.definition_json);
    if (rawHash(row.definition_json) !== row.content_hash || value.policy_version_id !== row.policy_version_id || value.strategy_version_id !== row.strategy_version_id) throw new Error("invalid");
    return value;
  } catch { throw new Error("EVALUATION_EVIDENCE_INVALID"); }
}
function validateBindings(db: Database.Database, portfolio: string, definition: EvaluationScheduleDefinition, now: string) {
  let active: ReturnType<typeof activation>;
  try { active = activation(db, portfolio, definition.activation_id, now); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "NO_ACTIVE_GOVERNANCE") throw new Error("EVALUATION_ACTIVATION_REQUIRED");
    if (message === "GOVERNANCE_VERSION_CHANGED") throw new Error("EVALUATION_ACTIVATION_CHANGED");
    if (message === "POLICY_REVIEW_OVERDUE") throw new Error("EVALUATION_POLICY_EXPIRED");
    throw error;
  }
  if (definition.policy_version_id !== active.policy.id || definition.strategy_version_id !== active.strategy.id) throw new Error("EVALUATION_VERSION_OUT_OF_SCOPE");
  if (active.strategy.value.algorithm !== "manual_target_v1" || active.strategy.value.evaluation_frequency !== "monthly") throw new Error("EVALUATION_STRATEGY_NOT_MONTHLY");
  let total = amount("0");
  for (const row of definition.targets.rows) {
    if (!active.policy.value.account_ids.includes(row.account_id) || !db.prepare("SELECT id FROM accounts WHERE id=? AND portfolio_id=?").get(row.account_id, portfolio)) throw new Error("EVALUATION_ACCOUNT_OUT_OF_SCOPE");
    const listing = db.prepare("SELECT currency FROM listings WHERE id=?").get(row.listing_id) as { currency: string } | undefined;
    if (!listing || listing.currency !== row.currency || !active.policy.value.listing_ids.includes(row.listing_id) || !active.strategy.value.universe.includes(row.listing_id)) throw new Error("EVALUATION_TARGET_OUT_OF_SCOPE");
    total = total.add(amount(row.weight));
  }
  if (total.gt(Decimal.min(amount(active.strategy.value.budget_weight), amount(active.policy.value.limits.strategy_weight)))) throw new Error("EVALUATION_TARGET_BUDGET_EXCEEDED");
  return active.strategy.value.strategy_key;
}
type Envelope = { portfolio_id: string; expected_revision: number; idempotency_key: string; reason: string };
function transact<T>(db: Database.Database, actor: EvaluationActor, action: string, input: Envelope, options: EvaluationOptions, effect: (now: string) => T): T {
  human(actor); assertWritableDatabase(db); const now = clock(options);
  const semantic = { ...input } as Record<string, unknown>;
  for (const key of ["expected_revision", "expected_schedule_revision", "expected_state_revision", "idempotency_key"]) delete semantic[key];
  const digest = hash({ actor_id: actor.id, command: semantic }), scope = `evaluation:${action}:${input.portfolio_id}`;
  return db.transaction(() => {
    assertWritableDatabase(db);
    const previous = db.prepare("SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?").get(scope, input.idempotency_key) as { payload_hash: string; result_json: string } | undefined;
    if (previous) { if (previous.payload_hash !== digest) throw new Error("EVALUATION_IDEMPOTENCY_CONFLICT"); assertWritableDatabase(db); return JSON.parse(previous.result_json) as T; }
    if (!db.prepare("SELECT id FROM portfolios WHERE id=?").get(input.portfolio_id)) throw new Error("EVALUATION_PORTFOLIO_NOT_FOUND");
    if (revision(db, input.portfolio_id) !== input.expected_revision) throw new Error("EVALUATION_LEDGER_CONFLICT");
    const result = effect(now);
    db.prepare("INSERT INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(scope, input.idempotency_key, digest, canonical(result), now);
    assertWritableDatabase(db); return result;
  }).immediate();
}

export function saveSchedule(db: Database.Database, actor: EvaluationActor, raw: unknown, options: EvaluationOptions = {}) {
  human(actor); const input = parse(saveScheduleSchema, raw);
  return transact(db, actor, "save_schedule", input, options, now => {
    const definition = parseEvaluationDefinition(input.definition_json), strategyKey = validateBindings(db, input.portfolio_id, definition, now);
    if (definition.start_month < localMonth(now, definition.timezone)) throw new Error("EVALUATION_START_MONTH_PAST");
    const existing = db.prepare("SELECT id FROM evaluation_schedules WHERE portfolio_id=? AND environment='actual' AND strategy_key=? AND scope_key='portfolio'").get(input.portfolio_id, strategyKey) as { id: string } | undefined;
    if ((existing?.id ?? null) !== input.expected_schedule_id) throw new Error("EVALUATION_SCHEDULE_CONFLICT");
    const current = existing ? head(db, input.portfolio_id, existing.id) : null;
    if (current && instantMicros(now) < instantMicros(current.updated_at)) throw new Error("EVALUATION_CLOCK_INVALID");
    if ((current?.revision ?? 0) !== input.expected_schedule_revision || (current && current.revision >= Number.MAX_SAFE_INTEGER)) throw new Error("EVALUATION_SCHEDULE_CONFLICT");
    if (current) definitionFor(current);
    const scheduleId = current?.id ?? randomUUID(), versionId = randomUUID(), nextVersion = (current?.version ?? 0) + 1, scheduleRevision = (current?.revision ?? 0) + 1;
    if (!current) db.prepare("INSERT INTO evaluation_schedules(id,portfolio_id,environment,strategy_key,scope_key,created_by,created_at) VALUES(?,?,'actual',?,'portfolio',?,?)").run(scheduleId, input.portfolio_id, strategyKey, actor.id, now);
    db.prepare("INSERT INTO evaluation_schedule_versions(id,schedule_id,version,policy_version_id,strategy_version_id,definition_json,content_hash,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(versionId, scheduleId, nextVersion, definition.policy_version_id, definition.strategy_version_id, input.definition_json, rawHash(input.definition_json), actor.id, now);
    const result = { schedule_id: scheduleId, version_id: versionId, version: nextVersion, schedule_revision: scheduleRevision, status: "paused" as const, content_hash: rawHash(input.definition_json) };
    const auditId = audit(db, actor, "save_evaluation_schedule", "evaluation_schedule", scheduleId, input.portfolio_id, input.expected_revision, { actor_kind: "human", input, result }, now);
    if (current) db.prepare("UPDATE evaluation_schedule_heads SET current_version_id=?,revision=?,status='paused',last_audit_id=?,updated_at=? WHERE schedule_id=? AND revision=?").run(versionId, scheduleRevision, auditId, now, scheduleId, current.revision);
    else db.prepare("INSERT INTO evaluation_schedule_heads(schedule_id,current_version_id,revision,status,last_audit_id,updated_at) VALUES(?,?,1,'paused',?,?)").run(scheduleId, versionId, auditId, now);
    return result;
  });
}

export function setScheduleStatus(db: Database.Database, actor: EvaluationActor, raw: unknown, options: EvaluationOptions = {}) {
  human(actor); const input = parse(setScheduleStatusSchema, raw);
  return transact(db, actor, "set_schedule_status", input, options, now => {
    const current = head(db, input.portfolio_id, input.schedule_id), definition = definitionFor(current);
    if (instantMicros(now) < instantMicros(current.updated_at)) throw new Error("EVALUATION_CLOCK_INVALID");
    if (current.revision !== input.expected_schedule_revision || current.revision >= Number.MAX_SAFE_INTEGER) throw new Error("EVALUATION_SCHEDULE_CONFLICT");
    if (current.status === input.status) throw new Error("EVALUATION_STATUS_UNCHANGED");
    let firstScheduledAt: string | null = null;
    if (input.status === "enabled") { validateBindings(db, input.portfolio_id, definition, now); firstScheduledAt = firstFutureTrigger(definition, now); }
    const result = { schedule_id: current.id, version_id: current.current_version_id, schedule_revision: current.revision + 1, status: input.status, first_scheduled_at: firstScheduledAt };
    const auditId = audit(db, actor, "set_evaluation_schedule_status", "evaluation_schedule", current.id, input.portfolio_id, input.expected_revision, { actor_kind: "human", input, result }, now);
    db.prepare("UPDATE evaluation_schedule_heads SET revision=revision+1,status=?,last_audit_id=?,updated_at=? WHERE schedule_id=? AND revision=?").run(input.status, auditId, now, current.id, current.revision);
    return result;
  });
}

type CycleRow = EvaluationCycleSummary & { strategy_version_id: string; policy_version_id: string; environment: string; strategy_key: string; scope_key: string; scope: string };
function cycleFor(db: Database.Database, portfolio: string, id: string): CycleRow {
  const row = db.prepare("SELECT * FROM evaluation_cycles WHERE id=? AND portfolio_id=? AND schedule_version_id IS NOT NULL").get(id, portfolio) as CycleRow | undefined;
  if (!row) throw new Error("EVALUATION_CYCLE_NOT_FOUND"); return row;
}
function originalAuthorization(db: Database.Database, cycle: CycleRow, scheduleId: string) {
  const history = db.prepare(`SELECT id,created_at,rowid FROM audit_events WHERE portfolio_id=? AND object_type='evaluation_schedule' AND object_id=?
    AND action IN ('save_evaluation_schedule','set_evaluation_schedule_status') ORDER BY rowid DESC LIMIT 10001`)
    .all(cycle.portfolio_id, scheduleId) as { id: string; created_at: string; rowid: number }[];
  if (history.length > 10000) throw new Error("EVALUATION_EVIDENCE_INVALID");
  const created = instantMicros(cycle.created_at);
  const eligible = history.map(row => ({ ...row, at: instantMicros(row.created_at) })).filter(row => row.at <= created)
    .sort((a, b) => a.at === b.at ? b.rowid - a.rowid : a.at > b.at ? -1 : 1);
  const row = eligible.length ? db.prepare("SELECT id,actor_id,action,created_at,payload_json FROM audit_events WHERE id=?").get(eligible[0].id) as { id: string; actor_id: string; action: string; created_at: string; payload_json: string } : undefined;
  if (!row) throw new Error("EVALUATION_EVIDENCE_INVALID");
  const payload = parseStrictJson(row.payload_json) as { actor_kind?: string; input?: Record<string, unknown>; result?: Record<string, unknown> };
  if (row.action !== "set_evaluation_schedule_status" || !row.actor_id.trim() || payload.actor_kind !== "human" || payload.input?.portfolio_id !== cycle.portfolio_id || payload.input?.schedule_id !== scheduleId || payload.input?.status !== "enabled"
    || !Number.isSafeInteger(payload.result?.schedule_revision) || !Number.isSafeInteger(payload.input?.expected_schedule_revision) || Number(payload.input?.expected_schedule_revision) + 1 !== payload.result?.schedule_revision
    || payload.result?.schedule_id !== scheduleId || payload.result?.version_id !== cycle.schedule_version_id || payload.result?.status !== "enabled" || instantMicros(row.created_at) > instantMicros(cycle.scheduled_at)) throw new Error("EVALUATION_EVIDENCE_INVALID");
  const request = db.prepare(`SELECT r.*,c.payload_json,c.payload_hash,c.actor_id,c.command_type,c.portfolio_id FROM evaluation_cycle_requests r JOIN command_requests c ON c.id=r.command_request_id WHERE r.cycle_id=? AND r.generation=1`).get(cycle.id) as { requested_by: string; actor_id: string; command_type: string; portfolio_id: string; payload_json: string; payload_hash: string } | undefined;
  if (!request || request.requested_by !== "system:monthly-discovery" || request.actor_id !== request.requested_by || request.command_type !== "monthly_evaluation" || request.portfolio_id !== cycle.portfolio_id
    || request.payload_json !== canonical({ cycle_id: cycle.id }) || request.payload_hash !== hash({ cycle_id: cycle.id })) throw new Error("EVALUATION_EVIDENCE_INVALID");
  return row;
}
/** Read-only authority proof for the fixed worker publisher; this never enables, retries or executes a cycle. */
export function verifyEvaluationAuthorization(db: Database.Database, input: { portfolio_id: string; cycle_id: string }) {
  const read = () => {
    const cycle = cycleFor(db, input.portfolio_id, input.cycle_id);
    const version = db.prepare("SELECT schedule_id FROM evaluation_schedule_versions WHERE id=?").get(cycle.schedule_version_id) as { schedule_id: string } | undefined;
    if (!version) throw new Error("EVALUATION_EVIDENCE_INVALID");
    const current = head(db, input.portfolio_id, version.schedule_id), definition = definitionFor(current);
    if (current.current_version_id !== cycle.schedule_version_id) throw new Error("EVALUATION_SCHEDULE_REPLACED");
    if (current.status !== "enabled") throw new Error("EVALUATION_SCHEDULE_PAUSED");
    if (cycle.environment !== "actual" || cycle.scope !== "actual:portfolio" || cycle.scope_key !== "portfolio" || cycle.strategy_key !== current.strategy_key
      || cycle.policy_version_id !== definition.policy_version_id || cycle.strategy_version_id !== definition.strategy_version_id
      || cycle.period < definition.start_month || (definition.end_month !== null && cycle.period > definition.end_month)
      || instantMicros(cycle.scheduled_at) !== instantMicros(triggerInstant(cycle.period, definition))
      || instantMicros(cycle.cutoff_at) !== instantMicros(cycle.scheduled_at) || instantMicros(cycle.knowledge_at) !== instantMicros(cycle.scheduled_at)
      || instantMicros(cycle.deadline_at) !== instantMicros(cycle.scheduled_at) + BigInt(definition.deadline_seconds) * 1000000n
      || instantMicros(cycle.created_at) < instantMicros(cycle.scheduled_at)) throw new Error("EVALUATION_EVIDENCE_INVALID");
    const original = originalAuthorization(db, cycle, current.id);
    return { schedule_id: current.id, version_id: current.current_version_id, schedule_revision: current.revision, authorization_audit_id: current.last_audit_id,
      original_authorization_audit_id: original.id, authorized_at: current.updated_at, original_authorized_at: original.created_at, definition, definition_hash: current.content_hash };
  };
  return db.inTransaction ? read() : db.transaction(read).deferred();
}
export function retryEvaluation(db: Database.Database, actor: EvaluationActor, raw: unknown, options: EvaluationOptions = {}) {
  human(actor); const input = parse(retryEvaluationSchema, raw);
  return transact(db, actor, "retry_evaluation", input, options, now => {
    const cycle = cycleFor(db, input.portfolio_id, input.cycle_id);
    if (instantMicros(now) < instantMicros(cycle.created_at) || (cycle.completed_at && instantMicros(now) < instantMicros(cycle.completed_at))) throw new Error("EVALUATION_CLOCK_INVALID");
    if (cycle.state_revision !== input.expected_state_revision || cycle.state_revision >= Number.MAX_SAFE_INTEGER) throw new Error("EVALUATION_CYCLE_CONFLICT");
    if (!["blocked", "failed"].includes(cycle.status)) throw new Error("EVALUATION_NOT_RETRYABLE");
    if (instantMicros(cycle.deadline_at) <= instantMicros(now)) throw new Error("EVALUATION_DEADLINE_EXPIRED");
    const version = db.prepare("SELECT schedule_id FROM evaluation_schedule_versions WHERE id=?").get(cycle.schedule_version_id) as { schedule_id: string } | undefined;
    if (!version) throw new Error("EVALUATION_EVIDENCE_INVALID");
    const current = head(db, input.portfolio_id, version.schedule_id), definition = definitionFor(current);
    if (instantMicros(now) < instantMicros(current.updated_at)) throw new Error("EVALUATION_CLOCK_INVALID");
    if (current.current_version_id !== cycle.schedule_version_id) throw new Error("EVALUATION_SCHEDULE_REPLACED");
    if (current.status !== "enabled") throw new Error("EVALUATION_SCHEDULE_PAUSED");
    validateBindings(db, input.portfolio_id, definition, now); verifyEvaluationAuthorization(db, { portfolio_id: input.portfolio_id, cycle_id: cycle.id });
    if (db.prepare("SELECT 1 FROM evaluation_cycle_requests r JOIN job_runs j ON j.command_request_id=r.command_request_id WHERE r.cycle_id=? AND j.status IN ('queued','running','retry_queued')").get(cycle.id)) throw new Error("EVALUATION_JOB_PENDING");
    const generation = (db.prepare("SELECT COALESCE(MAX(generation),0)+1 AS generation FROM evaluation_cycle_requests WHERE cycle_id=?").get(cycle.id) as { generation: number }).generation;
    const requestId = randomUUID(), payload = { cycle_id: cycle.id };
    db.prepare("UPDATE evaluation_cycles SET status='pending',outcome=NULL,completed_at=NULL,terminal_attempt_id=NULL,state_revision=state_revision+1 WHERE id=? AND state_revision=?").run(cycle.id, cycle.state_revision);
    db.prepare("INSERT INTO command_requests(id,portfolio_id,command_type,idempotency_key,payload_hash,payload_json,actor_id,created_at) VALUES(?,?,'monthly_evaluation',?,?,?,?,?)").run(requestId, input.portfolio_id, `evaluation:${cycle.id}:${generation}`, hash(payload), canonical(payload), actor.id, now);
    db.prepare("INSERT INTO evaluation_cycle_requests(command_request_id,cycle_id,generation,requested_by,reason,created_at) VALUES(?,?,?,?,?,?)").run(requestId, cycle.id, generation, actor.id, input.reason, now);
    const result = { cycle_id: cycle.id, request_id: requestId, generation, state_revision: cycle.state_revision + 1, status: "pending" as const };
    audit(db, actor, "retry_evaluation", "evaluation_cycle", cycle.id, input.portfolio_id, input.expected_revision, { actor_kind: "human", input, result, schedule_revision: current.revision, authorization_audit_id: current.last_audit_id }, now);
    return result;
  });
}

function scheduleView(row: HeadRow): EvaluationScheduleView {
  const current: ScheduleVersionView = { id: row.current_version_id, version: row.version, policy_version_id: row.policy_version_id, strategy_version_id: row.strategy_version_id, definition_json: row.definition_json, definition: definitionFor(row), content_hash: row.content_hash, created_at: row.version_created_at };
  return { id: row.id, strategy_key: row.strategy_key, status: row.status, schedule_revision: row.revision, current_version: current, last_audit_id: row.last_audit_id, updated_at: row.updated_at };
}
function cycleSummary(row: CycleRow): EvaluationCycleSummary {
  const { id, portfolio_id, period, status, outcome, schedule_version_id, scheduled_at, cutoff_at, knowledge_at, deadline_at, created_at, state_revision, terminal_attempt_id, completed_at } = row;
  return { id, portfolio_id, period, status, outcome, schedule_version_id, scheduled_at, cutoff_at, knowledge_at, deadline_at, created_at, state_revision, terminal_attempt_id, completed_at };
}
const cursorSchema = z.object({ portfolio_id: z.string().min(1).max(200), period: z.string().regex(/^\d{4}-\d{2}$/), id: z.string().min(1).max(200) }).strict();
const attemptCursorSchema = z.object({ cycle_id: z.string().min(1).max(200), attempt: z.number().int().positive().safe() }).strict();
function decode<T>(raw: string, schema: z.ZodType<T>): T {
  try { const bytes = Buffer.from(raw, "base64url"); if (bytes.toString("base64url") !== raw) throw new Error("encoding"); return schema.parse(parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch { throw new Error("EVALUATION_CURSOR_INVALID"); }
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
export function getEvaluationState(db: Database.Database, actor: EvaluationActor, raw: unknown = {}): EvaluationState {
  human(actor); const parsed = evaluationQuerySchema.safeParse(raw); if (!parsed.success) throw new Error("EVALUATION_QUERY_INVALID"); const input = parsed.data;
  const read = (): EvaluationState => {
    const portfolios = db.prepare("SELECT id,name FROM portfolios ORDER BY created_at,id LIMIT 1000").all() as { id: string; name: string }[];
    const portfolio = input.portfolio_id ?? (portfolios.length ? portfolios[0].id : null), limit = input.limit ?? 20;
    if (portfolio && !db.prepare("SELECT 1 FROM portfolios WHERE id=?").get(portfolio)) throw new Error("EVALUATION_PORTFOLIO_NOT_FOUND");
    const result: EvaluationState = { schema_version: "monthly-evaluations-v1", portfolios, selected_portfolio_id: portfolio, ledger_revision: portfolio ? revision(db, portfolio) : null, read_only: readOnly(db), schedules: [], schedules_truncated: false, cycles: [], next_cursor: null, detail: null };
    if (!portfolio) return result;
    const schedules = db.prepare(`${headSql} WHERE s.portfolio_id=? ORDER BY s.created_at DESC,s.id DESC LIMIT 101`).all(portfolio) as HeadRow[];
    result.schedules = schedules.slice(0, 100).map(row => { validateHeadAudit(db, row); return scheduleView(row); }); result.schedules_truncated = schedules.length > 100;
    if (input.cycle_id) {
      const cycle = cycleFor(db, portfolio, input.cycle_id), cursor = input.attempt_cursor ? decode(input.attempt_cursor, attemptCursorSchema) : null;
      if (cursor && cursor.cycle_id !== cycle.id) throw new Error("EVALUATION_CURSOR_INVALID");
      const rows = db.prepare(`SELECT id,attempt,status,input_hash,result_hash,created_at,completed_at,job_attempt_id,input_manifest AS input_manifest_json,result_json FROM evaluation_attempts WHERE cycle_id=? ${cursor ? "AND attempt<?" : ""} ORDER BY attempt DESC LIMIT ?`).all(cycle.id, ...(cursor ? [cursor.attempt] : []), limit + 1) as EvaluationAttemptView[];
      const attempts = rows.slice(0, limit);
      for (const row of attempts) if (hash(parseStrictJson(row.input_manifest_json)) !== row.input_hash || hash(parseStrictJson(row.result_json)) !== row.result_hash) throw new Error("EVALUATION_EVIDENCE_INVALID");
      const requests = db.prepare("SELECT command_request_id,generation,requested_by,reason,created_at FROM evaluation_cycle_requests WHERE cycle_id=? ORDER BY generation DESC LIMIT 101").all(cycle.id) as NonNullable<EvaluationState["detail"]>["requests"];
      const jobs = db.prepare("SELECT j.id,j.command_request_id,j.status,j.attempt_count,j.max_attempts,j.created_at,j.updated_at FROM job_runs j JOIN (SELECT command_request_id FROM evaluation_cycle_requests WHERE cycle_id=? ORDER BY generation DESC LIMIT 100) r ON r.command_request_id=j.command_request_id ORDER BY j.created_at DESC,j.id DESC LIMIT 100").all(cycle.id) as NonNullable<EvaluationState["detail"]>["jobs"];
      result.detail = { cycle: cycleSummary(cycle), attempts, requests: requests.slice(0, 100), jobs, requests_truncated: requests.length > 100, next_attempt_cursor: rows.length > limit ? encode({ cycle_id: cycle.id, attempt: attempts.at(-1)!.attempt }) : null };
    } else {
      const cursor = input.cursor ? decode(input.cursor, cursorSchema) : null;
      if (cursor && cursor.portfolio_id !== portfolio) throw new Error("EVALUATION_CURSOR_INVALID");
      const rows = db.prepare(`SELECT * FROM evaluation_cycles WHERE portfolio_id=? AND schedule_version_id IS NOT NULL ${cursor ? "AND (period<? OR (period=? AND id<?))" : ""} ORDER BY period DESC,id DESC LIMIT ?`).all(portfolio, ...(cursor ? [cursor.period, cursor.period, cursor.id] : []), limit + 1) as CycleRow[];
      result.cycles = rows.slice(0, limit).map(cycleSummary); const last = result.cycles.at(-1);
      result.next_cursor = rows.length > limit && last ? encode({ portfolio_id: portfolio, period: last.period, id: last.id }) : null;
    }
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESPONSE_BYTES) throw new Error("EVALUATION_RESPONSE_TOO_LARGE");
    return result;
  };
  return db.inTransaction ? read() : db.transaction(read).deferred();
}
