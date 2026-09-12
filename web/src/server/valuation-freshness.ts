import type Database from "better-sqlite3";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import common from "../../../contracts/v1/common.schema.json";
import valuationRules from "../../../contracts/v1/valuation-rules.schema.json";
import marketObservation from "../../../contracts/v1/market-observation.schema.json";
import flowRules from "../../../contracts/v1/flow-fx-rules.schema.json";
import flowEvidence from "../../../contracts/v1/flow-fx-evidence-v2.schema.json";
import providerFlowEvidence from "../../../contracts/v1/flow-fx-evidence-v3.schema.json";
import performanceInput from "../../../contracts/v1/performance-input-v5.schema.json";
import providerPerformanceInput from "../../../contracts/v1/performance-input-v6.schema.json";
import securityValue from "../../../contracts/v1/security-transfer-value.schema.json";
import valuationInput from "../../../contracts/v1/valuation-input-v3.schema.json";
import factQualitySchema from "../../../contracts/v1/ledger-fact-quality.schema.json";
import ledgerFact from "../../../contracts/v1/ledger-fact.schema.json";
import { canonical, hash } from "./ledger/service";
import { Decimal } from "./ledger/decimal";
import { ledgerFactQualityAt } from "./ledger/fact-quality-db";
import { verifiedMarketSource } from "./market-source";

type ObjectValue = Record<string, unknown>;
type Valuation = { id: string; market_manifest: string; ledger_revision: number };
type StoredValuation = Valuation & { portfolio_id: string; method_version: string; nav_cny: string | null; quality: string; cutoff_at: string; created_at: string };
type Publication = { scope: string; revision: number; batch_id: string; manifest_hash: string; published_at: string };
type Item = { account_id: string; item_type: string; listing_id: string | null; currency: string; amount: string | null; fx_rate: string | null; value_cny: string | null; evidence_json: string };
type Observation = { metric: string; price_basis: string; listing_id: string | null; series_key: string; unit: string; market: string | null; listing_currency: string | null; observed_at: string; ingested_at: string; published_at: string | null; time_precision: string; source_timezone: string };
const ajv = new Ajv2020({ strict: true, strictRequired: false });
addFormats(ajv);
ajv.addSchema(common);
ajv.addSchema(marketObservation);
ajv.addSchema(flowRules);
ajv.addSchema(securityValue);
ajv.addSchema(flowEvidence);
ajv.addSchema(providerFlowEvidence);
ajv.addSchema(factQualitySchema);
const validRules = ajv.compile(valuationRules);
const validValuationInput = ajv.compile(valuationInput);
const validPerformanceInput = ajv.compile(performanceInput);
const validProviderPerformanceInput = ajv.compile(providerPerformanceInput);
const validSecurityValue = ajv.getSchema(securityValue.$id)!;
const validLedgerFact = ajv.compile(ledgerFact);
const FlowDecimal = Decimal.clone({ precision: 80 });
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}
function parse(value: string): ObjectValue | undefined {
  try { return object(JSON.parse(value)); } catch { return undefined; }
}
function publicationAt(db: Database.Database, scope: string, expected: unknown): Publication | undefined {
  const input = object(expected);
  if (!input || input.scope !== scope || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1 || !digest(input.manifest_hash) || typeof input.batch_id !== "string" || typeof input.published_at !== "string") return;
  const historical = db.prepare("SELECT * FROM market_publication_events WHERE scope=? AND revision=?").get(scope, input.revision) as Publication | undefined;
  if (historical && historical.batch_id === input.batch_id && historical.manifest_hash === input.manifest_hash && historical.published_at === input.published_at) return historical;
}
function headMatches(db: Database.Database, scope: string, expected: unknown): boolean {
  const input = object(expected);
  const head = db.prepare("SELECT revision,manifest_hash FROM market_publications WHERE scope=?").get(scope) as { revision: number; manifest_hash: string } | undefined;
  return Boolean(head && input && head.revision === input.revision && head.manifest_hash === input.manifest_hash);
}

function instant(value: unknown): bigint | undefined {
  if (typeof value !== "string") return;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(value);
  if (!match || value.startsWith("0000")) return;
  const milliseconds = Date.parse(match[1] + "Z");
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== match[1]) return;
  // Python datetime and financial timestamps resolve microseconds, not JS milliseconds.
  return BigInt(milliseconds) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0").slice(0, 6));
}
function dateInZone(at: bigint, zone: string): string {
  if (!dateFormatters.has(zone)) dateFormatters.set(zone, new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }));
  const milliseconds = at / 1000n - (at < 0n && at % 1000n !== 0n ? 1n : 0n);
  const parts = dateFormatters.get(zone)!.formatToParts(new Date(Number(milliseconds)));
  return ["year", "month", "day"].map(name => parts.find(part => part.type === name)!.value).join("-");
}
function localDayBounds(day: string, zone: string): [bigint, bigint] {
  const nominal = Date.parse(day + "T00:00:00Z");
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 10) !== day) throw new Error("INVALID_FLOW_DATE");
  const boundary = (after: boolean) => {
    let low = nominal - 48 * 3600000, high = nominal + 72 * 3600000;
    while (low < high) {
      const middle = Math.floor((low + high) / 2), local = dateInZone(BigInt(middle) * 1000n, zone);
      if (after ? local > day : local >= day) high = middle; else low = middle + 1;
    }
    return BigInt(low) * 1000n;
  };
  return [boundary(false), boundary(true)];
}
function observedInstant(observation: ObjectValue): bigint | undefined {
  if (observation.time_precision === "second") return instant(observation.observed_at);
  if (observation.time_precision !== "date" || typeof observation.observed_at !== "string" || typeof observation.source_timezone !== "string") return;
  try { return localDayBounds(observation.observed_at, observation.source_timezone)[1]; } catch { return; }
}
function chosenObservation(rows: ObjectValue[], cutoff: bigint, knownAt: bigint): ObjectValue | undefined {
  const eligible = rows.flatMap(row => {
    const observed = observedInstant(row), ingested = instant(row.ingested_at), published = row.published_at === null || row.published_at === undefined ? ingested : instant(row.published_at);
    return observed !== undefined && ingested !== undefined && published !== undefined && observed <= cutoff && ingested <= knownAt && published <= knownAt ? [{ row, order: [observed, published, ingested] }] : [];
  });
  eligible.sort((a, b) => { for (let i = 0; i < 3; i++) if (a.order[i] !== b.order[i]) return a.order[i] > b.order[i] ? -1 : 1; return 0; });
  const best = eligible[0];
  if (!best) return;
  const ties = eligible.filter(item => item.order.every((value, i) => value === best.order[i]));
  if (new Set(ties.map(item => canonical([item.row.value, item.row.revision_id, item.row.source_id]))).size > 1) return;
  return best.row;
}

