import { z } from "zod";
import { investorHash, investorId, investorInstant } from "./schemas";

const revision = z.number().int().nonnegative().safe();
// Legacy ledger writers use both millisecond and microsecond UTC timestamps.
export function accountInstantMicros(value: string): bigint | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}|\d{6})Z$/.exec(value);
  if (!match || value.startsWith("0000")) return null;
  const millis = Date.parse(match[1] + "Z");
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== match[1]) return null;
  return BigInt(millis) * 1000n + BigInt(match[2].padEnd(6, "0"));
}
const accountInstant = z.string().refine(value => accountInstantMicros(value) !== null);
export const portfolioLinkDocumentSchema = z.object({
  schema_version: z.literal("investor-portfolio-link-v1"), portfolio_id: investorId.nullable(), creation_audit_id: investorId.nullable(),
  ledger_revision_at_link: revision.nullable(), linked_at: investorInstant,
}).strict().refine(value => (value.portfolio_id === null) === (value.creation_audit_id === null)
  && (value.portfolio_id === null) === (value.ledger_revision_at_link === null));
export const portfolioLinkSchema = z.object({ id: investorId, version: revision.refine(value => value > 0), content_hash: investorHash,
  document: portfolioLinkDocumentSchema }).strict();
export const investorAccountsSchema = z.object({
  schema_version: z.literal("investor-accounts-v1"), workspace_id: investorId.nullable(), workspace_revision: revision,
  checked_at: investorInstant, read_only: z.boolean(), link: portfolioLinkSchema.nullable(),
  books: z.array(z.object({ id: investorId, name: z.string().min(1).max(120), ledger_revision: revision, created_at: accountInstant }).strict()).max(100),
  accounts: z.array(z.object({ id: investorId, name: z.string().min(1).max(120), broker: z.string().min(1).max(120),
    base_currency: z.string().regex(/^[A-Z]{3}$/), status: z.enum(["active", "disabled", "reconciliation_required"]),
    row_version: revision, created_at: accountInstant }).strict()).max(200),
  scope: z.literal("account_records_not_valued"), live_advice_eligible: z.literal(false), execution_authorized: z.literal(false),
}).strict().superRefine((value, context) => {
  const book = value.books.find(row => row.id === value.link?.document.portfolio_id);
  const checked = accountInstantMicros(value.checked_at);
  const futureOrInvalid = (raw: string) => { const time = accountInstantMicros(raw); return checked === null || time === null || time > checked; };
  if (new Set(value.books.map(row => row.id)).size !== value.books.length || new Set(value.accounts.map(row => row.id)).size !== value.accounts.length
    || value.books.some(row => futureOrInvalid(row.created_at)) || value.accounts.some(row => futureOrInvalid(row.created_at))
    || value.link && futureOrInvalid(value.link.document.linked_at)
    || value.link?.document.portfolio_id && (!book || book.ledger_revision < value.link.document.ledger_revision_at_link!)
    || !value.link?.document.portfolio_id && value.accounts.length > 0
    || value.workspace_id === null && (value.workspace_revision !== 0 || value.link !== null || value.books.length > 0 || value.accounts.length > 0)
    || value.workspace_id !== null && value.workspace_revision === 0) context.addIssue({ code: z.ZodIssueCode.custom, message: "INVESTOR_ACCOUNT_RESPONSE_INVALID" });
});
export type InvestorPortfolioLink = z.infer<typeof portfolioLinkSchema>;
export type InvestorAccountWorkspace = z.infer<typeof investorAccountsSchema>;
