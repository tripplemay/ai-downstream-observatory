import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as client from "../src/components/workbench/collection-schedule-client";
import { parseStrictJson } from "../src/server/strict-json";
import { SESSION_INVALIDATED_EVENT } from "../src/components/session-boundary-state";
import type { CollectionScheduleState } from "../src/server/market-schedules/types";

type Tree = { type: unknown; props: Record<string, unknown> };
type Listener = (event: Record<string, unknown>) => void;
type Effect = () => void | (() => void);
function queue<T>() {
  const items: T[] = [], waiting = new Map<number, Array<(value: T) => void>>();
  return { items, push(value: T) { const index = items.length; items.push(value); for (const resolve of waiting.get(index) ?? []) resolve(value); waiting.delete(index); },
    at(index: number): Promise<T> { if (index < items.length) return Promise.resolve(items[index]); return new Promise(resolve => waiting.set(index, [...(waiting.get(index) ?? []), resolve])); } };
}
const binding = "a".repeat(64), otherBinding = "b".repeat(64), at = "2026-09-01T00:00:00.000000Z";
const definition = (currencies = ["CHF"]) => ({ schema_version: "collection-schedule-v1" as const, provider: "ecb" as const, feed: "daily" as const,
  currencies: currencies as Array<"CHF" | "EUR">, frequency: "daily" as const, timezone: "UTC" as const, start_date: "2026-10-01", end_date: null,
  trigger: { hour: 8, minute: 7 }, deadline_seconds: 900, max_attempts: 2, publish: true as const, missed_policy: "record_no_backfill" as const });
