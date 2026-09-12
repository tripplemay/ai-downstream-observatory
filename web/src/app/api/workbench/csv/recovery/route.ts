import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, tokenHash } from "@/server/auth/core";
import { requireApiSession } from "@/server/auth/session";
import { sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { getCsvConfirmationAttempt, isCsvRecoveryClientError, listCsvConfirmationAttempts } from "@/server/ledger/csv-confirmation-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
const querySchema = z.object({ id: z.string().uuid().optional(), batch: z.string().min(1).max(2000).optional(), payload_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  cursor: z.string().min(1).max(1024).optional(), limit: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().min(1).max(20)).optional() }).strict();

export async function GET(request: Request) {
  try {
    const session = await requireApiSession();
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) throw new Error("CSV_RECOVERY_QUERY_INVALID");
    const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new Error("CSV_RECOVERY_QUERY_INVALID");
    const query = parsed.data, isId = query.id !== undefined, isHash = query.batch !== undefined || query.payload_hash !== undefined;
    if ((isId && isHash) || (isHash && (!query.batch || !query.payload_hash)) || ((isId || isHash) && (query.cursor !== undefined || query.limit !== undefined))) throw new Error("CSV_RECOVERY_QUERY_INVALID");
    const db = openWorkbench();
    let result;
    try {
      const principal = { actorId: session.userId, sessionHash: tokenHash(session.sessionId) };
      result = isId ? getCsvConfirmationAttempt(db, principal, { id: query.id! })
        : isHash ? getCsvConfirmationAttempt(db, principal, { batch_id: query.batch!, payload_hash: query.payload_hash! })
        : listCsvConfirmationAttempts(db, principal, { ...(query.cursor === undefined ? {} : { cursor: query.cursor }), ...(query.limit === undefined ? {} : { limit: query.limit }) });
    } finally { db.close(); }
    const current = await requireApiSession();
    if (current.userId !== session.userId || current.sessionId !== session.sessionId) throw new AuthError("UNAUTHENTICATED", 401);
    return NextResponse.json({ ...result, session_binding: sessionBinding(session.sessionId) }, { headers });
  } catch (error) {
    let code = "WORKBENCH_UNAVAILABLE", status = 503;
    if (error instanceof AuthError) { code = error.code; status = error.status; }
    else if (error instanceof Error && isCsvRecoveryClientError(error.message)) {
      code = error.message;
      status = code === "CSV_RECOVERY_NOT_FOUND" ? 404 : code.endsWith("_TOO_LARGE") ? 413 : 400;
    }
    if (status === 503) console.error("CSV confirmation recovery failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: code }, { status, headers });
  }
}
