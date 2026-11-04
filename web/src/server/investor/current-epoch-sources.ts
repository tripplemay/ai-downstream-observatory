import type Database from "better-sqlite3";
import { hash } from "../ledger/service";
import { priceInstant } from "../market-price-source";
import { readInvestorConfirmedCapture } from "./confirmed-source";
import { readInvestorHistoricalCapture, readInvestorSourceReview, type VerifiedSourceReview } from "./source-inputs";
import { assertCurrentEpochAuxiliarySources } from "./model-epoch-continuation-source";

type Obj = Record<string, unknown>;
type Binding = { rights: VerifiedSourceReview; listing: VerifiedSourceReview; calendar: VerifiedSourceReview };
type Candidate = { id: string; created_at: string; market: string; day: Obj; calendar: VerifiedSourceReview; listings: Map<string, string>; records: Map<string, Obj> };
function check(value: unknown, code = "INVALID"): asserts value { if (!value) throw new Error("INVESTOR_EPOCH_CURRENT_SOURCE_" + code); }
function obj(value: unknown): Obj { check(value && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function rows(value: unknown): Obj[] { check(Array.isArray(value)); return value.map(obj); }
function text(value: unknown): string { check(typeof value === "string"); return value; }
const time = (value: unknown) => priceInstant(text(value));
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const zones: Record<string, string> = { CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" };
function localDay(now: string, market: string) {
  check(zones[market]); const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zones[market], year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  return ["year", "month", "day"].map(key => parts.find(part => part.type === key)!.value).join("-");
}

function candidate(db: Database.Database, workspace: string, row: Obj, targets: Map<string, Obj>, now: string): Candidate | null {
  let capture: Obj, bindings: Binding[], records: Obj[];
  if (row.kind === "historical") {
    const value = readInvestorHistoricalCapture(db, workspace, text(row.id), now);
    capture = value.capture; bindings = value.bindings; records = value.records;
  } else {
    check(row.kind === "confirmed"); const value = readInvestorConfirmedCapture(db, workspace, text(row.id), now);
    check(value.status === "complete"); capture = value.capture; records = value.records;
    bindings = rows(value.receipt.bindings).map(raw => {
      const refs = obj(raw.reviews);
      const [rights, listing, calendar] = ["rights", "listing", "calendar"].map(kind => readInvestorSourceReview(db, workspace, obj(refs[kind]), now));
      return { rights, listing, calendar };
    });
  }
  const identities = new Set(bindings.map(bound => text(bound.listing.facts.listing_id)));
  if ([...identities].some(id => !targets.has(id))) return null;
  const markets = new Set(bindings.map(bound => text(bound.listing.facts.market))); if (markets.size !== 1) return null;
  const market = [...markets][0], calendar = bindings[0].calendar, facts = calendar.facts, day = localDay(now, market);
  check(bindings.every(bound => bound.calendar.row.id === calendar.row.id), "CALENDAR_AMBIGUOUS");
  if (day < text(facts.range_start) || text(facts.range_end) < day) return null;
  const complete = rows(facts.days).filter(value => value.kind !== "closed" && time(value.close_at) <= time(now)); if (!complete.length) return null;
  const expected = complete.reduce((a, b) => time(a.close_at) > time(b.close_at) ? a : b);
  if (time(expected.close_at) + 604800000000n <= time(now)) return null;
  const selected = new Map(records.filter(record => record.observed_at === expected.date).map(record => [text(record.listing_id), record]));
  if (!same([...selected.keys()].sort(), [...identities].sort())) return null;
  for (const bound of bindings) {
    const spec = bound.listing.facts, target = targets.get(text(spec.listing_id))!, record = selected.get(text(spec.listing_id))!;
    check(spec.market === target.market && spec.currency === target.currency && spec.provider_symbol === target.symbol && record.currency === target.currency, "IDENTITY_CHANGED");
    check(time(expected.available_at) <= time(record.ingested_at) && time(record.ingested_at) <= time(now), "PRICE_NOT_AVAILABLE");
  }
  return { id: text(row.id), created_at: text(capture.created_at), market, day: expected, calendar,
    listings: new Map(bindings.map(bound => [text(bound.listing.facts.listing_id), bound.listing.row.id])), records: selected };
}

/** Negative/selection gate only. The caller must independently replay the actual
 * journal first; passing values here never certifies a source or permits a write. */
export function assertCurrentEpochSourceSelection(db: Database.Database, workspace: string, targets: Obj[], definition: Obj, document: Obj, projection: Obj, now: string) {
  assertCurrentEpochAuxiliarySources(db, workspace, definition, document, now);
  const targetMap = new Map(targets.map(target => [text(target.listing_id), target])); check(targetMap.size === targets.length);
  const earliest = new Date(Number(time(now) / 1000n) - 604800000).toISOString().slice(0, 10);
  const retained = db.prepare(`SELECT 'historical' kind,c.id,c.created_at FROM investor_price_captures c
    JOIN investor_price_payloads p ON p.capture_id=c.id WHERE c.workspace_id=? AND c.qualification='isolated_official_sdk'
      AND c.created_at<=? AND c.retain_until>? AND json_extract(c.receipt_json,'$.request.end_date')>=?
    UNION ALL SELECT 'confirmed' kind,c.id,c.created_at FROM investor_confirmed_captures c
    JOIN investor_confirmed_payloads p ON p.capture_id=c.id WHERE c.workspace_id=? AND c.qualification='isolated_official_sdk_callback'
      AND c.status='complete' AND c.created_at<=? AND c.retain_until>?
    ORDER BY created_at DESC,id LIMIT 129`).all(workspace, now, now, earliest, workspace, now, now) as Obj[];
  check(retained.length <= 128, "SOURCE_LIMIT");
  const candidates = retained.map(row => candidate(db, workspace, row, targetMap, now)).filter((value): value is Candidate => value !== null);
  check(candidates.length, "PRICES_NOT_READY");
  const prices = new Map<string, unknown>(), listings = new Map<string, string>(), calendars = new Map<string, Candidate>();
  for (const value of candidates) {
    const old = calendars.get(value.market);
    check(!old || old.calendar.row.id === value.calendar.row.id && old.day.date === value.day.date, "CALENDAR_AMBIGUOUS");
    calendars.set(value.market, value);
    for (const [id, record] of value.records) {
      check(!prices.has(id) || prices.get(id) === record.value, "PRICES_CONFLICT");
      check(!listings.has(id) || listings.get(id) === value.listings.get(id), "LISTING_AMBIGUOUS");
      prices.set(id, record.value); listings.set(id, value.listings.get(id)!);
    }
  }
  check(same([...prices.keys()].sort(), [...targetMap.keys()].sort()), "PRICES_NOT_READY");
  const covered = new Set<string>();
  for (const value of [...candidates].sort((a, b) => b.records.size - a.records.size || (time(a.created_at) < time(b.created_at) ? 1 : time(a.created_at) > time(b.created_at) ? -1 : compare(b.id, a.id)))) {
    if ([...value.records.keys()].some(id => covered.has(id))) continue;
    value.records.forEach((_, id) => covered.add(id));
  }
  check(same([...covered].sort(), [...targetMap.keys()].sort()), "CAPTURE_SCOPE_AMBIGUOUS");
  const selectedListings = new Map<string, string>();
  for (const segment of rows(document.segments)) for (const reference of rows(obj(segment.snapshot).review_refs)) {
    const value = readInvestorSourceReview(db, workspace, reference, now); if (value.source.kind !== "listing") continue;
    const id = text(value.facts.listing_id); check(!selectedListings.has(id) || selectedListings.get(id) === value.row.id, "LISTING_AMBIGUOUS"); selectedListings.set(id, value.row.id);
  }
  const quotes = rows(projection.quotes); check(quotes.length === targetMap.size && new Set(quotes.map(quote => quote.listing_id)).size === targetMap.size, "PRICES_NOT_READY");
  for (const quote of quotes) {
    const id = text(quote.listing_id), expected = calendars.get(text(quote.market)), target = targetMap.get(id);
    check(target && expected && quote.currency === target.currency && quote.market === target.market && quote.close === prices.get(id)
      && time(quote.observed_at) === time(expected.day.close_at) && time(quote.expected_close_at) === time(expected.day.close_at)
      && quote.calendar_hash === expected.calendar.row.content_hash && listings.get(id) === selectedListings.get(id), "PRICE_SELECTION_CHANGED");
  }
}