const rawDefinition = JSON.stringify(definition(), null, 2).replaceAll("\n", "\r\n") + "\r\n";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
function initial(portfolio = "p"): CollectionScheduleState {
  const existing = definition(["EUR"]), raw = JSON.stringify(existing);
  return { schema_version: "collection-schedules-v1", portfolios: [{ id: "p", name: "SYNTHETIC SCOPE A" }, { id: "p2", name: "SYNTHETIC SCOPE B" }], portfolios_truncated: false,
    selected_portfolio_id: portfolio, read_only: false, server_now: at, schedules: [{ id: `${portfolio}-schedule`, portfolio_id: portfolio,
      scope_key: "provider:ecb:fx:daily:EUR", schedule_revision: 1, status: "paused", current_version: { id: `${portfolio}-v1`, version: 1,
        definition_json: raw, definition: existing, content_hash: hash(raw), created_by: "synthetic-human", created_at: at, audit_id: `${portfolio}-save` },
      last_audit_id: `${portfolio}-save`, updated_at: at, next_trigger_at: null }], schedules_truncated: false, slots: [], next_cursor: null };
}
const compiled = ts.transpileModule(readFileSync(new URL("../src/components/workbench/collection-schedule-workspace.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Invoke the real component effects and callbacks; this is not native browser/BFCache evidence.
function mount(t: { after(callback: () => void): void }, options: { delayedHash?: boolean; verified?: boolean; binding?: string } = {}) {
  class Surface {
    listeners = new Map<string, Set<Listener>>();
    addEventListener(type: string, callback: Listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(callback); }
    removeEventListener(type: string, callback: Listener) { this.listeners.get(type)?.delete(callback); }
    emit(type: string, event: Record<string, unknown> = {}) { for (const callback of this.listeners.get(type) ?? []) callback(event); }
  }
  class Element { closest(_selector: string): Element | null { return null; } }
  class Anchor extends Element {
    href: string; target: string; download = "";
    constructor(href: string, target = "") { super(); this.href = new URL(href, "https://synthetic.invalid/workbench/market/schedules").href; this.target = target; }
    closest(_selector: string) { return this; }
    hasAttribute(name: string) { return name === "download" && this.download !== ""; }
  }
  const document = Object.assign(new Surface(), { visibilityState: "visible" });
  let confirmResult = false;
  const prompts: string[] = [], events: string[] = [];
  const window = Object.assign(new Surface(), { location: new URL("https://synthetic.invalid/workbench/market/schedules"),
    confirm(message: string) { prompts.push(message); return confirmResult; },
    dispatchEvent(event: { type: string }) { events.push(event.type); window.emit(event.type, event); return true; } });
  const network = queue<{ url: string; options?: RequestInit; resolve(response: Response): void; reject(reason: Error): void }>();
  const hashes = queue<{ actual: Promise<client.CollectionPending>; release(pending: client.CollectionPending): void }>();
  const hooks: unknown[] = [], effects: { dependencies: unknown[]; cleanup?: () => void }[] = [], queued: { slot: number; callback: Effect }[] = [];
  let cursor = 0, effectCursor = 0, tree: Tree, rendering = false, render: () => void;
  const context = { verified: options.verified ?? true, sessionBinding: options.binding ?? binding };
  let pageBinding = binding;
  const react = {
    useState(value: unknown) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof value === "function" ? value() : value;
      return [hooks[i], (next: unknown) => { const resolved = typeof next === "function" ? next(hooks[i]) : next; if (Object.is(resolved, hooks[i])) return; hooks[i] = resolved; render(); }]; },
    useRef(value: unknown) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: value }; return hooks[i]; },
    useEffect(callback: Effect, dependencies: unknown[]) { const slot = effectCursor++, old = effects[slot];
      if (!old || dependencies.some((value, i) => !Object.is(value, old.dependencies[i]))) { old?.cleanup?.(); effects[slot] = { dependencies }; queued.push({ slot, callback }); } },
  };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const dependencies: Record<string, unknown> = { react, "react/jsx-runtime": { jsx, jsxs: jsx }, "next/link": { default: "link" },
    "@/components/session-boundary": { useSessionBoundary: () => context }, "@/components/session-boundary-state": { SESSION_INVALIDATED_EVENT },
    "@/server/strict-json": { parseStrictJson },
    "./collection-schedule-client": { ...client, prepareCollectionAttempt: (...args: Parameters<typeof client.prepareCollectionAttempt>) => {
      const actual = client.prepareCollectionAttempt(...args);
      return options.delayedHash ? new Promise<client.CollectionPending>(release => hashes.push({ actual, release })) : actual;
    } } };
  const module = { exports: {} as { CollectionScheduleWorkspace(props: unknown): Tree } };
  const execute = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { window, document, URL, URLSearchParams, Element, HTMLAnchorElement: Anchor,
    TextEncoder, TextDecoder, crypto, Error, CustomEvent: class { constructor(public type: string) {} },
    fetch: (url: string, options?: RequestInit) => new Promise((resolve, reject) => network.push({ url, options, resolve, reject })),
  }) as (require: (id: string) => unknown, module: unknown, exports: unknown) => void;
  execute(id => { assert.ok(id in dependencies, id); return dependencies[id]; }, module, module.exports);
  render = () => {
    if (rendering) return; rendering = true; cursor = 0; effectCursor = 0;
    tree = module.exports.CollectionScheduleWorkspace({ initialSessionBinding: pageBinding }); rendering = false;
    while (queued.length) { const item = queued.shift()!; const cleanup = item.callback(); if (cleanup) effects[item.slot].cleanup = cleanup; }
  };
  render(); t.after(() => effects.forEach(effect => effect.cleanup?.()));
  const all = () => { const result: Tree[] = []; const walk = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object" || !("props" in value)) return;
    const node = value as Tree; result.push(node); walk(node.props.children);
  }; walk(tree); return result; };
  const text = (node: Tree = tree): string => { const walk = (value: unknown): string => Array.isArray(value) ? value.map(walk).join(" ") : typeof value === "string" || typeof value === "number" ? String(value) : value && typeof value === "object" && "props" in value ? walk((value as Tree).props.children) : ""; return walk(node); };
  const control = (type: string, predicate: (node: Tree) => boolean = () => true) => { const found = all().find(node => node.type === type && predicate(node)); assert.ok(found, type); return found; };
  const named = (type: string, label: string) => control(type, node => node.props["aria-label"] === label);
  const checkbox = () => control("input", node => node.props.type === "checkbox");
  const change = (node: Tree, value: string | boolean) => (node.props.onChange as (event: unknown) => void)({ target: typeof value === "boolean" ? { checked: value } : { value } });
  const click = (label: string) => { const node = control("button", row => text(row) === label); assert.equal(!!node.props.disabled, false); (node.props.onClick as () => void)(); };
  const submit = () => (control("form").props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  const fill = (reason = "SYNTHETIC PRIVATE CONTROL REASON") => { change(named("textarea", "采集调度定义"), rawDefinition); change(named("input", "采集调度理由"), reason); change(checkbox(), true); };
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  const respond = async (index: number, body: unknown, status = 200, raw = false) => { (await network.at(index)).resolve(new Response(raw ? body as string : JSON.stringify(body), { status })); await flush(); };
  const session = (index: number, value = binding) => respond(index, { authenticated: true, session_binding: value });
  const load = async (start: number, value = initial()) => { await session(start); await respond(start + 1, { ...value, session_binding: binding }); await session(start + 2); };
  const ready = async (value = initial()) => { const start = network.items.length - 1; await load(start, value); if (network.items.length === start + 4) await load(start + 3, value); };
  const beforeUnload = () => { const event = { defaultPrevented: false, returnValue: undefined as unknown, preventDefault() { this.defaultPrevented = true; } }; window.emit("beforeunload", event); return event; };
  const navigate = (href: string, target = "", extra: Record<string, unknown> = {}) => {
    const anchor = new Anchor(href, target); if (extra.download === true) anchor.download = "synthetic-evidence.json";
    const event = { target: anchor, button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    document.emit("click", event); return event;
  };
  return { context, document, window, events, prompts, all, control, named, checkbox, change, click, submit, fill, text, ready, load, respond, session, flush, render,
    requests: network.items, waitForRequest: network.at, waitForHash: hashes.at, beforeUnload, navigate,
    setConfirm(value: boolean) { confirmResult = value; }, setPageBinding(value: string) { pageBinding = value; render(); },
    postRequests: () => network.items.filter(item => item.options?.method === "POST"),
    async reject(index: number) { (await network.at(index)).reject(new Error("Synthetic network loss")); await flush(); },
    async releaseHash(index = 0) { const item = await hashes.at(index), result = await item.actual; item.release(result); await flush(); return result; } };
}

test("unverified session reveals no directory; verified new schedule has blank explicit inputs and no automatic writes", async t => {
  for (const options of [{ verified: false }, { binding: otherBinding }]) {
    const f = mount(t, options); assert.doesNotMatch(f.text(), /SYNTHETIC SCOPE/); assert.equal(f.requests.length, 0);
  }
  const f = mount(t); await f.ready();
  assert.equal(f.named("textarea", "采集调度定义").props.value, "");
  assert.equal(f.named("input", "采集调度理由").props.value, "");
  assert.equal(f.named("select", "目标采集调度").props.value, "");
  assert.equal(f.checkbox().props.checked, false); assert.equal(f.postRequests().length, 0);
  assert.match(f.text(), /没有默认证券、币种或触发时间/); assert.match(f.text(), /不是执行换汇价、交易、策略准入或投资批准/);
});

test("hash completion cannot POST after blur, hidden document, SID mismatch or scope A-B-A", async t => {
  for (const reason of ["blur", "hidden", "sid", "scope"] as const) {
    const f = mount(t, { delayedHash: true }); await f.ready(); f.fill(); const start = f.requests.length;
    f.submit(); f.submit(); await f.session(start); await (await f.waitForHash(0)).actual;
    assert.equal(f.postRequests().length, 0); assert.equal(f.beforeUnload().defaultPrevented, true);
    if (reason === "blur") f.window.emit("blur");
    if (reason === "hidden") { f.document.visibilityState = "hidden"; f.document.emit("visibilitychange"); }
    if (reason === "sid") { f.context.sessionBinding = otherBinding; f.render(); }
    if (reason === "scope") { const old = f.named("select", "采集调度组合"); f.change(old, "p2"); f.change(old, "p"); }
    await f.releaseHash(); assert.equal(f.postRequests().length, 0, reason); assert.doesNotMatch(f.text(), /SYNTHETIC SCOPE|PRIVATE CONTROL/);
  }
});

test("save requires acknowledgement and nonempty reason; editing revokes acknowledgement", async t => {
  const f = mount(t); await f.ready();
  f.fill(); f.change(f.named("input", "采集调度理由"), "Changed synthetic reason");
  assert.equal(f.checkbox().props.checked, false); const before = f.requests.length; f.submit(); assert.equal(f.requests.length, before);
  f.change(f.named("input", "采集调度理由"), "   "); f.change(f.checkbox(), true); f.submit(); await f.session(before); await f.flush();
  assert.equal(f.postRequests().length, 0); assert.match(f.text(), /COLLECTION_REASON_REQUIRED/);
});

test("lost save response preserves exact raw JSON, null identity, CAS and idempotency across same-SID refresh", async t => {
  const f = mount(t); await f.ready(); f.fill(); const start = f.requests.length; f.submit(); await f.session(start);
  const first = await f.waitForRequest(start + 1), body = first.options!.body as string, command = JSON.parse(body).command;
  assert.equal(command.definition_json, rawDefinition); assert.equal(command.expected_schedule_id, null); assert.equal(command.expected_schedule_revision, 0);
  await f.reject(start + 1); assert.equal(f.named("select", "采集调度组合").props.disabled, true);
  const changed = initial(); changed.schedules[0].schedule_revision = 3;
  f.click("重新核对会话与调度"); await f.ready(changed); assert.equal(f.postRequests().length, 1); assert.equal(f.checkbox().props.checked, false);
  const retry = f.requests.length; f.change(f.checkbox(), true); f.submit(); await f.session(retry);
  const resent = await f.waitForRequest(retry + 1); assert.equal(resent.options!.body, body);
  assert.equal(new Headers(resent.options!.headers).get("X-Workbench-Session-Binding"), binding);
});

test("status selection and scope changes only read until a reason and explicit acknowledgement submit", async t => {
  const f = mount(t); await f.ready();
  f.change(f.named("select", "采集调度组合"), "p2"); await f.ready(initial("p2"));
  f.change(f.named("select", "目标采集调度"), "p2-schedule"); f.change(f.named("select", "采集调度操作"), "enabled");
  assert.equal(f.postRequests().length, 0); f.submit(); assert.equal(f.postRequests().length, 0);
  f.change(f.named("input", "采集调度理由"), "Explicit synthetic enable"); f.change(f.checkbox(), true);
  const start = f.requests.length; f.submit(); await f.session(start); const request = await f.waitForRequest(start + 1);
  const payload = JSON.parse(request.options!.body as string);
  assert.equal(payload.action, "set_collection_schedule_status"); assert.equal(payload.command.portfolio_id, "p2");
  assert.equal(payload.command.schedule_id, "p2-schedule"); assert.equal(payload.command.status, "enabled"); assert.equal(payload.command.expected_schedule_revision, 1);
  assert.equal("definition_json" in payload.command, false);
});

test("503 and blur preserve pending in memory but require successful read and human confirmation to retry", async t => {
  const f = mount(t); await f.ready(); f.fill(); const start = f.requests.length; f.submit(); await f.session(start);
  const body = (await f.waitForRequest(start + 1)).options!.body; await f.respond(start + 1, { error: "WORKBENCH_UNAVAILABLE" }, 503);
  assert.equal(f.events.length, 0); assert.equal(f.beforeUnload().defaultPrevented, true);
  f.window.emit("blur"); assert.doesNotMatch(f.text(), /PRIVATE CONTROL|SYNTHETIC SCOPE/);
  f.click("重新核对会话与调度"); await f.ready(); assert.equal(f.postRequests().length, 1); assert.equal(f.checkbox().props.checked, false);
  const retry = f.requests.length; f.change(f.checkbox(), true); f.submit(); await f.session(retry);
  assert.equal((await f.waitForRequest(retry + 1)).options!.body, body);
});

test("current POST 401 invalidates before reading malformed body and clears pending navigation guard", async t => {
  const f = mount(t); await f.ready(); f.fill(); const start = f.requests.length; f.submit(); await f.session(start); await f.waitForRequest(start + 1);
  await f.respond(start + 1, "SYNTHETIC_PRIVATE_RESPONSE", 401, true);
  assert.deepEqual(f.events, [SESSION_INVALIDATED_EVENT]); assert.doesNotMatch(f.text(), /SYNTHETIC_|PRIVATE CONTROL/);
  assert.equal(f.beforeUnload().defaultPrevented, false); assert.equal(f.navigate("/login").defaultPrevented, false);
});

test("a changed SID from the recovery probe invalidates and clears the old in-memory command without reposting", async t => {
  const f = mount(t); await f.ready(); f.fill(); const start = f.requests.length; f.submit(); await f.session(start);
  await f.waitForRequest(start + 1); await f.reject(start + 1); assert.equal(f.beforeUnload().defaultPrevented, true);
  f.click("重新核对会话与调度"); const probe = f.requests.length - 1; await f.session(probe, otherBinding);
  assert.deepEqual(f.events, [SESSION_INVALIDATED_EVENT]); assert.equal(f.postRequests().length, 1);
  assert.equal(f.beforeUnload().defaultPrevented, false); assert.doesNotMatch(f.text(), /PRIVATE CONTROL|SYNTHETIC SCOPE/);
});

test("obsolete GET 401 cannot invalidate later generation, while current GET 401 clears the page", async t => {
  const f = mount(t); await f.session(0); f.window.emit("blur"); f.click("重新核对会话与调度");
  await f.respond(1, "invalid", 401, true); assert.deepEqual(f.events, []); await f.ready();
  f.click("重新核对会话与调度"); const start = f.requests.length - 1; await f.session(start); await f.respond(start + 1, "invalid", 401, true);
  assert.deepEqual(f.events, [SESSION_INVALIDATED_EVENT]); assert.doesNotMatch(f.text(), /SYNTHETIC SCOPE/);
});

test("pending warns on same-tab navigation but never traps logout, new-tab evidence or explicit abandonment", async t => {
  const f = mount(t); await f.ready(); f.fill(); const start = f.requests.length; f.submit(); await f.session(start); await f.waitForRequest(start + 1); await f.reject(start + 1);
  assert.equal(f.beforeUnload().defaultPrevented, true); assert.equal(f.navigate("/workbench").defaultPrevented, true);
  assert.equal(f.navigate("/workbench/market", "_blank").defaultPrevented, false); assert.equal(f.navigate("#local").defaultPrevented, false);
  assert.equal(f.navigate("/api/workbench/market", "", { download: true }).defaultPrevented, false);
  f.click("显式放弃本页重试"); assert.equal(f.beforeUnload().defaultPrevented, true);
  f.setConfirm(true); f.click("显式放弃本页重试"); assert.equal(f.beforeUnload().defaultPrevented, false); assert.equal(f.postRequests().length, 1);
  f.window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); assert.equal(f.navigate("/login").defaultPrevented, false);
});

