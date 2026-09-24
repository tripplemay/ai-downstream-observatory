import type Database from "better-sqlite3";
import { parseStrictJson } from "../strict-json";
import { verifiedSdkMarketSource } from "../market-price-source";
import { readMarketReferenceVersion, type CalendarFacts, type MappingFacts } from "../market-references/service";
import { firstFuturePriceTrigger, instant, priceCollectionClock, priceCollectionReadOnly, readPriceCollectionHistory, requirePriceCollectionPortfolio } from "./core";
import { assertPriceReferenceHeads, priceScheduleReferences, priceSessionDisposition } from "./references";
import { priceCollectionQuerySchema, priceCollectionSlotQuerySchema, priceScheduleDateSchema, priceScheduleIdSchema } from "./schemas";
import { verifyPriceCollectionSlotIdentity, verifyScheduledPriceCollectionRequest, type PriceCollectionRequestRow } from "./verification";
import type { PriceCollectionOptions, PriceCollectionScheduleState, PriceCollectionSlotDetail, PriceCollectionSlotRow, PriceCollectionSlotView, PriceReferenceCandidate } from "./types";

function slotView(db: Database.Database, slot: PriceCollectionSlotRow, now: string): PriceCollectionSlotView {
  try {
    const { version, next } = verifyPriceCollectionSlotIdentity(db, slot);
    if (instant(slot.created_at) > instant(now)) throw new Error();
    if (slot.disposition !== "requested") {
      if (slot.command_request_id !== null || slot.expected_publication_revision !== null) throw new Error();
      if (slot.disposition === "missed") {
        const endedFirst = next !== undefined && instant(next.created_at) < instant(slot.deadline_at);
        if (slot.reason_code !== (endedFirst ? "AUTHORIZATION_ENDED" : "DEADLINE_EXPIRED") || instant(slot.created_at) < instant(endedFirst ? next.created_at : slot.deadline_at)) throw new Error();
      } else {
        if (instant(slot.created_at) >= instant(slot.deadline_at) || (next && instant(slot.created_at) >= instant(next.created_at))) throw new Error();
        let changed = false;
        try { assertPriceReferenceHeads(db, version.reference_binding, slot.created_at); } catch { changed = true; }
        if (slot.disposition === "blocked" && slot.reason_code === "REFERENCE_CHANGED") { if (!changed) throw new Error(); }
        else if (slot.disposition === "blocked" && slot.reason_code === "REFERENCE_INVALID") {
          let invalid = false; try { priceScheduleReferences(db, slot.portfolio_id, version.definition, slot.created_at); } catch { invalid = true; }
          if (!invalid) throw new Error();
        } else {
          if (changed) throw new Error();
          const disposition = priceSessionDisposition(db, slot.portfolio_id, version.reference_binding, slot.period);
          if (!(slot.disposition === "skipped" && slot.reason_code === "MARKET_CLOSED" && disposition === "closed")
            && !(slot.disposition === "blocked" && slot.reason_code === "MIXED_CALENDAR_SESSION" && disposition === "mixed")) throw new Error();
        }
      }
      return { ...slot, job: null, capture: null };
    }
    const request = db.prepare("SELECT * FROM command_requests WHERE id=?").get(slot.command_request_id) as PriceCollectionRequestRow | undefined;
    if (!request || !verifyScheduledPriceCollectionRequest(db, request)) throw new Error();
    type JobRow = NonNullable<PriceCollectionSlotView["job"]> & { scope: string; period: string; job_type: string; input_version: string; created_at: string };
    const jobs = db.prepare("SELECT * FROM job_runs WHERE command_request_id=? LIMIT 2").all(request.id) as JobRow[];
    if (jobs.length > 1) throw new Error();
    const job = jobs[0];
    if (job && (job.scope !== slot.portfolio_id || job.period !== slot.period || job.job_type !== "market_collect_prices"
      || job.input_version !== request.id + ":" + request.payload_hash || job.max_attempts !== version.definition.max_attempts
      || !Number.isSafeInteger(job.attempt_count) || job.attempt_count < 0 || job.attempt_count > job.max_attempts
      || instant(job.created_at) < instant(request.created_at) || instant(job.updated_at) > instant(now))) throw new Error();
    const captures = db.prepare("SELECT c.id,c.batch_id,c.receipt_hash,b.status FROM market_sdk_captures c JOIN market_batches b ON b.id=c.batch_id WHERE c.command_request_id=? LIMIT 2").all(request.id) as { id: string; batch_id: string; receipt_hash: string; status: string }[];
    if (captures.length > 1 || (!captures.length && job?.status === "succeeded")) throw new Error();
    let capture: PriceCollectionSlotView["capture"] = null;
    if (captures[0]) {
      const row = captures[0];
      if (!job || job.status !== "succeeded" || row.status !== "published" || instant(job.updated_at) >= instant(slot.deadline_at) || (next && instant(job.updated_at) >= instant(next.created_at))) throw new Error();
      // Read historical proof at its committed knowledge time, not at a later reference head.
      const source = verifiedSdkMarketSource(db, row.batch_id, job.updated_at);
      if (source.portfolio_id !== slot.portfolio_id || source.capture_id !== row.id || source.receipt_hash !== row.receipt_hash
        || instant(source.received_at) < instant(slot.scheduled_at) || instant(source.received_at) >= instant(slot.deadline_at)) throw new Error();
      capture = { id: row.id, batch_id: row.batch_id, receipt_hash: row.receipt_hash, status: row.status, received_at: source.received_at };
    }
    return { ...slot, job: job ? { id: job.id, status: job.status, attempt_count: job.attempt_count, max_attempts: job.max_attempts, updated_at: job.updated_at } : null, capture };
  } catch { throw new Error("PRICE_COLLECTION_EVIDENCE_INVALID"); }
}
function referenceCandidates(db: Database.Database, portfolio: string, now: string) {
  const heads = db.prepare("SELECT kind,scope_key,version,version_id,updated_at FROM market_reference_heads WHERE portfolio_id=? ORDER BY kind,scope_key LIMIT 1001").all(portfolio) as { kind: "mapping" | "calendar"; scope_key: string; version: number; version_id: string; updated_at: string }[];
  const candidates: PriceReferenceCandidate[] = heads.slice(0, 1000).map(head => {
    const { row, document } = readMarketReferenceVersion(db, portfolio, head.version_id), facts = document.facts;
    if (row.kind !== head.kind || row.scope_key !== head.scope_key || row.version !== head.version || row.known_at !== head.updated_at || instant(row.known_at) > instant(now)) throw new Error("PRICE_COLLECTION_REFERENCE_INVALID");
    const mapping = document.kind === "mapping" ? facts as MappingFacts : null, calendar = document.kind === "calendar" ? facts as CalendarFacts : null;
    return { id: row.id, kind: row.kind, market: facts.market, scope_key: row.scope_key, version: row.version, known_at: row.known_at, content_hash: row.content_hash,
      listing_id: mapping?.listing_id ?? null, provider_symbol: mapping?.provider_symbol ?? null, exchange: facts.exchange,
      range_start: mapping ? mapping.valid_from : calendar!.range_start, range_end: mapping ? mapping.valid_to : calendar!.range_end,
      verification_status: "human_reviewed_not_provider_verified" };
  });
  return { candidates, truncated: heads.length > 1000 };
}
export function getPriceCollectionScheduleState(db: Database.Database, raw: unknown = {}, options: PriceCollectionOptions = {}): PriceCollectionScheduleState {
  const parsed = priceCollectionQuerySchema.safeParse(raw); if (!parsed.success) throw new Error("PRICE_COLLECTION_INVALID_QUERY"); const input = parsed.data, now = priceCollectionClock(options);
  return db.transaction((): PriceCollectionScheduleState => {
    const portfolios = db.prepare("SELECT id,name FROM portfolios ORDER BY created_at,id LIMIT 1001").all() as { id: string; name: string }[];
    const portfolio = input.portfolio_id ?? (portfolios.length ? portfolios[0].id : null);
    if (!portfolio) return { schema_version: "price-collection-schedules-v1", portfolios: [], portfolios_truncated: false, selected_portfolio_id: null, read_only: priceCollectionReadOnly(db), server_now: now, reference_candidates: [], reference_candidates_truncated: false, schedules: [], schedules_truncated: false, slots: [], next_cursor: null };
    requirePriceCollectionPortfolio(db, portfolio);
    if (input.schedule_id) readPriceCollectionHistory(db, portfolio, input.schedule_id);
    const rows = db.prepare("SELECT id FROM price_collection_schedules WHERE portfolio_id=? ORDER BY created_at DESC,id DESC LIMIT 21").all(portfolio) as { id: string }[];
    const schedules = rows.slice(0, 20).map(row => {
      const { schedule, head, versions } = readPriceCollectionHistory(db, portfolio, row.id), version = versions.get(head.current_version_id)!;
      let reference_status: "current" | "changed" | "invalid" = "current";
      try { assertPriceReferenceHeads(db, version.reference_binding); } catch { reference_status = "changed"; }
      const future = head.status === "enabled" ? firstFuturePriceTrigger(version.definition, now) : null;
      return { id: row.id, portfolio_id: portfolio, scope_key: schedule.scope_key, market: schedule.market, schedule_revision: head.revision, status: head.status,
        current_version: version, last_audit_id: head.last_audit_id, updated_at: head.updated_at,
        next_trigger_at: future?.scheduled_at ?? null, next_target_date: future?.period ?? null, reference_status };
    });
    type Cursor = { portfolio: string; schedule: string | null; period: string; id: string };
    let cursor: Cursor | null = null;
    if (input.cursor) {
      try {
        const decoded = Buffer.from(input.cursor, "base64url").toString("utf8"), value = parseStrictJson(decoded) as Cursor;
        if (Buffer.from(decoded).toString("base64url") !== input.cursor || Object.keys(value).sort().join(",") !== "id,period,portfolio,schedule"
          || value.portfolio !== portfolio || value.schedule !== (input.schedule_id ?? null) || !priceScheduleDateSchema.safeParse(value.period).success || !priceScheduleIdSchema.safeParse(value.id).success) throw new Error();
        cursor = value;
      } catch { throw new Error("PRICE_COLLECTION_INVALID_QUERY"); }
    }
    const limit = input.limit ?? 20;
    const slots = db.prepare("SELECT * FROM price_collection_schedule_slots WHERE portfolio_id=? AND (? IS NULL OR schedule_id=?) AND (? IS NULL OR period<? OR (period=? AND id<?)) ORDER BY period DESC,id DESC LIMIT ?").all(portfolio, input.schedule_id ?? null, input.schedule_id ?? null, cursor?.period ?? null, cursor?.period ?? null, cursor?.period ?? null, cursor?.id ?? null, limit + 1) as PriceCollectionSlotRow[];
    const page = slots.slice(0, limit), last = page.at(-1), references = referenceCandidates(db, portfolio, now);
    return { schema_version: "price-collection-schedules-v1", portfolios: portfolios.slice(0, 1000), portfolios_truncated: portfolios.length > 1000, selected_portfolio_id: portfolio,
      read_only: priceCollectionReadOnly(db), server_now: now, reference_candidates: references.candidates, reference_candidates_truncated: references.truncated,
      schedules, schedules_truncated: rows.length > 20, slots: page.map(slot => slotView(db, slot, now)),
      next_cursor: slots.length > limit && last ? Buffer.from(JSON.stringify({ portfolio, schedule: input.schedule_id ?? null, period: last.period, id: last.id })).toString("base64url") : null };
  })();
}
export function getPriceCollectionSlot(db: Database.Database, raw: unknown, options: PriceCollectionOptions = {}): PriceCollectionSlotDetail {
  const parsed = priceCollectionSlotQuerySchema.safeParse(raw); if (!parsed.success) throw new Error("PRICE_COLLECTION_INVALID_QUERY"); const input = parsed.data, now = priceCollectionClock(options);
  return db.transaction((): PriceCollectionSlotDetail => {
    requirePriceCollectionPortfolio(db, input.portfolio_id);
    const slot = db.prepare("SELECT * FROM price_collection_schedule_slots WHERE id=?").get(input.slot_id) as PriceCollectionSlotRow | undefined;
    if (!slot) throw new Error("PRICE_COLLECTION_SLOT_NOT_FOUND"); if (slot.portfolio_id !== input.portfolio_id) throw new Error("PRICE_COLLECTION_OUT_OF_SCOPE");
    const view = slotView(db, slot, now), history = readPriceCollectionHistory(db, input.portfolio_id, slot.schedule_id, slot.authorization_revision + 1);
    const rows = view.job ? db.prepare("SELECT attempt,status,started_at,finished_at,error_json FROM job_attempts WHERE job_id=? ORDER BY attempt LIMIT 6").all(view.job.id) as (Omit<PriceCollectionSlotDetail["attempts"][number], "error_code"> & { error_json: string | null })[] : [];
    const attempts = rows.map(({ error_json, ...row }) => {
      let code: unknown = null;
      try { if (error_json) code = (parseStrictJson(error_json) as { code?: unknown }).code; } catch { /* Never return private worker exception text. */ }
      return { ...row, error_code: typeof code === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(code) ? code : error_json ? "PRICE_COLLECTION_JOB_FAILED" : null };
    });
    if (attempts.length > 5 || (view.job && attempts.length !== view.job.attempt_count) || attempts.some((row, index) => row.attempt !== index + 1)) throw new Error("PRICE_COLLECTION_EVIDENCE_INVALID");
    return { schema_version: "price-collection-slot-v1", portfolio_id: input.portfolio_id, read_only: priceCollectionReadOnly(db), server_now: now, slot: view, version: history.versions.get(slot.schedule_version_id)!, attempts };
  })();
}
