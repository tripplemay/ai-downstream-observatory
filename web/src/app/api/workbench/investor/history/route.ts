import { NextResponse } from "next/server";
import { AuthError } from "@/server/auth/core";
import { requireApiSession } from "@/server/auth/session";
import { assertRequestSessionBinding, sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { historyQuerySchema } from "@/server/investor/history-schemas";
import { readInvestorHistory } from "@/server/investor/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
export async function GET(request: Request) {
  try {
    const first = await requireApiSession();
    if (!request.headers.get("x-workbench-session-binding")) throw new AuthError("SESSION_BINDING_REQUIRED", 400);
    assertRequestSessionBinding(request, first.sessionId);
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(name => !["observation", "cursor"].includes(name) || query.getAll(name).length !== 1)) throw new AuthError("INVALID_QUERY", 400);
    const parsed = historyQuerySchema.safeParse(Object.fromEntries(query));
    if (!parsed.success) throw new AuthError("INVALID_QUERY", 400);
    const current = await requireApiSession();
    if (current.sessionId !== first.sessionId || current.userId !== first.userId) throw new AuthError("SESSION_CHANGED", 401);
    const db = openWorkbench();
    try { return NextResponse.json({ ...readInvestorHistory(db, { id: current.userId }, parsed.data), session_binding: sessionBinding(current.sessionId) }, { headers }); }
    finally { db.close(); }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = error instanceof AuthError ? error.code : ["INVESTOR_HISTORY_CURSOR_INVALID", "INVESTOR_HISTORY_NOT_FOUND"].includes(message) ? message : "INVESTOR_HISTORY_UNAVAILABLE";
    const status = error instanceof AuthError ? error.status : code === "INVESTOR_HISTORY_CURSOR_INVALID" ? 400 : code === "INVESTOR_HISTORY_NOT_FOUND" ? 404 : 503;
    return NextResponse.json({ error: code }, { status, headers });
  }
}
