import { NextResponse } from "next/server";
import { AuthError } from "@/server/auth/core";
import { requireApiSession } from "@/server/auth/session";
import { openWorkbench } from "@/server/workbench-db";
import { readAttachment } from "@/server/ledger/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireApiSession();
    const { id } = await context.params;
    const url = new URL(request.url);
    const portfolio = url.searchParams.get("portfolio");
    if (!portfolio || url.searchParams.getAll("portfolio").length !== 1 || [...url.searchParams.keys()].some(key => key !== "portfolio") || portfolio.length > 200 || id.length > 200) {
      return NextResponse.json({ error: "INVALID_ATTACHMENT_REQUEST" }, { status: 400 });
    }
    const db = openWorkbench();
    try {
      const { attachment, bytes } = readAttachment(db, { id: session.userId }, portfolio, id);
      const suffix = attachment.media_type === "text/csv" ? "csv" : "json";
      return new Response(new Uint8Array(bytes), { headers: {
        "Content-Type": `${attachment.media_type}; charset=utf-8`, "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="${attachment.content_hash}.${suffix}"`,
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'", "ETag": `"${attachment.content_hash}"`,
      } });
    } finally { db.close(); }
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.code }, { status: error.status });
    const message = error instanceof Error ? error.message : "";
    if (["ATTACHMENT_OUT_OF_SCOPE", "ACCOUNT_OUT_OF_SCOPE"].includes(message)) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    if (["ATTACHMENT_NOT_FOUND", "PORTFOLIO_NOT_FOUND"].includes(message)) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ error: "ATTACHMENT_UNAVAILABLE" }, { status: 503 });
  }
}
