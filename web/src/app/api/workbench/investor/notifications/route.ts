import { NextResponse } from "next/server";
import { AuthError } from "@/server/auth/core";
import { requireApiSession, requireMutationSession } from "@/server/auth/session";
import { assertRequestSessionBinding, sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { parseStrictJson } from "@/server/strict-json";
import { readInvestorNotifications, readInvestorNotification } from "@/server/investor/notifications";
import { investorNoticeReadSchema } from "@/server/investor/notification-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
function failure(error: unknown) {
  let code = "INVESTOR_NOTIFICATIONS_UNAVAILABLE", status = 503;
  if (error instanceof AuthError) { code = error.code; status = error.status; }
  else if (error instanceof Error) {
    if (error.message === "WORKBENCH_READ_ONLY") { code = error.message; status = 423; }
    if (error.message === "INVESTOR_NOTIFICATION_NOT_FOUND") { code = error.message; status = 404; }
    if (error.message === "INVESTOR_NOTIFICATION_CHANGED") { code = error.message; status = 409; }
  }
  return NextResponse.json({ error: code }, { status, headers });
}
function bind(request: Request, sid: string) {
  if (!request.headers.get("x-workbench-session-binding")) throw new AuthError("SESSION_BINDING_REQUIRED", 400);
  assertRequestSessionBinding(request, sid);
  if (new URL(request.url).searchParams.size) throw new AuthError("INVALID_QUERY", 400);
}
async function body(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new AuthError("JSON_REQUIRED", 415);
  const declared = request.headers.get("content-length"), maximum = 1024;
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > maximum)) throw new AuthError("REQUEST_TOO_LARGE", 413);
  const reader = request.body?.getReader(); if (!reader) throw new AuthError("INVALID_JSON", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length;
      if (size > maximum) { await reader.cancel(); throw new AuthError("REQUEST_TOO_LARGE", 413); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  try { return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new AuthError("INVALID_JSON", 400); }
}
export async function GET(request: Request) {
  try {
    const first = await requireApiSession(); bind(request, first.sessionId);
    const current = await requireApiSession();
    if (first.sessionId !== current.sessionId || first.userId !== current.userId) throw new AuthError("SESSION_CHANGED", 401);
    const db = openWorkbench();
    try { return NextResponse.json({ ...readInvestorNotifications(db, { id: current.userId }), session_binding: sessionBinding(current.sessionId) }, { headers }); }
    finally { db.close(); }
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const first = await requireMutationSession(); bind(request, first.sessionId);
    const parsed = investorNoticeReadSchema.safeParse(await body(request));
    if (!parsed.success) throw new AuthError("INVESTOR_NOTIFICATION_INPUT_INVALID", 400);
    const input = parsed.data, current = await requireMutationSession();
    if (first.sessionId !== current.sessionId || first.userId !== current.userId) throw new AuthError("SESSION_CHANGED", 401);
    bind(request, current.sessionId); const db = openWorkbench();
    try { return NextResponse.json({ ...readInvestorNotification(db, { id: current.userId }, input), session_binding: sessionBinding(current.sessionId) }, { headers }); }
    finally { db.close(); }
  } catch (error) { return failure(error); }
}
