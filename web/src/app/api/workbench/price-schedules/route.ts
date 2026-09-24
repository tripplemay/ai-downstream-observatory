import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError } from "@/server/auth/core";
import { requireApiSession, requireMutationSession } from "@/server/auth/session";
import { assertRequestSessionBinding, sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { parseStrictJson } from "@/server/strict-json";
import { savePriceCollectionScheduleSchema, setPriceCollectionScheduleStatusSchema, priceCollectionQuerySchema, priceCollectionSlotQuerySchema } from "@/server/price-schedules/schemas";
import { savePriceCollectionSchedule, setPriceCollectionScheduleStatus, isPriceCollectionClientError } from "@/server/price-schedules/service";
import { getPriceCollectionScheduleState, getPriceCollectionSlot } from "@/server/price-schedules/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
const envelope = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_schedule"), command: savePriceCollectionScheduleSchema }).strict(),
  z.object({ action: z.literal("set_status"), command: setPriceCollectionScheduleStatusSchema }).strict(),
]);
const queryStrings = z.object({ portfolio: z.string().optional(), schedule: z.string().optional(), slot: z.string().optional(),
  cursor: z.string().optional(), limit: z.string().regex(/^[1-9][0-9]?$/).transform(Number).refine(value => value <= 50).optional() }).strict();
function requireBoundSession(request: Request, sessionId: string) {
  if (!request.headers.get("X-Workbench-Session-Binding")) throw new AuthError("SESSION_CHANGED", 401);
  assertRequestSessionBinding(request, sessionId);
}
function failure(error: unknown) {
  let status = 503, code = "WORKBENCH_UNAVAILABLE";
  if (error instanceof AuthError) { status = error.status; code = error.code; }
  else if (error instanceof z.ZodError) { status = 400; code = "VALIDATION_FAILED"; }
  else if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") { status = 423; code = error.message; }
  else if (error instanceof Error && isPriceCollectionClientError(error.message) && !/EVIDENCE|RESPONSE_TOO_LARGE/.test(error.message)) {
    code = error.message;
    status = code.endsWith("_CONFLICT") ? 409 : code.endsWith("_PERMISSION_DENIED") || code.endsWith("_OUT_OF_SCOPE") ? 403
      : code.endsWith("_NOT_FOUND") ? 404 : code.endsWith("_TOO_LARGE") ? 413 : 400;
  }
  return NextResponse.json({ error: code }, { status, headers: { ...headers, ...(status === 413 ? { Connection: "close" } : {}) } });
}
async function body(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new AuthError("JSON_REQUIRED", 415);
  const max = 1048576, declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) throw new AuthError("REQUEST_TOO_LARGE", 413);
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
    if ([...parameters.keys()].some(key => parameters.getAll(key).length !== 1)) throw new AuthError("INVALID_QUERY", 400);
    const strings = queryStrings.parse(Object.fromEntries(parameters));
    if (strings.slot !== undefined && (strings.schedule !== undefined || strings.cursor !== undefined || strings.limit !== undefined)) throw new AuthError("INVALID_QUERY", 400);
    if ((strings.schedule !== undefined || strings.cursor !== undefined) && strings.portfolio === undefined) throw new AuthError("INVALID_QUERY", 400);
    const detail = strings.slot !== undefined ? priceCollectionSlotQuerySchema.parse({ portfolio_id: strings.portfolio, slot_id: strings.slot }) : null;
    if (detail) requireBoundSession(request, initial.sessionId);
    const query = detail ? null : priceCollectionQuerySchema.parse({ portfolio_id: strings.portfolio, schedule_id: strings.schedule, cursor: strings.cursor, limit: strings.limit });
    const db = openWorkbench();
    try {
      const result = detail ? getPriceCollectionSlot(db, detail) : getPriceCollectionScheduleState(db, query!);
      const current = await requireApiSession();
      if (current.sessionId !== initial.sessionId || current.userId !== initial.userId) throw new AuthError("SESSION_CHANGED", 401);
      assertRequestSessionBinding(request, current.sessionId);
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
      const actor = { id: current.userId, kind: "human" as const };
      const result = input.action === "save_schedule" ? savePriceCollectionSchedule(db, actor, input.command) : setPriceCollectionScheduleStatus(db, actor, input.command);
      const final = await requireMutationSession();
      if (final.sessionId !== current.sessionId || final.userId !== current.userId) throw new AuthError("SESSION_CHANGED", 401);
      assertRequestSessionBinding(request, final.sessionId);
      return NextResponse.json({ ...result, session_binding: sessionBinding(final.sessionId) }, { headers });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}
