import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as client from "../src/components/workbench/evaluation-client";
import { SESSION_INVALIDATED_EVENT } from "../src/components/session-boundary-state";
import type { EvaluationState } from "../src/server/evaluation/types";

type Tree = { type: unknown; props: Record<string, unknown> };
type Effect = () => void | (() => void);
type Listener = () => void;
function observedQueue<T>() {
  const items: T[] = [], waiters = new Map<number, Array<(value: T) => void>>();
  return { items, push(value: T) { const index = items.length; items.push(value); for (const resolve of waiters.get(index) ?? []) resolve(value); waiters.delete(index); },
    at(index: number): Promise<T> { if (index < items.length) return Promise.resolve(items[index]);
      return new Promise(resolve => { waiters.set(index, [...(waiters.get(index) ?? []), resolve]); }); } };
}
const binding = "a".repeat(64), other = "b".repeat(64);
const initial = (): EvaluationState => ({ schema_version: "monthly-evaluations-v1", portfolios: [{ id: "p", name: "SYNTHETIC PRIVATE PORTFOLIO" }, { id: "p2", name: "Synthetic second" }],
  selected_portfolio_id: "p", ledger_revision: 5, read_only: false, schedules: [], schedules_truncated: false, cycles: [], next_cursor: null, detail: null });
const definition = JSON.stringify({ ...JSON.parse(client.evaluationTemplate()), policy_version_id: "policy", strategy_version_id: "strategy", activation_id: "activation", timezone: "UTC", start_month: "2026-12", end_month: null,
  trigger: { day: 3, hour: 1, minute: 5 }, max_attempts: 1, deadline_seconds: 60,
  targets: { ...JSON.parse(client.evaluationTemplate()).targets, rows: [{ account_id: "account", listing_id: "listing", currency: "CNY", weight: "0.1" }], absolute_tolerance_cny: "1", weight_tolerance: "0.01" } });
