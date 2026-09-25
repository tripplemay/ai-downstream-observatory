import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareCsvBackgroundPreview, sendCsvBackground } from "../src/components/workbench/csv-background-client";

const binding = "b".repeat(64), encoder = new TextEncoder();
const csv = encoder.encode('\ufeffdate,amount,id,note\r\n2026-01-01,7,s1,"Synthetic, original"\r\n');
const mappingValue = {
  schema_version: "csv-import-mapping-v1", mapping_id: "SYNTHETIC-MULTIPART", version: 1, title: "Synthetic parser compatibility only",
  dialect: { encoding: "utf-8", delimiter: ",", record_separator: "either" }, expected_headers: ["date", "amount", "id", "note"], ignored_columns: [],
  account: { kind: "constant", value: "a" }, event_type: { kind: "constant", value: "deposit" }, source_id: "synthetic",
  source_event_id: { kind: "column", column: "id", trim: false, empty: "reject" }, reason: { kind: "column", column: "note", trim: false, empty: "reject" },
  effective_at: { column: "date", format: "YYYY-MM-DD", trim: false, source_timezone: "UTC" },
  rules: [{ event_type: "deposit", fields: { currency: { kind: "constant", value: "CNY" }, amount: { kind: "decimal", column: "amount", empty: "reject",
    format: { decimal_separator: ".", grouping_separator: "none", negative_style: "minus", allow_leading_plus: false, trim: false } } } }],
};
const mappingLf = " \n" + JSON.stringify(mappingValue, null, 2) + "\r\n\t";
const mappings = [mappingLf, mappingLf.replace(/\r?\n/g, "\r\n")];
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

// No SQLite, worker, addon or HTTP server is imported: run this exact file on each supported Node parser.
const filenames = ["ordinary.csv", "\u5408\u6210 \"original\".csv", "back\\slash.csv", "literal%22.csv", "literal%0A.csv",
  "literal%0D.csv", "literal%25.csv", "\ufefforiginal.csv", "\u{1f4c4}.csv"];
for (const filename of filenames) test(`frozen multipart retains exact original filename ${JSON.stringify(filename)} and raw mapping on explicit retries`, async t => {
  for (const mapping of mappings) {
    const input = { portfolioId: "p", accountId: "a", revision: 0, file: new File([csv], filename, { type: "text/csv" }), mapping,
      idempotencyKey: "synthetic-multipart-key", acknowledge: true as const };
    const prepared = await prepareCsvBackgroundPreview(input);
    const inputHash = digest(canonical({ operation: "preview", portfolio_id: "p", account_id: "a", expected_revision: 0,
      input: { filename, mapping, csv_sha256: digest(csv) } }));
    assert.equal(prepared.inputHash, inputHash); assert.equal(prepared.contentHash, digest(csv));
    assert.ok(Object.isFrozen(prepared)); assert.equal(prepared.mapping, mapping); assert.equal(prepared.file.name, filename);
    const posted: { body: BodyInit; filenameHeader: string }[] = [];
    const mock = t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
      if (url === "/api/auth/session") return Response.json({ authenticated: true, session_binding: binding });
      assert.equal(url, "/api/workbench/csv/jobs"); assert.equal(options?.method, "POST");
      const headers = new Headers(options!.headers), filenameHeader = headers.get("X-CSV-Original-Filename")!;
      assert.equal(filenameHeader, Buffer.from(filename, "utf8").toString("base64url"));
      assert.match(filenameHeader, /^[A-Za-z0-9_-]+$/); assert.equal(filenameHeader.includes("="), false);
      assert.equal(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(filenameHeader, "base64url")), filename);
      assert.equal(headers.get("X-CSV-Idempotency-Key"), input.idempotencyKey);
      assert.equal(headers.get("X-CSV-Background-Acknowledged"), "true"); assert.equal(headers.get("X-Workbench-Session-Binding"), binding);
      assert.equal(options!.body, prepared.body);
      const wire = await prepared.body.text(); assert.doesNotMatch(wire, /filename\*/);
      assert.match(wire, /name="file"; filename="upload\.csv"\r\n/);
      const form = await new Request("https://synthetic.invalid", options).formData();
      assert.deepEqual([...form.keys()], ["portfolio_id", "account_id", "expected_revision", "mapping", "file"]);
      assert.equal(form.get("mapping"), mapping); assert.equal(form.get("portfolio_id"), "p"); assert.equal(form.get("account_id"), "a"); assert.equal(form.get("expected_revision"), "0");
      const file = form.get("file") as File; assert.equal(file.name, "upload.csv");
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), csv);
      posted.push({ body: options!.body!, filenameHeader });
      return Response.json({ request_id: "synthetic-request", status: "queued", operation: "preview", input_hash: inputHash, session_binding: binding });
    });
    try {
      const options = { sessionBinding: binding, isCurrent: () => true };
      for (let retry = 0; retry < 2; retry++) assert.equal((await sendCsvBackground(prepared, options)).request_id, "synthetic-request");
      assert.equal(posted.length, 2); assert.equal(posted[0].body, posted[1].body); assert.equal(posted[0].filenameHeader, posted[1].filenameHeader);
    } finally { mock.mock.restore(); }
  }
});

test("original percent sequence and quote stay distinct input identities although multipart placeholder names are identical", async () => {
  const prepared = await Promise.all(["literal%22.csv", 'literal".csv'].map(name => prepareCsvBackgroundPreview({ portfolioId: "p", accountId: "a", revision: 0,
    file: new File([csv], name), mapping: mappingLf, idempotencyKey: "synthetic-identity", acknowledge: true })));
  assert.notEqual(prepared[0].inputHash, prepared[1].inputHash); assert.equal(prepared[0].contentHash, prepared[1].contentHash);
});
