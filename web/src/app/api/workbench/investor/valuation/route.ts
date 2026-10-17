import { NextResponse } from "next/server";
import { AuthError } from "@/server/auth/core";
import { requireApiSession } from "@/server/auth/session";
import { assertRequestSessionBinding, sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { getInvestorValuationContext } from "@/server/investor/valuation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
export async function GET(request: Request) {
  try {
    const first = await requireApiSession();
    if (!request.headers.get("x-workbench-session-binding")) throw new AuthError("SESSION_BINDING_REQUIRED", 400);
    assertRequestSessionBinding(request, first.sessionId);
    if (new URL(request.url).searchParams.size) throw new AuthError("INVALID_QUERY", 400);
    const current = await requireApiSession();
    if (current.sessionId !== first.sessionId || current.userId !== first.userId) throw new AuthError("SESSION_CHANGED", 401);
    const db = openWorkbench();
    try { return NextResponse.json({ ...getInvestorValuationContext(db, { id: current.userId }), session_binding: sessionBinding(current.sessionId) }, { headers }); }
    finally { db.close(); }
  } catch (error) {
    const code = error instanceof AuthError ? error.code : error instanceof Error && ["INVESTOR_ACCOUNT_OUT_OF_SCOPE", "INVESTOR_VALUATION_CAPACITY_REQUIRES_REVIEW"].includes(error.message) ? error.message : "INVESTOR_VALUATION_UNAVAILABLE";
    const status = error instanceof AuthError ? error.status : code === "INVESTOR_ACCOUNT_OUT_OF_SCOPE" ? 403 : code === "INVESTOR_VALUATION_CAPACITY_REQUIRES_REVIEW" ? 400 : 503;
    return NextResponse.json({ error: code }, { status, headers });
  }
}
