import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError } from "@/server/auth/core";
import { requireApiSession, requireMutationSession } from "@/server/auth/session";
import { openWorkbench } from "@/server/workbench-db";
import { parseCatalogQuery, readCatalogRequest } from "@/server/catalog/http-input";
import { addCatalogEntry, storeCatalogSource, publishCatalogProfile, publishCatalogHoldings, isCatalogClientError } from "@/server/catalog/service";
import { catalogWorkspace, catalogDetail, compareCatalog, readCatalogSource } from "@/server/catalog/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
function failure(error: unknown) {
  let code = "WORKBENCH_UNAVAILABLE", status = 503;
  if (error instanceof AuthError) { code = error.code; status = error.status; }
  else if (error instanceof z.ZodError) { code = "VALIDATION_FAILED"; status = 400; }
  else {
    const message = error instanceof Error ? error.message : "";
    if (message === "WORKBENCH_READ_ONLY") { code = message; status = 423; }
    else if (isCatalogClientError(message)) {
      code = message;
      status = message.endsWith("_CONFLICT") || message === "CATALOG_CURSOR_STALE" ? 409
        : message.endsWith("_OUT_OF_SCOPE") || message.endsWith("_PERMISSION_DENIED") ? 403
        : message.endsWith("_NOT_FOUND") ? 404 : message.endsWith("_TOO_LARGE") ? 413 : 400;
    }
  }
  if (status === 503) console.error("Catalog request failed", error instanceof Error ? error.name : "UnknownError");
  return NextResponse.json({ error: code }, { status, headers: { ...headers, ...(status === 413 ? { Connection: "close" } : {}) } });
}

export async function GET(request: Request) {
  try {
    await requireApiSession();
    const query = parseCatalogQuery(request.url), db = openWorkbench();
    try {
      if (query.view === "source") {
        const source = readCatalogSource(db, query.portfolio!, query.source!);
        return new NextResponse(source.content_text, { headers: { ...headers, "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": 'attachment; filename="catalog-source.json"', "Content-Security-Policy": "sandbox; default-src 'none'" } });
      }
      const result = query.view === "detail"
        ? catalogDetail(db, { portfolio_id: query.portfolio!, listing_id: query.listing! })
        : catalogWorkspace(db, { portfolio_id: query.portfolio, market: query.market, query: query.query, cursor: query.cursor, limit: query.limit });
      return NextResponse.json(result, { headers });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requireMutationSession();
    const input = await readCatalogRequest(request), db = openWorkbench();
    try {
      const actor = { id: session.userId, kind: "human" as const };
      const result = input.action === "add_entry" ? addCatalogEntry(db, actor, input.command)
        : input.action === "store_source" ? storeCatalogSource(db, actor, input.command)
        : input.action === "publish_profile" ? publishCatalogProfile(db, actor, input.command)
        : input.action === "publish_holdings" ? publishCatalogHoldings(db, actor, input.command)
        : compareCatalog(db, input.command);
      return NextResponse.json(result, { headers });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}
