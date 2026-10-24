import { investorHoldingsSchema, holdingsInstantMicros, type InvestorHoldings } from "@/server/investor/holdings-schemas";
import { investorHash } from "@/server/investor/schemas";
import type { InvestorPlan } from "@/server/investor/types";

const response = investorHoldingsSchema.safeExtend({ session_binding: investorHash }).strict();
export function parseInvestorHoldings(raw: unknown, expected: { binding: string; workspace: string | null; revision: number; portfolio: string | null;
  linkId: string | null; linkVersion: number | null; ledgerRevision: number | null; accountIds: string[]; plan: InvestorPlan | null }): InvestorHoldings {
  const parsed = response.safeParse(raw);
  if (!parsed.success || parsed.data.session_binding !== expected.binding || parsed.data.workspace_id !== expected.workspace || parsed.data.workspace_revision !== expected.revision
    || parsed.data.portfolio_id !== expected.portfolio || parsed.data.link_id !== expected.linkId || parsed.data.link_version !== expected.linkVersion
    || parsed.data.ledger_revision !== expected.ledgerRevision || parsed.data.comparison && (parsed.data.comparison.plan_id !== expected.plan?.id || parsed.data.comparison.plan_hash !== expected.plan?.content_hash))
    throw new Error("INVESTOR_HOLDINGS_RESPONSE_INVALID");
  const { session_binding: _, ...value } = parsed.data;
  const checked = investorHoldingsSchema.safeParse(value);
  if (!checked.success) throw new Error("INVESTOR_HOLDINGS_RESPONSE_INVALID");
  if (checked.data.snapshot && (checked.data.snapshot.reconciliations.length !== expected.accountIds.length
    || checked.data.snapshot.reconciliations.some(row => !expected.accountIds.includes(row.account_id)))) throw new Error("INVESTOR_HOLDINGS_RESPONSE_INVALID");
  const comparison = checked.data.comparison, plan = expected.plan;
  if (comparison && (!plan || plan.quality !== "current" || plan.document.data_mode !== "reconstructed"
    || holdingsInstantMicros(comparison.valid_until)! > holdingsInstantMicros(plan.document.valid_until)!
    || comparison.rows.length !== plan.document.targets.length || comparison.rows.some(row => {
      const target = plan.document.targets.find(target => target.listing_id === row.research_listing_id);
      return !target || row.symbol !== target.symbol || row.market !== target.market || row.currency !== target.currency || row.target_weight !== target.weight;
    }))) throw new Error("INVESTOR_HOLDINGS_RESPONSE_INVALID");
  return checked.data;
}
