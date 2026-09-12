import { NextResponse } from "next/server";
import { AuthError, getAuthConfig, requireSameOrigin } from "@/server/auth/core";
import { openSession } from "@/server/auth/session";
import { withAuthStore } from "@/server/auth/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const config = getAuthConfig();
    requireSameOrigin(request.headers, config);
    const session = await openSession(config);
    if (session.sid) withAuthStore(config, (store) => store.revoke(session.sid!));
    session.destroy();
    return NextResponse.redirect(new URL("/login", config.origin), 303);
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.code }, { status: error.status });
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
}
