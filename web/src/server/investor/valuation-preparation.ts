import type Database from "better-sqlite3";
import { hash, type Actor } from "../ledger/service";
import { Decimal } from "../ledger/decimal";
import { readMarketReferenceVersion, type CalendarFacts } from "../market-references/service";
import { priceInstant, verifiedPriceCalendarSession } from "../market-price-source";
import { chosenObservation, observedInstant } from "../valuation-freshness";
import { completedCalendarSession, valuationLocalDay } from "../valuation-calendars";
import type { ValuationCalendarCheck } from "../valuation-calendar-schemas";
import { valuationPreparationSchema, type ValuationContext, type ValuationPreparation } from "./valuation-schemas";

type Observation = Record<string, unknown>;
export function prepareInvestorValuationInputs(db: Database.Database, actor: Actor, portfolio: string, cutoff: string | null,
  listings: ValuationContext["listings"], currencies: string[], sources: ValuationContext["sources"], now: string): ValuationPreparation {
  let bytes = 0;
  const budget = (length: number) => { bytes += length; if (bytes > 32 * 1024 * 1024) throw new Error("INVESTOR_VALUATION_CAPACITY_REQUIRES_REVIEW"); };
  const markets: ValuationPreparation["markets"] = [];
  for (const market of [...new Set(listings.map(row => row.market))].sort()) {
    const checks: ValuationCalendarCheck[] = [], gaps: ValuationPreparation["markets"][number]["gaps"] = [];
    for (const exchange of [...new Set(listings.filter(row => row.market === market).map(row => row.exchange))].sort()) {
      const head = db.prepare(`SELECT h.*,v.created_by FROM market_reference_heads h LEFT JOIN market_reference_versions v ON v.id=h.version_id
        WHERE h.portfolio_id=? AND h.kind='calendar' AND h.scope_key=?`).get(portfolio, `${market}:${exchange}`) as
        { version_id: string; version: number; updated_at: string; created_by: string } | undefined;
      if (!head) { if (!gaps.includes("CALENDAR_REQUIRED")) gaps.push("CALENDAR_REQUIRED"); continue; }
      const size = db.prepare(`SELECT length(CAST(v.document_json AS BLOB))+length(CAST(s.content_text AS BLOB)) bytes
        FROM market_reference_versions v JOIN market_reference_sources s ON s.id=v.source_id WHERE v.id=?`).get(head.version_id) as { bytes: number } | undefined;
      budget(size?.bytes ?? 0);
      try {
        if (!cutoff || head.created_by !== actor.id) throw new Error();
        const proof = readMarketReferenceVersion(db, portfolio, head.version_id);
        const latest = db.prepare(`SELECT id FROM market_reference_versions WHERE portfolio_id=? AND kind='calendar' AND scope_key=?
          AND known_at<=? ORDER BY version DESC LIMIT 1`).get(portfolio, `${market}:${exchange}`, now.replace(/(\.\d{3})Z$/, "$1000Z")) as { id: string } | undefined;
        if (proof.row.kind !== "calendar" || proof.row.scope_key !== `${market}:${exchange}` || proof.row.version !== head.version
          || proof.row.known_at !== head.updated_at || priceInstant(proof.row.known_at) > priceInstant(now) || latest?.id !== proof.row.id) throw new Error();
        checks.push({ market, exchange, version_id: proof.row.id, content_hash: proof.row.content_hash,
          expected_session: completedCalendarSession(proof.document.facts as CalendarFacts, cutoff) });
      } catch { if (!gaps.includes("CALENDAR_UNUSABLE")) gaps.push("CALENDAR_UNUSABLE"); }
    }
    if (!gaps.length && new Set(checks.map(row => row.expected_session)).size !== 1) gaps.push("CALENDAR_SESSIONS_DIFFER");
    markets.push({ market, expected_session: gaps.length ? null : checks[0]?.expected_session ?? null,
      calendar_checks: gaps.length ? [] : checks, candidate_scopes: [], suggested_scope: null, gaps });
  }
  const foreign = currencies.filter(currency => currency !== "CNY"), fxCandidates: ValuationPreparation["fx"]["candidates"] = [];
  if (cutoff) for (const source of sources) {
    const head = db.prepare(`SELECT p.batch_id,p.revision,p.manifest_hash,b.source_id FROM market_publications p JOIN market_batches b ON b.id=p.batch_id WHERE p.scope=?`)
      .get(source.scope) as { batch_id: string; revision: number; manifest_hash: string; source_id: string } | undefined;
    if (!head || head.revision !== source.revision || head.manifest_hash !== source.manifest_hash) continue;
    if (source.batch_type === "prices" && !markets.some(row => row.expected_session && source.markets.includes(row.market)) || source.batch_type === "fx" && !foreign.length) continue;
    const observations = db.prepare(`SELECT o.* FROM market_batch_members m JOIN market_observations o ON o.id=m.observation_id WHERE m.batch_id=? ORDER BY o.id LIMIT 10001`)
      .all(head.batch_id) as Observation[];
    if (observations.length > 10000) throw new Error("INVESTOR_VALUATION_CAPACITY_REQUIRES_REVIEW");
    budget(Buffer.byteLength(JSON.stringify(observations)));
    const choose = (predicate: (row: Observation) => boolean) => {
      const chosen = chosenObservation(observations.filter(predicate), priceInstant(cutoff), priceInstant(now));
      try { return chosen && chosen.provenance === "live_observed" && new Decimal(String(chosen.value)).gt(0) ? chosen : null; } catch { return null; }
    };
    if (source.batch_type === "prices") for (const prepared of markets) {
      if (!prepared.expected_session || !source.markets.includes(prepared.market)) continue;
      const covered = listings.filter(row => row.market === prepared.market).every(listing => {
        const chosen = choose(row => row.listing_id === listing.id && row.metric === "close" && row.price_basis === "unadjusted");
        if (!chosen || chosen.unit !== listing.currency) return false;
        try {
          const session = chosen.time_precision === "date" ? String(chosen.observed_at) : valuationLocalDay(String(chosen.observed_at), String(chosen.source_timezone));
          return session === prepared.expected_session && (head.source_id !== "provider:longport:prices"
            || verifiedPriceCalendarSession(db, head.batch_id, portfolio, listing.id, cutoff, now) === session);
        } catch { return false; }
      });
      if (covered) prepared.candidate_scopes.push(source.scope);
    }
    else {
      const chosen = foreign.map(currency => choose(row => row.series_key === "FX:" + currency && row.metric === "fx_cny_per_unit" && row.price_basis === "not_applicable"));
      if (chosen.some(row => !row || row.unit !== "CNY_per_unit_currency" || row.listing_id !== null)) continue;
      const ages = chosen.map(row => Number((priceInstant(cutoff) - observedInstant(row!)! + 999999n) / 1000000n));
      const age = Math.max(...ages);
      if (Number.isSafeInteger(age) && age >= 0 && age <= 2592000) fxCandidates.push({ scope: source.scope, oldest_age_seconds: age });
    }
  }
  for (const prepared of markets) {
    prepared.candidate_scopes.sort();
    if (prepared.candidate_scopes.length === 1) prepared.suggested_scope = prepared.candidate_scopes[0];
    else prepared.gaps.push(prepared.candidate_scopes.length ? "PRICE_SOURCE_AMBIGUOUS" : "PRICE_SOURCE_REQUIRED");
  }
  const identity = { markets, fx: { required: foreign.length > 0, candidates: fxCandidates.sort((a, b) => a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0),
    suggested_scope: fxCandidates.length === 1 ? fxCandidates[0].scope : null,
    gap: !foreign.length || fxCandidates.length === 1 ? null : fxCandidates.length ? "FX_SOURCE_AMBIGUOUS" as const : "FX_SOURCE_REQUIRED" as const },
    basis: "reviewed_metadata_suggestions_not_quality_approval" as const, approval_required: true as const };
  return valuationPreparationSchema.parse({ ...identity, evidence_hash: hash(identity) });
}