test("rejected reads and restored read-only state cannot enable or save a schedule", async t => {
  const f = mount(t); await f.ready(); f.fill(); f.click("重新核对会话与调度"); const start = f.requests.length - 1;
  await f.respond(start, { error: "AUTH_UNAVAILABLE" }, 503); assert.equal(f.postRequests().length, 0); assert.doesNotMatch(f.text(), /SYNTHETIC SCOPE/);
  f.click("重新核对会话与调度"); await f.ready({ ...initial(), read_only: true });
  assert.equal(f.checkbox().props.disabled, true); assert.equal(f.control("fieldset").props.disabled, true);
  f.submit(); assert.equal(f.postRequests().length, 0); assert.match(f.text(), /恢复\/只读模式/);
});

test("pagination retains scope, uses only explicit GET and refuses a mismatched portfolio response", async t => {
  const f = mount(t); await f.ready({ ...initial(), next_cursor: "synthetic/page+1" }); f.click("读取更早槽位");
  const start = f.requests.length - 1; await f.session(start); const request = await f.waitForRequest(start + 1);
  const query = new URL(request.url, "https://synthetic.invalid").searchParams;
  assert.equal(query.get("portfolio"), "p"); assert.equal(query.get("cursor"), "synthetic/page+1");
  await f.respond(start + 1, { ...initial("p2"), session_binding: binding });
  assert.match(f.text(), /COLLECTION_RESPONSE_INVALID/); assert.doesNotMatch(f.text(), /SYNTHETIC SCOPE/); assert.equal(f.postRequests().length, 0);
});

