import { z } from "zod";
import { valuationContextSchema, valuationIntentSchema, type ValuationContext, type ValuationIntent } from "@/server/investor/valuation-schemas";

export type ValuationScope = { binding: string; workspace: string | null; revision: number; portfolio: string; ledgerRevision: number; linkId: string; linkVersion: number };
const response = valuationContextSchema.extend({ session_binding: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function parseValuationContext(value: unknown, expected: ValuationScope): ValuationContext {
  const { session_binding, ...document } = response.parse(value);
  if (session_binding !== expected.binding || document.workspace_id !== expected.workspace || document.workspace_revision !== expected.revision
    || document.portfolio_id !== expected.portfolio || document.ledger_revision !== expected.ledgerRevision || document.link_id !== expected.linkId
    || document.link_version !== expected.linkVersion) throw new Error("INVESTOR_VALUATION_RESPONSE_INVALID");
  return document;
}
export type ValuationDraft = { prices: { market: "CN" | "HK" | "US"; scope: string; session: string }[]; fxScope: string; fxAge: string; reference: string; acknowledged: boolean };
export function blankValuationDraft(context: ValuationContext): ValuationDraft {
  return { prices: [...new Set(context.listings.map(row => row.market))].sort().map(market => ({ market, scope: "", session: "" })),
    fxScope: "", fxAge: "", reference: "", acknowledged: false };
}
export function buildValuationIntent(context: ValuationContext, draft: ValuationDraft): ValuationIntent {
  if (!valuationContextSchema.safeParse(context).success || context.read_only || context.gaps.length || !context.cutoff_at) throw new Error("INVESTOR_VALUATION_DRAFT_INVALID");
  const markets = [...new Set(context.listings.map(row => row.market))].sort();
  if (JSON.stringify(draft.prices.map(row => row.market).sort()) !== JSON.stringify(markets)) throw new Error("INVESTOR_VALUATION_DRAFT_INVALID");
  const foreign = context.currencies.some(currency => currency !== "CNY");
  if (foreign && (!/^[0-9]{1,7}$/.test(draft.fxAge) || !context.sources.some(row => row.scope === draft.fxScope && row.batch_type === "fx"))
    || draft.prices.some(price => !context.sources.some(row => row.scope === price.scope && row.batch_type === "prices" && row.markets.includes(price.market)))) throw new Error("INVESTOR_VALUATION_DRAFT_INVALID");
  return valuationIntentSchema.parse({ action: "request_linked_valuation", portfolio_id: context.portfolio_id, expected_ledger_revision: context.ledger_revision,
    expected_link_id: context.link_id, expected_link_version: context.link_version, expected_context_hash: context.context_hash, cutoff_at: context.cutoff_at,
    prices: draft.prices.map(row => ({ market: row.market, scope: row.scope, expected_session: row.session })),
    fx: foreign ? { scope: draft.fxScope, max_age_seconds: Number(draft.fxAge) } : null, source_reference: draft.reference,
    acknowledgement: draft.acknowledged, basis: "owner_reviewed_valuation_rules_not_provider_certification" });
}
