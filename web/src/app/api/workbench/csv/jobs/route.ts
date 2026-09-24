import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, tokenHash } from "@/server/auth/core";
import { requireApiSession, requireMutationSession } from "@/server/auth/session";
import { assertRequestSessionBinding, sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { parseStrictJson } from "@/server/strict-json";
import { readCsvUpload } from "@/server/ledger/csv-upload";
import { CSV_BACKGROUND_LIMITS, csvBackgroundIdSchema as id } from "@/server/csv-background/binding";
import { requestCsvBackgroundPreview, requestCsvBackgroundConfirmation, cancelCsvBackgroundRequest, isCsvBackgroundClientError } from "@/server/csv-background/service";
import { csvBackgroundQuerySchema, queryCsvBackground } from "@/server/csv-background/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
// Every legal 5 MiB payload string fits even when each byte is JSON-escaped as six ASCII characters.
const JSON_MAX_BYTES = 6 * CSV_BACKGROUND_LIMITS.payload_bytes + 1024 * 1024, MULTIPART_MAX_BYTES = 5 * 1024 * 1024;
const confirm = z.object({ portfolio_id: id, account_id: id, idempotency_key: id, payload_text: z.string().min(1).max(CSV_BACKGROUND_LIMITS.payload_bytes), acknowledge_background_execution: z.literal(true) }).strict();
const cancel = z.object({ portfolio_id: id, request_id: id, reason: z.string().refine(value => !!value.trim() && [...value].length <= 1000 && !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value)) }).strict();
const envelope = z.discriminatedUnion("action", [z.object({ action: z.literal("confirm"), command: confirm }).strict(), z.object({ action: z.literal("cancel"), command: cancel }).strict()]);
const integer = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().safe());
const queryStrings = z.object({ portfolio: id, request: id.optional(), view: z.enum(["status", "preview", "rows", "candidates", "receipts"]).optional(), cursor: z.string().min(1).max(2048).optional(), limit: integer.optional(), row: integer.optional(), kind: z.string().optional(),
  review_only: z.enum(["true", "false"]).transform(value => value === "true").optional() }).strict();
