import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { amount } from "../ledger/decimal";
import { canonical, hash } from "../ledger/service";
import { activeLinks, allLinks, currentPlan, executionItems, fundingTransaction, insertLink, localDate, receiptFacts, resources, type Item } from "./core";
import { readFundingState, receiptIssue } from "./state";
import { deferSchema, executionSchema, publishSchema, receiptSchema, unlinkSchema, type FundingActor, type FundingOptions, type FundingPlan } from "./schemas";
export { getFundingState, type FundingState } from "./state";
export { fundingPlanSchema, type FundingActor, type FundingOptions, type FundingPlan } from "./schemas";

function requirePlan(db: Database.Database, portfolio: string) {
  const current = currentPlan(db, portfolio);
  if (!current) throw new Error("FUNDING_PLAN_REVIEW_REQUIRED");
  return current;
}
function activeExecution(db: Database.Database, portfolio: string, logicalId: string) {
  const itemIds = activeLinks(allLinks(db, portfolio)).filter(link => link.action === "execution_attach" && link.logical_id === logicalId).map(link => link.proposal_item_id);
  return resources(db, portfolio).reservations.some(row => itemIds.includes(row.proposal_item_id) && row.status === "active" && (amount(row.amount).gt(0) || amount(row.quantity).gt(0)));
}
function validatePlan(db: Database.Database, portfolio: string, plan: FundingPlan, acknowledged: boolean, now: string) {
  const previous = currentPlan(db, portfolio), links = activeLinks(allLinks(db, portfolio)), facts = receiptFacts(db, portfolio);
  const priorUsage = previous ? readFundingState(db, portfolio, now).tranches : [];
  const ids = [...plan.sources, ...plan.tranches].map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("FUNDING_DUPLICATE_ITEM");
  for (const item of [...plan.sources, ...plan.tranches]) if (item.account_id && !db.prepare("SELECT id FROM accounts WHERE id=? AND portfolio_id=?").get(item.account_id, portfolio)) throw new Error("ACCOUNT_OUT_OF_SCOPE");
  for (const source of plan.sources) {
    if (source.period_start > source.period_end || (source.expected_arrival_date && (source.expected_arrival_date < source.period_start || source.expected_arrival_date > source.period_end))) throw new Error("FUNDING_INVALID_PERIOD");
    const tranches = plan.tranches.filter(tranche => tranche.source_id === source.id && tranche.status !== "cancelled");
    if (source.status === "cancelled" && tranches.length) throw new Error("FUNDING_CANCEL_DEPENDENCIES");
    if (tranches.reduce((sum, tranche) => sum.add(tranche.planned_amount), amount("0")).gt(source.planned_amount)) throw new Error("FUNDING_TRANCHE_BUDGET_EXCEEDED");
    const receipts = links.filter(link => link.action === "receipt_attach" && link.logical_id === source.id);
    for (const link of receipts) {
      const fact = facts.find(fact => fact.id === link.ledger_event_id);
      if (fact && receiptIssue(plan, source, fact)) throw new Error("FUNDING_LINKED_ITEM_CHANGED");
    }
    const matched = receipts.filter(link => facts.some(fact => fact.id === link.ledger_event_id)).reduce((sum, link) => sum.add(link.amount!), amount("0"));
    if ((matched.gt(source.planned_amount) || (source.status === "cancelled" && matched.gt(0))) && !acknowledged) throw new Error("FUNDING_ACKNOWLEDGEMENT_REQUIRED");
  }
  for (const tranche of plan.tranches) {
    const source = plan.sources.find(source => source.id === tranche.source_id);
    if (!source || (tranche.invest_by && tranche.invest_by < source.period_start)) throw new Error("FUNDING_INVALID_SOURCE");
    const execution = links.filter(link => link.action === "execution_attach" && link.logical_id === tranche.id);
    for (const link of execution) {
      const item = executionItems(db, portfolio).find(item => item.id === link.proposal_item_id);
      if (!item || source.currency !== item.currency || (tranche.account_id && tranche.account_id !== item.account_id)) throw new Error("FUNDING_LINKED_ITEM_CHANGED");
    }
    if (tranche.status === "cancelled" && activeExecution(db, portfolio, tranche.id)) throw new Error("FUNDING_ACTIVE_EXECUTION");
    const usage = priorUsage.find(value => value.id === tranche.id);
    if (usage && !acknowledged && ((amount(tranche.planned_amount).lt(usage.planned_amount) && amount(usage.executed_amount).add(usage.active_reservations).gt(tranche.planned_amount)) || (tranche.status === "cancelled" && usage.status !== "cancelled" && amount(usage.executed_amount).gt(0)))) throw new Error("FUNDING_ACKNOWLEDGEMENT_REQUIRED");
  }
  if (previous) for (const item of previous.items) {
    const next = item.kind === "source" ? plan.sources.find(value => value.id === item.logical_id) : plan.tranches.find(value => value.id === item.logical_id);
    if (!next) throw new Error("FUNDING_ITEM_REMOVAL_FORBIDDEN");
    if (item.kind === "tranche" && "source_id" in next && next.source_id !== item.parent_key && links.some(link => link.logical_id === item.logical_id)) throw new Error("FUNDING_LINKED_ITEM_CHANGED");
  }
}
function savePlan(db: Database.Database, actor: FundingActor, portfolio: string, plan: FundingPlan, now: string) {
  const id = randomUUID(), version = (db.prepare("SELECT COALESCE(MAX(version),0)+1 version FROM funding_plan_versions WHERE portfolio_id=?").get(portfolio) as { version: number }).version;
  db.prepare("INSERT INTO funding_plan_versions(id,portfolio_id,version,currency,plan_json,content_hash,actor_id,created_at) VALUES(?,?,?,'CNY',?,?,?,?)").run(id, portfolio, version, canonical(plan), hash(plan), actor.id, now);
  const insert = db.prepare("INSERT INTO funding_plan_items(id,portfolio_id,plan_version_id,logical_id,kind,parent_key,currency,planned_amount,item_json) VALUES(?,?,?,?,?,?,?,?,?)");
  for (const source of plan.sources) insert.run(randomUUID(), portfolio, id, source.id, "source", null, source.currency, source.planned_amount, canonical(source));
  for (const tranche of plan.tranches) insert.run(randomUUID(), portfolio, id, tranche.id, "tranche", tranche.source_id, plan.sources.find(source => source.id === tranche.source_id)!.currency, tranche.planned_amount, canonical(tranche));
  return { plan_version_id: id, version };
}
export function publishFundingPlanVersion(db: Database.Database, actor: FundingActor, raw: unknown, options: FundingOptions = {}) {
  const input = publishSchema.parse(raw);
  return fundingTransaction(db, actor, "publish_plan", input, options, ({ now }) => {
    validatePlan(db, input.portfolio_id, input.plan, input.acknowledge_shortfall, now);
    return savePlan(db, actor, input.portfolio_id, input.plan, now);
  });
}
export function deferFundingTranche(db: Database.Database, actor: FundingActor, raw: unknown, options: FundingOptions = {}) {
  const input = deferSchema.parse(raw);
  return fundingTransaction(db, actor, "defer_tranche", input, options, ({ now }) => {
    const { plan } = requirePlan(db, input.portfolio_id), tranche = plan.tranches.find(tranche => tranche.id === input.tranche_id);
    if (!tranche || tranche.status === "cancelled") throw new Error("FUNDING_ITEM_OUT_OF_SCOPE");
    if (input.invest_by <= localDate(now, plan.timezone) || (tranche.invest_by && input.invest_by <= tranche.invest_by)) throw new Error("FUNDING_DEFER_MUST_BE_FUTURE");
    const next = { ...plan, tranches: plan.tranches.map(value => value.id === tranche.id ? { ...value, invest_by: input.invest_by, unspent_action: input.unspent_action } : value) };
    validatePlan(db, input.portfolio_id, next, true, now);
    return { ...savePlan(db, actor, input.portfolio_id, next, now), previous_invest_by: tranche.invest_by, invest_by: input.invest_by };
  });
}
export function linkFundingReceipt(db: Database.Database, actor: FundingActor, raw: unknown, options: FundingOptions = {}) {
  const input = receiptSchema.parse(raw);
  return fundingTransaction(db, actor, "link_receipt", input, options, ({ now, next }) => {
    const current = requirePlan(db, input.portfolio_id), source = current.plan.sources.find(source => source.id === input.source_id);
    if (!source || source.status === "cancelled") throw new Error("FUNDING_ITEM_OUT_OF_SCOPE");
    const fact = receiptFacts(db, input.portfolio_id).find(fact => fact.id === input.ledger_event_id);
    const issue = receiptIssue(current.plan, source, fact); if (issue) throw new Error(issue);
    if (!amount(input.amount).gt(0)) throw new Error("FUNDING_POSITIVE_AMOUNT_REQUIRED");
    const linked = activeLinks(allLinks(db, input.portfolio_id)).filter(link => link.ledger_event_id === fact!.id).reduce((sum, link) => sum.add(link.amount!), amount("0"));
    if (linked.add(input.amount).gt(fact!.amount)) throw new Error("FUNDING_RECEIPT_OVERALLOCATED");
    const id = insertLink(db, actor, input, current.items.find(item => item.logical_id === source.id)!, { action: "receipt_attach", ledger_event_id: fact!.id, amount: input.amount }, next, now);
    return { id, plan_version_id: current.row.id };
  });
}
export function linkFundingExecution(db: Database.Database, actor: FundingActor, raw: unknown, options: FundingOptions = {}) {
  const input = executionSchema.parse(raw);
  return fundingTransaction(db, actor, "link_execution", input, options, ({ now, next }) => {
    const current = requirePlan(db, input.portfolio_id), tranche = current.plan.tranches.find(tranche => tranche.id === input.tranche_id);
    if (!tranche || tranche.status === "cancelled") throw new Error("FUNDING_ITEM_OUT_OF_SCOPE");
    const source = current.plan.sources.find(source => source.id === tranche.source_id)!;
    if (source.status === "cancelled") throw new Error("FUNDING_ITEM_OUT_OF_SCOPE");
    if (resources(db, input.portfolio_id).hash !== input.expected_resources_hash) throw new Error("RESOURCE_CONFLICT");
    const item = executionItems(db, input.portfolio_id).find(item => item.id === input.proposal_item_id);
    if (!item || (tranche.account_id && item.account_id !== tranche.account_id)) throw new Error("FUNDING_EXECUTION_OUT_OF_SCOPE");
    if (item.currency !== source.currency) throw new Error("FUNDING_CURRENCY_MISMATCH");
    if (activeLinks(allLinks(db, input.portfolio_id)).some(link => link.proposal_item_id === item.id)) throw new Error("FUNDING_EXECUTION_ALREADY_LINKED");
    const id = insertLink(db, actor, input, current.items.find(value => value.logical_id === tranche.id)!, { action: "execution_attach", proposal_item_id: item.id }, next, now);
    return { id, plan_version_id: current.row.id };
  });
}
function unlink(db: Database.Database, actor: FundingActor, raw: unknown, kind: "receipt" | "execution", options: FundingOptions) {
  const input = unlinkSchema.parse(raw);
  return fundingTransaction(db, actor, `unlink_${kind}`, input, options, ({ now, next }) => {
    const current = requirePlan(db, input.portfolio_id), links = allLinks(db, input.portfolio_id), link = links.find(link => link.id === input.link_id && link.action === `${kind}_attach`);
    if (!link) throw new Error("FUNDING_LINK_OUT_OF_SCOPE");
    if (!activeLinks(links).some(row => row.id === link.id)) throw new Error("FUNDING_LINK_ALREADY_RELEASED");
    if (kind === "execution" && resources(db, input.portfolio_id).reservations.some(row => row.proposal_item_id === link.proposal_item_id && row.status === "active" && (amount(row.amount).gt(0) || amount(row.quantity).gt(0)))) throw new Error("FUNDING_ACTIVE_EXECUTION");
    const item = db.prepare("SELECT * FROM funding_plan_items WHERE id=? AND portfolio_id=?").get(link.plan_item_id, input.portfolio_id) as Item;
    const id = insertLink(db, actor, input, item, { action: kind === "receipt" ? "receipt_detach" : "execution_detach", ledger_event_id: link.ledger_event_id, proposal_item_id: link.proposal_item_id, amount: link.amount, reverses_link_id: link.id }, next, now);
    return { id, plan_version_id: current.row.id, released_link_id: link.id };
  });
}
export function unlinkFundingReceipt(db: Database.Database, actor: FundingActor, raw: unknown, options: FundingOptions = {}) { return unlink(db, actor, raw, "receipt", options); }
export function unlinkFundingExecution(db: Database.Database, actor: FundingActor, raw: unknown, options: FundingOptions = {}) { return unlink(db, actor, raw, "execution", options); }

