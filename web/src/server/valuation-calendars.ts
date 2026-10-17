import type Database from "better-sqlite3";
import { z } from "zod";
import { readMarketReferenceVersion, type CalendarFacts } from "./market-references/service";
import { priceInstant } from "./market-price-source";
import { valuationCalendarCheckSchema } from "./valuation-calendar-schemas";
const zones = { CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" };
export function valuationLocalDay(at: string, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  return ["year", "month", "day"].map(name => parts.find(part => part.type === name)!.value).join("-");
}
export function completedCalendarSession(facts: CalendarFacts, cutoff: string) {
  const day = valuationLocalDay(cutoff, zones[facts.market]);
  if (facts.timezone !== zones[facts.market] || facts.range_start > day || facts.range_end < day) throw new Error("VALUATION_CALENDAR_INPUTS_CHANGED");
  const sessions = facts.days.filter(row => row.kind !== "closed" && row.close_at && priceInstant(row.close_at) <= priceInstant(cutoff));
  if (!sessions.length) throw new Error("VALUATION_CALENDAR_INPUTS_CHANGED");
  return sessions.at(-1)!.date;
}
export function verifyValuationCalendars(db: Database.Database, portfolio: string, cutoff: string, raw: unknown,
  expectedSessions: Record<string, unknown>, knownAt: string, requireCurrent = false) {
  try {
    const checks = z.array(valuationCalendarCheckSchema).max(200).parse(raw), scopes = new Set<string>();
    const normalized = knownAt.replace(/(?:\.(\d{1,6}))?Z$/, (_, fraction: string | undefined) => "." + (fraction ?? "").padEnd(6, "0") + "Z");
    priceInstant(normalized);
    for (const check of checks) {
      const scope = `${check.market}:${check.exchange}`;
      if (scopes.has(scope)) throw new Error(); scopes.add(scope);
      const proof = readMarketReferenceVersion(db, portfolio, check.version_id);
      const latest = db.prepare(`SELECT id FROM market_reference_versions WHERE portfolio_id=? AND kind='calendar' AND scope_key=?
        AND known_at<=? ORDER BY version DESC LIMIT 1`).get(portfolio, scope, normalized) as { id: string } | undefined;
      if (proof.row.kind !== "calendar" || proof.row.scope_key !== scope || proof.row.content_hash !== check.content_hash
        || priceInstant(proof.row.known_at) > priceInstant(normalized) || latest?.id !== check.version_id
        || completedCalendarSession(proof.document.facts as CalendarFacts, cutoff) !== check.expected_session
        || expectedSessions[check.market] !== check.expected_session) throw new Error();
      if (requireCurrent) {
        const head = db.prepare("SELECT version_id,version,updated_at FROM market_reference_heads WHERE portfolio_id=? AND kind='calendar' AND scope_key=?")
          .get(portfolio, scope) as { version_id: string; version: number; updated_at: string } | undefined;
        if (head?.version_id !== proof.row.id || head.version !== proof.row.version || head.updated_at !== proof.row.known_at) throw new Error();
      }
    }
    return checks;
  } catch { throw new Error("VALUATION_CALENDAR_INPUTS_CHANGED"); }
}
