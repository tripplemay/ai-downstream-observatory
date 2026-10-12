import { z } from "zod";
import { amount } from "../ledger/decimal";
import { statementSchema, RECONCILIATION_BALANCES, reconciliationInstantMicros } from "../ledger/reconciliation-schemas";
export { reconciliationInstantMicros } from "../ledger/reconciliation-schemas";

// Kept independent from investor/schemas to avoid a command-schema import cycle.
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/), revision = z.number().int().nonnegative().safe();
const instant = z.string().refine(value => reconciliationInstantMicros(value) !== null);
export const investorStatementSchema = statementSchema.extend({
  cutoff_at: instant, balances: statementSchema.shape.balances.max(160), positions: statementSchema.shape.positions.max(100),
  security_transits: statementSchema.shape.security_transits.unwrap().max(30),
}).superRefine((value, context) => {
  const invalid = () => context.addIssue({ code: z.ZodIssueCode.custom, message: "INVESTOR_STATEMENT_INVALID" });
  if (value.coverage.currencies.length > 20 || new Set(value.coverage.currencies).size !== value.coverage.currencies.length
    || value.coverage.security_transits_complete !== true || value.coverage.ledger_accounts.length !== RECONCILIATION_BALANCES.length
    || new Set(value.coverage.ledger_accounts).size !== RECONCILIATION_BALANCES.length
    || value.balances.length !== value.coverage.currencies.length * RECONCILIATION_BALANCES.length
    || new Set(value.balances.map(row => row.currency + ":" + row.ledger_account)).size !== value.balances.length
    || value.balances.some(row => !value.coverage.currencies.includes(row.currency))
    || new Set(value.positions.map(row => row.listing_id)).size !== value.positions.length
    || new Set(value.security_transits.map(row => row.transfer_event_id)).size !== value.security_transits.length
    || [...value.positions, ...value.security_transits].some(row => amount(row.quantity).lt(0) || !value.coverage.currencies.includes(row.currency))) invalid();
});
export const reconciliationIntentSchema = z.object({ action: z.literal("reconcile_linked_account"), portfolio_id: id, account_id: id,
  expected_ledger_revision: revision, expected_account_row_version: revision, expected_link_id: id, expected_link_version: revision.refine(value => value > 0),
  source_reference: z.string().trim().min(1).max(500), basis: z.literal("operator_transcription_not_broker_file"),
  acknowledgement: z.literal(true), statement: investorStatementSchema, resolves_issue_ids: z.array(id).max(100), resolution_reason: z.string().trim().max(500),
}).strict();
const listing = z.object({ id, ticker: z.string().min(1).max(120), name: z.string().min(1).max(200), market: z.enum(["CN", "HK", "US"]), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
export const reconciliationContextSchema = z.object({ schema_version: z.literal("investor-reconciliation-v1"), workspace_id: id, workspace_revision: revision,
  checked_at: instant, portfolio_id: id, ledger_revision: revision, link_id: id, link_version: revision.refine(value => value > 0),
  account_id: id, account_row_version: revision, read_only: z.boolean(),
  requirements: z.object({ currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(20), known_positions: z.array(id).max(100), listings: z.array(listing).max(200),
    transits: z.array(z.object({ transfer_event_id: id, source_account_id: id, target_account_id: id, listing_id: id, currency: z.string().regex(/^[A-Z]{3}$/),
      source_name: z.string().min(1).max(120), target_name: z.string().min(1).max(120) }).strict()).max(30),
  }).strict(),
  latest: z.object({ id, status: z.enum(["matched", "issues"]), ledger_revision: revision, cutoff_at: instant, created_at: instant,
    issue_count: revision, prior_open_issues: revision, account_activated: z.boolean(), current_facts: z.boolean() }).strict().nullable(),
  history_status: z.enum(["verified", "unavailable"]), open_issue_count: revision,
  open_issues: z.array(z.object({ id, code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/), cutoff_at: instant }).strict()).max(100),
  scope: z.literal("metadata_only_no_prefilled_balances"), execution_authorized: z.literal(false),
}).strict().superRefine((value, context) => {
  const bad = () => context.addIssue({ code: z.ZodIssueCode.custom, message: "INVESTOR_RECONCILIATION_RESPONSE_INVALID" });
  if (!value.workspace_revision || new Set(value.requirements.currencies).size !== value.requirements.currencies.length
    || new Set(value.requirements.listings.map(row => row.id)).size !== value.requirements.listings.length
    || new Set(value.requirements.known_positions).size !== value.requirements.known_positions.length
    || value.requirements.known_positions.some(id => !value.requirements.listings.some(row => row.id === id))
    || value.requirements.listings.filter(row => value.requirements.known_positions.includes(row.id)).some(row => !value.requirements.currencies.includes(row.currency))
    || new Set(value.requirements.transits.map(row => row.transfer_event_id)).size !== value.requirements.transits.length
    || value.requirements.transits.some(row => ![row.source_account_id, row.target_account_id].includes(value.account_id)
      || row.source_account_id === row.target_account_id || !value.requirements.currencies.includes(row.currency)
      || !value.requirements.listings.some(listing => listing.id === row.listing_id && listing.currency === row.currency))
    || (value.history_status === "verified" ? value.open_issue_count !== value.open_issues.length : value.latest !== null || value.open_issues.length > 0)
    || new Set(value.open_issues.map(row => row.id)).size !== value.open_issues.length
    || value.open_issues.some(row => reconciliationInstantMicros(row.cutoff_at)! > reconciliationInstantMicros(value.checked_at)!)
    || value.latest && (value.latest.ledger_revision > value.ledger_revision || reconciliationInstantMicros(value.latest.cutoff_at)! > reconciliationInstantMicros(value.latest.created_at)!
      || reconciliationInstantMicros(value.latest.created_at)! > reconciliationInstantMicros(value.checked_at)! || (value.latest.status === "matched") !== (value.latest.issue_count === 0)
      || value.latest.account_activated && (value.latest.status !== "matched" || value.latest.prior_open_issues !== 0)
      || value.latest.current_facts !== (value.latest.ledger_revision === value.ledger_revision))) bad();
});
export type ReconciliationContext = z.infer<typeof reconciliationContextSchema>;
export type ReconciliationIntent = z.infer<typeof reconciliationIntentSchema>;
