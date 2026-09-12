import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as client from "../src/components/workbench/market-reference-client";
import { SESSION_INVALIDATED_EVENT } from "../src/components/session-boundary-state";
import type { MarketReferenceState } from "../src/server/market-references/queries";

type Tree = { type: unknown; props: Record<string, unknown> };
type Listener = (event: Record<string, unknown>) => void;
type Effect = () => void | (() => void);
function queue<T>() {
  const items: T[] = [], waiting = new Map<number, Array<(value: T) => void>>();
  return { items, push(value: T) { const index = items.length; items.push(value); for (const resolve of waiting.get(index) ?? []) resolve(value); waiting.delete(index); },
    at(index: number): Promise<T> { if (index < items.length) return Promise.resolve(items[index]); return new Promise(resolve => waiting.set(index, [...(waiting.get(index) ?? []), resolve])); } };
}
const binding = "a".repeat(64), other = "b".repeat(64);
const initial = (): MarketReferenceState => ({ portfolios: [{ id: "p", name: "SYNTHETIC PRIVATE DIRECTORY" }, { id: "p2", name: "Synthetic second" }], portfolios_truncated: false,
  selected_portfolio_id: "p", ledger_revision: 3, read_only: false, sources: [], sources_truncated: false, versions: [], versions_truncated: false,
  heads: [], heads_truncated: false, listings: [], listings_truncated: false, resource_hash: "c".repeat(64), review_basis: "human_reviewed_not_provider_verified" });
