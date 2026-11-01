import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { canonical, hash } from "../ledger/service";
import { amount } from "../ledger/decimal";
import { parseStrictJson } from "../strict-json";
import { priceInstant, replayLongportProjection } from "../market-price-source";
import { investorInstant } from "./schemas";
import { validateInvestorSourceDocument } from "./kernel-contracts";
import { readInvestorConfirmedCapture } from "./confirmed-source";
import { managedFxReviewUnavailable, verifyManagedFxReview } from "./managed-fx-source";
import { currentCalendarReview } from "./calendar-continuation";
import { MANAGED_ACTION_PREFIX, managedActionReviewUnavailable, readManagedActionReview } from "./managed-action-source";
import { actionAvailabilityRefs, indexActionAvailability } from "./monitor-action-knowledge";

type Obj = Record<string, unknown>;
type Row = { id: string; workspace_id: string; document_json: string; content_hash: string; created_at: string; actor_id: string; audit_id: string; valid_until: string; source_qualification: string };
export type VerifiedSourceReview = { row: Row & { source_id: string; version: number; decision: string }; source: Row & { kind: string }; facts: Obj };
type Review = VerifiedSourceReview;
export type SourceRequest = { input_id: string | null; evidence_input_id?: string | null };
const zones: Record<string, string> = { CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" };
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_EVIDENCE_INVALID"); }
function obj(value: unknown): Obj { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function list(value: unknown, max = 100000): Obj[] { check(Array.isArray(value) && value.length <= max); return value.map(obj); }
function eq(a: unknown, b: unknown) { check(hash(a) === hash(b)); }
function json(raw: string, maximum = 8388608) { check(Buffer.byteLength(raw) <= maximum); return obj(parseStrictJson(raw)); }
function sealed(row: Row, now: string) { const value = json(row.document_json); check(hash(value) === row.content_hash && investorInstant.safeParse(row.created_at).success && row.created_at <= now); return value; }
function localDate(value: unknown, zone: string) {
  check(typeof value === "string"); priceInstant(value);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  return ["year", "month", "day"].map(key => parts.find(part => part.type === key)!.value).join("-");
}
function audit(db: Database.Database, workspace: string, row: Row, action: string, kind: string) {
  const owner = db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as { owner_id: string } | undefined;
  const event = db.prepare("SELECT * FROM audit_events WHERE id=?").get(row.audit_id) as Obj | undefined;
  check(owner?.owner_id === row.actor_id && event?.actor_id === row.actor_id && event?.action === action
    && event?.object_type === kind && event?.object_id === row.id && event?.created_at === row.created_at);
  eq(json(event.payload_json as string), { content_hash: row.content_hash });
}

export function latestInvestorResearchInput(db: Database.Database, workspace: string, now: string) {
  const row = db.prepare("SELECT * FROM investor_research_source_heads WHERE workspace_id=? ORDER BY created_at DESC,(source_kind='evidence') DESC,source_order DESC LIMIT 1")
    .get(workspace) as { id: string; content_hash: string; created_at: string; source_kind: "synthetic" | "evidence"; source_qualification: string } | undefined;
  if (row) check(investorInstant.safeParse(row.created_at).success && row.created_at <= now
    && row.source_qualification === (row.source_kind === "evidence" ? "owner_reviewed_reconstructed" : "synthetic_test_only"));
  return row ?? null;
}

function review(db: Database.Database, workspace: string, ref: Obj, now: string): Review {
  if (typeof ref.review_id === "string" && ref.review_id.startsWith(MANAGED_ACTION_PREFIX)) {
    const value = readManagedActionReview(db, workspace, ref.review_id, now);
    check(value.row.content_hash === ref.review_hash && value.source.id === ref.source_id && value.source.content_hash === ref.source_hash);
    return value;
  }
  const row = db.prepare("SELECT * FROM investor_data_reviews WHERE id=? AND workspace_id=?").get(ref.review_id, workspace) as Review["row"] | undefined;
  check(row && row.content_hash === ref.review_hash && row.source_id === ref.source_id && row.decision === "approved" && now < row.valid_until);
  const source = db.prepare("SELECT * FROM investor_data_sources WHERE id=? AND workspace_id=?").get(row.source_id, workspace) as Review["source"] | undefined;
  check(source && source.content_hash === ref.source_hash && source.created_at <= row.created_at);
  sealed(source, now); audit(db, workspace, source, "investor_store_data_source", "investor_data_source");
  const document = sealed(row, now); audit(db, workspace, row, "investor_review_data_source", "investor_data_review");
  check(Object.keys(document).sort().join() === "decision,facts,kind,reason,review_basis,schema_version,source_hash,source_id,valid_until,version"
    && document.schema_version === "investor-data-review-v1" && document.source_id === source.id && document.source_hash === source.content_hash
    && document.kind === source.kind && document.version === row.version && document.decision === "approved"
    && document.valid_until === row.valid_until && document.review_basis === "owner_reviewed_not_provider_certified");
  validateInvestorSourceDocument("facts", { kind: source.kind, facts: document.facts });
  const facts = obj(document.facts);
  if (source.kind === "listing") {
    const patterns: Record<string, RegExp> = { CN: /^[0-9]{6}\.(SH|SZ)$/, HK: /^[0-9]{1,5}\.HK$/, US: /^[A-Z][A-Z0-9]{0,14}(?:[.-][A-Z0-9]{1,5})?\.US$/ };
    const currencies: Record<string, string[]> = { CN: ["CNY"], HK: ["HKD", "CNY", "USD"], US: ["USD"] };
    check(patterns[facts.market as string].test(facts.provider_symbol as string) && currencies[facts.market as string].includes(facts.currency as string)
      && amount(facts.quantity_step as string).gt(0) && amount(facts.fee_rate as string).gte(0) && amount(facts.fee_rate as string).lte(1)
      && (facts.fee_as_of as string) <= row.created_at.slice(0, 10)
      && (!facts.tradable_until || priceInstant(facts.tradable_from) < priceInstant(facts.tradable_until)));
  }
  if (source.kind === "fx") verifyManagedFxReview(db, workspace, row as unknown as Obj, facts, now);
  return { row, source, facts };
}

function bareCalendarReview(db: Database.Database, workspace: string, id: string, now: string): Review {
  const ref = db.prepare("SELECT r.id review_id,r.content_hash review_hash,r.source_id,s.content_hash source_hash FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id AND s.workspace_id=r.workspace_id WHERE r.id=? AND r.workspace_id=? AND s.kind='calendar'")
    .get(id, workspace) as Obj | undefined;
  check(ref);
  return review(db, workspace, ref, now);
}

export function readInvestorCurrentCalendarReview(db: Database.Database, workspace: string, id: string, now: string): Review {
  return currentCalendarReview(db, workspace, bareCalendarReview(db, workspace, id, now), now,
    (next, at) => bareCalendarReview(db, workspace, next, at));
}

/** Historical calendar continuation does not change the returned original facts. */
export function readInvestorSourceReview(db: Database.Database, workspace: string, ref: Obj, now: string): Review {
  const value = review(db, workspace, ref, now);
  const latest = db.prepare("SELECT id FROM investor_review_headers WHERE source_id=? AND workspace_id=? ORDER BY version DESC LIMIT 1")
    .get(value.source.id, workspace) as { id: string } | undefined;
  check(latest);
  if (latest.id !== value.row.id) {
    check(value.source.kind === "calendar");
    currentCalendarReview(db, workspace, value, now, (id, at) => bareCalendarReview(db, workspace, id, at));
  }
  return value;
}

function unavailable(db: Database.Database, workspace: string, document: Obj, now: string) {
  if (now >= (document.valid_until as string)) return "REFERENCE_SOURCE_EXPIRED";
  const snapshot = obj(document.snapshot);
  for (const ref of list(snapshot.review_refs, 3000)) {
    const row = db.prepare("SELECT id,source_id,content_hash,version,decision,valid_until FROM investor_review_headers WHERE id=? AND workspace_id=?").get(ref.review_id, workspace) as Obj | undefined;
    check(row && row.content_hash === ref.review_hash && row.source_id === ref.source_id);
    const latest = db.prepare("SELECT id FROM investor_review_headers WHERE source_id=? ORDER BY version DESC LIMIT 1").get(row.source_id) as Obj;
    if (row.decision !== "approved") return "REFERENCE_SOURCE_NO_LONGER_CURRENT";
    if (latest.id !== row.id) {
      try { readInvestorCurrentCalendarReview(db, workspace, row.id as string, now); }
      catch { return "REFERENCE_SOURCE_NO_LONGER_CURRENT"; }
    }
    if (now >= (row.valid_until as string)) return "REFERENCE_SOURCE_EXPIRED";
    const actions = managedActionReviewUnavailable(db, workspace, row.id, now); if (actions) return actions;
    const managed = managedFxReviewUnavailable(db, workspace, row.id, now); if (managed) return managed;
  }
  for (const ref of list(snapshot.capture_refs, 1000)) {
    const versioned = ["investor-monitor-price-snapshot-v1", "investor-monitor-source-snapshot-v2"].includes(snapshot.schema_version as string);
    check(versioned ? ["historical_sdk", "confirmed_sdk"].includes(ref.kind as string) : !Object.hasOwn(ref, "kind"));
    const confirmed = versioned && ref.kind === "confirmed_sdk", prefix = confirmed ? "investor_confirmed" : "investor_price", digest = confirmed ? "payload_sha256" : "projection_sha256";
    const row = db.prepare(`SELECT id,receipt_hash,${digest},retain_until FROM ${prefix}_captures WHERE id=? AND workspace_id=?`).get(ref.capture_id, workspace) as Obj | undefined;
    check(row && row.receipt_hash === ref.receipt_hash && row[digest] === ref[digest]);
    if (now >= (row.retain_until as string)) return "REFERENCE_SOURCE_EXPIRED";
    if (db.prepare(`SELECT 1 FROM ${prefix}_purges WHERE capture_id=?`).get(row.id)) return "REFERENCE_SOURCE_PAYLOAD_PURGED";
  }
  return null;
}

/** Pure local verification. No quote collection, research, lease, write or AI. */
export function readInvestorResearchSource(db: Database.Database, workspace: string, request: SourceRequest, now: string) {
  try {
    check(!(request.input_id && request.evidence_input_id));
    if (!request.evidence_input_id) {
      if (!request.input_id) return null;
      const row = db.prepare("SELECT * FROM investor_research_inputs WHERE id=? AND workspace_id=?").get(request.input_id, workspace) as Row | undefined;
      check(row && row.source_qualification === "synthetic_test_only");
      const payload = sealed(row, now); check(Object.keys(payload).sort().join() === "dataset,plan,policy" && obj(payload.dataset).mode === "synthetic");
      return { row, payload, document: null, unavailable_reason: null };
    }
    const row = db.prepare("SELECT * FROM investor_evidence_inputs WHERE id=? AND workspace_id=?").get(request.evidence_input_id, workspace) as Row | undefined;
    check(row && row.source_qualification === "owner_reviewed_reconstructed");
    const document = sealed(row, now); validateInvestorSourceDocument("input", document);
    audit(db, workspace, row, "investor_admit_research_source", "investor_evidence_input");
    const snapshot = obj(document.snapshot), frozen = row.created_at;
    check(document.workspace_id === workspace && document.source_qualification === row.source_qualification && document.created_at === frozen
      && document.valid_until === row.valid_until && snapshot.created_at === frozen && snapshot.mode === "reconstructed" && snapshot.workspace_id === workspace);
    const rebuilt = readInvestorDataSnapshot(db, workspace, document, now);
    if (!rebuilt.dataset) return { row, payload: null, document, unavailable_reason: rebuilt.unavailable_reason };
    eq(obj(document.policy).roles, Object.fromEntries(Object.entries(rebuilt.catalog).map(([id,value]) => [id,value.role])));
    return { row, document, catalog: rebuilt.catalog, payload: { dataset: rebuilt.dataset, plan: document.plan, policy: document.policy }, unavailable_reason: null };
  } catch { throw new Error("INVESTOR_EVIDENCE_INVALID"); }
}

/** Rebuild one audited market window from receipts; callers seal its envelope. */
export function readInvestorDataSnapshot(db: Database.Database, workspace: string, document: Obj, now: string) {
  return readSnapshot(db, workspace, document, now, false);
}

export function readInvestorMonitorPriceSnapshot(db: Database.Database, workspace: string, document: Obj, now: string) {
  return readSnapshot(db, workspace, document, now, true);
}

export function readInvestorAuditedMonitorSnapshot(db: Database.Database, workspace: string, document: Obj, now: string) {
  return db.transaction(() => readSnapshot(db, workspace, document, now, true, true)).deferred();
}

function readSnapshot(db: Database.Database, workspace: string, document: Obj, now: string, confirmedSnapshot: boolean, auditedActions = false) {
  try {
    const snapshot = obj(document.snapshot), frozen = document.created_at as string, start = snapshot.range_start as string, end = snapshot.range_end as string;
    validateInvestorSourceDocument(auditedActions ? "audited_monitor_snapshot" : confirmedSnapshot ? "monitor_snapshot" : "snapshot", snapshot);
    check(investorInstant.safeParse(frozen).success && frozen <= now && investorInstant.safeParse(document.valid_until).success
      && snapshot.created_at === frozen && snapshot.mode === "reconstructed" && snapshot.workspace_id === workspace);
    const reason = unavailable(db, workspace, document, now);
    if (reason) return { dataset: null, catalog: null, reviews: null, valid_until: null, unavailable_reason: reason };
    const captureRefs = list(snapshot.capture_refs, 1000), reviewRefs = list(snapshot.review_refs, 3000);
    check(captureRefs.every((ref, index) => index === 0 || (captureRefs[index - 1].capture_id as string) < (ref.capture_id as string))
      && reviewRefs.every((ref, index) => index === 0 || (reviewRefs[index - 1].review_id as string) < (ref.review_id as string)));
    const reviews = new Map<string, Review>();
    for (const ref of reviewRefs) {
      check(!reviews.has(ref.review_id as string)); const value = review(db, workspace, ref, now); check(value.row.created_at <= frozen);
      reviews.set(ref.review_id as string, value);
    }
    const actionReviews = [...reviews.values()].filter(value => value.source.kind === "actions");
    const availability = auditedActions ? actionAvailabilityRefs(db, workspace, actionReviews, now, frozen) : null;
    if (availability) eq(snapshot.action_availability_refs, availability);
    const available = availability ? indexActionAvailability(actionReviews, availability, frozen) : null;
    const assets = new Map<string, Review>(), calendars = new Map<string, Review>();
    const quotes = new Map<string, { capture: Obj; record: Obj }>(), used = new Set<string>();
    const deadlines = [...reviews.values()].map(value => value.row.valid_until);
    for (const ref of captureRefs) {
      if (confirmedSnapshot && ref.kind === "confirmed_sdk") {
        const value = readInvestorConfirmedCapture(db, workspace, ref.capture_id as string, now), capture = value.capture;
        check(capture.created_at as string <= frozen && capture.receipt_hash === ref.receipt_hash && capture.payload_sha256 === ref.payload_sha256);
        deadlines.push(capture.retain_until as string);
        for (const raw of list(value.receipt.bindings, 32)) {
          const refs = obj(raw.reviews), bound = ["rights", "listing", "calendar"].map(kind => {
            const selected = obj(refs[kind]), id = selected.review_id as string, review = reviews.get(id); used.add(id);
            check(review && review.source.kind === kind);
            eq(selected, { review_id: id, review_hash: review.row.content_hash, source_id: review.source.id, source_hash: review.source.content_hash });
            return review;
          });
          const [, listing, calendar] = bound, spec = listing.facts, identity = spec.listing_id as string, market = spec.market as string;
          check((calendar.facts.range_start as string) <= start && end <= (calendar.facts.range_end as string));
          check(!assets.has(identity) || assets.get(identity)!.row.id === listing.row.id); assets.set(identity, listing);
          check(!calendars.has(market) || calendars.get(market)!.row.id === calendar.row.id); calendars.set(market, calendar);
          for (const record of value.records.filter(row => row.listing_id === identity)) if (start <= (record.observed_at as string) && (record.observed_at as string) <= end) {
            const key = identity + "|" + record.observed_at; check(!quotes.has(key));
            quotes.set(key, { capture: { ...capture, projection_sha256: capture.payload_sha256, confirmed_callback: true }, record });
          }
        }
        continue;
      }
      const capture = db.prepare("SELECT * FROM investor_price_captures WHERE id=? AND workspace_id=?").get(ref.capture_id, workspace) as Obj | undefined;
      check(capture && capture.qualification === "isolated_official_sdk" && (capture.created_at as string) <= frozen && frozen <= now
        && investorInstant.safeParse(capture.created_at).success && investorInstant.safeParse(capture.retain_until).success
        && capture.receipt_hash === ref.receipt_hash && capture.projection_sha256 === ref.projection_sha256);
      const receipt = json(capture.receipt_json as string, 32768); check(hash(receipt) === capture.receipt_hash);
      const bound = ["rights", "listing", "calendar"].map(kind => {
        const id = capture[kind + "_review_id"] as string, value = reviews.get(id); used.add(id);
        check(value?.source.kind === kind && receipt[kind + "_review_id"] === id && obj(receipt.review_hashes)[kind] === value.row.content_hash);
        return value;
      });
      const [rights, listing, calendar] = bound, grant = rights.facts, spec = listing.facts, days = calendar.facts;
      check((grant.markets as string[]).includes(spec.market as string) && ["private_research", "private_retention", "private_display", "private_backup"].every(use => (grant.uses as string[]).includes(use))
        && priceInstant(grant.valid_from) <= priceInstant(capture.created_at) && priceInstant(now) < priceInstant(grant.valid_until));
      check(spec.market === days.market && (days.range_start as string) <= start && end <= (days.range_end as string));
      const capturedRequest = obj(receipt.request), tileStart = capturedRequest.start_date as string, tileEnd = capturedRequest.end_date as string;
      check((days.range_start as string) <= tileStart && tileStart <= tileEnd && tileEnd <= (days.range_end as string)
        && Date.parse(tileEnd) - Date.parse(tileStart) < 31 * 86400000);
      const expected = list(days.days, 3660).filter(day => day.kind !== "closed" && tileStart <= (day.date as string) && (day.date as string) <= tileEnd
        && priceInstant(day.close_at) >= priceInstant(spec.tradable_from) && (!spec.tradable_until || priceInstant(day.close_at) < priceInstant(spec.tradable_until))).map(day => day.date as string);
      check(expected.length > 0);
      eq(capturedRequest, { mapping: Object.fromEntries(["listing_id", "provider_symbol", "market", "currency"].map(key => [key, spec[key]])),
        start_date: tileStart, end_date: tileEnd, expected_dates: expected, period: "day", adjust_type: "none", trade_session: "regular" });
      const raw = db.prepare("SELECT projection FROM investor_price_payloads WHERE capture_id=?").get(capture.id) as { projection: Buffer } | undefined;
      check(raw && Buffer.isBuffer(raw.projection) && raw.projection.length <= 2097152 && createHash("sha256").update(raw.projection).digest("hex") === capture.projection_sha256);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(raw.projection), projection = json(text, 2097152); check(canonical(projection) === text);
      const replay = replayLongportProjection(projection, spec as unknown as Parameters<typeof replayLongportProjection>[1], expected, { start_date: tileStart, end_date: tileEnd });
      check(replay.digest === capture.projection_sha256 && priceInstant(replay.returned) < priceInstant(capture.created_at) + 1000n);
      check(bound.every(value => priceInstant(value.row.created_at) <= priceInstant(replay.started)));
      eq(receipt.source, projection.source);
      eq(receipt, { schema_version: "investor-price-capture-v1", capture_id: capture.id, workspace_id: workspace,
        rights_review_id: rights.row.id, listing_review_id: listing.row.id, calendar_review_id: calendar.row.id,
        review_hashes: { rights: rights.row.content_hash, listing: listing.row.content_hash, calendar: calendar.row.content_hash }, request: capturedRequest,
        projection_sha256: capture.projection_sha256, qualification: "isolated_official_sdk", source: projection.source, created_at: capture.created_at,
        retain_until: capture.retain_until, publication_time_status: "not_supplied", historical_archive_verified: false });
      const retain = [priceInstant(grant.valid_until), priceInstant(rights.row.valid_until), priceInstant(capture.created_at) + BigInt(grant.retention_days as number) * 86400000000n].reduce((a,b) => a < b ? a : b);
      check(capture.retain_until === new Date(Number(retain / 1000n)).toISOString()); deadlines.push(capture.retain_until as string);
      const identity = spec.listing_id as string, market = spec.market as string;
      check(!assets.has(identity) || assets.get(identity)!.row.id === listing.row.id); assets.set(identity, listing);
      check(!calendars.has(market) || calendars.get(market)!.row.id === calendar.row.id); calendars.set(market, calendar);
      for (const record of replay.records) if (start <= record.observed_at && record.observed_at <= end) {
        const key = identity + "|" + record.observed_at; check(!quotes.has(key)); quotes.set(key, { capture, record });
      }
    }
    const actions = new Map<string, Review>(), rates = new Map<string, Review>();
    for (const [id, value] of reviews) if (["actions", "fx"].includes(value.source.kind)) {
      used.add(id); const key = value.facts[value.source.kind === "actions" ? "listing_id" : "currency"] as string;
      const destination = value.source.kind === "actions" ? actions : rates; check(!destination.has(key)); destination.set(key, value);
    }
    check(assets.size > 0 && assets.size <= 20 && used.size === reviews.size && actions.size === assets.size);
    for (const [identity, value] of actions) check(assets.has(identity) && (value.facts.range_start as string) <= start && end <= (value.facts.range_end as string));
    const currencies = new Set([...assets.values()].map(value => value.facts.currency as string).filter(currency => currency !== "CNY"));
    eq([...rates.keys()].sort(), [...currencies].sort());
    const sessions: Obj[] = [], settlements: Obj[] = [], observations: Obj[] = [], events: Obj[] = [], journal: Obj[] = [], expectedKeys = new Set<string>();
    for (const [market, value] of [...calendars].sort(([a],[b]) => cmp(a,b))) {
      const days = list(value.facts.days, 3660), rangeStart = value.facts.range_start as string, rangeEnd = value.facts.range_end as string;
      const count = (Date.parse(rangeEnd + "T00:00:00Z") - Date.parse(rangeStart + "T00:00:00Z")) / 86400000 + 1;
      check(days.length === count); days.forEach((day, index) => check(day.date === new Date(Date.parse(rangeStart + "T00:00:00Z") + index * 86400000).toISOString().slice(0, 10)));
      for (const day of days) {
        if (day.kind === "closed") { check([day.close_at, day.available_at, day.settled_at, day.settlement_rule_known_at].every(value => value === null)); continue; }
        check(localDate(day.close_at, zones[market]) === day.date && priceInstant(day.close_at) <= priceInstant(day.available_at)
          && priceInstant(day.close_at) <= priceInstant(day.settled_at) && priceInstant(day.settlement_rule_known_at) <= priceInstant(day.close_at));
        if ((day.date as string) < start || end < (day.date as string)) continue;
        check(priceInstant(day.available_at) <= priceInstant(frozen));
        sessions.push({ market, session_date: day.date, close_at: day.close_at, available_at: day.available_at, trade_allowed: true });
        settlements.push({ market, session_date: day.date, settled_at: day.settled_at, published_at: day.settlement_rule_known_at, source_evidence: "review:" + value.row.id });
        for (const [identity, asset] of assets) {
          const spec = asset.facts;
          if (spec.market !== market || priceInstant(day.close_at) < priceInstant(spec.tradable_from) || spec.tradable_until && priceInstant(day.close_at) >= priceInstant(spec.tradable_until)) continue;
          const key = identity + "|" + day.date; expectedKeys.add(key); const quote = quotes.get(key); check(quote);
          const cap = quote.capture;
          check(priceInstant(day.available_at) <= priceInstant(quote.record.ingested_at));
          observations.push({ id: "price:" + hash({ capture: cap.id, date: day.date, ...(cap.confirmed_callback ? { listing_id: identity } : {}) }), batch_id: cap.id, source_id: "provider:longport:research", series_key: identity, listing_id: identity,
            metric: "close", value: quote.record.value, unit: spec.currency, observed_at: day.close_at, assumed_available_at: day.available_at, ingested_at: quote.record.ingested_at,
            source_timezone: zones[market], time_precision: "second", price_basis: "unadjusted", revision_id: cap.id, raw_hash: cap.projection_sha256,
            parser_version: cap.confirmed_callback ? "investor-confirmed-monitor-v1" : "investor-longbridge-reconstructed-v1",
            provenance: "reconstructed" });
        }
      }
    }
    eq([...expectedKeys].sort(), [...quotes.keys()].sort());
    for (const [currency, value] of [...rates].sort(([a],[b]) => cmp(a,b))) {
      let previous: bigint | null = null;
      for (const rate of list(value.facts.rows, 20000)) {
        const at = priceInstant(rate.observed_at); check(previous === null || previous < at); previous = at;
        check(amount(rate.value as string).gt(0) && at <= priceInstant(rate.assumed_available_at) && priceInstant(rate.assumed_available_at) <= priceInstant(value.row.created_at));
        if (at > priceInstant(end + "T23:59:59.999999Z")) continue;
        observations.push({ id: "fx:" + hash({ review: value.row.id, at: rate.observed_at }), batch_id: value.row.id, source_id: "reviewed:fx:" + value.source.id,
          series_key: "FX:" + currency, metric: "fx_cny_per_unit", value: rate.value, unit: "CNY_per_unit_currency", observed_at: rate.observed_at,
          assumed_available_at: rate.assumed_available_at, ingested_at: value.row.created_at, source_timezone: "UTC", time_precision: "second", price_basis: "not_applicable",
          revision_id: value.row.id, raw_hash: value.source.content_hash, parser_version: "investor-longbridge-reconstructed-v1", provenance: "reconstructed" });
      }
    }
    const actionIds = new Set<string>();
    for (const [identity, value] of actions) for (const event of list(value.facts.events)) {
      const day = localDate(event.at, zones[assets.get(identity)!.facts.market as string]);
      check(event.listing_id === identity && (value.facts.range_start as string) <= day && day <= (value.facts.range_end as string)
        && (auditedActions || priceInstant(event.published_at) <= priceInstant(event.at)));
      if (event.type === "split") check(amount(event.ratio as string).gt(0));
      else check(amount(event.gross_per_unit as string).gte(0) && amount(event.tax_per_unit as string).gte(0)
        && amount(event.tax_per_unit as string).lte(amount(event.gross_per_unit as string)) && priceInstant(event.pay_at) >= priceInstant(event.at));
      if (start <= day && day <= end) {
        if (auditedActions) {
          const session = sessions.find(row => row.market === assets.get(identity)!.facts.market && row.session_date === day);
          check(session !== undefined && priceInstant(event.at) <= priceInstant(session.close_at));
        }
        check(!actionIds.has(event.id as string)); actionIds.add(event.id as string);
        events.push({ ...event, source_evidence: "review:" + value.row.id });
        if (available) journal.push({ fact: { ...event }, availability: available(value.row.id, event.id) });
      }
    }
    const catalog = Object.fromEntries([...assets].sort(([a],[b]) => cmp(a,b)).map(([id,value]) => [id,value.facts]));
    const commonDataset = { mode: "reconstructed", source_evidence: "investor-data-snapshot:" + hash(snapshot),
      license_scope: "Recorded private research/retention/display/backup only; owner-reviewed sources, not provider certification; no external AI authority inferred",
      historical_archive_verified: false, corporate_actions_complete: true, publication_refs: [],
      assets: [...assets].sort(([a],[b]) => cmp(a,b)).map(([identity,value]) => ({ listing_id: identity, market: value.facts.market, currency: value.facts.currency,
        quantity_step: value.facts.quantity_step, tradable_from: value.facts.tradable_from, ...(value.facts.tradable_until ? { tradable_until: value.facts.tradable_until } : {}), source_evidence: "review:" + value.row.id })),
      sessions: sessions.sort((a,b) => cmp(a.close_at as string,b.close_at as string) || cmp(a.market as string,b.market as string)),
      settlements: settlements.sort((a,b) => cmp(a.session_date as string,b.session_date as string) || cmp(a.market as string,b.market as string)),
      observations: observations.sort((a,b) => cmp(a.id as string,b.id as string)) };
    const dataset = auditedActions ? { ...commonDataset, schema_version: "investor-monitor-source-dataset-v1", created_at: frozen,
      use_scope: "monitor_only", action_knowledge_basis: "audited_owner_review_not_provider_publication",
      reviewed_actions: journal.sort((a,b) => cmp(obj(a.fact).at as string,obj(b.fact).at as string) || cmp(obj(a.fact).id as string,obj(b.fact).id as string)) }
      : { ...commonDataset, schema_version: "research-dataset-v2", actions: events.sort((a,b) => cmp(a.at as string,b.at as string) || cmp(a.id as string,b.id as string)) };
    check(observations.length <= 100000 && Buffer.byteLength(canonical(dataset)) + Buffer.byteLength(canonical(snapshot)) <= 16777216);
    validateInvestorSourceDocument(auditedActions ? "monitor_dataset" : "dataset", dataset);
    check(hash(dataset) === document.dataset_hash && hash(catalog) === document.catalog_hash && [...deadlines].sort()[0] === document.valid_until);
    return { dataset, catalog, reviews: [...reviews.values()], valid_until: document.valid_until as string, unavailable_reason: null };
  } catch { throw new Error("INVESTOR_EVIDENCE_INVALID"); }
}
