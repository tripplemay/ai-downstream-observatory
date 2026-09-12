import type Database from "better-sqlite3";
import { amount, Decimal, exact } from "../ledger/decimal";
import { getActiveLedgerEvents, revision, type LedgerCommand } from "../ledger/service";
import { assertWritableDatabase } from "../workbench-db";
import { activeLinks, allLinks, currentPlan, executionItems, fundingClock, fundingHead, localDate, receiptFacts, requireFundingActor, resources, type ReceiptFact } from "./core";
import type { FundingActor, FundingOptions, FundingPlan } from "./schemas";

export function receiptIssue(plan: FundingPlan, source: FundingPlan["sources"][number], fact: ReceiptFact | undefined): string | null {
  if (!fact) return "FUNDING_RECEIPT_SUPERSEDED";
  if (source.currency !== fact.currency) return "FUNDING_CURRENCY_MISMATCH";
  if (source.account_id && source.account_id !== fact.account_id) return "ACCOUNT_OUT_OF_SCOPE";
  if (source.kind === "contribution" && fact.event_type !== "deposit") return "FUNDING_RECEIPT_TYPE_MISMATCH";
  if (fact.time_precision === "date" && fact.source_timezone !== plan.timezone) return "FUNDING_DATE_SCOPE_UNCERTAIN";
  const date = fact.time_precision === "date" ? fact.effective_at : localDate(fact.effective_at, plan.timezone);
  return date < source.period_start || date > source.period_end ? "FUNDING_RECEIPT_OUTSIDE_PERIOD" : null;
}
export function readFundingState(db: Database.Database, portfolio: string, now: string) {
  const ledgerRevision = revision(db, portfolio), head = fundingHead(db, portfolio), current = currentPlan(db, portfolio);
  const links = allLinks(db, portfolio), active = activeLinks(links), facts = receiptFacts(db, portfolio), resource = resources(db, portfolio);
  const allExecution = executionItems(db, portfolio), factEvents = getActiveLedgerEvents(db, portfolio);
  const executionEvidence = db.prepare("SELECT object_id event_id,json_extract(payload_json,'$.proposal_item_id') proposal_item_id FROM audit_events WHERE portfolio_id=? AND action='execution_fact_link' AND object_type='ledger_event' ORDER BY created_at,id").all(portfolio) as { event_id: string; proposal_item_id: string }[];
  const correctionPairs = db.prepare("SELECT json_extract(j.value,'$.original_event_id') original_event_id,json_extract(j.value,'$.event_id') event_id FROM audit_events a,json_each(a.payload_json,'$.replacements') j WHERE a.portfolio_id=? AND a.action='correct_ledger' AND a.object_type='portfolio' AND a.object_id=?").all(portfolio, portfolio) as { original_event_id: string; event_id: string }[];
  const replacements = new Map(correctionPairs.map(pair => [pair.original_event_id, pair.event_id]));
  const activeEventIds = new Set(factEvents.map(event => event.id));
  const explicitlyRelinked = (original: string, proposalItem: string) => {
    const seen = new Set<string>(); let id = original;
    while (replacements.has(id) && !seen.has(id)) {
      seen.add(id); id = replacements.get(id)!;
      if (activeEventIds.has(id)) return executionEvidence.some(row => row.event_id === id && row.proposal_item_id === proposalItem);
    }
    return false;
  };
  const currentItems = new Map(current?.items.map(item => [item.logical_id, item]) ?? []);
  const isActive = new Set(active.map(link => link.id));
  const displayLinks = links.filter(link => link.action.endsWith("_attach")).map(link => {
    const kind = link.action === "receipt_attach" ? "receipt" as const : "execution" as const;
    const source = current?.plan.sources.find(source => source.id === link.logical_id);
    const item = currentItems.get(link.logical_id);
    const issue = !item ? "FUNDING_ITEM_MISSING" : kind === "receipt"
      ? source && current ? receiptIssue(current.plan, source, facts.find(fact => fact.id === link.ledger_event_id)) : "FUNDING_ITEM_MISSING"
      : !allExecution.some(item => item.id === link.proposal_item_id) ? "FUNDING_EXECUTION_OUT_OF_SCOPE" : null;
    return { id: link.id, kind, source_id: kind === "receipt" ? link.logical_id : null, tranche_id: kind === "execution" ? link.logical_id : null, ledger_event_id: link.ledger_event_id, proposal_item_id: link.proposal_item_id, status: !isActive.has(link.id) ? "released" as const : issue ? "needs_review" as const : "active" as const, issue, amount: link.amount, currency: link.currency, reason: link.reason, created_at: link.created_at };
  });
  const today = current ? localDate(now, current.plan.timezone) : null;
  const sources = (current?.plan.sources ?? []).map(source => {
    const relevant = displayLinks.filter(link => link.source_id === source.id && link.status !== "released");
    const matching = relevant.filter(link => link.status === "active");
    const matched = matching.reduce((total, link) => total.add(link.amount!), amount("0"));
    const opening = matching.filter(link => facts.find(fact => fact.id === link.ledger_event_id)?.event_type === "opening_cash").reduce((total, link) => total.add(link.amount!), amount("0"));
    const assigned = current!.plan.tranches.filter(tranche => tranche.source_id === source.id && tranche.status !== "cancelled").reduce((sum, tranche) => sum.add(tranche.planned_amount), amount("0"));
    const remaining = Decimal.max(amount(source.planned_amount).sub(matched), amount("0"));
    return { ...source, matched_amount: exact(matched), opening_amount: exact(opening), contribution_amount: exact(matched.sub(opening)), arrival_remaining: exact(remaining), excess_arrival: exact(Decimal.max(matched.sub(source.planned_amount), amount("0"))), assigned_amount: exact(assigned), planned_unallocated: exact(amount(source.planned_amount).sub(assigned)), needs_review_count: relevant.filter(link => link.status === "needs_review").length,
      due_status: source.status === "cancelled" ? "cancelled" : remaining.isZero() ? "funded" : !source.expected_arrival_date ? "needs_schedule" : source.expected_arrival_date < today! ? "overdue" : source.expected_arrival_date === today ? "due" : "planned" };
  });
  const tranches = (current?.plan.tranches ?? []).map(tranche => {
    const itemIds = active.filter(link => link.action === "execution_attach" && link.logical_id === tranche.id).map(link => link.proposal_item_id!);
    const reserved = resource.reservations.filter(row => itemIds.includes(row.proposal_item_id) && row.status === "active").reduce((sum, row) => sum.add(row.amount), amount("0"));
    const evidence = executionEvidence.filter(row => itemIds.includes(row.proposal_item_id));
    const missing = evidence.filter(row => !activeEventIds.has(row.event_id) && !explicitlyRelinked(row.event_id, row.proposal_item_id));
    const executed = evidence.reduce((sum, row) => {
      const event = factEvents.find(event => event.id === row.event_id);
      if (!event) return sum;
      const fact = (JSON.parse(event.payload_json) as LedgerCommand).fact;
      return fact.type === "buy" ? sum.add(fact.consideration ?? amount(fact.price).mul(amount(fact.quantity))).add(fact.fee ?? "0") : sum;
    }, amount("0"));
    const excess = Decimal.max(executed.add(reserved).sub(tranche.planned_amount), amount("0"));
    const executionStatus = missing.length ? "needs_review" : excess.gt(0) ? "over_budget" : tranche.status === "cancelled" && executed.gt(0) ? "cancelled_with_execution" : amount(tranche.planned_amount).gt(0) && executed.gte(tranche.planned_amount) ? "budget_executed" : executed.gt(0) ? "partially_executed" : reserved.gt(0) ? "reserved" : "unallocated";
    return { ...tranche, currency: current!.plan.sources.find(source => source.id === tranche.source_id)!.currency, active_reservations: exact(reserved), executed_amount: exact(executed), budget_excess: exact(excess), execution_status: executionStatus, needs_review_count: missing.length,
      due_status: tranche.status === "cancelled" ? "cancelled" : missing.length ? "needs_review" : !tranche.invest_by ? "needs_schedule" : tranche.invest_by < today! ? "overdue" : tranche.invest_by === today ? "due" : "planned" };
  });
  const matchable = facts.map(fact => {
    const used = active.filter(link => link.ledger_event_id === fact.id).reduce((sum, link) => sum.add(link.amount!), amount("0"));
    return { ...fact, remaining_amount: exact(amount(fact.amount).sub(used)) };
  });
  const versions = db.prepare("SELECT id,version,plan_json,content_hash,created_at FROM funding_plan_versions WHERE portfolio_id=? ORDER BY version DESC LIMIT 50").all(portfolio) as { id: string; version: number; plan_json: string; content_hash: string; created_at: string }[];
  let readOnly = db.readonly;
  try { assertWritableDatabase(db); } catch (error) { if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") readOnly = true; else throw error; }
  const warnings = ["PLANNING_IS_NOT_CASH", "ACCOUNT_CASH_IS_FUNGIBLE_ACROSS_PLAN_BATCHES", "FUNDING_VIEW_IS_NOT_TRADING_PERMISSION"];
  if (!current && versions.length) warnings.push("LEGACY_RELATIVE_PLAN_REQUIRES_REVIEW");
  if (displayLinks.some(link => link.status === "needs_review") || tranches.some(tranche => tranche.needs_review_count)) warnings.push("FUNDING_LINKS_REQUIRE_REVIEW");
  if (tranches.some(tranche => amount(tranche.budget_excess).gt(0))) warnings.push("FUNDING_TRANCHE_OVER_BUDGET");
  if (tranches.some(tranche => tranche.status === "cancelled" && amount(tranche.executed_amount).gt(0))) warnings.push("CANCELLED_TRANCHE_HAS_EXECUTED_FACTS");
  return {
    portfolio_id: portfolio, ledger_revision: ledgerRevision, funding_revision: head?.revision ?? 0, read_only: readOnly, resources_hash: resource.hash,
    plan_status: current ? "confirmed_plan" as const : versions.length ? "needs_review" as const : "not_configured" as const,
    plan: current?.plan ?? null, versions: versions.map(({ plan_json, ...row }) => ({ ...row, plan: JSON.parse(plan_json) as unknown })),
    sources, tranches, links: displayLinks.slice(-1000).reverse(), link_history: links.slice(-1000).reverse(),
    matchable_facts: matchable.slice(-200).reverse(), accounts: resource.accounts, account_cash: resource.cash,
    execution_items: allExecution.slice(0, 200).map(item => ({ ...item, linked_tranche_id: active.find(link => link.proposal_item_id === item.id)?.logical_id ?? null })),
    warnings, totals: { links: displayLinks.length, matchable_facts: matchable.length, execution_items: allExecution.length },
    limits: { versions: 50, links: 1000, matchable_facts: 200, execution_items: 200 },
  };
}
export function getFundingState(db: Database.Database, actor: FundingActor, portfolio: string, options: FundingOptions = {}) {
  requireFundingActor(actor, false);
  const now = fundingClock(options);
  return db.transaction(() => readFundingState(db, portfolio, now)).deferred();
}
export type FundingState = ReturnType<typeof getFundingState>;
