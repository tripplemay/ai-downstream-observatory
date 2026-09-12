import { NextResponse } from "next/server";
import { AuthError } from "@/server/auth/core";
import { requireMutationSession } from "@/server/auth/session";
import { openWorkbench } from "@/server/workbench-db";
import { readCsvInspectionUpload } from "@/server/ledger/csv-inspection-upload";
import { inspectCsvImport } from "@/server/ledger/csv-inspection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const clientErrors = new Set(["CSV_INSPECTION_FIELDS_INVALID", "CSV_INSPECTION_DIALECT_INVALID", "CSV_INSPECTION_VALUES_INVALID", "CSV_INSPECTION_VALUES_UNAVAILABLE", "CSV_COLUMN_NOT_FOUND", "CSV_FILENAME_INVALID", "CSV_EMPTY", "CSV_BYTES_REQUIRED", "CSV_DIALECT_INVALID"]);
function failure(error: unknown) {
  let code = "WORKBENCH_UNAVAILABLE", status = 503;
  if (error instanceof AuthError) { code = error.code; status = error.status; }
  else if (error instanceof Error) {
    const message = error.message;
    if (message === "VERSION_CONFLICT") { code = message; status = 409; }
    else if (message === "ACCOUNT_OUT_OF_SCOPE") { code = message; status = 403; }
    else if (message === "PORTFOLIO_NOT_FOUND") { code = message; status = 404; }
    else if (["CSV_TOO_LARGE", "CSV_INSPECTION_VALUES_TOO_LARGE", "CSV_INSPECTION_RESPONSE_TOO_LARGE"].includes(message)) { code = message; status = 413; }
    else if (clientErrors.has(message)) { code = message; status = 400; }
  }
  if (status === 503) console.error("CSV inspection failed", error instanceof Error ? error.name : "UnknownError");
  return NextResponse.json({ error: code }, { status, headers: { ...headers, ...(status === 413 ? { Connection: "close" } : {}) } });
}

export async function POST(request: Request) {
  try {
    // Reuse session + Origin validation even though this endpoint never mutates the ledger.
    await requireMutationSession();
    const input = await readCsvInspectionUpload(request), db = openWorkbench();
    try { return NextResponse.json(inspectCsvImport(db, input), { headers }); }
    finally { db.close(); }
  } catch (error) { return failure(error); }
}
