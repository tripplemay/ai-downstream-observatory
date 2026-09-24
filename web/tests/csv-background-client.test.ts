import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { canonical } from "../src/server/ledger/service";
import { queryCsvBackground, type CsvBackgroundQuery } from "../src/server/csv-background/queries";
import { requestCsvBackgroundPreview, requestCsvBackgroundConfirmation } from "../src/server/csv-background/service";
import { rawCsvBackgroundHash } from "../src/server/csv-background/binding";
import { getImportPreview } from "../src/server/ledger/imports";
import { assertCsvBackgroundPage, fetchCsvBackground, prepareCsvBackgroundPreview, prepareCsvBackgroundConfirmation,
  prepareCsvBackgroundCancellation, sendCsvBackground } from "../src/components/workbench/csv-background-client";
import { csvBackgroundQueryFixture } from "./csv-background-query-fixture";

const binding = "b".repeat(64), context = () => ({ sessionBinding: binding, isCurrent: () => true });
function fixture(t: Parameters<typeof csvBackgroundQueryFixture>[0], rows = 3) {
  const f = csvBackgroundQueryFixture(t, rows);
  const page = (query: Omit<CsvBackgroundQuery, "portfolio_id"> = {}) => ({ ...queryCsvBackground(f.db, f.principal, { portfolio_id: f.portfolio, ...query }, f.options), session_binding: binding });
  const summary = (request: string) => { const value = page({ request_id: request }); assert.equal(value.view, "status"); return value.item; };
  return { ...f, page, summary };
}
test("browser validates real queued/status/preview/rows/candidates/receipts without executing GETs", async t => {
  const f = fixture(t), request = f.enqueue();
  for (const query of [{ portfolio_id: f.portfolio }, { portfolio_id: f.portfolio, request_id: request.request_id }])
    await assertCsvBackgroundPage(f.page(query), query, binding);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM job_runs").get() as { n: number }).n, 0);
  f.publish(request.request_id); const expected = f.summary(request.request_id);
  for (const selection of [{ view: "preview" }, { view: "rows", limit: 2 }, { view: "rows", review_only: true, limit: 1 },
    { view: "candidates", row: 3, kind: "exact_prior_rows", limit: 1 }] as const) {
    const query = { portfolio_id: f.portfolio, request_id: request.request_id, ...selection }, page = f.page(query);
    await assertCsvBackgroundPage(page, query, binding, expected);
    if ("next_cursor" in page && page.next_cursor) {
      const nextQuery = { ...query, cursor: page.next_cursor };
      await assertCsvBackgroundPage(f.page(nextQuery), nextQuery, binding, expected);
    }
  }
  const confirm = f.confirm(expected.result!.batch_id); f.publish(confirm.request_id);
  const query = { portfolio_id: f.portfolio, request_id: confirm.request_id, view: "receipts" as const, limit: 2 };
  await assertCsvBackgroundPage(f.page(query), query, binding, f.summary(confirm.request_id));
  const oldQuery = { portfolio_id: f.portfolio, request_id: request.request_id, view: "preview" as const };
  const live = await assertCsvBackgroundPage(f.page(oldQuery), oldQuery, binding, expected);
  assert.equal(live.view, "preview"); assert.equal(live.preview.batch_status, "confirmed"); assert.equal(expected.result!.batch_status, "preview");
});
test("strict browser result proof rejects forged hashes, scopes, extra fields and missing verified context", async t => {
  const f = fixture(t), request = f.enqueue(); f.publish(request.request_id); const expected = f.summary(request.request_id);
  const query = { portfolio_id: f.portfolio, request_id: request.request_id, view: "rows" as const }, page = f.page(query);
  for (const patch of [{ session_binding: "a".repeat(64) }, { portfolio_id: "other" }, { request_id: "other" }, { result_hash: "a".repeat(64) },
    { review_hash: "c".repeat(64) }, { payload_text: "PRIVATE" }, { total: 9 }, { review_only: true }])
    await assert.rejects(assertCsvBackgroundPage({ ...page, ...patch }, query, binding, expected), /RESPONSE_INVALID/);
  await assert.rejects(assertCsvBackgroundPage(page, query, binding), /RESPONSE_INVALID/);
  const statusQuery = { portfolio_id: f.portfolio, request_id: request.request_id };
  const status = f.page(statusQuery); assert.equal(status.view, "status");
  for (const item of [{ ...expected, result_hash: "0".repeat(64) }, { ...expected, result: { ...expected.result!, operation: "confirm" } },
    { ...expected, status: "queued" }, { ...expected, attempts: [] }, { ...expected, expires_at: expected.created_at },
    { ...expected, job: { ...expected.job!, status: "running" } }, { ...expected, attempts: [{ ...expected.attempts[0], finished_at: null }] }])
    await assert.rejects(assertCsvBackgroundPage({ ...status, item }, statusQuery, binding), /RESPONSE_INVALID/);
});
test("invalid mapped rows remain inspectable and formula-like source text is not executed or silently discarded", async t => {
  const f = fixture(t), request = f.enqueue({ bytes: Buffer.from("date,amount,id,note\n2026-01-01,not-a-number,s1,=SYNTHETIC()\n") });
  f.publish(request.request_id); const expected = f.summary(request.request_id);
  assert.equal(expected.result!.batch_status, "invalid");
  for (const view of ["preview", "rows"] as const) {
    const query = { portfolio_id: f.portfolio, request_id: request.request_id, view };
    const page = await assertCsvBackgroundPage(f.page(query), query, binding, expected);
    if (page.view === "rows") { assert.equal(page.items[0].command, null); assert.equal(page.items[0].source.cells[3], "=SYNTHETIC()"); assert.deepEqual(page.items[0].source.formula_columns, [4]); }
  }
});
test("mapped command reasons preserve JSON Schema Unicode codepoint limits without changing human review limits", async t => {
  const f = fixture(t, 1), reason = "\u{1f4c4}".repeat(1001);
  const accepted = f.enqueue({ bytes: Buffer.from(`date,amount,id,note\n2026-01-01,100,s1,${reason}\n`) });
  f.publish(accepted.request_id); const expected = f.summary(accepted.request_id);
  assert.equal(expected.result!.batch_status, "preview");
  const query = { portfolio_id: f.portfolio, request_id: accepted.request_id, view: "rows" as const }, raw = f.page(query);
  assert.equal(raw.view, "rows"); assert.equal(raw.items[0].source.command!.reason, reason);
  await assertCsvBackgroundPage(raw, query, binding, expected);
  const mutated = structuredClone(raw), tooLong = "\u{1f4c4}".repeat(2001);
  mutated.items[0].source.command!.reason = tooLong; mutated.items[0].command!.reason = tooLong;
  await assert.rejects(assertCsvBackgroundPage(mutated, query, binding, expected), /RESPONSE_INVALID/);
});
test("candidate counts, kinds, request rows and cursor continuation cannot silently drift", async t => {
  const f = fixture(t, 5), request = f.enqueue(); f.publish(request.request_id); const expected = f.summary(request.request_id);
  const rowsQuery = { portfolio_id: f.portfolio, request_id: request.request_id, view: "rows" as const };
  const rows = f.page(rowsQuery); assert.equal(rows.view, "rows"); const row = rows.items[4];
  const query = { ...rowsQuery, view: "candidates" as const, row: 5, kind: "exact_prior_rows" as const, limit: 2 };
  const page = f.page(query); assert.equal(page.view, "candidates");
  await assertCsvBackgroundPage(page, query, binding, expected, row);
  for (const patch of [{ total: 99 }, { row: 4 }, { kind: "possible_prior_rows" }, { items: [1, 1] }, { items: [1, 5] }, { items: ["1", "2"] }, { next_cursor: null }])
    await assert.rejects(assertCsvBackgroundPage({ ...page, ...patch }, query, binding, expected, row), /RESPONSE_INVALID/);
  const nextQuery = { ...query, cursor: page.next_cursor! }, tail = f.page(nextQuery); assert.equal(tail.view, "candidates");
  await assertCsvBackgroundPage(tail, nextQuery, binding, expected, row);
  await assert.rejects(assertCsvBackgroundPage({ ...tail, next_cursor: page.next_cursor }, nextQuery, binding, expected, row), /RESPONSE_INVALID/);
  const badScope = Buffer.from(canonical({ scope: "a".repeat(64), after: 3 })).toString("base64url");
  await assert.rejects(assertCsvBackgroundPage({ ...tail, items: [3], next_cursor: badScope }, nextQuery, binding, expected, row), /RESPONSE_INVALID/);
});
test("rows reject reordered/duplicate row numbers, command divergence, unknown private fields and invalid formula coordinates", async t => {
  const f = fixture(t), request = f.enqueue(); f.publish(request.request_id);
  const query = { portfolio_id: f.portfolio, request_id: request.request_id, view: "rows" as const }, page = f.page(query); assert.equal(page.view, "rows");
  const expected = f.summary(request.request_id), first = page.items[0];
  for (const changed of [{ ...first, row: 2 }, { ...first, command: null }, { ...first, command: { ...first.command!, reason: "different" } },
    { ...first, source: { ...first.source, secret: "PRIVATE" } }, { ...first, source: { ...first.source, formula_columns: [0] } },
    { ...first, source: { ...first.source, formula_columns: [first.source.cells.length + 1] } }])
    await assert.rejects(assertCsvBackgroundPage({ ...page, items: [changed, ...page.items.slice(1)] }, query, binding, expected), /RESPONSE_INVALID/);
});
test("a real links-only confirmation need not increment revision", async t => {
  const f = fixture(t, 2), previewRequest = f.enqueue(), previewResult = f.publish(previewRequest.request_id);
  const confirm = f.confirm(previewResult.batch_id); f.publish(confirm.request_id);
  const nextPreview = f.enqueue({ idempotency_key: "second-preview", expected_revision: 2, bytes: Buffer.from(f.input.bytes.toString().replace(/SYNTHETIC row/g, "Reviewed row")) });
  f.publish(nextPreview.request_id); const expected = f.summary(nextPreview.request_id), preview = getImportPreview(f.db, f.actor, f.portfolio, expected.result!.batch_id);
  const payloadText = JSON.stringify({ action: "confirm_import", portfolio_id: f.portfolio, batch_id: expected.result!.batch_id, preview_hash: preview.preview_hash, expected_revision: 2,
    csv_review: { acknowledge_unverified_mapping: true, review_hash: preview.csv!.review_hash, rows: preview.csv!.required_review_rows.map(row => ({ row, action: "link_existing", event_id: preview.csv!.candidates.find(item => item.row === row)!.exact_event_ids[0], reason: "Same source fact" })) } });
  const request = requestCsvBackgroundConfirmation(f.db, f.principal, { portfolio_id: f.portfolio, account_id: f.account, idempotency_key: "second-confirm", payload_text: payloadText, acknowledge_background_execution: true }, f.options);
  f.publish(request.request_id); const result = f.summary(request.request_id); assert.equal(result.result!.confirmed_revision, 2);
  const query = { portfolio_id: f.portfolio, request_id: request.request_id, view: "receipts" as const };
  await assertCsvBackgroundPage(f.page(query), query, binding, result);
});
test("prepared preview freezes raw mapping/file and matches the server hash on identical manual retries", async t => {
  const f = fixture(t), input = { portfolioId: f.portfolio, accountId: f.account, revision: 0, file: new File([new Uint8Array(f.input.bytes)], f.input.filename),
    mapping: ` ${f.input.mapping}\n`, idempotencyKey: "client-preview", acknowledge: true as const };
  const prepared = await prepareCsvBackgroundPreview(input); assert.ok(Object.isFrozen(prepared)); assert.equal(prepared.mapping, input.mapping);
  assert.equal(prepared.contentHash, rawCsvBackgroundHash(f.input.bytes));
  const actual = requestCsvBackgroundPreview(f.db, f.principal, { ...f.input, mapping: input.mapping, idempotency_key: input.idempotencyKey }, f.options);
  assert.equal(prepared.inputHash, actual.input_hash);
  const posted: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    if (url === "/api/auth/session") return Response.json({ authenticated: true, session_binding: binding });
    posted.push(options!); return Response.json({ ...actual, session_binding: binding });
  });
  for (let i = 0; i < 2; i++) assert.deepEqual(await sendCsvBackground(prepared, context()), { ...actual, session_binding: binding });
  assert.equal(posted.length, 2);
  for (const options of posted) {
    assert.equal(options.method, "POST"); const form = await new Request("http://localhost", options).formData();
    assert.equal(form.get("mapping"), input.mapping); assert.equal(form.get("expected_revision"), "0");
    assert.equal(rawCsvBackgroundHash(new Uint8Array(await (form.get("file") as File).arrayBuffer())), prepared.contentHash);
    assert.equal((options.headers as Record<string, string>)["X-CSV-Idempotency-Key"], "client-preview");
  }
});
test("prepared confirmation preserves BOM and whitespace bytes and requires separate human acknowledgement", async t => {
  const f = fixture(t), request = f.enqueue(); f.publish(request.request_id); const expected = f.summary(request.request_id), preview = getImportPreview(f.db, f.actor, f.portfolio, expected.result!.batch_id);
  const raw = "\ufeff " + JSON.stringify({ action: "confirm_import", portfolio_id: f.portfolio, batch_id: expected.result!.batch_id, preview_hash: preview.preview_hash, expected_revision: 0,
    csv_review: { acknowledge_unverified_mapping: true, review_hash: preview.csv!.review_hash, rows: preview.csv!.required_review_rows.map(row => ({ row, action: "record_distinct", reason: "Synthetic review" })) } }) + "\n";
  const input = { portfolioId: f.portfolio, accountId: f.account, idempotencyKey: "client-confirm", payloadText: raw, acknowledge: true as const };
  const prepared = await prepareCsvBackgroundConfirmation(input), actual = requestCsvBackgroundConfirmation(f.db, f.principal,
    { portfolio_id: f.portfolio, account_id: f.account, idempotency_key: input.idempotencyKey, payload_text: raw, acknowledge_background_execution: true }, f.options);
  assert.equal(JSON.parse(prepared.body).command.payload_text, raw); assert.equal(prepared.inputHash, actual.input_hash); assert.ok(Object.isFrozen(prepared));
  await assert.rejects(prepareCsvBackgroundConfirmation({ ...input, acknowledge: false as never }));
  await assert.rejects(prepareCsvBackgroundConfirmation({ ...input, payloadText: raw.replace('"expected_revision":0', '"expected_revision":0,"expected_revision":0') }));
  await assert.rejects(prepareCsvBackgroundPreview({ portfolioId: f.portfolio, accountId: f.account, revision: 0, idempotencyKey: "x", file: new File(["x"], "x.csv"), mapping: f.input.mapping, acknowledge: false as never }));
});
test("scope invalidation during session probe prevents POST, and stale response cannot revive data", async t => {
  let current = true, posts = 0;
  const prepared = prepareCsvBackgroundCancellation({ portfolioId: "p", requestId: "request", reason: "Stop" });
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "/api/auth/session") { current = false; return Response.json({ authenticated: true, session_binding: binding }); }
    posts++; return Response.json({ request_id: "request", status: "cancelled", session_binding: binding });
  });
  await assert.rejects(sendCsvBackground(prepared, { sessionBinding: binding, isCurrent: () => current }), /REQUEST_STALE/); assert.equal(posts, 0);
});
test("accepted POST then failed final session probe remains ambiguous and never auto retries", async t => {
  let calls = 0, posts = 0;
  const prepared = prepareCsvBackgroundCancellation({ portfolioId: "p", requestId: "request", reason: "Stop" });
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "/api/auth/session") return Response.json(++calls === 1 ? { authenticated: true, session_binding: binding } : { error: "UNAUTHENTICATED" }, { status: calls === 1 ? 200 : 401 });
    posts++; return Response.json({ request_id: "request", status: "cancelled", session_binding: binding });
  });
  await assert.rejects(sendCsvBackground(prepared, context()), /UNAUTHENTICATED/); assert.equal(posts, 1); assert.equal(calls, 2);
});
test("bounded strict JSON rejects oversize chunks and duplicate keys; mismatched write receipts never count as success", async t => {
  const prepared = prepareCsvBackgroundCancellation({ portfolioId: "p", requestId: "request", reason: "Stop" });
  let raw = '{"request_id":"request","status":"cancelled","status":"cancelled","session_binding":"' + binding + '"}';
  t.mock.method(globalThis, "fetch", async (url: string) => url === "/api/auth/session" ? Response.json({ authenticated: true, session_binding: binding }) : new Response(raw, { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(sendCsvBackground(prepared, context()), /DUPLICATE_JSON_KEY/);
  raw = JSON.stringify({ request_id: "other", status: "cancelled", session_binding: binding }); await assert.rejects(sendCsvBackground(prepared, context()), /RESPONSE_INVALID/);
  raw = '"' + "x".repeat(4096) + '"'; await assert.rejects(sendCsvBackground(prepared, context()), /RESPONSE_INVALID/);
});
test("invalid UTF-8, oversize response and scope loss reject without awaiting a stalled stream cancellation", async t => {
  const prepared = prepareCsvBackgroundCancellation({ portfolioId: "p", requestId: "request", reason: "Stop" });
  for (const failure of ["encoding", "size", "stale"] as const) {
    let cancelled = false, current = true;
    const mock = t.mock.method(globalThis, "fetch", async (url: string) => {
      if (url === "/api/auth/session") return Response.json({ authenticated: true, session_binding: binding });
      return new Response(new ReadableStream({ pull(controller) {
        if (failure === "stale") current = false;
        controller.enqueue(failure === "encoding" ? new Uint8Array([0xff]) : new Uint8Array(failure === "size" ? 4097 : 1));
      }, cancel() { cancelled = true; return new Promise(() => {}); } }), { headers: { "Content-Type": "application/json" } });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([assert.rejects(sendCsvBackground(prepared, { sessionBinding: binding, isCurrent: () => current })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("stalled cancellation delayed rejection")), 1000); })]);
      assert.equal(cancelled, true);
    } finally { clearTimeout(timer); mock.mock.restore(); }
  }
});
test("GET is session-bound, preserves limited selectors and aborts late page delivery", async t => {
  const f = fixture(t), request = f.enqueue(); f.publish(request.request_id);
  const query = { portfolio_id: f.portfolio, request_id: request.request_id, view: "rows" as const, review_only: true, limit: 1 };
  let probes = 0, current = true; const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    if (url === "/api/auth/session") { probes++; if (probes === 4) current = false; return Response.json({ authenticated: true, session_binding: binding }); }
    urls.push(url); assert.notEqual(options?.method, "POST"); assert.equal((options!.headers as Record<string, string>)["X-Workbench-Session-Binding"], binding);
    return Response.json(f.page(query));
  });
  await fetchCsvBackground(query, { ...context(), expected: f.summary(request.request_id) });
  assert.match(urls[0], /review_only=true/); assert.match(urls[0], /limit=1/);
  await assert.rejects(fetchCsvBackground(query, { sessionBinding: binding, isCurrent: () => current, expected: f.summary(request.request_id) }), /REQUEST_STALE/);
  assert.equal(urls.length, 2);
});

