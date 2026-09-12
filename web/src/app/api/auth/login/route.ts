import { NextResponse } from "next/server";
import { AuthError, getAuthConfig, readLoginForm, requireSameOrigin, verifyPassword } from "@/server/auth/core";
import { openSession } from "@/server/auth/session";
import { withAuthStore } from "@/server/auth/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const config = getAuthConfig();
    requireSameOrigin(request.headers, config);
    const limit = withAuthStore(config, (store) => store.consumeLoginAttempt());
    if (!limit.allowed) return NextResponse.json({ error: "TOO_MANY_ATTEMPTS" }, {
      status: 429, headers: { "Retry-After": String(limit.retryAfter), "Cache-Control": "no-store" },
    });
    const form = await readLoginForm(request);
    if (form.getAll("password").length !== 1 || !(await verifyPassword(form.get("password") ?? "", config.passwordHash))) {
      return NextResponse.redirect(new URL("/login?error=invalid", config.origin), 303);
    }
    const session = await openSession(config);
    if (session.sid) withAuthStore(config, (store) => store.revoke(session.sid!));
    Object.assign(session, withAuthStore(config, (store) => store.issue(config)));
    await session.save();
    return NextResponse.redirect(new URL("/", config.origin), 303);
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.code }, { status: error.status });
    console.error("Authentication storage unavailable");
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
}
