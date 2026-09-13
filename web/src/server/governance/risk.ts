import type Database from "better-sqlite3";
import { amount, Decimal, exact } from "../ledger/decimal";
import { canonical, getActiveLedgerEvents, hash, revision } from "../ledger/service";
import { readJsonAttachment } from "../ledger/attachments";
import { capabilitiesSchema, type Policy } from "./schemas";
import { activation, verifyGateEvidence, type GovernanceActor, type GovernanceOptions } from "./core";
import { isGovernanceClientError } from "./errors";
import { valuationFreshness } from "../valuation-freshness";
import { ledgerFactQualityAt } from "../ledger/fact-quality-db";
import { verifiedMarketSource } from "../market-source";
import { verifiedPriceCalendarSession } from "../market-price-source";
import { reviewedListingAt } from "../listing-reviews/service";
import { readEvaluationListingBoundary, type EvaluationListingBoundary } from "../evaluation/listing-boundary";
import { referenceInstant } from "../market-references/service";

export interface ProposalRow { id: string; portfolio_id: string; environment: string; policy_version_id: string; strategy_version_id: string; ledger_revision: number; market_manifest: string; input_hash: string; expires_at: string; created_at: string }
export interface ItemRow { id: string; proposal_id: string; account_id: string; listing_id: string; side: "buy" | "sell"; currency: string; quantity: string; limit_price: string; estimated_fees: string }
export interface Publication { scope: string; batch_id: string; manifest_hash: string; revision: number; published_at: string }
export interface Listing { id: string; instrument_id: string; market: "CN" | "HK" | "US"; currency: string; quantity_step: string | null; price_step: string | null; status: string; asset_class: string; index_id: string | null; exposure_json: string; verified_at: string | null; review: { id: string; revision: number; content_hash: string; proof_hash: string; identity_hash: string; source_id: string; source_hash: string; known_at: string; review_until: string; review_basis: string } }
export interface Capability { rules_json: string; evidence_id: string; approved_by: string }
export interface Observation { id: string; source_id: string; listing_id: string | null; series_key: string; revision_id: string; value: string; unit: string; observed_at: string; published_at: string | null; ingested_at: string; price_basis: string; provenance: string; time_precision: string; source_timezone: string }
export interface Balance { account_id: string; currency: string; ledger_account: string; balance: string }
export interface Position { account_id: string; listing_id: string; currency: string; quantity: string; cost_known: number }
export interface SecurityTransit extends Omit<Position, "account_id"> { transfer_event_id: string; source_account_id: string; target_account_id: string }
export interface Reservation { id: string; proposal_item_id: string; account_id: string; currency: string; listing_id: string; side: string; amount: string; quantity: string; row_version: number }
export interface ProposalContext { activation_id: string; valuation_id: string; publications: Publication[]; ai_run_id?: string }
export interface RiskResult { status: "pass" | "blocked"; input_hash: string; checks: { code: string; detail?: string }[]; budgets: { item_id: string; account_id: string; currency: string; side: "buy" | "sell"; amount: string; quantity: string }[] }
/** Callers pass only active reservations; this is a balance calculation, not trading permission. */
export function availableResources(balances: readonly Balance[], positions: readonly Position[], reservations: readonly Reservation[]) {
  const available = new Map<string, Decimal>(), sellable = new Map<string, Decimal>();
  for (const balance of balances) {
    const key = `${balance.account_id}:${balance.currency}`, value = amount(balance.balance);
    if (balance.ledger_account === "cash_settled") available.set(key, (available.get(key) ?? amount("0")).add(value));
    if (["trade_payable", "other_liability", "dividend_tax_payable"].includes(balance.ledger_account)) {
      if (value.gt(0)) throw new Error("INVALID_LEDGER_LIABILITY");
      available.set(key, (available.get(key) ?? amount("0")).add(value));
    }
    if (balance.ledger_account === "cash_hold") { if (value.lt(0)) throw new Error("INVALID_CASH_HOLD"); available.set(key, (available.get(key) ?? amount("0")).sub(value)); }
    if (balance.ledger_account === "trade_receivable" && value.lt(0)) available.set(key, (available.get(key) ?? amount("0")).add(value));
  }
  for (const position of positions) sellable.set(`${position.account_id}:${position.listing_id}`, amount(position.quantity));
  for (const row of reservations) {
    const key = row.side === "buy" ? `${row.account_id}:${row.currency}` : `${row.account_id}:${row.listing_id}`;
    const map = row.side === "buy" ? available : sellable;
    map.set(key, (map.get(key) ?? amount("0")).sub(amount(row.side === "buy" ? row.amount : row.quantity)));
  }
  return { available, sellable };
}
/** In-transit securities remain source-owned exposure, never available shares. */
export function ownedSecurityPositions(positions: readonly Position[], transits: readonly SecurityTransit[]): Position[] {
  return [...positions, ...transits.map(row => ({ account_id: row.source_account_id, listing_id: row.listing_id, currency: row.currency, quantity: row.quantity, cost_known: row.cost_known }))];
}
export function loadProposal(db: Database.Database, portfolio: string, id: string): { proposal: ProposalRow; items: ItemRow[]; context: ProposalContext } {
  const proposal = db.prepare("SELECT * FROM proposals WHERE id=? AND portfolio_id=?").get(id, portfolio) as ProposalRow | undefined;
  if (!proposal || proposal.environment !== "actual") throw new Error("PROPOSAL_OUT_OF_SCOPE");
  return { proposal, items: db.prepare("SELECT * FROM proposal_items WHERE proposal_id=? ORDER BY id").all(id) as ItemRow[], context: JSON.parse(proposal.market_manifest) as ProposalContext };
}
export function currentPublications(db: Database.Database, policy: Policy, now: string, portfolioId?: string): Publication[] {
  const scopes = [...new Set([...Object.values(policy.price_scope_by_market), policy.fx_scope])].sort();
  const rows: Publication[] = [];
  for (const scope of scopes) {
    const row = db.prepare("SELECT p.*,b.validation_json FROM market_publications p JOIN market_batches b ON b.id=p.batch_id WHERE p.scope=?").get(scope) as (Publication & { validation_json: string }) | undefined;
    if (!row) { if (Object.values(policy.price_scope_by_market).includes(scope)) throw new Error("MARKET_PUBLICATION_MISSING"); else continue; }
    try {
      const source = verifiedMarketSource(db, row.batch_id, now);
      if (source.mode === "provider_observed" && source.provider === "longport" && source.portfolio_id !== portfolioId) throw new Error("PRIVATE_PRICE_SOURCE_OUT_OF_SCOPE");
    } catch { throw new Error("ACTUAL_DATA_NOT_VERIFIED"); }
    if (marketTimeKey(row.published_at) > marketTimeKey(now)) throw new Error("FUTURE_MARKET_PUBLICATION");
    rows.push({ scope: row.scope, batch_id: row.batch_id, manifest_hash: row.manifest_hash, revision: row.revision, published_at: row.published_at });
  }
  return rows;
}
export function requireValuation(db: Database.Database, portfolio: string, id: string, policy: Policy, publications: Publication[], now: string) {
  const row = db.prepare("SELECT * FROM valuation_runs WHERE id=? AND portfolio_id=?").get(id, portfolio) as { id: string; ledger_revision: number; market_manifest: string; cutoff_at: string; quality: string; nav_cny: string | null; created_at: string } | undefined;
  if (!row || row.quality !== "complete" || !row.nav_cny || !amount(row.nav_cny).gt(0) || row.ledger_revision !== revision(db, portfolio)) throw new Error("CURRENT_COMPLETE_VALUATION_REQUIRED");
  if (row.cutoff_at > now || row.created_at > now || (Date.parse(now) - Date.parse(row.cutoff_at)) / 1000 > policy.execution.max_valuation_age_seconds) throw new Error("VALUATION_STALE");
  const manifest = JSON.parse(row.market_manifest) as { publications?: Record<string, Publication | null> };
  if (!manifest.publications || publications.some(publication => canonical(manifest.publications?.[publication.scope]) !== canonical(publication))) throw new Error("VALUATION_MARKET_CHANGED");
  if (valuationFreshness(db, row, revision(db, portfolio)).length) throw new Error("CURRENT_COMPLETE_VALUATION_REQUIRED");
  for (const event of getActiveLedgerEvents(db, portfolio)) {
    if (Date.parse(event.effective_at) > Date.parse(row.cutoff_at) || (event.time_precision === "date" && event.effective_at >= row.cutoff_at.slice(0, 10))) throw new Error("VALUATION_NOT_CURRENT");
  }
  return row;
}
export function validateAccount(db: Database.Database, portfolio: string, accountId: string, policy: Policy, now: string): void {
  const account = db.prepare("SELECT * FROM accounts WHERE id=? AND portfolio_id=?").get(accountId, portfolio) as { status: string } | undefined;
  if (!account || !policy.account_ids.includes(accountId)) throw new Error("ACCOUNT_NOT_AUTHORIZED");
  if (account.status !== "active") throw new Error("ACCOUNT_RECONCILIATION_REQUIRED");
  const matched = db.prepare("SELECT json_extract(result_json,'$.cutoff_at') AS cutoff_at FROM reconciliation_runs WHERE account_id=? AND portfolio_id=? AND status='matched' ORDER BY cutoff_at DESC LIMIT 1").get(accountId, portfolio) as { cutoff_at: string } | undefined;
  const unresolved = db.prepare("SELECT i.id FROM reconciliation_issues i JOIN reconciliation_runs r ON r.id=i.run_id WHERE r.account_id=? AND i.status='open' LIMIT 1").get(accountId);
  if (!matched || unresolved || matched.cutoff_at > now || (Date.parse(now) - Date.parse(matched.cutoff_at)) / 1000 > policy.execution.max_reconciliation_age_seconds) throw new Error("ACCOUNT_RECONCILIATION_REQUIRED");
  const quality = ledgerFactQualityAt(db, portfolio, now, now, "restated");
  if (quality.dividends.some(row => row.account_id === accountId && (row.nav_quality !== "complete" || row.performance_quality !== "complete"))
    || quality.corporate_actions.some(row => row.account_id === accountId && row.status !== "resolved")) throw new Error("ACCOUNT_RECONCILIATION_REQUIRED");
}
function reviewTime(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) throw new Error("INVALID_CLOCK");
  const normalized = `${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z`;
  referenceInstant(normalized); return normalized;
}
function listing(db: Database.Database, id: string, policy: Policy, now: string, portfolio: string, knowledgeAt = now, reviewSequenceWatermark?: number): Listing {
  if (!policy.listing_ids.includes(id)) throw new Error("LISTING_NOT_AUTHORIZED");
  const checkedAt = reviewTime(now), knowledge = reviewTime(knowledgeAt);
  const proof = reviewedListingAt(db, { portfolio_id: portfolio, listing_id: id, knowledge_at: knowledge, now: checkedAt, review_sequence_watermark: reviewSequenceWatermark });
  if (proof.quality !== "complete" || !proof.row || !proof.document || !proof.proof_hash) throw new Error(proof.issues[0] ?? "LISTING_REVIEW_MISSING");
  if (knowledge !== checkedAt || reviewSequenceWatermark !== undefined) {
    const current = reviewedListingAt(db, { portfolio_id: portfolio, listing_id: id, knowledge_at: checkedAt, now: checkedAt });
    if (current.quality !== "complete") throw new Error(current.issues[0] ?? "LISTING_REVIEW_MISSING");
    if (current.proof_hash !== proof.proof_hash) throw new Error("LISTING_REVIEW_CHANGED");
  }
  const d = proof.document, facts = d.facts;
  // Explicit whole-fund classification is not constituent-level look-through evidence.
  return { id, instrument_id: d.identity_snapshot.instrument_id, market: d.identity_snapshot.market, currency: d.identity_snapshot.currency,
    quantity_step: facts.quantity_step, price_step: facts.price_step, status: facts.lifecycle_status, asset_class: facts.instrument_kind,
    index_id: facts.risk_classification.index_id, exposure_json: canonical({ region: facts.risk_classification.region, sector: facts.risk_classification.sector }), verified_at: d.known_at,
    review: { id: d.id, revision: d.revision, content_hash: proof.row.content_hash, proof_hash: proof.proof_hash, identity_hash: d.identity_hash, source_id: d.source_id, source_hash: d.source_hash,
      known_at: d.known_at, review_until: d.review_until, review_basis: d.review_basis } };
}
function capability(db: Database.Database, account: string, listing: Listing, side: string, now: string) {
  const row = db.prepare("SELECT * FROM account_capabilities WHERE account_id=? AND market=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?)").get(account, listing.market, now, now) as Capability | undefined;
  if (!row || !row.evidence_id || !row.approved_by) throw new Error("ACCOUNT_CAPABILITY_MISSING");
  const rules = capabilitiesSchema.safeParse(JSON.parse(row.rules_json));
  if (!rules.success || !rules.data.currencies.includes(listing.currency) || !rules.data.listing_ids.includes(listing.id) || (side === "buy" ? !rules.data.buy : !rules.data.sell)) throw new Error("ACCOUNT_CAPABILITY_MISSING");
  return row;
}
function marketTimeKey(value: string, subtractSeconds = 0): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(value);
  if (!match || value.startsWith("0000")) throw new Error("MARKET_OBSERVATION_TIME_INVALID");
  const millis = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== match[1] || !Number.isSafeInteger(subtractSeconds)) throw new Error("MARKET_OBSERVATION_TIME_INVALID");
  // Trim insignificant zeros, not precision: lexicographic order then equals exact UTC order.
  return `${new Date(millis - subtractSeconds * 1000).toISOString().slice(0, 19)}.${(match[2] ?? "").replace(/0+$/, "")}`;
}
function observation(db: Database.Database, publications: Publication[], scope: string | undefined, key: string, metric: string, policy: Policy, now: string, portfolioId?: string) {
  const publication = publications.find(row => row.scope === scope);
  if (!publication) throw new Error("MARKET_PUBLICATION_MISSING");
  // A provider series name is not a listing ID. Never match one security through another's alias.
  const fx = metric === "fx_cny_per_unit";
  const candidates = db.prepare(`SELECT o.* FROM market_batch_members m JOIN market_observations o ON o.id=m.observation_id
    WHERE m.batch_id=? AND ${fx ? "o.series_key=? AND o.listing_id IS NULL" : "o.listing_id=?"} AND o.metric=?`).iterate(publication.batch_id, key, metric) as Iterable<Observation>;
  const known = marketTimeKey(now), staleBefore = marketTimeKey(now, policy.execution.max_price_age_seconds);
  let row: Observation | undefined, best: string[] = [], ambiguous = false;
  const observedKey = (value: Observation) => marketTimeKey(value.time_precision === "date" ? `${value.observed_at}T00:00:00Z` : value.observed_at);
  const equivalent = (value: Observation) => canonical([value.source_id, value.revision_id, value.value, value.unit, value.price_basis, value.provenance, value.time_precision, value.source_timezone]);
  for (const candidate of candidates) {
    const received = marketTimeKey(candidate.ingested_at);
    if (received > known) continue;
    const order = [observedKey(candidate), marketTimeKey(candidate.published_at ?? candidate.ingested_at), received];
    const different = row ? order.findIndex((value, index) => value !== best[index]) : 0;
    if (!row || (different >= 0 && order[different] > best[different])) { row = candidate; best = order; ambiguous = false; }
    else if (different === -1) { ambiguous ||= equivalent(candidate) !== equivalent(row); if (candidate.id < row.id) row = candidate; }
  }
  if (ambiguous) throw new Error("MARKET_OBSERVATION_AMBIGUOUS");
  if (!row || row.provenance === "reconstructed" || best[0] > known || (row.published_at && marketTimeKey(row.published_at) > known) || best[0] < staleBefore) throw new Error(`MARKET_OBSERVATION_UNAVAILABLE:${metric}`);
  if ((metric === "close" && row.price_basis !== "unadjusted") || (metric !== "close" && row.price_basis !== "not_applicable")) throw new Error("MARKET_PRICE_BASIS_INVALID");
  if (row.time_precision === "date") {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: row.source_timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
    const part = (type: string) => parts.find(value => value.type === type)!.value;
    if (row.observed_at >= `${part("year")}-${part("month")}-${part("day")}`) throw new Error(`MARKET_OBSERVATION_UNAVAILABLE:${metric}`);
  }
  if (metric === "close" && row.source_id === "provider:longport:prices") {
    if (!portfolioId || row.observed_at !== verifiedPriceCalendarSession(db, publication.batch_id, portfolioId, key, now, now)) throw new Error("PRICE_CALENDAR_UNVERIFIED");
  }
  return row;
}
export function checkRisk(db: Database.Database, actor: GovernanceActor, portfolio: string, proposalId: string, options: GovernanceOptions, now: string, excludeOwnReservations = false): RiskResult {
  const { proposal, items, context } = loadProposal(db, portfolio, proposalId);
  return evaluateRisk(db, actor, proposal, items, context, options, now, excludeOwnReservations);
}
export { listing as evaluationListing, capability as evaluationCapability, observation as evaluationObservation };

