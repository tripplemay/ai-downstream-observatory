import assert from "node:assert/strict";
import test from "node:test";
import { runHttpLoad, summarizeHttpLoadSamples, type HttpLoadClass, type HttpLoadOperationResult, type HttpLoadRuntime, type HttpLoadSample } from "../scripts/workbench-http-load";

async function microtasks() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
class Clock implements HttpLoadRuntime {
  time = 1000;
  sequence = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimer = (callback: () => void, delayMs: number) => { const id = ++this.sequence; this.timers.set(id, { at: this.time + delayMs, callback }); return id; };
  clearTimer = (handle: unknown) => { this.timers.delete(handle as number); };
  async advance(milliseconds: number) {
    const target = this.time + milliseconds;
    await microtasks();
    for (let iterations = 0; ; iterations++) {
      assert.ok(iterations < 10000, "timer spin");
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > target) break;
      this.time = Math.max(this.time, next[1].at); this.timers.delete(next[0]); next[1].callback(); await microtasks();
    }
    this.time = target; await microtasks();
  }
}
function deferred() {
  let resolve!: (value: HttpLoadOperationResult) => void, reject!: (error: unknown) => void;
  const promise = new Promise<HttpLoadOperationResult>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const ok = (): HttpLoadOperationResult => ({ ok: true, http: { method: "POST", url: "/api/synthetic", status: 201 } });
const config = (patch: Partial<HttpLoadClass> = {}): HttpLoadClass => ({ id: "write", count: 1, intervalMs: 10, maxInFlight: 1, maxQueued: 1,
  queueTimeoutMs: 100, requestTimeoutMs: 100, target: { method: "POST", url: "/api/synthetic" }, operation: ok, ...patch });

test("independent fixed arrivals preserve every scheduled sample and do not shift a fast class behind a slow one", async () => {
  const runtime = new Clock(), blocked = deferred(), dispatched: number[] = [];
  const pending = runHttpLoad({ runtime, overallTimeoutMs: 100, drainTimeoutMs: 10, classes: [
    config({ id: "slow", count: 6, maxQueued: 1, queueTimeoutMs: 25, operation: () => blocked.promise }),
    config({ id: "fast", count: 6, maxQueued: 0, operation: context => { dispatched.push(context.dispatchedMs); return ok(); } }),
  ] });
  await runtime.advance(60); const report = await pending;
  assert.equal(report.finish_reason, "drain_deadline"); assert.equal(report.samples.length, 12);
  assert.deepEqual(dispatched, [0, 10, 20, 30, 40, 50]);
  const slow = report.samples.filter(row => row.class_id === "slow");
  assert.deepEqual(slow.map(row => row.scheduled_ms), [0, 10, 20, 30, 40, 50]);
  assert.deepEqual(slow.map(row => row.status), ["drain_deadline", "queue_deadline", "queue_full", "queue_full", "drain_deadline", "queue_full"]);
  assert.deepEqual(report.classes.slow.shortfall, { dispatched: 5, successful: 6 });
  assert.equal(report.classes.slow.success.wall_ms.count, 0); assert.equal(report.classes.slow.success.wall_ms.max_ms, null);
  assert.equal(report.classes.fast.succeeded, 6); assert.equal(runtime.timers.size, 0);
});

test("expired queued samples are never dispatched even when a slot becomes free at their exact deadline", async () => {
  const runtime = new Clock(), first = deferred(), called: number[] = [];
  const pending = runHttpLoad({ runtime, overallTimeoutMs: 100, drainTimeoutMs: 50, classes: [config({ count: 3, queueTimeoutMs: 10,
    operation: context => { called.push(context.index); return context.index ? ok() : first.promise; } })] });
  await runtime.advance(10); runtime.time += 10; first.resolve(ok()); await microtasks();
  const report = await pending;
  assert.deepEqual(called, [0, 2]); assert.equal(report.samples[1].status, "queue_deadline"); assert.equal(report.samples[1].dispatched_ms, null);
  assert.equal(report.samples[1].queue_ms, 10); assert.equal(report.samples[2].scheduled_ms, 20); assert.equal(report.samples[2].dispatched_ms, 20);
});

test("an abort-ignoring timed out operation keeps its physical slot and late success cannot change the returned report", async () => {
  const runtime = new Clock(), first = deferred(); let calls = 0, signal: AbortSignal | undefined;
  const pending = runHttpLoad({ runtime, overallTimeoutMs: 40, drainTimeoutMs: 100, classes: [config({ count: 3, maxQueued: 2, requestTimeoutMs: 5,
    operation: context => { calls++; signal = context.signal; return first.promise; } })] });
  await runtime.advance(5); assert.equal(signal?.aborted, true); assert.equal(calls, 1);
  await runtime.advance(35); const report = await pending, frozen = JSON.stringify(report);
  assert.equal(report.samples[0].status, "request_timeout"); assert.equal(report.samples[0].completed_ms, 5);
  assert.equal(report.classes.write.dispatched, 1); assert.equal(report.classes.write.unsettled_at_return, 1);
  assert.equal(report.classes.write.failed, 3); assert.equal(report.finish_reason, "overall_deadline");
  first.resolve(ok()); await microtasks(); assert.equal(JSON.stringify(report), frozen); assert.equal(calls, 1);
  assert.ok(Object.isFrozen(report.samples[0])); assert.ok(Object.isFrozen(report.classes.write.failure.wall_ms));
});

test("late settlement before a delayed timer still times out and may only release capacity, never become success", async () => {
  const runtime = new Clock(), first = deferred();
  const pending = runHttpLoad({ runtime, overallTimeoutMs: 30, drainTimeoutMs: 20, classes: [config({ requestTimeoutMs: 5, operation: () => first.promise })] });
  runtime.time += 6; first.resolve(ok()); await microtasks(); const report = await pending;
  assert.equal(report.samples[0].status, "request_timeout"); assert.equal(report.samples[0].wall_ms, 6);
  assert.equal(report.classes.write.succeeded, 0); assert.equal(report.classes.write.unsettled_at_return, 0);
});

test("request timeout remains the final failure when event-loop delay also crosses the overall deadline", async () => {
  const runtime = new Clock(), first = deferred();
  const pending = runHttpLoad({ runtime, overallTimeoutMs: 10, drainTimeoutMs: 30, classes: [config({ requestTimeoutMs: 5, operation: () => first.promise })] });
  runtime.time += 12; first.resolve(ok()); await microtasks(); const report = await pending;
  assert.equal(report.finish_reason, "overall_deadline"); assert.equal(report.samples[0].status, "request_timeout");
  assert.equal(report.samples[0].completed_ms, 12, "observed completion is not fabricated at the nominal timer boundary");
});

test("overall deadline retains future scheduled arrivals as undispatched failures without idle padding", async () => {
  const runtime = new Clock();
  const pending = runHttpLoad({ runtime, overallTimeoutMs: 20, drainTimeoutMs: 100, classes: [config({ count: 3, intervalMs: 100 })] });
  await runtime.advance(20); const report = await pending;
  assert.deepEqual(report.samples.map(row => row.scheduled_ms), [0, 100, 200]);
  assert.deepEqual(report.samples.map(row => row.status), ["success", "overall_deadline", "overall_deadline"]);
  assert.equal(report.samples[1].queue_ms, null); assert.equal(report.samples[1].wall_ms, null);
  assert.deepEqual(report.classes.write.shortfall, { dispatched: 2, successful: 2 });
});

test("full-operation wall and measured HTTP timings remain distinct, with success and error distributions separated", async () => {
  const runtime = new Clock();
  const pending = runHttpLoad({ runtime, overallTimeoutMs: 100, drainTimeoutMs: 50, classes: [config({ count: 2, intervalMs: 20,
    operation: context => new Promise(resolve => runtime.setTimer(() => resolve({ ok: !context.index,
      http: { method: "POST", url: "/api/synthetic", status: context.index ? 503 : 204,
        timings: { started_ms: context.dispatchedMs + 2, headers_ms: context.dispatchedMs + 3, completed_ms: context.nowMs() - 1 } },
      ...(context.index ? { error: { code: "HTTP_503", message: "Synthetic failure" } } : {}) }), 10)) })] });
  await runtime.advance(30); const report = await pending;
  assert.equal(report.classes.write.success.wall_ms.max_ms, 10); assert.equal(report.classes.write.success.http_ms.max_ms, 7);
  assert.equal(report.classes.write.failure.wall_ms.max_ms, 10); assert.equal(report.classes.write.failure.http_ms.max_ms, 7);
  assert.equal(report.samples[1].error?.code, "HTTP_503"); assert.equal(report.samples[1].result?.http.status, 503);
  assert.equal(report.classes.write.succeeded, 1); assert.equal(report.classes.write.failed, 1);
});

test("queue delay does not disappear into successful operation latency", async () => {
  const runtime = new Clock();
  const pending = runHttpLoad({ runtime, overallTimeoutMs: 100, drainTimeoutMs: 80, classes: [config({ count: 3, intervalMs: 0, maxQueued: 2,
    operation: () => new Promise(resolve => runtime.setTimer(() => resolve(ok()), 5)) })] });
  await runtime.advance(15); const report = await pending;
  assert.deepEqual(report.samples.map(row => row.scheduled_ms), [0, 0, 0]);
  assert.deepEqual(report.samples.map(row => row.queue_ms), [0, 5, 10]); assert.deepEqual(report.samples.map(row => row.wall_ms), [5, 5, 5]);
  assert.equal(report.classes.write.success.queue_ms.p95_ms, 10); assert.equal(report.classes.write.success.wall_ms.max_ms, 5);
});

test("invalid results and operation failures are retained without retries or leaking unexpected payload fields", async () => {
  const runtime = new Clock(); let calls = 0;
  const pending = runHttpLoad({ runtime, overallTimeoutMs: 100, drainTimeoutMs: 50, classes: [config({ count: 4, operation: context => {
    calls++;
    if (context.index === 0) throw new Error("Synchronous synthetic failure");
    if (context.index === 1) return Promise.reject(new Error("Asynchronous synthetic failure"));
    if (context.index === 2) return { ...ok(), secret: "must-not-be-retained" } as HttpLoadOperationResult;
    return { ...ok(), http: { ...ok().http, timings: { started_ms: 0, headers_ms: null, completed_ms: 10000 } } };
  } })] });
  await runtime.advance(30); const report = await pending;
  assert.equal(calls, 4); assert.deepEqual(report.samples.map(row => row.error?.code), ["OPERATION_REJECTED", "OPERATION_REJECTED", "RESULT_INVALID", "RESULT_INVALID"]);
  assert.equal(report.classes.write.failed, 4); assert.doesNotMatch(JSON.stringify(report), /must-not-be-retained/);
});

test("aborted runs retain every planned sample and do not dispatch after cancellation", async () => {
  const runtime = new Clock(), controller = new AbortController(), first = deferred(); let calls = 0;
  const pending = runHttpLoad({ runtime, signal: controller.signal, overallTimeoutMs: 100, drainTimeoutMs: 100,
    classes: [config({ count: 3, operation: () => { calls++; return first.promise; } })] });
  await runtime.advance(5); controller.abort(); const report = await pending;
  assert.equal(report.finish_reason, "aborted"); assert.equal(calls, 1); assert.equal(report.samples.length, 3);
  assert.ok(report.samples.every(row => row.status === "aborted")); assert.equal(runtime.timers.size, 0);
  first.reject(new Error("late rejection")); await microtasks(); assert.equal(report.classes.write.failed, 3);
  const cancelled = await runHttpLoad({ runtime, signal: controller.signal, overallTimeoutMs: 100, drainTimeoutMs: 100,
    classes: [config({ operation: () => assert.fail("preaborted must not run") })] });
  assert.equal(cancelled.samples[0].dispatched_ms, null);
});

test("empty classes finish without inventing observations and invalid resource bounds reject before dispatch", async () => {
  const runtime = new Clock();
  const report = await runHttpLoad({ runtime, overallTimeoutMs: 100, drainTimeoutMs: 100, classes: [config({ count: 0 })] });
  assert.deepEqual(report.samples, []); assert.equal(report.classes.write.success.wall_ms.max_ms, null);
  for (const patch of [{ count: -1 }, { intervalMs: NaN }, { maxInFlight: 0 }, { maxQueued: -1 }, { requestTimeoutMs: Infinity },
    { target: { method: "POST", url: "/api/path?token=secret" } }]) {
    assert.throws(() => runHttpLoad({ runtime, overallTimeoutMs: 100, drainTimeoutMs: 100, classes: [config(patch)] }), /HTTP_LOAD_CONFIG_INVALID/);
  }
  assert.throws(() => runHttpLoad({ runtime, overallTimeoutMs: 100, drainTimeoutMs: 100, classes: [config(), config()] }), /HTTP_LOAD_CONFIG_INVALID/);
});

test("default monotonic timers return despite an operation that ignores AbortSignal", { timeout: 2000 }, async () => {
  const report = await runHttpLoad({ overallTimeoutMs: 50, drainTimeoutMs: 10, classes: [config({ operation: () => new Promise(() => {}) })] });
  assert.equal(report.finish_reason, "drain_deadline"); assert.equal(report.samples[0].status, "drain_deadline");
  assert.ok(report.finished_ms >= 10); assert.equal(report.classes.write.unsettled_at_return, 1);
});

test("physical concurrency stays bounded and only actual settlement frees a timed-out slot", async () => {
  const runtime = new Clock(), operations = [deferred(), deferred(), deferred(), deferred()];
  let active = 0, maximum = 0, calls = 0;
  const pending = runHttpLoad({ runtime, overallTimeoutMs: 40, drainTimeoutMs: 30, classes: [config({ count: 4, intervalMs: 0, maxInFlight: 2, maxQueued: 2,
    requestTimeoutMs: 5, operation: context => { calls++; maximum = Math.max(maximum, ++active); return operations[context.index].promise.finally(() => { active--; }); } })] });
  await runtime.advance(5); assert.equal(calls, 2); assert.equal(active, 2);
  operations[0].resolve(ok()); await microtasks(); assert.equal(calls, 3); assert.equal(active, 2);
  operations[1].reject(new Error("late")); await microtasks(); assert.equal(calls, 4); assert.equal(active, 2);
  operations[2].resolve(ok()); operations[3].resolve(ok()); await microtasks();
  const report = await pending;
  assert.equal(maximum, 2); assert.deepEqual(report.samples.map(row => row.status), ["request_timeout", "request_timeout", "success", "success"]);
  assert.equal(report.classes.write.unsettled_at_return, 0);
});

test("caller-defined buckets expose their real count without inventing a per-bucket target or substituting p95 for maximum", () => {
  const rows: HttpLoadSample[] = Array.from({ length: 20 }, (_, index) => ({ sample_id: `read:${index}`, class_id: "read", index, target: null,
    scheduled_ms: index, dispatched_ms: index, completed_ms: index + (index === 19 ? 5001 : 1), queue_ms: 0,
    wall_ms: index === 19 ? 5001 : 1, status: "success", error: null, result: null }));
  const all = summarizeHttpLoadSamples(rows, 1000), warm = summarizeHttpLoadSamples(rows.slice(1));
  assert.equal(all.sample_count, 20); assert.deepEqual(all.shortfall, { dispatched: 980, successful: 980 });
  assert.equal(all.success.wall_ms.p95_ms, 1); assert.equal(all.success.wall_ms.max_ms, 5001);
  assert.equal(warm.sample_count, 19); assert.equal(warm.target, null); assert.equal(warm.shortfall, null);
  const empty = summarizeHttpLoadSamples([]); assert.equal(empty.success.wall_ms.max_ms, null); assert.equal(empty.failure.wall_ms.count, 0);
});

test("claimed success with a non-2xx HTTP response fails closed while explicit HTTP errors remain retained", async () => {
  const runtime = new Clock();
  const pending = runHttpLoad({ runtime, overallTimeoutMs: 100, drainTimeoutMs: 50, classes: [config({ count: 5, operation: context => ({
    ok: context.index < 4, http: { method: "POST", url: "/api/synthetic", status: [199, 301, 401, 503, 503][context.index] },
    ...(context.index === 4 ? { error: { code: "HTTP_503" } } : {}),
  }) })] });
  await runtime.advance(40); const report = await pending;
  assert.equal(report.classes.write.succeeded, 0);
  assert.deepEqual(report.samples.map(row => row.error?.code), ["RESULT_INVALID", "RESULT_INVALID", "RESULT_INVALID", "RESULT_INVALID", "HTTP_503"]);
  assert.equal(report.samples[4].result?.http.status, 503);
});
