import { z } from "zod";
import { AuthError } from "../auth/core";
import { parseStrictJson } from "../strict-json";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const text = z.string().min(1).max(2000);
export const catalogRequestSchema = z.object({
  action: z.enum(["add_entry", "store_source", "publish_profile", "publish_holdings", "compare"]),
  command: z.unknown(),
}).strict();

export function parseCatalogQuery(url: string) {
  const params = new URL(url).searchParams;
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) throw new AuthError("INVALID_QUERY", 400);
  const query = z.object({
    portfolio: text.optional(), view: z.enum(["detail", "source"]).optional(),
    listing: text.optional(), source: text.optional(), market: z.enum(["CN", "HK", "US"]).optional(),
    query: z.string().max(100).optional(), cursor: z.string().min(1).max(4000).optional(),
    limit: z.string().regex(/^[1-9]\d?$/).transform(Number).refine(value => value <= 50).optional(),
  }).strict().parse(Object.fromEntries(params));
  if (query.view) {
    if (!query.portfolio || query.market || query.query !== undefined || query.cursor || query.limit !== undefined
      || (query.view === "detail" ? !query.listing || query.source : !query.source || query.listing)) throw new AuthError("INVALID_QUERY", 400);
  } else if (query.listing || query.source || (query.cursor && !query.portfolio)) throw new AuthError("INVALID_QUERY", 400);
  return query;
}

export async function readCatalogRequest(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new AuthError("JSON_REQUIRED", 415);
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) throw new AuthError("REQUEST_TOO_LARGE", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError("INVALID_JSON", 400);
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) { await reader.cancel(); throw new AuthError("REQUEST_TOO_LARGE", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new AuthError("INVALID_UTF8", 400); }
  let value: unknown;
  try { value = parseStrictJson(raw); } catch { throw new AuthError("INVALID_JSON", 400); }
  return catalogRequestSchema.parse(value);
}
