import { Decimal } from "../ledger/decimal";
import { hash } from "../ledger/service";
import { economicInstant, economicStamp, economicText, requireEconomic, type ContinuousDataset } from "./continuous-market";

type Obj = Record<string, unknown>;
export type ReviewLinks = { allowSales?: boolean; originReviewId?: string; replacesOrderIds?: string[] };
type ReviewOrder = ReviewLinks & { id: string; listing: string; side: "buy" | "sell"; budget: Decimal; state: string };
type Row = { id: string; created_at: string; status: string; allow_sales: boolean; action_ids: string[];
  listing_ids: string[]; fresh_after: Record<string, string>; cancelled_order_ids: string[]; last_cancelled_order_ids: string[];
  replacement_order_ids: string[]; current_replacement_order_ids: string[]; failure_order_ids: string[];
  completed_at: string | null; completion_reason: string | null };

/** Independent lifecycle reconstruction; never mutates cash or an old order's economics. */
export class OrderReviews<T extends ReviewOrder> {
  private rows = new Map<string, Row>();
  private activeId: string | null = null;
  constructor(private orders: Map<string, T>, private events: Obj[], private weights: Record<string, string>) {}
  get active() { return this.activeId === null ? null : this.rows.get(this.activeId)!; }

  onActions(actions: ContinuousDataset["actions"], pending: T[], at: bigint,
    finish: (order: T, state: string, at: bigint, reason?: string, extra?: Obj) => void) {
    const affected = new Set(actions.map(action => action.listing_id));
    let row = this.active;
    if (pending.some(order => affected.has(order.listing))) {
      if (!row) {
        requireEconomic(pending.every(order => typeof order.allowSales === "boolean"));
        const id = `order-review:${String(this.rows.size + 1).padStart(6, "0")}`;
        row = { id, created_at: economicStamp(at), status: "pending_evaluation", allow_sales: pending.every(order => order.allowSales),
          action_ids: [], listing_ids: [...new Set(pending.map(order => order.listing))].sort(), fresh_after: {},
          cancelled_order_ids: [], last_cancelled_order_ids: [], replacement_order_ids: [], current_replacement_order_ids: [],
          failure_order_ids: [], completed_at: null, completion_reason: null };
        this.rows.set(id, row); this.activeId = id;
      }
      requireEconomic(pending.every(order => !order.originReviewId || order.originReviewId === row!.id), "ORDER_REVIEW_BATCH_SCOPE_INVALID");
      const batch = [...pending]; row.last_cancelled_order_ids = batch.map(order => order.id);
      row.cancelled_order_ids.push(...row.last_cancelled_order_ids); row.current_replacement_order_ids = [];
      if (row.status !== "failed") row.status = "pending_evaluation";
      for (const order of batch) finish(order, "skipped", at, affected.has(order.listing)
        ? "CORPORATE_ACTION_INVALIDATES_FROZEN_ORDER" : "BATCH_CANCELLED_AFTER_CORPORATE_ACTION", {
          cancellation_review_id: row.id, action_ids: actions.map(action => action.id).sort(),
          released_reservation_cny: economicText(order.side === "buy" && order.state === "scheduled" ? order.budget : new Decimal(0)),
        });
      this.events.push({ type: "order_review_requested", at: economicStamp(at), review_id: row.id, cancelled_order_ids: [...row.last_cancelled_order_ids] });
    }
    if (row) for (const action of actions) {
      if (new Decimal(this.weights[action.listing_id] ?? "0").lte(0)) continue;
      if (!row.action_ids.includes(action.id)) row.action_ids.push(action.id);
      const previous = row.fresh_after[action.listing_id], after = economicInstant(action.at);
      if (!previous || economicInstant(previous) < after) row.fresh_after[action.listing_id] = economicStamp(after);
    }
  }

