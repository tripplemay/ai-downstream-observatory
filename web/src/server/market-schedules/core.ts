import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonical } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { referenceClock, referenceInstant, referenceReadOnly } from "../market-references/service";
import { collectionScheduleSchema, saveCollectionScheduleSchema, setCollectionScheduleStatusSchema } from "./schemas";
import type { CollectionControl, CollectionOptions, CollectionScheduleDefinition, CollectionScheduleReceipt, CollectionScheduleRow, CollectionVersionView } from "./types";

const CLIENT_ERRORS = new Set(["COLLECTION_PERMISSION_DENIED", "COLLECTION_INVALID_COMMAND", "COLLECTION_INVALID_DEFINITION", "COLLECTION_DEFINITION_TOO_LARGE", "COLLECTION_INVALID_CLOCK", "COLLECTION_PORTFOLIO_NOT_FOUND", "COLLECTION_SCHEDULE_NOT_FOUND", "COLLECTION_SLOT_NOT_FOUND", "COLLECTION_OUT_OF_SCOPE", "COLLECTION_SCHEDULE_CONFLICT", "COLLECTION_IDEMPOTENCY_CONFLICT", "COLLECTION_SCOPE_CONFLICT", "COLLECTION_STATUS_UNCHANGED", "COLLECTION_NO_FUTURE_TRIGGER", "COLLECTION_INVALID_QUERY", "COLLECTION_LIMIT_REACHED"]);
export const isCollectionClientError = (code: string) => CLIENT_ERRORS.has(code);
export const rawHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export function collectionClock(options: CollectionOptions = {}) { try { return referenceClock(options); } catch { throw new Error("COLLECTION_INVALID_CLOCK"); } }
export const instant = referenceInstant;
export const collectionReadOnly = referenceReadOnly;
export function collectionScope(definition: CollectionScheduleDefinition) { return `provider:ecb:fx:daily:${[...definition.currencies].sort().join("-")}`; }
export function parseCollectionDefinition(raw: string): CollectionScheduleDefinition {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 65536) throw new Error("COLLECTION_DEFINITION_TOO_LARGE");
  try {
    if (Buffer.from(raw, "utf8").toString("utf8") !== raw || raw.startsWith("\uFEFF")) throw new Error();
    const parsed = collectionScheduleSchema.safeParse(parseStrictJson(raw)); if (!parsed.success) throw new Error(); return parsed.data;
  } catch { throw new Error("COLLECTION_INVALID_DEFINITION"); }
}
export function triggerAt(definition: CollectionScheduleDefinition, period: string) {
  const value = `${period}T${String(definition.trigger.hour).padStart(2, "0")}:${String(definition.trigger.minute).padStart(2, "0")}:00.000000Z`;
  instant(value); return value;
}
export function deadlineAt(definition: CollectionScheduleDefinition, period: string) { return new Date(Date.parse(triggerAt(definition, period)) + definition.deadline_seconds * 1000).toISOString().replace(/(\.\d{3})Z$/, "$1000Z"); }
export function firstFutureTrigger(definition: CollectionScheduleDefinition, now: string): string | null {
  instant(now); let day = definition.start_date > now.slice(0, 10) ? definition.start_date : now.slice(0, 10);
  if (instant(triggerAt(definition, day)) < instant(now)) day = new Date(Date.parse(day + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  return definition.end_date !== null && day > definition.end_date ? null : triggerAt(definition, day);
}
export type HeadRow = { schedule_id: string; scope_key: string; current_version_id: string; revision: number; status: "enabled" | "paused"; last_audit_id: string; updated_at: string };
type VersionRow = Omit<CollectionVersionView, "definition"> & { schedule_id: string };
type AuditRow = { id: string; actor_id: string; action: string; object_type: string; object_id: string; portfolio_id: string; ledger_revision: number | null; payload_json: string; created_at: string };
export function requireCollectionPortfolio(db: Database.Database, id: string) { if (!db.prepare("SELECT 1 FROM portfolios WHERE id=?").get(id)) throw new Error("COLLECTION_PORTFOLIO_NOT_FOUND"); }
export function readCollectionHistory(db: Database.Database, portfolio: string, scheduleId: string, throughRevision?: number) {
  const schedule = db.prepare("SELECT * FROM collection_schedules WHERE id=?").get(scheduleId) as CollectionScheduleRow | undefined;
  if (!schedule) throw new Error("COLLECTION_SCHEDULE_NOT_FOUND");
  if (schedule.portfolio_id !== portfolio) throw new Error("COLLECTION_OUT_OF_SCOPE");
  try {
    instant(schedule.created_at); if (schedule.provider !== "ecb" || !schedule.created_by.trim()) throw new Error();
    if (throughRevision !== undefined && (!Number.isSafeInteger(throughRevision) || throughRevision < 1 || throughRevision > 1024)) throw new Error();
    const controls = db.prepare("SELECT * FROM collection_schedule_controls WHERE schedule_id=? AND revision<=? ORDER BY revision LIMIT 1025").all(scheduleId, throughRevision ?? Number.MAX_SAFE_INTEGER) as CollectionControl[];
    const rows = (throughRevision === undefined
      ? db.prepare("SELECT * FROM collection_schedule_versions WHERE schedule_id=? ORDER BY version LIMIT 1024").all(scheduleId)
      : db.prepare("SELECT DISTINCT v.* FROM collection_schedule_versions v JOIN collection_schedule_controls c ON c.version_id=v.id WHERE c.schedule_id=? AND c.revision<=? ORDER BY v.version LIMIT 1024").all(scheduleId, throughRevision)) as VersionRow[];
    const last = controls.at(-1);
    const head = throughRevision === undefined ? db.prepare("SELECT * FROM collection_schedule_heads WHERE schedule_id=?").get(scheduleId) as HeadRow | undefined : last && { schedule_id: schedule.id, scope_key: schedule.scope_key, current_version_id: last.version_id, revision: last.revision, status: last.status, last_audit_id: last.audit_id, updated_at: last.created_at };
    if (!head || rows.length < 1 || rows.length > 1023 || controls.length < 1 || controls.length > 1024) throw new Error();
    const versions = new Map<string, CollectionVersionView>();
    for (const [index, row] of rows.entries()) {
      const definition = parseCollectionDefinition(row.definition_json); instant(row.created_at);
      if (row.version !== index + 1 || collectionScope(definition) !== schedule.scope_key || rawHash(row.definition_json) !== row.content_hash || !row.created_by.trim()) throw new Error();
      versions.set(row.id, { id: row.id, version: row.version, definition_json: row.definition_json, definition, content_hash: row.content_hash, created_by: row.created_by, created_at: row.created_at, audit_id: row.audit_id });
    }
    let versionNumber = 0;
    for (const [index, control] of controls.entries()) {
      const version = versions.get(control.version_id), previous = controls[index - 1];
      if (!version || control.revision !== index + 1 || instant(control.created_at) < instant(previous?.created_at ?? schedule.created_at)) throw new Error();
      const event = db.prepare("SELECT * FROM audit_events WHERE id=?").get(control.audit_id) as AuditRow | undefined;
      if (!event || event.object_type !== "collection_schedule" || event.object_id !== schedule.id || event.portfolio_id !== portfolio || event.ledger_revision !== null || event.created_at !== control.created_at || !event.actor_id.trim() || event.actor_id.startsWith("system:")) throw new Error();
      const payload = parseStrictJson(event.payload_json) as Record<string, unknown>;
      const result: CollectionScheduleReceipt = { schedule_id: schedule.id, version_id: version.id, version: version.version, schedule_revision: control.revision, status: control.status, scope_key: schedule.scope_key, content_hash: version.content_hash };
      if (event.action === "save_collection_schedule") {
        const parsed = saveCollectionScheduleSchema.safeParse(payload.input); if (!parsed.success) throw new Error();
        const input = parsed.data;
        if (control.status !== "paused" || version.version !== versionNumber + 1 || input.portfolio_id !== portfolio || input.expected_schedule_id !== (index === 0 ? null : schedule.id) || input.expected_schedule_revision !== control.revision - 1 || input.definition_json !== version.definition_json || version.audit_id !== event.id || version.created_at !== event.created_at || version.created_by !== event.actor_id) throw new Error();
        if (index === 0 && (schedule.created_at !== event.created_at || schedule.created_by !== event.actor_id)) throw new Error();
        versionNumber++;
        if (canonical(payload) !== canonical({ actor_kind: "human", input, result })) throw new Error();
      } else if (event.action === "set_collection_schedule_status") {
        const parsed = setCollectionScheduleStatusSchema.safeParse(payload.input); if (!parsed.success) throw new Error();
        const input = parsed.data;
        if (!previous || previous.version_id !== version.id || input.portfolio_id !== portfolio || input.schedule_id !== schedule.id || input.expected_schedule_revision !== control.revision - 1 || input.status !== control.status || version.version !== versionNumber) throw new Error();
        if (canonical(payload) !== canonical({ actor_kind: "human", input, result })) throw new Error();
      } else throw new Error();
      if (control.revision === 1024 && (event.action !== "set_collection_schedule_status" || previous?.status !== "enabled" || control.status !== "paused")) throw new Error();
    }
    if (!last || versionNumber !== versions.size || head.scope_key !== schedule.scope_key || head.current_version_id !== last.version_id || head.revision !== last.revision || head.status !== last.status || head.last_audit_id !== last.audit_id || head.updated_at !== last.created_at) throw new Error();
    return { schedule, head, versions, controls };
  } catch { throw new Error("COLLECTION_EVIDENCE_INVALID"); }
}
