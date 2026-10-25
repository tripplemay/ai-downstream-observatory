import { Decimal as LedgerDecimal } from "../ledger/decimal";
import { hash } from "../ledger/service";
import { ContinuousMarket, economicDate, economicFact, economicInstant, economicLocal, economicMidnight, economicStamp, economicText, requireEconomic,
  type ContinuousDataset, type Settlement } from "./continuous-market";
import { continuousPerformance } from "./continuous-performance";
import { OrderReviews, type ReviewLinks } from "./order-reviews";
import { CashIntents, type CashIntentLinks } from "./cash-intents";
import { prepareSettledCashBuys } from "./settled-funding";

type Decimal = LedgerDecimal;

type ObjectValue = Record<string, unknown>;
export type ContinuousParameters = { schema_version: string; weights: Record<string, string>; roles: Record<string, string>; rebalance: string;
  tolerance: { absolute_cny: string; weight: string }; class_drift_threshold: string; minimum_days_between_rebalances: number;
  contribution_mode: string; order_expiry: string };
export type ContinuousPlan = { schema_version: string; window: { start: string; end: string }; evaluation_timezone: string;
  funding_policy?: unknown;
  parameters: ContinuousParameters; initial_capital_cny: string; contributions: { at: string; amount_cny: string }[]; decision_times: string[];
  execution: { model: string; settlement_model: string; sale_proceeds: string; max_fx_age_seconds: number; slippage_bps: string;
    minimum_fee_cny: string; commission_bps: string; fx_bps: string; cash_quantum: string;
    buy_price_buffer_bps?: string; buy_fx_buffer_bps?: string; order_action_policy?: string; buy_funding_policy?: string }; tax_coverage: string };
type Order = ReviewLinks & CashIntentLinks & { id: string; listing: string; side: "buy" | "sell"; quantity: Decimal; budget: Decimal; cashFloor: Decimal; lockedAtDecision: Decimal;
  decision: bigint; expiry: bigint; execute?: bigint; dependencies: string[]; state: string;
  priceCap?: Decimal; fxCap?: Decimal; worstTotal?: Decimal };
