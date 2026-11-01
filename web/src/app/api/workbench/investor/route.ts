import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError } from "@/server/auth/core";
import { requireApiSession, requireMutationSession } from "@/server/auth/session";
import { assertRequestSessionBinding, sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { parseStrictJson } from "@/server/strict-json";
import { executeInvestorCommand, getInvestorState, isInvestorClientError } from "@/server/investor/service";
import { actionDraftProgressRequest } from "@/server/investor/action-draft-progress-schemas";
import { actionMaintenanceProgressRequest } from "@/server/investor/action-maintenance-progress-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
const readHeaders = { ...headers, Vary: "Cookie, " + actionDraftProgressRequest.header };
function failure(error: unknown) {
  let status = 503, code = "INVESTOR_UNAVAILABLE";
  if (error instanceof AuthError) { status = error.status; code = error.code; }
  else if (error instanceof z.ZodError) { status = 400; code = "INVESTOR_INPUT_INVALID"; }
  else if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") { status = 423; code = error.message; }
  else if (error instanceof Error && isInvestorClientError(error.message)) {
    code = error.message; status = code.endsWith("_CONFLICT") || code.endsWith("_CHANGED") || code.endsWith("_EXPIRED") || code.endsWith("_NOT_CURRENT") || code === "INVESTOR_PLAN_SOURCE_UNAVAILABLE" || code === "INVESTOR_MONITOR_FIXED_POLICY_UNSUPPORTED" ? 409 : code.endsWith("_OUT_OF_SCOPE") ? 403 : 400;
  }
  return NextResponse.json({ error: code }, { status, headers });
}
async function readCommand(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new AuthError("JSON_REQUIRED", 415);
  const max = 32 * 1024, declared = request.headers.get("content-length");
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > max)) throw new AuthError("REQUEST_TOO_LARGE", 413);
  const reader = request.body?.getReader(); if (!reader) throw new AuthError("INVALID_JSON", 400);
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength;
      if (length > max) { await reader.cancel(); throw new AuthError("REQUEST_TOO_LARGE", 413); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  try { return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new AuthError("INVALID_JSON", 400); }
}
export async function GET(request: Request) {
  try {
    const initial = await requireApiSession(); assertRequestSessionBinding(request, initial.sessionId);
    if (new URL(request.url).searchParams.size) throw new AuthError("INVALID_QUERY", 400);
    const includeActionMaintenanceProgress = request.headers.get(actionMaintenanceProgressRequest.header) === actionMaintenanceProgressRequest.value;
    const includeActionDraftProgress = includeActionMaintenanceProgress || request.headers.get(actionDraftProgressRequest.header) === actionDraftProgressRequest.value;
    if (includeActionDraftProgress && !request.headers.get("x-workbench-session-binding")) throw new AuthError("SESSION_BINDING_REQUIRED", 400);
    const current = await requireApiSession();
    if (current.sessionId !== initial.sessionId) throw new AuthError("SESSION_CHANGED", 401);
    const db = openWorkbench();
    try { return NextResponse.json({ ...getInvestorState(db, { id: current.userId }, undefined, {
      includeActionDraftProgress, includeActionMaintenanceProgress }),
      session_binding: sessionBinding(current.sessionId) }, { headers: readHeaders }); }
    finally { db.close(); }
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const initial = await requireMutationSession(); assertRequestSessionBinding(request, initial.sessionId);
    const command = await readCommand(request), current = await requireMutationSession();
    if (current.sessionId !== initial.sessionId || current.userId !== initial.userId) throw new AuthError("SESSION_CHANGED", 401);
    assertRequestSessionBinding(request, current.sessionId);
    if (command && typeof command === "object" && "action" in command && ["record_linked_trade_fact", "record_linked_cash_fact", "request_linked_valuation", "link_recorded_execution_fact", "record_linked_execution_report", "review_linked_proposal", "set_monitor_costs"].includes(String(command.action))) {
      if (!request.headers.get("x-workbench-session-binding")) throw new AuthError("SESSION_BINDING_REQUIRED", 400);
      if (new URL(request.url).searchParams.size) throw new AuthError("INVALID_QUERY", 400);
    }
    const db = openWorkbench();
    try { return NextResponse.json({ ...executeInvestorCommand(db, { id: current.userId }, command), session_binding: sessionBinding(current.sessionId) }, { headers }); }
    finally { db.close(); }
  } catch (error) { return failure(error); }
}
