import { allocatedCost, amount, Decimal, exact, nonnegative, positive } from "./decimal";

export type LedgerAccount = "cash_settled" | "trade_receivable" | "trade_payable" | "dividend_receivable" | "dividend_tax_payable" | "transfer_in_transit" | "inventory_cost" | "external_capital" | "opening_equity" | "income" | "unclassified_income" | "expense" | "fx_bridge" | "inventory_in_transit_cost" | "capital_valuation_adjustment";
export const CORPORATE_ACTION_TYPES = ["corporate_action_notice", "corporate_action_resolution"] as const;
export const DIVIDEND_ROOT_TYPES = ["dividend_accrual", "dividend", "dividend_net"] as const;
export const DIVIDEND_CHILD_TYPES = ["dividend_payment", "dividend_breakdown", "dividend_tax_assessment", "dividend_tax_payment"] as const;
export const CORPORATE_SUPPORT_TYPES = ["opening_position", "buy", "sell", "settlement", ...DIVIDEND_ROOT_TYPES, ...DIVIDEND_CHILD_TYPES, "fee", "split", "security_in", "security_out", "security_transfer_out", "security_transfer_in", "security_transfer_return"] as const;
export const isCorporateActionMarker = (type: string): boolean => (CORPORATE_ACTION_TYPES as readonly string[]).includes(type);
export type DividendTaxStatus = "unknown" | "estimated" | "confirmed";
export interface Posting { account_id: string; currency: string; ledger_account: LedgerAccount; amount: string }
export interface Movement { account_id: string; listing_id: string; currency: string; quantity: string; cost_amount: string; cost_known: boolean }
export interface Position { quantity: string; cost_amount: string; cost_known: boolean; currency: string }
export interface SecurityTransferValue { schema_version: "security-transfer-value-v1"; reference: string; effective_at: string; time_precision: "date" | "second"; source_timezone: string }
export interface TransitPosition extends Position { transfer_event_id: string; source_account_id: string; target_account_id: string; listing_id: string }
export interface TransitMovement extends Omit<TransitPosition, "transfer_event_id"> { transfer_event_id: string | null }
export interface Fact {
  type: "opening_cash" | "opening_position" | "deposit" | "withdrawal" | "buy" | "sell" | "settlement" | "dividend_accrual" | "dividend_payment" | "dividend" | "dividend_net" | "dividend_breakdown" | "dividend_tax_assessment" | "dividend_tax_payment" | "corporate_action_notice" | "corporate_action_resolution" | "fee" | "fx" | "transfer_out" | "transfer_in" | "split" | "security_in" | "security_out" | "security_transfer_out" | "security_transfer_in" | "security_transfer_return";
  account_id: string;
  currency: string;
  listing_id?: string;
  amount?: string;
  quantity?: string;
  price?: string;
  consideration?: string;
  cost_amount?: string;
  fee?: string;
  tax?: string;
  gross_amount?: string;
  tax_status?: DividendTaxStatus;
  net_status?: "final" | "provisional";
  evidence_reference?: string;
  action_kind?: "dividend_entitlement" | "merger" | "liquidation" | "return_of_capital" | "other";
  resolution?: "not_applicable" | "recorded";
  supporting_event_ids?: string[];
  target_account_id?: string;
  target_currency?: string;
  received_amount?: string;
  direction?: "buy" | "sell";
  related_event_id?: string;
  split_numerator?: string;
  split_denominator?: string;
  market_value?: string;
  value_evidence?: SecurityTransferValue;
}
export interface FactState {
  position?: Position;
  related?: { type: string; account_id: string; currency: string; outstanding: string; target_account_id?: string };
  transfer?: TransitPosition;
  transit_positions?: TransitPosition[];
  dividend?: DividendState;
  legacy_direct_dividend?: boolean;
  notice?: { account_id: string; currency: string; resolved: boolean };
}
export interface DividendState {
  root_event_id: string; type: string; account_id: string; currency: string; listing_id?: string;
  gross_amount: string | null; tax: string; tax_status: DividendTaxStatus;
  net_cash: string; receivable: string; tax_payable: string;
  net_amount?: string; net_status?: "final" | "provisional"; breakdown_event_id?: string;
  tax_assessment_event_id?: string; assessment_confirmed: boolean;
}
export interface Entry { postings: Posting[]; movements: Movement[]; warnings: string[]; transits?: TransitMovement[] }

