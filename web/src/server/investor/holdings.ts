import type Database from "better-sqlite3";
import { canonical, hash, type Actor } from "../ledger/service";
import type { AttachmentOptions } from "../ledger/attachments";
import { valuationFreshness } from "../valuation-freshness";
import { parseStrictJson } from "../strict-json";
import { readMarketReferenceVersion, type MappingFacts } from "../market-references/service";
import { reviewedListingAt } from "../listing-reviews/service";
import { getInvestorAccountWorkspace } from "./accounts";
import { getInvestorState } from "./service";
import { readInvestorReconciliation, reconciliationReadOrderSql } from "./reconciliation-evidence";
import { HoldingsDecimal as Decimal, holdingsInstantMicros, investorHoldingsSchema, holdingsGapCodes,
  type HoldingsGapCode, type InvestorHoldings } from "./holdings-schemas";

type Valuation = { id: string; ledger_revision: number; market_manifest: string; cutoff_at: string; quality: string; nav_cny: string | null; issues_json: string; created_at: string };
type Item = { id: string; account_id: string; listing_id: string | null; item_type: string; currency: string; value_cny: string | null; quality: string; evidence_json: string };
type Component = NonNullable<InvestorHoldings["snapshot"]>["components"][number];
const monetary = new Set(["cash_settled", "trade_receivable", "trade_payable", "dividend_receivable", "dividend_tax_payable", "transfer_in_transit", "other_liability"]);
function instant(value: string) { const parsed = holdingsInstantMicros(value); if (parsed === null) throw new Error("VALUATION_EVIDENCE_INVALID"); return parsed; }
function gap(error: unknown): HoldingsGapCode {
  return error instanceof Error && (holdingsGapCodes as readonly string[]).includes(error.message) ? error.message as HoldingsGapCode : "VALUATION_EVIDENCE_INVALID";
}
function quantity(item: Item) {
  const evidence = parseStrictJson(item.evidence_json) as { quantity: string };
  if (!evidence || typeof evidence.quantity !== "string") throw new Error("VALUATION_EVIDENCE_INVALID");
  return new Decimal(evidence.quantity);
}
function compose(db: Database.Database, items: Item[], accountIds: Set<string>, nav: string) {
  const groups = new Map<string, Component>();
  for (const item of items) {
    if (!accountIds.has(item.account_id) || item.quality !== "complete" || item.value_cny === null) throw new Error("VALUATION_EVIDENCE_INVALID");
    const security = ["security_market_value", "security_in_transit_market_value"].includes(item.item_type);
    if (!security && !monetary.has(item.item_type) || security !== (item.listing_id !== null)) throw new Error("VALUATION_EVIDENCE_INVALID");
    const key = security ? "security:" + item.listing_id : item.item_type + ":" + item.currency;
    let row = groups.get(key);
    if (!row) {
      const listing = security ? db.prepare(`SELECT l.ticker,l.market,l.currency,i.name FROM listings l JOIN instruments i ON i.id=l.instrument_id WHERE l.id=?`).get(item.listing_id) as
        { ticker: string; market: "CN" | "HK" | "US"; currency: string; name: string } | undefined : undefined;
      if (security && (!listing || listing.currency !== item.currency)) throw new Error("VALUATION_EVIDENCE_INVALID");
      row = { key, category: security ? "security" : item.item_type as Component["category"], currency: item.currency, listing_id: item.listing_id,
        ticker: listing?.ticker ?? null, name: listing?.name ?? null, market: listing?.market ?? null, account_ids: [], value_cny: "0", weight: "0",
        settled_quantity: security ? "0" : null, transit_quantity: security ? "0" : null };
      groups.set(key, row);
    }
    if (!row.account_ids.includes(item.account_id)) row.account_ids.push(item.account_id);
    row.value_cny = new Decimal(row.value_cny).add(item.value_cny).toFixed();
    if (security) {
      const field = item.item_type === "security_market_value" ? "settled_quantity" : "transit_quantity";
      row[field] = new Decimal(row[field]!).add(quantity(item)).toFixed();
    }
  }
  return [...groups.values()].sort((a, b) => a.key < b.key ? -1 : 1).map(row => ({ ...row, account_ids: row.account_ids.sort(), weight: new Decimal(row.value_cny).div(nav).toFixed(18) }));
}
function marketDayStart(day: string, market: "CN" | "HK" | "US") {
  const zone = { CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" }[market];
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const localDay = (millis: number) => { const parts = formatter.formatToParts(new Date(millis)); return ["year", "month", "day"].map(name => parts.find(part => part.type === name)!.value).join("-"); };
  const nominal = Date.parse(day + "T00:00:00Z"); let low = nominal - 48 * 3600000, high = nominal + 48 * 3600000;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (localDay(middle) >= day) high = middle; else low = middle + 1; }
  return BigInt(low) * 1000n;
}
function targetComparison(db: Database.Database, actor: Actor, result: InvestorHoldings, now: string) {
  const state = getInvestorState(db, actor, now), plan = state.plan, snapshot = result.snapshot!;
  if (!plan || plan.quality !== "current") throw new Error("REFERENCE_NOT_READY");
  if (plan.document.data_mode !== "reconstructed" || !plan.document.reference_evidence) throw new Error("REFERENCE_NOT_REAL_DATA");
  const portfolio = result.portfolio_id!, heads = db.prepare("SELECT * FROM market_reference_heads WHERE portfolio_id=? AND kind='mapping' ORDER BY scope_key LIMIT 1001").all(portfolio) as
    { scope_key: string; version_id: string; version: number; updated_at: string }[];
  if (heads.length > 1000) throw new Error("HOLDINGS_CAPACITY_REVIEW_REQUIRED");
  const mappings = heads.map(head => {
    const proof = readMarketReferenceVersion(db, portfolio, head.version_id), facts = proof.document.facts as MappingFacts;
    if (proof.document.kind !== "mapping" || proof.row.scope_key !== head.scope_key || proof.row.version !== head.version
      || proof.row.known_at !== head.updated_at || instant(proof.row.known_at) > instant(now)) throw new Error("REFERENCE_EVIDENCE_INVALID");
    return { proof, facts };
  });
  let expiry = instant(plan.document.valid_until), allocated = new Decimal(0);
  const used = new Set<string>();
  const rows = plan.document.targets.map(target => {
    const candidates = mappings.filter(({ facts }) => facts.provider_symbol === target.symbol && facts.market === target.market && facts.currency === target.currency
      && marketDayStart(facts.valid_from, facts.market) <= instant(now)
      && (facts.valid_to === null || marketDayStart(facts.valid_to, facts.market) > instant(now)));
    if (candidates.length !== 1) throw new Error(candidates.length ? "REFERENCE_IDENTITY_AMBIGUOUS" : "REFERENCE_IDENTITY_REQUIRED");
    const { proof, facts } = candidates[0];
    if (used.has(facts.listing_id)) throw new Error("REFERENCE_IDENTITY_AMBIGUOUS"); used.add(facts.listing_id);
    const microsNow = now.replace(/(\.\d{3})Z$/, "$1000Z");
    const review = reviewedListingAt(db, { portfolio_id: portfolio, listing_id: facts.listing_id, knowledge_at: microsNow, now: microsNow });
    if (review.quality !== "complete" || !review.document || !review.proof_hash || review.identity.market !== target.market
      || review.identity.currency !== target.currency || review.identity.exchange !== facts.exchange) throw new Error("REFERENCE_IDENTITY_REQUIRED");
    expiry = expiry < instant(review.document.review_until) ? expiry : instant(review.document.review_until);
    if (facts.valid_to) { const end = marketDayStart(facts.valid_to, facts.market); expiry = expiry < end ? expiry : end; }
    const actual = snapshot.components.filter(row => row.listing_id === facts.listing_id).reduce((sum, row) => sum.add(row.value_cny), new Decimal(0));
    allocated = allocated.add(actual);
    return { research_listing_id: target.listing_id, ledger_listing_id: facts.listing_id, symbol: target.symbol, market: target.market, currency: target.currency,
      target_weight: target.weight, actual_value_cny: actual.toFixed(), actual_weight: actual.div(snapshot.nav_cny).toFixed(18),
      difference_cny: actual.minus(new Decimal(snapshot.nav_cny).mul(target.weight)).toFixed(), difference_weight: actual.div(snapshot.nav_cny).minus(target.weight).toFixed(18),
      mapping_version_id: proof.row.id, listing_review_id: review.document.id };
  });
  const validUntil = new Date(Number(expiry / 1000n)).toISOString();
  if (instant(validUntil) <= instant(now)) throw new Error("REFERENCE_NOT_READY");
  return { plan_id: plan.id, plan_hash: plan.content_hash, valid_until: validUntil,
    basis: "arithmetic_difference_not_trade_recommendation" as const, rows, outside_target_value_cny: new Decimal(snapshot.nav_cny).minus(allocated).toFixed() };
}

