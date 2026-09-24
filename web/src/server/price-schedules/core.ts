import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { referenceClock, referenceInstant, referenceReadOnly } from "../market-references/service";
import { priceCollectionScheduleSchema, savePriceCollectionScheduleSchema, setPriceCollectionScheduleStatusSchema } from "./schemas";
import { priceCollectionScope, priceScheduleReferences } from "./references";
import type { PriceCollectionControl, PriceCollectionOptions, PriceCollectionScheduleDefinition, PriceCollectionScheduleReceipt, PriceCollectionScheduleRow, PriceCollectionVersionView } from "./types";

const CLIENT_ERRORS = new Set(["PRICE_COLLECTION_PERMISSION_DENIED", "PRICE_COLLECTION_INVALID_COMMAND", "PRICE_COLLECTION_INVALID_DEFINITION", "PRICE_COLLECTION_DEFINITION_TOO_LARGE", "PRICE_COLLECTION_INVALID_CLOCK", "PRICE_COLLECTION_INVALID_TRIGGER", "PRICE_COLLECTION_OVERLAPPING_WINDOWS", "PRICE_COLLECTION_PORTFOLIO_NOT_FOUND", "PRICE_COLLECTION_SCHEDULE_NOT_FOUND", "PRICE_COLLECTION_SLOT_NOT_FOUND", "PRICE_COLLECTION_OUT_OF_SCOPE", "PRICE_COLLECTION_SCHEDULE_CONFLICT", "PRICE_COLLECTION_IDEMPOTENCY_CONFLICT", "PRICE_COLLECTION_SCOPE_CONFLICT", "PRICE_COLLECTION_NO_FUTURE_TRIGGER", "PRICE_COLLECTION_INVALID_QUERY", "PRICE_COLLECTION_LIMIT_REACHED", "PRICE_COLLECTION_REFERENCE_INVALID", "PRICE_COLLECTION_REFERENCE_CHANGED"]);
export const isPriceCollectionClientError = (code: string) => CLIENT_ERRORS.has(code);
export const rawHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export function priceCollectionClock(options: PriceCollectionOptions = {}) { try { return referenceClock(options); } catch { throw new Error("PRICE_COLLECTION_INVALID_CLOCK"); } }
export const instant = referenceInstant;
export const priceCollectionReadOnly = referenceReadOnly;
export const validHumanId = (id: unknown): id is string => typeof id === "string" && /^[\x21-\x7e]{1,160}$/.test(id) && !/^system(?::|$)/i.test(id);
export function requirePriceCollectionPortfolio(db: Database.Database, id: string) { if (!db.prepare("SELECT 1 FROM portfolios WHERE id=?").get(id)) throw new Error("PRICE_COLLECTION_PORTFOLIO_NOT_FOUND"); }
const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(at: Date, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); formatters.set(zone, formatter); }
  const parts = formatter.formatToParts(at);
  return ["year", "month", "day", "hour", "minute", "second"].map(type => Number(parts.find(part => part.type === type)!.value));
}
export function nextDay(period: string) {
  const value = new Date(Date.parse(period + "T00:00:00Z") + 86400000).toISOString();
  if (!/^\d{4}-/.test(value) || value.startsWith("0000")) throw new Error("PRICE_COLLECTION_INVALID_TRIGGER");
  return value.slice(0, 10);
}
export function priceTriggerAt(definition: PriceCollectionScheduleDefinition, period: string) {
  const date = nextDay(period), desired = [...date.split("-").map(Number), definition.trigger_local.hour, definition.trigger_local.minute, 0];
  const naive = Date.parse(`${date}T${String(desired[3]).padStart(2, "0")}:${String(desired[4]).padStart(2, "0")}:00Z`), offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const at = new Date(naive + delta * 3600000), p = localParts(at, definition.timezone);
    const represented = Date.parse(`${String(p[0]).padStart(4, "0")}-${String(p[1]).padStart(2, "0")}-${String(p[2]).padStart(2, "0")}T${String(p[3]).padStart(2, "0")}:${String(p[4]).padStart(2, "0")}:${String(p[5]).padStart(2, "0")}Z`);
    offsets.add(represented - at.getTime());
  }
  const matches = [...offsets].map(offset => new Date(naive - offset)).filter(at => localParts(at, definition.timezone).every((value, i) => value === desired[i]));
  if (matches.length !== 1 || !/^\d{4}-/.test(matches[0].toISOString())) throw new Error("PRICE_COLLECTION_INVALID_TRIGGER");
  return matches[0].toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
}
export function priceDeadlineAt(definition: PriceCollectionScheduleDefinition, period: string) {
  const result = new Date(Date.parse(priceTriggerAt(definition, period)) + definition.deadline_seconds * 1000).toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
  try { instant(result); } catch { throw new Error("PRICE_COLLECTION_INVALID_TRIGGER"); } return result;
}
const timingValidated = new Map<string, true>();
export function parsePriceCollectionDefinition(raw: string): PriceCollectionScheduleDefinition {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 65536) throw new Error("PRICE_COLLECTION_DEFINITION_TOO_LARGE");
  let definition: PriceCollectionScheduleDefinition;
  try {
    if (Buffer.from(raw, "utf8").toString("utf8") !== raw || raw.startsWith("\uFEFF")) throw new Error();
    const parsed = priceCollectionScheduleSchema.safeParse(parseStrictJson(raw)); if (!parsed.success) throw new Error(); definition = parsed.data;
  } catch { throw new Error("PRICE_COLLECTION_INVALID_DEFINITION"); }
  const digest = rawHash(raw);
  if (!timingValidated.has(digest)) {
    let previousDeadline: string | null = null;
    for (let day = definition.start_date; day <= definition.end_date; day = nextDay(day)) {
      const due = priceTriggerAt(definition, day), deadline = priceDeadlineAt(definition, day);
      if (previousDeadline && instant(due) < instant(previousDeadline)) throw new Error("PRICE_COLLECTION_OVERLAPPING_WINDOWS");
      previousDeadline = deadline;
      if (day === definition.end_date) break;
    }
    if (timingValidated.size >= 128) timingValidated.delete(timingValidated.keys().next().value!);
    timingValidated.set(digest, true);
  }
  return definition;
}
export function firstFuturePriceTrigger(definition: PriceCollectionScheduleDefinition, now: string) {
  instant(now);
  for (let period = definition.start_date; period <= definition.end_date; period = nextDay(period)) {
    const scheduled_at = priceTriggerAt(definition, period);
    if (instant(scheduled_at) >= instant(now)) return { period, scheduled_at };
    if (period === definition.end_date) break;
  }
  return null;
}
export type PriceHeadRow = { schedule_id: string; scope_key: string; current_version_id: string; revision: number; status: "enabled" | "paused"; last_audit_id: string; updated_at: string };
type VersionRow = Omit<PriceCollectionVersionView, "definition" | "reference_binding"> & { schedule_id: string };
type AuditRow = { id: string; actor_id: string; action: string; object_type: string; object_id: string; portfolio_id: string; ledger_revision: number | null; payload_json: string; created_at: string };
export function readPriceCollectionHistory(db: Database.Database, portfolio: string, scheduleId: string, throughRevision?: number) {
  const schedule = db.prepare("SELECT * FROM price_collection_schedules WHERE id=?").get(scheduleId) as PriceCollectionScheduleRow | undefined;
  if (!schedule) throw new Error("PRICE_COLLECTION_SCHEDULE_NOT_FOUND");
  if (schedule.portfolio_id !== portfolio) throw new Error("PRICE_COLLECTION_OUT_OF_SCOPE");
  try {
    instant(schedule.created_at); if (schedule.provider !== "longport" || !validHumanId(schedule.created_by)) throw new Error();
    if (throughRevision !== undefined && (!Number.isSafeInteger(throughRevision) || throughRevision < 1 || throughRevision > 1024)) throw new Error();
    const controls = db.prepare("SELECT * FROM price_collection_schedule_controls WHERE schedule_id=? AND revision<=? ORDER BY revision LIMIT 1025").all(scheduleId, throughRevision ?? 1024) as PriceCollectionControl[];
    const rows = db.prepare("SELECT DISTINCT v.* FROM price_collection_schedule_versions v JOIN price_collection_schedule_controls c ON c.version_id=v.id WHERE c.schedule_id=? AND c.revision<=? ORDER BY v.version LIMIT 1024").all(scheduleId, throughRevision ?? 1024) as VersionRow[];
    const last = controls.at(-1);
    const head = throughRevision === undefined ? db.prepare("SELECT * FROM price_collection_schedule_heads WHERE schedule_id=?").get(scheduleId) as PriceHeadRow | undefined : last && { schedule_id: schedule.id, scope_key: schedule.scope_key, current_version_id: last.version_id, revision: last.revision, status: last.status, last_audit_id: last.audit_id, updated_at: last.created_at };
    if (!head || rows.length < 1 || rows.length > 1023 || controls.length < 1 || controls.length > 1024) throw new Error();
    const versions = new Map<string, PriceCollectionVersionView>();
    for (const [index, row] of rows.entries()) {
      const definition = parsePriceCollectionDefinition(row.definition_json); instant(row.created_at);
      const binding = priceScheduleReferences(db, portfolio, definition, row.created_at);
      if (row.version !== index + 1 || row.schedule_id !== scheduleId || schedule.market !== definition.market || priceCollectionScope(binding) !== schedule.scope_key || rawHash(row.definition_json) !== row.content_hash || !validHumanId(row.created_by)
        || canonical(binding) !== row.reference_binding_json || hash(binding) !== row.reference_binding_hash) throw new Error();
      versions.set(row.id, { id: row.id, version: row.version, definition_json: row.definition_json, definition, content_hash: row.content_hash, reference_binding_json: row.reference_binding_json, reference_binding_hash: row.reference_binding_hash, reference_binding: binding, created_by: row.created_by, created_at: row.created_at, audit_id: row.audit_id });
    }
    let versionNumber = 0;
    for (const [index, control] of controls.entries()) {
      const version = versions.get(control.version_id), previous = controls[index - 1];
      if (!version || control.schedule_id !== scheduleId || control.revision !== index + 1 || instant(control.created_at) < instant(previous?.created_at ?? schedule.created_at) || instant(version.created_at) > instant(control.created_at)) throw new Error();
      const event = db.prepare("SELECT * FROM audit_events WHERE id=?").get(control.audit_id) as AuditRow | undefined;
      if (!event || event.object_type !== "price_collection_schedule" || event.object_id !== schedule.id || event.portfolio_id !== portfolio || event.ledger_revision !== null || event.created_at !== control.created_at || !validHumanId(event.actor_id)) throw new Error();
      const payload = parseStrictJson(event.payload_json) as Record<string, unknown>;
      const result: PriceCollectionScheduleReceipt = { schedule_id: schedule.id, version_id: version.id, version: version.version, schedule_revision: control.revision, status: control.status, scope_key: schedule.scope_key, content_hash: version.content_hash };
      if (event.action === "save_price_collection_schedule") {
        const parsed = savePriceCollectionScheduleSchema.safeParse(payload.input); if (!parsed.success) throw new Error(); const input = parsed.data;
        if (control.status !== "paused" || version.version !== versionNumber + 1 || input.portfolio_id !== portfolio || input.expected_schedule_id !== (index === 0 ? null : schedule.id) || input.expected_schedule_revision !== control.revision - 1 || input.definition_json !== version.definition_json || version.audit_id !== event.id || version.created_at !== event.created_at || version.created_by !== event.actor_id) throw new Error();
        if (index === 0 && (schedule.created_at !== event.created_at || schedule.created_by !== event.actor_id)) throw new Error();
        versionNumber++;
        if (canonical(payload) !== canonical({ actor_kind: "human", input, result })) throw new Error();
      } else if (event.action === "set_price_collection_schedule_status") {
        const parsed = setPriceCollectionScheduleStatusSchema.safeParse(payload.input); if (!parsed.success) throw new Error(); const input = parsed.data;
        if (!previous || previous.version_id !== version.id || input.portfolio_id !== portfolio || input.schedule_id !== schedule.id || input.expected_schedule_revision !== control.revision - 1 || input.status !== control.status || version.version !== versionNumber) throw new Error();
        if (canonical(payload) !== canonical({ actor_kind: "human", input, result })) throw new Error();
      } else throw new Error();
      if (control.revision === 1024 && (event.action !== "set_price_collection_schedule_status" || previous?.status !== "enabled" || control.status !== "paused")) throw new Error();
    }
    if (!last || versionNumber !== versions.size || head.scope_key !== schedule.scope_key || head.current_version_id !== last.version_id || head.revision !== last.revision || head.status !== last.status || head.last_audit_id !== last.audit_id || head.updated_at !== last.created_at) throw new Error();
    return { schedule, head, versions, controls };
  } catch { throw new Error("PRICE_COLLECTION_EVIDENCE_INVALID"); }
}
