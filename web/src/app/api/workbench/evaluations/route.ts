import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError } from "@/server/auth/core";
import { requireApiSession, requireMutationSession } from "@/server/auth/session";
import { assertRequestSessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { parseStrictJson } from "@/server/strict-json";
import { getEvaluationState, isEvaluationClientError, retryEvaluation, saveSchedule, setScheduleStatus } from "@/server/evaluation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
const querySchema = z.object({ portfolio: z.string().min(1).max(200).optional(), cycle: z.string().min(1).max(200).optional(), cursor: z.string().min(1).max(1024).optional(), attempt_cursor: z.string().min(1).max(1024).optional(), limit: z.string().regex(/^[1-9]\d?$/).transform(Number).refine(value => value <= 50).optional() }).strict();
const commandSchema = z.object({ action: z.enum(["save_schedule", "set_schedule_status", "retry_evaluation"]), command: z.unknown() }).strict();
function failure(error: unknown): NextResponse {
  if (error instanceof AuthError) return NextResponse.json({ error: error.code }, { status: error.status, headers: { ...headers, ...(error.status === 413 ? { Connection: "close" } : {}) } });
  const code = error instanceof Error ? error.message : "";
  if (code === "WORKBENCH_READ_ONLY") return NextResponse.json({ error: code }, { status: 423, headers });
  if (isEvaluationClientError(code)) return NextResponse.json({ error: code }, { status: code.endsWith("_CONFLICT") ? 409 : code.endsWith("_PERMISSION_DENIED") || code.endsWith("_OUT_OF_SCOPE") ? 403 : code.endsWith("_NOT_FOUND") ? 404 : code.endsWith("_TOO_LARGE") ? 413 : 400, headers });
  console.error("Evaluation request failed", error instanceof Error ? error.name : "UnknownError");
  return NextResponse.json({ error: "WORKBENCH_UNAVAILABLE" }, { status: 503, headers });
}
export async function GET(request: Request) {
  try {
    const session = await requireApiSession(), parameters = new URL(request.url).searchParams;
    if ([...parameters.keys()].some(key => parameters.getAll(key).length !== 1)) throw new AuthError("EVALUATION_QUERY_INVALID", 400);
    const parsed = querySchema.safeParse(Object.fromEntries(parameters));
    if (!parsed.success) throw new AuthError("EVALUATION_QUERY_INVALID", 400);
    const { portfolio, cycle, ...rest } = parsed.data, db = openWorkbench();
    try {
      const result = getEvaluationState(db, { id: session.userId, kind: "human" }, { portfolio_id: portfolio, cycle_id: cycle, ...rest });
      const current = await requireApiSession();
      if (current.userId !== session.userId || current.sessionId !== session.sessionId) throw new AuthError("SESSION_CHANGED", 401);
      return NextResponse.json(result, { headers });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}
async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new AuthError("JSON_REQUIRED", 415);
  const max = 1024 * 1024, declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) throw new AuthError("REQUEST_TOO_LARGE", 413);
  const reader = request.body?.getReader(); if (!reader) throw new AuthError("INVALID_JSON", 400);
  let size = 0; const chunks: Uint8Array[] = [];
  for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > max) { await reader.cancel(); throw new AuthError("REQUEST_TOO_LARGE", 413); } chunks.push(item.value); }
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new AuthError("INVALID_UTF8", 400); }
  try { return parseStrictJson(raw); } catch { throw new AuthError("INVALID_JSON", 400); }
}
export async function POST(request: Request) {
  try {
    const session = await requireMutationSession(); assertRequestSessionBinding(request, session.sessionId);
    const parsed = commandSchema.safeParse(await readBody(request)); if (!parsed.success) throw new AuthError("EVALUATION_COMMAND_INVALID", 400);
    const current = await requireMutationSession();
    if (current.userId !== session.userId || current.sessionId !== session.sessionId) throw new AuthError("SESSION_CHANGED", 401);
    const db = openWorkbench();
    try {
      const handlers = { save_schedule: saveSchedule, set_schedule_status: setScheduleStatus, retry_evaluation: retryEvaluation };
      return NextResponse.json(handlers[parsed.data.action](db, { id: session.userId, kind: "human" }, parsed.data.command), { headers });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}
