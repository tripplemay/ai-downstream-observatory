import assert from "node:assert/strict";
import test from "node:test";
import { parseCatalogQuery, readCatalogRequest } from "../src/server/catalog/http-input";

const request = (body: BodyInit, headers: Record<string, string> = {}) => new Request("https://fixture.test/api/workbench/catalog", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body,
});
test("catalog HTTP rejects duplicate JSON keys, excessive nesting and malformed UTF8", async () => {
  assert.deepEqual(await readCatalogRequest(request('{"action":"add_entry","command":{}}')), { action: "add_entry", command: {} });
  for (const raw of ['{"action":"add_entry","action":"compare","command":{}}', '{"action":"store_source","command":{"document":{"a":1,"a":2}}}', '['.repeat(65) + '0' + ']'.repeat(65)]) {
    await assert.rejects(readCatalogRequest(request(raw)), /INVALID_JSON/);
  }
  await assert.rejects(readCatalogRequest(request(Buffer.from([0xff]))), /INVALID_UTF8/);
  await assert.rejects(readCatalogRequest(request('{}', { "Content-Type": "text/plain" })), /JSON_REQUIRED/);
});
test("catalog HTTP bounds streaming requests even with no content length", async () => {
  await assert.rejects(readCatalogRequest(request('{}', { "Content-Length": "2097153" })), /REQUEST_TOO_LARGE/);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } });
  const input = new Request("https://fixture.test", { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
  await assert.rejects(readCatalogRequest(input), /REQUEST_TOO_LARGE/); assert.equal(cancelled, true);
});
test("catalog query validates scope, duplicate keys, filters and bounded pagination", () => {
  const parse = (q: string) => parseCatalogQuery(`https://fixture.test/api/workbench/catalog?${q}`);
  assert.deepEqual(parse("portfolio=p&market=HK&limit=50"), { portfolio: "p", market: "HK", limit: 50 });
  assert.equal(parse("view=source&portfolio=p&source=s").source, "s");
  for (const q of ["portfolio=p&portfolio=q", "view=source&source=s", "listing=l", "cursor=x", "view=detail&portfolio=p&listing=l&source=s", "view=detail&portfolio=p&listing=l&query=", "limit=51", "limit=01", "market=XX", "actor=owner"]) {
    assert.throws(() => parse(q));
  }
});
