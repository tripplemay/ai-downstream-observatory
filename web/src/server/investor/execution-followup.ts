import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { amount } from "../ledger/decimal";
import { canonical, getActiveLedgerEvents, hash, revision, sourceFingerprint, type Actor, type LedgerCommand, type Receipt } from "../ledger/service";
import { readAttachment, type AttachmentOptions } from "../ledger/attachments";
import { parseStrictJson } from "../strict-json";
import { proposalSchema } from "../governance/schemas";
import { recordExecutionFact, recordExecutionReport } from "../governance/service";
import { getTradeRecordingContext, readTradeLedgerCommand } from "./trade-recording";
import { executionFollowupBasis, executionFollowupContextSchema, executionReportIntentSchema, linkExecutionIntentSchema,
  type ExecutionFollowupContext, type ExecutionReportIntent, type LinkExecutionIntent } from "./execution-followup-schemas";

type Audit = { id: string; actor_id: string; portfolio_id: string; object_id: string; ledger_revision: number; created_at: string; payload_json: string };
type Proposal = { id: string; portfolio_id: string; policy_version_id: string; strategy_version_id: string; input_hash: string;
  ledger_revision: number; market_manifest: string; created_at: string; expires_at: string };
type Item = { id: string; proposal_id: string; account_id: string; listing_id: string; side: "buy" | "sell"; currency: string; quantity: string; limit_price: string; estimated_fees: string; dependencies_json: string };
function invalid(): never { throw new Error("INVESTOR_EXECUTION_EVIDENCE_INVALID"); }
function bounded<T>(rows: T[], maximum: number): T[] {
  if (rows.length > maximum) throw new Error("INVESTOR_EXECUTION_CAPACITY_REQUIRES_REVIEW");
  return rows;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function auditFor(db: Database.Database, portfolio: string, action: string, path: string, id: string): Audit {
  const rows = db.prepare(`SELECT * FROM audit_events WHERE portfolio_id=? AND action=? AND json_extract(payload_json,?)=?
    AND COALESCE(json_extract(payload_json,'$.result.duplicate'),0)=0 LIMIT 2`).all(portfolio, action, path, id) as Audit[];
  if (rows.length !== 1) invalid();
  return rows[0];
}
function proposalItems(db: Database.Database, portfolio: string, account: string) {
  const proposals = bounded(db.prepare(`SELECT p.* FROM proposals p WHERE p.portfolio_id=? AND p.environment='actual'
    AND EXISTS(SELECT 1 FROM proposal_items i WHERE i.proposal_id=p.id AND i.account_id=?) ORDER BY p.created_at,p.id LIMIT 201`).all(portfolio, account) as Proposal[], 200);
  const result: ExecutionFollowupContext["items"] = [], evidence: unknown[] = [];
  for (const proposal of proposals) {
    const audit = auditFor(db, portfolio, "create_proposal", "$.result.id", proposal.id), original = object(parseStrictJson(audit.payload_json));
    const input = proposalSchema.parse(original.input), receipt = object(original.result), context = object(parseStrictJson(proposal.market_manifest));
    const items = db.prepare("SELECT * FROM proposal_items WHERE proposal_id=? ORDER BY id LIMIT 101").all(proposal.id) as Item[];
    if (items.length !== input.items.length || !Array.isArray(receipt.item_ids) || receipt.item_ids.length !== items.length
      || new Set(receipt.item_ids).size !== items.length || audit.created_at !== proposal.created_at || audit.ledger_revision !== proposal.ledger_revision
      || input.portfolio_id !== portfolio || input.expected_revision !== proposal.ledger_revision || receipt.input_hash !== proposal.input_hash
      || input.expires_at !== proposal.expires_at || context.activation_id !== input.activation_id || context.valuation_id !== input.valuation_id
      || context.ai_run_id !== input.ai_run_id || hash({ portfolio_id: portfolio, ledger_revision: proposal.ledger_revision,
        policy_version_id: proposal.policy_version_id, strategy_version_id: proposal.strategy_version_id,
        context: { ...context, ai_run_id: undefined }, items: input.items, expires_at: proposal.expires_at }) !== proposal.input_hash) invalid();
    for (const [index, itemId] of receipt.item_ids.entries()) {
      const item = items.find(row => row.id === itemId);
      if (!item) invalid();
      const { id: _, proposal_id: __, dependencies_json, ...body } = item;
      if (canonical(parseStrictJson(dependencies_json)) !== "[]" || canonical(body) !== canonical(input.items[index])) invalid();
      if (item.account_id !== account) continue;
      const listing = db.prepare("SELECT ticker,market,currency FROM listings WHERE id=?").get(item.listing_id) as
        { ticker: string; market: "CN" | "HK" | "US"; currency: string } | undefined;
      if (!listing || listing.currency !== item.currency) invalid();
      if (result.length >= 200) throw new Error("INVESTOR_EXECUTION_CAPACITY_REQUIRES_REVIEW");
      result.push({ id: item.id, proposal_id: proposal.id, listing_id: item.listing_id, ticker: listing.ticker, market: listing.market,
        side: item.side, currency: item.currency, quantity: item.quantity, limit_price: item.limit_price, estimated_fees: item.estimated_fees,
        created_at: proposal.created_at, expires_at: proposal.expires_at });
    }
    evidence.push({ proposal, audit, items });
  }
  return { items: bounded(result, 200), evidence };
}
function originalTrade(db: Database.Database, row: ReturnType<typeof getActiveLedgerEvents>[number], portfolio: string, account: string, now: string) {
  const command = readTradeLedgerCommand(row, portfolio, account, now), { expected_revision: _, idempotency_key: __, ...semantic } = command;
  if (command.fact.type !== "buy" && command.fact.type !== "sell") invalid();
  const dedup = db.prepare("SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?")
    .get("ledger:" + portfolio, command.idempotency_key) as { payload_hash: string; result_json: string } | undefined;
  if (!dedup || dedup.payload_hash !== row.payload_hash || hash(semantic) !== row.payload_hash) invalid();
  const receipt = parseStrictJson(dedup.result_json) as Receipt;
  const audit = db.prepare("SELECT * FROM audit_events WHERE id=? AND action='record_fact' AND object_type='ledger_event'").get(receipt.audit_id) as Audit | undefined;
  if (!audit || receipt.event_id !== row.id || receipt.revision !== row.ledger_revision || audit.object_id !== row.id || audit.portfolio_id !== portfolio
    || audit.ledger_revision !== row.ledger_revision || audit.created_at !== row.recorded_at || object(parseStrictJson(audit.payload_json)).digest !== row.payload_hash) invalid();
  const movement = db.prepare("SELECT account_id,listing_id,currency,quantity,cost_amount,cost_known FROM position_movements WHERE event_id=?").all(row.id) as
    { account_id: string; listing_id: string; currency: string; quantity: string; cost_amount: string; cost_known: number }[];
  const buying = command.fact.type === "buy", principal = command.fact.consideration ?? amount(command.fact.quantity).mul(command.fact.price!).toFixed();
  if (movement.length !== 1 || movement[0].account_id !== account || movement[0].listing_id !== command.fact.listing_id
    || movement[0].currency !== command.fact.currency || ![0, 1].includes(movement[0].cost_known)
    || !amount(movement[0].quantity).eq(amount(command.fact.quantity).mul(buying ? 1 : -1))) invalid();
  const cost = amount(movement[0].cost_amount), fee = command.fact.fee ?? "0";
  if (buying && (!cost.eq(principal) || movement[0].cost_known !== 1) || !buying && cost.gt(0)) invalid();
  const expected = { inventory_cost: cost.toFixed(), expense: fee, [buying ? "trade_payable" : "trade_receivable"]:
    buying ? amount(principal).add(fee).neg().toFixed() : amount(principal).sub(fee).toFixed(),
    ...(!buying ? { [movement[0].cost_known ? "income" : "unclassified_income"]: amount(principal).add(cost).neg().toFixed() } : {}) };
  const postings = db.prepare("SELECT account_id,currency,ledger_account,amount FROM postings WHERE event_id=?").all(row.id) as
    { account_id: string; currency: string; ledger_account: string; amount: string }[];
  const entries = Object.entries(expected).filter(([, value]) => !amount(value).isZero());
  if (postings.length !== entries.length || new Set(postings.map(value => value.ledger_account)).size !== postings.length
    || postings.some(value => value.account_id !== account || value.currency !== command.fact.currency
      || !entries.some(([name, quantity]) => name === value.ledger_account && amount(quantity).eq(value.amount)))) invalid();
  return { command, principal, fee, evidence: { row, audit, dedup, movement, postings } };
}

/** Historical records only: no risk pass, approval, resource release, facts or orders on GET. */
export function getExecutionFollowupContext(db: Database.Database, actor: Actor, accountId: string, now = new Date().toISOString()): ExecutionFollowupContext {
  return db.transaction(() => {
    const base = getTradeRecordingContext(db, actor, accountId, now), portfolio = base.portfolio_id;
    const { items, evidence: proposalEvidence } = proposalItems(db, portfolio, accountId);
    const active = bounded(getActiveLedgerEvents(db, portfolio).filter(row => row.account_id === accountId && ["buy", "sell"].includes(row.event_type)), 200);
    const factEvidence: unknown[] = [];
    const facts = active.map(row => {
      const trade = originalTrade(db, row, portfolio, accountId, now), c = trade.command;
      const links = db.prepare("SELECT * FROM audit_events WHERE portfolio_id=? AND action='execution_fact_link' AND object_type='ledger_event' AND object_id=? LIMIT 2").all(portfolio, row.id) as Audit[];
      if (links.length > 1) invalid();
      let link: ExecutionFollowupContext["facts"][number]["link"] = null;
      if (links.length) {
        const stored = object(parseStrictJson(links[0].payload_json)), item = items.find(value => value.id === stored.proposal_item_id);
        const original = auditFor(db, portfolio, "record_execution_fact", "$.result.receipt.event_id", row.id);
        const body = object(parseStrictJson(original.payload_json)), input = object(body.input), result = object(body.result);
        if (!item || stored.proposal_id !== item.proposal_id || item.listing_id !== c.fact.listing_id || item.side !== c.fact.type
          || input.proposal_id !== item.proposal_id || input.proposal_item_id !== item.id || input.attachment_id !== stored.attachment_id
          || result.consumed !== stored.consumed || canonical(result.deviations) !== canonical(stored.deviations)
          || sourceFingerprint(input.command as LedgerCommand) !== sourceFingerprint(c) || original.actor_id !== links[0].actor_id
          || links[0].ledger_revision !== row.ledger_revision || original.created_at !== links[0].created_at || links[0].created_at > now) invalid();
        link = { proposal_item_id: item.id, attachment_id: stored.attachment_id as string, consumed: stored.consumed as boolean,
          deviations: stored.deviations as string[], recorded_at: links[0].created_at };
      }
      factEvidence.push({ trade: trade.evidence, links });
      return { event_id: row.id, listing_id: c.fact.listing_id!, side: c.fact.type as "buy" | "sell", currency: c.fact.currency,
        quantity: c.fact.quantity!, consideration: trade.principal, fee: trade.fee, effective_at: c.effective_at,
        source_timezone: c.source_timezone, recorded_at: row.recorded_at, source_id: c.source_id, source_event_id: c.source_event_id ?? null, link };
    });
    const attachmentRows = bounded(db.prepare(`SELECT DISTINCT t.* FROM attachments t JOIN audit_events a ON a.object_id=t.id
      WHERE a.action='store_attachment' AND a.object_type='attachment' AND a.portfolio_id=? AND json_extract(a.payload_json,'$.account_id')=?
      AND t.media_type IN ('application/json','text/csv') ORDER BY t.created_at,t.id LIMIT 51`).all(portfolio, accountId) as
      { id: string; content_hash: string; byte_size: number; media_type: "application/json" | "text/csv"; created_at: string; storage_key: string }[], 50);
    const evidence = attachmentRows.map(row => {
      if (row.storage_key !== `attachments/${row.content_hash}.${row.media_type === "text/csv" ? "csv" : "json"}`) invalid();
      return { id: row.id, content_hash: row.content_hash, byte_size: row.byte_size, media_type: row.media_type, created_at: row.created_at };
    });
    const reportRows = bounded(db.prepare("SELECT * FROM execution_reports WHERE portfolio_id=? AND account_id=? ORDER BY recorded_at,id LIMIT 201").all(portfolio, accountId) as
      { id: string; proposal_item_id: string; source_id: string; source_event_id: string; status: string; payload_json: string; attachment_id: string; actor_id: string; recorded_at: string }[], 200);
    const reportEvidence: unknown[] = [];
    const reports = reportRows.map(row => {
      const audit = auditFor(db, portfolio, "record_execution_report", "$.result.id", row.id), body = object(parseStrictJson(audit.payload_json));
      const input = object(body.input), result = object(body.result), payload = object(parseStrictJson(row.payload_json));
      const item = items.find(value => value.id === row.proposal_item_id);
      if (!item || audit.created_at !== row.recorded_at || audit.actor_id !== row.actor_id || input.proposal_id !== item.proposal_id
        || input.proposal_item_id !== item.id || input.source_id !== row.source_id || input.source_event_id !== row.source_event_id
        || input.attachment_id !== row.attachment_id || input.status !== row.status || input.reported_quantity !== payload.reported_quantity
        || input.reason !== payload.reason || payload.fact_confirmed !== false || result.fact_confirmed !== false
        || result.status !== row.status || canonical(result.deviations) !== canonical(payload.deviations)) invalid();
      reportEvidence.push({ row, audit });
      return { id: row.id, proposal_item_id: row.proposal_item_id, status: row.status as ExecutionReportIntent["status"],
        source_id: row.source_id, source_event_id: row.source_event_id, reason: payload.reason as string, attachment_id: row.attachment_id,
        reported_quantity: payload.reported_quantity as string, deviations: payload.deviations as string[], recorded_at: row.recorded_at, fact_confirmed: false as const };
    });
    const reservations = bounded(db.prepare("SELECT * FROM reservations WHERE portfolio_id=? AND account_id=? ORDER BY id LIMIT 401").all(portfolio, accountId) as
      { proposal_item_id: string; status: string }[], 400);
    const counts = new Set<string>();
    for (const row of reservations.filter(value => value.status === "active")) { if (counts.has(row.proposal_item_id)) invalid(); counts.add(row.proposal_item_id); }
    const approvals = bounded(db.prepare(`SELECT a.* FROM approval_events a WHERE EXISTS(SELECT 1 FROM proposal_items i
      JOIN proposals p ON p.id=i.proposal_id WHERE p.id=a.proposal_id AND p.portfolio_id=? AND i.account_id=?) ORDER BY a.rowid LIMIT 1001`).all(portfolio, accountId), 1000);
    const { listings: _, unsettled_trades: __, basis: ___, context_hash: tradeHash, ...identity } = base;
    const { checked_at: ____, ...stableIdentity } = identity;
    try { return executionFollowupContextSchema.parse({ ...identity, schema_version: "investor-execution-followup-v1", items, facts, evidence, reports,
      basis: executionFollowupBasis, broker_ordering_enabled: false, context_hash: hash({ identity: stableIdentity, tradeHash, proposalEvidence, factEvidence,
        attachmentRows, reportEvidence, reservations, approvals }) }); }
    catch { invalid(); }
  }).deferred();
}
export function assertExecutionScope(context: ExecutionFollowupContext, input: LinkExecutionIntent | ExecutionReportIntent | {
  portfolio_id: string; expected_ledger_revision: number; expected_account_row_version: number; expected_link_id: string;
  expected_link_version: number; expected_context_hash: string }) {
  if (context.portfolio_id !== input.portfolio_id) throw new Error("INVESTOR_ACCOUNT_OUT_OF_SCOPE");
  if (context.ledger_revision !== input.expected_ledger_revision || context.account_row_version !== input.expected_account_row_version
    || context.link_id !== input.expected_link_id || context.link_version !== input.expected_link_version || context.context_hash !== input.expected_context_hash)
    throw new Error("INVESTOR_EXECUTION_CONTEXT_CONFLICT");
  if (context.read_only) throw new Error("WORKBENCH_READ_ONLY");
  if (context.account_status === "disabled") throw new Error("INVESTOR_TRADE_ACCOUNT_DISABLED");
}
export function recordInvestorExecutionFollowup(db: Database.Database, actor: Actor, raw: (LinkExecutionIntent | ExecutionReportIntent) & { idempotency_key: string; expected_revision?: number }, now: string, options: AttachmentOptions) {
  const { idempotency_key, expected_revision: _, ...body } = raw;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(idempotency_key)) throw new Error("INVESTOR_EXECUTION_SELECTION_INVALID");
  const input = body.action === "link_recorded_execution_fact" ? linkExecutionIntentSchema.parse(body) : executionReportIntentSchema.parse(body);
  assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db);
    const context = getExecutionFollowupContext(db, actor, input.account_id, now); assertExecutionScope(context, input);
    const item = context.items.find(row => row.id === input.proposal_item_id);
    if (!item || !context.evidence.some(row => row.id === input.attachment_id)) throw new Error("INVESTOR_EXECUTION_SELECTION_INVALID");
    readAttachment(db, actor, context.portfolio_id, input.attachment_id, { ...options, now, accountId: context.account_id });
    const envelope = { portfolio_id: context.portfolio_id, expected_revision: context.ledger_revision,
      idempotency_key: "investor-execution:" + hash({ owner: actor.id, idempotency_key }), proposal_id: item.proposal_id,
      proposal_item_id: item.id, attachment_id: input.attachment_id };
    const human = { ...actor, kind: "human" as const };
    if (input.action === "record_linked_execution_report") {
      let result;
      try { result = recordExecutionReport(db, human, { ...envelope, source_id: input.source_id, source_event_id: input.source_event_id,
        status: input.status, reported_quantity: input.reported_quantity, reason: input.reason }, { ...options, now }); }
      catch (error) { if (error instanceof Error && error.message === "EXECUTION_REPORT_DUPLICATE_CONFLICT") throw new Error("INVESTOR_EXECUTION_REPORT_DUPLICATE_CONFLICT"); throw error; }
      if (revision(db, context.portfolio_id) !== context.ledger_revision) invalid();
      return { resource_id: result.id, ...result, execution_authorized: false as const, basis: executionFollowupBasis };
    }
    const fact = context.facts.find(row => row.event_id === input.event_id);
    if (!fact || fact.listing_id !== item.listing_id || fact.currency !== item.currency || fact.side !== item.side) throw new Error("INVESTOR_EXECUTION_SELECTION_INVALID");
    if (fact.link) {
      if (fact.link.proposal_item_id !== item.id || fact.link.attachment_id !== input.attachment_id) throw new Error("INVESTOR_EXECUTION_FACT_ALREADY_LINKED");
      return { resource_id: fact.event_id, consumed: false, duplicate: true, deviations: fact.link.deviations,
        execution_authorized: false as const, basis: executionFollowupBasis };
    }
    const row = getActiveLedgerEvents(db, context.portfolio_id).find(value => value.id === fact.event_id);
    if (!row) invalid();
    const existing = originalTrade(db, row, context.portfolio_id, context.account_id, now);
    // Reuse only the original durable ledger receipt: this path must never add a fact.
    const result = recordExecutionFact(db, human, { ...envelope, reason: "Owner explicitly linked an already recorded trade to independent original evidence",
      command: { ...existing.command, expected_revision: context.ledger_revision } }, { ...options, now });
    if (result.receipt.event_id !== fact.event_id || !result.receipt.duplicate || result.receipt.warnings.includes("ORIGINAL_SOURCE_SUPERSEDED")
      || revision(db, context.portfolio_id) !== context.ledger_revision) invalid();
    return { resource_id: fact.event_id, consumed: result.consumed, duplicate: result.duplicate, deviations: result.deviations,
      execution_authorized: false as const, basis: executionFollowupBasis };
  }).immediate();
}