/** No scheduling, valuation calculation, reconciliation mutation or trading occurs on this read. */
export function getInvestorHoldings(db: Database.Database, actor: Actor, now = new Date().toISOString(), options: AttachmentOptions = {}): InvestorHoldings {
  return db.transaction(() => {
    const accounts = getInvestorAccountWorkspace(db, actor, now), link = accounts.link?.document.portfolio_id ? accounts.link : null;
    const book = accounts.books.find(row => row.id === link?.document.portfolio_id);
    const result: InvestorHoldings = { schema_version: "investor-holdings-v1", workspace_id: accounts.workspace_id, workspace_revision: accounts.workspace_revision,
      checked_at: now, portfolio_id: book?.id ?? null, link_id: link?.id ?? null, link_version: link?.version ?? null, ledger_revision: book?.ledger_revision ?? null,
      read_only: accounts.read_only, status: book ? "evidence_required" : "not_linked", gaps: [], snapshot: null, comparison: null,
      live_advice_eligible: false, execution_authorized: false };
    const finish = () => investorHoldingsSchema.parse(result);
    if (!book) { result.gaps.push("ACCOUNT_BOOK_NOT_LINKED"); return finish(); }
    if (!accounts.accounts.length) { result.gaps.push("ACCOUNT_BOOK_EMPTY"); return finish(); }
    const size = db.prepare(`SELECT count(DISTINCT a.id) n,COALESCE(sum(a.byte_size),0) bytes FROM reconciliation_runs r
      JOIN attachments a ON a.id=r.attachment_id WHERE r.portfolio_id=? AND r.id IN
      (SELECT r2.id FROM reconciliation_runs r2 WHERE r2.portfolio_id=? AND r2.account_id=r.account_id ORDER BY ${reconciliationReadOrderSql} LIMIT 1)`).get(book.id, book.id) as { n: number; bytes: number };
    const events = db.prepare("SELECT count(*) n FROM ledger_events WHERE portfolio_id=?").get(book.id) as { n: number };
    if (size.bytes > 16 * 1024 * 1024 || events.n > 10000) { result.gaps.push("HOLDINGS_CAPACITY_REVIEW_REQUIRED"); return finish(); }
    const reconciliations: NonNullable<InvestorHoldings["snapshot"]>["reconciliations"] = [];
    for (const account of accounts.accounts) try { reconciliations.push(readInvestorReconciliation(db, actor, book.id, account.id, book.ledger_revision, now, options)); }
    catch (error) { const reason = gap(error); if (!result.gaps.includes(reason)) result.gaps.push(reason); }
    if (result.gaps.length) return finish();
    const valuation = db.prepare(`SELECT * FROM valuation_runs WHERE portfolio_id=? ORDER BY
      substr(cutoff_at,1,19) DESC,substr(replace(substr(cutoff_at,21,6),'Z','')||'000000',1,6) DESC,
      substr(created_at,1,19) DESC,substr(replace(substr(created_at,21,6),'Z','')||'000000',1,6) DESC,id DESC LIMIT 1`).get(book.id) as Valuation | undefined;
    if (!valuation) { result.gaps.push("VALUATION_REQUIRED"); return finish(); }
    try {
      if (valuation.quality !== "complete" || valuation.nav_cny === null) throw new Error("VALUATION_NOT_COMPLETE");
      if (!new Decimal(valuation.nav_cny).gt(0)) throw new Error("VALUATION_NONPOSITIVE_NAV");
      const manifest = parseStrictJson(valuation.market_manifest) as { mode: string };
      if (manifest.mode !== "restated" || valuation.ledger_revision !== book.ledger_revision || instant(valuation.created_at) > instant(now)
        || instant(valuation.cutoff_at) > instant(valuation.created_at)) throw new Error("VALUATION_NOT_CURRENT");
      const items = db.prepare("SELECT * FROM valuation_items WHERE run_id=? ORDER BY id LIMIT 2001").all(valuation.id) as Item[];
      if (items.length > 2000) throw new Error("HOLDINGS_CAPACITY_REVIEW_REQUIRED");
      const quality = parseStrictJson(valuation.issues_json) as { codes: unknown[]; known_partial_cny: string; complete_nav_available: boolean };
      if (!quality || canonical(Object.keys(quality).sort()) !== canonical(["codes", "complete_nav_available", "known_partial_cny"])
        || !Array.isArray(quality.codes) || quality.codes.length || quality.complete_nav_available !== true
        || !new Decimal(quality.known_partial_cny).eq(valuation.nav_cny) || valuationFreshness(db, valuation, book.ledger_revision).length) throw new Error("VALUATION_EVIDENCE_INVALID");
      if (reconciliations.some(row => instant(row.cutoff_at) < instant(valuation.cutoff_at))) throw new Error("VALUATION_CUTOFF_NOT_RECONCILED");
      const components = compose(db, items, new Set(accounts.accounts.map(row => row.id)), valuation.nav_cny);
      result.snapshot = { valuation_id: valuation.id, evidence_hash: hash({ valuation, items, reconciliations }), cutoff_at: valuation.cutoff_at,
        created_at: valuation.created_at, nav_cny: valuation.nav_cny, mode: "restated", basis: "owner_supplied_statements_not_provider_verified",
        account_sync: "recorded_facts_only_not_realtime", reconciliations, components };
      result.status = "verified_as_of"; investorHoldingsSchema.parse(result);
    } catch (error) { result.snapshot = null; result.status = "evidence_required"; result.gaps.push(gap(error)); return finish(); }
    try { result.comparison = targetComparison(db, actor, result, now); }
    catch (error) { result.gaps.push(error instanceof Error && error.message.startsWith("REFERENCE_") ? gap(error) : "REFERENCE_EVIDENCE_INVALID"); }
    return finish();
  })();
}
