import "server-only";
import { AuthError, tokenHash } from "./core";

/** Correlation only; never accepted as a session credential or storage session hash. */
export function sessionBinding(sid: string): string {
  if (typeof sid !== "string" || !sid) throw new Error("SESSION_BINDING_UNAVAILABLE");
  return tokenHash(`workbench-client-session-v1:${sid}`);
}

/** An optional stale-session guard, never a substitute for authentication or same-origin checks. */
export function assertRequestSessionBinding(request: Pick<Request, "headers">, sid: string): void {
  const supplied = request.headers.get("x-workbench-session-binding");
  if (supplied !== null && supplied !== sessionBinding(sid)) throw new AuthError("SESSION_CHANGED", 401);
}