function deadlineClock(t: TestContext) {
  let now = 0, sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
    const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id: number) => { timers.delete(id); });
  return { timers, advance(milliseconds: number, fire = true) {
    now += milliseconds;
    if (fire) for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  } };
}
async function microtasks() { for (let count = 0; count < 40; count++) await Promise.resolve(); }
function abortListeners(t: TestContext, signal: AbortSignal) {
  const listeners = new Set<unknown>(), add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  t.mock.method(signal, "addEventListener", (type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => {
    if (type === "abort") listeners.add(listener); add(type, listener, options);
  });
  t.mock.method(signal, "removeEventListener", (type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) => {
    if (type === "abort") listeners.delete(listener); remove(type, listener, options);
  });
  return listeners;
}
test("one wall-clock budget rejects a never-ending GET stream and cancels it without waiting for transport cooperation", async t => {
  const clock = deadlineClock(t); let requests = 0, cancelled = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "/api/auth/session") return Response.json({ authenticated: true, session_binding: binding });
    requests++;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"schema_version":')); },
      cancel() { cancelled = true; return new Promise(() => {}); } }), { headers: { "Content-Type": "application/json" } });
  });
  const pending = fetchCsvBackground({ portfolio_id: "p" }, context()), rejected = assert.rejects(pending, /CSV_BACKGROUND_REQUEST_TIMEOUT/);
  await microtasks(); assert.equal(requests, 1); assert.equal(clock.timers.size, 1);
  clock.advance(30000); await rejected; await microtasks();
  assert.equal(cancelled, true); assert.equal(clock.timers.size, 0); assert.equal(requests, 1);
});
test("a stuck preflight cannot POST after timeout even when fetch ignores abort and resolves late", async t => {
  const clock = deadlineClock(t); let release!: (value: Response) => void, posts = 0;
  t.mock.method(globalThis, "fetch", (url: string) => {
    if (url === "/api/auth/session") return new Promise<Response>(resolve => { release = resolve; });
    posts++; return Promise.resolve(Response.json({}));
  });
  const prepared = prepareCsvBackgroundCancellation({ portfolioId: "p", requestId: "request", reason: "Stop" });
  const rejected = assert.rejects(sendCsvBackground(prepared, context()), /CSV_BACKGROUND_REQUEST_TIMEOUT/);
  await microtasks(); clock.advance(30000); await rejected;
  release(Response.json({ authenticated: true, session_binding: binding })); await microtasks();
  assert.equal(posts, 0); assert.equal(clock.timers.size, 0);
});
test("accepted POST with a stalled final probe times out on the original budget, preserving the prepared body without retry", async t => {
  const clock = deadlineClock(t); let probes = 0, posts = 0, rejectLate!: (error: Error) => void;
  const prepared = prepareCsvBackgroundCancellation({ portfolioId: "p", requestId: "request", reason: "Exact reason" }), original = prepared.body;
  t.mock.method(globalThis, "fetch", (url: string, options?: RequestInit) => {
    if (url === "/api/auth/session") {
      if (++probes === 2) return new Promise<Response>((_, reject) => { rejectLate = reject; });
      clock.advance(10000, false); return Promise.resolve(Response.json({ authenticated: true, session_binding: binding }));
    }
    posts++; assert.equal(options?.body, original); clock.advance(10000, false);
    return Promise.resolve(Response.json({ request_id: "request", status: "cancelled", session_binding: binding }));
  });
  const rejected = assert.rejects(sendCsvBackground(prepared, context()), /CSV_BACKGROUND_REQUEST_TIMEOUT/);
  await microtasks(); assert.equal(probes, 2); clock.advance(9999); await microtasks(); assert.equal(clock.timers.size, 1);
  clock.advance(1); await rejected; rejectLate(new Error("Late ignored transport rejection")); await microtasks();
  assert.equal(posts, 1); assert.equal(probes, 2); assert.equal(prepared.body, original); assert.equal(clock.timers.size, 0);
});
test("monotonic deadline guards block POST before a delayed timer callback runs", async t => {
  const clock = deadlineClock(t); let posts = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "/api/auth/session") { clock.advance(30001, false); return Response.json({ authenticated: true, session_binding: binding }); }
    posts++; return Response.json({});
  });
  const prepared = prepareCsvBackgroundCancellation({ portfolioId: "p", requestId: "request", reason: "Stop" });
  await assert.rejects(sendCsvBackground(prepared, context()), /CSV_BACKGROUND_REQUEST_TIMEOUT/);
  assert.equal(posts, 0); assert.equal(clock.timers.size, 0);
});
test("proof hashing shares the GET deadline and a late valid digest cannot publish a page or start a final session probe", async t => {
  const f = fixture(t), accepted = f.enqueue(); f.publish(accepted.request_id);
  const query = { portfolio_id: f.portfolio, request_id: accepted.request_id }, page = f.page(query), expected = f.summary(accepted.request_id);
  const clock = deadlineClock(t); let probes = 0, release!: (value: ArrayBuffer) => void, entered!: () => void;
  const hashing = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(crypto.subtle, "digest", () => new Promise<ArrayBuffer>(resolve => { release = resolve; entered(); }));
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "/api/auth/session") { probes++; return Response.json({ authenticated: true, session_binding: binding }); }
    return Response.json(page);
  });
  const rejected = assert.rejects(fetchCsvBackground(query, context()), /CSV_BACKGROUND_REQUEST_TIMEOUT/);
  await hashing; clock.advance(30000); await rejected;
  release(Uint8Array.from(Buffer.from(expected.result_hash!, "hex")).buffer); await microtasks();
  assert.equal(probes, 1); assert.equal(clock.timers.size, 0);
});
test("external abort releases the operation timer and stream listeners even if cancellation never settles", async t => {
  const clock = deadlineClock(t), controller = new AbortController(), external = abortListeners(t, controller.signal);
  let internal: Set<unknown> | undefined, cancelled = false;
  t.mock.method(globalThis, "fetch", async (_url: string, options?: RequestInit) => {
    internal = abortListeners(t, options!.signal!);
    return new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }), { headers: { "Content-Type": "application/json" } });
  });
  const rejected = assert.rejects(fetchCsvBackground({ portfolio_id: "p" }, { ...context(), signal: controller.signal }), /CSV_BACKGROUND_REQUEST_STALE/);
  await microtasks(); assert.equal(external.size, 1); assert.equal(internal?.size, 1);
  controller.abort(); await rejected; await microtasks();
  assert.equal(cancelled, true); assert.equal(clock.timers.size, 0); assert.equal(external.size, 0); assert.equal(internal?.size, 0);
});
test("completed operations remove their timer and external abort listener; rejected response headers cancel unlocked bodies", async t => {
  const clock = deadlineClock(t), controller = new AbortController(), listeners = abortListeners(t, controller.signal);
  const prepared = prepareCsvBackgroundCancellation({ portfolioId: "p", requestId: "request", reason: "Stop" });
  let mode = "ok", cancelled = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "/api/auth/session") return Response.json({ authenticated: true, session_binding: binding });
    if (mode === "ok") return Response.json({ request_id: "request", status: "cancelled", session_binding: binding });
    return new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }), {
      status: mode === "401" ? 401 : 200, headers: mode === "type" ? { "Content-Type": "text/html" } : { "Content-Type": "application/json", "Content-Length": "4097" },
    });
  });
  await sendCsvBackground(prepared, { ...context(), signal: controller.signal });
  assert.equal(clock.timers.size, 0); assert.equal(listeners.size, 0);
  for (mode of ["type", "length", "401"]) {
    await assert.rejects(sendCsvBackground(prepared, { ...context(), signal: controller.signal }), mode === "401" ? /UNAUTHENTICATED/ : /RESPONSE_INVALID/);
    assert.equal(clock.timers.size, 0); assert.equal(listeners.size, 0);
  }
  assert.equal(cancelled, 3);
});