function observationEligible(observation: Observation, publication: Publication, run: StoredValuation, mode: unknown): boolean {
  const cutoff = instant(run.cutoff_at), knownAt = mode === "restated" ? instant(object(parse(run.market_manifest)?.ledger_fact_quality)?.knowledge_at) : cutoff;
  const ingested = instant(observation.ingested_at), published = instant(publication.published_at), observed = observedInstant({ ...observation });
  const quotePublished = observation.published_at === null ? ingested : instant(observation.published_at);
  return cutoff !== undefined && knownAt !== undefined && ingested !== undefined && published !== undefined && observed !== undefined && quotePublished !== undefined && ingested <= knownAt && published <= knownAt && quotePublished <= knownAt && observed <= cutoff;
}

type SecurityHolding = { account_id: string; listing_id: string; currency: string; quantity: Decimal; transfer_event_id?: string; target_account_id?: string };
function securityHoldingsAt(db: Database.Database, run: StoredValuation, mode: unknown) {
  const cutoff = instant(run.cutoff_at), created = instant(run.created_at);
  if (cutoff === undefined || created === undefined) throw new Error("INVALID_VALUATION_CLOCK");
  const known = mode === "as_known" ? cutoff : instant(object(parse(run.market_manifest)?.ledger_fact_quality)?.knowledge_at);
  if (known === undefined || known > created) throw new Error("INVALID_LEDGER_KNOWLEDGE");
  const events = db.prepare("SELECT * FROM ledger_events WHERE portfolio_id=? AND ledger_revision<=?").all(run.portfolio_id, run.ledger_revision) as EventRow[];
  const included = new Set<string>(), eventById = new Map(events.map(event => [event.id, event])), cutoffDates = new Map<string, string>();
  let futureRecorded = false;
  for (const event of events) {
    const recorded = instant(event.recorded_at);
    if (recorded === undefined) throw new Error("INVALID_LEDGER_KNOWLEDGE");
    let eligible = false;
    if (event.time_precision === "date") {
      if (!cutoffDates.has(event.source_timezone)) cutoffDates.set(event.source_timezone, dateInZone(cutoff, event.source_timezone));
      eligible = event.effective_at <= cutoffDates.get(event.source_timezone)!;
    } else eligible = (instant(event.effective_at) ?? cutoff + 1n) <= cutoff;
    if (!eligible) continue;
    if (recorded > known) { if (mode === "restated") futureRecorded = true; continue; }
    included.add(event.id);
  }
  const accounts = new Set((db.prepare("SELECT id FROM accounts WHERE portfolio_id=?").all(run.portfolio_id) as { id: string }[]).map(row => row.id));
  const settled = new Map<string, SecurityHolding>(), transit = new Map<string, SecurityHolding>();
  const movements = db.prepare("SELECT p.*,l.currency listing_currency FROM position_movements p JOIN ledger_events e ON e.id=p.event_id JOIN listings l ON l.id=p.listing_id WHERE e.portfolio_id=? AND e.ledger_revision<=?").all(run.portfolio_id, run.ledger_revision) as (ObjectValue & { event_id: string; account_id: string; listing_id: string; currency: string; listing_currency: string; quantity: string })[];
  for (const movement of movements) {
    if (!included.has(movement.event_id)) continue;
    if (!accounts.has(movement.account_id) || movement.currency !== movement.listing_currency) throw new Error("INVALID_POSITION_SCOPE");
    const key = canonical([movement.account_id, movement.listing_id, movement.currency]);
    const previous = settled.get(key);
    settled.set(key, { account_id: movement.account_id, listing_id: movement.listing_id, currency: movement.currency, quantity: (previous?.quantity ?? new Decimal(0)).add(movement.quantity) });
  }
  const transitMovements = db.prepare("SELECT m.*,l.currency listing_currency FROM security_transit_movements m JOIN ledger_events e ON e.id=m.event_id JOIN listings l ON l.id=m.listing_id WHERE e.portfolio_id=? AND e.ledger_revision<=?").all(run.portfolio_id, run.ledger_revision) as (ObjectValue & { event_id: string; transfer_event_id: string; source_account_id: string; target_account_id: string; listing_id: string; currency: string; listing_currency: string; quantity: string })[];
  const originMovements = new Map(transitMovements.filter(movement => movement.event_id === movement.transfer_event_id).map(movement => [movement.transfer_event_id, movement]));
  for (const movement of transitMovements) {
    if (!included.has(movement.event_id)) continue;
    const source = eventById.get(movement.transfer_event_id), fact = source ? object(parse(String(source.payload_json))?.fact) : undefined;
    const origin = originMovements.get(movement.transfer_event_id);
    if (!source || source.event_type !== "security_transfer_out" || !included.has(source.id) || !accounts.has(movement.source_account_id) || !accounts.has(movement.target_account_id) || movement.source_account_id === movement.target_account_id || movement.currency !== movement.listing_currency || source.account_id !== movement.source_account_id || fact?.target_account_id !== movement.target_account_id || fact?.listing_id !== movement.listing_id || fact?.currency !== movement.currency || !origin || typeof fact.quantity !== "string" || !new Decimal(origin.quantity).eq(fact.quantity)) throw new Error("INVALID_SECURITY_TRANSIT_SCOPE");
    const previous = transit.get(movement.transfer_event_id);
    if (previous && (previous.account_id !== movement.source_account_id || previous.target_account_id !== movement.target_account_id || previous.listing_id !== movement.listing_id || previous.currency !== movement.currency)) throw new Error("INVALID_SECURITY_TRANSIT_SCOPE");
    transit.set(movement.transfer_event_id, { account_id: movement.source_account_id, target_account_id: movement.target_account_id, transfer_event_id: movement.transfer_event_id, listing_id: movement.listing_id, currency: movement.currency, quantity: (previous?.quantity ?? new Decimal(0)).add(movement.quantity) });
  }
  for (const collection of [settled, transit]) for (const [key, holding] of collection) {
    if (holding.quantity.lt(0)) throw new Error("NEGATIVE_SECURITY_QUANTITY");
    if (holding.quantity.isZero()) collection.delete(key);
  }
  const reversed = new Set(events.filter(event => included.has(event.id) && event.reversal_of).map(event => event.reversal_of));
  const initialized = events.some(event => included.has(event.id) && !reversed.has(event.id) && !["reversal", "corporate_action_notice", "corporate_action_resolution"].includes(event.event_type));
  return { settled, transit, included, futureRecorded, initialized };
}

