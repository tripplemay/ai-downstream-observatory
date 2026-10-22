import type { ExecutionFollowupContext } from "../src/server/investor/execution-followup-schemas";
import { executionFollowupBasis } from "../src/server/investor/execution-followup-schemas";
import type { ReconciliationScope } from "../src/components/workbench/investor-reconciliation-client";

export const executionBinding = "a".repeat(64);
export const executionScope: ReconciliationScope = { binding: executionBinding, workspace: "fictional-workspace", revision: 2,
  portfolio: "fictional-book", ledgerRevision: 3, linkId: "fictional-link", linkVersion: 1, accountId: "fictional-account", accountRowVersion: 4 };
export const executionContext: ExecutionFollowupContext = { schema_version: "investor-execution-followup-v1",
  workspace_id: executionScope.workspace!, workspace_revision: executionScope.revision, portfolio_id: executionScope.portfolio,
  ledger_revision: executionScope.ledgerRevision, link_id: executionScope.linkId, link_version: executionScope.linkVersion,
  account_id: executionScope.accountId, account_row_version: executionScope.accountRowVersion, account_status: "active", read_only: false,
  checked_at: "2026-01-05T12:00:00.000Z", context_hash: "c".repeat(64),
  items: [{ id: "fictional-item", proposal_id: "fictional-proposal", listing_id: "fictional-listing", ticker: "FICTIONAL", market: "CN",
    side: "buy", currency: "CNY", quantity: "600", limit_price: "100", estimated_fees: "0", created_at: "2026-01-05T11:00:00.000Z", expires_at: "2026-01-05T11:30:00.000Z" }],
  facts: [{ event_id: "fictional-fact", listing_id: "fictional-listing", side: "buy", currency: "CNY", quantity: "200", consideration: "20000",
    fee: "0", effective_at: "2026-01-05", source_timezone: "Asia/Shanghai", recorded_at: "2026-01-05T11:30:00.000Z",
    source_id: "FICTIONAL-SOURCE", source_event_id: "fill-1", link: null }],
  evidence: [{ id: "fictional-evidence", content_hash: "e".repeat(64), byte_size: 40, media_type: "text/csv", created_at: "2026-01-05T11:00:00.000Z" }],
  reports: [], basis: executionFollowupBasis, execution_authorized: false, broker_ordering_enabled: false };
