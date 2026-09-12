import assert from "node:assert/strict";
import test from "node:test";
import { readCsvInspectionUpload } from "../src/server/ledger/csv-inspection-upload";

const dialect = { encoding: "utf-8", delimiter: ",", record_separator: "crlf" };
export function inspectionForm(bytes = Buffer.from("\ufeffCode,Note\r\n000001,=1+1\r\n")) {
  const form = new FormData(); form.set("portfolio_id", "p"); form.set("account_id", "a"); form.set("expected_revision", "0"); form.set("dialect", JSON.stringify(dialect));
  form.set("file", new Blob([new Uint8Array(bytes)], { type: "text/csv" }), "synthetic.csv"); return form;
}
const request = (body: FormData) => new Request("https://fixture.invalid/api/workbench/csv/inspect", { method: "POST", body });

test("inspection multipart retains original BOM/newlines/bytes and accepts explicit dialect or auto", async () => {
  const bytes = Buffer.from('\ufeffCode,Note\r\n000001,"line1\r\nline2"\r\n'), form = inspectionForm(bytes);
  form.set("values", JSON.stringify({ column: "Code", trim: false, offset: 0, limit: 100 }));
  const parsed = await readCsvInspectionUpload(request(form));
  assert.deepEqual(Buffer.from(parsed.bytes), bytes); assert.deepEqual(parsed.dialect, dialect); assert.equal(parsed.filename, "synthetic.csv");
  assert.deepEqual(parsed.values, { column: "Code", trim: false, offset: 0, limit: 100 });
  const automatic = inspectionForm(); automatic.set("dialect", "auto");
  assert.equal((await readCsvInspectionUpload(request(automatic))).dialect, "auto");
});

test("inspection multipart rejects duplicate/unknown fields, mapping/actor injection and invalid integer pagination", async () => {
  for (const change of [
    (form: FormData) => form.append("account_id", "other"), (form: FormData) => form.set("actor_id", "forged"),
    (form: FormData) => form.set("mapping", "{}"), (form: FormData) => form.set("expected_revision", "1e2"),
    (form: FormData) => form.set("expected_revision", "01"), (form: FormData) => form.set("expected_revision", "9007199254740992"),
    (form: FormData) => form.set("file", "not file"), (form: FormData) => form.delete("file"),
    (form: FormData) => form.set("dialect", JSON.stringify({ ...dialect, encoding: "gbk" })),
    (form: FormData) => form.set("dialect", '{"encoding":"utf-8","delimiter":",","delimiter":";","record_separator":"lf"}'),
    (form: FormData) => form.set("values", '{"column":"Code","column":"Note","trim":false,"offset":0,"limit":1}'),
    (form: FormData) => { form.set("dialect", "auto"); form.set("values", JSON.stringify({ column: "Code", trim: false, offset: 0, limit: 1 })); },
  ]) { const form = inspectionForm(); change(form); await assert.rejects(readCsvInspectionUpload(request(form))); }
  for (const patch of [{ limit: 101 }, { limit: 0 }, { limit: 0.1 }, { offset: -1 }, { offset: "1" }, { trim: "false" }, { ignored: true }]) {
    const form = inspectionForm(); form.set("values", JSON.stringify({ column: "Code", trim: false, offset: 0, limit: 10, ...patch }));
    await assert.rejects(readCsvInspectionUpload(request(form)), /CSV_INSPECTION_FIELDS_INVALID/);
  }
  const twice = inspectionForm(); twice.append("values", "{}"); twice.append("values", "{}");
  await assert.rejects(readCsvInspectionUpload(request(twice)), /CSV_INSPECTION_FIELDS_INVALID/);
});

test("inspection upload rejects non-UTF8, empty/oversized files, content encoding and unbounded streams before parsing", async () => {
  await assert.rejects(readCsvInspectionUpload(request(inspectionForm(Buffer.from([0xff])))), /INVALID_UTF8/);
  await assert.rejects(readCsvInspectionUpload(request(inspectionForm(Buffer.alloc(0)))), /CSV_EMPTY/);
  await assert.rejects(readCsvInspectionUpload(request(inspectionForm(Buffer.alloc(4 * 1024 * 1024 + 1, 65)))), /CSV_TOO_LARGE/);
  await assert.rejects(readCsvInspectionUpload(new Request("https://fixture.invalid", { method: "POST", headers: { "Content-Type": "text/csv" }, body: "Code\n1" })), /CSV_MULTIPART_REQUIRED/);
  const encoded = request(inspectionForm()); encoded.headers.set("Content-Encoding", "gzip");
  await assert.rejects(readCsvInspectionUpload(encoded), /CSV_MULTIPART_REQUIRED/);
  const oversized = request(inspectionForm()); oversized.headers.set("Content-Length", "999999999");
  await assert.rejects(readCsvInspectionUpload(oversized), /REQUEST_TOO_LARGE/); assert.equal(oversized.bodyUsed, false);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } });
  const req = new Request("https://fixture.invalid", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" }, body: stream, duplex: "half" } as RequestInit);
  await assert.rejects(readCsvInspectionUpload(req), /REQUEST_TOO_LARGE/); assert.equal(cancelled, true); assert.equal(req.body!.locked, false);
});
