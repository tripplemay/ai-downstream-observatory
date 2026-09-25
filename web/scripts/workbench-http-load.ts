export interface HttpLoadRuntime {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}
export interface HttpLoadTarget { method: string; url: string }
export interface HttpLoadError { code: string; message?: string }
export interface HttpLoadOperationResult {
  ok: boolean;
  http: HttpLoadTarget & { status: number | null; timings?: { started_ms: number; headers_ms: number | null; completed_ms: number } };
  error?: HttpLoadError;
}
export interface HttpLoadContext {
  signal: AbortSignal; sampleId: string; classId: string; index: number;
  scheduledMs: number; dispatchedMs: number; nowMs(): number;
}
export interface HttpLoadClass {
  id: string; count: number; intervalMs: number; maxInFlight: number; maxQueued: number;
  queueTimeoutMs: number; requestTimeoutMs: number; target?: HttpLoadTarget;
  operation(context: HttpLoadContext): HttpLoadOperationResult | PromiseLike<HttpLoadOperationResult>;
}
export type HttpLoadStatus = "success" | "error" | "queue_full" | "queue_deadline" | "request_timeout" | "overall_deadline" | "drain_deadline" | "aborted";
export interface HttpLoadSample {
  sample_id: string; class_id: string; index: number; target: HttpLoadTarget | null;
  scheduled_ms: number; dispatched_ms: number | null; completed_ms: number;
  queue_ms: number | null; wall_ms: number | null; status: HttpLoadStatus; error: HttpLoadError | null;
  result: HttpLoadOperationResult | null;
}
export interface HttpLoadDistribution { count: number; p50_ms: number | null; p95_ms: number | null; p99_ms: number | null; max_ms: number | null }
interface Latencies { queue_ms: HttpLoadDistribution; wall_ms: HttpLoadDistribution; http_ms: HttpLoadDistribution }
export interface HttpLoadSubsetSummary {
  sample_count: number; target: number | null; dispatched: number; succeeded: number; failed: number;
  shortfall: { dispatched: number; successful: number } | null;
  statuses: Partial<Record<HttpLoadStatus, number>>; success: Latencies; failure: Latencies;
}
export interface HttpLoadClassSummary {
  planned: number; dispatched: number; succeeded: number; failed: number; unsettled_at_return: number;
  shortfall: { dispatched: number; successful: number };
  statuses: Partial<Record<HttpLoadStatus, number>>;
  success: Latencies; failure: Latencies;
}
export interface HttpLoadReport {
  schema_version: "workbench-http-load-v1"; arrival_model: "independent_fixed_schedule";
  finish_reason: "completed" | "overall_deadline" | "drain_deadline" | "aborted";
  deadline_ms: number; finished_ms: number; samples: HttpLoadSample[];
  classes: Record<string, HttpLoadClassSummary>;
}
export interface HttpLoadOptions {
  classes: readonly HttpLoadClass[]; overallTimeoutMs: number; drainTimeoutMs: number;
  runtime?: HttpLoadRuntime; signal?: AbortSignal;
}