const errors = new Set(["UNAUTHENTICATED", "WORKBENCH_READ_ONLY", "PORTFOLIO_NOT_FOUND", "ACCOUNT_OUT_OF_SCOPE", "DUPLICATE_CONFLICT", "INVALID_CLOCK", "DECIMAL_RANGE", "INVALID_LEDGER_LIABILITY", "INVALID_CASH_HOLD", "RESOURCE_CONFLICT", "FUNDING_PERMISSION_DENIED", "FUNDING_VERSION_CONFLICT", "FUNDING_PLAN_HASH_MISMATCH", "FUNDING_PLAN_REVIEW_REQUIRED", "FUNDING_DUPLICATE_ITEM", "FUNDING_INVALID_PERIOD", "FUNDING_INVALID_SOURCE", "FUNDING_CANCEL_DEPENDENCIES", "FUNDING_TRANCHE_BUDGET_EXCEEDED", "FUNDING_LINKED_ITEM_CHANGED", "FUNDING_ACKNOWLEDGEMENT_REQUIRED", "FUNDING_ACTIVE_EXECUTION", "FUNDING_ITEM_REMOVAL_FORBIDDEN", "FUNDING_ITEM_OUT_OF_SCOPE", "FUNDING_DEFER_MUST_BE_FUTURE", "FUNDING_RECEIPT_SUPERSEDED", "FUNDING_CURRENCY_MISMATCH", "FUNDING_RECEIPT_TYPE_MISMATCH", "FUNDING_DATE_SCOPE_UNCERTAIN", "FUNDING_RECEIPT_OUTSIDE_PERIOD", "FUNDING_POSITIVE_AMOUNT_REQUIRED", "FUNDING_RECEIPT_OVERALLOCATED", "FUNDING_EXECUTION_OUT_OF_SCOPE", "FUNDING_EXECUTION_ALREADY_LINKED", "FUNDING_LINK_OUT_OF_SCOPE", "FUNDING_LINK_ALREADY_RELEASED"]);
export const isFundingClientError = (code: string) => errors.has(code);
