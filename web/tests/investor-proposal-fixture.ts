import type { ProposalReviewContext } from "../src/server/investor/proposal-review-schemas";
import { proposalReviewBasis } from "../src/server/investor/proposal-review-schemas";
import type { ValuationScope } from "../src/components/workbench/investor-valuation-client";

// Fictional display contract only; this is not real market or strategy-admission evidence.
export const proposalBinding = "a".repeat(64);
export const proposalScope: ValuationScope = { binding: proposalBinding, workspace: "fictional-workspace", revision: 2,
  portfolio: "fictional-book", ledgerRevision: 3, linkId: "fictional-link", linkVersion: 1 };
const header = { id: "fictional-proposal", created_at: "2026-01-05T11:00:00.000Z", expires_at: "2026-01-05T12:30:00.000Z", has_active_reservations: false };
export const proposalContext: ProposalReviewContext = { schema_version: "investor-proposal-review-v1", workspace_id: proposalScope.workspace!,
  workspace_revision: proposalScope.revision, portfolio_id: proposalScope.portfolio, ledger_revision: proposalScope.ledgerRevision,
  link_id: proposalScope.linkId, link_version: proposalScope.linkVersion, checked_at: "2026-01-05T12:00:00.000Z", read_only: false,
  context_hash: "c".repeat(64), proposals: [header], selected: { ...header, policy_version_id: "fictional-policy", strategy_version_id: "fictional-strategy",
    items: [{ id: "fictional-item", account_id: "fictional-account", account_name: "Fictional account", listing_id: "fictional-listing", ticker: "FICTIONAL",
      market: "CN", currency: "CNY", side: "buy", quantity: "600", limit_price: "100", estimated_fees: "0" }],
    current_risk: { status: "pass", input_hash: "d".repeat(64), checks: [{ code: "DETERMINISTIC_RISK_PASS" }],
      budgets: [{ item_id: "fictional-item", account_id: "fictional-account", currency: "CNY", side: "buy", amount: "60000", quantity: "600" }] },
    recorded_risk: { id: "fictional-risk", created_at: "2026-01-05T11:00:00.000Z", status: "pass", input_hash: "d".repeat(64), matches_current: true },
    approval: null, preparation: null, reservations: [], allowed_operations: ["risk_check", "approve", "cancel_remainder"] },
  basis: proposalReviewBasis, broker_ordering_enabled: false, automated_execution_enabled: false };