const compiled = ts.transpileModule(readFileSync(new URL("../src/components/workbench/market-reference-workspace.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Real component handlers/effects with controlled promises; not native DOM/BFCache acceptance.
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
    constructor(href: string, target = "") { super(); this.href = new URL(href, "https://synthetic.invalid/workbench/market").href; this.target = target; }
    closest(_selector: string) { return this; }
    hasAttribute(name: string) { return name === "download" && this.download !== ""; }
    getAttribute(name: string) { return name === "href" ? this.href : name === "target" ? this.target : null; }
  }
  const document = Object.assign(new Surface(), { visibilityState: "visible" });
  let confirmResult = false;
  const prompts: string[] = [], events: string[] = [];
  const window = Object.assign(new Surface(), { location: new URL("https://synthetic.invalid/workbench/market"),
    confirm(message: string) { prompts.push(message); return confirmResult; },
    dispatchEvent(event: { type: string }) { events.push(event.type); window.emit(event.type, event); return true; } });
  const network = queue<{ url: string; options?: RequestInit; resolve(response: Response): void; reject(reason: Error): void }>();
  const hashes = queue<{ actual: Promise<client.MarketPending>; release(pending: client.MarketPending): void }>();
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
    "./market-reference-client": { ...client, prepareMarketAttempt: (...args: Parameters<typeof client.prepareMarketAttempt>) => {
      const actual = client.prepareMarketAttempt(...args);
      return options.delayedHash ? new Promise<client.MarketPending>(release => hashes.push({ actual, release })) : actual;
    } } };
  const module = { exports: {} as { MarketReferenceWorkspace(props: unknown): Tree } };
  const execute = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { window, document, URL, URLSearchParams, Element, HTMLAnchorElement: Anchor,
    TextEncoder, TextDecoder, crypto, Error, CustomEvent: class { constructor(public type: string) {} },
    fetch: (url: string, options?: RequestInit) => new Promise((resolve, reject) => network.push({ url, options, resolve, reject })),
  }) as (require: (id: string) => unknown, module: unknown, exports: unknown) => void;
  execute(id => { assert.ok(id in dependencies, id); return dependencies[id]; }, module, module.exports);
  render = () => {
    if (rendering) return; rendering = true; cursor = 0; effectCursor = 0;
    tree = module.exports.MarketReferenceWorkspace({ initial: initial(), initialSessionBinding: pageBinding }); rendering = false;
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
  const checkbox = () => control("input", node => node.props.type === "checkbox");
  const change = (node: Tree, value: string | boolean) => (node.props.onChange as (event: unknown) => void)({ target: typeof value === "boolean" ? { checked: value } : { value } });
  const button = (label: string) => control("button", node => text(node) === label);
  const click = (label: string) => { const node = button(label); assert.equal(!!node.props.disabled, false); (node.props.onClick as () => void)(); };
  const submit = () => (control("form").props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  const fill = (raw = '{\r\n "synthetic_private_source": "001.00"\r\n}\r\n') => {
    change(control("input", node => node.props.type !== "checkbox"), "SYNTHETIC PRIVATE SOURCE"); change(control("textarea"), raw); change(checkbox(), true);
  };
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  const respond = async (index: number, body: unknown, status = 200, raw = false) => { (await network.at(index)).resolve(new Response(raw ? body as string : JSON.stringify(body), { status })); await flush(); };
  const session = (index: number, value = binding) => respond(index, { authenticated: true, session_binding: value });
  const ready = async (value = initial(), start = network.items.length - 1) => { await session(start); await respond(start + 1, { ...value, session_binding: binding }); await session(start + 2); };
  const beforeUnload = () => { const event = { defaultPrevented: false, returnValue: undefined as unknown, preventDefault() { this.defaultPrevented = true; } }; window.emit("beforeunload", event); return event; };
  const navigate = (href: string, target = "", extra: Record<string, unknown> = {}) => {
    const anchor = new Anchor(href, target); if (extra.download === true) anchor.download = "synthetic-source.json";
    const event = { target: anchor, button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {}, ...extra };
    document.emit("click", event); return event;
  };
  return { context, document, window, events, prompts, all, control, checkbox, change, click, submit, fill, text, ready, respond, session, flush, render,
    requests: network.items, waitForRequest: network.at, waitForHash: hashes.at, beforeUnload, navigate,
    setConfirm(value: boolean) { confirmResult = value; }, setPageBinding(value: string) { pageBinding = value; render(); },
    postRequests: () => network.items.filter(item => item.options?.method === "POST"),
    async reject(index: number) { (await network.at(index)).reject(new Error("Synthetic network loss")); await flush(); },
    async releaseHash(index = 0) { const item = await hashes.at(index), result = await item.actual; item.release(result); await flush(); return result; } };
}

test("unverified or mismatched boundary renders no initial private directory and issues no GET", t => {
  for (const options of [{ verified: false }, { binding: other }]) {
    const f = mount(t, options); assert.doesNotMatch(f.text(), /SYNTHETIC PRIVATE/); assert.equal(f.requests.length, 0);
    assert.match(f.text(), /会话待核对/);
  }
});

test("controlled hash completion cannot send after blur, hide, SID switch or scope A-B-A", async t => {
  for (const reason of ["blur", "hidden", "sid", "scope"] as const) {
    const f = mount(t, { delayedHash: true }); await f.ready(); f.fill(); f.submit(); f.submit(); await f.session(3);
    const hashing = await f.waitForHash(0); await hashing.actual; assert.equal(f.postRequests().length, 0);
    assert.equal(f.beforeUnload().defaultPrevented, true);
    if (reason === "blur") f.window.emit("blur");
    if (reason === "hidden") { f.document.visibilityState = "hidden"; f.document.emit("visibilitychange"); }
    if (reason === "sid") { f.context.sessionBinding = other; f.render(); }
    if (reason === "scope") {
      const oldChange = f.control("select", node => node.props["aria-label"] === "市场资料组合");
      f.change(oldChange, "p2"); f.change(oldChange, "p");
    }
    await f.releaseHash(); assert.equal(f.postRequests().length, 0, reason);
    assert.doesNotMatch(f.text(), /SYNTHETIC PRIVATE/);
  }
});

test("POST loss preserves exact body and original CAS through refresh, with explicit confirmation required for retry", async t => {
  const f = mount(t); await f.ready();
  f.change(f.control("select", node => !node.props["aria-label"]), "collect_prices");
  f.change(f.control("textarea"), JSON.stringify({ schema_version: "market-price-collect-v1", provider: "longport",
    mapping_version_ids: ["synthetic-mapping"], calendar_version_ids: ["synthetic-calendar"], start_date: "2025-06-05", end_date: "2025-06-06",
    expected_publication_revision: 2, publish: false }));
  f.change(f.checkbox(), true); f.submit(); await f.session(3);
  const original = (await f.waitForRequest(4)).options!.body;
  assert.equal(JSON.parse(original as string).command.expected_revision, 3);
  assert.equal(JSON.parse(original as string).command.payload.expected_publication_revision, 2);
  await f.reject(4); assert.equal(f.control("select", node => node.props["aria-label"] === "市场资料组合").props.disabled, true);
  f.click("重新核对会话与资料"); await f.ready({ ...initial(), ledger_revision: 9 });
  assert.equal(f.postRequests().length, 1); assert.equal(f.checkbox().props.checked, false);
  f.change(f.checkbox(), true); f.submit(); await f.session(8);
  const retried = await f.waitForRequest(9); assert.equal(retried.options!.body, original);
  assert.equal(new Headers(retried.options?.headers).get("X-Workbench-Session-Binding"), binding);
  assert.equal(f.postRequests().length, 2);
});

test("pending navigation requires warning but new-tab inspection and session invalidation do not trap the user", async t => {
  const f = mount(t); await f.ready(); f.fill(); f.submit(); await f.session(3); await f.waitForRequest(4); await f.reject(4);
  assert.equal(f.beforeUnload().defaultPrevented, true);
  assert.equal(f.navigate("/workbench").defaultPrevented, true); assert.equal(f.prompts.length, 1);
  assert.equal(f.navigate("/workbench", "_blank").defaultPrevented, false);
  assert.equal(f.navigate("/api/workbench/market?view=source", "", { download: true }).defaultPrevented, false);
  assert.equal(f.navigate("#local").defaultPrevented, false);
  assert.equal(f.navigate("/workbench", "", { ctrlKey: true }).defaultPrevented, false);
  const link = f.all().find(row => row.type === "link" && row.props.href === "/workbench")!;
  assert.equal(link.props.target, "_blank"); assert.match(String(link.props.rel), /noopener/);
  f.setConfirm(true); assert.equal(f.navigate("/workbench").defaultPrevented, false);
  f.window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT));
  assert.equal(f.beforeUnload().defaultPrevented, false); assert.equal(f.navigate("/login").defaultPrevented, false);
  assert.doesNotMatch(f.text(), /SYNTHETIC PRIVATE|synthetic_private_source/); assert.equal(f.postRequests().length, 1);
});