  requireFresh(quotes: Map<string, readonly unknown[]>, at: bigint) {
    const row = this.active; if (!row) return;
    requireEconomic(row.status === "pending_evaluation", row.status === "failed" ? "ORDER_REVIEW_TERMINAL_FAILURE" : "ORDER_REVIEW_REPLACEMENT_PENDING");
    for (const [listing, after] of Object.entries(row.fresh_after)) {
      const evidence = quotes.get(listing)?.[4] as Obj | undefined;
      requireEconomic(evidence && at > economicInstant(after) && economicInstant(evidence.quote_observed_at as string) >= economicInstant(after),
        "ORDER_REVIEW_REQUIRES_POST_ACTION_CLOSE:" + listing);
    }
  }

  publish(planned: T[], at: bigint) {
    const row = this.active; if (!row) return;
    requireEconomic(row.status === "pending_evaluation" && planned.length > 0, "ORDER_REVIEW_PROPOSAL_INVALID");
    for (const order of planned) { order.originReviewId = row.id; order.replacesOrderIds = [...row.last_cancelled_order_ids]; }
    row.current_replacement_order_ids = planned.map(order => order.id); row.replacement_order_ids.push(...row.current_replacement_order_ids);
    row.status = "awaiting_replacement";
    this.events.push({ type: "order_review_reproposal", at: economicStamp(at), review_id: row.id,
      order_ids: [...row.current_replacement_order_ids], replaces_order_ids: [...row.last_cancelled_order_ids] });
  }

  failed(order: T, at: bigint) {
    if (!order.originReviewId) return;
    const row = this.rows.get(order.originReviewId)!; row.status = "failed"; row.failure_order_ids.push(order.id);
    this.events.push({ type: "order_review_failed", at: economicStamp(at), review_id: row.id, order_id: order.id });
  }

  complete(at: bigint, withinTolerance = false, noSalesRepairSatisfied = false) {
    const row = this.active; if (!row || row.status === "failed") return;
    requireEconomic(!noSalesRepairSatisfied || withinTolerance && !row.allow_sales, "ORDER_REVIEW_COMPLETION_INVALID");
    if (withinTolerance) requireEconomic(row.status === "pending_evaluation", "ORDER_REVIEW_COMPLETION_INVALID");
    else if (row.status !== "awaiting_replacement" || !row.current_replacement_order_ids.length
      || row.current_replacement_order_ids.some(id => !["filled", "settled"].includes(this.orders.get(id)!.state))) return;
    row.status = "resolved"; row.completed_at = economicStamp(at);
    row.completion_reason = noSalesRepairSatisfied ? "no_sales_repair_no_longer_needed" : withinTolerance ? "targets_within_tolerance" : "replacement_orders_filled";
    this.events.push({ type: "order_review_resolved", at: economicStamp(at), review_id: row.id, reason: row.completion_reason });
    this.activeId = null;
  }

  result(rawFailures: number) {
    const cancellations = this.events.filter(event => event.type === "execution_skipped" && "cancellation_review_id" in event);
    const resolved = cancellations.filter(event => this.rows.get(event.cancellation_review_id as string)!.status === "resolved").length;
    const lineageTypes = new Set(["research_order", "execution_skipped", "order_expired", "simulated_buy", "simulated_sell", "stock_settlement", "sale_cash_settlement", "order_cash_reserved", "policy_deployment_failed"]);
    const lineage = this.events.filter(event => lineageTypes.has(event.type as string) || (event.type as string).startsWith("order_review_"))
      .map(event => Object.fromEntries(Object.entries(event).filter(([key]) => key !== "decision_price_mark")));
    return { terminal_execution_failure_count: rawFailures - resolved, corporate_action_cancellation_count: cancellations.length,
      resolved_corporate_action_cancellation_count: resolved, unresolved_order_review_count: [...this.rows.values()].filter(row => row.status !== "resolved").length,
      order_review_lineage_hash: hash({ events: lineage, reviews: [...this.rows.values()] }),
      order_reviews: [...this.rows.values()] };
  }
}
