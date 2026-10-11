import { z } from "zod";
import { Decimal as LedgerDecimal } from "../ledger/decimal";
import { investorHash, investorId, investorInstant } from "./schemas";

export const HoldingsDecimal = LedgerDecimal.clone({ precision: 120 });
const Decimal = HoldingsDecimal;

export function holdingsInstantMicros(value: string): bigint | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match || value.startsWith("0000")) return null;
  const millis = Date.parse(match[1] + "Z");
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== match[1]) return null;
  return BigInt(millis) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
const instant = z.string().max(27).refine(value => holdingsInstantMicros(value) !== null);
const revision = z.number().int().nonnegative().safe();
const decimal = z.string().max(200).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,120})?$/);
const categories = ["cash_settled", "trade_receivable", "trade_payable", "dividend_receivable", "dividend_tax_payable", "transfer_in_transit", "other_liability", "security"] as const;
const component = z.object({ key: z.string().min(1).max(200), category: z.enum(categories), currency: z.string().regex(/^[A-Z]{3}$/),
  listing_id: investorId.nullable(), ticker: z.string().min(1).max(120).nullable(), name: z.string().min(1).max(200).nullable(),
  market: z.enum(["CN", "HK", "US"]).nullable(), account_ids: z.array(investorId).min(1).max(200),
  value_cny: decimal, weight: decimal, settled_quantity: decimal.nullable(), transit_quantity: decimal.nullable(),
}).strict();
export const holdingsGapCodes = ["ACCOUNT_BOOK_NOT_LINKED", "ACCOUNT_BOOK_EMPTY", "HOLDINGS_CAPACITY_REVIEW_REQUIRED", "RECONCILIATION_REQUIRED",
  "RECONCILIATION_EVIDENCE_INVALID", "RECONCILIATION_SOURCE_UNAVAILABLE", "RECONCILIATION_FACTS_CHANGED", "RECONCILIATION_MISMATCH",
  "VALUATION_REQUIRED", "VALUATION_NOT_COMPLETE", "VALUATION_NONPOSITIVE_NAV", "VALUATION_NOT_CURRENT", "VALUATION_EVIDENCE_INVALID", "VALUATION_CUTOFF_NOT_RECONCILED",
  "REFERENCE_NOT_READY", "REFERENCE_NOT_REAL_DATA", "REFERENCE_EVIDENCE_INVALID", "REFERENCE_IDENTITY_REQUIRED", "REFERENCE_IDENTITY_AMBIGUOUS"] as const;
