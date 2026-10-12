import { z } from "zod";
import { amount } from "./decimal";

export const BASE_RECONCILIATION_BALANCES = ["cash_settled", "trade_receivable", "trade_payable", "dividend_receivable", "transfer_in_transit", "other_liability", "cash_hold"] as const;
export const RECONCILIATION_BALANCES = [...BASE_RECONCILIATION_BALANCES, "dividend_tax_payable"] as const;
export function reconciliationInstantMicros(value: string): bigint | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match || value.startsWith("0000")) return null;
  const milliseconds = Date.parse(match[1] + "Z");
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== match[1]) return null;
  return BigInt(milliseconds) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
const id = z.string().min(1).max(200), currency = z.string().regex(/^[A-Z]{3}$/);
const decimal = z.string().max(80).superRefine((value, context) => {
  try { amount(value); } catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_DECIMAL" }); }
});
export const statementSchema = z.object({
  schema_version: z.literal(1), portfolio_id: id, account_id: id,
  cutoff_at: z.string().datetime({ offset: false }),
  coverage: z.object({ currencies: z.array(currency).min(1).max(100),
    ledger_accounts: z.array(z.enum(RECONCILIATION_BALANCES)).min(1).max(RECONCILIATION_BALANCES.length),
    positions_complete: z.literal(true), balances_complete: z.literal(true), security_transits_complete: z.literal(true).optional(),
  }).strict(),
  balances: z.array(z.object({ currency, ledger_account: z.enum(RECONCILIATION_BALANCES), balance: decimal }).strict()).max(1000),
  positions: z.array(z.object({ listing_id: id, currency, quantity: decimal }).strict()).max(10000),
  security_transits: z.array(z.object({ transfer_event_id: id, source_account_id: id, target_account_id: id, listing_id: id, currency, quantity: decimal }).strict()).max(10000).optional(),
}).strict();
export type AccountStatement = z.infer<typeof statementSchema>;
