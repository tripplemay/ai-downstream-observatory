import { NextResponse } from "next/server";
import { AuthError } from "@/server/auth/core";
import { requireApiSession } from "@/server/auth/session";
import { assertRequestSessionBinding, sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { getFundedComparison } from "@/server/investor/funded-comparison";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
export async function GET(request: Request) {
  try {
    const initial = await requireApiSession(); assertRequestSessionBinding(request, initial.sessionId);
    if (new URL(request.url).searchParams.size) throw new AuthError("INVALID_QUERY", 400);
    const db = openWorkbench();
    try {
      const result = await getFundedComparison(db, { id: initial.userId }, { signal: request.signal });
      const current = await requireApiSession();
      if (current.sessionId !== initial.sessionId || current.userId !== initial.userId) throw new AuthError("SESSION_CHANGED", 401);
      if (result.candidates.length && (!result.valid_until || Date.parse(result.valid_until) <= Date.now())) throw new Error("FUNDED_COMPARISON_SOURCE_EXPIRED");
      return NextResponse.json({ ...result, session_binding: sessionBinding(current.sessionId) }, { headers });
    } finally { db.close(); }
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.code }, { status: error.status, headers });
    const busy = error instanceof Error && error.message === "FUNDED_COMPARISON_BUSY";
    return NextResponse.json({ error: busy ? "FUNDED_COMPARISON_BUSY" : "FUNDED_COMPARISON_UNAVAILABLE" }, { status: busy ? 429 : 503, headers });
  }
}
