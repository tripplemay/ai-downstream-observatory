import { z } from "zod";
import contextContract from "../../../../contracts/v1/ai-monitor-context.schema.json";
import { investorHash, investorId, investorInstant } from "./schemas";

export const aiLimitations = contextContract.properties.limitations.const;
export const aiTriggerCodes = contextContract.properties.trigger_codes.items.enum as [string, ...string[]];
const names = ["max_abs_target_gap", "target_change_count", "estimated_cost_ratio"];
const decimal = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/).max(20);
export const aiMonitorContextSchema = z.object({
  schema_version: z.literal("ai-monitor-context-v1"), deterministic_outcome: z.enum(["observe", "decision_required"]), evaluated_at: investorInstant,
  evidence: z.array(z.object({ evidence_id: z.string(), metric: z.string(), value: decimal, as_of: investorInstant }).strict()).min(2).max(3),
  trigger_codes: z.array(z.enum(aiTriggerCodes)).min(1).max(16),
  limitations: z.array(z.string()), strategy_gates: z.object({ investment_gate_passed: z.literal(false), live_advice_eligible: z.literal(false) }).strict(),
}).strict().superRefine((value, ctx) => {
  const fail = () => ctx.addIssue({ code: "custom", message: "AI_CONTEXT_INVALID" });
  if (JSON.stringify(value.limitations) !== JSON.stringify(aiLimitations)
    || JSON.stringify(value.trigger_codes) !== JSON.stringify([...new Set(value.trigger_codes)].sort())) fail();
  for (const [index, row] of value.evidence.entries()) {
    const name = names[index], number = Number(row.value);
    if (row.evidence_id !== "derived:" + name || row.metric !== "model." + name || row.as_of !== value.evaluated_at
      || row.value.endsWith("0") && row.value.includes(".")
      || (name === "target_change_count" ? !/^(?:0|[1-9][0-9]?)$/.test(row.value) || number > 20 : number < 0 || number > 1 || /^1\./.test(row.value))) fail();
  }
});
const refs = z.array(investorId).max(3).refine(rows => new Set(rows).size === rows.length);
const texts = z.array(z.string().max(600)).max(3);
export const aiMonitorReviewSchema = z.object({ schema_version: z.literal("ai-research-review-v1"),
  facts: z.array(z.object({ evidence_id: investorId, metric: z.string().min(1), value: decimal, as_of: investorInstant }).strict()).min(2).max(3),
  inferences: z.array(z.object({ text: z.string().max(600), evidence_ids: refs }).strict()).max(3),
  supporting_evidence: refs, counter_evidence: refs, risks: texts,
  recommendation: z.enum(["maintain_research", "review", "research_hypothesis"]), reason: z.string().min(1).max(600),
  unknowns: texts, invalidation_conditions: texts,
}).strict();
export type AiMonitorContext = z.infer<typeof aiMonitorContextSchema>;
export type AiMonitorReview = z.infer<typeof aiMonitorReviewSchema>;
export function validateAiMonitorReview(raw: unknown, context: AiMonitorContext): AiMonitorReview {
  const review = aiMonitorReviewSchema.parse(raw), facts = new Map(context.evidence.map(row => [row.evidence_id, row]));
  if (review.facts.length !== facts.size || new Set(review.facts.map(row => row.evidence_id)).size !== facts.size
    || review.facts.some(row => { const source = facts.get(row.evidence_id); return !source || ["metric", "value", "as_of"].some(key => row[key as keyof typeof row] !== source[key as keyof typeof source]); })
    || [...review.supporting_evidence, ...review.counter_evidence, ...review.inferences.flatMap(row => row.evidence_ids)].some(id => !facts.has(id)))
    throw new Error("AI_GATEWAY_OUTPUT_INVALID");
  return review;
}
export const aiExplanationStatusSchema = z.object({ schema_version: z.literal("investor-ai-explanation-v1"),
  status: z.enum(["available", "blocked", "queued", "running", "complete", "failed"]), reason_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).nullable(),
  observation_id: investorId.nullable(), binding_hash: investorHash.nullable(), valid_until: investorInstant.nullable(),
  review: aiMonitorReviewSchema.nullable(), narrative_verified: z.literal(false), live_advice_eligible: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if ((value.status === "complete") !== (value.review !== null)
    || (value.status === "blocked" || value.status === "failed") !== (value.reason_code !== null)
    || value.status !== "blocked" && (!value.observation_id || !value.binding_hash || !value.valid_until))
    ctx.addIssue({ code: "custom", message: "AI_STATUS_INVALID" });
});
export type AiExplanationStatus = z.infer<typeof aiExplanationStatusSchema>;
