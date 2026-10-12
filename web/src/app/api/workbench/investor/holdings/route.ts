import { NextResponse } from "next/server";
import { AuthError } from "@/server/auth/core";
import { requireApiSession } from "@/server/auth/session";
import { assertRequestSessionBinding, sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { getInvestorHoldings } from "@/server/investor/holdings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
export async function GET(request: Request) {
  try {
    const initial = await requireApiSession(); assertRequestSessionBinding(request, initial.sessionId);
    if (new URL(request.url).searchParams.size) throw new AuthError("INVALID_QUERY", 400);
    const db = openWorkbench();
    let state;
    try { state = getInvestorHoldings(db, { id: initial.userId }); } finally { db.close(); }
    const current = await requireApiSession();
    if (current.sessionId !== initial.sessionId || current.userId !== initial.userId) throw new AuthError("SESSION_CHANGED", 401);
    return NextResponse.json({ ...state, session_binding: sessionBinding(current.sessionId) }, { headers });
  } catch (error) {
    return error instanceof AuthError ? NextResponse.json({ error: error.code }, { status: error.status, headers })
      : NextResponse.json({ error: "INVESTOR_HOLDINGS_UNAVAILABLE" }, { status: 503, headers });
  }
}
