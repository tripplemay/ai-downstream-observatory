import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError } from "@/server/auth/core";
import { requireApiSession, requireMutationSession } from "@/server/auth/session";
import { assertRequestSessionBinding, sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { parseStrictJson } from "@/server/strict-json";
import { verificationCommandSchema, verificationQuerySchema } from "@/server/verifications/schemas";
import { getVerificationState, isVerificationClientError, readVerificationArtifact, requestVerification } from "@/server/verifications/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
const envelope = z.object({ command: verificationCommandSchema }).strict();
const queryStrings = z.object({ portfolio: z.string().optional(), request: z.string().optional(), cursor: z.string().optional(),
  limit: z.string().regex(/^[1-9][0-9]?$/).transform(Number).refine(value => value <= 50).optional() }).strict();
const artifactQuery = z.object({ portfolio: z.string().min(1).max(200), artifact: z.string().min(1).max(200) }).strict();
function requireBoundSession(request: Request, sessionId: string) {
  if (!request.headers.get("X-Workbench-Session-Binding")) throw new AuthError("SESSION_CHANGED", 401);
  assertRequestSessionBinding(request, sessionId);
}

function failure(error: unknown) {
  let status = 503, code = "WORKBENCH_UNAVAILABLE";
  if (error instanceof AuthError) { status = error.status; code = error.code; }
  else if (error instanceof z.ZodError) { status = 400; code = "VALIDATION_FAILED"; }
  else if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") { status = 423; code = error.message; }
  else if (error instanceof Error && isVerificationClientError(error.message) && !["VERIFICATION_EVIDENCE_INVALID", "VERIFICATION_RESPONSE_TOO_LARGE"].includes(error.message)) {
    code = error.message;
    status = code.endsWith("_CONFLICT") || code === "VERIFICATION_CONTEXT_CHANGED" ? 409
      : code.endsWith("_PERMISSION_DENIED") ? 403 : code.endsWith("_NOT_FOUND") ? 404 : code === "VERIFICATION_SOURCE_UNAVAILABLE" ? 503 : 400;
  }
  return NextResponse.json({ error: code }, { status, headers: { ...headers, ...(status === 413 ? { Connection: "close" } : {}) } });
}
async function body(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new AuthError("JSON_REQUIRED", 415);
  const max = 1048576, declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > max)) throw new AuthError("REQUEST_TOO_LARGE", 413);
  const reader = request.body?.getReader(); if (!reader) throw new AuthError("INVALID_JSON", 400);
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength;
      if (length > max) { void reader.cancel().catch(() => {}); throw new AuthError("REQUEST_TOO_LARGE", 413); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  let raw: unknown;
  try { raw = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new AuthError("INVALID_JSON", 400); }
  return envelope.parse(raw);
}
export async function GET(request: Request) {
  try {
    const initial = await requireApiSession(); assertRequestSessionBinding(request, initial.sessionId);
    const parameters = new URL(request.url).searchParams;
    if (parameters.has("artifact")) requireBoundSession(request, initial.sessionId);
    if ([...parameters.keys()].some(key => parameters.getAll(key).length !== 1)) throw new AuthError("INVALID_QUERY", 400);
    const raw = Object.fromEntries(parameters);
    const artifact = parameters.has("artifact") ? artifactQuery.parse(raw) : null;
    const query = artifact ? null : verificationQuerySchema.parse(queryStrings.parse(raw));
    const db = openWorkbench();
    try {
      const result = artifact ? readVerificationArtifact(db, artifact.portfolio, artifact.artifact) : getVerificationState(db, query!);
      const current = await requireApiSession();
      if (current.sessionId !== initial.sessionId || current.userId !== initial.userId) throw new AuthError("SESSION_CHANGED", 401);
      assertRequestSessionBinding(request, current.sessionId);
      if (artifact) {
        const file = result as ReturnType<typeof readVerificationArtifact>;
        return new NextResponse(new Uint8Array(file.body), { headers: { ...headers, "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="verification-artifact.json"', "X-Artifact-SHA256": file.sha256,
          "X-Workbench-Session-Binding": sessionBinding(current.sessionId) } });
      }
      return NextResponse.json({ ...result, session_binding: sessionBinding(current.sessionId) }, { headers });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const initial = await requireMutationSession(); requireBoundSession(request, initial.sessionId);
    if (new URL(request.url).searchParams.size !== 0) throw new AuthError("INVALID_QUERY", 400);
    const input = await body(request), current = await requireMutationSession();
    if (current.sessionId !== initial.sessionId || current.userId !== initial.userId) throw new AuthError("SESSION_CHANGED", 401);
    assertRequestSessionBinding(request, current.sessionId);
    const db = openWorkbench();
    try {
      const result = requestVerification(db, { id: current.userId, kind: "human" }, input.command);
      const final = await requireMutationSession();
      if (final.sessionId !== current.sessionId || final.userId !== current.userId) throw new AuthError("SESSION_CHANGED", 401);
      assertRequestSessionBinding(request, final.sessionId);
      return NextResponse.json({ ...result, session_binding: sessionBinding(final.sessionId) }, { headers });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}
