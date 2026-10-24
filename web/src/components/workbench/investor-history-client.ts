import { z } from "zod";
import { investorHistorySchema, type HistoryQuery } from "@/server/investor/history-schemas";

export function parseInvestorHistory(value: unknown, binding: string, workspace: string | null, query: HistoryQuery) {
  const parsed = investorHistorySchema.safeExtend({ session_binding: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(value);
  const { session_binding, ...body } = parsed, history = investorHistorySchema.parse(body);
  if (session_binding !== binding || history.workspace_id !== workspace || history.observation_id !== (query.observation ?? null)
    || history.mode !== (query.observation ? "decisions" : "observations")) throw new Error("INVESTOR_HISTORY_RESPONSE_INVALID");
  return history;
}
export function historyUrl(query: HistoryQuery) {
  const parameters = new URLSearchParams();
  if (query.observation) parameters.set("observation", query.observation);
  if (query.cursor) parameters.set("cursor", query.cursor);
  return "/api/workbench/investor/history" + (parameters.size ? "?" + parameters : "");
}
