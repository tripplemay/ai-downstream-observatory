import { blankCashRecordingDraft } from "../src/components/workbench/investor-cash-recording-client";
import { cashRecordingContextSchema } from "../src/server/investor/cash-recording-schemas";

export const cashBinding = "a".repeat(64);
export const cashContext = cashRecordingContextSchema.parse({ schema_version: "investor-cash-recording-v1", workspace_id: "fictional-workspace",
  workspace_revision: 2, portfolio_id: "fictional-book", ledger_revision: 3, link_id: "fictional-link", link_version: 1,
  account_id: "fictional-account", account_row_version: 4, account_status: "active", base_currency: "CNY", checked_at: "2026-01-02T00:15:00.000Z",
  read_only: false, context_hash: "c".repeat(64), allowed_currencies: ["CNY", "HKD", "USD"], basis: "metadata_only_no_fact_prefill", execution_authorized: false });
export const cashScope = { binding: cashBinding, workspace: cashContext.workspace_id, revision: cashContext.workspace_revision,
  portfolio: cashContext.portfolio_id, ledgerRevision: cashContext.ledger_revision, linkId: cashContext.link_id, linkVersion: cashContext.link_version,
  accountId: cashContext.account_id, accountRowVersion: cashContext.account_row_version };
export function validCashDraft() { return { ...blankCashRecordingDraft(), direction: "deposit", currency: "USD", amount: "300.01",
  date: "2026-01-01", zone: "America/New_York", source: "FICTIONAL", sourceEvent: "cash-1", reference: "Fictional cash record", acknowledged: true }; }