test("wrong save hash receipt retains original pending; successful paused save never auto-enables", async t => {
  const f = mount(t); await f.ready(); f.fill(); const start = f.requests.length; f.submit(); await f.session(start);
  const body = (await f.waitForRequest(start + 1)).options!.body;
  const receipt = { schedule_id: "new-schedule", version_id: "new-version", version: 1, schedule_revision: 1, status: "paused",
    scope_key: "provider:ecb:fx:daily:CHF", content_hash: hash(rawDefinition), session_binding: binding };
  await f.respond(start + 1, { ...receipt, content_hash: otherBinding }); assert.match(f.text(), /COLLECTION_RECEIPT_INVALID/);
  assert.ok(f.all().some(row => row.type === "pre" && row.props.children === body)); assert.equal(f.beforeUnload().defaultPrevented, true);
  f.change(f.checkbox(), true); const retry = f.requests.length; f.submit(); await f.session(retry); await f.waitForRequest(retry + 1);
  await f.respond(retry + 1, receipt); await f.session(retry + 2); await f.ready();
  assert.equal(f.postRequests().length, 2); assert.equal(f.postRequests()[1].options!.body, body);
  assert.equal(f.named("textarea", "采集调度定义").props.value, ""); assert.equal(f.checkbox().props.checked, false);
  assert.equal(f.beforeUnload().defaultPrevented, false); assert.match(f.text(), /不是采集成功证明/);
});
