import { AuthError } from "../auth/core";
import { CSV_LIMITS } from "./csv";
import { CSV_MAPPING_MAX_BYTES } from "./csv-mapping";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export interface CsvUpload { portfolio_id: string; account_id: string; expected_revision: number; mapping: string; filename: string; bytes: Uint8Array }

/** Bound the multipart body before handing it to the platform parser. No base64 expansion. */
export async function readCsvUpload(request: Request): Promise<CsvUpload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType) || request.headers.has("content-encoding")) throw new AuthError("CSV_MULTIPART_REQUIRED", 415);
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_UPLOAD_BYTES)) throw new AuthError("REQUEST_TOO_LARGE", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError("CSV_UPLOAD_EMPTY", 400);
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_UPLOAD_BYTES) { await reader.cancel(); throw new AuthError("REQUEST_TOO_LARGE", 413); }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks);
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body); }
  catch { throw new AuthError("INVALID_UTF8", 400); }
  let form: FormData;
  try { form = await new Response(body, { headers: { "Content-Type": contentType } }).formData(); }
  catch { throw new AuthError("CSV_MULTIPART_INVALID", 400); }
  const names = ["portfolio_id", "account_id", "expected_revision", "mapping", "file"];
  if ([...form.keys()].some(key => !names.includes(key)) || names.some(key => form.getAll(key).length !== 1)) throw new AuthError("CSV_UPLOAD_FIELDS_INVALID", 400);
  const portfolio = form.get("portfolio_id"), account = form.get("account_id"), revision = form.get("expected_revision"), mapping = form.get("mapping"), file = form.get("file");
  if (typeof portfolio !== "string" || !portfolio.trim() || portfolio.length > 120 || typeof account !== "string" || !account.trim() || account.length > 120
    || typeof revision !== "string" || !/^(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision)) || typeof mapping !== "string" || !file || typeof file === "string") throw new AuthError("CSV_UPLOAD_FIELDS_INVALID", 400);
  if (Buffer.byteLength(mapping, "utf8") > CSV_MAPPING_MAX_BYTES) throw new AuthError("CSV_MAPPING_TOO_LARGE", 413);
  if (!file.size || file.size > CSV_LIMITS.bytes) throw new AuthError("CSV_TOO_LARGE", 413);
  if (!file.name || file.name.length > 200 || /[\u0000-\u001f\u007f]/.test(file.name)) throw new AuthError("CSV_FILENAME_INVALID", 400);
  return { portfolio_id: portfolio, account_id: account, expected_revision: Number(revision), mapping, filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}
