import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getIronSession, type SessionOptions } from "iron-session";
import { AuthError, getAuthConfig, requireSameOrigin, SESSION_TTL_SECONDS, type AuthConfig } from "./core";
import { withAuthStore } from "./store";

export type SessionData = { sid?: string; expiresAt?: number };
export type Principal = { userId: "owner"; sessionId: string };

export function sessionOptions(config: AuthConfig): SessionOptions {
  return {
    password: config.secret,
    cookieName: config.secure ? "__Host-workbench-session" : "workbench-session",
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: { secure: config.secure, httpOnly: true, sameSite: "strict", path: "/", maxAge: SESSION_TTL_SECONDS },
  };
}

export async function openSession(config: AuthConfig) {
  return getIronSession<SessionData>(await cookies(), sessionOptions(config));
}

export async function getCurrentSession(): Promise<Principal | null> {
  // Read request context even when unconfigured: this must never be prerendered.
  await cookies();
  let config: AuthConfig;
  try { config = getAuthConfig(); } catch (error) {
    if (error instanceof AuthError) return null;
    throw error;
  }
  const session = await openSession(config);
  if (!session.sid || !session.expiresAt || session.expiresAt <= Date.now()) return null;
  return withAuthStore(config, (store) => store.valid(session.sid, config))
    ? { userId: "owner", sessionId: session.sid } : null;
}

export async function requireSession(): Promise<Principal> {
  const principal = await getCurrentSession();
  if (!principal) redirect("/login");
  return principal;
}

export async function requireApiSession(): Promise<Principal> {
  const principal = await getCurrentSession();
  if (!principal) throw new AuthError("UNAUTHENTICATED", 401);
  return principal;
}

export async function requireMutationSession(): Promise<Principal> {
  const principal = await requireApiSession();
  requireSameOrigin(await headers(), getAuthConfig());
  return principal;
}
