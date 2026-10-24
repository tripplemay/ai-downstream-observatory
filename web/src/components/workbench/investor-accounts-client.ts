import { investorAccountsSchema, type InvestorAccountWorkspace } from "@/server/investor/account-schemas";
import { investorHash } from "@/server/investor/schemas";

const responseSchema = investorAccountsSchema.safeExtend({ session_binding: investorHash }).strict();
export function parseInvestorAccounts(value: unknown, expected: { binding: string; workspace: string | null; revision: number }): InvestorAccountWorkspace {
  const result = responseSchema.safeParse(value);
  if (!result.success || result.data.session_binding !== expected.binding || result.data.workspace_id !== expected.workspace
    || result.data.workspace_revision !== expected.revision) throw new Error("INVESTOR_ACCOUNT_RESPONSE_INVALID");
  const { session_binding: _, ...document } = result.data;
  const checked = investorAccountsSchema.safeParse(document);
  if (!checked.success) throw new Error("INVESTOR_ACCOUNT_RESPONSE_INVALID");
  return checked.data;
}