const runtimeDefault: HttpLoadRuntime = {
  now: () => performance.now(), setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
function target(value: unknown): value is HttpLoadTarget {
  if (!object(value) || typeof value.method !== "string" || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(value.method)
    || typeof value.url !== "string" || value.url.length > 2048 || !/^\/(?!\/)/.test(value.url) || /[\x00-\x20\x7f?#\\]/.test(value.url)) return false;
  return true;
}
function errorValue(value: unknown): value is HttpLoadError {
  return object(value) && keys(value, ["code", "message"]) && typeof value.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value.code)
    && (value.message === undefined || (typeof value.message === "string" && value.message.length <= 1024));
}
function resultValue(value: unknown, sample: Pending, now: number): HttpLoadOperationResult {
  if (!object(value) || !keys(value, ["ok", "http", "error"]) || typeof value.ok !== "boolean" || !object(value.http)
    || !keys(value.http, ["method", "url", "status", "timings"]) || !target(value.http)
    || !(value.http.status === null || (Number.isInteger(value.http.status) && Number(value.http.status) >= 100 && Number(value.http.status) <= 599))
    || (value.ok && (value.http.status === null || Number(value.http.status) < 200 || Number(value.http.status) >= 300 || value.error !== undefined))
    || (!value.ok && !errorValue(value.error))) throw new Error("RESULT_INVALID");
  if (sample.state.config.target && (value.http.method !== sample.state.config.target.method || value.http.url !== sample.state.config.target.url)) throw new Error("RESULT_INVALID");
  const timing = value.http.timings;
  if (timing !== undefined && (!object(timing) || !keys(timing, ["started_ms", "headers_ms", "completed_ms"])
    || !finite(timing.started_ms) || !finite(timing.completed_ms) || timing.started_ms < sample.dispatched!
    || timing.completed_ms < timing.started_ms || timing.completed_ms > now
    || !(timing.headers_ms === null || (finite(timing.headers_ms) && timing.headers_ms >= timing.started_ms && timing.headers_ms <= timing.completed_ms)))) throw new Error("RESULT_INVALID");
  return { ok: value.ok, http: { method: value.http.method, url: value.http.url, status: value.http.status as number | null,
    ...(timing === undefined ? {} : { timings: { ...(timing as NonNullable<HttpLoadOperationResult["http"]["timings"]>) } }) },
    ...(value.error === undefined ? {} : { error: { ...(value.error as HttpLoadError) } }) };
}
function distribution(values: (number | null)[]): HttpLoadDistribution {
  const ordered = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  const percentile = (p: number) => ordered.length ? ordered[Math.ceil(ordered.length * p) - 1] : null;
  return { count: ordered.length, p50_ms: percentile(.5), p95_ms: percentile(.95), p99_ms: percentile(.99), max_ms: ordered.at(-1) ?? null };
}
/** A caller-defined cold/warm/overlap subset has no implied minimum sample target. */
export function summarizeHttpLoadSamples(samples: readonly HttpLoadSample[], target: number | null = null): HttpLoadSubsetSummary {
  if (target !== null && (!Number.isSafeInteger(target) || target < 0)) throw new Error("HTTP_LOAD_TARGET_INVALID");
  const passed = samples.filter(sample => sample.status === "success"), failed = samples.filter(sample => sample.status !== "success");
  const latency = (group: readonly HttpLoadSample[]): Latencies => ({ queue_ms: distribution(group.map(row => row.queue_ms)), wall_ms: distribution(group.map(row => row.wall_ms)),
    http_ms: distribution(group.map(row => row.result?.http.timings ? row.result.http.timings.completed_ms - row.result.http.timings.started_ms : null)) });
  const dispatched = samples.filter(sample => sample.dispatched_ms !== null).length;
  return { sample_count: samples.length, target, dispatched, succeeded: passed.length, failed: failed.length,
    shortfall: target === null ? null : { dispatched: Math.max(0, target - dispatched), successful: Math.max(0, target - passed.length) },
    statuses: samples.reduce<Partial<Record<HttpLoadStatus, number>>>((value, sample) => { value[sample.status] = (value[sample.status] ?? 0) + 1; return value; }, {}),
    success: latency(passed), failure: latency(failed) };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
interface ClassState { config: HttpLoadClass; queue: Pending[]; head: number; active: Set<Pending> }
interface Pending { state: ClassState; id: string; index: number; scheduled: number; dispatched: number | null; arrived: boolean; controller?: AbortController; deadline?: number; final?: HttpLoadSample }

/** Fixed arrivals, no retries, and bounded return even when operations ignore abort. */
export function runHttpLoad(options: HttpLoadOptions): Promise<HttpLoadReport> {
  const duration = (value: number) => finite(value) && value > 0 && value <= 3600000;
  if (!Array.isArray(options.classes) || options.classes.length > 32 || !duration(options.overallTimeoutMs) || !duration(options.drainTimeoutMs)) throw new Error("HTTP_LOAD_CONFIG_INVALID");
  const ids = new Set<string>(); let count = 0;
  const states: ClassState[] = options.classes.map(config => {
    if (!config || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(config.id) || ids.has(config.id)
      || !Number.isSafeInteger(config.count) || config.count < 0 || config.count > 100000
      || !finite(config.intervalMs) || config.intervalMs > 3600000 || !Number.isSafeInteger(config.maxInFlight) || config.maxInFlight < 1 || config.maxInFlight > 10000
      || !Number.isSafeInteger(config.maxQueued) || config.maxQueued < 0 || config.maxQueued > 100000
      || !duration(config.queueTimeoutMs) || !duration(config.requestTimeoutMs) || typeof config.operation !== "function"
      || (config.target !== undefined && (!target(config.target) || !keys(config.target as unknown as Record<string, unknown>, ["method", "url"])))) throw new Error("HTTP_LOAD_CONFIG_INVALID");
    ids.add(config.id); count += config.count;
    return { config: { ...config, ...(config.target ? { target: { ...config.target } } : {}) }, queue: [], head: 0, active: new Set() };
  });
  if (count > 100000) throw new Error("HTTP_LOAD_CONFIG_INVALID");
  const runtime = options.runtime ?? runtimeDefault, origin = runtime.now();
  if (!finite(origin)) throw new Error("HTTP_LOAD_CLOCK_INVALID");
  let last = 0;
  const now = () => {
    const value = runtime.now() - origin;
    if (!finite(value) || value < last) throw new Error("HTTP_LOAD_CLOCK_INVALID");
    last = value; return value;
  };
  const samples: Pending[] = states.flatMap(state => Array.from({ length: state.config.count }, (_, index) => ({ state, id: `${state.config.id}:${index}`, index,
    scheduled: index * state.config.intervalMs, dispatched: null, arrived: false })));
  const arrivals = [...samples].sort((a, b) => a.scheduled - b.scheduled || (a.state.config.id < b.state.config.id ? -1 : a.state.config.id > b.state.config.id ? 1 : 0) || a.index - b.index);
  const lastArrival = arrivals.at(-1)?.scheduled ?? 0, drainDeadline = lastArrival + options.drainTimeoutMs;
  const deadline = Math.min(options.overallTimeoutMs, drainDeadline);
  const deadlineReason = options.overallTimeoutMs <= drainDeadline ? "overall_deadline" : "drain_deadline";
  return new Promise(resolve => {
    let cursor = 0, timer: unknown, timerSet = false, sealed = false, pumping = false, repump = false;
    const clearTimer = () => { if (timerSet) runtime.clearTimer(timer); timerSet = false; };
    const finalize = (sample: Pending, status: HttpLoadStatus, at: number, error: HttpLoadError | null = null, result: HttpLoadOperationResult | null = null) => {
      if (sample.final || sealed) return;
      sample.final = freeze({ sample_id: sample.id, class_id: sample.state.config.id, index: sample.index, target: sample.state.config.target ?? null,
        scheduled_ms: sample.scheduled, dispatched_ms: sample.dispatched, completed_ms: at,
        queue_ms: sample.dispatched === null ? (sample.arrived ? at - sample.scheduled : null) : sample.dispatched - sample.scheduled,
        wall_ms: sample.dispatched === null ? null : at - sample.dispatched, status, error, result });
    };
    const finish = (reason: HttpLoadReport["finish_reason"], at: number) => {
      if (sealed) return;
      for (const sample of samples) if (!sample.final) {
        const timeout = reason !== "aborted" && sample.dispatched !== null && sample.deadline! < deadline && at >= sample.deadline!;
        const queueExpired = reason !== "aborted" && sample.dispatched === null && sample.arrived
          && sample.scheduled + sample.state.config.queueTimeoutMs < deadline && at >= sample.scheduled + sample.state.config.queueTimeoutMs;
        const status = timeout ? "request_timeout" : queueExpired ? "queue_deadline" : reason === "completed" ? "error" : reason;
        finalize(sample, status, at, { code: status.toUpperCase() });
      }
      sealed = true; clearTimer(); options.signal?.removeEventListener("abort", abort);
      for (const state of states) for (const sample of state.active) sample.controller!.abort();
      const rows = samples.map(sample => sample.final!);
      const summaries = Object.fromEntries(states.map(state => {
        const selected = rows.filter(sample => sample.class_id === state.config.id), summary = summarizeHttpLoadSamples(selected, state.config.count);
        return [state.config.id, { planned: selected.length, dispatched: summary.dispatched, succeeded: summary.succeeded, failed: summary.failed, unsettled_at_return: state.active.size,
          shortfall: summary.shortfall!, statuses: summary.statuses, success: summary.success, failure: summary.failure } satisfies HttpLoadClassSummary];
      }));
      resolve(freeze({ schema_version: "workbench-http-load-v1", arrival_model: "independent_fixed_schedule", finish_reason: reason,
        deadline_ms: deadline, finished_ms: at, samples: rows, classes: summaries }));
    };
    const abort = () => finish("aborted", now());
    const settle = (sample: Pending, value: unknown, rejected: boolean) => {
      if (sealed) return;
      const at = now(); sample.state.active.delete(sample);
      if (at >= deadline) { finish(deadlineReason, at); return; }
      if (!sample.final) {
        if (at >= sample.deadline!) { finalize(sample, "request_timeout", at, { code: "REQUEST_TIMEOUT" }); sample.controller!.abort(); }
        else if (rejected) finalize(sample, "error", at, { code: "OPERATION_REJECTED", message: (value instanceof Error ? value.message : typeof value === "string" ? value : "Non-Error rejection").slice(0, 1024) });
        else {
          try { const result = resultValue(value, sample, at); finalize(sample, result.ok ? "success" : "error", at, result.error ?? null, result); }
          catch { finalize(sample, "error", at, { code: "RESULT_INVALID" }); }
        }
      }
      pump();
    };
    const dispatch = (sample: Pending) => {
      const at = now();
      if (at >= deadline) { finish(deadlineReason, at); return; }
      if (at >= sample.scheduled + sample.state.config.queueTimeoutMs) { finalize(sample, "queue_deadline", at, { code: "QUEUE_DEADLINE" }); return; }
      sample.dispatched = at; sample.controller = new AbortController(); sample.deadline = at + sample.state.config.requestTimeoutMs; sample.state.active.add(sample);
      try {
        const operation = sample.state.config.operation({ signal: sample.controller.signal, sampleId: sample.id, classId: sample.state.config.id,
          index: sample.index, scheduledMs: sample.scheduled, dispatchedMs: at, nowMs: now });
        void Promise.resolve(operation).then(value => settle(sample, value, false), error => settle(sample, error, true));
      } catch (error) { settle(sample, error, true); }
    };
    const drain = (state: ClassState) => {
      while (!sealed && state.head < state.queue.length) {
        const sample = state.queue[state.head], at = now();
        if (at >= deadline) { finish(deadlineReason, at); return; }
        if (at >= sample.scheduled + state.config.queueTimeoutMs) { state.head++; finalize(sample, "queue_deadline", at, { code: "QUEUE_DEADLINE" }); }
        else if (state.active.size < state.config.maxInFlight) { state.head++; dispatch(sample); }
        else break;
      }
    };
    const pump = () => {
      if (sealed) return;
      if (pumping) { repump = true; return; }
      pumping = true; clearTimer();
      try {
        do {
          repump = false;
          let at = now();
          if (at >= deadline) { finish(deadlineReason, at); return; }
          for (const state of states) {
            for (const sample of state.active) if (!sample.final && at >= sample.deadline!) {
              finalize(sample, "request_timeout", at, { code: "REQUEST_TIMEOUT" }); sample.controller!.abort();
            }
            drain(state);
          }
          while (!sealed && cursor < arrivals.length && arrivals[cursor].scheduled <= (at = now())) {
            if (at >= deadline) { finish(deadlineReason, at); return; }
            const sample = arrivals[cursor++], state = sample.state; sample.arrived = true;
            if (at >= sample.scheduled + state.config.queueTimeoutMs) finalize(sample, "queue_deadline", at, { code: "QUEUE_DEADLINE" });
            else if (state.active.size < state.config.maxInFlight && state.head === state.queue.length) dispatch(sample);
            else if (state.queue.length - state.head < state.config.maxQueued) state.queue.push(sample);
            else finalize(sample, "queue_full", at, { code: "QUEUE_FULL" });
          }
          if (sealed) return;
          if (cursor === arrivals.length && states.every(state => state.head === state.queue.length && state.active.size === 0)) { finish("completed", now()); return; }
        } while (repump);
        let due = deadline;
        if (cursor < arrivals.length) due = Math.min(due, arrivals[cursor].scheduled);
        for (const state of states) {
          if (state.head < state.queue.length) due = Math.min(due, state.queue[state.head].scheduled + state.config.queueTimeoutMs);
          for (const sample of state.active) if (!sample.final) due = Math.min(due, sample.deadline!);
        }
        timer = runtime.setTimer(pump, Math.max(0, due - now())); timerSet = true;
      } finally { pumping = false; }
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort(); else pump();
  });
}
