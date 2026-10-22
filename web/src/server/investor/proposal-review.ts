import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { canonical, hash, revision, type Actor } from "../ledger/service";
import { amount } from "../ledger/decimal";
import { parseStrictJson } from "../strict-json";
import { approvalSchema, prepareSchema, proposalRefSchema, proposalSchema } from "../governance/schemas";
import { reconciliationInstantMicros } from "../ledger/reconciliation-schemas";
import { checkRisk } from "../governance/risk";
import { approveProposal, cancelRemainder, expireProposal, prepareExecution, runRiskCheck, type GovernanceOptions } from "../governance/service";
import { getInvestorAccountWorkspace } from "./accounts";
import { proofObject, proposalEvidenceInvalid as invalid, readCreatedProposal, readGovernanceAudit } from "./proposal-evidence";
import { proposalReviewBasis, proposalReviewContextSchema, proposalReviewIntentSchema, proposalRiskSchema,
  type ProposalReviewContext, type ProposalReviewIntent } from "./proposal-review-schemas";

type Approval = { id: string; proposal_id: string; actor_id: string; action: string; expected_revision: number; input_hash: string; payload_json: string; created_at: string };
function bounded<T>(rows: T[], maximum: number): T[] { if (rows.length > maximum) throw new Error("INVESTOR_PROPOSAL_CAPACITY_REQUIRES_REVIEW"); return rows; }
function at(value: string) { const time = reconciliationInstantMicros(value); if (time === null) invalid(); return time; }
function selectedRisk(db: Database.Database, portfolio: string, proposal: string, now: string) {
  const row = db.prepare("SELECT * FROM risk_runs WHERE proposal_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(proposal) as
    { id: string; proposal_id: string; input_hash: string; status: string; checks_json: string; created_at: string } | undefined;
  if (!row) return null;
  const created = db.prepare("SELECT 1 FROM audit_events WHERE portfolio_id=? AND action='create_proposal' AND json_extract(payload_json,'$.result.risk.id')=? LIMIT 1").get(portfolio, row.id);
  const original = created ? readGovernanceAudit(db, portfolio, "create_proposal", "$.result.risk.id", row.id, proposalSchema)
    : readGovernanceAudit(db, portfolio, "run_risk_check", "$.result.id", row.id, proposalRefSchema);
  const result = created ? proofObject(original.result.risk) : original.result;
  const { id, ...risk } = result, payload = proofObject(parseStrictJson(row.checks_json));
  if (id !== row.id || original.audit.created_at !== row.created_at || row.created_at > now || row.status !== risk.status
    || row.input_hash !== risk.input_hash || canonical(payload) !== canonical({ checks: risk.checks, budgets: risk.budgets })
    || (!created && original.input.proposal_id !== proposal) || created && original.result.id !== proposal) invalid();
  return { row, original, risk: proposalRiskSchema.parse(risk) };
}
function approvalProof(db: Database.Database, portfolio: string, row: Approval, proposalHash: string, now: string) {
  const action = row.action === "approve" ? "approve_proposal" : row.action;
  const schema = row.action === "approve" ? approvalSchema : row.action === "prepare_execution" ? prepareSchema : proposalRefSchema;
  if (!["approve", "prepare_execution", "cancel_remainder", "expire"].includes(row.action) || row.created_at > now) invalid();
  const original = readGovernanceAudit(db, portfolio, action, "$.result.id", row.id, schema), input = original.input;
  const payload = proofObject(parseStrictJson(row.payload_json));
  if (input.proposal_id !== row.proposal_id || original.audit.actor_id !== row.actor_id || original.audit.created_at !== row.created_at
    || input.expected_revision !== row.expected_revision || input.reason !== payload.reason) invalid();
  if (row.action === "approve" && (input.expected_input_hash !== row.input_hash || input.risk_run_id !== payload.risk_run_id || payload.proposal_input_hash !== proposalHash)) invalid();
  if (row.action === "prepare_execution" && (input.approval_id !== payload.approval_id || payload.broker_order_sent !== false || original.result.broker_order_sent !== false)) invalid();
  if (["cancel_remainder", "expire"].includes(row.action) && (row.input_hash !== proposalHash || original.result.facts_changed !== false)) invalid();
  return { row, original };
}

/** Whole owned book, never a research-to-live conversion or an implicit risk/approval write. */
export function getInvestorProposalReviewContext(db: Database.Database, actor: Actor, proposalId: string | null = null,
  now = new Date().toISOString(), options: GovernanceOptions = {}): ProposalReviewContext {
  return db.transaction(() => {
    const accounts = getInvestorAccountWorkspace(db, actor, now), book = accounts.books.find(row => row.id === accounts.link?.document.portfolio_id);
    if (!book || !accounts.workspace_id || !accounts.link) throw new Error("INVESTOR_ACCOUNT_OUT_OF_SCOPE");
    const heads = bounded(db.prepare(`SELECT p.id,p.created_at,p.expires_at,
      EXISTS(SELECT 1 FROM reservations r JOIN proposal_items i ON i.id=r.proposal_item_id WHERE i.proposal_id=p.id AND r.status='active') has_active_reservations
      FROM proposals p WHERE p.portfolio_id=? AND p.environment='actual'
      AND NOT EXISTS(SELECT 1 FROM approval_events a WHERE a.proposal_id=p.id AND a.action IN ('reject','cancel_remainder','expire'))
      AND (substr(p.expires_at,1,19)>=? OR EXISTS(SELECT 1 FROM reservations r JOIN proposal_items i ON i.id=r.proposal_item_id WHERE i.proposal_id=p.id AND r.status='active'))
      ORDER BY p.created_at DESC,p.rowid DESC LIMIT 51`).all(book.id, now.slice(0, 19)) as
      { id: string; created_at: string; expires_at: string; has_active_reservations: number }[], 50)
      .filter(row => row.has_active_reservations || at(row.expires_at) > at(now));
    let selected: ProposalReviewContext["selected"] = null, evidence: unknown = null;
    if (proposalId) {
      const head = heads.find(row => row.id === proposalId); if (!head) throw new Error("INVESTOR_PROPOSAL_SELECTION_INVALID");
      const proof = readCreatedProposal(db, book.id, proposalId), proposal = proof.proposal;
      const approvalRows = bounded(db.prepare("SELECT * FROM approval_events WHERE proposal_id=? ORDER BY rowid LIMIT 1001").all(proposalId) as Approval[], 1000);
      const approvals = approvalRows.map(row => approvalProof(db, book.id, row, proposal.input_hash, now));
      const approved = approvals.filter(value => value.row.action === "approve"); if (approved.length > 1) invalid();
      const approval = approved[0]?.row ?? null;
      const preparations = approvals.filter(value => value.row.action === "prepare_execution");
      if (preparations.some(value => !approval || value.row.input_hash !== approval.input_hash || value.row.expected_revision !== approval.expected_revision
        || value.original.input.approval_id !== approval.id)) invalid();
      const reservations = bounded(db.prepare("SELECT * FROM reservations WHERE proposal_item_id IN (SELECT id FROM proposal_items WHERE proposal_id=?) ORDER BY id LIMIT 101")
        .all(proposalId) as { id: string; portfolio_id: string; account_id: string; proposal_item_id: string; approval_id: string; listing_id: string;
          currency: string; side: "buy" | "sell"; amount: string; quantity: string; status: "active" | "released" | "filled" | "expired"; row_version: number }[], 100);
      if (new Set(reservations.filter(row => row.status === "active").map(row => row.proposal_item_id)).size !== reservations.filter(row => row.status === "active").length) invalid();
      const grants = approved[0]?.original.result.reservations;
      if (approval && (!Array.isArray(grants) || grants.length !== proof.items.length || reservations.length !== grants.length)) invalid();
      for (const row of reservations) {
        const item = proof.items.find(value => value.id === row.proposal_item_id);
        const grant = Array.isArray(grants) ? grants.map(proofObject).find(value => value.id === row.id) : null;
        if (!item || !approval || !grant || row.portfolio_id !== book.id || row.approval_id !== approval.id || row.account_id !== item.account_id || row.listing_id !== item.listing_id
          || row.side !== item.side || row.currency !== item.currency || amount(row.quantity).lt(0) || amount(row.quantity).gt(item.quantity)
          || grant.item_id !== item.id || grant.account_id !== row.account_id || grant.currency !== row.currency || grant.side !== row.side
          || !amount(grant.quantity).eq(item.quantity) || amount(row.amount).gt(amount(grant.amount))
          || amount(row.amount).lt(0) || row.status !== "active" && (!amount(row.amount).isZero() || !amount(row.quantity).isZero())) invalid();
      }
      const items = proof.items.map(item => {
        const account = accounts.accounts.find(row => row.id === item.account_id), listing = db.prepare("SELECT ticker,market,currency FROM listings WHERE id=?").get(item.listing_id) as
          { ticker: string; market: "CN" | "HK" | "US"; currency: string } | undefined;
        if (!account || !listing || listing.currency !== item.currency) invalid();
        const { proposal_id: _, dependencies_json: __, ...body } = item;
        return { ...body, account_name: account.name, ticker: listing.ticker, market: listing.market };
      });
      const currentRisk = proposalRiskSchema.parse(checkRisk(db, { id: actor.id, kind: "human" }, book.id, proposalId, { ...options, now }, now, !!approval));
      const recorded = selectedRisk(db, book.id, proposalId, now), matches = !!recorded && canonical(recorded.risk) === canonical(currentRisk);
      const allowed: ProposalReviewIntent["operation"][] = [];
      if (!accounts.read_only) {
        allowed.push("cancel_remainder");
        if (at(proposal.expires_at) <= at(now)) allowed.push("expire");
        else if (!approval) { allowed.push("risk_check"); if (currentRisk.status === "pass" && matches && recorded?.risk.status === "pass") allowed.push("approve"); }
        else if (currentRisk.status === "pass" && approval.expected_revision === book.ledger_revision && approval.input_hash === currentRisk.input_hash
          && proof.items.every(item => reservations.some(row => row.proposal_item_id === item.id && row.status === "active" && amount(row.quantity).eq(item.quantity)
            && Array.isArray(grants) && grants.map(proofObject).some(grant => grant.id === row.id && amount(grant.amount).eq(row.amount))))) allowed.push("prepare");
      }
      selected = { ...head, has_active_reservations: !!head.has_active_reservations, policy_version_id: proposal.policy_version_id, strategy_version_id: proposal.strategy_version_id,
        items, current_risk: currentRisk, recorded_risk: recorded ? { id: recorded.row.id, created_at: recorded.row.created_at, status: recorded.risk.status,
          input_hash: recorded.risk.input_hash, matches_current: matches } : null,
        approval: approval ? { id: approval.id, created_at: approval.created_at, ledger_revision: approval.expected_revision, input_hash: approval.input_hash } : null,
        preparation: preparations.length ? { id: preparations.at(-1)!.row.id, created_at: preparations.at(-1)!.row.created_at } : null,
        reservations: reservations.map(({ id, proposal_item_id, approval_id, side, currency, amount, quantity, status, row_version }) =>
          ({ id, proposal_item_id, approval_id, side, currency, amount, quantity, status, row_version })), allowed_operations: allowed };
      evidence = { proof, approvals, reservations, recorded, currentRisk };
    }
    const identity = { workspace_id: accounts.workspace_id, workspace_revision: accounts.workspace_revision, portfolio_id: book.id,
      ledger_revision: book.ledger_revision, link_id: accounts.link.id, link_version: accounts.link.version, read_only: accounts.read_only };
    try { return proposalReviewContextSchema.parse({ ...identity, checked_at: now, schema_version: "investor-proposal-review-v1",
      proposals: heads.map(row => ({ ...row, has_active_reservations: !!row.has_active_reservations })), selected,
      context_hash: hash({ identity, accounts: accounts.accounts, heads, evidence }), basis: proposalReviewBasis, broker_ordering_enabled: false, automated_execution_enabled: false }); }
    catch { invalid(); }
  }).deferred();
}

export function reviewInvestorProposal(db: Database.Database, actor: Actor, raw: ProposalReviewIntent & { expected_revision?: number; idempotency_key: string }, now: string, options: GovernanceOptions = {}) {
  const { expected_revision: _, idempotency_key, ...body } = raw, input = proposalReviewIntentSchema.parse(body);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(idempotency_key)) throw new Error("INVESTOR_PROPOSAL_SELECTION_INVALID");
  assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db);
    const context = getInvestorProposalReviewContext(db, actor, input.proposal_id, now, options), selected = context.selected;
    if (context.portfolio_id !== input.portfolio_id) throw new Error("INVESTOR_ACCOUNT_OUT_OF_SCOPE");
    if (context.ledger_revision !== input.expected_ledger_revision || context.link_id !== input.expected_link_id || context.link_version !== input.expected_link_version
      || context.context_hash !== input.expected_context_hash) throw new Error("INVESTOR_PROPOSAL_CONTEXT_CONFLICT");
    if (!selected || !selected.allowed_operations.includes(input.operation)) throw new Error("INVESTOR_PROPOSAL_OPERATION_BLOCKED");
    const reason = `Owner explicitly requested ${input.operation} for an existing account proposal; no broker order is sent${input.note ? "; " + input.note : ""}`;
    const envelope = { portfolio_id: context.portfolio_id, expected_revision: context.ledger_revision,
      idempotency_key: "investor-proposal:" + hash({ owner: actor.id, idempotency_key }), proposal_id: input.proposal_id, reason };
    const human = { id: actor.id, kind: "human" as const }, settings = { ...options, now };
    let result;
    if (input.operation === "risk_check") result = runRiskCheck(db, human, envelope, settings);
    else if (input.operation === "approve") result = approveProposal(db, human, { ...envelope, risk_run_id: selected.recorded_risk!.id, expected_input_hash: selected.current_risk.input_hash }, settings);
    else if (input.operation === "prepare") result = prepareExecution(db, human, { ...envelope, approval_id: selected.approval!.id }, settings);
    else if (input.operation === "expire") result = expireProposal(db, human, envelope, settings);
    else result = cancelRemainder(db, human, envelope, settings);
    if (revision(db, context.portfolio_id) !== context.ledger_revision) invalid();
    assertWritableDatabase(db);
    return { resource_id: result.id, operation: input.operation, result, ledger_facts_changed: false, broker_order_sent: false, basis: proposalReviewBasis };
  }).immediate();
}
