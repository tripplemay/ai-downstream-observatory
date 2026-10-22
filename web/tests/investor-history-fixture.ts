import type { InvestorHistory } from "../src/server/investor/history-schemas";
export const historyBinding = "a".repeat(64);
export const historyPage: InvestorHistory = { schema_version: "investor-history-v1", workspace_id: "fictional-workspace", checked_at: "2026-01-02T12:00:10.000Z",
  mode: "observations", observation_id: null, entries: [{ id: "fictional-observation", recorded_outcome: "decision_required", read_outcome: "decision_required",
    evaluated_at: "2026-01-02T12:00:00.000Z", profile_version: 1, input_version: "b".repeat(64), data_cutoff: "2026-01-01T12:00:00.000Z",
    reasons: ["Fictional historical observation only"], gaps: [], next_review_at: "2026-01-03T12:00:00.000Z", next_conditions: ["Fictional source update"], latest_decision: null, more_decisions: false }],
  decisions: [], previous_cursor: null, next_cursor: "fictional_cursor", historical_only: true, is_current_conclusion: false, live_advice_eligible: false };