function inspectSecurityItems(db: Database.Database, run: StoredValuation, items: Item[], holdings: ReturnType<typeof securityHoldingsAt>): string[] {
  const issues: string[] = [], seen = new Set<string>();
  for (const item of items) {
    if (!["security_market_value", "security_in_transit_market_value"].includes(item.item_type)) continue;
    const evidence = parse(item.evidence_json), isTransit = item.item_type === "security_in_transit_market_value";
    const identity = isTransit ? String(evidence?.transfer_event_id) : canonical([item.account_id, item.listing_id, item.currency]);
    const key = item.item_type + ":" + identity, expected = (isTransit ? holdings.transit : holdings.settled).get(identity);
    if (!evidence || !expected || seen.has(key) || item.account_id !== expected.account_id || item.listing_id !== expected.listing_id || item.currency !== expected.currency || evidence.quantity !== expected.quantity.toFixed() || (isTransit ? evidence.target_account_id !== expected.target_account_id : evidence.transfer_event_id !== undefined || evidence.target_account_id !== undefined)) {
      issues.push("SECURITY_QUANTITY_EVIDENCE_INVALID"); continue;
    }
    seen.add(key);
    const price = db.prepare("SELECT value FROM market_observations WHERE id=?").get(evidence.price_observation_id ?? "") as { value: string } | undefined;
    const fx = item.currency === "CNY" ? { value: "1" } : db.prepare("SELECT value FROM market_observations WHERE id=?").get(evidence.fx_observation_id ?? "") as { value: string } | undefined;
    if (!price || !fx || !new Decimal(price.value).gt(0) || !new Decimal(fx.value).gt(0) || item.amount === null || item.fx_rate === null || item.value_cny === null || !new Decimal(item.amount).eq(expected.quantity.mul(price.value)) || !new Decimal(item.fx_rate).eq(fx.value) || !new Decimal(item.value_cny).eq(expected.quantity.mul(price.value).mul(fx.value))) issues.push("SECURITY_VALUE_EVIDENCE_INVALID");
  }
  for (const [key] of holdings.settled) if (!seen.has("security_market_value:" + key)) issues.push("SECURITY_QUANTITY_EVIDENCE_MISSING");
  for (const [key] of holdings.transit) if (!seen.has("security_in_transit_market_value:" + key)) issues.push("SECURITY_TRANSIT_EVIDENCE_MISSING");
  return issues;
}

const monetaryAccounts = new Set(["cash_settled", "trade_receivable", "trade_payable", "dividend_receivable", "dividend_tax_payable", "transfer_in_transit", "other_liability"]);
function inspectMonetaryItems(db: Database.Database, run: StoredValuation, items: Item[], included: Set<string>): string[] {
  const issues: string[] = [], expected = new Map<string, Decimal>(), seen = new Set<string>();
  const postings = db.prepare("SELECT p.account_id,p.currency,p.ledger_account,p.amount,p.event_id,a.portfolio_id FROM postings p JOIN ledger_events e ON e.id=p.event_id JOIN accounts a ON a.id=p.account_id WHERE e.portfolio_id=? AND e.ledger_revision<=?").all(run.portfolio_id, run.ledger_revision) as { account_id: string; currency: string; ledger_account: string; amount: string; event_id: string; portfolio_id: string }[];
  for (const posting of postings) {
    if (!included.has(posting.event_id) || !monetaryAccounts.has(posting.ledger_account)) continue;
    if (posting.portfolio_id !== run.portfolio_id) throw new Error("MONETARY_SCOPE_INVALID");
    const key = canonical([posting.account_id, posting.currency, posting.ledger_account]);
    expected.set(key, (expected.get(key) ?? new Decimal(0)).add(posting.amount));
  }
  for (const [key, value] of expected) if (value.isZero()) expected.delete(key);
  for (const item of items) {
    if (!monetaryAccounts.has(item.item_type)) {
      if (!["security_market_value", "security_in_transit_market_value", "invalid_position"].includes(item.item_type)) issues.push("VALUATION_ITEM_TYPE_INVALID");
      continue;
    }
    const key = canonical([item.account_id, item.currency, item.item_type]), value = expected.get(key), evidence = parse(item.evidence_json);
    if (seen.has(key) || !value || item.listing_id !== null || item.amount === null || !new Decimal(item.amount).eq(value) || evidence?.ledger_revision !== run.ledger_revision) {
      issues.push("MONETARY_AMOUNT_EVIDENCE_INVALID"); continue;
    }
    seen.add(key);
    const fx = item.currency === "CNY" ? { value: "1" } : db.prepare("SELECT value FROM market_observations WHERE id=?").get(evidence?.fx_observation_id ?? "") as { value: string } | undefined;
    if (!fx) {
      if (item.fx_rate !== null || item.value_cny !== null) issues.push("MONETARY_VALUE_EVIDENCE_INVALID");
    } else if (!new Decimal(fx.value).gt(0) || item.fx_rate === null || item.value_cny === null || !new Decimal(item.fx_rate).eq(fx.value) || !new Decimal(item.value_cny).eq(value.mul(fx.value))) issues.push("MONETARY_VALUE_EVIDENCE_INVALID");
  }
  for (const [key] of expected) if (!seen.has(key)) issues.push("MONETARY_AMOUNT_EVIDENCE_MISSING");
  if (run.nav_cny !== null) {
    if (items.some(item => item.value_cny === null) || !new Decimal(run.nav_cny).eq(items.reduce((sum, item) => sum.add(item.value_cny ?? "0"), new Decimal(0)))) issues.push("VALUATION_TOTAL_EVIDENCE_INVALID");
  }
  return issues;
}