const compiled = ts.transpileModule(readFileSync(new URL("../src/components/workbench/evaluation-workspace.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Executes component callbacks/effects with controlled network promises; not a browser layout acceptance test.
function mount(t: { after(callback: () => void): void }, options: { binding?: string; verified?: boolean; delayedHash?: boolean } = {}) {
  class Surface {
    listeners = new Map<string, Set<Listener>>();
    addEventListener(type: string, callback: Listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(callback); }
    removeEventListener(type: string, callback: Listener) { this.listeners.get(type)?.delete(callback); }
    emit(type: string) { for (const callback of this.listeners.get(type) ?? []) callback(); }
  }
  const document = Object.assign(new Surface(), { visibilityState: "visible" }), events: string[] = [];
  const window = Object.assign(new Surface(), { location: { reload() {} }, confirm: () => true,
    dispatchEvent(event: { type: string }) { events.push(event.type); window.emit(event.type); return true; } });
  const network = observedQueue<{ url: string; options?: RequestInit; resolve(response: Response): void; reject(reason: Error): void }>();
  const requests = network.items;
  const hashes = observedQueue<{ actual: Promise<client.EvaluationPending>; release?: (pending: client.EvaluationPending) => void }>();
  const hooks: unknown[] = [], effects: { dependencies: unknown[]; cleanup?: () => void }[] = [], queued: { slot: number; callback: Effect }[] = [];
  let cursor = 0, effectCursor = 0, tree: Tree, rendering = false, render: () => void;
  const context = { verified: options.verified ?? true, sessionBinding: options.binding ?? binding };
  const react = {
    useState(initialValue: unknown) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initialValue === "function" ? initialValue() : initialValue;
      return [hooks[i], (value: unknown) => { const next = typeof value === "function" ? value(hooks[i]) : value; if (Object.is(next, hooks[i])) return; hooks[i] = next; render(); }]; },
    useRef(value: unknown) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: value }; return hooks[i]; },
    useEffect(callback: Effect, dependencies: unknown[]) { const slot = effectCursor++, old = effects[slot];
      if (!old || dependencies.some((value, i) => !Object.is(value, old.dependencies[i]))) { old?.cleanup?.(); effects[slot] = { dependencies }; queued.push({ slot, callback }); } },
  };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const dependencies: Record<string, unknown> = { react, "react/jsx-runtime": { jsx, jsxs: jsx }, "next/link": { default: "link" }, "@/components/ui/button": { Button: "button" },
    "@/components/ui/input": { Input: "input" }, "@/components/session-boundary": { useSessionBoundary: () => context },
    "@/components/session-boundary-state": { SESSION_INVALIDATED_EVENT }, "./evaluation-client": { ...client,
      sealEvaluationAttempt: (pending: client.EvaluationPending) => {
        const actual = client.sealEvaluationAttempt(pending);
        if (options.delayedHash && pending.action === "save_schedule" && pending.expectedDefinitionHash === null)
          return new Promise<client.EvaluationPending>(release => hashes.push({ actual, release }));
        hashes.push({ actual }); return actual;
      } } };
  const module = { exports: {} as { EvaluationWorkspace(props: unknown): Tree } };
  const execute = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { window, document, URLSearchParams, TextDecoder, TextEncoder, crypto, Error,
    CustomEvent: class { constructor(public type: string) {} },
    fetch: (url: string, options?: RequestInit) => new Promise((resolve, reject) => network.push({ url, options, resolve, reject })),
  }) as (require: (id: string) => unknown, module: unknown, exports: unknown) => void;
  execute(id => { assert.ok(id in dependencies, id); return dependencies[id]; }, module, module.exports);
  render = () => {
    if (rendering) return; rendering = true; cursor = 0; effectCursor = 0;
    tree = module.exports.EvaluationWorkspace({ initial: initial(), initialSessionBinding: binding }); rendering = false;
    while (queued.length) { const item = queued.shift()!; const cleanup = item.callback(); if (cleanup) effects[item.slot].cleanup = cleanup; }
  };
  render(); t.after(() => effects.forEach(effect => effect.cleanup?.()));
  const visit = (value: unknown, callback: (node: Tree) => void) => {
    if (Array.isArray(value)) { value.forEach(item => visit(item, callback)); return; }
    if (!value || typeof value !== "object" || !("props" in value)) return;
    const node = value as Tree; callback(node); visit(node.props.children, callback);
  };
  const all = () => { const values: Tree[] = []; visit(tree, node => values.push(node)); return values; };
  const text = (node: Tree = tree): string => {
    const walk = (value: unknown): string => Array.isArray(value) ? value.map(walk).join(" ") : typeof value === "string" || typeof value === "number" ? String(value) : value && typeof value === "object" && "props" in value ? walk((value as Tree).props.children) : "";
    return walk(node);
  };
  const byLabel = (label: string) => { const node = all().find(node => node.props["aria-label"] === label); assert.ok(node, label); return node; };
  const button = (label: string) => { const node = all().find(node => node.type === "button" && text(node) === label); assert.ok(node, label); return node; };
  // Drain controlled response/render work only. Native digest completion is observed separately, never inferred from these turns.
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  const respond = async (index: number, value: unknown, status = 200, raw = false) => { const request = await network.at(index); request.resolve(new Response(raw ? value as string : JSON.stringify(value), { status })); await flush(); };
  const session = async (index: number) => respond(index, { authenticated: true, session_binding: binding });
  const ready = async (value = initial()) => { const start = requests.length - 1; await session(start); await respond(start + 1, value); await session(start + 2); };
  const change = (label: string, value: string | boolean) => (byLabel(label).props.onChange as (event: unknown) => void)({ target: typeof value === "boolean" ? { checked: value } : { value } });
  const click = (label: string) => { const node = button(label); assert.equal(!!node.props.disabled, false, label); (node.props.onClick as () => void)(); };
  const submit = () => { const form = all().find(node => node.type === "form")!; assert.ok(form); (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} }); };
  const fill = () => { change("调度定义原文", definition); change("评估操作理由", "Synthetic explicit decision"); change("确认评估操作", true); };
  return { requests, events, window, document, context, render, text, byLabel, button, change, click, submit, fill, ready, respond, session, flush,
    waitForRequest: network.at, waitForHash: hashes.at,
    releaseHash: async (index = 0) => { const job = await hashes.at(index); assert.ok(job.release); const sealed = await job.actual; job.release(sealed); await flush(); return sealed; },
    reject: async (index: number) => { const request = await network.at(index); request.reject(new Error("Synthetic transport loss")); await flush(); },
    frozenBody: () => all().find(node => node.props.title === "冻结原请求（含原 CAS 与幂等键）")?.props.raw,
    postRequests: () => requests.filter(row => row.options?.method === "POST") };
}

test("mismatched or unverified session only renders a non-sensitive skeleton, never initial directory or draft", t => {
  for (const options of [{ binding: other }, { verified: false }]) {
    const f = mount(t, options); assert.doesNotMatch(f.text(), /SYNTHETIC PRIVATE PORTFOLIO/); assert.equal(f.requests.length, 0);
    assert.match(f.text(), /组合目录、草稿与回执保持隐藏/);
  }
});

test("blur and refresh clear human confirmation; read-only still performs bounded GET without permitting writes", async t => {
  const f = mount(t); await f.ready(); f.fill(); assert.equal(f.byLabel("确认评估操作").props.checked, true);
  f.window.emit("blur"); assert.equal(f.byLabel("确认评估操作").props.checked, false); assert.equal(f.postRequests().length, 0);
  f.click("刷新并重新核对"); await f.ready({ ...initial(), read_only: true });
  assert.match(f.text(), /当前为只读模式/); assert.equal(f.byLabel("确认评估操作").props.disabled, true); assert.equal(f.postRequests().length, 0);
  assert.match(f.requests.find(row => row.url.includes("evaluations?"))!.url, /limit=20/);
});

