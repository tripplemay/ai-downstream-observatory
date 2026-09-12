import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError } from "@/server/auth/core";
import { requireApiSession, requireMutationSession } from "@/server/auth/session";
import { assertRequestSessionBinding, sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { parseStrictJson } from "@/server/strict-json";
import { isReferenceClientError, storeMarketReferenceSource, publishMarketReference, readMarketReferenceSource, readMarketReferenceVersion } from "@/server/market-references/service";
import { getMarketReferenceState } from "@/server/market-references/queries";
import { saveCollectionSchedule, setCollectionScheduleStatus, isCollectionClientError } from "@/server/market-schedules/service";
import { getCollectionScheduleState, getCollectionSlot } from "@/server/market-schedules/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
const envelope = z.object({ action: z.enum(["store_source", "publish_reference", "save_collection_schedule", "set_collection_schedule_status"]), command: z.unknown() }).strict();
function failure(error: unknown) {
  let status = 503, code = "WORKBENCH_UNAVAILABLE";
  if (error instanceof AuthError) { status = error.status; code = error.code; }
  else if (error instanceof z.ZodError) { status = 400; code = "VALIDATION_FAILED"; }
  else if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") { status = 423; code = error.message; }
  else if (error instanceof Error && (isReferenceClientError(error.message) || isCollectionClientError(error.message))) {
    code = error.message; status = code.endsWith("_CONFLICT") ? 409 : code.endsWith("_OUT_OF_SCOPE") || code.endsWith("_PERMISSION_DENIED") ? 403 : code.endsWith("_NOT_FOUND") ? 404 : code.endsWith("_TOO_LARGE") ? 413 : 400;
  }
  return NextResponse.json({ error: code }, { status, headers });
}
async function body(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new AuthError("JSON_REQUIRED", 415);
  const max = 2 * 1024 * 1024, declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > max)) throw new AuthError("REQUEST_TOO_LARGE", 413);
  const reader = request.body?.getReader(); if (!reader) throw new AuthError("INVALID_JSON", 400);
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > max) { await reader.cancel(); throw new AuthError("REQUEST_TOO_LARGE", 413); } chunks.push(value); } } finally { reader.releaseLock(); }
  let raw: string; try { raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new AuthError("INVALID_UTF8", 400); }
  let parsed: unknown; try { parsed = parseStrictJson(raw); } catch { throw new AuthError("INVALID_JSON", 400); }
  return envelope.parse(parsed);
}
export async function GET(request: Request) {
  try {
    const session = await requireApiSession(); assertRequestSessionBinding(request, session.sessionId);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => params.getAll(key).length !== 1)) throw new AuthError("INVALID_QUERY", 400);
    const query = z.object({ portfolio: z.string().min(1).max(160).optional(), view: z.enum(["source", "version", "collection_schedules", "collection_slot"]).optional(), id: z.string().min(1).max(160).optional(), schedule: z.string().min(1).max(160).optional(), cursor: z.string().min(1).max(1024).optional(), limit: z.string().regex(/^[1-9][0-9]?$/).transform(Number).refine(value => value <= 50).optional() }).strict().parse(Object.fromEntries(params));
    if (query.view === "collection_schedules" ? query.id !== undefined : query.schedule !== undefined || query.cursor !== undefined || query.limit !== undefined || (query.view ? !query.portfolio || !query.id : query.id !== undefined)) throw new AuthError("INVALID_QUERY", 400);
    const db = openWorkbench();
    try {
      if (query.view === "source") {
        const source = readMarketReferenceSource(db, query.portfolio!, query.id!);
        return new NextResponse(source.content_text, { headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="market-reference-source.json"', "Content-Security-Policy": "sandbox; default-src 'none'" } });
      }
      const result = query.view === "collection_schedules" ? getCollectionScheduleState(db, { portfolio_id: query.portfolio, schedule_id: query.schedule, cursor: query.cursor, limit: query.limit })
        : query.view === "collection_slot" ? getCollectionSlot(db, { portfolio_id: query.portfolio, slot_id: query.id })
        : query.view === "version" ? { version: readMarketReferenceVersion(db, query.portfolio!, query.id!).document } : getMarketReferenceState(db, { portfolio_id: query.portfolio });
      return NextResponse.json({ ...result, session_binding: sessionBinding(session.sessionId) }, { headers });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const initial = await requireMutationSession(); assertRequestSessionBinding(request, initial.sessionId);
    const input = await body(request);
    const current = await requireMutationSession();
    if (current.sessionId !== initial.sessionId || current.userId !== initial.userId) throw new AuthError("SESSION_CHANGED", 401);
    assertRequestSessionBinding(request, current.sessionId);
    const db = openWorkbench();
    try {
      const actor = { id: current.userId, kind: "human" as const };
      const result = input.action === "save_collection_schedule" ? saveCollectionSchedule(db, actor, input.command)
        : input.action === "set_collection_schedule_status" ? setCollectionScheduleStatus(db, actor, input.command)
        : input.action === "store_source" ? storeMarketReferenceSource(db, actor, input.command) : publishMarketReference(db, actor, input.command);
      return NextResponse.json({ ...result, session_binding: sessionBinding(current.sessionId) }, { headers });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}
