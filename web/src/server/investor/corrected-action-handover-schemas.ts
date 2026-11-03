import { z } from "zod";

const id = z.string().min(1).max(300), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const correctedHandoverInputSchema = z.object({ kind: z.literal("confirmation"), body: z.object({
  schema_version: z.literal("investor-corrected-action-handover-submit-v1"), preview_id: id, correction_id: id,
  expected_correction_hash: hash, expected_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), idempotency_key: id,
  enable_rule: z.boolean(), acknowledgements: z.object({ confirmed_historical_baseline: z.literal(true), current_report_differences_seen: z.literal(true),
    unchanged_tax_and_event_assumptions: z.literal(true), reported_coverage_not_objective_absence: z.literal(true),
    separate_new_maintenance_choice: z.literal(true), new_epoch_still_required_no_trading: z.literal(true) }).strict()
}).strict() }).strict();
