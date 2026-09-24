import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { readMarketReferenceVersion, referenceInstant, type CalendarFacts, type MappingFacts } from "../market-references/service";
import type { PriceCollectionScheduleDefinition, PriceReferenceHead, PriceScheduleReferenceBinding } from "./types";

function at(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) throw new Error("PRICE_COLLECTION_REFERENCE_INVALID");
  return referenceInstant(`${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z`);
}
export function priceCollectionScope(binding: PriceScheduleReferenceBinding) {
  return "provider:longport:prices:" + hash({ portfolio_id: binding.portfolio_id, market: binding.market, listing_ids: binding.mappings.map(row => row.listing_id).sort() });
}
export function priceScheduleReferences(db: Database.Database, portfolio: string, definition: PriceCollectionScheduleDefinition, knownAt: string, current = false): PriceScheduleReferenceBinding {
  try {
    referenceInstant(knownAt);
    const load = (id: string, kind: "mapping" | "calendar") => {
      const item = readMarketReferenceVersion(db, portfolio, id), row = item.row;
      if (row.kind !== kind || item.document.facts.market !== definition.market || at(row.known_at) > at(knownAt)) throw new Error();
      const latest = db.prepare("SELECT id FROM market_reference_versions WHERE portfolio_id=? AND kind=? AND scope_key=? AND known_at<=? ORDER BY version DESC LIMIT 1").get(portfolio, kind, row.scope_key, knownAt) as { id: string } | undefined;
      if (latest?.id !== id) throw new Error();
      const head: PriceReferenceHead = { portfolio_id: portfolio, kind, scope_key: row.scope_key, version: row.version, version_id: row.id, updated_at: row.known_at };
      if (current && canonical(db.prepare("SELECT * FROM market_reference_heads WHERE portfolio_id=? AND kind=? AND scope_key=?").get(portfolio, kind, row.scope_key)) !== canonical(head)) throw new Error("PRICE_COLLECTION_REFERENCE_CHANGED");
      const sourceAudits = db.prepare("SELECT * FROM audit_events WHERE action='store_market_reference_source' AND object_type='market_reference_source' AND object_id=?").all(item.source.id);
      if (sourceAudits.length !== 1) throw new Error();
      return { ...item, head, proof: { version_id: row.id, version_hash: hash(row), source_row_hash: hash(item.source), source_audit_hash: hash(sourceAudits[0]), review_audit_hash: hash(item.audit) } };
    };
    const mappings = definition.mapping_version_ids.map(id => load(id, "mapping"));
    const calendars = definition.calendar_version_ids.map(id => load(id, "calendar"));
    const byExchange = new Map(calendars.map(item => [(item.document.facts as CalendarFacts).exchange, item]));
    if (byExchange.size !== calendars.length) throw new Error();
    const used = new Set<string>(), listings = new Set<string>();
    const selected = mappings.sort((a, b) => {
      const first = (a.document.facts as MappingFacts).listing_id, second = (b.document.facts as MappingFacts).listing_id;
      return first < second ? -1 : first > second ? 1 : 0;
    }).map(item => {
      const facts = item.document.facts as MappingFacts, calendar = byExchange.get(facts.exchange);
      if (!calendar || listings.has(facts.listing_id) || facts.provider !== "longport" || facts.valid_from > definition.start_date || (facts.valid_to !== null && facts.valid_to <= definition.end_date)) throw new Error();
      const days = calendar.document.facts as CalendarFacts;
      if (days.timezone !== definition.timezone || days.range_start > definition.start_date || days.range_end < definition.end_date) throw new Error();
      const listing = db.prepare("SELECT id,market,exchange,currency,created_at FROM listings WHERE id=?").get(facts.listing_id) as { id: string; market: string; exchange: string; currency: string; created_at: string } | undefined;
      const entry = db.prepare("SELECT * FROM catalog_entries WHERE portfolio_id=? AND listing_id=?").get(portfolio, facts.listing_id) as { created_at: string } | undefined;
      if (!listing || !entry || at(listing.created_at) > at(knownAt) || at(entry.created_at) > at(knownAt) || listing.market !== facts.market || listing.exchange !== facts.exchange || listing.currency !== facts.currency) throw new Error();
      listings.add(facts.listing_id); used.add(calendar.row.id);
      return { ...item.proof, listing_id: facts.listing_id, listing_identity_hash: hash(listing), catalog_entry_hash: hash(entry), calendar_version_id: calendar.row.id };
    });
    if (used.size !== calendars.length) throw new Error();
    return { schema_version: "price-schedule-reference-binding-v1", portfolio_id: portfolio, market: definition.market,
      timezone: definition.timezone, start_date: definition.start_date, end_date: definition.end_date, known_at: knownAt,
      mappings: selected, calendars: calendars.map(item => item.proof).sort((a, b) => a.version_id < b.version_id ? -1 : a.version_id > b.version_id ? 1 : 0),
      heads: [...mappings, ...calendars].map(item => item.head).sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.scope_key < b.scope_key ? -1 : a.scope_key > b.scope_key ? 1 : 0) };
  } catch (error) {
    if (error instanceof Error && error.message === "PRICE_COLLECTION_REFERENCE_CHANGED") throw error;
    throw new Error("PRICE_COLLECTION_REFERENCE_INVALID");
  }
}
export function assertPriceReferenceHeads(db: Database.Database, binding: PriceScheduleReferenceBinding, knownAt?: string) {
  for (const head of binding.heads) {
    const row = knownAt
      ? db.prepare("SELECT portfolio_id,kind,scope_key,version,id AS version_id,known_at AS updated_at FROM market_reference_versions WHERE portfolio_id=? AND kind=? AND scope_key=? AND known_at<=? ORDER BY version DESC LIMIT 1").get(head.portfolio_id, head.kind, head.scope_key, knownAt)
      : db.prepare("SELECT * FROM market_reference_heads WHERE portfolio_id=? AND kind=? AND scope_key=?").get(head.portfolio_id, head.kind, head.scope_key);
    if (canonical(row ?? null) !== canonical(head)) throw new Error("PRICE_COLLECTION_REFERENCE_CHANGED");
  }
}
export function priceSessionDisposition(db: Database.Database, portfolio: string, binding: PriceScheduleReferenceBinding, period: string): "open" | "closed" | "mixed" {
  const closed = binding.mappings.map(mapping => {
    const calendar = readMarketReferenceVersion(db, portfolio, mapping.calendar_version_id).document.facts as CalendarFacts;
    const day = calendar.days.find(item => item.date === period);
    if (!day) throw new Error("PRICE_COLLECTION_REFERENCE_INVALID");
    return day.kind === "closed";
  });
  return closed.every(Boolean) ? "closed" : closed.some(Boolean) ? "mixed" : "open";
}
