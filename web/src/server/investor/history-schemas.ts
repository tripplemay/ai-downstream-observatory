import { z } from "zod";
import { evidenceGapSchema, investorHash, investorId, investorInstant } from "./schemas";

export const historyCursor = z.string().min(1).max(1400).regex(/^[A-Za-z0-9_-]+$/);
export const historyQuerySchema = z.object({ observation: investorId.optional(), cursor: historyCursor.optional() }).strict();
export const historyDecisionSchema = z.object({ id: investorId, observation_id: investorId,
  decision: z.enum(["accept_idea", "defer", "reject"]), note: z.string().max(2000), created_at: investorInstant }).strict();
const outcome = z.enum(["observe", "decision_required", "insufficient_evidence"]);
export const historyObservationSchema = z.object({ id: investorId, recorded_outcome: outcome, read_outcome: outcome,
  evaluated_at: investorInstant, profile_version: z.number().int().safe().positive(), input_version: investorHash,
  data_cutoff: investorInstant.nullable(), reasons: z.array(z.string().min(1).max(1500)).max(20),
  gaps: z.array(evidenceGapSchema).max(40), next_review_at: investorInstant.nullable(),
  next_conditions: z.array(z.string().min(1).max(500)).min(1).max(20),
  latest_decision: historyDecisionSchema.nullable(), more_decisions: z.boolean() }).strict();
export const investorHistorySchema = z.object({ schema_version: z.literal("investor-history-v1"), workspace_id: investorId.nullable(),
  checked_at: investorInstant, mode: z.enum(["observations", "decisions"]), observation_id: investorId.nullable(),
  entries: z.array(historyObservationSchema).max(20), decisions: z.array(historyDecisionSchema).max(20),
  previous_cursor: historyCursor.nullable(), next_cursor: historyCursor.nullable(),
  historical_only: z.literal(true), is_current_conclusion: z.literal(false), live_advice_eligible: z.literal(false),
}).strict().superRefine((value, context) => {
  const fail = () => context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_HISTORY_BINDING" });
  if (value.mode === "observations" ? value.observation_id !== null || value.decisions.length !== 0
    : value.observation_id === null || value.entries.length !== 1 || value.entries[0].id !== value.observation_id) fail();
  if (!value.workspace_id && (value.entries.length || value.decisions.length || value.previous_cursor || value.next_cursor)) fail();
  for (const rows of [value.entries, value.decisions]) {
    if (new Set(rows.map(row => row.id)).size !== rows.length) fail();
    for (let index = 1; index < rows.length; index++) {
      const a = rows[index - 1], b = rows[index];
      const left = "evaluated_at" in a ? a.evaluated_at : a.created_at, right = "evaluated_at" in b ? b.evaluated_at : b.created_at;
      if (left < right) fail();
    }
  }
  if (value.entries.some(row => row.evaluated_at > value.checked_at || row.data_cutoff !== null && row.data_cutoff > row.evaluated_at
    || row.next_review_at !== null && row.next_review_at <= row.evaluated_at
    || row.latest_decision && (row.latest_decision.observation_id !== row.id || row.latest_decision.created_at < row.evaluated_at || row.latest_decision.created_at > value.checked_at))) fail();
  if (value.decisions.some(row => row.observation_id !== value.observation_id || row.created_at > value.checked_at
    || value.entries[0] && row.created_at < value.entries[0].evaluated_at)) fail();
});
export type InvestorHistory = z.infer<typeof investorHistorySchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
