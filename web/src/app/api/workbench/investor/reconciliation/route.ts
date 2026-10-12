import { NextResponse } from "next/server";
import { AuthError } from "@/server/auth/core";
import { requireApiSession } from "@/server/auth/session";
import { assertRequestSessionBinding, sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { getInvestorReconciliationContext } from "@/server/investor/reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
export async function GET(request: Request) {
  try {
    const initial = await requireApiSession(); assertRequestSessionBinding(request, initial.sessionId);
    const query = new URL(request.url).searchParams, account = query.get("account");
    if (query.size !== 1 || !account || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(account)) throw new AuthError("INVALID_QUERY", 400);
    const current = await requireApiSession();
    if (current.sessionId !== initial.sessionId || current.userId !== initial.userId) throw new AuthError("SESSION_CHANGED", 401);
    const db = openWorkbench();
    try {
      const context = getInvestorReconciliationContext(db, { id: current.userId }, account);
      const final = await requireApiSession();
      if (final.sessionId !== current.sessionId || final.userId !== current.userId) throw new AuthError("SESSION_CHANGED", 401);
      return NextResponse.json({ ...context, session_binding: sessionBinding(final.sessionId) }, { headers });
    } finally { db.close(); }
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.code }, { status: error.status, headers });
    const code = error instanceof Error ? error.message : "";
    if (code === "INVESTOR_ACCOUNT_OUT_OF_SCOPE") return NextResponse.json({ error: code }, { status: 403, headers });
    if (code === "INVESTOR_RECONCILIATION_CAPACITY_REQUIRES_REVIEW") return NextResponse.json({ error: code }, { status: 409, headers });
    return NextResponse.json({ error: "INVESTOR_RECONCILIATION_UNAVAILABLE" }, { status: 503, headers });
  }
}