export function buildEntry(fact: Fact, state: FactState = {}): Entry {
  if (!fact.account_id || !/^[A-Z]{3}$/.test(fact.currency)) throw new Error("INVALID_ACCOUNT_OR_CURRENCY");
  const entry: Entry = { postings: [], movements: [], warnings: [] };
  const add = (ledger_account: LedgerAccount, value: Decimal, account_id = fact.account_id, currency = fact.currency) => {
    if (!value.isZero()) entry.postings.push({ account_id, currency, ledger_account, amount: exact(value) });
  };
  const move = (quantity: Decimal, cost: Decimal, known = true) => {
    if (!fact.listing_id) throw new Error("LISTING_REQUIRED");
    entry.movements.push({ account_id: fact.account_id, listing_id: fact.listing_id, currency: fact.currency, quantity: exact(quantity), cost_amount: exact(cost), cost_known: known });
  };
  const fee = nonnegative(fact.fee ?? "0");
  const tax = nonnegative(fact.tax ?? "0");
  const release = (position: Position, quantity: Decimal) => {
    if (position.currency !== fact.currency || quantity.gt(amount(position.quantity))) throw new Error("POSITION_HISTORY_REQUIRED");
    return quantity.eq(amount(position.quantity)) ? amount(position.cost_amount) : allocatedCost(amount(position.cost_amount).mul(quantity).div(positive(position.quantity)));
  };
  const transit = (lot: Omit<TransitMovement, "quantity" | "cost_amount">, quantity: Decimal, cost: Decimal) => {
    if (!quantity.isZero()) (entry.transits ??= []).push({ ...lot, quantity: exact(quantity), cost_amount: exact(cost) });
  };
  const principalFor = (qty: Decimal) => {
    const price = fact.price === undefined ? undefined : positive(fact.price);
    const principal = fact.consideration === undefined ? qty.mul(price ?? positive(undefined)) : positive(fact.consideration);
    if (price && !qty.mul(price).eq(principal)) entry.warnings.push("BROKER_PRINCIPAL_DIFFERS_FROM_QUANTITY_PRICE");
    return principal;
  };
  const related = (types: string[], signed = false) => {
    const r = state.related;
    if (!fact.related_event_id || !r || !types.includes(r.type) || r.currency !== fact.currency) throw new Error("INVALID_RELATED_EVENT");
    if (fact.type !== "transfer_in" && r.account_id !== fact.account_id) throw new Error("RELATED_ACCOUNT_MISMATCH");
    const value = signed ? amount(fact.amount) : positive(fact.amount);
    const outstanding = amount(r.outstanding);
    if (value.isZero() || value.isPositive() !== outstanding.isPositive() || value.abs().gt(outstanding.abs())) throw new Error("EXCEEDS_OUTSTANDING");
    return { r, value };
  };
  const dividend = (requiresGross = true) => {
    const value = state.dividend;
    if (!fact.related_event_id || !value || !(DIVIDEND_ROOT_TYPES as readonly string[]).includes(value.type) || value.currency !== fact.currency) throw new Error("INVALID_RELATED_EVENT");
    if (value.account_id !== fact.account_id) throw new Error("RELATED_ACCOUNT_MISMATCH");
    if (fact.listing_id && value.listing_id && fact.listing_id !== value.listing_id) throw new Error("DIVIDEND_LISTING_MISMATCH");
    if (requiresGross && value.gross_amount === null) throw new Error("DIVIDEND_BREAKDOWN_REQUIRED");
    return value;
  };
  const dividendBalances = (value: DividendState, netCash: Decimal, totalTax: Decimal) => {
    const remaining = positive(value.gross_amount).sub(totalTax).sub(netCash);
    add("dividend_receivable", Decimal.max(remaining, 0).sub(value.receivable));
    add("dividend_tax_payable", Decimal.min(remaining, 0).sub(value.tax_payable));
  };
  if (["dividend_breakdown", "dividend_tax_assessment", "dividend_tax_payment", ...CORPORATE_ACTION_TYPES].includes(fact.type) && !fact.evidence_reference?.trim()) throw new Error("DIVIDEND_EVIDENCE_REQUIRED");
  switch (fact.type) {
    case "opening_cash": {
      const value = amount(fact.amount);
      add("cash_settled", value); add("opening_equity", value.neg());
      break;
    }
    case "opening_position": {
      const qty = positive(fact.quantity);
      const known = fact.cost_amount !== undefined;
      const cost = known ? nonnegative(fact.cost_amount) : new Decimal(0);
      move(qty, cost, known); add("inventory_cost", cost); add("opening_equity", cost.neg());
      if (!known) entry.warnings.push("UNKNOWN_HISTORICAL_COST");
      break;
    }
    case "security_in": case "security_out": {
      if (!fact.value_evidence?.reference?.trim() || fact.value_evidence.schema_version !== "security-transfer-value-v1") throw new Error("SECURITY_VALUE_EVIDENCE_REQUIRED");
      const qty = positive(fact.quantity), value = positive(fact.market_value), incoming = fact.type === "security_in";
      if (!incoming && !state.position) throw new Error("POSITION_HISTORY_REQUIRED");
      const known = incoming ? fact.cost_amount !== undefined : state.position!.cost_known;
      const cost = incoming ? nonnegative(fact.cost_amount ?? "0") : release(state.position!, qty);
      move(incoming ? qty : qty.neg(), incoming ? cost : cost.neg(), known);
      add("inventory_cost", incoming ? cost : cost.neg());
      add("external_capital", incoming ? value.neg() : value);
      add("capital_valuation_adjustment", incoming ? value.sub(cost) : cost.sub(value));
      entry.warnings.push("CONFIRMED_IN_KIND_VALUE_NOT_CASH", "HISTORICAL_COST_PROFIT_DIFFERS_FROM_PORTFOLIO_PERIOD_PROFIT");
      if (!known) entry.warnings.push("UNKNOWN_HISTORICAL_COST");
      break;
    }
    case "security_transfer_out": {
      if (!fact.target_account_id || fact.target_account_id === fact.account_id) throw new Error("TRANSFER_TARGET_REQUIRED");
      if (!fact.listing_id || !state.position) throw new Error("POSITION_HISTORY_REQUIRED");
      const qty = positive(fact.quantity), cost = release(state.position, qty);
      move(qty.neg(), cost.neg(), state.position.cost_known);
      add("inventory_cost", cost.neg()); add("inventory_in_transit_cost", cost);
      transit({ transfer_event_id: null, source_account_id: fact.account_id, target_account_id: fact.target_account_id, listing_id: fact.listing_id, currency: fact.currency, cost_known: state.position.cost_known }, qty, cost);
      if (!state.position.cost_known) entry.warnings.push("UNKNOWN_HISTORICAL_COST");
      break;
    }
    case "security_transfer_in": case "security_transfer_return": {
      const lot = state.transfer;
      if (!lot || !fact.related_event_id || lot.transfer_event_id !== fact.related_event_id || lot.listing_id !== fact.listing_id || lot.currency !== fact.currency) throw new Error("INVALID_SECURITY_TRANSFER");
      if ((fact.type === "security_transfer_in" ? lot.target_account_id : lot.source_account_id) !== fact.account_id) throw new Error("TRANSFER_TARGET_MISMATCH");
      const qty = positive(fact.quantity);
      if (qty.gt(amount(lot.quantity))) throw new Error("EXCEEDS_OUTSTANDING");
      const cost = release(lot, qty);
      move(qty, cost, lot.cost_known); add("inventory_cost", cost); add("inventory_in_transit_cost", cost.neg(), lot.source_account_id);
      transit(lot, qty.neg(), cost.neg());
      if (!lot.cost_known) entry.warnings.push("UNKNOWN_HISTORICAL_COST");
      break;
    }
    case "deposit": case "withdrawal": {
      const value = positive(fact.amount).mul(fact.type === "deposit" ? 1 : -1);
      add("cash_settled", value); add("external_capital", value.neg());
      break;
    }
    case "buy": {
      const qty = positive(fact.quantity);
      const principal = principalFor(qty);
      move(qty, principal); add("inventory_cost", principal); add("expense", fee);
      add("trade_payable", principal.add(fee).neg());
      break;
    }
    case "sell": {
      const qty = positive(fact.quantity);
      const pos = state.position;
      if (!pos || pos.currency !== fact.currency || qty.gt(amount(pos.quantity))) throw new Error("POSITION_HISTORY_REQUIRED");
      const principal = principalFor(qty);
      const cost = qty.eq(amount(pos.quantity)) ? amount(pos.cost_amount) : allocatedCost(amount(pos.cost_amount).mul(qty).div(positive(pos.quantity)));
      move(qty.neg(), cost.neg(), pos.cost_known);
      add("inventory_cost", cost.neg()); add("trade_receivable", principal.sub(fee));
      add("expense", fee); add(pos.cost_known ? "income" : "unclassified_income", principal.sub(cost).neg());
      if (!pos.cost_known) entry.warnings.push("UNKNOWN_REALIZED_COST");
      break;
    }
    case "settlement": {
      if (!fact.direction) throw new Error("SETTLEMENT_DIRECTION_REQUIRED");
      const { value } = related([fact.direction], fact.direction === "sell");
      if (fact.direction === "buy") { add("cash_settled", value.neg()); add("trade_payable", value); }
      else { add("cash_settled", value); add("trade_receivable", value.neg()); }
      break;
    }
    case "dividend_accrual": case "dividend": {
      const gross = positive(fact.amount);
      const status = fact.tax_status ?? (fact.tax === undefined ? "unknown" : "confirmed");
      if (!["unknown", "estimated", "confirmed"].includes(status) || (status === "unknown" && fact.tax !== undefined) || (status !== "unknown" && fact.tax === undefined)) throw new Error("INVALID_DIVIDEND_TAX_STATUS");
      if (fact.type === "dividend" && status !== "confirmed" && !(state.legacy_direct_dividend && status === "unknown" && fact.tax === undefined)) throw new Error("DIRECT_DIVIDEND_TAX_REQUIRED");
      if (tax.gt(gross)) throw new Error("TAX_EXCEEDS_DIVIDEND");
      add(fact.type === "dividend" ? "cash_settled" : "dividend_receivable", gross.sub(tax));
      add("income", gross.neg()); add("expense", tax);
      if (status !== "confirmed") entry.warnings.push("DIVIDEND_TAX_PROVISIONAL");
      break;
    }
    case "dividend_net": {
      if (!["final", "provisional"].includes(fact.net_status ?? "")) throw new Error("INVALID_DIVIDEND_NET_STATUS");
      const net = positive(fact.amount);
      add("cash_settled", net); add("unclassified_income", net.neg());
      entry.warnings.push("DIVIDEND_BREAKDOWN_MISSING");
      if (fact.net_status === "provisional") entry.warnings.push("DIVIDEND_NET_PROVISIONAL");
      break;
    }
    case "dividend_breakdown": {
      const value = dividend(false);
      if (value.type !== "dividend_net" || value.breakdown_event_id) throw new Error("DIVIDEND_BREAKDOWN_ALREADY_RECORDED");
      const gross = positive(fact.gross_amount), net = positive(value.net_amount);
      if (fact.tax === undefined || tax.gt(gross) || !gross.sub(tax).eq(net)) throw new Error("DIVIDEND_BREAKDOWN_MISMATCH");
      add("unclassified_income", net); add("income", gross.neg()); add("expense", tax);
      break;
    }
    case "dividend_payment": {
      const value = dividend(), paid = positive(fact.amount), netCash = amount(value.net_cash).add(paid);
      if (netCash.gt(positive(value.gross_amount))) throw new Error("EXCEEDS_DIVIDEND_GROSS");
      add("cash_settled", paid); dividendBalances(value, netCash, amount(value.tax));
      break;
    }
    case "dividend_tax_assessment": {
      const value = dividend();
      if (!["estimated", "confirmed"].includes(fact.tax_status ?? "") || fact.tax === undefined) throw new Error("INVALID_DIVIDEND_TAX_STATUS");
      if (tax.gt(positive(value.gross_amount))) throw new Error("TAX_EXCEEDS_DIVIDEND");
      dividendBalances(value, amount(value.net_cash), tax); add("expense", tax.sub(value.tax));
      if (fact.tax_status !== "confirmed") entry.warnings.push("DIVIDEND_TAX_PROVISIONAL");
      break;
    }
    case "dividend_tax_payment": {
      const value = dividend(), paid = positive(fact.amount);
      if (paid.gt(amount(value.tax_payable).neg())) throw new Error("EXCEEDS_OUTSTANDING");
      add("cash_settled", paid.neg()); dividendBalances(value, amount(value.net_cash).sub(paid), amount(value.tax));
      break;
    }
    case "corporate_action_notice": {
      if (!["dividend_entitlement", "merger", "liquidation", "return_of_capital", "other"].includes(fact.action_kind ?? "")) throw new Error("INVALID_CORPORATE_ACTION_NOTICE");
      entry.warnings.push("CORPORATE_ACTION_UNRESOLVED");
      break;
    }
    case "corporate_action_resolution": {
      if (!fact.related_event_id || !state.notice || state.notice.account_id !== fact.account_id || state.notice.currency !== fact.currency) throw new Error("INVALID_CORPORATE_ACTION_RESOLUTION");
      if (state.notice.resolved) throw new Error("CORPORATE_ACTION_ALREADY_RESOLVED");
      const support = fact.supporting_event_ids;
      if (!Array.isArray(support) || new Set(support).size !== support.length || (fact.resolution === "not_applicable" ? support.length !== 0 : fact.resolution !== "recorded" || support.length === 0)) throw new Error("INVALID_CORPORATE_ACTION_RESOLUTION");
      break;
    }
    case "fee": {
      const value = positive(fact.amount);
      add("cash_settled", value.neg()); add("expense", value);
      break;
    }
    case "fx": {
      const sent = positive(fact.amount), received = positive(fact.received_amount);
      const target = fact.target_currency;
      if (!target || !/^[A-Z]{3}$/.test(target) || target === fact.currency) throw new Error("INVALID_FX_CURRENCY");
      const account = fact.target_account_id ?? fact.account_id;
      add("cash_settled", sent.add(fee).neg()); add("fx_bridge", sent); add("expense", fee);
      add("cash_settled", received, account, target); add("fx_bridge", received.neg(), account, target);
      break;
    }
    case "transfer_out": {
      if (!fact.target_account_id || fact.target_account_id === fact.account_id) throw new Error("TRANSFER_TARGET_REQUIRED");
      const value = positive(fact.amount);
      add("cash_settled", value.add(fee).neg()); add("transfer_in_transit", value); add("expense", fee);
      break;
    }
    case "transfer_in": {
      const { r, value } = related(["transfer_out"]);
      if (r.target_account_id !== fact.account_id) throw new Error("TRANSFER_TARGET_MISMATCH");
      add("cash_settled", value); add("transfer_in_transit", value.neg(), r.account_id);
      break;
    }
    case "split": {
      const pos = state.position;
      const lots = state.transit_positions ?? [];
      if ((!pos && !lots.length) || (pos && pos.currency !== fact.currency)) throw new Error("POSITION_HISTORY_REQUIRED");
      const ratio = positive(fact.split_numerator).div(positive(fact.split_denominator));
      if (pos) move(amount(pos.quantity).mul(ratio).sub(pos.quantity), new Decimal(0), pos.cost_known);
      for (const lot of lots) {
        if (lot.source_account_id !== fact.account_id || lot.listing_id !== fact.listing_id || lot.currency !== fact.currency) throw new Error("INVALID_SECURITY_TRANSFER");
        transit(lot, amount(lot.quantity).mul(ratio).sub(lot.quantity), new Decimal(0));
      }
      break;
    }
    default: throw new Error("UNSUPPORTED_EVENT_TYPE");
  }
  validateEntry(entry);
  return entry;
}

export function validateEntry(entry: Entry): void {
  const totals = new Map<string, Decimal>();
  for (const p of entry.postings) totals.set(p.currency, (totals.get(p.currency) ?? new Decimal(0)).add(amount(p.amount)));
  if ([...totals.values()].some(v => !v.isZero())) throw new Error("UNBALANCED_EVENT");
  for (const m of entry.movements) { amount(m.quantity); amount(m.cost_amount); }
  for (const m of entry.transits ?? []) { amount(m.quantity); amount(m.cost_amount); }
}
