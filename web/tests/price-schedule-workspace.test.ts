import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as client from "../src/components/workbench/price-schedule-client";
import { PRICE_MARKET_ZONES } from "../src/server/price-schedules/schemas";
import { parseStrictJson } from "../src/server/strict-json";
import { SESSION_INVALIDATED_EVENT } from "../src/components/session-boundary-state";
import { priceBinding as binding, priceOtherBinding as otherBinding, priceDetail, priceReceipt, priceState } from "./price-schedule-test-fixture";

type Tree = { type: unknown; props: Record<string, unknown> };
type Listener = (event: Record<string, unknown>) => void;
const compiled = ts.transpileModule(readFileSync(new URL("../src/components/workbench/price-schedule-workspace.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
// Exercises actual component callbacks and validators; not native-browser evidence.
function mount(t: { after(callback: () => void): void }, options: { verified?: boolean; sessionBinding?: string } = {}) {
  class Surface {
    listeners = new Map<string, Set<Listener>>();
    captures = new Map<Listener, boolean>();
    addEventListener(type: string, callback: Listener, capture = false) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(callback); this.captures.set(callback, capture); }
    removeEventListener(type: string, callback: Listener) { this.listeners.get(type)?.delete(callback); }
    emit(type: string, event: Record<string, unknown> = {}) { for (const callback of this.listeners.get(type) ?? []) callback(event); }
  }
  const document = Object.assign(new Surface(), { visibilityState: "visible" }), events: string[] = [];
  const confirmations: string[] = [];
  let confirmResult = true;
  const window = Object.assign(new Surface(), { location: new URL("http://localhost/workbench/price-schedules"), confirm: (message: string) => { confirmations.push(message); return confirmResult; }, dispatchEvent(event: { type: string }) { events.push(event.type); window.emit(event.type, event); return true; } });
  class Element { constructor(private anchor?: HTMLAnchorElement) {} closest() { return this.anchor; } }
  class HTMLAnchorElement extends Element {
    constructor(public href: string, public target = "", private download = false) { super(); }
    hasAttribute(name: string) { return name === "download" && this.download; }
  }
  const network: { url: string; options?: RequestInit; resolve(response: Response): void; reject(reason: Error): void }[] = [], listeners = new Set<() => void>();
  const hooks: unknown[] = [], effects: { dependencies: unknown[]; cleanup?: () => void }[] = [], queued: { slot: number; callback: () => void | (() => void) }[] = [];
  let cursor = 0, effectCursor = 0, tree: Tree, rendering = false, render: () => void, pageBinding = binding;
  const context = { verified: options.verified ?? true, sessionBinding: options.sessionBinding ?? binding };
  const react = {
    useState(value: unknown) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof value === "function" ? value() : value;
      return [hooks[i], (next: unknown) => { const resolved = typeof next === "function" ? next(hooks[i]) : next; if (Object.is(resolved, hooks[i])) return; hooks[i] = resolved; render(); }]; },
    useRef(value: unknown) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: value }; return hooks[i]; },
    useEffect(callback: () => void | (() => void), dependencies: unknown[]) { const slot = effectCursor++, old = effects[slot];
      if (!old || dependencies.some((value, i) => !Object.is(value, old.dependencies[i]))) { old?.cleanup?.(); effects[slot] = { dependencies }; queued.push({ slot, callback }); } },
  };
  const jsx = (type: unknown, props: Record<string, unknown>): Tree => typeof type === "function" ? type(props) : ({ type, props });
  const dependencies: Record<string, unknown> = { react, "react/jsx-runtime": { jsx, jsxs: jsx }, "next/link": { default: "a" },
    "@/components/session-boundary": { useSessionBoundary: () => context }, "@/components/session-boundary-state": { SESSION_INVALIDATED_EVENT },
    "@/server/strict-json": { parseStrictJson }, "@/server/price-schedules/schemas": { PRICE_MARKET_ZONES }, "./price-schedule-client": client };
  const module = { exports: {} as { PriceScheduleWorkspace(props: unknown): Tree } };
  const execute = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { window, document, Element, HTMLAnchorElement, URL, URLSearchParams, TextEncoder, TextDecoder, Error, crypto,
    CustomEvent: class { constructor(public type: string) {} }, fetch: (url: string, options?: RequestInit) => new Promise((resolve, reject) => {
      network.push({ url, options, resolve, reject }); for (const listener of listeners) listener();
    }) });
  execute((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports);
  render = () => { if (rendering) return; rendering = true; cursor = 0; effectCursor = 0;
    tree = module.exports.PriceScheduleWorkspace({ initialSessionBinding: pageBinding }); rendering = false;
    while (queued.length) { const item = queued.shift()!; const cleanup = item.callback(); if (cleanup) effects[item.slot].cleanup = cleanup; }
    for (const listener of listeners) listener();
  };
  render(); t.after(() => { effects.forEach(effect => effect.cleanup?.()); });
  const all = () => { const result: Tree[] = []; const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; } if (!value || typeof value !== "object" || !("props" in value)) return;
    const row = value as Tree; result.push(row); visit(row.props.children);
  }; visit(tree); return result; };
  const text = (node: Tree = tree): string => { const visit = (value: unknown): string => Array.isArray(value) ? value.map(visit).join(" ") : typeof value === "string" || typeof value === "number" ? String(value)
    : value && typeof value === "object" && "props" in value ? visit((value as Tree).props.children) : ""; return visit(node); };
  const control = (type: string, predicate: (node: Tree) => boolean = () => true) => { const found = all().find(row => row.type === type && predicate(row)); assert.ok(found, type); return found; };
  const named = (type: string, label: string) => control(type, row => row.props["aria-label"] === label);
  const change = (node: Tree, value: string | boolean) => (node.props.onChange as (event: unknown) => void)({ target: typeof value === "boolean" ? { checked: value } : { value } });
  const click = (label: string) => { const node = control("button", row => text(row).replace(/\s+/g, " ").trim() === label); assert.equal(!!node.props.disabled, false); (node.props.onClick as () => void)(); };
  const until = (predicate: () => boolean, label: string) => new Promise<void>((resolve, reject) => {
    const check = () => { if (predicate()) { clearTimeout(timeout); listeners.delete(check); resolve(); } };
    const timeout = setTimeout(() => { listeners.delete(check); reject(new Error(`Timed out: ${label}; ${text()}`)); }, 10000);
    listeners.add(check); check();
  });
  const request = async (index: number) => { await until(() => network.length > index, `request ${index}`); return network[index]; };
  const respond = async (index: number, value: unknown, status = 200, raw = false) => { (await request(index)).resolve(new Response(raw ? value as string : JSON.stringify(value), { status })); await new Promise(resolve => setImmediate(resolve)); };
  const session = (index: number, value = binding) => respond(index, { authenticated: true, session_binding: value });
  const load = async (index: number, state = priceState(), detail?: ReturnType<typeof priceDetail>) => {
    await session(index); await respond(index + 1, { ...state, session_binding: binding });
    if (detail) await respond(index + 2, { ...detail, session_binding: binding });
    await session(index + (detail ? 3 : 2));
  };
  const settled = () => until(() => !control("main").props["aria-busy"], "component settled");
  const ready = async (state = priceState()) => { await load(0, state); await load(3, state); await settled(); };
  return { context, window, document, events, requests: network, all, text, control, named, change, click, request, respond, session, load, ready, settled, render,
    confirmations, confirm(value: boolean) { confirmResult = value; },
    navigate(options: { href?: string; target?: string; download?: boolean; button?: number; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; defaultPrevented?: boolean } = {}) {
      const event = { button: 0, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, propagationStopped: false, ...options,
        target: new Element(new HTMLAnchorElement(options.href ?? "/workbench/market", options.target, options.download)),
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; } };
      document.emit("click", event); return event;
    },
    ack(value = true) { change(named("input", "确认价格采集授权"), value); },
    submit() { void (control("form").props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} }); },
    posts: () => network.filter(row => row.options?.method === "POST"), untilText: (pattern: RegExp) => until(() => pattern.test(text()), String(pattern)),
    setPageBinding(value: string) { pageBinding = value; render(); },
  };
}
type Fixture = ReturnType<typeof mount>;
function fill(f: Fixture) {
  f.change(f.named("select", "采集市场"), "HK"); f.change(f.named("input", "引用 mapping-synthetic"), true); f.change(f.named("input", "引用 calendar-synthetic"), true);
  for (const [label, value] of [["目标价格起日 D（含）", "2030-01-02"], ["目标价格止日 D（含，必填）", "2030-01-04"], ["D+1 本地触发小时", "2"], ["D+1 本地触发分钟", "5"], ["截止窗口秒数", "600"], ["最大尝试次数", "2"]]) f.change(f.named("input", label), value);
  f.change(f.named("textarea", "价格采集理由"), "SYNTHETIC PRIVATE FINITE PLAN"); f.ack();
}

