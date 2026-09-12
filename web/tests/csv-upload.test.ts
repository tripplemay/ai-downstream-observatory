import assert from "node:assert/strict";
import test from "node:test";
import { readCsvUpload } from "../src/server/ledger/csv-upload";

const body = (raw: Uint8Array = Buffer.from('\ufeffCode,Note\r\n000001,"line 1\r\nline 2"\r\n')) => {
  const form = new FormData();
  form.set("portfolio_id", "p"); form.set("account_id", "a"); form.set("expected_revision", "0"); form.set("mapping", '{"explicit":"mapping"}');
  form.set("file", new Blob([new Uint8Array(raw)], { type: "text/csv" }), "original.csv");
  return form;
};
const request = (form: FormData) => new Request("http://fixture.invalid/api/workbench/csv", { method: "POST", body: form });

test("CSV multipart upload retains exact BOM, CRLF, quotes and filename without base64", async () => {
  const raw = Buffer.from('\ufeffCode,Note\r\n000001,"line 1\r\nline 2"\r\n');
  const result = await readCsvUpload(request(body(raw)));
  assert.deepEqual(Buffer.from(result.bytes), raw);
  assert.equal(result.filename, "original.csv"); assert.equal(result.expected_revision, 0);
  assert.equal(result.mapping, '{"explicit":"mapping"}');
});

test("CSV upload rejects duplicate/unknown fields, malformed revision, MIME disguises and invalid UTF8", async () => {
  for (const mutate of [
    (f: FormData) => f.append("account_id", "other"), (f: FormData) => f.set("actor_id", "forged"),
    (f: FormData) => f.set("expected_revision", "1e2"), (f: FormData) => f.set("mapping", new Blob(["{}"]), "mapping.json"),
    (f: FormData) => f.set("file", "not a file"), (f: FormData) => f.delete("file"),
  ]) { const form = body(); mutate(form); await assert.rejects(readCsvUpload(request(form)), /CSV_UPLOAD_FIELDS_INVALID/); }
  await assert.rejects(readCsvUpload(request(body(Buffer.from([0xff])))), /INVALID_UTF8/);
  await assert.rejects(readCsvUpload(new Request("http://fixture.invalid", { method: "POST", headers: { "Content-Type": "text/csv" }, body: "Code\n1" })), /CSV_MULTIPART_REQUIRED/);
  await assert.rejects(readCsvUpload(new Request("http://fixture.invalid", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=no" }, body: "invalid" })), /CSV_MULTIPART_INVALID|CSV_UPLOAD_FIELDS_INVALID/);
});

test("CSV upload enforces file/mapping and streamed transport bounds before parsing", async () => {
  await assert.rejects(readCsvUpload(request(body(Buffer.alloc(4 * 1024 * 1024 + 1, 65)))), /CSV_TOO_LARGE/);
  const mapping = body(); mapping.set("mapping", "x".repeat(256 * 1024 + 1));
  await assert.rejects(readCsvUpload(request(mapping)), /CSV_MAPPING_TOO_LARGE/);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } });
  const streamed = new Request("http://fixture.invalid", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=synthetic" }, body: stream, duplex: "half" } as RequestInit);
  await assert.rejects(readCsvUpload(streamed), /REQUEST_TOO_LARGE/); assert.equal(cancelled, true);
});
