import { z } from "zod";
import { AuthError } from "../auth/core";
import { parseStrictJson } from "../strict-json";
import { CSV_LIMITS } from "./csv";
import type { CsvInspectionRequest } from "./csv-inspection-types";

const id = z.string().min(1).max(120).refine(value => value.trim().length > 0);
const dialect = z.object({ encoding: z.literal("utf-8"), delimiter: z.enum([",", ";", "\t"]), record_separator: z.enum(["crlf", "lf", "either"]) }).strict();
export const csvInspectionRequestSchema = z.object({
  portfolio_id: id, account_id: id, expected_revision: z.number().int().nonnegative().safe(),
  dialect: z.union([z.literal("auto"), dialect]),
  values: z.object({ column: z.string().min(1).max(256), trim: z.boolean(), offset: z.number().int().nonnegative().safe(), limit: z.number().int().min(1).max(100) }).strict().optional(),
}).strict().refine(value => value.dialect !== "auto" || !value.values, "CSV_INSPECTION_VALUES_REQUIRE_DIALECT");
export interface CsvInspectionUpload extends CsvInspectionRequest { filename: string; bytes: Uint8Array }
export const CSV_INSPECTION_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Inspect uploads are never attached or persisted. The original File is uploaded again for ledger preview. */
export async function readCsvInspectionUpload(request: Request): Promise<CsvInspectionUpload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType) || request.headers.has("content-encoding")) throw new AuthError("CSV_MULTIPART_REQUIRED", 415);
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > CSV_INSPECTION_UPLOAD_BYTES)) throw new AuthError("REQUEST_TOO_LARGE", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError("CSV_UPLOAD_EMPTY", 400);
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > CSV_INSPECTION_UPLOAD_BYTES) { await reader.cancel(); throw new AuthError("REQUEST_TOO_LARGE", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks);
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body); }
  catch { throw new AuthError("INVALID_UTF8", 400); }
  let form: FormData;
  try { form = await new Response(body, { headers: { "Content-Type": contentType } }).formData(); }
  catch { throw new AuthError("CSV_MULTIPART_INVALID", 400); }
  const required = ["portfolio_id", "account_id", "expected_revision", "dialect", "file"], allowed = [...required, "values"];
  if ([...form.keys()].some(key => !allowed.includes(key)) || required.some(key => form.getAll(key).length !== 1) || form.getAll("values").length > 1) throw new AuthError("CSV_INSPECTION_FIELDS_INVALID", 400);
  const revision = form.get("expected_revision"), rawDialect = form.get("dialect"), rawValues = form.get("values");
  if (typeof revision !== "string" || !/^(0|[1-9]\d*)$/.test(revision) || typeof rawDialect !== "string" || Buffer.byteLength(rawDialect, "utf8") > 1024
    || (rawValues !== null && (typeof rawValues !== "string" || Buffer.byteLength(rawValues, "utf8") > 4096))) throw new AuthError("CSV_INSPECTION_FIELDS_INVALID", 400);
  let parsedDialect: unknown, parsedValues: unknown;
  try { parsedDialect = rawDialect === "auto" ? "auto" : parseStrictJson(rawDialect); }
  catch { throw new AuthError("CSV_INSPECTION_DIALECT_INVALID", 400); }
  try { parsedValues = rawValues === null ? undefined : parseStrictJson(rawValues as string); }
  catch { throw new AuthError("CSV_INSPECTION_VALUES_INVALID", 400); }
  const input = csvInspectionRequestSchema.safeParse({ portfolio_id: form.get("portfolio_id"), account_id: form.get("account_id"), expected_revision: Number(revision), dialect: parsedDialect, ...(parsedValues === undefined ? {} : { values: parsedValues }) });
  if (!input.success) throw new AuthError("CSV_INSPECTION_FIELDS_INVALID", 400);
  const file = form.get("file");
  if (!file || typeof file === "string") throw new AuthError("CSV_INSPECTION_FIELDS_INVALID", 400);
  if (!file.size) throw new AuthError("CSV_EMPTY", 400);
  if (file.size > CSV_LIMITS.bytes) throw new AuthError("CSV_TOO_LARGE", 413);
  if (!file.name || file.name.length > 200 || /[\u0000-\u001f\u007f]/.test(file.name)) throw new AuthError("CSV_FILENAME_INVALID", 400);
  return { ...input.data, filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}