/** Read-only calculation; virtual empty-item evaluations must also verify their explicit target input scope. */
export function evaluateRisk(db: Database.Database, actor: GovernanceActor, proposal: ProposalRow, items: ItemRow[], context: ProposalContext, options: GovernanceOptions, now: string, excludeOwnReservations = false,
  reviewBoundary?: EvaluationListingBoundary): RiskResult {
  const portfolio = proposal.portfolio_id;
  const state: Record<string, unknown> = { proposal, items, context, ledger_revision: revision(db, portfolio) };
  const budgets: RiskResult["budgets"] = [];
  try {
    // Preserve sub-millisecond input boundaries when the legacy governance clock normalized the same instant.
    const inputNow = reviewTime(options.now && Date.parse(options.now) === Date.parse(now) ? options.now : now);
    if (reviewBoundary) {
      if (reviewBoundary.portfolio_id !== portfolio) throw new Error("LISTING_REVIEW_OUT_OF_SCOPE");
      try {
        const boundary = readEvaluationListingBoundary(db, { id: reviewBoundary.cycle_id, portfolio_id: portfolio, knowledge_at: reviewBoundary.knowledge_at });
        if (canonical(boundary) !== canonical(reviewBoundary)) throw new Error("LISTING_REVIEW_EVIDENCE_INVALID");
      } catch { throw new Error("LISTING_REVIEW_EVIDENCE_INVALID"); }
      state.listing_review_boundary = reviewBoundary;
    }
    if (proposal.expires_at <= now) throw new Error("PROPOSAL_EXPIRED");
    if (proposal.ledger_revision !== state.ledger_revision) throw new Error("PROPOSAL_LEDGER_CHANGED");
    const active = activation(db, portfolio, context.activation_id, now), policy = active.policy.value, strategy = active.strategy.value;
    const riskListing = (id: string) => listing(db, id, policy, inputNow, portfolio, reviewBoundary?.knowledge_at ?? inputNow, reviewBoundary?.watermark_sequence);
    state.activation = active;
    if (active.policy.id !== proposal.policy_version_id || active.strategy.id !== proposal.strategy_version_id) throw new Error("GOVERNANCE_VERSION_CHANGED");
    verifyGateEvidence(db, actor, portfolio, JSON.parse(active.row.evidence_json).gate_attachments, active.policy, active.strategy, options, now);
    const publications = currentPublications(db, policy, inputNow, portfolio); state.publications = publications;
    if (canonical(publications) !== canonical(context.publications)) throw new Error("PROPOSAL_MARKET_CHANGED");
    const valuation = requireValuation(db, portfolio, context.valuation_id, policy, publications, now); state.valuation = valuation;
    const balances = db.prepare("SELECT a.account_id,a.currency,a.ledger_account,a.balance FROM account_projections a JOIN accounts b ON b.id=a.account_id WHERE b.portfolio_id=? ORDER BY a.account_id,a.currency,a.ledger_account").all(portfolio) as Balance[];
    const positions = db.prepare("SELECT p.account_id,p.listing_id,p.currency,p.quantity,p.cost_known FROM position_projections p JOIN accounts a ON a.id=p.account_id WHERE a.portfolio_id=? ORDER BY p.account_id,p.listing_id").all(portfolio) as Position[];
    const transits = db.prepare("SELECT p.transfer_event_id,p.source_account_id,p.target_account_id,p.listing_id,p.currency,p.quantity,p.cost_known FROM security_transit_projections p JOIN accounts a ON a.id=p.source_account_id WHERE a.portfolio_id=? ORDER BY p.transfer_event_id").all(portfolio) as SecurityTransit[];
    const reservations = db.prepare("SELECT * FROM reservations WHERE portfolio_id=? AND status='active' ORDER BY id").all(portfolio) as Reservation[];
    const ownItemIds = new Set(items.map(item => item.id));
    const countedReservations = reservations.filter(row => !excludeOwnReservations || !ownItemIds.has(row.proposal_item_id));
    state.balances = balances; state.positions = positions; state.security_transits = transits; state.reservations = countedReservations;
    state.accounts = db.prepare("SELECT id,status,row_version FROM accounts WHERE portfolio_id=? ORDER BY id").all(portfolio);
    state.capabilities = []; state.listings = []; state.observations = [];
    for (const accountId of policy.account_ids) validateAccount(db, portfolio, accountId, policy, now);
    const rates = new Map<string, Decimal>([["CNY", amount("1")]]);
    const fx = (currency: string): Decimal => {
      if (!rates.has(currency)) { const row = observation(db, publications, policy.fx_scope, `FX:${currency}`, "fx_cny_per_unit", policy, inputNow); if (row.unit !== "CNY_per_unit_currency" || !amount(row.value).gt(0)) throw new Error("INVALID_FX_RATE"); rates.set(currency, amount(row.value)); (state.observations as unknown[]).push(row); }
      return rates.get(currency)!;
    };
    for (const balance of balances) if (!amount(balance.balance).isZero() && !policy.account_ids.includes(balance.account_id)) throw new Error("ACCOUNT_SCOPE_INCOMPLETE");
    const { available, sellable } = availableResources(balances, positions, countedReservations);
    const projected = new Map<string, { value: Decimal; info: Listing }>();
    for (const position of ownedSecurityPositions(positions, transits).filter(row => !amount(row.quantity).isZero())) {
      if (!policy.account_ids.includes(position.account_id) || !position.cost_known || amount(position.quantity).lt(0)) throw new Error("POSITION_INPUT_INCOMPLETE");
      const info = riskListing(position.listing_id), price = observation(db, publications, policy.price_scope_by_market[info.market], info.id, "close", policy, inputNow, portfolio);
      if (position.currency !== info.currency || price.unit !== info.currency || !amount(price.value).gt(0)) throw new Error("MARKET_UNITS_INVALID");
      (state.listings as unknown[]).push(info); (state.observations as unknown[]).push(price);
      const value = amount(position.quantity).mul(amount(price.value)).mul(fx(position.currency));
      projected.set(info.id, { value: (projected.get(info.id)?.value ?? amount("0")).add(value), info });
    }
    // Pending approved buys already consume concentration and strategy budget, not just cash.
    for (const row of countedReservations.filter(row => row.side === "buy")) {
      const info = riskListing(row.listing_id);
      (state.listings as unknown[]).push(info);
      projected.set(info.id, { value: (projected.get(info.id)?.value ?? amount("0")).add(amount(row.amount).mul(fx(row.currency))), info });
    }
    let feesCny = amount("0"), newBuysCny = amount("0");
    const seen = new Set<string>();
    for (const item of items) {
      const key = `${item.account_id}:${item.listing_id}`;
      if (seen.has(key)) throw new Error("PROPOSAL_NOT_NETTED"); seen.add(key);
      if (!strategy.universe.includes(item.listing_id)) throw new Error("STRATEGY_UNIVERSE_MISMATCH");
      validateAccount(db, portfolio, item.account_id, policy, now);
      const info = riskListing(item.listing_id); (state.listings as unknown[]).push(info);
      const permission = capability(db, item.account_id, info, item.side, now); (state.capabilities as unknown[]).push(permission);
      readJsonAttachment(db, actor, portfolio, permission.evidence_id, { ...options, accountId: item.account_id });
      if (item.currency !== info.currency) throw new Error("INVALID_LISTING_CURRENCY");
      const quantity = amount(item.quantity), price = amount(item.limit_price), fee = amount(item.estimated_fees);
      if (!quantity.gt(0) || !price.gt(0) || fee.lt(0)) throw new Error("INVALID_PROPOSAL_AMOUNTS");
      if (!quantity.mod(amount(info.quantity_step)).isZero() || !price.mod(amount(info.price_step)).isZero()) throw new Error("INVALID_TRADING_INCREMENT");
      const read = (metric: string) => { const row = observation(db, publications, policy.price_scope_by_market[info.market], info.id, metric, policy, inputNow, portfolio); (state.observations as unknown[]).push(row); return row; };
      const close = read("close"), spread = read("spread_bps"), premium = read("premium_bps"), turnover = read("turnover"), volume = read("volume");
      if (close.unit !== info.currency || turnover.unit !== info.currency || volume.unit !== "shares" || spread.unit !== "bps" || premium.unit !== "bps" || !amount(close.value).gt(0) || !amount(volume.value).gt(0)) throw new Error("MARKET_UNITS_INVALID");
      if (price.sub(close.value).abs().div(close.value).mul(10000).gt(policy.execution.max_price_deviation_bps)) throw new Error("PRICE_DEVIATION_EXCEEDED");
      if (amount(spread.value).lt(0) || amount(spread.value).gt(policy.execution.max_spread_bps) || amount(premium.value).abs().gt(policy.execution.max_premium_bps) || amount(turnover.value).lt(policy.execution.min_turnover) || quantity.div(volume.value).gt(policy.execution.max_participation)) throw new Error("EXECUTION_LIQUIDITY_BLOCKED");
      const principal = price.mul(quantity), minimum = policy.execution.minimum_fee_by_currency[item.currency];
      if (minimum === undefined || fee.lt(Decimal.max(amount(minimum), principal.mul(policy.execution.fee_rate_bps).div(10000))) || fee.div(principal).mul(10000).gt(policy.execution.max_fee_bps)) throw new Error("FEE_BUDGET_INVALID");
      const unitFx = fx(item.currency), cash = principal.mul(amount("1").add(amount(policy.execution.price_buffer_bps).div(10000))).add(fee);
      if (cash.mul(unitFx).gt(policy.limits.max_order_cny)) throw new Error("ORDER_BUDGET_EXCEEDED");
      if (item.side === "buy") {
        const cashKey = `${item.account_id}:${item.currency}`, left = (available.get(cashKey) ?? amount("0")).sub(cash);
        if (left.lt(0)) throw new Error("INSUFFICIENT_AVAILABLE_CASH"); available.set(cashKey, left); newBuysCny = newBuysCny.add(cash.mul(unitFx));
      } else {
        const left = (sellable.get(key) ?? amount("0")).sub(quantity);
        if (left.lt(0)) throw new Error("INSUFFICIENT_AVAILABLE_SHARES"); sellable.set(key, left);
        // Net sell proceeds are not reusable buying power until actual settlement.
      }
      feesCny = feesCny.add(fee.mul(unitFx));
      const current = projected.get(item.listing_id)?.value ?? amount("0");
      const delta = quantity.mul(item.side === "buy" ? Decimal.max(price, amount(close.value)).mul(amount("1").add(amount(policy.execution.price_buffer_bps).div(10000))) : amount(close.value)).mul(unitFx);
      projected.set(item.listing_id, { value: item.side === "buy" ? current.add(delta) : current.sub(delta), info });
      budgets.push({ item_id: item.id, account_id: item.account_id, currency: item.currency, side: item.side, amount: item.side === "buy" ? exact(cash) : "0", quantity: item.quantity });
    }
    const denominator = amount(valuation.nav_cny).sub(feesCny);
    if (!denominator.gt(0)) throw new Error("NONPOSITIVE_POST_TRADE_NAV");
    const groups = new Map<string, Decimal>();
    for (const { value, info } of projected.values()) {
      if (value.lt(0)) throw new Error("NEGATIVE_TARGET_POSITION");
      const exposure = JSON.parse(info.exposure_json);
      for (const [dimension, group] of [["listing", info.id], ["index", info.index_id], ["market", info.market], ["region", exposure.region], ["sector", exposure.sector]]) {
        const key = `${dimension}:${group}`; groups.set(key, (groups.get(key) ?? amount("0")).add(value));
      }
    }
    const currencyValues = db.prepare("SELECT currency,value_cny FROM valuation_items WHERE run_id=? AND quality='complete'").all(context.valuation_id) as { currency: string; value_cny: string | null }[];
    if (!currencyValues.length) throw new Error("VALUATION_ITEMS_REQUIRED");
    for (const row of currencyValues) {
      if (row.value_cny === null) throw new Error("VALUATION_ITEMS_REQUIRED");
      const key = `currency:${row.currency}`; groups.set(key, (groups.get(key) ?? amount("0")).add(amount(row.value_cny)));
    }
    for (const item of items) {
      const key = `currency:${item.currency}`;
      groups.set(key, (groups.get(key) ?? amount("0")).sub(amount(item.estimated_fees).mul(fx(item.currency))));
    }
    for (const [key, value] of groups) {
      const dimension = key.split(":")[0] as "listing" | "index" | "market" | "currency" | "region" | "sector";
      if (value.div(denominator).gt(policy.limits[`${dimension}_weight`])) throw new Error(`CONCENTRATION_LIMIT_EXCEEDED:${dimension}`);
    }
    const strategyExposure = [...projected.entries()].filter(([id]) => strategy.universe.includes(id)).reduce((sum, [, row]) => sum.add(row.value), amount("0"));
    if (strategyExposure.div(denominator).gt(Decimal.min(amount(strategy.budget_weight), amount(policy.limits.strategy_weight))) || newBuysCny.div(denominator).gt(strategy.budget_weight)) throw new Error("STRATEGY_BUDGET_EXCEEDED");
    let availableCny = amount("0");
    for (const [key, value] of available) { const currency = key.slice(key.lastIndexOf(":") + 1); availableCny = availableCny.add(Decimal.max(value, amount("0")).mul(fx(currency))); }
    if (availableCny.div(denominator).lt(policy.limits.min_cash_weight)) throw new Error("MINIMUM_CASH_BREACHED");
    if (policy.ai_mode === "required_block_on_missing") {
      const ai = db.prepare("SELECT * FROM ai_runs WHERE id=? AND portfolio_id=? AND status='valid' AND created_at<=?").get(context.ai_run_id ?? "", portfolio, now) as { input_manifest: string; quality_json: string } | undefined;
      if (!ai || JSON.parse(ai.input_manifest)?.proposal_input_hash !== proposal.input_hash || JSON.parse(ai.quality_json)?.unresolved_fact_conflicts !== 0) throw new Error("AI_REVIEW_REQUIRED");
      state.ai_review = ai;
    }
    return { status: "pass", input_hash: hash(state), checks: [{ code: "G-01_POLICY" }, { code: "G-02_ACCOUNTS" }, { code: "G-03_INPUTS" }, { code: "G-04_STRATEGY" }, { code: "DETERMINISTIC_RISK_PASS" }], budgets };
  } catch (error) {
    const code = error instanceof Error && isGovernanceClientError(error.message) ? error.message : "RISK_INPUT_INVALID";
    return { status: "blocked", input_hash: hash({ ...state, blocked: code }), checks: [{ code }], budgets: [] };
  }
}
