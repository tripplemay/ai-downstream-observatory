import { valuationContextSchema } from "../src/server/investor/valuation-schemas";
import { blankValuationDraft } from "../src/components/workbench/investor-valuation-client";

export const valuationBinding = "a".repeat(64);
export const valuationContext = valuationContextSchema.parse({ schema_version: "investor-valuation-v1", workspace_id: "fictional-workspace", workspace_revision: 2,
  portfolio_id: "fictional-book", ledger_revision: 3, link_id: "fictional-link", link_version: 1, context_hash: "c".repeat(64),
  checked_at: "2026-01-02T12:00:20.000Z", read_only: false, cutoff_at: "2026-01-02T12:00:10.000Z",
  accounts: [{ id: "fictional-account", row_version: 4, status: "active", gap: null, reconciliation: { run_id: "fictional-recon", attachment_hash: "d".repeat(64), cutoff_at: "2026-01-02T12:00:10.000Z" } }],
  listings: [{ id: "fictional-listing", ticker: "FICTIONAL", market: "CN", currency: "CNY" }], currencies: ["CNY", "USD"],
  sources: [{ scope: "fictional-prices", revision: 1, manifest_hash: "d".repeat(64), batch_type: "prices", mode: "manual_verified", markets: ["CN"] },
    { scope: "fictional-fx", revision: 1, manifest_hash: "e".repeat(64), batch_type: "fx", mode: "manual_verified", markets: [] }],
  gaps: [], task: null, basis: "metadata_only_whole_book_historical_requirements", execution_authorized: false });
export const valuationScope = { binding: valuationBinding, workspace: valuationContext.workspace_id, revision: valuationContext.workspace_revision,
  portfolio: valuationContext.portfolio_id, ledgerRevision: valuationContext.ledger_revision, linkId: valuationContext.link_id, linkVersion: valuationContext.link_version };
export function validValuationDraft() { return { ...blankValuationDraft(valuationContext), prices: [{ market: "CN" as const, scope: "fictional-prices", session: "2026-01-02" }],
  fxScope: "fictional-fx", fxAge: "86400", reference: "Fictional independent source review", acknowledged: true }; }
