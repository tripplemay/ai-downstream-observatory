import { NextResponse } from "next/server";
import { AuthError } from "@/server/auth/core";
import { requireMutationSession } from "@/server/auth/session";
import { assertRequestSessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { readCsvUpload } from "@/server/ledger/csv-upload";
import { previewCsvImport } from "@/server/ledger/csv-imports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const conflicts = new Set([
  "VERSION_CONFLICT", "DUPLICATE_CONFLICT", "SOURCE_DUPLICATE_CONFLICT", "PREVIEW_HASH_MISMATCH",
  "CSV_MAPPING_VERSION_CONFLICT", "CSV_FILE_ALREADY_CONFIRMED", "CSV_IMPORT_METHOD_CHANGED",
  "CSV_IMPORT_CONTEXT_CHANGED", "CSV_REVIEW_HASH_MISMATCH", "CSV_REVIEW_CONFLICT",
]);
const forbidden = new Set(["ACCOUNT_OUT_OF_SCOPE", "IMPORT_BATCH_OUT_OF_SCOPE", "ATTACHMENT_OUT_OF_SCOPE", "CSV_REVIEW_SCOPE_MISMATCH"]);
const missing = new Set(["PORTFOLIO_NOT_FOUND", "IMPORT_NOT_FOUND", "ATTACHMENT_NOT_FOUND"]);
const tooLarge = new Set(["IMPORT_TOO_LARGE", "ATTACHMENT_TOO_LARGE", "CSV_MAPPING_TOO_LARGE", "CSV_TOO_LARGE"]);
const clientErrors = new Set([
  "CSV_UPLOAD_FIELDS_INVALID", "CSV_MAPPING_JSON_INVALID", "CSV_MAPPING_INVALID", "CSV_REVIEW_CANDIDATE_LIMIT",
  "CSV_REVIEW_INVALID", "CSV_REVIEW_ROWS_MISMATCH", "CSV_REVIEW_LINK_NOT_EXACT",
  "INVALID_ATTACHMENT_TEXT", "INVALID_ATTACHMENT_BYTES", "INVALID_ATTACHMENT_UTF8", "INVALID_JSON_VALUE",
]);

function errorResponse(code: string, status: number): NextResponse {
  return NextResponse.json({ error: code }, {
    status, headers: { "Cache-Control": "private, no-store", ...(status === 413 ? { Connection: "close" } : {}) },
  });
}

function failure(error: unknown): NextResponse {
  if (error instanceof AuthError) return errorResponse(error.code, error.status);
  const message = error instanceof Error ? error.message : "REQUEST_FAILED";
  if (conflicts.has(message)) return errorResponse(message, 409);
  if (forbidden.has(message)) return errorResponse(message, 403);
  if (missing.has(message)) return errorResponse(message, 404);
  if (message === "UNAUTHENTICATED") return errorResponse(message, 401);
  if (message === "WORKBENCH_READ_ONLY") return errorResponse(message, 423);
  if (tooLarge.has(message)) return errorResponse(message, 413);
  const code = message.split(":", 1)[0];
  if (clientErrors.has(code)) return errorResponse(code, 400);
  // Storage paths, source SQL and corrupt evidence details are not client diagnostics.
  console.error("CSV upload failed", error instanceof Error ? error.name : "UnknownError");
  return errorResponse("WORKBENCH_UNAVAILABLE", 503);
}

export async function POST(request: Request) {
  try {
    const session = await requireMutationSession();
    assertRequestSessionBinding(request, session.sessionId);
    const input = await readCsvUpload(request);
    const current = await requireMutationSession();
    if (current.userId !== session.userId || current.sessionId !== session.sessionId) throw new AuthError("SESSION_CHANGED", 401);
    const db = openWorkbench();
    try {
      const result = previewCsvImport(db, { id: session.userId }, input);
      return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}