test("busy lock blocks double submit and hash-await blur prevents sending the frozen command", async t => {
  const f = mount(t, { delayedHash: true }); await f.ready(); f.fill(); f.submit(); f.submit();
  assert.equal(f.requests.length, 4); await f.session(3); f.window.emit("blur"); await f.releaseHash();
  assert.equal(f.postRequests().length, 0); assert.equal(f.byLabel("确认评估操作").props.checked, false);
});

test("four event-loop turns cannot stand in for hashing; request waiters advance only after the controlled seal is released", async t => {
  const f = mount(t, { delayedHash: true }); await f.ready(); f.fill(); f.submit(); await f.session(3);
  const hash = await f.waitForHash(0); await hash.actual;
  let observed = false; const posted = f.waitForRequest(4).then(request => { observed = true; return request; });
  await f.flush(); assert.equal(observed, false); assert.equal(f.requests.length, 4); assert.equal(f.postRequests().length, 0);
  const sealed = await f.releaseHash(); const request = await posted;
  assert.equal(observed, true); assert.equal(request.options?.body, sealed.body); assert.equal(f.postRequests().length, 1);
});

test("POST 401 with malformed body invalidates before JSON parsing and removes financial drafts and frozen payload", async t => {
  const f = mount(t); await f.ready(); f.fill(); f.submit(); await f.session(3);
  await f.waitForRequest(4);
  assert.equal(f.postRequests().length, 1); assert.equal(new Headers(f.postRequests()[0].options?.headers).get("X-Workbench-Session-Binding"), binding);
  await f.respond(4, "not-json", 401, true);
  assert.deepEqual(f.events, [SESSION_INVALIDATED_EVENT]); assert.doesNotMatch(f.text(), /SYNTHETIC PRIVATE PORTFOLIO|Synthetic explicit decision|冻结原请求/);
  assert.match(f.text(), /保持隐藏/);
});

test("GET 401 invalidates immediately but an obsolete generation 401 cannot invalidate a newer scope", async t => {
  const f = mount(t); await f.session(0); await f.respond(1, "bad-json", 401, true);
  assert.deepEqual(f.events, [SESSION_INVALIDATED_EVENT]); assert.doesNotMatch(f.text(), /SYNTHETIC PRIVATE PORTFOLIO/);
  const g = mount(t); await g.session(0); g.window.emit("blur"); g.click("刷新并重新核对");
  await g.respond(1, "bad-json", 401, true); assert.deepEqual(g.events, []); await g.ready(); assert.match(g.text(), /SYNTHETIC PRIVATE PORTFOLIO/);
});

test("lost response then auth 503 hides without deleting exact pending body; manual recovery never automatically POSTs", async t => {
  const f = mount(t); await f.ready(); f.fill(); f.submit(); await f.session(3); const original = (await f.waitForRequest(4)).options!.body;
  await f.reject(4); assert.match(f.text(), /已保留本页的冻结请求/);
  f.click("刷新并重新核对"); await f.respond(5, { error: "AUTH_UNAVAILABLE" }, 503);
  assert.deepEqual(f.events, []); assert.doesNotMatch(f.text(), /SYNTHETIC PRIVATE PORTFOLIO/);
  f.click("重新核对会话（保留未决请求）"); await f.ready(); assert.match(f.text(), /已保留本页的冻结请求/);
  assert.equal(f.postRequests().length, 1); assert.equal(f.byLabel("确认评估操作").props.checked, false);
  f.change("确认评估操作", true); f.submit(); await f.session(9);
  await f.waitForRequest(10);
  assert.equal(f.postRequests().length, 2); assert.equal(f.postRequests()[1].options!.body, original);
});

test("incorrect save receipt hash/version retains frozen attempt and does not display a verified success", async t => {
  for (const defect of ["hash", "version"] as const) {
    const f = mount(t, { delayedHash: true }); await f.ready(); f.fill(); f.submit(); await f.session(3);
    const sealed = await f.releaseHash(), original = (await f.waitForRequest(4)).options!.body;
    await f.respond(4, { schedule_id: "schedule", version_id: "version", version: defect === "version" ? 2 : 1,
      schedule_revision: 1, status: "paused", content_hash: defect === "hash" ? "0".repeat(64) : sealed.expectedDefinitionHash });
    assert.match(f.text(), /EVALUATION_RECEIPT_INVALID/); assert.match(f.text(), /已保留本页的冻结请求/);
    assert.doesNotMatch(f.text(), /服务端已返回并校验本次操作回执/); assert.equal(f.postRequests().length, 1);
    assert.equal(f.frozenBody(), original); assert.equal(f.byLabel("确认评估操作").props.checked, false);
  }
});