test("a current POST 401 invalidates before malformed-body parsing and deletes pending sources", async t => {
  const f = mount(t); await f.ready(); f.fill(); f.submit(); await f.session(3); await f.waitForRequest(4);
  await f.respond(4, "SYNTHETIC_PRIVATE_RESPONSE_MARKER", 401, true);
  assert.deepEqual(f.events, [SESSION_INVALIDATED_EVENT]); assert.doesNotMatch(f.text(), /SYNTHETIC PRIVATE|synthetic_private_source|RESPONSE_MARKER/);
  assert.equal(f.beforeUnload().defaultPrevented, false);
});

test("obsolete GET 401 cannot invalidate a new generation; current GET 401 clears private state", async t => {
  const f = mount(t); await f.session(0); f.window.emit("blur"); f.click("重新核对会话与资料");
  await f.respond(1, "invalid", 401, true); assert.deepEqual(f.events, []); await f.ready(); assert.match(f.text(), /SYNTHETIC PRIVATE DIRECTORY/);
  f.click("重新核对会话与资料"); const start = f.requests.length - 1; await f.session(start); await f.respond(start + 1, "invalid", 401, true);
  assert.deepEqual(f.events, [SESSION_INVALIDATED_EVENT]); assert.doesNotMatch(f.text(), /SYNTHETIC PRIVATE/);
});

test("read rejection and restore read-only state never authorize submission", async t => {
  const f = mount(t); await f.ready(); f.fill(); const submit = f.control("form").props.onSubmit as (event: unknown) => void;
  f.click("重新核对会话与资料"); const start = f.requests.length - 1; await f.respond(start, { error: "AUTH_UNAVAILABLE" }, 503);
  assert.doesNotMatch(f.text(), /SYNTHETIC PRIVATE/);
  const staleProbe = f.requests.length; submit({ preventDefault() {} });
  if (f.requests.length > staleProbe) await f.session(staleProbe);
  assert.equal(f.postRequests().length, 0);
  f.click("重新核对会话与资料"); await f.ready({ ...initial(), read_only: true });
  assert.match(f.text(), /恢复\/只读模式/); assert.equal(f.checkbox().props.disabled, true);
  f.submit(); assert.equal(f.postRequests().length, 0);
});

test("invalid private JSON never escapes via parser error and remains concealed after blur", async t => {
  const f = mount(t); await f.ready(); f.fill("SYNTHETIC_PRIVATE_SOURCE_MARKER"); f.submit(); await f.session(3); await f.flush();
  assert.equal(f.postRequests().length, 0); assert.doesNotMatch(f.text(), /Unexpected token|SYNTHETIC_|SOURCE_MARKER/);
  assert.match(f.text(), /MARKET_INVALID_JSON/); f.window.emit("blur"); assert.doesNotMatch(f.text(), /SYNTHETIC_|SOURCE_MARKER/);
});

test("malformed network JSON is reduced to a safe code without exposing response fragments", async t => {
  const f = mount(t); await f.session(0); await f.respond(1, "SYNTHETIC_RESPONSE_FRAGMENT", 200, true);
  assert.doesNotMatch(f.text(), /SYNTHETIC_RESPONSE|Unexpected token/); assert.equal(f.postRequests().length, 0);
  assert.match(f.text(), /MARKET_RESPONSE_INVALID/);
  const g = mount(t); await g.ready(); g.fill(); g.submit(); await g.session(3); await g.waitForRequest(4);
  await g.respond(4, "SYNTHETIC_RESPONSE_FRAGMENT", 200, true);
  assert.doesNotMatch(g.text(), /SYNTHETIC_RESPONSE|Unexpected token/); assert.match(g.text(), /MARKET_RESPONSE_INVALID/);
  assert.equal(g.beforeUnload().defaultPrevented, true); assert.equal(g.postRequests().length, 1);
});

test("wrong successful source receipt retains frozen retry rather than clearing the original", async t => {
  const f = mount(t); await f.ready(); f.fill(); f.submit(); await f.session(3); const request = await f.waitForRequest(4);
  await f.respond(4, { id: "source", audit_id: "audit", portfolio_id: "p", session_binding: binding, content_hash: other, verification_status: "unreviewed" });
  assert.match(f.text(), /MARKET_RECEIPT_INVALID/); assert.equal(f.beforeUnload().defaultPrevented, true);
  assert.equal(f.postRequests().length, 1); assert.ok(f.all().some(row => row.type === "pre" && row.props.children === request.options!.body));
});
