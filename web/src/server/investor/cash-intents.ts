import { Decimal } from "../ledger/decimal";
import { hash } from "../ledger/service";
import { economicInstant, economicStamp, requireEconomic } from "./continuous-market";
import { OrderReviews, type ReviewLinks } from "./order-reviews";

type Obj = Record<string, unknown>;
export type CashIntentLinks = { cashIntentId?: string; settledAt?: string };
type Order = ReviewLinks & CashIntentLinks & { id: string; listing: string; side: "buy" | "sell"; budget: Decimal; state: string; expiry: bigint };
type Declaration = { id: string; declared_at: string; deadline: string; policy_hash: string; sale_order_ids: string[]; buy_listing_ids: string[] };
type Row = { declaration: Declaration; declaration_hash: string; state: string; current_sale_order_ids: string[];
  buy_order_ids: string[]; current_buy_order_ids: string[]; prepared_hash: string | null; completed_at: string | null; reason: string | null };

/** Reconstruct current dependency leaves from preserved cancellations/replacements, never projected receipts. */
export class CashIntents<T extends Order> {
  private rows = new Map<string, Row>();
  private activeId: string | null = null;
  constructor(private orders: Map<string, T>, private events: Obj[], private reviews: OrderReviews<T>, private policyHash: string) {}
  get active() { return this.activeId === null ? null : this.rows.get(this.activeId)!; }

  declare(sales: string[], buyScope: string[], at: bigint, deadline: bigint) {
    requireEconomic(!this.active && sales.length && buyScope.length && at < deadline, "CASH_INTENT_DECLARATION_INVALID");
    const id = `cash-intent:${String(this.rows.size + 1).padStart(6, "0")}`;
    const declaration: Declaration = { id, declared_at: economicStamp(at), deadline: economicStamp(deadline),
      policy_hash: this.policyHash, sale_order_ids: [...sales], buy_listing_ids: [...buyScope].sort() };
    const row: Row = { declaration, declaration_hash: hash(declaration), state: "waiting_sales", current_sale_order_ids: [...sales],
      buy_order_ids: [], current_buy_order_ids: [], prepared_hash: null, completed_at: null, reason: null };
    this.rows.set(id, row); this.activeId = id;
    for (const key of sales) this.orders.get(key)!.cashIntentId = id;
    this.events.push({ type: "cash_intent_declared", at: economicStamp(at), declaration: structuredClone(declaration), declaration_hash: row.declaration_hash });
  }

  bindReplacements(planned: T[], at: bigint) {
    const row = this.active; if (!row) return;
    const side = ["waiting_sales", "waiting_decision"].includes(row.state) ? "sell" : "buy";
    requireEconomic(["waiting_sales", "waiting_decision", "buy_published"].includes(row.state)
      && planned.every(order => order.side === side && !!order.originReviewId), "CASH_INTENT_REPLACEMENT_SCOPE_INVALID");
    for (const order of planned) {
      requireEconomic(order.expiry <= economicInstant(row.declaration.deadline), "CASH_INTENT_DEADLINE_EXTENDED");
      order.cashIntentId = row.declaration.id;
    }
    this.events.push({ type: "cash_intent_replacements_bound", at: economicStamp(at), intent_id: row.declaration.id,
      side, order_ids: planned.map(order => order.id) });
  }

  private leaves(row: Row, roots: string[], side: string): [boolean, string[]] {
    const seen = new Set<string>();
    const follow = (key: string, path: Set<string>): boolean => {
      requireEconomic(!path.has(key), "CASH_INTENT_LINEAGE_CYCLE");
      const order = this.orders.get(key)!;
      requireEconomic(order && order.cashIntentId === row.declaration.id && order.side === side, "CASH_INTENT_LINEAGE_SCOPE_INVALID");
      if (!["skipped", "expired"].includes(order.state)) { seen.add(key); return true; }
      const cancelled = this.events.find(event => event.type === "execution_skipped" && event.order_id === key && "cancellation_review_id" in event);
      if (!cancelled) return false;
      const review = this.reviews.getRow(cancelled.cancellation_review_id as string);
      requireEconomic(review, "CASH_INTENT_LINEAGE_SCOPE_INVALID");
      if (review.status === "failed") return false;
      const replacement = this.events.find(event => event.type === "order_review_reproposal" && event.review_id === review.id
        && (event.replaces_order_ids as string[]).includes(key));
      if (replacement) {
        const children = replacement.order_ids as string[];
        requireEconomic(children.length && children.every(child => this.orders.get(child)?.side === side), "CASH_INTENT_REPLACEMENT_SCOPE_INVALID");
        return children.map(child => follow(child, new Set([...path, key]))).every(Boolean);
      }
      if (review.status === "resolved" && ["targets_within_tolerance", "no_sales_repair_no_longer_needed", "sale_scope_no_longer_needed"].includes(review.completion_reason!)) return true;
      seen.add(key); return true;
    };
    return [roots.map(key => follow(key, new Set())).every(Boolean), [...seen].sort()];
  }

