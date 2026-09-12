import type Database from "better-sqlite3";
import { parseStrictJson } from "../strict-json";
import { verifiedMarketSource } from "../market-source";
import { collectionClock, collectionReadOnly, deadlineAt, firstFutureTrigger, instant, readCollectionHistory, requireCollectionPortfolio, triggerAt } from "./core";
import { collectionQuerySchema, collectionSlotQuerySchema } from "./schemas";
import { verifyScheduledCollectionRequest, type CollectionRequestRow } from "./verification";
import type { CollectionOptions, CollectionScheduleState, CollectionSlotDetail, CollectionSlotRow, CollectionSlotView } from "./types";

function slotView(db: Database.Database, slot: CollectionSlotRow, now: string): CollectionSlotView {
  const history = readCollectionHistory(db, slot.portfolio_id, slot.schedule_id, slot.authorization_revision + 1), version = history.versions.get(slot.schedule_version_id), control = history.controls[slot.authorization_revision - 1], next = history.controls[slot.authorization_revision];
  if (!version || !control || control.status !== "enabled" || slot.period < version.definition.start_date || (version.definition.end_date !== null && slot.period > version.definition.end_date) || slot.scope_key !== history.schedule.scope_key || slot.authorization_audit_id !== control.audit_id || slot.schedule_version_id !== control.version_id || slot.scheduled_at !== triggerAt(version.definition, slot.period) || slot.deadline_at !== deadlineAt(version.definition, slot.period) || instant(slot.scheduled_at) < instant(control.created_at) || instant(slot.created_at) < instant(slot.scheduled_at) || (next && instant(slot.scheduled_at) >= instant(next.created_at))) throw new Error("COLLECTION_EVIDENCE_INVALID");
  if (slot.disposition === "missed") {
    const endedFirst = next !== undefined && instant(next.created_at) < instant(slot.deadline_at);
    if (slot.command_request_id !== null || slot.expected_publication_revision !== null || slot.reason_code !== (endedFirst ? "AUTHORIZATION_ENDED" : "DEADLINE_EXPIRED") || instant(slot.created_at) < instant(endedFirst ? next.created_at : slot.deadline_at)) throw new Error("COLLECTION_EVIDENCE_INVALID");
    return { ...slot, job: null, capture: null };
  }
  const request = db.prepare("SELECT * FROM command_requests WHERE id=?").get(slot.command_request_id) as CollectionRequestRow | undefined;
  if (!request || !verifyScheduledCollectionRequest(db, request)) throw new Error("COLLECTION_EVIDENCE_INVALID");
  const jobs = db.prepare("SELECT id,status,attempt_count,max_attempts,updated_at FROM job_runs WHERE command_request_id=? LIMIT 2").all(request.id) as NonNullable<CollectionSlotView["job"]>[];
  if (jobs.length > 1) throw new Error("COLLECTION_EVIDENCE_INVALID");
  const captures = db.prepare("SELECT c.id,c.batch_id,c.receipt_hash,c.receipt_json,c.normalized_json,b.status FROM market_provider_captures c JOIN market_batches b ON b.id=c.batch_id WHERE c.command_request_id=? LIMIT 2").all(request.id) as { id: string; batch_id: string; receipt_hash: string; receipt_json: string; normalized_json: string; status: string }[];
  if (captures.length > 1) throw new Error("COLLECTION_EVIDENCE_INVALID");
  let capture: CollectionSlotView["capture"] = null;
  if (captures[0]) {
    const row = captures[0];
    if (row.status !== "published") throw new Error("COLLECTION_EVIDENCE_INVALID");
    const source = verifiedMarketSource(db, row.batch_id, now);
    const normalized = parseStrictJson(row.normalized_json) as { source: { last_rate_date: string } };
    if (source.mode !== "provider_observed" || source.provider !== "ecb" || source.capture_id !== row.id || source.receipt_hash !== row.receipt_hash) throw new Error("COLLECTION_EVIDENCE_INVALID");
    capture = { id: row.id, batch_id: row.batch_id, receipt_hash: row.receipt_hash, status: row.status, received_at: source.received_at, rate_date: normalized.source.last_rate_date };
  }
  return { ...slot, job: jobs[0] ?? null, capture };
}
export function getCollectionScheduleState(db: Database.Database, raw: unknown = {}, options: CollectionOptions = {}): CollectionScheduleState {
  const parsed = collectionQuerySchema.safeParse(raw); if (!parsed.success) throw new Error("COLLECTION_INVALID_QUERY"); const input = parsed.data, now = collectionClock(options);
  return db.transaction((): CollectionScheduleState => {
    const portfolios = db.prepare("SELECT id,name FROM portfolios ORDER BY created_at,id LIMIT 1001").all() as { id: string; name: string }[];
    const portfolio = input.portfolio_id ?? (portfolios.length ? portfolios[0].id : null);
    if (!portfolio) return { schema_version: "collection-schedules-v1", portfolios: [], portfolios_truncated: false, selected_portfolio_id: null, read_only: collectionReadOnly(db), server_now: now, schedules: [], schedules_truncated: false, slots: [], next_cursor: null };
    requireCollectionPortfolio(db, portfolio);
    if (input.schedule_id) readCollectionHistory(db, portfolio, input.schedule_id);
    const rows = db.prepare("SELECT id FROM collection_schedules WHERE portfolio_id=? ORDER BY created_at DESC,id DESC LIMIT 21").all(portfolio) as { id: string }[];
    const schedules = rows.slice(0, 20).map(row => {
      const { schedule, head, versions } = readCollectionHistory(db, portfolio, row.id), version = versions.get(head.current_version_id)!;
      return { id: row.id, portfolio_id: portfolio, scope_key: schedule.scope_key, schedule_revision: head.revision, status: head.status, current_version: version, last_audit_id: head.last_audit_id, updated_at: head.updated_at, next_trigger_at: head.status === "enabled" ? firstFutureTrigger(version.definition, now) : null };
    });
    type Cursor = { portfolio: string; schedule: string | null; period: string; id: string };
    let cursor: Cursor | null = null;
    if (input.cursor) {
      try {
        const decoded = Buffer.from(input.cursor, "base64url").toString("utf8"), value = parseStrictJson(decoded) as Cursor;
        if (Buffer.from(decoded).toString("base64url") !== input.cursor || Object.keys(value).sort().join(",") !== "id,period,portfolio,schedule" || value.portfolio !== portfolio || value.schedule !== (input.schedule_id ?? null) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value.period) || typeof value.id !== "string" || !value.id || value.id.length > 160) throw new Error();
        cursor = value;
      } catch { throw new Error("COLLECTION_INVALID_QUERY"); }
    }
    const limit = input.limit ?? 20;
    const slots = db.prepare("SELECT * FROM collection_schedule_slots WHERE portfolio_id=? AND (? IS NULL OR schedule_id=?) AND (? IS NULL OR period<? OR (period=? AND id<?)) ORDER BY period DESC,id DESC LIMIT ?").all(portfolio, input.schedule_id ?? null, input.schedule_id ?? null, cursor?.period ?? null, cursor?.period ?? null, cursor?.period ?? null, cursor?.id ?? null, limit + 1) as CollectionSlotRow[];
    const page = slots.slice(0, limit), last = page.at(-1);
    return { schema_version: "collection-schedules-v1", portfolios: portfolios.slice(0, 1000), portfolios_truncated: portfolios.length > 1000, selected_portfolio_id: portfolio, read_only: collectionReadOnly(db), server_now: now, schedules, schedules_truncated: rows.length > 20, slots: page.map(slot => slotView(db, slot, now)), next_cursor: slots.length > limit && last ? Buffer.from(JSON.stringify({ portfolio, schedule: input.schedule_id ?? null, period: last.period, id: last.id })).toString("base64url") : null };
  })();
}
export function getCollectionSlot(db: Database.Database, raw: unknown, options: CollectionOptions = {}): CollectionSlotDetail {
  const parsed = collectionSlotQuerySchema.safeParse(raw); if (!parsed.success) throw new Error("COLLECTION_INVALID_QUERY"); const input = parsed.data, now = collectionClock(options);
  return db.transaction((): CollectionSlotDetail => {
    requireCollectionPortfolio(db, input.portfolio_id);
    const slot = db.prepare("SELECT * FROM collection_schedule_slots WHERE id=?").get(input.slot_id) as CollectionSlotRow | undefined;
    if (!slot) throw new Error("COLLECTION_SLOT_NOT_FOUND"); if (slot.portfolio_id !== input.portfolio_id) throw new Error("COLLECTION_OUT_OF_SCOPE");
    const view = slotView(db, slot, now), history = readCollectionHistory(db, input.portfolio_id, slot.schedule_id, slot.authorization_revision + 1);
    const rows = view.job ? db.prepare("SELECT attempt,status,started_at,finished_at,error_json FROM job_attempts WHERE job_id=? ORDER BY attempt LIMIT 6").all(view.job.id) as (Omit<CollectionSlotDetail["attempts"][number], "error_code"> & { error_json: string | null })[] : [];
    const attempts = rows.map(({ error_json, ...row }) => {
      let code: unknown = null;
      try { if (error_json) code = (parseStrictJson(error_json) as { code?: unknown }).code; } catch { /* Do not expose worker error text. */ }
      return { ...row, error_code: typeof code === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(code) ? code : error_json ? "COLLECTION_JOB_FAILED" : null };
    });
    if (attempts.length > 5) throw new Error("COLLECTION_EVIDENCE_INVALID");
    return { schema_version: "collection-slot-v1", portfolio_id: input.portfolio_id, read_only: collectionReadOnly(db), server_now: now, slot: view, version: history.versions.get(slot.schedule_version_id)!, attempts };
  })();
}