function inspectValuation(db: Database.Database, run: Valuation) {
  const issues: string[] = [], scopes = new Map<string, Publication>();
  const checkedSources = new Map<string, boolean>();
  const manifest = parse(run.market_manifest);
  const stored = db.prepare("SELECT * FROM valuation_runs WHERE id=?").get(run.id) as StoredValuation | undefined;
  if (!stored || stored.market_manifest !== run.market_manifest || stored.ledger_revision !== run.ledger_revision) issues.push("VALUATION_EVIDENCE_INVALID");
  if (!stored || !/^decimal-nav-cny-v4:(as_known|restated)$/.test(stored.method_version) || (manifest?.mode && stored.method_version !== "decimal-nav-cny-v4:" + manifest.mode)) issues.push("VALUATION_METHOD_SUPERSEDED");
  if (!manifest || !validValuationInput(manifest) || !validRules(manifest.rules) || manifest.rules_hash !== hash(manifest.rules) || !object(manifest.publications)) {
    return { issues: [...issues, "INPUT_MANIFEST_INVALID"], scopes, manifest, stored };
  }
  const rules = object(manifest.rules)!;
  if (rules.approved !== true) issues.push("VALUATION_QUALITY_RULES_UNAPPROVED");
  const publications = object(manifest.publications)!;
  const items = db.prepare("SELECT account_id,item_type,listing_id,currency,amount,fx_rate,value_cny,evidence_json FROM valuation_items WHERE run_id=?").all(run.id) as Item[];
  if (!items.length && stored?.nav_cny !== null && !/^-?0(?:\.0+)?$/.test(stored?.nav_cny ?? "")) issues.push("VALUATION_ITEMS_MISSING");
  for (const item of items) {
    const evidence = parse(item.evidence_json);
    if (!evidence) { issues.push("MARKET_EVIDENCE_INVALID"); continue; }
    for (const kind of ["price", "fx"] as const) {
      const id = evidence[kind + "_observation_id"];
      if (id === null || id === undefined) {
        if ((kind === "price" && ["security_market_value", "security_in_transit_market_value"].includes(item.item_type)) || (kind === "fx" && item.currency !== "CNY")) issues.push("MARKET_EVIDENCE_MISSING");
        continue;
      }
      if (typeof id !== "string") { issues.push("MARKET_EVIDENCE_INVALID"); continue; }
      const observation = db.prepare("SELECT o.*,l.market,l.currency AS listing_currency FROM market_observations o LEFT JOIN listings l ON l.id=o.listing_id WHERE o.id=?").get(id) as Observation | undefined;
      const scope = kind === "price" ? object(rules.price_scope_by_market)?.[observation?.market ?? ""] : rules.fx_scope;
      const publication = typeof scope === "string" ? publicationAt(db, scope, publications[scope]) : undefined;
      const metricValid = observation && (kind === "price"
        ? observation.metric === "close" && observation.price_basis === "unadjusted" && observation.listing_id === item.listing_id && observation.listing_currency === item.currency && observation.unit === item.currency
        : observation.metric === "fx_cny_per_unit" && observation.price_basis === "not_applicable" && observation.listing_id === null && observation.series_key === "FX:" + item.currency && observation.unit === "CNY_per_unit_currency");
      if (!metricValid || !observation || !publication || !stored || !observationEligible(observation, publication, stored, manifest.mode) || !db.prepare("SELECT 1 FROM market_batch_members WHERE batch_id=? AND observation_id=?").get(publication.batch_id, id)) {
        issues.push("MARKET_EVIDENCE_INVALID"); continue;
      }
      if (!checkedSources.has(publication.batch_id)) {
        try { verifiedMarketSource(db, publication.batch_id, manifest.mode === "as_known" ? stored.cutoff_at : String(object(manifest.ledger_fact_quality)?.knowledge_at)); checkedSources.set(publication.batch_id, true); }
        catch { checkedSources.set(publication.batch_id, false); }
      }
      if (!checkedSources.get(publication.batch_id)) { issues.push("MARKET_SOURCE_UNVERIFIED"); continue; }
      scopes.set(publication.scope, publication);
    }
  }
  if (stored) try {
    const proof = object(manifest.ledger_fact_quality), known = instant(proof?.knowledge_at);
    if (!proof || known === undefined || known > instant(stored.created_at)! || known < instant(stored.cutoff_at)!) throw new Error("INVALID_FACT_KNOWLEDGE");
    const expected = ledgerFactQualityAt(db, stored.portfolio_id, stored.cutoff_at, String(proof.knowledge_at), manifest.mode as "as_known" | "restated", stored.ledger_revision);
    if (canonical(proof) !== canonical(expected)) issues.push("LEDGER_FACT_QUALITY_EVIDENCE_INVALID");
    if ((expected.nav_quality !== "complete" && (stored.quality === "complete" || stored.nav_cny !== null)) || (expected.nav_quality === "blocked" && stored.quality !== "blocked")) issues.push("LEDGER_FACT_QUALITY_OVERRIDDEN");
  } catch { issues.push("LEDGER_FACT_QUALITY_EVIDENCE_INVALID"); }
  if (stored) try {
    const holdings = securityHoldingsAt(db, stored, manifest.mode);
    if ((!holdings.initialized || holdings.futureRecorded) && (stored.quality !== "blocked" || stored.nav_cny !== null)) issues.push("LEDGER_FACT_QUALITY_OVERRIDDEN");
    issues.push(...inspectSecurityItems(db, stored, items, holdings), ...inspectMonetaryItems(db, stored, items, holdings.included));
  } catch { issues.push("LEDGER_ITEM_EVIDENCE_INVALID"); }
  return { issues, scopes, manifest, stored };
}


type EventRow = ObjectValue & { id: string; portfolio_id: string; account_id: string; effective_at: string; time_precision: string; source_timezone: string; recorded_at: string; reversal_of: string | null; event_type: string; payload_hash: string; ledger_revision: number };
type PostingRow = ObjectValue & { id: string; event_id: string; account_id: string; currency: string; amount: string };
type StoredPerformance = ObjectValue & { id: string; portfolio_id: string; market_manifest: string; method_version: string; ledger_revision: number; period_start: string; period_end: string; result_json: string; created_at: string };

