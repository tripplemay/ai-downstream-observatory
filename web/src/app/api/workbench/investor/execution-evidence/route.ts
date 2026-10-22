import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError } from "@/server/auth/core";
import { requireMutationSession } from "@/server/auth/session";
import { assertRequestSessionBinding, sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { parseStrictJson } from "@/server/strict-json";
import { storeInvestorExecutionEvidence } from "@/server/investor/execution-evidence";
import { executionUploadScopeSchema } from "@/server/investor/execution-followup-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
async function readUpload(request: Request) {
  const contentType = request.headers.get("content-type") ?? "", maximum = 5 * 1024 * 1024;
  if (!/^multipart\/form-data\s*;/i.test(contentType) || request.headers.has("content-encoding")) throw new AuthError("MULTIPART_REQUIRED", 415);
  const declared = request.headers.get("content-length");
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > maximum)) throw new AuthError("REQUEST_TOO_LARGE", 413);
  const reader = request.body?.getReader(); if (!reader) throw new AuthError("INVALID_UPLOAD", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
    if (size > maximum) { await reader.cancel(); throw new AuthError("REQUEST_TOO_LARGE", 413); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  let form: FormData;
  try { form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": contentType } }).formData(); }
  catch { throw new AuthError("INVALID_UPLOAD", 400); }
  const names = ["scope", "idempotency_key", "media_type", "file"];
  if ([...form.keys()].some(name => !names.includes(name)) || names.some(name => form.getAll(name).length !== 1)) throw new AuthError("INVALID_UPLOAD", 400);
  const raw = form.get("scope"), key = form.get("idempotency_key"), media = form.get("media_type"), file = form.get("file");
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 8192 || typeof key !== "string" || !["text/csv", "application/json"].includes(String(media))
    || !file || typeof file === "string" || !file.size || file.size > 4 * 1024 * 1024) throw new AuthError("INVALID_UPLOAD", 400);
  let scope: unknown; try { scope = executionUploadScopeSchema.parse(parseStrictJson(raw)); } catch { throw new AuthError("INVALID_UPLOAD", 400); }
  return { scope, upload: { bytes: new Uint8Array(await file.arrayBuffer()), media_type: media as "text/csv" | "application/json", idempotency_key: key } };
}
export async function POST(request: Request) {
  try {
    const first = await requireMutationSession();
    if (!request.headers.get("x-workbench-session-binding")) throw new AuthError("SESSION_BINDING_REQUIRED", 400);
    assertRequestSessionBinding(request, first.sessionId);
    if (new URL(request.url).searchParams.size) throw new AuthError("INVALID_QUERY", 400);
    const input = await readUpload(request), current = await requireMutationSession();
    if (current.sessionId !== first.sessionId || current.userId !== first.userId) throw new AuthError("SESSION_CHANGED", 401);
    assertRequestSessionBinding(request, current.sessionId);
    const db = openWorkbench();
    try { return NextResponse.json({ ...storeInvestorExecutionEvidence(db, { id: current.userId }, input.scope, input.upload, new Date().toISOString()),
      session_binding: sessionBinding(current.sessionId) }, { headers }); } finally { db.close(); }
  } catch (error) {
    const message = error instanceof Error ? error.message : "", client = /^INVESTOR_EXECUTION_(CONTEXT_CONFLICT|CAPACITY_REQUIRES_REVIEW|UPLOAD_INVALID|UPLOAD_DUPLICATE_CONFLICT)$/.test(message);
    const code = error instanceof AuthError ? error.code : error instanceof z.ZodError ? "INVESTOR_EXECUTION_UPLOAD_INVALID"
      : message === "WORKBENCH_READ_ONLY" || message === "INVESTOR_ACCOUNT_OUT_OF_SCOPE" || client ? message : "INVESTOR_EXECUTION_UNAVAILABLE";
    const status = error instanceof AuthError ? error.status : code === "WORKBENCH_READ_ONLY" ? 423 : code === "INVESTOR_ACCOUNT_OUT_OF_SCOPE" ? 403
      : code.endsWith("_CONFLICT") ? 409 : client || error instanceof z.ZodError ? 400 : 503;
    return NextResponse.json({ error: code }, { status, headers });
  }
}