  refresh(at: bigint) {
    const row = this.active; if (!row || ["failed", "expired"].includes(row.state)) return;
    requireEconomic(hash(row.declaration) === row.declaration_hash, "CASH_INTENT_DECLARATION_CHANGED");
    if (at >= economicInstant(row.declaration.deadline)) {
      row.state = "expired"; row.reason = "CASH_INTENT_DEADLINE_REACHED";
      this.events.push({ type: "cash_intent_failed", at: economicStamp(at), intent_id: row.declaration.id, reason: row.reason }); return;
    }
    const buying = row.state === "buy_published";
    const [valid, leaves] = this.leaves(row, buying ? row.buy_order_ids : row.declaration.sale_order_ids, buying ? "buy" : "sell");
    if (buying) row.current_buy_order_ids = leaves; else row.current_sale_order_ids = leaves;
    if (!valid) {
      row.state = "failed"; row.reason = "CASH_INTENT_PUBLISHED_ORDER_FAILED";
      this.events.push({ type: "cash_intent_failed", at: economicStamp(at), intent_id: row.declaration.id, reason: row.reason });
    } else if (buying && leaves.every(key => ["filled", "settled"].includes(this.orders.get(key)!.state))) {
      this.resolve(at, leaves.length ? "buy_orders_completed" : "reviewed_buy_scope_no_longer_needed");
    } else if (!buying) row.state = leaves.every(key => this.orders.get(key)!.state === "settled") ? "waiting_decision" : "waiting_sales";
  }

  publish(planned: T[], preparation: Obj, at: bigint) {
    const row = this.active;
    requireEconomic(row && row.state === "waiting_decision" && planned.length && !row.buy_order_ids.length
      && planned.every(order => order.side === "buy"), "CASH_INTENT_BUY_ALREADY_PUBLISHED_OR_UNREADY");
    requireEconomic(preparation.intent_id === row.declaration.id && preparation.policy_hash === this.policyHash
      && preparation.decision_at === economicStamp(at) && preparation.published === false && preparation.live_advice_eligible === false
      && JSON.stringify(planned.map(order => order.id)) === JSON.stringify((preparation.orders as Obj[]).map(order => order.order_id)),
      "CASH_INTENT_PREPARATION_BINDING_INVALID");
    for (const order of planned) order.cashIntentId = row.declaration.id;
    row.state = "buy_published"; row.buy_order_ids = planned.map(order => order.id); row.prepared_hash = hash(preparation);
    this.events.push({ type: "cash_intent_buy_published", at: economicStamp(at), intent_id: row.declaration.id,
      preparation: structuredClone(preparation), preparation_hash: row.prepared_hash });
  }

  resolve(at: bigint, reason: string) {
    const row = this.active; requireEconomic(row && !["failed", "expired"].includes(row.state), "CASH_INTENT_COMPLETION_INVALID");
    row.state = "resolved"; row.completed_at = economicStamp(at); row.reason = reason;
    this.events.push({ type: "cash_intent_resolved", at: economicStamp(at), intent_id: row.declaration.id, reason }); this.activeId = null;
  }

  result() {
    const intents = [...this.rows.values()], events = this.events.filter(event => (event.type as string).startsWith("cash_intent_"));
    return { cash_intents: structuredClone(intents),
      pending_cash_intent_count: intents.filter(row => ["waiting_sales", "waiting_decision", "buy_published"].includes(row.state)).length,
      failed_cash_intent_count: intents.filter(row => ["failed", "expired"].includes(row.state)).length,
      cash_intent_lineage_hash: hash({ events, intents }) };
  }
}
