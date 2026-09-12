import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { amount, Decimal, exact } from "../ledger/decimal";
import { audit, canonical, hash, recordFact, revision, type LedgerCommand } from "../ledger/service";
import { readJsonAttachment } from "../ledger/attachments";
import { activationSchema, approvalSchema, capabilityCommandSchema, createPolicySchema, createStrategySchema, executionFactSchema, executionReportSchema, prepareSchema, proposalRefSchema, proposalSchema } from "./schemas";
import { activation, clock, requireActor, transaction, verifyGateEvidence, versions, type GovernanceActor, type GovernanceOptions } from "./core";
import { checkRisk, currentPublications, loadProposal, requireValuation, validateAccount, type RiskResult } from "./risk";

export type { GovernanceActor, GovernanceOptions } from "./core";
export { policySchema, strategySchema } from "./schemas";
export { GOVERNANCE_CLIENT_ERRORS, isGovernanceClientError } from "./errors";

export function createPolicyVersion(db: Database.Database, actor: GovernanceActor, raw: unknown, options: GovernanceOptions = {}) {
  requireActor(actor, true);
  const input = createPolicySchema.parse(raw);
  return transaction(db, actor, "create_policy_version", input, input, options, now => {
    if (input.policy.review_after <= now) throw new Error("POLICY_REVIEW_OVERDUE");
    for (const accountId of input.policy.account_ids) if (!db.prepare("SELECT id FROM accounts WHERE id=? AND portfolio_id=?").get(accountId, input.portfolio_id)) throw new Error("ACCOUNT_OUT_OF_SCOPE");
    for (const listingId of input.policy.listing_ids) if (!db.prepare("SELECT id FROM listings WHERE id=?").get(listingId)) throw new Error("LISTING_NOT_FOUND");
    const id = randomUUID(), version = (db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM policy_versions WHERE portfolio_id=?").get(input.portfolio_id) as { version: number }).version;
    db.prepare("INSERT INTO policy_versions(id,portfolio_id,version,policy_json,content_hash,created_by,created_at) VALUES(?,?,?,?,?,?,?)").run(id, input.portfolio_id, version, canonical(input.policy), hash(input.policy), actor.id, now);
    return { id, version, content_hash: hash(input.policy), status: "candidate" as const };
  });
}

export function createStrategyVersion(db: Database.Database, actor: GovernanceActor, raw: unknown, options: GovernanceOptions = {}) {
  requireActor(actor, true);
  const input = createStrategySchema.parse(raw);
  return transaction(db, actor, "create_strategy_version", input, input, options, now => {
    for (const listingId of input.strategy.universe) if (!db.prepare("SELECT id FROM listings WHERE id=?").get(listingId)) throw new Error("LISTING_NOT_FOUND");
    const id = randomUUID(), version = (db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM strategy_versions WHERE portfolio_id=? AND strategy_key=?").get(input.portfolio_id, input.strategy.strategy_key) as { version: number }).version;
    db.prepare("INSERT INTO strategy_versions(id,portfolio_id,strategy_key,version,parameters_json,content_hash,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, input.portfolio_id, input.strategy.strategy_key, version, canonical(input.strategy), hash(input.strategy), actor.id, now);
    return { id, version, content_hash: hash(input.strategy), status: "candidate" as const };
  });
}

export function approveAccountCapability(db: Database.Database, actor: GovernanceActor, raw: unknown, options: GovernanceOptions = {}) {
  requireActor(actor, true);
  const input = capabilityCommandSchema.parse(raw);
  return transaction(db, actor, "approve_account_capability", input, input, options, now => {
    if (input.valid_until <= now) throw new Error("CAPABILITY_EXPIRED");
    readJsonAttachment(db, actor, input.portfolio_id, input.attachment_id, { ...options, accountId: input.account_id });
    for (const id of input.rules.listing_ids) {
      const listing = db.prepare("SELECT currency FROM listings WHERE id=? AND market=?").get(id, input.market) as { currency: string } | undefined;
      if (!listing || !input.rules.currencies.includes(listing.currency)) throw new Error("INVALID_CAPABILITY_SCOPE");
    }
    const overlapping = db.prepare("SELECT id FROM account_capabilities WHERE account_id=? AND market=? AND (valid_to IS NULL OR valid_to>?)").get(input.account_id, input.market, now);
    if (overlapping) throw new Error("CAPABILITY_ALREADY_ACTIVE");
    const id = randomUUID();
    db.prepare("INSERT INTO account_capabilities(id,account_id,market,valid_from,valid_to,rules_json,evidence_id,approved_by,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, input.account_id, input.market, now, input.valid_until, canonical(input.rules), input.attachment_id, actor.id, now);
    return { id, valid_until: input.valid_until };
  });
}

export function activatePolicy(db: Database.Database, actor: GovernanceActor, raw: unknown, options: GovernanceOptions = {}) {
  requireActor(actor, true);
  const input = activationSchema.parse(raw);
  return transaction(db, actor, "activate_policy", input, input, options, now => {
    const { policy, strategy } = versions(db, input.portfolio_id, input.policy_version_id, input.strategy_version_id);
    if (policy.value.review_after <= now) throw new Error("POLICY_REVIEW_OVERDUE");
    if (strategy.value.universe.some(id => !policy.value.listing_ids.includes(id)) || amount(strategy.value.budget_weight).gt(policy.value.limits.strategy_weight) || strategy.value.benchmark !== policy.value.benchmark) throw new Error("STRATEGY_POLICY_MISMATCH");
    verifyGateEvidence(db, actor, input.portfolio_id, input.gate_attachments, policy, strategy, options, now);
    for (const accountId of policy.value.account_ids) validateAccount(db, input.portfolio_id, accountId, policy.value, now);
    const publications = currentPublications(db, policy.value, now);
    requireValuation(db, input.portfolio_id, input.valuation_id, policy.value, publications, now);
    const previous = db.prepare("SELECT id,valid_from FROM activations WHERE portfolio_id=? AND mode='live_advice' AND valid_to IS NULL").get(input.portfolio_id) as { id: string; valid_from: string } | undefined;
    if (previous) {
      if (previous.valid_from >= now) throw new Error("ACTIVATION_TIMESTAMP_CONFLICT");
      db.prepare("UPDATE activations SET valid_to=? WHERE id=?").run(now, previous.id);
    }
    const id = randomUUID();
    db.prepare("INSERT INTO activations(id,portfolio_id,policy_version_id,strategy_version_id,mode,valid_from,evidence_json,approved_by,created_at) VALUES(?,?,?,?,'live_advice',?,?,?,?)").run(id, input.portfolio_id, policy.id, strategy.id, now, canonical({ gate_attachments: input.gate_attachments, valuation_id: input.valuation_id, publications }), actor.id, now);
    return { id, policy_version_id: policy.id, strategy_version_id: strategy.id, status: "live_advice" as const, broker_ordering: false };
  });
}

function saveRisk(db: Database.Database, proposalId: string, result: RiskResult, now: string) {
  const id = randomUUID();
  db.prepare("INSERT INTO risk_runs(id,proposal_id,input_hash,status,checks_json,created_at) VALUES(?,?,?,?,?,?)").run(id, proposalId, result.input_hash, result.status, canonical({ checks: result.checks, budgets: result.budgets }), now);
  return { id, ...result };
}

export function createProposal(db: Database.Database, actor: GovernanceActor, raw: unknown, options: GovernanceOptions = {}) {
  requireActor(actor);
  const input = proposalSchema.parse(raw);
  return transaction(db, actor, "create_proposal", input, input, options, now => {
    const active = activation(db, input.portfolio_id, input.activation_id, now), policy = active.policy.value;
    if (input.expires_at <= now || (Date.parse(input.expires_at) - Date.parse(now)) / 1000 > policy.execution.proposal_ttl_seconds) throw new Error("INVALID_PROPOSAL_EXPIRY");
    for (const item of input.items) if (!db.prepare("SELECT id FROM accounts WHERE id=? AND portfolio_id=?").get(item.account_id, input.portfolio_id)) throw new Error("ACCOUNT_OUT_OF_SCOPE");
    const publications = currentPublications(db, policy, now), id = randomUUID();
    const context = { activation_id: active.row.id, valuation_id: input.valuation_id, publications, ai_run_id: input.ai_run_id };
    const inputHash = hash({ portfolio_id: input.portfolio_id, ledger_revision: input.expected_revision, policy_version_id: active.policy.id, strategy_version_id: active.strategy.id, context: { ...context, ai_run_id: undefined }, items: input.items, expires_at: input.expires_at });
    db.prepare("INSERT INTO proposals(id,portfolio_id,environment,policy_version_id,strategy_version_id,ledger_revision,market_manifest,input_hash,status,reasons_json,created_at,expires_at) VALUES(?,?,'actual',?,?,?,?,?,'draft',?,?,?)")
      .run(id, input.portfolio_id, active.policy.id, active.strategy.id, input.expected_revision, canonical(context), inputHash, canonical([input.reason]), now, input.expires_at);
    const itemIds = input.items.map(item => {
      const itemId = randomUUID();
      db.prepare("INSERT INTO proposal_items(id,proposal_id,account_id,listing_id,side,currency,quantity,limit_price,estimated_fees) VALUES(?,?,?,?,?,?,?,?,?)").run(itemId, id, item.account_id, item.listing_id, item.side, item.currency, item.quantity, item.limit_price, item.estimated_fees);
      return itemId;
    });
    const risk = saveRisk(db, id, checkRisk(db, actor, input.portfolio_id, id, options, now), now);
    return { id, item_ids: itemIds, input_hash: inputHash, risk, status: risk.status === "pass" ? "awaiting_human_approval" : "blocked" };
  }, false);
}

export function runRiskCheck(db: Database.Database, actor: GovernanceActor, raw: unknown, options: GovernanceOptions = {}) {
  requireActor(actor);
  const input = proposalRefSchema.parse(raw);
  return transaction(db, actor, "run_risk_check", input, input, options, now => saveRisk(db, input.proposal_id, checkRisk(db, actor, input.portfolio_id, input.proposal_id, options, now), now), false);
}

function terminal(db: Database.Database, proposalId: string): boolean {
  return Boolean(db.prepare("SELECT id FROM approval_events WHERE proposal_id=? AND action IN ('reject','cancel_remainder','expire') LIMIT 1").get(proposalId));
}

export function approveProposal(db: Database.Database, actor: GovernanceActor, raw: unknown, options: GovernanceOptions = {}) {
  requireActor(actor, true);
  const input = approvalSchema.parse(raw);
  return transaction(db, actor, "approve_proposal", input, input, options, now => {
    const { proposal } = loadProposal(db, input.portfolio_id, input.proposal_id);
    if (terminal(db, proposal.id)) throw new Error("PROPOSAL_TERMINAL");
    if (db.prepare("SELECT id FROM approval_events WHERE proposal_id=? AND action='approve'").get(proposal.id)) throw new Error("PROPOSAL_ALREADY_APPROVED");
    const previous = db.prepare("SELECT * FROM risk_runs WHERE id=? AND proposal_id=?").get(input.risk_run_id, proposal.id) as { status: string; input_hash: string } | undefined;
    if (!previous || previous.status !== "pass" || previous.input_hash !== input.expected_input_hash) throw new Error("RISK_APPROVAL_MISMATCH");
    const risk = checkRisk(db, actor, input.portfolio_id, proposal.id, options, now);
    if (risk.status !== "pass") throw new Error(`RISK_BLOCKED:${risk.checks[0].code}`);
    if (risk.input_hash !== input.expected_input_hash) throw new Error("RISK_INPUT_CHANGED");
    const id = randomUUID();
    db.prepare("INSERT INTO approval_events(id,proposal_id,actor_id,action,expected_revision,input_hash,payload_json,created_at) VALUES(?,?,?,'approve',?,?,?,?)").run(id, proposal.id, actor.id, input.expected_revision, risk.input_hash, canonical({ reason: input.reason, risk_run_id: input.risk_run_id, proposal_input_hash: proposal.input_hash }), now);
    const reservations = risk.budgets.map(budget => {
      const reservationId = randomUUID();
      const item = db.prepare("SELECT listing_id FROM proposal_items WHERE id=?").get(budget.item_id) as { listing_id: string };
      db.prepare("INSERT INTO reservations(id,portfolio_id,account_id,proposal_item_id,approval_id,listing_id,currency,side,amount,quantity,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?)")
        .run(reservationId, input.portfolio_id, budget.account_id, budget.item_id, id, item.listing_id, budget.currency, budget.side, budget.amount, budget.quantity, now, now);
      return { id: reservationId, ...budget };
    });
    return { id, proposal_id: proposal.id, reservations, status: "approved_pending_manual_execution" as const, broker_order_sent: false };
  });
}

export function prepareExecution(db: Database.Database, actor: GovernanceActor, raw: unknown, options: GovernanceOptions = {}) {
  requireActor(actor, true);
  const input = prepareSchema.parse(raw);
  return transaction(db, actor, "prepare_execution", input, input, options, now => {
    const { proposal, items } = loadProposal(db, input.portfolio_id, input.proposal_id);
    if (terminal(db, proposal.id)) throw new Error("PROPOSAL_TERMINAL");
    const approval = db.prepare("SELECT * FROM approval_events WHERE id=? AND proposal_id=? AND action='approve'").get(input.approval_id, proposal.id) as { expected_revision: number; input_hash: string } | undefined;
    if (!approval || approval.expected_revision !== input.expected_revision) throw new Error("APPROVAL_STALE");
    if (items.some(item => !db.prepare("SELECT id FROM reservations WHERE proposal_item_id=? AND approval_id=? AND status='active'").get(item.id, input.approval_id))) throw new Error("RESERVATION_NOT_ACTIVE");
    const risk = checkRisk(db, actor, input.portfolio_id, proposal.id, options, now, true);
    if (risk.status !== "pass") throw new Error(`RISK_BLOCKED:${risk.checks[0].code}`);
    if (risk.input_hash !== approval.input_hash) throw new Error("APPROVAL_STALE");
    const id = randomUUID();
    db.prepare("INSERT INTO approval_events(id,proposal_id,actor_id,action,expected_revision,input_hash,payload_json,created_at) VALUES(?,?,?,'prepare_execution',?,?,?,?)").run(id, proposal.id, actor.id, input.expected_revision, risk.input_hash, canonical({ approval_id: input.approval_id, reason: input.reason, broker_order_sent: false }), now);
    return { id, proposal_id: proposal.id, status: "ready_for_manual_execution" as const, broker_order_sent: false };
  });
}

function release(db: Database.Database, actor: GovernanceActor, raw: unknown, options: GovernanceOptions, action: "cancel_remainder" | "expire") {
  requireActor(actor, true);
  const input = proposalRefSchema.parse(raw);
  return transaction(db, actor, action, input, input, options, now => {
    const { proposal } = loadProposal(db, input.portfolio_id, input.proposal_id);
    if (terminal(db, proposal.id)) throw new Error("PROPOSAL_TERMINAL");
    if (action === "expire" && proposal.expires_at > now) throw new Error("PROPOSAL_NOT_EXPIRED");
    const rows = db.prepare("SELECT r.* FROM reservations r JOIN proposal_items i ON i.id=r.proposal_item_id WHERE i.proposal_id=? AND r.status='active'").all(proposal.id) as { id: string; amount: string; quantity: string; row_version: number }[];
    for (const row of rows) db.prepare("UPDATE reservations SET amount='0',quantity='0',status=?,row_version=row_version+1,updated_at=? WHERE id=? AND row_version=?").run(action === "expire" ? "expired" : "released", now, row.id, row.row_version);
    const id = randomUUID();
    db.prepare("INSERT INTO approval_events(id,proposal_id,actor_id,action,expected_revision,input_hash,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, proposal.id, actor.id, action, input.expected_revision, proposal.input_hash, canonical({ reason: input.reason, released: rows.map(row => ({ id: row.id, amount: row.amount, quantity: row.quantity })) }), now);
    return { id, released: rows.length, ledger_revision: revision(db, input.portfolio_id), facts_changed: false };
  });
}
export function cancelRemainder(db: Database.Database, actor: GovernanceActor, raw: unknown, options: GovernanceOptions = {}) { return release(db, actor, raw, options, "cancel_remainder"); }
export function expireProposal(db: Database.Database, actor: GovernanceActor, raw: unknown, options: GovernanceOptions = {}) { return release(db, actor, raw, options, "expire"); }

export function recordExecutionReport(db: Database.Database, actor: GovernanceActor, raw: unknown, options: GovernanceOptions = {}) {
  requireActor(actor, true);
  const input = executionReportSchema.parse(raw);
  return transaction(db, actor, "record_execution_report", input, input, options, now => {
    const { proposal, items } = loadProposal(db, input.portfolio_id, input.proposal_id), item = items.find(item => item.id === input.proposal_item_id);
    if (!item) throw new Error("PROPOSAL_ITEM_OUT_OF_SCOPE");
    readJsonAttachment(db, actor, input.portfolio_id, input.attachment_id, { ...options, accountId: item.account_id });
    const id = randomUUID();
    const deviations = [...(terminal(db, proposal.id) || proposal.expires_at <= now ? ["REPORTED_AFTER_TERMINAL_OR_EXPIRY"] : []), ...(amount(input.reported_quantity).gt(item.quantity) ? ["REPORTED_QUANTITY_EXCEEDS_PROPOSAL"] : [])];
    if (!db.prepare("SELECT id FROM approval_events WHERE proposal_id=? AND action='approve'").get(proposal.id)) deviations.push("REPORTED_WITHOUT_APPROVAL");
    const existing = db.prepare("SELECT id,proposal_item_id,status,payload_json,attachment_id FROM execution_reports WHERE account_id=? AND source_id=? AND source_event_id=?").get(item.account_id, input.source_id, input.source_event_id) as { id: string; proposal_item_id: string; status: string; payload_json: string; attachment_id: string } | undefined;
    if (existing) {
      const payload = JSON.parse(existing.payload_json);
      if (existing.proposal_item_id !== item.id || existing.status !== input.status || existing.attachment_id !== input.attachment_id || !amount(payload.reported_quantity).eq(input.reported_quantity) || payload.reason !== input.reason) throw new Error("EXECUTION_REPORT_DUPLICATE_CONFLICT");
      return { id: existing.id, status: existing.status, deviations: payload.deviations as string[], fact_confirmed: false, ledger_revision: revision(db, input.portfolio_id), duplicate: true };
    }
    db.prepare("INSERT INTO execution_reports(id,portfolio_id,account_id,proposal_item_id,source_id,source_event_id,status,payload_json,attachment_id,actor_id,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, input.portfolio_id, item.account_id, item.id, input.source_id, input.source_event_id, input.status, canonical({ reported_quantity: input.reported_quantity, reason: input.reason, deviations, fact_confirmed: false }), input.attachment_id, actor.id, now);
    return { id, status: input.status, deviations, fact_confirmed: false, ledger_revision: revision(db, input.portfolio_id) };
  });
}

/** Confirmed broker facts, not order reports, consume a reservation in the same transaction. */
export function recordExecutionFact(db: Database.Database, actor: GovernanceActor, raw: unknown, options: GovernanceOptions = {}) {
  requireActor(actor, true);
  const input = executionFactSchema.parse(raw);
  return transaction(db, actor, "record_execution_fact", input, input, options, now => {
    const { proposal, items } = loadProposal(db, input.portfolio_id, input.proposal_id), item = items.find(item => item.id === input.proposal_item_id);
    if (!item) throw new Error("PROPOSAL_ITEM_OUT_OF_SCOPE");
    readJsonAttachment(db, actor, input.portfolio_id, input.attachment_id, { ...options, accountId: item.account_id });
    const command = input.command as LedgerCommand;
    if (!command?.fact || command.portfolio_id !== input.portfolio_id || command.fact.account_id !== item.account_id || command.fact.listing_id !== item.listing_id || command.fact.currency !== item.currency || command.fact.type !== item.side || command.expected_revision !== input.expected_revision) throw new Error("EXECUTION_FACT_OUT_OF_SCOPE");
    const receipt = recordFact(db, actor, command, now);
    const linked = db.prepare("SELECT payload_json FROM audit_events WHERE action='execution_fact_link' AND object_id=?").get(receipt.event_id) as { payload_json: string } | undefined;
    if (linked) {
      if (JSON.parse(linked.payload_json).proposal_item_id !== item.id) throw new Error("EXECUTION_FACT_ALREADY_LINKED");
      return { receipt, consumed: false, duplicate: true, deviations: [] as string[] };
    }
    const deviations: string[] = [];
    if (terminal(db, proposal.id) || proposal.expires_at <= now) deviations.push("FACT_AFTER_TERMINAL_OR_EXPIRY");
    if (proposal.ledger_revision !== input.expected_revision) deviations.push("FACT_AGAINST_STALE_PROPOSAL");
    const quantity = amount(command.fact.quantity), price = command.fact.price ? amount(command.fact.price) : amount(command.fact.consideration).div(quantity);
    if (item.side === "buy" ? price.gt(item.limit_price) : price.lt(item.limit_price)) deviations.push("EXECUTION_PRICE_OUTSIDE_LIMIT");
    const reservation = db.prepare("SELECT * FROM reservations WHERE proposal_item_id=? AND status='active'").get(item.id) as { id: string; quantity: string; amount: string; row_version: number } | undefined;
    let consumed = false;
    if (receipt.warnings.includes("ORIGINAL_SOURCE_SUPERSEDED")) deviations.push("SUPERSEDED_FACT_NOT_CONSUMED");
    else if (command.effective_at.slice(0, 10) < proposal.created_at.slice(0, 10)) deviations.push("FACT_PREDATES_PROPOSAL");
    else if (reservation) {
      const remaining = Decimal.max(amount(reservation.quantity).sub(quantity), amount("0"));
      if (quantity.gt(reservation.quantity)) deviations.push("FACT_EXCEEDS_RESERVED_QUANTITY");
      const remainderAmount = remaining.isZero() ? amount("0") : amount(reservation.amount).mul(remaining).div(reservation.quantity).toDecimalPlaces(18, Decimal.ROUND_CEIL);
      db.prepare("UPDATE reservations SET amount=?,quantity=?,status=?,row_version=row_version+1,updated_at=? WHERE id=? AND row_version=?").run(exact(remainderAmount), exact(remaining), remaining.isZero() ? "filled" : "active", now, reservation.id, reservation.row_version);
      consumed = true;
    } else deviations.push("NO_ACTIVE_RESERVATION");
    audit(db, actor, "execution_fact_link", "ledger_event", receipt.event_id, input.portfolio_id, receipt.revision, { proposal_id: proposal.id, proposal_item_id: item.id, attachment_id: input.attachment_id, consumed, deviations }, now);
    return { receipt, consumed, deviations, duplicate: false };
  });
}

export function getGovernanceState(db: Database.Database, actor: GovernanceActor, portfolioId: string) {
  if (!actor?.id?.trim() || !["human", "strategy", "ai"].includes(actor.kind)) throw new Error("UNAUTHENTICATED");
  return db.transaction(() => {
    const ledgerRevision = revision(db, portfolioId), now = clock({});
    const proposals = db.prepare("SELECT id,environment,input_hash,ledger_revision,market_manifest,policy_version_id,strategy_version_id,created_at,expires_at FROM proposals WHERE portfolio_id=? ORDER BY created_at DESC,id LIMIT 200").all(portfolioId) as { id: string; ledger_revision: number; expires_at: string }[];
    const proposalIds = new Set(proposals.map(row => row.id));
    const approvals = db.prepare("SELECT e.* FROM approval_events e JOIN proposals p ON p.id=e.proposal_id WHERE p.portfolio_id=? ORDER BY e.created_at DESC,e.rowid DESC LIMIT 1000").all(portfolioId) as { id: string; proposal_id: string; action: string; payload_json: string }[];
    const risks = db.prepare("SELECT r.* FROM risk_runs r JOIN proposals p ON p.id=r.proposal_id WHERE p.portfolio_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1000").all(portfolioId) as { id: string; proposal_id: string; status: string; checks_json: string }[];
    return {
    ledger_revision: ledgerRevision,
    policy_versions: db.prepare("SELECT id,version,content_hash,policy_json,created_at FROM policy_versions WHERE portfolio_id=? ORDER BY version DESC LIMIT 200").all(portfolioId),
    strategy_versions: db.prepare("SELECT id,strategy_key,version,content_hash,parameters_json,created_at FROM strategy_versions WHERE portfolio_id=? ORDER BY created_at DESC LIMIT 200").all(portfolioId),
    activations: db.prepare("SELECT id,policy_version_id,strategy_version_id,mode,valid_from,valid_to FROM activations WHERE portfolio_id=? ORDER BY valid_from DESC LIMIT 200").all(portfolioId),
    capabilities: db.prepare("SELECT c.id,c.account_id,c.market,c.valid_from,c.valid_to,c.rules_json,c.evidence_id,c.approved_by,c.recorded_at FROM account_capabilities c JOIN accounts a ON a.id=c.account_id WHERE a.portfolio_id=? ORDER BY c.recorded_at DESC LIMIT 500").all(portfolioId),
    proposals: proposals.map(row => ({ ...row, status: approvals.find(approval => approval.proposal_id === row.id && ["reject", "expire", "cancel_remainder"].includes(approval.action))?.action ?? (row.expires_at <= now ? "expired" : row.ledger_revision !== ledgerRevision ? "stale" : approvals.some(approval => approval.proposal_id === row.id && approval.action === "approve") ? "approved_requires_preexecution_check" : risks.find(risk => risk.proposal_id === row.id)?.status === "pass" ? "awaiting_human_approval" : "blocked") })),
    proposal_items: (db.prepare("SELECT i.* FROM proposal_items i JOIN (SELECT id FROM proposals WHERE portfolio_id=? ORDER BY created_at DESC,id LIMIT 200) p ON p.id=i.proposal_id ORDER BY i.id LIMIT 20000").all(portfolioId) as { proposal_id: string }[]).filter(row => proposalIds.has(row.proposal_id)),
    risk_checks: risks.map(({ checks_json, ...row }) => ({ ...row, result: JSON.parse(checks_json) })),
    approvals: approvals.map(({ payload_json, ...row }) => ({ ...row, payload: JSON.parse(payload_json) })),
    execution_reports: (db.prepare("SELECT id,proposal_item_id,status,payload_json,recorded_at FROM execution_reports WHERE portfolio_id=? ORDER BY recorded_at DESC LIMIT 500").all(portfolioId) as { payload_json: string }[]).map(({ payload_json, ...row }) => ({ ...row, payload: JSON.parse(payload_json) })),
    verification_runs: db.prepare("SELECT id,gate,policy_hash,strategy_hash,suite_version,tool_version,source_manifest_hash,manifest_hash,status,provenance,executed_at FROM governance_verification_runs WHERE portfolio_id=? ORDER BY recorded_at DESC LIMIT 200").all(portfolioId),
    reservations: db.prepare("SELECT id,proposal_item_id,side,currency,amount,quantity,status,row_version FROM reservations WHERE portfolio_id=? ORDER BY created_at DESC LIMIT 500").all(portfolioId),
    broker_ordering_enabled: false,
    };
  }).deferred();
}
