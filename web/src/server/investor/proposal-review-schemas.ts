import { z } from "zod";
import { reconciliationInstantMicros } from "../ledger/reconciliation-schemas";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().safe().nonnegative(), instant = z.string().max(40).refine(value => reconciliationInstantMicros(value) !== null);
const decimal = z.string().max(80).regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/), positive = decimal.refine(value => /[1-9]/.test(value));
const currency = z.string().regex(/^[A-Z]{3}$/);
export const proposalReviewBasis = "owned_account_proposal_control_not_broker_order" as const;
export const proposalOperationSchema = z.enum(["risk_check", "approve", "prepare", "cancel_remainder", "expire"]);
export const proposalReviewIntentSchema = z.object({ action: z.literal("review_linked_proposal"), portfolio_id: id, proposal_id: id,
  expected_ledger_revision: revision, expected_link_id: id, expected_link_version: revision.positive(), expected_context_hash: digest,
  operation: proposalOperationSchema, note: z.string().trim().max(1000), basis: z.literal(proposalReviewBasis), acknowledgement: z.literal(true) }).strict();
export const proposalRiskSchema = z.object({ status: z.enum(["pass", "blocked"]), input_hash: digest,
  checks: z.array(z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_:.-]{0,199}$/), detail: z.string().max(2000).optional() }).strict()).min(1).max(100),
  budgets: z.array(z.object({ item_id: id, account_id: id, currency, side: z.enum(["buy", "sell"]), amount: decimal, quantity: positive }).strict()).max(100),
}).strict();
const header = z.object({ id, created_at: instant, expires_at: instant, has_active_reservations: z.boolean() }).strict();
export const proposalReviewContextSchema = z.object({ schema_version: z.literal("investor-proposal-review-v1"), workspace_id: id,
  workspace_revision: revision.positive(), portfolio_id: id, ledger_revision: revision, link_id: id, link_version: revision.positive(),
  checked_at: z.string().datetime({ precision: 3 }), read_only: z.boolean(), context_hash: digest, proposals: z.array(header).max(50),
  selected: header.extend({ policy_version_id: id, strategy_version_id: id,
    items: z.array(z.object({ id, account_id: id, account_name: z.string().min(1).max(120), listing_id: id, ticker: z.string().min(1).max(120),
      market: z.enum(["CN", "HK", "US"]), side: z.enum(["buy", "sell"]), currency, quantity: positive, limit_price: positive, estimated_fees: decimal }).strict()).min(1).max(100),
    current_risk: proposalRiskSchema,
    recorded_risk: z.object({ id, created_at: instant, status: z.enum(["pass", "blocked"]), input_hash: digest, matches_current: z.boolean() }).strict().nullable(),
    approval: z.object({ id, created_at: instant, ledger_revision: revision, input_hash: digest }).strict().nullable(),
    preparation: z.object({ id, created_at: instant }).strict().nullable(),
    reservations: z.array(z.object({ id, proposal_item_id: id, approval_id: id, side: z.enum(["buy", "sell"]), currency,
      amount: decimal, quantity: decimal, status: z.enum(["active", "released", "filled", "expired"]), row_version: revision }).strict()).max(100),
    allowed_operations: z.array(proposalOperationSchema).max(5),
  }).strict().nullable(), basis: z.literal(proposalReviewBasis), broker_ordering_enabled: z.literal(false), automated_execution_enabled: z.literal(false),
}).strict().superRefine((value, context) => {
  const fail = () => context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_PROPOSAL_REVIEW_BINDING" });
  const future = (at: string) => reconciliationInstantMicros(at)! > reconciliationInstantMicros(value.checked_at)!;
  if (new Set(value.proposals.map(row => row.id)).size !== value.proposals.length || value.proposals.some(row => future(row.created_at)
    || reconciliationInstantMicros(row.expires_at)! <= reconciliationInstantMicros(row.created_at)!)) fail();
  const selected = value.selected;
  if (!selected) return;
  if (!value.proposals.some(row => row.id === selected.id) || new Set(selected.items.map(row => row.id)).size !== selected.items.length
    || new Set(selected.allowed_operations).size !== selected.allowed_operations.length
    || selected.recorded_risk && future(selected.recorded_risk.created_at) || selected.approval && future(selected.approval.created_at)
    || selected.preparation && (!selected.approval || future(selected.preparation.created_at))) fail();
  if (selected.reservations.some(row => !selected.items.some(item => item.id === row.proposal_item_id && item.side === row.side && item.currency === row.currency)
    || row.approval_id !== selected.approval?.id)) fail();
  if (value.read_only && selected.allowed_operations.length) fail();
});
export type ProposalReviewContext = z.infer<typeof proposalReviewContextSchema>;
export type ProposalReviewIntent = z.infer<typeof proposalReviewIntentSchema>;
