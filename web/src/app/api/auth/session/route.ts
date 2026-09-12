import { NextResponse } from "next/server";
import { AuthError, getAuthConfig } from "@/server/auth/core";
import { requireApiSession } from "@/server/auth/session";
import { sessionBinding } from "@/server/auth/session-binding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function GET() {
  try {
    // getCurrentSession treats invalid configuration as anonymous; a probe must distinguish an outage.
    getAuthConfig();
    const principal = await requireApiSession();
    return NextResponse.json({ authenticated: true, session_binding: sessionBinding(principal.sessionId) }, { headers });
  } catch (error) {
    const unauthenticated = error instanceof AuthError && error.status === 401;
    return NextResponse.json({ error: unauthenticated ? "UNAUTHENTICATED" : "AUTH_UNAVAILABLE" }, { status: unauthenticated ? 401 : 503, headers });
  }
}
