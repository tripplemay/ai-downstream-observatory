import type Database from "better-sqlite3";
import { z } from "zod";
import { hash } from "../ledger/service";
import { readMarketReferenceVersion, referenceReadOnly } from "./service";

const querySchema = z.object({ portfolio_id: z.string().min(1).max(160).optional() }).strict();
export function getMarketReferenceState(db: Database.Database, raw: unknown = {}) {
  const parsed = querySchema.safeParse(raw); if (!parsed.success) throw new Error("REFERENCE_INVALID_QUERY");
  return db.transaction(() => {
    const portfolios = db.prepare("SELECT id,name FROM portfolios ORDER BY created_at,id LIMIT 1001").all() as { id: string; name: string }[];
    const selected = parsed.data.portfolio_id ?? (portfolios.length ? portfolios[0].id : null);
    if (selected && !db.prepare("SELECT 1 FROM portfolios WHERE id=?").get(selected)) throw new Error("REFERENCE_PORTFOLIO_NOT_FOUND");
    const sources = selected ? db.prepare("SELECT id,reference,content_hash,known_at FROM market_reference_sources WHERE portfolio_id=? ORDER BY known_at DESC,id DESC LIMIT 101").all(selected) as { id: string; reference: string; content_hash: string; known_at: string }[] : [];
    const history = selected ? db.prepare("SELECT id FROM market_reference_versions WHERE portfolio_id=? ORDER BY known_at DESC,id DESC LIMIT 101").all(selected) as { id: string }[] : [];
    const heads = selected ? db.prepare("SELECT portfolio_id,kind,scope_key,version,version_id,updated_at FROM market_reference_heads WHERE portfolio_id=? ORDER BY kind,scope_key LIMIT 1001").all(selected) as { portfolio_id: string; kind: "mapping" | "calendar"; scope_key: string; version: number; version_id: string; updated_at: string }[] : [];
    const listings = selected ? db.prepare("SELECT l.id,l.market,l.exchange,l.ticker,l.currency FROM listings l JOIN catalog_entries c ON c.listing_id=l.id WHERE c.portfolio_id=? ORDER BY l.id LIMIT 1001").all(selected) as { id: string; market: string; exchange: string; ticker: string; currency: string }[] : [];
    const versions = history.slice(0, 100).map(({ id }) => {
      const { row, document } = readMarketReferenceVersion(db, selected!, id);
      return { id: row.id, kind: row.kind, scope_key: row.scope_key, version: row.version, source_id: row.source_id, source_hash: row.source_hash, content_hash: row.content_hash, known_at: row.known_at, audit_id: row.audit_id, review_basis: document.review_basis,
        market: document.facts.market, exchange: document.facts.exchange,
        summary: "listing_id" in document.facts ? `${document.facts.provider_symbol} / ${document.facts.listing_id}` : `${document.facts.range_start} - ${document.facts.range_end} (${document.facts.days.length})` };
    });
    const revision = selected ? (db.prepare("SELECT revision FROM ledger_heads WHERE portfolio_id=?").get(selected) as { revision: number }).revision : 0;
    return { portfolios: portfolios.slice(0, 1000), portfolios_truncated: portfolios.length > 1000, selected_portfolio_id: selected, ledger_revision: revision, read_only: referenceReadOnly(db),
      sources: sources.slice(0, 100), sources_truncated: sources.length > 100, versions, versions_truncated: history.length > 100,
      heads: heads.slice(0, 1000), heads_truncated: heads.length > 1000, listings: listings.slice(0, 1000), listings_truncated: listings.length > 1000,
      resource_hash: hash({ selected, revision, heads, listings }), review_basis: "human_reviewed_not_provider_verified" as const };
  })();
}
export type MarketReferenceState = ReturnType<typeof getMarketReferenceState>;