function securityFlowValid(db: Database.Database, event: EventRow, posting: PostingRow, flow: ObjectValue): boolean {
  const fact = object(parse(String(event.payload_json))?.fact), security = object(flow.security), evidence = object(fact?.value_evidence);
  if (!fact || !validLedgerFact(fact) || !security || !evidence || !validSecurityValue(evidence) || typeof evidence.reference !== "string" || !evidence.reference.trim() || fact.type !== event.event_type || fact.account_id !== event.account_id || fact.currency !== posting.currency || typeof fact.listing_id !== "string" || typeof fact.quantity !== "string" || typeof fact.market_value !== "string" || !new FlowDecimal(fact.quantity).gt(0) || !new FlowDecimal(fact.market_value).gt(0)) return false;
  if (security.listing_id !== fact.listing_id || security.quantity !== fact.quantity || security.market_value !== fact.market_value || security.fact_hash !== hash(fact) || canonical(security.value_evidence) !== canonical(evidence) || evidence.time_precision !== event.time_precision || evidence.source_timezone !== event.source_timezone || (event.time_precision === "date" ? evidence.effective_at !== event.effective_at : instant(evidence.effective_at) === undefined || instant(evidence.effective_at) !== instant(event.effective_at))) return false;
  const listing = db.prepare("SELECT currency FROM listings WHERE id=?").get(fact.listing_id) as { currency: string } | undefined;
  const movements = db.prepare("SELECT account_id,listing_id,currency,quantity FROM position_movements WHERE event_id=?").all(event.id) as { account_id: string; listing_id: string; currency: string; quantity: string }[];
  const direction = event.event_type === "security_in" ? 1 : -1, movement = movements[0];
  return listing?.currency === posting.currency && movements.length === 1 && movement.account_id === event.account_id && movement.listing_id === fact.listing_id && movement.currency === posting.currency && new FlowDecimal(movement.quantity).eq(new FlowDecimal(fact.quantity).mul(direction)) && new FlowDecimal(posting.amount).neg().eq(new FlowDecimal(fact.market_value).mul(direction));
}