const conflicts = new Set(["VERSION_CONFLICT", "PREVIEW_HASH_MISMATCH", "CSV_BACKGROUND_IDEMPOTENCY_CONFLICT", "CSV_BACKGROUND_ALREADY_TERMINAL", "CSV_BACKGROUND_CONFIRM_REQUIRED", "CSV_FILE_ALREADY_CONFIRMED", "IMPORT_HAS_ERRORS", "CSV_BACKGROUND_RESULT_NOT_READY", "CSV_BACKGROUND_RECEIPTS_UNAVAILABLE"]);
const inputErrors = new Set(["CSV_BACKGROUND_QUERY_INVALID", "CSV_BACKGROUND_CURSOR_INVALID", "CSV_MAPPING_JSON_INVALID", "CSV_MAPPING_INVALID", "CSV_REVIEW_INVALID", "CSV_RECOVERY_PAYLOAD_INVALID", "CSV_RECOVERY_NOT_CSV", "CSV_RECOVERY_QUERY_INVALID"]);
function bound(request: Request, sid: string) {
  if (!request.headers.get("X-Workbench-Session-Binding")) throw new AuthError("SESSION_CHANGED", 401);
  assertRequestSessionBinding(request, sid);
}
function failure(error: unknown) {
  let code = "WORKBENCH_UNAVAILABLE", status = 503;
  if (error instanceof AuthError) { code = error.code; status = error.status; }
  else if (error instanceof z.ZodError) { code = "VALIDATION_FAILED"; status = 400; }
  else if (error instanceof Error) {
    const message = error.message;
    if (message === "WORKBENCH_READ_ONLY") { code = message; status = 423; }
    else if (conflicts.has(message)) { code = message; status = 409; }
    else if (["ACCOUNT_OUT_OF_SCOPE", "ATTACHMENT_OUT_OF_SCOPE"].includes(message)) { code = message; status = 403; }
    else if (["CSV_BACKGROUND_NOT_FOUND", "CSV_BACKGROUND_ROW_NOT_FOUND", "IMPORT_NOT_FOUND"].includes(message)) { code = message; status = 404; }
    else if (["CSV_MAPPING_TOO_LARGE", "CSV_RECOVERY_PAYLOAD_TOO_LARGE", "CSV_BACKGROUND_RESPONSE_TOO_LARGE"].includes(message)) { code = message; status = 413; }
    else if (inputErrors.has(message) || isCsvBackgroundClientError(message) || message === "CSV_RECOVERY_BUDGET_EXCEEDED") { code = message; status = 400; }
  }
  return NextResponse.json({ error: code }, { status, headers: { ...headers, ...(status === 413 ? { Connection: "close" } : {}) } });
}
async function readBytes(request: Request, max: number) {
  if (request.headers.has("content-encoding")) throw new AuthError("CONTENT_ENCODING_UNSUPPORTED", 415);
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) throw new AuthError("REQUEST_TOO_LARGE", 413);
  const reader = request.body?.getReader(); if (!reader) throw new AuthError("REQUEST_BODY_REQUIRED", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > max) { void reader.cancel().catch(() => {}); throw new AuthError("REQUEST_TOO_LARGE", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export async function GET(request: Request) {
  try {
    const initial = await requireApiSession(); bound(request, initial.sessionId);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => params.getAll(key).length !== 1)) throw new AuthError("INVALID_QUERY", 400);
    const strings = queryStrings.parse(Object.fromEntries(params));
    const query = csvBackgroundQuerySchema.parse({ portfolio_id: strings.portfolio, request_id: strings.request, view: strings.view, cursor: strings.cursor, limit: strings.limit, row: strings.row, kind: strings.kind, review_only: strings.review_only });
    const db = openWorkbench();
    try {
      const result = queryCsvBackground(db, { actorId: initial.userId, sessionHash: tokenHash(initial.sessionId) }, query);
      const current = await requireApiSession();
      if (current.sessionId !== initial.sessionId || current.userId !== initial.userId) throw new AuthError("SESSION_CHANGED", 401);
      bound(request, current.sessionId);
      return NextResponse.json({ ...result, session_binding: sessionBinding(current.sessionId) }, { headers });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const initial = await requireMutationSession(); bound(request, initial.sessionId);
    if (new URL(request.url).searchParams.size) throw new AuthError("INVALID_QUERY", 400);
    const media = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    let input;
    if (media === "multipart/form-data") {
      const key = id.parse(request.headers.get("X-CSV-Idempotency-Key"));
      if (request.headers.get("X-CSV-Background-Acknowledged") !== "true") throw new AuthError("CSV_BACKGROUND_ACKNOWLEDGEMENT_REQUIRED", 400);
      const raw = await readBytes(request, MULTIPART_MAX_BYTES);
      const upload = await readCsvUpload(new Request(request.url, { method: "POST", headers: request.headers, body: raw }));
      input = { action: "preview" as const, command: { ...upload, idempotency_key: key, acknowledge_background_execution: true as const } };
    } else {
      if (media !== "application/json") throw new AuthError("CSV_BACKGROUND_MEDIA_TYPE_REQUIRED", 415);
      const raw = await readBytes(request, JSON_MAX_BYTES); let value;
      try { value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { throw new AuthError("INVALID_JSON", 400); }
      input = envelope.parse(value);
    }
    const current = await requireMutationSession();
    if (current.sessionId !== initial.sessionId || current.userId !== initial.userId) throw new AuthError("SESSION_CHANGED", 401);
    bound(request, current.sessionId);
    const principal = { actorId: current.userId, sessionHash: tokenHash(current.sessionId) }, db = openWorkbench();
    try {
      const result = input.action === "preview" ? requestCsvBackgroundPreview(db, principal, input.command)
        : input.action === "confirm" ? requestCsvBackgroundConfirmation(db, principal, input.command) : cancelCsvBackgroundRequest(db, principal, input.command);
      const final = await requireMutationSession();
      if (final.sessionId !== current.sessionId || final.userId !== current.userId) throw new AuthError("SESSION_CHANGED", 401);
      bound(request, final.sessionId);
      return NextResponse.json({ ...result, session_binding: sessionBinding(final.sessionId) }, { headers });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}