test("price workspace reads only under verified session and starts with explicit empty fields", async t => {
  for (const options of [{ verified: false }, { sessionBinding: otherBinding }]) { const f = mount(t, options); assert.equal(f.requests.length, 0); assert.doesNotMatch(f.text(), /SYNTHETIC SCOPE/); }
  const f = mount(t); await f.ready(); assert.equal(f.posts().length, 0); assert.equal(f.named("select", "采集市场").props.value, ""); assert.equal(f.named("input", "D+1 本地触发小时").props.value, "");
  assert.equal(f.named("textarea", "价格采集理由").props.value, ""); assert.equal(f.named("input", "确认价格采集授权").props.checked, false); assert.match(f.text(), /有限日期范围/); assert.match(f.text(), /保存永远暂停/); assert.match(f.text(), /DST/);
});
test("explicit typed save sends exactly once and shows paused receipt without auto enabling", async t => {
  const f = mount(t); await f.ready(); fill(f); const index = f.requests.length; f.submit(); f.submit(); await f.session(index);
  const posted = await f.request(index + 1); assert.equal(posted.options?.method, "POST"); assert.equal(f.posts().length, 1);
  const body = posted.options?.body as string, value = JSON.parse(body); assert.equal(value.action, "save_schedule"); assert.equal(JSON.parse(value.command.definition_json).market, "HK");
  await f.respond(index + 1, priceReceipt(body)); await f.session(index + 2); await f.load(index + 3, priceState("p", true)); await f.settled();
  assert.match(f.text(), /已核验命令回执（不是采集成功）/); assert.match(f.text(), /paused/); assert.equal(f.posts().length, 1); assert.equal(f.named("textarea", "价格采集理由").props.value, "");
});
test("separate explicit enable and pause retain saved version CAS and cannot run without acknowledgement", async t => {
  for (const operation of ["enabled", "paused"] as const) {
    const f = mount(t); await f.ready(priceState("p", true)); f.change(f.named("select", "价格采集计划"), "schedule-synthetic"); f.change(f.named("select", "价格采集操作"), operation);
    f.change(f.named("textarea", "价格采集理由"), "SYNTHETIC HUMAN CONTROL"); const count = f.requests.length; f.submit(); assert.equal(f.requests.length, count);
    f.ack(); f.submit(); await f.session(count); const posted = await f.request(count + 1), body = JSON.parse(posted.options!.body as string);
    assert.equal(body.action, "set_status"); assert.equal(body.command.status, operation); assert.equal(body.command.expected_schedule_revision, 1); assert.equal("definition_json" in body.command, false);
    await f.respond(count + 1, { error: "WORKBENCH_READ_ONLY" }, 423); await f.untilText(/原请求保留/);
  }
});
test("uncertain write preserves exact bytes and key across refresh until manual acknowledged retry", async t => {
  const f = mount(t); await f.ready(); fill(f); const index = f.requests.length; f.submit(); await f.session(index);
  const body = (await f.request(index + 1)).options!.body as string; await f.respond(index + 1, { error: "WORKBENCH_UNAVAILABLE" }, 503); await f.untilText(/原请求保留/);
  assert.equal(f.posts().length, 1); assert.equal(f.control("fieldset").props.disabled, true);
  const refresh = f.requests.length; f.click("刷新会话、计划与历史"); await f.load(refresh, priceState("p", true)); await f.settled(); assert.equal(f.posts().length, 1);
  f.ack(); const retry = f.requests.length; f.submit(); await f.session(retry); assert.equal((await f.request(retry + 1)).options!.body, body);
  await f.respond(retry + 1, priceReceipt(body)); await f.session(retry + 2); await f.load(retry + 3, priceState("p", true)); await f.settled(); assert.equal(f.posts().length, 2);
});
test("capture navigation guard cancels busy and uncertain writes without losing exact retry bytes", async t => {
  const f = mount(t); await f.ready(); fill(f); f.confirm(false);
  const index = f.requests.length; f.submit();
  const busyNavigation = f.navigate(); assert.equal(busyNavigation.defaultPrevented, true); assert.equal(busyNavigation.propagationStopped, true);
  const listener = [...f.document.listeners.get("click")!][0]; assert.equal(f.document.captures.get(listener), true);
  await f.session(index); const body = (await f.request(index + 1)).options!.body as string;
  await f.respond(index + 1, { error: "WORKBENCH_UNAVAILABLE" }, 503); await f.untilText(/原请求保留/);
  const pendingNavigation = f.navigate(); assert.equal(pendingNavigation.defaultPrevented, true); assert.equal(pendingNavigation.propagationStopped, true);
  assert.equal(f.posts().length, 1); assert.equal(f.confirmations.length, 2); assert.equal(f.control("pre").props.children, body);
  f.ack(); const retry = f.requests.length; f.submit(); await f.session(retry);
  assert.equal((await f.request(retry + 1)).options!.body, body); assert.equal(f.posts().length, 2);
  await f.respond(retry + 1, { error: "WORKBENCH_UNAVAILABLE" }, 503); await f.untilText(/原请求保留/);
});
test("navigation guard allows confirmed departure but skips non-leaving links and invalid sessions", async t => {
  const f = mount(t); await f.ready(); f.confirm(false);
  assert.equal(f.navigate().defaultPrevented, false); assert.equal(f.confirmations.length, 0);
  fill(f); const index = f.requests.length; f.submit(); await f.session(index); await f.request(index + 1);
  await f.respond(index + 1, { error: "WORKBENCH_UNAVAILABLE" }, 503); await f.untilText(/原请求保留/);
  for (const options of [{ target: "_blank" }, { download: true }, { button: 1 }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { href: "#history" }]) {
    const event = f.navigate(options); assert.equal(event.defaultPrevented, false); assert.equal(event.propagationStopped, false);
  }
  f.navigate({ defaultPrevented: true }); assert.equal(f.confirmations.length, 0);
  f.confirm(true); const leave = f.navigate(); assert.equal(leave.defaultPrevented, false); assert.equal(leave.propagationStopped, false); assert.equal(f.confirmations.length, 1);
  assert.match(f.confirmations[0], /原字节与幂等键/); assert.equal(f.posts().length, 1);
  f.window.emit(SESSION_INVALIDATED_EVENT); await f.untilText(/会话待核对/); f.confirm(false);
  assert.equal(f.navigate().defaultPrevented, false); assert.equal(f.confirmations.length, 1); assert.doesNotMatch(f.text(), /冻结原请求/);
});
test("market reference review opens a separate page and leaves the pending-page memory intact", async t => {
  const f = mount(t); await f.ready(); const link = f.control("a", row => row.props.href === "/workbench/market");
  assert.equal(link.props.target, "_blank"); assert.equal(link.props.rel, "noopener noreferrer"); assert.match(f.text(link), /新页/);
});
test("same scope retains draft and acknowledgement; A-B-A clears them without reusing stale work", async t => {
  const f = mount(t); await f.ready(); fill(f); const count = f.requests.length;
  f.change(f.named("select", "价格采集组合"), "p"); assert.equal(f.requests.length, count); assert.equal(f.named("textarea", "价格采集理由").props.value, "SYNTHETIC PRIVATE FINITE PLAN"); assert.equal(f.named("input", "确认价格采集授权").props.checked, true);
  f.change(f.named("select", "价格采集组合"), "q"); await f.load(count, priceState("q")); await f.settled();
  assert.equal(f.named("textarea", "价格采集理由").props.value, ""); assert.equal(f.named("input", "确认价格采集授权").props.checked, false); assert.equal(f.named("select", "采集市场").props.value, "");
  const back = f.requests.length; f.change(f.named("select", "价格采集组合"), "p"); await f.load(back); await f.settled(); assert.equal(f.posts().length, 0); assert.equal(f.named("textarea", "价格采集理由").props.value, "");
});
test("slot detail preserves original times attempts capture and both return paths clear drafts", async t => {
  for (const method of ["button", "selector"] as const) {
    const state = priceState("p", true, true), f = mount(t); await f.ready(state); fill(f); const start = f.requests.length;
    f.click("读取槽位 slot-synthetic"); await f.load(start, state, priceDetail()); await f.settled();
    assert.match(f.text(), /目标价格日期 D： 2030-01-02/); assert.match(f.text(), /计划触发 UTC： 2030-01-02T18:05:00/); assert.match(f.text(), /实际接收 UTC： 2030-01-02T18:05:04/);
    assert.match(f.text(), /尝试历史/); assert.equal(f.all().some(row => row.type === "form"), false);
    const back = f.requests.length; if (method === "button") f.click("返回本组合槽位列表"); else f.change(f.named("select", "价格采集组合"), "p");
    await f.load(back, state); await f.settled(); assert.equal(f.named("textarea", "价格采集理由").props.value, ""); assert.equal(f.posts().length, 0);
  }
});
test("readonly retains scoped private history while preventing save enable or pause", async t => {
  const f = mount(t), state = priceState("p", true, true); state.read_only = true; await f.ready(state);
  assert.match(f.text(), /恢复\/只读模式/); assert.match(f.text(), /capture-synthetic/); assert.equal(f.control("fieldset").props.disabled, true); assert.equal(f.named("input", "确认价格采集授权").props.disabled, true);
  fill(f); f.submit(); assert.equal(f.posts().length, 0);
  const start = f.requests.length; f.click("读取槽位 slot-synthetic"); const detail = priceDetail(); detail.read_only = true; await f.load(start, state, detail); await f.settled(); assert.match(f.text(), /尝试历史/);
});
test("changed/401 sessions and explicit invalidation remove private data and pending writes", async t => {
  for (const cause of ["event", "foreign", "401"] as const) {
    const f = mount(t); await f.ready(); fill(f); const start = f.requests.length; f.submit(); await f.session(start); await f.request(start + 1);
    if (cause === "event") f.window.emit(SESSION_INVALIDATED_EVENT);
    else if (cause === "foreign") await f.respond(start + 1, priceReceipt(f.posts()[0].options!.body as string, otherBinding));
    else await f.respond(start + 1, "PRIVATE_NON_JSON", 401, true);
    await f.untilText(/会话待核对/); assert.doesNotMatch(f.text(), /SYNTHETIC PRIVATE|SYNTHETIC SCOPE|冻结原请求/); assert.equal(f.posts().length, 1);
  }
});
test("pre-submit blur and stale generation responses never send or reveal old scoped work", async t => {
  const f = mount(t); await f.ready(); fill(f); const start = f.requests.length; f.submit(); f.window.emit("blur"); await f.session(start);
  assert.equal(f.posts().length, 0); assert.doesNotMatch(f.text(), /SYNTHETIC PRIVATE FINITE PLAN/);
  const refresh = f.requests.length; f.click("刷新会话、计划与历史"); await f.session(refresh); const old = await f.request(refresh + 1);
  f.window.emit("blur"); const fresh = f.requests.length; f.click("刷新会话、计划与历史"); await f.load(fresh); await f.settled();
  old.resolve(new Response(JSON.stringify({ ...priceState("q", true, true), session_binding: binding }))); await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(f.text(), /capture-synthetic/); assert.equal(f.named("select", "价格采集组合").props.value, "p"); assert.equal(f.posts().length, 0);
});
test("all draft edits revoke acknowledgement and invalid typed ranges cannot reach POST", async t => {
  const f = mount(t); await f.ready(); fill(f); f.change(f.named("input", "D+1 本地触发分钟"), "60"); assert.equal(f.named("input", "确认价格采集授权").props.checked, false);
  f.ack(); const start = f.requests.length; f.submit(); await f.session(start); await f.untilText(/PRICE_SCHEDULE_INVALID_DEFINITION/); assert.equal(f.posts().length, 0);
});