function inspectFlows(db: Database.Database, manifest: ObjectValue, snapshots: StoredValuation[], stored: StoredPerformance | undefined, scopes: Set<string>): string[] {
  const issues: string[] = [], evidence = manifest.external_flow_evidence as ObjectValue[];
  if (snapshots.length < 2) return ["FLOW_EVIDENCE_INVALID"];
  const portfolio = snapshots[0].portfolio_id, start = instant(snapshots[0].cutoff_at), end = instant(snapshots.at(-1)!.cutoff_at);
  if (start === undefined || end === undefined) return ["FLOW_EVIDENCE_INVALID"];
  const rules = object(manifest.flow_fx_rules), rulesHash = rules ? hash(rules) : null;
  if (manifest.flow_fx_rules_hash !== rulesHash) issues.push("FLOW_FX_RULES_INVALID");
  const valuationFxScopes = new Map<string, Set<string>>();
  for (const snapshot of snapshots) {
    const scope = object(parse(snapshot.market_manifest)?.rules)?.fx_scope;
    if (typeof scope !== "string") continue;
    for (const item of db.prepare("SELECT currency,evidence_json FROM valuation_items WHERE run_id=?").all(snapshot.id) as Pick<Item, "currency" | "evidence_json">[]) {
      if (typeof parse(item.evidence_json)?.fx_observation_id !== "string") continue;
      if (!valuationFxScopes.has(item.currency)) valuationFxScopes.set(item.currency, new Set());
      valuationFxScopes.get(item.currency)!.add(scope);
    }
  }
  if (stored) {
    const result = parse(stored.result_json);
    if (instant(stored.period_start) !== start || instant(stored.period_end) !== end || !result || canonical(result.external_flow_evidence ?? null) !== canonical(evidence)) issues.push("FLOW_EVIDENCE_INVALID");
  } else if (evidence.length) issues.push("PERFORMANCE_EVIDENCE_MISSING");

  const events = db.prepare("SELECT * FROM ledger_events WHERE portfolio_id=? AND ledger_revision<=?").all(portfolio, manifest.ledger_revision) as EventRow[];
  const visible = events.filter(event => manifest.mode === "restated" || (instant(event.recorded_at) ?? end + 1n) <= end);
  const reversed = new Set(visible.map(event => event.reversal_of).filter(Boolean));
  const active = new Map(visible.filter(event => event.event_type !== "reversal" && !event.reversal_of && !reversed.has(event.id)).map(event => [event.id, event]));
  const accounts = new Set((db.prepare("SELECT id FROM accounts WHERE portfolio_id=?").all(portfolio) as { id: string }[]).map(row => row.id));
  const expected = new Map<string, { event: EventRow; posting: PostingRow; at: bigint | null; evaluationDate: string | null }>();
  const boundaries = new Map<string, [bigint, bigint]>();
  const cutoffs = snapshots.map(snapshot => instant(snapshot.cutoff_at)!);
  const capitalPostings = db.prepare("SELECT p.* FROM postings p JOIN ledger_events e ON e.id=p.event_id WHERE e.portfolio_id=? AND e.ledger_revision<=? AND p.ledger_account='external_capital'").all(portfolio, manifest.ledger_revision) as PostingRow[];
  const capitalCounts = new Map<string, number>();
  for (const posting of capitalPostings) capitalCounts.set(posting.event_id, (capitalCounts.get(posting.event_id) ?? 0) + 1);
  for (const event of active.values()) if (["security_in", "security_out"].includes(event.event_type)) {
    const at = event.time_precision === "second" ? instant(event.effective_at) : undefined;
    const bounds = event.time_precision === "date" ? localDayBounds(event.effective_at, event.source_timezone) : undefined;
    if ((bounds ? bounds[1] > start && bounds[0] <= end : at !== undefined && start < at && at <= end) && capitalCounts.get(event.id) !== 1) issues.push("SECURITY_FLOW_POSTING_COVERAGE_INVALID");
  }
  for (const posting of capitalPostings) {
    const event = active.get(posting.event_id);
    if (!event) continue;
    try {
      let at: bigint | undefined;
      if (event.time_precision === "date") {
        const key = event.effective_at + ":" + event.source_timezone;
        if (!boundaries.has(key)) boundaries.set(key, localDayBounds(event.effective_at, event.source_timezone));
        const [dayStart, dayEnd] = boundaries.get(key)!;
        if (cutoffs.some(cutoff => dayStart <= cutoff && cutoff < dayEnd)) issues.push("DATE_ONLY_FLOW_CROSSES_SNAPSHOT_BOUNDARY");
        if (posting.currency !== "CNY" || ["security_in", "security_out"].includes(event.event_type)) {
          if (dayEnd > start && dayStart <= end) expected.set(posting.id, { event, posting, at: null, evaluationDate: null });
          continue;
        }
        at = dayEnd;
      } else at = instant(event.effective_at);
      if (at === undefined) { issues.push("FLOW_EVIDENCE_INVALID"); continue; }
      if (start < at && at <= end) expected.set(posting.id, { event, posting, at, evaluationDate: dateInZone(event.time_precision === "date" ? at - 1n : at, String(manifest.evaluation_timezone)) });
    } catch { issues.push("FLOW_EVIDENCE_INVALID"); }
  }
  const seen = new Set<string>(), restatedKnowledge = new Set<string>();
  for (const flow of evidence) {
    const postingId = String(flow.posting_id), source = expected.get(postingId);
    if (!source || seen.has(postingId)) { issues.push("FLOW_EVIDENCE_COVERAGE_INVALID"); continue; }
    seen.add(postingId);
    const { event, posting, at, evaluationDate } = source;
    const isSecurity = ["security_in", "security_out"].includes(event.event_type);
    const { binding_id: binding, ...bound } = flow;
    const native = new FlowDecimal(posting.amount).neg(), nativeText = native.isZero() ? "0" : native.toFixed();
    if (binding !== hash(bound) || flow.portfolio_id !== portfolio || flow.event_id !== event.id || flow.event_payload_hash !== event.payload_hash || flow.event_hash !== hash(event) || flow.posting_hash !== hash(posting) || flow.event_ledger_revision !== event.ledger_revision || flow.currency !== posting.currency || flow.amount_native !== nativeText || flow.effective_at !== event.effective_at || flow.time_precision !== event.time_precision || flow.source_timezone !== event.source_timezone || flow.mode !== manifest.mode || !accounts.has(posting.account_id) || posting.account_id !== event.account_id || (at === null ? flow.flow_time !== null : instant(flow.flow_time) !== at) || flow.evaluation_date !== evaluationDate) {
      issues.push("FLOW_EVIDENCE_INVALID"); continue;
    }
    if (flow.flow_kind !== (isSecurity ? "security" : "cash") || (!isSecurity && flow.security !== null)) { issues.push("FLOW_EVIDENCE_INVALID"); continue; }
    if (["security_transfer_out", "security_transfer_in", "security_transfer_return"].includes(event.event_type)) { issues.push("INTERNAL_SECURITY_TRANSFER_EXTERNAL_CAPITAL"); continue; }
    if (flow.quality !== "complete" || (flow.issues as string[]).length) {
      issues.push("FLOW_EVIDENCE_BLOCKED");
      if (flow.fx_rate !== null || flow.amount_cny !== null) issues.push("FLOW_EVIDENCE_INVALID");
      continue;
    }
    if (isSecurity && !securityFlowValid(db, event, posting, flow)) { issues.push("SECURITY_FLOW_EVIDENCE_INVALID"); continue; }
    if (isSecurity && at === null) { issues.push("SECURITY_FLOW_TIME_UNCERTAIN"); continue; }
    if (posting.currency === "CNY") {
      if (["knowledge_at", "rules_hash", "publication", "observation", "observation_hash", "source_validation_hash", "source_mode", "source_evidence"].some(key => flow[key] !== null) || flow.fx_rate !== "1" || flow.amount_cny !== nativeText) issues.push("FLOW_EVIDENCE_INVALID");
      continue;
    }
    if (at === null || event.time_precision !== "second") { issues.push("FLOW_FX_TIME_UNCERTAIN"); continue; }
    if (!rules || rules.approved !== true || typeof rules.approval_evidence !== "string" || !rules.approval_evidence.trim() || flow.rules_hash !== rulesHash || typeof rules.fx_scope !== "string") { issues.push("FLOW_FX_RULES_INVALID"); continue; }
    if ([...valuationFxScopes.get(posting.currency) ?? []].some(scope => scope !== rules.fx_scope)) issues.push("INCOMPATIBLE_FLOW_FX_SOURCE:" + posting.currency);
    const scope = rules.fx_scope, publication = publicationAt(db, scope, flow.publication), declared = object(flow.observation);
    const knowledge = instant(flow.knowledge_at), created = instant(stored?.created_at);
    if (knowledge === undefined || (manifest.mode === "as_known" ? knowledge !== at : !created || knowledge < end || knowledge > created)) { issues.push("FLOW_FX_PIT_INVALID"); continue; }
    if (manifest.mode === "restated") restatedKnowledge.add(knowledge.toString());
    if (!publication || !declared || typeof declared.id !== "string") { issues.push("FLOW_FX_EVIDENCE_MISSING"); continue; }
    const publicationTime = instant(publication.published_at);
    const available = (db.prepare("SELECT * FROM market_publication_events WHERE scope=? ORDER BY revision DESC").all(scope) as Publication[]).find(row => (instant(row.published_at) ?? knowledge + 1n) <= knowledge);
    if (publicationTime === undefined || publicationTime > knowledge || !available || available.revision !== publication.revision || available.manifest_hash !== publication.manifest_hash) { issues.push("FLOW_FX_PIT_INVALID"); continue; }
    const observation = db.prepare("SELECT * FROM market_observations WHERE id=?").get(declared.id) as ObjectValue | undefined;
    if (!observation || hash(Object.fromEntries(Object.entries(observation).filter(([, value]) => value !== null))) !== flow.observation_hash || hash(declared) !== flow.observation_hash || !db.prepare("SELECT 1 FROM market_batch_members WHERE batch_id=? AND observation_id=?").get(publication.batch_id, declared.id)) { issues.push("FLOW_FX_EVIDENCE_INVALID"); continue; }
    const batch = db.prepare("SELECT validation_json,source_id,status,manifest_hash FROM market_batches WHERE id=?").get(publication.batch_id) as { validation_json: string; source_id: string; status: string; manifest_hash: string } | undefined;
    const validation = batch ? parse(batch.validation_json) : undefined, plan = object(validation?.plan);
    let sourceVerified = false;
    try {
      const source = verifiedMarketSource(db, publication.batch_id, String(flow.knowledge_at));
      sourceVerified = source.mode === flow.source_mode && (source.mode === "provider_observed" ? flow.schema_version === "flow-fx-evidence-v3" : typeof flow.source_evidence === "string" && Boolean(flow.source_evidence.trim()));
    } catch { /* Invalid provider proof is never downgraded to manual verification. */ }
    if (!validation || hash(validation) !== flow.source_validation_hash || !plan || flow.source_mode !== plan.source_mode || flow.source_evidence !== (plan.source_evidence ?? null) || !sourceVerified || observation.provenance === "reconstructed") { issues.push("FLOW_FX_SOURCE_UNVERIFIED"); continue; }
    if (!batch || batch.status !== "published" || batch.manifest_hash !== publication.manifest_hash || plan.source_id !== batch.source_id || plan.scope !== scope || observation.source_id !== batch.source_id || observation.published_at === null) { issues.push("FLOW_FX_EVIDENCE_INVALID"); continue; }
    if (observation.metric !== "fx_cny_per_unit" || observation.price_basis !== "not_applicable" || observation.unit !== "CNY_per_unit_currency" || observation.series_key !== "FX:" + posting.currency || observation.listing_id !== null) { issues.push("FLOW_FX_EVIDENCE_INVALID"); continue; }
    const candidates = db.prepare("SELECT o.* FROM market_observations o JOIN market_batch_members m ON m.observation_id=o.id WHERE m.batch_id=? AND o.series_key=? AND o.metric='fx_cny_per_unit' AND o.price_basis='not_applicable'").all(publication.batch_id, "FX:" + posting.currency) as ObjectValue[];
    const chosen = chosenObservation(candidates, at, knowledge), observed = observedInstant(observation);
    if (!chosen || chosen.id !== observation.id || observed === undefined || observed > at || at - observed > BigInt(Number(rules.max_fx_age_seconds)) * 1000000n) { issues.push("FLOW_FX_PIT_INVALID"); continue; }
    const rate = new FlowDecimal(String(observation.value)), rateText = rate.isZero() ? "0" : rate.toFixed();
    const converted = native.mul(rate), convertedText = converted.isZero() ? "0" : converted.toFixed();
    if (!rate.gt(0) || flow.fx_rate !== rateText || flow.amount_cny !== convertedText) { issues.push("FLOW_FX_AMOUNT_INVALID"); continue; }
    scopes.add(scope);
    const head = object(object(manifest.market_heads)?.[scope]);
    if (!head || Number(head.revision) < publication.revision || (manifest.mode === "restated" && (head.revision !== publication.revision || head.manifest_hash !== publication.manifest_hash))) issues.push("FLOW_FX_EVIDENCE_INVALID");
    if (manifest.mode === "as_known") {
      const later = (db.prepare("SELECT o.*,e.published_at AS batch_published_at FROM market_observations o JOIN market_batch_members m ON m.observation_id=o.id JOIN market_publication_events e ON e.batch_id=m.batch_id WHERE e.scope=? AND e.revision>? AND o.series_key=? AND o.metric='fx_cny_per_unit' AND o.price_basis='not_applicable'").all(scope, publication.revision, "FX:" + posting.currency) as ObjectValue[])
        .filter(row => (instant(row.batch_published_at) ?? end + 1n) <= end && (observedInstant(row) ?? -1n) >= observed);
      const revised = chosenObservation([observation, ...later], at, end);
      if (!revised || revised.unit !== observation.unit || revised.listing_id !== null || !new FlowDecimal(String(revised.value)).eq(rate)) issues.push("FLOW_FX_KNOWLEDGE_CHANGED_RESTATE_REQUIRED");
    }
  }
  if (seen.size !== expected.size) issues.push("FLOW_EVIDENCE_COVERAGE_INVALID");
  if (restatedKnowledge.size > 1) issues.push("FLOW_FX_PIT_INVALID");
  return issues;
}

