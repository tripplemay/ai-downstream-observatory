import { aiExplanationStatusSchema, type AiExplanationStatus } from "@/server/investor/ai-explanation-schemas";
import { investorHash } from "@/server/investor/schemas";

export function parseInvestorAiExplanation(raw: unknown, binding: string, observationId: string | null, now = Date.now()): AiExplanationStatus {
  const result = aiExplanationStatusSchema.safeExtend({ session_binding: investorHash }).strict().safeParse(raw);
  if (!result.success || result.data.session_binding !== binding) throw new Error("INVESTOR_AI_RESPONSE_INVALID");
  const { session_binding: _, ...value } = result.data;
  aiExplanationStatusSchema.parse(value);
  if (value.status !== "blocked" && (value.observation_id !== observationId || Date.parse(value.valid_until!) <= now)) throw new Error("INVESTOR_AI_RESPONSE_NOT_CURRENT");
  // Without the private context, this checks structure only; the server checks exact evidence.
  return value;
}
