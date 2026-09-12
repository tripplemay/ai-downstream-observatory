"use server";

import { requireMutationSession } from "@/server/auth/session";
import type { ObservationInput, PoolItemInput, SignalUpdateInput, StrategyParamsInput, ThesisInput } from "./schemas";

export type ActionResult = { ok: boolean; message: string };
const archived = (): ActionResult => ({ ok: false, message: "历史研究档案为只读。新账户、策略和交易事实请使用 ETF 投资工作台。" });

export async function updateSignal(_input: SignalUpdateInput): Promise<ActionResult> {
  await requireMutationSession();
  return archived();
}
export async function addObservation(_input: ObservationInput): Promise<ActionResult> {
  await requireMutationSession();
  return archived();
}
export async function saveThesis(_input: ThesisInput): Promise<ActionResult> {
  await requireMutationSession();
  return archived();
}
export async function addPoolItem(_input: PoolItemInput): Promise<ActionResult> {
  await requireMutationSession();
  return archived();
}
export async function updatePoolItem(_input: PoolItemInput): Promise<ActionResult> {
  await requireMutationSession();
  return archived();
}
export async function deletePoolItem(_themeId: string, _id: number): Promise<ActionResult> {
  await requireMutationSession();
  return archived();
}
export async function saveStrategyParams(_input: StrategyParamsInput): Promise<ActionResult> {
  await requireMutationSession();
  return archived();
}
