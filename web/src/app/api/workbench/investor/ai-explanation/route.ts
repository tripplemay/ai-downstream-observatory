import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError } from "@/server/auth/core";
import { requireApiSession, requireMutationSession } from "@/server/auth/session";
import { assertRequestSessionBinding, sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { parseStrictJson } from "@/server/strict-json";
import { investorId, investorHash } from "@/server/investor/schemas";
import { readInvestorAiExplanation, enqueueInvestorAiExplanation } from "@/server/investor/ai-explanation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
function failure(error: unknown) {
  if (error instanceof AuthError) return NextResponse.json({ error: error.code }, { status: error.status, headers });
  if (error instanceof z.ZodError) return NextResponse.json({ error: "INVESTOR_AI_INPUT_INVALID" }, { status: 400, headers });
  const allowed = new Set(["INVESTOR_AI_BINDING_CHANGED", "INVESTOR_AI_BUSY", "WORKBENCH_READ_ONLY"]);
  const code = error instanceof Error && allowed.has(error.message) ? error.message : "INVESTOR_AI_UNAVAILABLE";
  return NextResponse.json({ error: code }, { status: code === "WORKBENCH_READ_ONLY" ? 423 : code === "INVESTOR_AI_BINDING_CHANGED" ? 409 : 503, headers });
}
function bind(request: Request, sid: string) {
  if (!request.headers.get("x-workbench-session-binding")) throw new AuthError("SESSION_BINDING_REQUIRED", 400);
  assertRequestSessionBinding(request, sid);
  if (new URL(request.url).searchParams.size) throw new AuthError("INVALID_QUERY", 400);
}
function readStatus(db: ReturnType<typeof openWorkbench>, actor: { id: string }) {
  const status = readInvestorAiExplanation(db, actor);
  return status.status === "available" && process.env.WORKBENCH_AI_BACKGROUND_ENABLED !== "1"
    ? { ...status, status: "blocked" as const, reason_code: "INVESTOR_AI_RUNTIME_UNAVAILABLE", observation_id: null, binding_hash: null, valid_until: null }
    : status;
}
async function readRequest(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new AuthError("JSON_REQUIRED", 415);
  const max = 1024, declared = request.headers.get("content-length");
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > max)) throw new AuthError("REQUEST_TOO_LARGE", 413);
  const reader = request.body?.getReader(); if (!reader) throw new AuthError("INVALID_JSON", 400);
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength;
      if (length > max) { await reader.cancel(); throw new AuthError("REQUEST_TOO_LARGE", 413); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new AuthError("INVALID_JSON", 400); }
  return z.object({ observation_id: investorId, binding_hash: investorHash }).strict().parse(value);
}
export async function GET(request: Request) {
  try {
    const initial = await requireApiSession(); bind(request, initial.sessionId);
    const current = await requireApiSession();
    if (current.sessionId !== initial.sessionId || current.userId !== initial.userId) throw new AuthError("SESSION_CHANGED", 401);
    const db = openWorkbench();
    try { return NextResponse.json({ ...readStatus(db, { id: current.userId }), session_binding: sessionBinding(current.sessionId) }, { headers }); }
    finally { db.close(); }
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const initial = await requireMutationSession(); bind(request, initial.sessionId);
    const body = await readRequest(request);
    const guard = async () => {
      const current = await requireMutationSession();
      if (current.sessionId !== initial.sessionId || current.userId !== initial.userId) throw new AuthError("SESSION_CHANGED", 401);
      bind(request, current.sessionId);
    };
    await guard(); const db = openWorkbench();
    try {
      if (process.env.WORKBENCH_AI_BACKGROUND_ENABLED !== "1") throw new Error("INVESTOR_AI_RUNTIME_UNAVAILABLE");
      await enqueueInvestorAiExplanation(db, { id: initial.userId }, body, { signal: request.signal, assert_session: guard });
      await guard();
      const status = readStatus(db, { id: initial.userId });
      return NextResponse.json({ ...status, session_binding: sessionBinding(initial.sessionId) }, { status: status.status === "queued" || status.status === "running" ? 202 : 200, headers });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}
