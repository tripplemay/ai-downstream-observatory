import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError } from "@/server/auth/core";
import { requireApiSession, requireMutationSession } from "@/server/auth/session";
import { assertRequestSessionBinding, sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { parseStrictJson } from "@/server/strict-json";
import { isListingReviewClientError, publishListingReview, readListingReviewVersion } from "@/server/listing-reviews/service";
import { getListingReviewState } from "@/server/listing-reviews/queries";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
const envelope = z.object({ action: z.literal("publish"), command: z.unknown() }).strict();
function failure(error: unknown) {
  let status = 503, code = "WORKBENCH_UNAVAILABLE";
  if (error instanceof AuthError) { status = error.status; code = error.code; }
  else if (error instanceof z.ZodError) { status = 400; code = "VALIDATION_FAILED"; }
  else if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") { status = 423; code = error.message; }
  else if (error instanceof Error && isListingReviewClientError(error.message)) { code = error.message; status = code.endsWith("_CONFLICT") || code.endsWith("_CURSOR_STALE") ? 409 : code.endsWith("_OUT_OF_SCOPE") || code.endsWith("_PERMISSION_DENIED") ? 403 : code.endsWith("_NOT_FOUND") ? 404 : 400; }
  return NextResponse.json({ error: code }, { status, headers: { ...headers, ...(status === 413 ? { Connection: "close" } : {}) } });
}
async function body(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new AuthError("JSON_REQUIRED", 415);
  const max = 65536, declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > max)) throw new AuthError("REQUEST_TOO_LARGE", 413);
  const reader = request.body?.getReader(); if (!reader) throw new AuthError("INVALID_JSON", 400);
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > max) { void reader.cancel().catch(() => {}); throw new AuthError("REQUEST_TOO_LARGE", 413); } chunks.push(value); } } finally { reader.releaseLock(); }
  let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new AuthError("INVALID_UTF8", 400); }
  let raw: unknown; try { raw = parseStrictJson(text); } catch { throw new AuthError("INVALID_JSON", 400); }
  return envelope.parse(raw);
}
export async function GET(request: Request) {
  try {
    const session = await requireApiSession(); assertRequestSessionBinding(request, session.sessionId);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => params.getAll(key).length !== 1)) throw new AuthError("INVALID_QUERY", 400);
    const query = z.object({ portfolio: z.string().min(1).max(160).optional(), listing: z.string().min(1).max(160).optional(), cursor: z.string().min(1).max(1024).optional(), limit: z.string().regex(/^[1-9][0-9]?$/).transform(Number).refine(value => value <= 50).optional() }).strict().parse(Object.fromEntries(params));
    const db = openWorkbench();
    try {
      const result = getListingReviewState(db, { portfolio_id: query.portfolio, listing_id: query.listing, cursor: query.cursor, limit: query.limit });
      const current = await requireApiSession();
      if (current.sessionId !== session.sessionId || current.userId !== session.userId) throw new AuthError("SESSION_CHANGED", 401);
      assertRequestSessionBinding(request, current.sessionId);
      return NextResponse.json({ ...result, session_binding: sessionBinding(current.sessionId) }, { headers });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const initial = await requireMutationSession(); assertRequestSessionBinding(request, initial.sessionId);
    const input = await body(request), current = await requireMutationSession();
    if (current.sessionId !== initial.sessionId || current.userId !== initial.userId) throw new AuthError("SESSION_CHANGED", 401);
    assertRequestSessionBinding(request, current.sessionId);
    const db = openWorkbench();
    try {
      const result = publishListingReview(db, { id: current.userId, kind: "human" }, input.command);
      return NextResponse.json({ ...result, document: readListingReviewVersion(db, result.portfolio_id, result.listing_id, result.id).document, session_binding: sessionBinding(current.sessionId) }, { headers });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}