export const investorHoldingsSchema = z.object({ schema_version: z.literal("investor-holdings-v1"),
  workspace_id: investorId.nullable(), workspace_revision: revision, checked_at: investorInstant, portfolio_id: investorId.nullable(),
  link_id: investorId.nullable(), link_version: revision.nullable(), ledger_revision: revision.nullable(), read_only: z.boolean(),
  status: z.enum(["not_linked", "evidence_required", "verified_as_of"]), gaps: z.array(z.enum(holdingsGapCodes)).max(20),
  snapshot: z.object({ valuation_id: investorId, evidence_hash: investorHash, cutoff_at: instant, created_at: instant, nav_cny: decimal,
    mode: z.literal("restated"), basis: z.literal("owner_supplied_statements_not_provider_verified"),
    account_sync: z.literal("recorded_facts_only_not_realtime"),
    reconciliations: z.array(z.object({ account_id: investorId, run_id: investorId, attachment_hash: investorHash, cutoff_at: instant }).strict()).min(1).max(200),
    components: z.array(component).max(2000),
  }).strict().nullable(),
  comparison: z.object({ plan_id: investorId, plan_hash: investorHash, valid_until: instant,
    basis: z.literal("arithmetic_difference_not_trade_recommendation"),
    rows: z.array(z.object({ research_listing_id: investorId, ledger_listing_id: investorId, symbol: z.string().min(1).max(120),
      market: z.enum(["CN", "HK", "US"]), currency: z.enum(["CNY", "HKD", "USD"]), target_weight: decimal, actual_value_cny: decimal,
      actual_weight: decimal, difference_cny: decimal, difference_weight: decimal, mapping_version_id: investorId, listing_review_id: investorId,
    }).strict()).min(1).max(20),
    outside_target_value_cny: decimal,
  }).strict().nullable(), live_advice_eligible: z.literal(false), execution_authorized: z.literal(false),
}).strict().superRefine((value, context) => {
  const bad = () => context.addIssue({ code: z.ZodIssueCode.custom, message: "INVESTOR_HOLDINGS_RESPONSE_INVALID" });
  try {
    const now = holdingsInstantMicros(value.checked_at); if (now === null) return bad();
    const bound = value.portfolio_id !== null;
    if (bound !== (value.link_id !== null) || bound !== (value.link_version !== null) || bound !== (value.ledger_revision !== null)
      || bound && (!value.workspace_id || !value.link_version || value.workspace_revision === 0)
      || value.workspace_id === null && value.workspace_revision !== 0 || new Set(value.gaps).size !== value.gaps.length
      || (value.status === "verified_as_of") !== (value.snapshot !== null) || value.status === "not_linked" && bound
      || value.status !== "not_linked" && !bound || value.status !== "verified_as_of" && value.comparison !== null
      || value.status === "verified_as_of" && value.gaps.some(code => !code.startsWith("REFERENCE_"))
      || value.comparison !== null && value.gaps.length > 0 || value.snapshot === null && value.gaps.length === 0) return bad();
    const snapshot = value.snapshot;
    if (!snapshot) return;
    const nav = new Decimal(snapshot.nav_cny), cutoff = holdingsInstantMicros(snapshot.cutoff_at), created = holdingsInstantMicros(snapshot.created_at);
    if (!nav.gt(0) || cutoff === null || created === null || cutoff > created || created > now
      || new Set(snapshot.components.map(row => row.key)).size !== snapshot.components.length
      || new Set(snapshot.reconciliations.map(row => row.account_id)).size !== snapshot.reconciliations.length) return bad();
    const accounts = new Set(snapshot.reconciliations.map(row => row.account_id));
    for (const row of snapshot.reconciliations) { const time = holdingsInstantMicros(row.cutoff_at); if (time === null || time < cutoff || time > now) return bad(); }
    for (const row of snapshot.components) {
      if (new Set(row.account_ids).size !== row.account_ids.length || row.account_ids.some(id => !accounts.has(id))
        || row.weight !== new Decimal(row.value_cny).div(nav).toFixed(18)
        || (row.category === "security") !== (row.listing_id !== null) || (row.category === "security") !== (row.market !== null)
        || row.category === "security" && (!row.ticker || !row.name || row.settled_quantity === null || row.transit_quantity === null
          || new Decimal(row.settled_quantity).lt(0) || new Decimal(row.transit_quantity).lt(0) || new Decimal(row.value_cny).lt(0))
        || row.category !== "security" && (row.ticker !== null || row.name !== null || row.settled_quantity !== null || row.transit_quantity !== null)) return bad();
    }
    if (!snapshot.components.reduce((sum, row) => sum.add(row.value_cny), new Decimal(0)).eq(nav)) return bad();
    const comparison = value.comparison;
    if (!comparison) return;
    const expiry = holdingsInstantMicros(comparison.valid_until);
    if (expiry === null || expiry <= now || new Set(comparison.rows.map(row => row.research_listing_id)).size !== comparison.rows.length
      || new Set(comparison.rows.map(row => row.ledger_listing_id)).size !== comparison.rows.length
      || !comparison.rows.reduce((sum, row) => sum.add(row.target_weight), new Decimal(0)).eq(1)) return bad();
    let allocated = new Decimal(0);
    for (const row of comparison.rows) {
      const actual = snapshot.components.filter(item => item.listing_id === row.ledger_listing_id).reduce((sum, item) => sum.add(item.value_cny), new Decimal(0));
      const weight = new Decimal(row.target_weight);
      if (!weight.gt(0) || weight.gt(1) || !actual.eq(row.actual_value_cny) || row.actual_weight !== actual.div(nav).toFixed(18)
        || row.difference_cny !== actual.minus(nav.mul(weight)).toFixed()
        || row.difference_weight !== actual.div(nav).minus(weight).toFixed(18)
        || snapshot.components.some(item => item.listing_id === row.ledger_listing_id && (item.market !== row.market || item.currency !== row.currency))) return bad();
      allocated = allocated.add(actual);
    }
    if (!nav.minus(allocated).eq(comparison.outside_target_value_cny)) bad();
  } catch { bad(); }
});
export type InvestorHoldings = z.infer<typeof investorHoldingsSchema>;
export type HoldingsGapCode = typeof holdingsGapCodes[number];