type StockLot = { order: string; listing: string; quantity: Decimal; at: bigint; evidence: Settlement };
type Sale = { order: string; amount: Decimal; at: bigint; evidence: Settlement };
type Delta = { listing_id: string; target_cny: string; current_cny: string; difference_cny: string; within_tolerance: boolean; price_mark: ObjectValue };
type Quote = [Decimal, Decimal, string, string | null, ObjectValue];
const ordered = <T>(map: Map<string, T>) => Object.fromEntries([...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const minTime = (a: bigint, b: bigint) => a < b ? a : b;
const failure = (error: unknown) => { if (!(error instanceof Error)) throw error; return error.message; };

class ClockQueue {
  private heap: bigint[] = [];
  private seen = new Set<bigint>();
  constructor(private start: bigint, private end: bigint) {}
  add(at: bigint) {
    if (at < this.start || at > this.end || this.seen.has(at)) return;
    this.seen.add(at); let index = this.heap.length; this.heap.push(at);
    while (index > 0) { const parent = (index - 1) >> 1; if (this.heap[parent] <= at) break; this.heap[index] = this.heap[parent]; index = parent; }
    this.heap[index] = at;
  }
  pop() {
    const value = this.heap[0], last = this.heap.pop();
    if (this.heap.length) {
      let index = 0;
      while (index * 2 + 1 < this.heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.heap.length && this.heap[child + 1] < this.heap[child]) child++;
        if (this.heap[child] >= last!) break;
        this.heap[index] = this.heap[child]; index = child;
      }
      this.heap[index] = last!;
    }
    return value;
  }
  get length() { return this.heap.length; }
}

/** Rebuild both economics and causal events from inputs, never from claimed result metrics. */
export function runContinuousEconomics(data: ContinuousDataset, plan: ContinuousPlan, releases: Map<bigint, Decimal>,
  options: { holdingBaseline?: boolean; researchPhase?: "train" | "validation" | "holdout" } = {}) {
  requireEconomic(options.holdingBaseline === undefined || typeof options.holdingBaseline === "boolean");
  const holdingBaseline = options.holdingBaseline === true;
  const research = options.researchPhase !== undefined;
  const settledFunding = research && plan.schema_version === "bounded-research-window-v4" || plan.schema_version === "investor-long-horizon-plan-v5";
  const Decimal = LedgerDecimal.clone({ precision: settledFunding ? 256 : 60 });
  const zero = () => new Decimal(0), sum = (values: Iterable<Decimal>) => [...values].reduce((a, b) => a.plus(b), zero());
  const reportedRatio = (n: Decimal, d: Decimal) => d.gt(0) ? economicText(new LedgerDecimal(n.toFixed()).div(d)) : null;
  const reviewable = settledFunding || research && plan.schema_version === "bounded-research-window-v3" || plan.schema_version === "investor-long-horizon-plan-v4";
  const actionAware = reviewable || research && plan.schema_version === "bounded-research-window-v2";
  const bounded = settledFunding || research || ["investor-long-horizon-plan-v3", "investor-long-horizon-plan-v4"].includes(plan.schema_version);
  requireEconomic(!research || ["train", "validation", "holdout"].includes(options.researchPhase!) && !holdingBaseline
    && releases.size === 0 && ["bounded-research-window-v1", "bounded-research-window-v2", "bounded-research-window-v3", "bounded-research-window-v4"].includes(plan.schema_version));
  const p = plan.parameters, ex = plan.execution, zone = plan.evaluation_timezone;
  requireEconomic(settledFunding ? ex.buy_funding_policy === "declare_sales_then_freeze_buy_from_settled_cash" : ex.buy_funding_policy === undefined);
  requireEconomic(reviewable ? ex.order_action_policy === "defer_known_else_cancel_batch_and_reassess"
    : actionAware ? ex.order_action_policy === "defer_known_scheduled_action_before_commit" : ex.order_action_policy === undefined);
  requireEconomic(p.schema_version === "research-fixed-rebalance-parameters-v2" && ex.model === (bounded ? "next_session_close_bounded_fixed_quantity" : "next_session_close_fixed_quantity")
    && ex.settlement_model === "explicit_market_calendar" && ex.sale_proceeds === "convert_to_cny_at_fill_then_settle");
  requireEconomic(["commission_bps", "minimum_fee_cny", "slippage_bps", "fx_bps"].every(key => economicFact(ex[key as "commission_bps"]).gte(0))
    && economicFact(ex.slippage_bps).lt(10000) && economicFact(ex.cash_quantum).gt(0));
  if (bounded) requireEconomic(ex.cash_quantum === "0.01" && [ex.buy_price_buffer_bps, ex.buy_fx_buffer_bps, ex.commission_bps, ex.fx_bps]
    .every(value => typeof value === "string" && economicFact(value).gte(0) && economicFact(value).lte(10000)));
  const market = new ContinuousMarket(data, ex.max_fx_age_seconds), start = economicInstant(plan.window.start), end = economicInstant(plan.window.end);
  requireEconomic(start < end && Object.keys(p.weights).sort().join() === Object.keys(p.roles).sort().join()
    && Object.keys(p.weights).every(key => market.assets.has(key) && ["growth", "defensive", "diversifier"].includes(p.roles[key]) && economicFact(p.weights[key]).gte(0)));
  const weights = new Map(Object.entries(p.weights).map(([key, value]) => [key, new Decimal(value)])), weightSum = sum(weights.values());
  requireEconomic(weightSum.gt(0) && weightSum.lte(1) && economicFact(p.class_drift_threshold).gt(0) && economicFact(p.class_drift_threshold).lte(1)
    && economicFact(p.tolerance.absolute_cny).gte(0) && economicFact(p.tolerance.weight).gte(0) && economicFact(p.tolerance.weight).lte(1)
    && Number.isInteger(p.minimum_days_between_rebalances) && p.minimum_days_between_rebalances >= 1 && p.minimum_days_between_rebalances <= 366);
  requireEconomic(["first_decision_each_year", "first_decision_each_half_year"].includes(p.rebalance));
  const clock = new ClockQueue(start, end), cash = new Map<string, Decimal>([["CNY", zero()]]), positions = new Map<string, Decimal>();
  const dividends = new Map<string, Decimal>(), payments = new Map<bigint, { currency: string; amount: Decimal; id: string }[]>();
  const pending: Order[] = [], stocks: StockLot[] = [], sales: Sale[] = [], orders = new Map<string, Order>(), slots = new Map<string, string>();
  const events: ObjectValue[] = [], curve: ObjectValue[] = [], flows: { at: bigint; amount: Decimal; before: Decimal }[] = [];
  const reviews = reviewable ? new OrderReviews(orders, events, p.weights) : null;
  const intents = settledFunding ? new CashIntents(orders, events, reviews!, hash({ parameters: p, execution: ex,
    decision_times: plan.decision_times, window: plan.window, ...(!research ? { funding_policy: plan.funding_policy } : {}) })) : null;
  const contributions = new Map<bigint, Decimal>();
  for (const flow of plan.contributions) {
    const at = economicInstant(flow.at), amount = new Decimal(flow.amount_cny);
    requireEconomic(amount.gt(0));
    if (start <= at && at <= end) contributions.set(at, (contributions.get(at) ?? zero()).plus(amount));
  }
  const initial = new Decimal(plan.initial_capital_cny).plus(contributions.get(start) ?? zero()); contributions.delete(start);
  requireEconomic(initial.gt(0)); cash.set("CNY", initial);
  let units = initial, locked = research ? zero() : initial, principal = initial, fundingPending = false, lastProposal: bigint | null = null;
  const lifecycle = { deferred: null as { first_deferred_at: string; last_deferred_at: string } | null };
  let fees = zero(), fxFees = zero(), slipFees = zero(), rounding = zero(), buys = zero(), sells = zero();
  const decisions = new Set(plan.decision_times.map(economicInstant).filter(at => start <= at && at <= end));
  const actions = new Map<bigint, ContinuousDataset["actions"]>();
  for (const at of [start, end, ...decisions, ...contributions.keys(), ...releases.keys()]) clock.add(at);
  for (const session of data.sessions) { clock.add(economicInstant(session.close_at)); clock.add(economicInstant(session.available_at)); }
  for (const row of data.observations) if (row.metric === "fx_cny_per_unit") clock.add(market.available(row));
  for (const action of data.actions) {
    const at = economicInstant(action.at);
    if (start <= at && at <= end) {
      const rows = actions.get(at) ?? []; rows.push(action); actions.set(at, rows); clock.add(at);
      if (action.pay_at) clock.add(economicInstant(action.pay_at));
    }
  }
  const cny = () => cash.get("CNY")!;
  const quoteFx = (currency: string, at: bigint): [Decimal, string | null] => {
    const [rate, id] = market.fx(currency, at); return [new Decimal(rate.toFixed()), id];
  };
  const fx = (currency: string, at: bigint) => quoteFx(currency, at)[0];
  const mark = (listing: string, at: bigint, decision = false): [Decimal, string, ObjectValue] => {
    const [source, id] = market.price(listing, at, decision), raw = new Decimal(source.toFixed()), observed = economicInstant(market.observations.get(id)!.observed_at);
    let price = raw; const applied: string[] = [];
    for (const action of data.actions.filter(row => row.listing_id === listing && observed < economicInstant(row.at) && economicInstant(row.at) <= at)
      .sort((a, b) => economicInstant(a.at) < economicInstant(b.at) ? -1 : economicInstant(a.at) > economicInstant(b.at) ? 1
        : a.type !== b.type ? a.type === "split" ? -1 : 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      requireEconomic(economicInstant(action.published_at) <= at && (data.mode !== "actual_replay" || economicInstant(action.ingested_at!) <= at), "CORPORATE_ACTION_CARRY_NOT_KNOWN:" + action.id);
      price = action.type === "split" ? price.div(action.ratio!) : price.minus(action.gross_per_unit!);
      requireEconomic(price.gt(0), "NONPOSITIVE_EX_ACTION_CARRY_MARK:" + listing); applied.push(action.id);
    }
    return [price, id, { listing_id: listing, price_observation_id: id, quote_observed_at: economicStamp(observed),
      mark_kind: applied.length ? "theoretical_ex_action_carry" : "observed_close", raw_price: economicText(raw), mark_price: economicText(price), action_ids: applied }];
  };
  const nav = (at: bigint, decision = false, carry?: ObjectValue[]) => {
    let value = sum([...cash].filter(([, v]) => !v.isZero()).map(([currency, amount]) => amount.times(fx(currency, at))));
    value = value.plus(sum([...dividends].filter(([, v]) => !v.isZero()).map(([currency, amount]) => amount.times(fx(currency, at))))).plus(sum(sales.map(row => row.amount)));
    for (const [listing, quantity] of positions) if (!quantity.isZero()) {
      const [price, , evidence] = mark(listing, at, decision);
      if (carry && (evidence.action_ids as string[]).length) carry.push(evidence);
      value = value.plus(quantity.times(price).times(fx(market.assets.get(listing)!.currency, at)));
    }
    return value;
  };
  const cost = (side: string, quantity: Decimal, price: Decimal, currency: string, at: bigint, spotOverride?: Decimal) => {
    price = new Decimal(price.toFixed());
    const spot = spotOverride ?? fx(currency, at), slip = new Decimal(ex.slippage_bps).div(10000), fillPrice = price.times(side === "buy" ? slip.plus(1) : new Decimal(1).minus(slip));
    requireEconomic(fillPrice.gt(0), "NONPOSITIVE_ORDER_COST");
    const principal = quantity.times(fillPrice).times(spot), fee = Decimal.max(ex.minimum_fee_cny, principal.times(ex.commission_bps).div(10000));
    const fxFee = currency === "CNY" ? zero() : principal.times(ex.fx_bps).div(10000);
    const raw = side === "buy" ? principal.plus(fee).plus(fxFee) : principal.minus(fee).minus(fxFee);
    const amount = raw.div(ex.cash_quantum).toDecimalPlaces(0, bounded && side === "buy" ? Decimal.ROUND_CEIL : Decimal.ROUND_HALF_EVEN).times(ex.cash_quantum);
    requireEconomic(amount.gt(0), "ORDER_BELOW_CASH_PRECISION");
    return { amount, principal, fee, fxFee, fillPrice, spot, slipCost: quantity.times(price).times(spot).times(slip),
      rounding: side === "buy" ? amount.minus(raw) : raw.minus(amount) };
  };
  const reserved = () => sum(pending.filter(row => row.side === "buy" && row.state === "scheduled").map(row => row.budget));
  const remove = <T>(items: T[], item: T) => { const index = items.indexOf(item); if (index >= 0) items.splice(index, 1); };
  const finish = (order: Order, state: string, at: bigint, reason?: string, extra: ObjectValue = {}) => {
    order.state = state; remove(pending, order);
    if (reason) events.push({ type: state === "expired" ? "order_expired" : "execution_skipped", at: economicStamp(at), order_id: order.id,
      listing_id: order.listing, side: order.side, quantity: economicText(order.quantity), reason, ...extra });
    if (reason && ["skipped", "expired"].includes(state) && !("cancellation_review_id" in extra)) reviews?.failed(order, at);
  };
  const nextClose = (listing: string, after: bigint, expiry: bigint) => {
    const at = market.nextClose(listing, after, expiry); return at !== null && at < expiry ? at : null;
  };
  const settle = (at: bigint) => {
    for (const lot of [...stocks]) if (lot.at <= at) {
      remove(stocks, lot); events.push({ type: "stock_settlement", at: economicStamp(at), order_id: lot.order, listing_id: lot.listing,
        quantity: economicText(lot.quantity), settlement_evidence: lot.evidence });
    }
    for (const sale of [...sales]) if (sale.at <= at) {
      remove(sales, sale); cash.set("CNY", cny().plus(sale.amount)); orders.get(sale.order)!.state = "settled";
      if (settledFunding) orders.get(sale.order)!.settledAt = economicStamp(sale.at);
      events.push({ type: "sale_cash_settlement", at: economicStamp(at), order_id: sale.order, amount_cny: economicText(sale.amount), settlement_evidence: sale.evidence });
    }
  };
  const activate = (at: bigint) => {
    for (const order of [...pending]) {
      if (order.state !== "waiting_for_sales") continue;
      const deps = order.dependencies.map(id => orders.get(id)!);
      if (deps.some(row => ["skipped", "expired"].includes(row.state))) { finish(order, "skipped", at, "DEPENDENT_SALE_NOT_COMPLETED"); continue; }
      if (!deps.every(row => row.state === "settled")) continue;
      const floor = order.cashFloor.plus(locked.minus(order.lockedAtDecision));
      if (order.budget.gt(cny().minus(reserved()).minus(floor))) {
        finish(order, "skipped", at, "SETTLED_CASH_BELOW_PRECOMMITTED_BUDGET", { budget_cny: economicText(order.budget),
          available_cny: economicText(Decimal.max(0, cny().minus(reserved()).minus(floor))) }); continue;
      }
      let close: bigint | null;
      try { close = nextClose(order.listing, at, order.expiry); } catch (error) { finish(order, "skipped", at, failure(error)); continue; }
      if (close === null) { finish(order, "skipped", at, "NO_EXECUTABLE_CLOSE_AFTER_SETTLEMENT"); continue; }
      order.state = "scheduled"; order.execute = close; clock.add(close);
      events.push({ type: "order_cash_reserved", at: economicStamp(at), order_id: order.id, execute_at: economicStamp(close),
        budget_cny: economicText(order.budget), reason: "DEPENDENT_SALE_CASH_SETTLED" });
    }
  };
  const resolveDeferred = (at: bigint, outcome: string) => {
    if (lifecycle.deferred) {
      events.push({ type: "policy_review_resumed", at: economicStamp(at), ...lifecycle.deferred, outcome });
      lifecycle.deferred = null;
    }
  };
  const publishOrders = (planned: Order[], at: bigint, expiry: bigint, quotes: Map<string, Quote>) => {
    for (const order of planned) {
      pending.push(order); if (order.execute !== undefined) clock.add(order.execute);
      const [, , priceId, fxId, priceMark] = quotes.get(order.listing)!;
      events.push({ type: "research_order", at: economicStamp(at), order_id: order.id, side: order.side, listing_id: order.listing,
        quantity: economicText(order.quantity), budget_cny: order.side === "buy" ? economicText(order.budget) : null,
        execute_at: order.execute === undefined ? null : economicStamp(order.execute), expires_at: economicStamp(settledFunding ? order.expiry : expiry), funding: order.state,
        dependency_order_ids: order.dependencies, decision_price_observation_id: priceId, decision_fx_observation_id: fxId, decision_price_mark: priceMark,
        ...(order.cashIntentId ? { cash_intent_id: order.cashIntentId } : {}),
        ...(order.originReviewId ? { origin_review_id: order.originReviewId, replaces_order_ids: order.replacesOrderIds } : {}),
        ...(bounded && order.side === "buy" ? { buy_price_cap: economicText(order.priceCap!), buy_fx_cap: economicText(order.fxCap!), worst_total_cash_cny: economicText(order.worstTotal!) } : {}) });
    }
  };
  const evaluate = (at: bigint) => {
    const local = economicLocal(at, zone), period = p.rebalance === "first_decision_each_year" ? String(local.year) : `${local.year}-H${local.month <= 6 ? 1 : 2}`;
    const nextMonth = local.month === 12 ? `${local.year + 1}-01-01` : `${local.year}-${String(local.month + 1).padStart(2, "0")}-01`;
    const expiry = minTime(end, economicMidnight(nextMonth, zone)); clock.add(expiry);
    const base: ObjectValue = { type: "evaluation", at: economicStamp(at), period, expires_at: economicStamp(expiry), cash_cny: economicText(cny()), open_order_count: pending.length };
    if (pending.length || stocks.length || sales.length) {
      events.push({ ...base, outcome: "blocked", targets: {}, signals: [], deltas: [], reason_codes: ["ACTIVE_ORDERS_OR_UNSETTLED_ASSETS"] }); return;
    }
    base.targets = Object.fromEntries(Object.entries(p.weights).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)); base.signals = [];
    let value: Decimal, deploy: Decimal, tolerance: Decimal; const deltas: Delta[] = [], quotes = new Map<string, Quote>();
    try {
      value = nav(at, true); deploy = value.minus(locked); requireEconomic(value.gt(0), "INVALID_ROTATION_TARGETS_OR_NAV");
      tolerance = Decimal.max(p.tolerance.absolute_cny, deploy.times(p.tolerance.weight));
      for (const listing of [...new Set([...weights.keys(), ...[...positions].filter(([, quantity]) => !quantity.isZero()).map(([key]) => key)])].sort()) {
        const weight = weights.get(listing) ?? zero(), quantity = positions.get(listing) ?? zero(); if (weight.isZero() && quantity.isZero()) continue;
        const [price, priceId, priceMark] = mark(listing, at, true), [rate, fxId] = quoteFx(market.assets.get(listing)!.currency, at);
        const target = deploy.times(weight), current = quantity.times(price).times(rate), difference = target.minus(current);
        deltas.push({ listing_id: listing, target_cny: economicText(target), current_cny: economicText(current), difference_cny: economicText(difference),
          within_tolerance: difference.abs().lte(tolerance), price_mark: priceMark }); quotes.set(listing, [price, rate, priceId, fxId, priceMark]);
      }
      reviews?.requireFresh(quotes, at);
    } catch (error) { events.push({ ...base, outcome: "blocked", deltas: [], reason_codes: [failure(error)] }); return; }
    Object.assign(base, { deltas, nav_cny: economicText(value), tolerance_cny: economicText(tolerance),
      ...(!research ? { deployment_base_cny: economicText(deploy), locked_cash_cny: economicText(locked) } : {}) });
    const cashIntent = intents?.active ?? null;
    if (cashIntent && ["failed", "expired"].includes(cashIntent.state)) {
      events.push({ ...base, outcome: "blocked", reason_codes: ["CASH_INTENT_TERMINAL_FAILURE"] }); return;
    }
    if (cashIntent?.state === "waiting_decision" && !reviews!.active) {
      const declaration = cashIntent.declaration, scope = deltas.filter(row => declaration.buy_listing_ids.includes(row.listing_id));
      const needsNow = scope.filter(row => !row.within_tolerance && new Decimal(row.difference_cny).gt(0));
      events.push({ type: "cash_intent_reassessment", at: economicStamp(at), intent_id: declaration.id,
        nav_cny: economicText(value), deltas: scope, current_sale_order_ids: [...cashIntent.current_sale_order_ids] });
      if (!needsNow.length) {
        intents!.resolve(at, "original_buy_scope_no_longer_needed");
        events.push({ ...base, outcome: "unchanged", reason_codes: ["CASH_INTENT_BUY_SCOPE_NO_LONGER_NEEDED"] }); return;
      }
      const foreign = sum([...cash].filter(([currency, amount]) => currency !== "CNY" && !amount.isZero()).map(([currency, amount]) => amount.times(fx(currency, at))));
      const floor = locked.plus(Decimal.max(0, deploy.times(new Decimal(1).minus(weightSum)).minus(foreign))).times(100).ceil().div(100);
      const needsDocument: ObjectValue[] = [], executable = new Map<string, bigint>();
      let preparation: ReturnType<typeof prepareSettledCashBuys>;
      try {
        for (const [index, row] of needsNow.entries()) {
          const listing = row.listing_id, [price, rate, priceId, fxId, evidence] = quotes.get(listing)!;
          const quote = market.observations.get(priceId)!, asset = market.assets.get(listing)!, fxRow = fxId ? market.observations.get(fxId) : null;
          const close = nextClose(listing, at, economicInstant(declaration.deadline));
          requireEconomic(close !== null, "NO_EXECUTABLE_CLOSE:" + listing); executable.set(listing, close);
          needsDocument.push({ listing_id: listing, order_id: `order:${String(orders.size + index + 1).padStart(6, "0")}`,
            need_cny: economicText(new Decimal(row.difference_cny).times(100).floor().div(100)),
            quantity_step: asset.quantity_step, currency: asset.currency, close: economicText(price), fx_cny_per_unit: economicText(rate),
            observed_at: quote.observed_at, available_at: economicStamp(market.available(quote)), mark_kind: evidence.mark_kind,
            fx_observed_at: fxRow?.observed_at ?? null, fx_available_at: fxRow ? economicStamp(market.available(fxRow)) : null,
            price_observation_id: priceId, fx_observation_id: fxId ?? "fx:CNY:constant" });
        }
        const currentSales = cashIntent.current_sale_order_ids;
        const document = { schema_version: "settled-cash-buy-preparation-v2",
          intent: { ...declaration, sale_order_ids: [...currentSales], buy_listing_ids: needsNow.map(row => row.listing_id) },
          decision_at: economicStamp(at), decision_times: plan.decision_times,
          cash: { as_of: economicStamp(at), settled_cny: economicText(cny()), reserved_cny: economicText(reserved()), floor_cny: economicText(floor) },
          book: currentSales.map(id => { const order = orders.get(id)!; return { id, listing_id: order.listing, side: "sell",
            cash_intent_id: declaration.id, state: order.state, settled_at: order.settledAt ?? null }; }),
          needs: needsDocument, execution: Object.fromEntries(["commission_bps", "minimum_fee_cny", "fx_bps", "slippage_bps",
            "buy_price_buffer_bps", "buy_fx_buffer_bps", "cash_quantum", "max_fx_age_seconds"].map(key => [key, ex[key as keyof typeof ex]])) };
        preparation = prepareSettledCashBuys(document);
        for (const [listing, close] of executable) requireEconomic(!data.actions.some(action => action.listing_id === listing
          && economicInstant(action.published_at) <= at && (data.mode !== "actual_replay" || economicInstant(action.ingested_at!) <= at)
          && at < economicInstant(action.at) && economicInstant(action.at) <= close), "KNOWN_ACTION_BEFORE_SCHEDULED_CLOSE");
      } catch (error) { events.push({ ...base, outcome: "blocked", reason_codes: [failure(error)], cash_intent_id: declaration.id }); return; }
      const planned: Order[] = preparation.orders.map(prepared => {
        const order: Order = { id: prepared.order_id, listing: prepared.listing_id, side: "buy", quantity: new Decimal(prepared.quantity),
          budget: new Decimal(prepared.budget_cny), cashFloor: floor, lockedAtDecision: locked, decision: at,
          expiry: economicInstant(declaration.deadline), dependencies: [...cashIntent.current_sale_order_ids], state: "scheduled",
          execute: executable.get(prepared.listing_id)!, allowSales: false, priceCap: new Decimal(prepared.buy_price_cap),
          fxCap: new Decimal(prepared.buy_fx_cap), worstTotal: new Decimal(prepared.worst_total_cash_cny) };
        orders.set(order.id, order); return order;
      });
      intents!.publish(planned, preparation, at); publishOrders(planned, at, economicInstant(declaration.deadline), quotes);
      events.push({ ...base, outcome: "proposed", reason_codes: ["SETTLED_CASH_BUY_BATCH_FROZEN"], order_ids: planned.map(order => order.id), partial: false }); return;
    }
    const reviewing = reviews?.active ?? null, reviewScope = reviewing ? new Set(reviewing.listing_ids) : null;
    if (reviewScope) base.reassessment_scope = [...reviewScope].sort();
    requireEconomic(deploy.gt(0), "INVALID_FIXED_POLICY_CLASS_SCOPE");
    const classes = (() => {
      const Decimal = LedgerDecimal, zero = () => new Decimal(0);
      const roles = new Map<string, { target: Decimal; current: Decimal }>();
      for (const [listing, weight] of weights) {
        const role = p.roles[listing], row = roles.get(role) ?? { target: zero(), current: zero() };
        row.target = row.target.plus(weight); row.current = row.current.plus(new Decimal(deltas.find(row => row.listing_id === listing)?.current_cny ?? "0").div(deploy)); roles.set(role, row);
      }
      return [...roles].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([role, row]) => ({ role, target_weight: economicText(row.target),
        current_weight: economicText(row.current), difference_weight: economicText(row.current.minus(row.target)), threshold_breached: row.current.minus(row.target).abs().gte(p.class_drift_threshold) }));
    })();
    const bootstrap = ![...positions.values()].some(value => !value.isZero()), due = !slots.has(period), breach = classes.some(row => row.threshold_breached);
    const triggers = [...(bootstrap ? ["INITIAL_DEPLOYMENT"] : []), ...(fundingPending ? ["NEW_CASH_REPAIR"] : []),
      ...(reviewing ? ["CORPORATE_ACTION_ORDER_REVIEW"] : []), ...(!holdingBaseline && due ? ["CALENDAR_REVIEW"] : []), ...(!holdingBaseline && breach ? ["CLASS_WEIGHT_BREACH"] : [])];
    Object.assign(base, { class_drift: classes, trigger_codes: triggers, last_proposed_at: lastProposal === null ? null : economicStamp(lastProposal) });
    const days = lastProposal === null ? Infinity : (Date.parse(economicDate(at, zone)) - Date.parse(economicDate(lastProposal, zone))) / 86400000;
    if (!triggers.length || !bootstrap && !fundingPending && !reviewing && days < p.minimum_days_between_rebalances) {
      if (actionAware && !triggers.length) resolveDeferred(at, "no_longer_triggered");
      events.push({ ...base, type: "policy_monitor", reason_codes: [triggers.length ? "REBALANCE_COOLDOWN" : "LOW_FREQUENCY_RULE_NOT_TRIGGERED"] }); return;
    }
    const allowSales = reviewing ? reviewing.allow_sales : !holdingBaseline && !fundingPending; base.allocation_method = allowSales ? "rebalance_to_targets" : "new_cash_repair_without_sales";
    if (!actionAware) { slots.set(period, economicStamp(at)); fundingPending = false; }
    const actionable = deltas.filter(row => !reviewScope || reviewScope.has(row.listing_id));
    const targetsSatisfied = actionable.every(row => row.within_tolerance);
    const saleReviewSatisfied = cashIntent && ["waiting_sales", "waiting_decision"].includes(cashIntent.state) && reviewing
      && actionable.every(row => row.within_tolerance || new Decimal(row.difference_cny).gt(0));
    if (targetsSatisfied || saleReviewSatisfied || reviewing && !allowSales && actionable.every(row => row.within_tolerance || new Decimal(row.difference_cny).lt(0))) {
      if (actionAware) {
        if (!reviewing) { slots.set(period, economicStamp(at)); fundingPending = false; }
        resolveDeferred(at, "targets_within_tolerance"); reviews?.complete(at, true, !targetsSatisfied && !saleReviewSatisfied, !!saleReviewSatisfied && !targetsSatisfied);
      }
      events.push({ ...base, outcome: "unchanged", reason_codes: [saleReviewSatisfied && !targetsSatisfied ? "SELL_SCOPE_NO_LONGER_NEEDED" : "TARGETS_WITHIN_TOLERANCE"] }); return;
    }
    const issues: string[] = [], planned: Order[] = [], saleIds: string[] = [], needs = new Map<string, Decimal>(); let projectedSales = zero();
    const foreign = sum([...cash].filter(([currency, amount]) => currency !== "CNY" && !amount.isZero()).map(([currency, amount]) => amount.times(fx(currency, at))));
    const floor = locked.plus(Decimal.max(0, deploy.times(new Decimal(1).minus(weightSum)).minus(foreign)));
    const makeOrder = (listing: string, side: "buy" | "sell", quantity: Decimal, budget = zero(), dependencies: string[] = [], bounds?: [Decimal, Decimal, Decimal]) => {
      const order: Order = { id: `order:${String(orders.size + 1).padStart(6, "0")}`, listing, side, quantity, budget, cashFloor: floor,
        lockedAtDecision: locked, decision: at, expiry: cashIntent ? minTime(expiry, economicInstant(cashIntent.declaration.deadline)) : expiry, dependencies, state: "planned",
        ...(reviewable ? { allowSales } : {}),
        ...(bounds ? { priceCap: bounds[0], fxCap: bounds[1], worstTotal: bounds[2] } : {}) }; orders.set(order.id, order); planned.push(order); return order;
    };
    for (const row of actionable) {
      if (row.within_tolerance) continue;
      const listing = row.listing_id, difference = new Decimal(row.difference_cny);
      if (difference.gt(0)) { needs.set(listing, difference); continue; } if (!allowSales) continue;
      const [price, rate] = quotes.get(listing)!, step = new Decimal(market.assets.get(listing)!.quantity_step), held = positions.get(listing) ?? zero();
      const desired = new Decimal(row.target_cny).isZero() ? held : difference.negated().div(price.times(rate));
      const quantity = Decimal.min(held, desired.div(step).floor().times(step));
      if (quantity.lte(0)) { issues.push("SELL_BELOW_QUANTITY_STEP:" + listing); continue; }
      if (new Decimal(row.target_cny).isZero() && quantity.lt(held)) issues.push("SELL_QUANTITY_STEP_RESIDUAL:" + listing);
      try {
        const close = nextClose(listing, at, expiry), proceeds = cost("sell", quantity, price, market.assets.get(listing)!.currency, at).amount;
        requireEconomic(close !== null, "NO_EXECUTABLE_CLOSE:" + listing);
        const order = makeOrder(listing, "sell", quantity); order.state = "scheduled"; order.execute = close;
        saleIds.push(order.id); projectedSales = projectedSales.plus(proceeds);
      } catch (error) { issues.push(failure(error)); }
    }
    const available = Decimal.max(0, cny().minus(floor)).plus(projectedSales), totalNeed = sum(needs.values()), deployment = Decimal.min(available, totalNeed);
    const deferredBuys = settledFunding && (saleIds.length > 0 || cashIntent && ["waiting_sales", "waiting_decision"].includes(cashIntent.state));
    for (const [listing, need] of deferredBuys ? [] : [...needs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      let allocation = totalNeed.isZero() ? zero() : deployment.times(need).div(totalNeed);
      if (bounded) allocation = allocation.times(100).floor().div(100);
      const [price, rate] = quotes.get(listing)!;
      const asset = market.assets.get(listing)!, step = new Decimal(asset.quantity_step);
      const cap = bounded ? price.times(new Decimal(1).plus(new Decimal(ex.buy_price_buffer_bps!).div(10000))) : price;
      const fxCap = bounded && asset.currency !== "CNY" ? rate.times(new Decimal(1).plus(new Decimal(ex.buy_fx_buffer_bps!).div(10000))) : rate;
      if (allocation.lte(0)) { issues.push("NO_SETTLED_OR_DEPENDENT_CASH:" + listing); continue; }
      let low = 0n, high = BigInt(allocation.div(cap.times(fxCap).times(step)).floor().toFixed());
      try {
        while (low < high) {
          const middle = (low + high + 1n) / 2n;
          if (cost("buy", step.times(middle.toString()), cap, asset.currency, at, bounded ? fxCap : undefined).amount.lte(allocation)) low = middle; else high = middle - 1n;
        }
      } catch (error) { issues.push(failure(error) + ":" + listing); continue; }
      if (!low) { issues.push("BUY_BELOW_QUANTITY_STEP_OR_FEES:" + listing); continue; }
      const bounds: [Decimal, Decimal, Decimal] | undefined = bounded ? [cap, fxCap, cost("buy", step.times(low.toString()), cap, asset.currency, at, fxCap).amount] : undefined;
      const reservedNow = sum(planned.filter(order => order.side === "buy" && order.state === "scheduled").map(order => order.budget));
      if (allocation.lte(cny().minus(floor).minus(reservedNow))) {
        try {
          const close = nextClose(listing, at, expiry); requireEconomic(close !== null, "NO_EXECUTABLE_CLOSE:" + listing);
          const order = makeOrder(listing, "buy", step.times(low.toString()), allocation, [], bounds); order.state = "scheduled"; order.execute = close;
        } catch (error) { issues.push(failure(error)); }
      } else if (saleIds.length) { const order = makeOrder(listing, "buy", step.times(low.toString()), allocation, [...saleIds], bounds); order.state = "waiting_for_sales"; }
      else issues.push("NO_SETTLED_OR_DEPENDENT_CASH:" + listing);
    }
    if (actionAware) {
      if ((reviewing || settledFunding) && (issues.length || !planned.length)) {
        for (const order of planned) orders.delete(order.id);
        events.push({ ...base, outcome: "blocked", reason_codes: [...new Set([...issues, "ORDER_REVIEW_REPLACEMENT_INCOMPLETE"])].sort() });
        return;
      }
      const deferred: ObjectValue[] = [];
      for (const order of planned) {
        if (order.state !== "scheduled") continue;
        const relevant = data.actions.filter(action => action.listing_id === order.listing).sort((a, b) => {
          const left = economicInstant(a.at), right = economicInstant(b.at);
          return left < right ? -1 : left > right ? 1 : a.type !== b.type ? a.type === "split" ? -1 : 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        for (const action of relevant) {
          const known = economicInstant(action.published_at) <= at && (data.mode !== "actual_replay" || economicInstant(action.ingested_at!) <= at);
          const actionAt = economicInstant(action.at);
          if (known && at < actionAt && actionAt <= order.execute!) deferred.push({ listing_id: order.listing, side: order.side,
            planned_close_at: economicStamp(order.execute!), action_id: action.id, action_at: action.at });
        }
      }
      if (deferred.length) {
        for (const order of planned) orders.delete(order.id);
        lifecycle.deferred = { first_deferred_at: lifecycle.deferred?.first_deferred_at ?? economicStamp(at), last_deferred_at: economicStamp(at) };
        events.push({ ...base, outcome: "deferred", reason_codes: [...new Set([...issues, "KNOWN_ACTION_BEFORE_SCHEDULED_CLOSE"])].sort(), deferred_actions: deferred });
        return;
      }
      if (!reviewing) { slots.set(period, economicStamp(at)); fundingPending = false; }
      if (planned.length && !issues.length) resolveDeferred(at, "new_orders_proposed");
      if (reviewing) { reviews!.publish(planned, at); if (intents?.active) intents.bindReplacements(planned, at); }
      if (settledFunding && saleIds.length && needs.size && !intents!.active) intents!.declare(saleIds, [...needs.keys()], at, expiry);
    }
    publishOrders(planned, at, expiry, quotes);
    events.push({ ...base, outcome: planned.length ? "proposed" : "blocked", reason_codes: [...new Set(issues)].sort(), order_ids: planned.map(order => order.id), partial: issues.length > 0 });
    if (planned.length) lastProposal = at;
  };

  while (clock.length) {
    const at = clock.pop();
    for (const order of [...pending]) if (at >= order.expiry) finish(order, "expired", at, "FIXED_POLICY_ORDER_EXPIRED");
    reviews?.onActions(actions.get(at) ?? [], pending, at, finish);
    for (const action of [...(actions.get(at) ?? [])].sort((a, b) => a.type !== b.type ? a.type === "split" ? -1 : 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      if (bounded && !reviewable) for (const order of [...pending]) if (order.listing === action.listing_id)
        finish(order, "skipped", at, "CORPORATE_ACTION_INVALIDATES_FROZEN_ORDER", { action_id: action.id });
      const quantity = positions.get(action.listing_id) ?? zero(), currency = market.assets.get(action.listing_id)!.currency;
      if (action.type === "split") {
        const ratio = new Decimal(action.ratio!); positions.set(action.listing_id, quantity.times(ratio));
        for (const lot of stocks) if (lot.listing === action.listing_id) lot.quantity = lot.quantity.times(ratio);
        for (const order of pending) if (order.listing === action.listing_id) order.quantity = order.quantity.times(ratio);
        events.push({ type: "split", at: economicStamp(at), action_id: action.id, listing_id: action.listing_id, ratio: economicText(ratio) });
      } else {
        const gross = quantity.times(action.gross_per_unit!), tax = quantity.times(action.tax_per_unit!), net = gross.minus(tax), payAt = economicInstant(action.pay_at!);
        dividends.set(currency, (dividends.get(currency) ?? zero()).plus(net));
        const rows = payments.get(payAt) ?? []; rows.push({ currency, amount: net, id: action.id }); payments.set(payAt, rows);
        events.push({ type: "dividend_entitlement", at: economicStamp(at), action_id: action.id, listing_id: action.listing_id,
          gross: economicText(gross), tax: economicText(tax), net: economicText(net), currency });
      }
    }
    for (const row of payments.get(at) ?? []) {
      dividends.set(row.currency, dividends.get(row.currency)!.minus(row.amount)); cash.set(row.currency, (cash.get(row.currency) ?? zero()).plus(row.amount));
      if (row.currency === "CNY" && row.amount.gt(0)) fundingPending = true;
      events.push({ type: "dividend_payment", at: economicStamp(at), action_id: row.id, amount: economicText(row.amount), currency: row.currency });
    }
    payments.delete(at); settle(at);
    if (contributions.has(at)) {
      const before = nav(at), amount = contributions.get(at)!; requireEconomic(before.gt(0), "RESEARCH_UNIT_NAV_REQUIRES_RESET");
      units = units.plus(amount.div(before.div(units))); cash.set("CNY", cny().plus(amount)); principal = principal.plus(amount);
      if (research) fundingPending = true; else locked = locked.plus(amount);
      flows.push({ at, amount, before }); events.push({ type: "external_contribution", at: economicStamp(at), amount_cny: economicText(amount) });
    }
    if (releases.has(at)) {
      const amount = releases.get(at)!; requireEconomic(amount.gte(0) && amount.lte(locked), "INVESTOR_LONG_HORIZON_RELEASE_EXCEEDS_LOCKED_CASH");
      locked = locked.minus(amount); fundingPending = fundingPending || amount.gt(0);
      events.push({ type: "funding_release", at: economicStamp(at), amount_cny: economicText(amount), remaining_locked_cash_cny: economicText(locked) });
    }
    activate(at);
    for (const order of [...pending]) {
      if (order.state !== "scheduled" || order.execute !== at) continue;
      const asset = market.assets.get(order.listing)!, quantity = order.quantity;
      if (quantity.lte(0) || !quantity.mod(asset.quantity_step).isZero()) { finish(order, "skipped", at, "FIXED_QUANTITY_NOT_EXECUTABLE_AFTER_ACTION"); continue; }
      const session = market.session(asset.market, at)!, evidence = market.settlements.get(`${asset.market}:${session.session_date}`);
      if (!evidence || economicInstant(evidence.published_at) > at || economicInstant(evidence.settled_at) < at || !evidence.source_evidence
        || data.mode === "actual_replay" && (!evidence.ingested_at || economicInstant(evidence.ingested_at) > at)) { finish(order, "skipped", at, "SETTLEMENT_EVIDENCE_UNAVAILABLE"); continue; }
      const settled = economicInstant(evidence.settled_at); let priceId: string, rawPrice: Decimal, actual: ReturnType<typeof cost>;
      try { const [price, id] = market.price(order.listing, at, false, at); priceId = id; rawPrice = price; actual = cost(order.side, quantity, price, asset.currency, at); }
      catch (error) { finish(order, "skipped", at, failure(error)); continue; }
      if (order.side === "buy") {
        if (bounded && (rawPrice.gt(order.priceCap!) || actual.spot.gt(order.fxCap!))) {
          finish(order, "skipped", at, "EXECUTION_PRICE_OR_FX_BOUND_EXCEEDED", { buy_price_cap: economicText(order.priceCap!), buy_fx_cap: economicText(order.fxCap!),
            observed_price: economicText(rawPrice), observed_fx: economicText(actual.spot) }); continue;
        }
        if (actual.amount.gt(order.budget) || actual.amount.gt(cny().minus(reserved().minus(order.budget)).minus(locked))) {
          finish(order, "skipped", at, "EXECUTION_EXCEEDS_PRECOMMITTED_CASH_BUDGET", { budget_cny: economicText(order.budget), required_cny: economicText(actual.amount) }); continue;
        }
        cash.set("CNY", cny().minus(actual.amount)); positions.set(order.listing, (positions.get(order.listing) ?? zero()).plus(quantity));
        stocks.push({ order: order.id, listing: order.listing, quantity, at: settled, evidence }); buys = buys.plus(actual.principal);
      } else {
        const available = (positions.get(order.listing) ?? zero()).minus(sum(stocks.filter(row => row.listing === order.listing).map(row => row.quantity)));
        if (quantity.gt(available)) { finish(order, "skipped", at, "STOCK_NOT_SETTLED_OR_UNAVAILABLE"); continue; }
        positions.set(order.listing, positions.get(order.listing)!.minus(quantity)); sales.push({ order: order.id, amount: actual.amount, at: settled, evidence }); sells = sells.plus(actual.principal);
      }
      finish(order, "filled", at); fees = fees.plus(actual.fee); fxFees = fxFees.plus(actual.fxFee); slipFees = slipFees.plus(actual.slipCost); rounding = rounding.plus(actual.rounding); clock.add(settled);
      events.push({ type: "simulated_" + order.side, at: economicStamp(at), order_id: order.id, decision_at: economicStamp(order.decision), listing_id: order.listing,
        quantity: economicText(quantity), execution_price: economicText(actual.fillPrice), fx_cny_per_unit: economicText(actual.spot), fee_cny: economicText(actual.fee),
        fx_fee_cny: economicText(actual.fxFee), cash_rounding_cny: economicText(actual.rounding), total_cash_cny: economicText(actual.amount),
        price_observation_id: priceId, fx_observation_id: market.fx(asset.currency, at)[1], settled_at: economicStamp(settled), settlement_evidence: evidence });
    }
    settle(at); activate(at); reviews?.complete(at); intents?.refresh(at); if (decisions.has(at)) evaluate(at);
    const carry: ObjectValue[] = [], total = nav(at, false, carry);
    requireEconomic(locked.gte(0) && cny().minus(locked).minus(reserved()).gte(0), "INVESTOR_LONG_HORIZON_CASH_RESERVATION_INVALID");
    curve.push({ at: economicStamp(at), nav_cny: economicText(total), unit_nav: reportedRatio(total, units)!,
      cash_cny: economicText(sum([...cash].filter(([, amount]) => !amount.isZero()).map(([currency, amount]) => amount.times(fx(currency, at))))),
      derived_carry_marks: carry.sort((a, b) => (a.listing_id as string) < (b.listing_id as string) ? -1 : 1), ...(!research ? { principal_cny: economicText(principal),
      profit_cny: economicText(total.minus(principal)), locked_cash_cny: economicText(locked), released_capital_cny: economicText(principal.minus(locked)),
      unreserved_released_cash_cny: economicText(cny().minus(locked).minus(reserved())) } : {}) });
  }
  const closing = new Decimal(curve.at(-1)!.nav_cny as string), meanNav = sum(curve.map(row => new Decimal(row.nav_cny as string))).div(curve.length);
  const bought = new Set(events.filter(row => row.type === "simulated_buy").map(row => row.listing_id));
  const missing = [...weights].filter(([listing, weight]) => weight.gt(0) && !bought.has(listing)).map(([listing]) => listing).sort();
  if (missing.length) events.push({ type: "policy_deployment_failed", at: economicStamp(end), missing_listings: missing,
    reason: bought.size ? "INITIAL_DEPLOYMENT_INCOMPLETE" : "INITIAL_DEPLOYMENT_NOT_EXECUTED" });
  else if (actionAware && lifecycle.deferred) events.push({ type: "policy_deployment_failed", at: economicStamp(end),
    ...lifecycle.deferred, reason: "DEFERRED_POLICY_REVIEW_UNRESOLVED" });
  const rawFailures = events.filter(row => ["execution_skipped", "order_expired", "policy_deployment_failed"].includes(row.type as string)).length;
  return { engine_version: settledFunding ? research ? "fixed-policy-settled-intent-rebalance-v6" : holdingBaseline ? "continuous-settled-intent-hold-v1" : "continuous-settled-intent-funding-v1" : reviewable ? research ? "fixed-policy-event-review-rebalance-v5" : holdingBaseline ? "continuous-event-review-hold-v1" : "continuous-event-review-funding-v1" : actionAware ? "fixed-policy-action-aware-bounded-rebalance-v4" : research ? "fixed-policy-bounded-rebalance-v3" : bounded ? holdingBaseline ? "continuous-bounded-hold-new-cash-v1" : "continuous-bounded-fixed-policy-funding-v1" : holdingBaseline ? "continuous-hold-new-cash-v1" : "continuous-fixed-policy-funding-v1", phase: options.researchPhase ?? "continuous", window: plan.window,
    initial_equity_cny: economicText(initial), contributions_cny: economicText(sum(contributions.values())), ending_nav_cny: economicText(closing),
    profit_cny: economicText(new LedgerDecimal(closing.toFixed()).minus(initial).minus(sum(contributions.values()))),
    ...continuousPerformance(start, end, initial, closing, flows, curve as { at: string; nav_cny: string; unit_nav: string }[], zone),
    fees_cny: economicText(fees), fx_fees_cny: economicText(fxFees), slippage_cny: economicText(slipFees), cash_rounding_cny: economicText(rounding),
    buy_turnover_on_mean_observed_nav: reportedRatio(buys, meanNav),
    sell_turnover_on_mean_observed_nav: reportedRatio(sells, meanNav),
    total_turnover_on_mean_observed_nav: reportedRatio(buys.plus(sells), meanNav),
    ending_cash_ratio: reportedRatio(new Decimal(curve.at(-1)!.cash_cny as string), closing),
    positions: Object.fromEntries(Object.entries(ordered(positions)).map(([key, value]) => [key, economicText(value)])),
    ending_cash: Object.fromEntries(Object.entries(ordered(cash)).map(([key, value]) => [key, economicText(value)])),
    ending_receivables: { sale_cny: economicText(sum(sales.map(row => row.amount))), dividends: Object.fromEntries(Object.entries(ordered(dividends)).map(([key, value]) => [key, economicText(value)])) },
    ending_unsettled_positions: stocks.map(row => ({ order_id: row.order, listing_id: row.listing, quantity: economicText(row.quantity), settled_at: economicStamp(row.at) })),
    execution_failure_count: rawFailures,
    ...(reviews ? reviews.result(rawFailures) : {}),
    ...(intents ? intents.result() : {}),
    policy_evaluation_counts: Object.fromEntries((actionAware ? ["proposed", "unchanged", "blocked", "deferred"] : ["proposed", "unchanged", "blocked"]).map(outcome => [outcome, events.filter(row => row.type === "evaluation" && row.outcome === outcome).length])),
    policy_rules: { ...Object.fromEntries(["rebalance", "roles", "class_drift_threshold", "minimum_days_between_rebalances", "contribution_mode", "order_expiry"].map(key => [key, p[key as keyof ContinuousParameters]])),
      ...(holdingBaseline ? { rebalance: "disabled_hold_new_cash" } : {}) },
    policy_monitor_count: events.filter(row => row.type === "policy_monitor").length, curve, events,
    assumptions: [research ? "independent_phase_restart_not_continuous_forward_history" : "continuous_single_account_no_phase_or_year_restart", "research_only_no_actual_facts_or_approval", "ex_post_close_valuation_with_point_in_time_decisions",
      "explicit_market_calendar_settlement", "sale_proceeds_converted_to_cny_at_fill_unavailable_until_settlement", "fixed_decision_quantity_and_budget",
      "theoretical_ex_action_carry_between_raw_closes_not_an_observed_or_live_price",
      ...(bounded ? ["buy_raw_close_and_fx_caps_frozen_at_decision", "buy_quantity_sized_at_both_caps_with_upward_cent_debit", "allocation_cent_dust_stays_cash", "corporate_action_cancels_frozen_orders_without_resizing"] : []),
      ...(actionAware ? ["known_scheduled_action_defers_entire_tentative_batch_without_consuming_policy_slot"] : []),
      ...(actionAware ? ["deferred_review_requires_later_valid_review_or_fails_phase"] : []),
      ...(reviewable ? ["raw_action_cancellations_preserved_and_only_resolved_lineage_closes_terminal_gaps", "post_action_raw_close_and_declared_future_decision_required_for_replacement"] : []),
      ...(settledFunding ? ["sell_only_publication_then_declared_decision_with_settled_cash", "cash_floor_upward_cent_and_remaining_buy_need_downward_cent", "failed_frozen_buy_never_resized_or_retried"] : []),
      holdingBaseline ? "no_calendar_or_class_drift_rebalancing" : "half_year_or_year_calendar_review_plus_absolute_class_drift",
      "cooldown_uses_evaluation_local_calendar_days", holdingBaseline ? "new_cny_cash_repairs_without_sales" : "new_cny_cash_repairs_without_sales_before_rebalancing", "orders_expire_at_next_month_boundary",
      "unsettled_assets_block_new_orders", "no_margin", "no_cash_interest", "foreign_dividends_retained_in_original_currency", "turnover_uses_arithmetic_mean_observed_nav",
      ...(!research ? ["all_capital_enters_nav_at_arrival_not_at_tranche_release", "waiting_cny_cash_has_no_interest_and_is_unavailable_for_orders",
      "strategic_targets_use_nav_less_unreleased_capital", "release_is_not_a_trade_or_an_external_cashflow"] : [])], tax_coverage: plan.tax_coverage };
}
