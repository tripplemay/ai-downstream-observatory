import type Database from "better-sqlite3";
import type { z } from "zod";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { commandEnvelope, proposalSchema } from "../governance/schemas";

export type GovernanceAudit = { id: string; actor_id: string; action: string; object_type: string; object_id: string;
  portfolio_id: string; ledger_revision: number; payload_json: string; created_at: string };
export function proposalEvidenceInvalid(): never { throw new Error("INVESTOR_PROPOSAL_EVIDENCE_INVALID"); }
export function proofObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) proposalEvidenceInvalid(); return value as Record<string, unknown>;
}
/** A receipt is checked against its original command, not a caller's PASS assertion. */
export function readGovernanceAudit(db: Database.Database, portfolio: string, action: string, path: string, id: string, schema: z.ZodTypeAny) {
  const rows = db.prepare(`SELECT * FROM audit_events WHERE portfolio_id=? AND action=? AND json_extract(payload_json,?)=? LIMIT 2`)
    .all(portfolio, action, path, id) as GovernanceAudit[];
  if (rows.length !== 1) proposalEvidenceInvalid();
  const audit = rows[0], body = proofObject(parseStrictJson(audit.payload_json)), input = proofObject(schema.parse(body.input));
  const envelope = commandEnvelope.parse(input), result = proofObject(body.result);
  if (canonical(input) !== canonical(body.input) || envelope.portfolio_id !== portfolio || !audit.actor_id.trim()
    || audit.object_type !== "governance" || audit.object_id !== envelope.idempotency_key || audit.ledger_revision !== envelope.expected_revision) proposalEvidenceInvalid();
  const prior = db.prepare("SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?")
    .get(`governance:${action}:${portfolio}`, envelope.idempotency_key) as { payload_hash: string; result_json: string } | undefined;
  const { expected_revision: _, idempotency_key: __, ...semantic } = input;
  if (!prior || prior.payload_hash !== hash(semantic) || canonical(parseStrictJson(prior.result_json)) !== canonical(result)) proposalEvidenceInvalid();
  return { audit, input, result, prior };
}
export function readCreatedProposal(db: Database.Database, portfolio: string, id: string) {
  const proposal = db.prepare("SELECT * FROM proposals WHERE portfolio_id=? AND id=? AND environment='actual'").get(portfolio, id) as
    { id: string; portfolio_id: string; policy_version_id: string; strategy_version_id: string; input_hash: string; ledger_revision: number;
      market_manifest: string; created_at: string; expires_at: string } | undefined;
  if (!proposal) proposalEvidenceInvalid();
  const original = readGovernanceAudit(db, portfolio, "create_proposal", "$.result.id", id, proposalSchema);
  const input = proposalSchema.parse(original.input), receipt = original.result, context = proofObject(parseStrictJson(proposal.market_manifest));
  const items = db.prepare("SELECT * FROM proposal_items WHERE proposal_id=? ORDER BY id LIMIT 101").all(id) as
    { id: string; proposal_id: string; account_id: string; listing_id: string; side: "buy" | "sell"; currency: string;
      quantity: string; limit_price: string; estimated_fees: string; dependencies_json: string }[];
  if (items.length !== input.items.length || !Array.isArray(receipt.item_ids) || receipt.item_ids.length !== items.length
    || new Set(receipt.item_ids).size !== items.length || original.audit.created_at !== proposal.created_at
    || input.expected_revision !== proposal.ledger_revision || receipt.input_hash !== proposal.input_hash || input.expires_at !== proposal.expires_at
    || context.activation_id !== input.activation_id || context.valuation_id !== input.valuation_id || context.ai_run_id !== input.ai_run_id
    || hash({ portfolio_id: portfolio, ledger_revision: proposal.ledger_revision, policy_version_id: proposal.policy_version_id,
      strategy_version_id: proposal.strategy_version_id, context: { ...context, ai_run_id: undefined }, items: input.items, expires_at: proposal.expires_at }) !== proposal.input_hash) proposalEvidenceInvalid();
  for (const [index, itemId] of receipt.item_ids.entries()) {
    const item = items.find(row => row.id === itemId); if (!item) proposalEvidenceInvalid();
    const { id: _, proposal_id: __, dependencies_json, ...body } = item;
    if (canonical(parseStrictJson(dependencies_json)) !== "[]" || canonical(body) !== canonical(input.items[index])) proposalEvidenceInvalid();
  }
  return { proposal, items, original };
}