export function valuationFreshness(db: Database.Database, run: Valuation, currentRevision: number): string[] {
  const { issues, scopes, manifest } = inspectValuation(db, run);
  if (run.ledger_revision !== currentRevision) issues.push("LEDGER_REVISION_CHANGED");
  // As-known still needs complete evidence, but a newer publication cannot rewrite its history.
  if (manifest?.mode === "restated") for (const [scope, publication] of scopes) if (!headMatches(db, scope, publication)) issues.push("RESTATED_MARKET_CHANGED:" + scope);
  return [...new Set(issues)];
}

export function performanceFreshness(db: Database.Database, run: { id?: string; market_manifest: string; method_version: string; ledger_revision: number }, currentRevision: number): string[] {
  const issues: string[] = [];
  if (run.ledger_revision !== currentRevision) issues.push("LEDGER_REVISION_CHANGED");
  if (!["snapshot-performance-cny-v5", "snapshot-performance-cny-v6"].includes(run.method_version)) issues.push("PERFORMANCE_METHOD_SUPERSEDED");
  const manifest = parse(run.market_manifest);
  const heads = object(manifest?.market_heads), references = manifest?.valuations;
  const validInput = run.method_version === "snapshot-performance-cny-v6" ? validProviderPerformanceInput : validPerformanceInput;
  if (!manifest || !validInput(manifest) || manifest.ledger_revision !== run.ledger_revision || !heads || !Array.isArray(references) || typeof manifest.evaluation_timezone !== "string") return [...issues, "INPUT_MANIFEST_INVALID"];
  try { new Intl.DateTimeFormat("en", { timeZone: manifest.evaluation_timezone }); } catch { return [...issues, "INPUT_MANIFEST_INVALID"]; }
  const scopes = new Set<string>(), ids = new Set<string>(), snapshots: StoredValuation[] = [];
  const stored = run.id ? db.prepare("SELECT * FROM performance_runs WHERE id=?").get(run.id) as StoredPerformance | undefined : undefined;
  if (run.id && (!stored || stored.market_manifest !== run.market_manifest || stored.ledger_revision !== run.ledger_revision || stored.method_version !== run.method_version)) issues.push("PERFORMANCE_EVIDENCE_INVALID");
  let portfolio = stored?.portfolio_id;
  let previousCutoff = -Infinity;
  for (const reference of references) {
    const ref = object(reference);
    if (typeof ref?.id !== "string" || !digest(ref.content_hash) || ids.has(ref.id)) { issues.push("VALUATION_EVIDENCE_INVALID"); continue; }
    ids.add(ref.id);
    const row = db.prepare("SELECT * FROM valuation_runs WHERE id=?").get(ref.id) as StoredValuation | undefined;
    if (!row || hash(row) !== ref.content_hash || row.ledger_revision !== run.ledger_revision || (portfolio && portfolio !== row.portfolio_id)) { issues.push("VALUATION_EVIDENCE_INVALID"); continue; }
    portfolio = row.portfolio_id;
    snapshots.push(row);
    const cutoff = Date.parse(row.cutoff_at);
    if (!Number.isFinite(cutoff) || cutoff <= previousCutoff) issues.push("VALUATION_EVIDENCE_INVALID");
    previousCutoff = cutoff;
    const evidence = inspectValuation(db, row);
    issues.push(...evidence.issues);
    if (evidence.manifest?.mode !== manifest.mode) issues.push("VALUATION_EVIDENCE_INVALID");
    for (const [scope, publication] of evidence.scopes) {
      scopes.add(scope);
      const expected = object(heads[scope]);
      if (!expected || (manifest.mode === "restated" && (expected.revision !== publication.revision || expected.manifest_hash !== publication.manifest_hash))) issues.push("MARKET_EVIDENCE_INVALID");
    }
  }
  if (manifest.mode === "as_known" && portfolio && snapshots.length >= 2) try {
    const times = snapshots.map(snapshot => instant(snapshot.cutoff_at));
    if (times.some(time => time === undefined)) throw new Error("INVALID_KNOWLEDGE_CLOCK");
    const boundaries = times as bigint[];
    const events = db.prepare("SELECT * FROM ledger_events WHERE portfolio_id=? AND ledger_revision<=?").all(portfolio, run.ledger_revision) as EventRow[];
    // Match Python's bisect_left policy, including reversals and zero-posting information events.
    for (const event of events) {
      const recorded = instant(event.recorded_at);
      if (recorded === undefined) throw new Error("INVALID_KNOWLEDGE_CLOCK");
      if (recorded > boundaries.at(-1)!) continue;
      const intervalEnd = boundaries.findIndex(boundary => boundary >= recorded);
      if (intervalEnd <= 0) continue;
      const effective = event.time_precision === "date" ? localDayBounds(String(event.effective_at), String(event.source_timezone))[1] : instant(event.effective_at);
      if (effective === undefined) throw new Error("INVALID_KNOWLEDGE_CLOCK");
      if (effective <= boundaries[intervalEnd - 1]) { issues.push("KNOWLEDGE_SET_CHANGED_RESTATE_REQUIRED"); break; }
    }
  } catch { issues.push("LEDGER_KNOWLEDGE_EVIDENCE_INVALID"); }
  try { issues.push(...inspectFlows(db, manifest, snapshots, stored, scopes)); } catch { issues.push("FLOW_EVIDENCE_INVALID"); }
  try {
    if (!stored || snapshots.length < 2) throw new Error("MISSING_PERFORMANCE_CONTEXT");
    const proofs = manifest.ledger_fact_quality as ObjectValue[], period = object(manifest.period_fact_quality);
    if (!period || proofs.length !== snapshots.length) throw new Error("FACT_QUALITY_COVERAGE_INVALID");
    const contexts = [...snapshots.map((snapshot, index) => ({ proof: proofs[index], cutoff: snapshot.cutoff_at, start: undefined as string | undefined })),
      { proof: period, cutoff: snapshots.at(-1)!.cutoff_at, start: snapshots[0].cutoff_at }];
    const bindings = new Set<string>();
    for (const { proof, cutoff, start } of contexts) {
      const known = instant(proof.knowledge_at);
      if (known === undefined || known > instant(stored.created_at)! || (manifest.mode === "as_known" ? known !== instant(cutoff) : known < instant(stored.period_end)!)) throw new Error("INVALID_FACT_KNOWLEDGE");
      bindings.add(String(proof.knowledge_at));
      const expected = ledgerFactQualityAt(db, stored.portfolio_id, cutoff, String(proof.knowledge_at), manifest.mode as "as_known" | "restated", stored.ledger_revision, start);
      if (canonical(proof) !== canonical(expected)) throw new Error("FACT_QUALITY_MISMATCH");
    }
    if (manifest.mode === "restated" && bindings.size !== 1) throw new Error("MIXED_FACT_KNOWLEDGE");
    const result = parse(stored.result_json);
    if (!result || canonical(result.ledger_fact_quality) !== canonical(proofs) || canonical(result.period_fact_quality) !== canonical(period)) throw new Error("FACT_QUALITY_RESULT_MISMATCH");
    const levels = ["complete", "provisional", "blocked"];
    const attribution = levels[Math.max(...[...proofs, period].map(proof => levels.indexOf(String(proof.attribution_quality))))];
    if (result.attribution_quality !== attribution) throw new Error("FACT_ATTRIBUTION_MISMATCH");
    if ([...proofs, period].some(proof => proof.performance_quality !== "complete")
      && (stored.quality !== "blocked" || result.return !== null || result.net_profit_cny !== null || result.drawdown !== null || object(result.xirr)?.rate !== null)) issues.push("LEDGER_FACT_QUALITY_OVERRIDDEN");
  } catch { issues.push("LEDGER_FACT_QUALITY_EVIDENCE_INVALID"); }
  for (const [scope, expected] of Object.entries(heads)) {
    const input = object(expected);
    const historical = input && Number.isSafeInteger(input.revision) && Number(input.revision) > 0 && digest(input.manifest_hash)
      ? db.prepare("SELECT manifest_hash FROM market_publication_events WHERE scope=? AND revision=?").get(scope, input.revision) as { manifest_hash: string } | undefined : undefined;
    if (!scopes.has(scope) || !historical || historical.manifest_hash !== input?.manifest_hash) issues.push("MARKET_EVIDENCE_INVALID");
    else if (manifest.mode === "restated" && !headMatches(db, scope, expected)) issues.push("RESTATED_MARKET_CHANGED:" + scope);
  }
  return [...new Set(issues)];
}
