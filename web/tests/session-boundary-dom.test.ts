import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as stateHelpers from "../src/components/session-boundary-state";

type Tree = { type: unknown; props: Record<string, unknown> };
type Effect = () => void | (() => void);
type Listener = (event: Record<string, unknown>) => void;
const binding = "a".repeat(64), other = "b".repeat(64);
const compiled = ts.transpileModule(readFileSync(new URL("../src/components/session-boundary.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Deterministic component event/DOM harness, not a browser or BFCache acceptance test.
function mount(t: { after: (callback: () => void) => void }) {
  class Surface {
    listeners = new Map<string, Set<Listener>>();
    addEventListener(type: string, listener: Listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(listener); }
    removeEventListener(type: string, listener: Listener) { this.listeners.get(type)?.delete(listener); }
    emit(type: string, event: Record<string, unknown> = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  }
  class MemoryStorage {
    values = new Map([[`${stateHelpers.CSV_RECOVERY_POINTER_PREFIX}synthetic`, "opaque-batch-id"], ["theme", "dark"]]);
    get length() { return this.values.size; }
    key(index: number) { return [...this.values.keys()][index] ?? null; }
    setItem(key: string, value: string) { this.values.set(key, value); }
    removeItem(key: string) { this.values.delete(key); }
  }
  class Form { constructor(public action: string) {} }
  class ClientEvent { constructor(public type: string, public detail: Record<string, unknown>) {} }
  const document = Object.assign(new Surface(), { visibilityState: "visible" });
  const navigation: string[] = [], emitted: { type: string; detail: unknown }[] = [];
  const window = Object.assign(new Surface(), {
    location: { href: "https://workbench.example.test/workbench", origin: "https://workbench.example.test", replace: (url: string) => navigation.push(url), reload: () => navigation.push("reload") },
    localStorage: new MemoryStorage(), sessionStorage: new MemoryStorage(), crypto: { randomUUID: () => "synthetic-logout-nonce-1234" },
    dispatchEvent(event: ClientEvent) { emitted.push(event); window.emit(event.type, { detail: event.detail }); return true; },
  });
  const broadcasts: unknown[] = [], channels: Channel[] = [];
  class Channel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor() { channels.push(this); }
    postMessage(value: unknown) { broadcasts.push(value); }
    close() {}
  }
  const dom = { style: { visibility: "hidden", display: "none" }, inert: true, attributes: new Map<string, string>(), setAttribute(name: string, value: string) { this.attributes.set(name, value); } };
  const requests: { signal: AbortSignal; resolve: (response: { status: number; json: () => Promise<unknown> }) => void; reject: (reason: Error) => void }[] = [];
  const hooks: unknown[] = []; let cursor = 0, effect: Effect | undefined, layouts: Effect[] = [], tree: Tree;
  const visit = (value: unknown, operation: (node: Tree) => void) => {
    if (Array.isArray(value)) { value.forEach(item => visit(item, operation)); return; }
    if (!value || typeof value !== "object" || !("props" in value)) return;
    const node = value as Tree; operation(node); visit(node.props.children, operation);
  };
  let render: () => void;
  const react = {
    createContext: () => ({ Provider: "provider" }), useContext: () => null,
    useState(initial: () => unknown) {
      const index = cursor++; if (!(index in hooks)) hooks[index] = initial();
      return [hooks[index], (value: unknown) => { hooks[index] = value; render(); }];
    },
    useRef(initial: unknown) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index]; },
    useEffect(callback: Effect) { effect ??= callback; }, useLayoutEffect(callback: Effect) { layouts.push(callback); },
  };
  const dependencies: Record<string, unknown> = { react, "react/jsx-runtime": { jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }), jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }) }, "./session-boundary-state": stateHelpers };
  const module = { exports: {} as { SessionBoundary: (props: { initialBinding: string; children: string }) => Tree } };
  const initialize = runInNewContext(`(function(require,module,exports){${compiled}\n})`, {
    window, document, HTMLFormElement: Form, CustomEvent: class extends ClientEvent { constructor(type: string, options: { detail: Record<string, unknown> }) { super(type, options.detail); } },
    BroadcastChannel: Channel, AbortController, URL, setTimeout, clearTimeout,
    fetch: (_url: string, options: { signal: AbortSignal }) => new Promise((resolve, reject) => requests.push({ signal: options.signal, resolve, reject })),
  }) as (require: (id: string) => unknown, module: unknown, exports: unknown) => void;
  initialize(id => { assert.ok(id in dependencies, id); return dependencies[id]; }, module, module.exports);
  render = () => {
    cursor = 0; layouts = []; tree = module.exports.SessionBoundary({ initialBinding: binding, children: "Synthetic protected content" });
    visit(tree, node => { if (node.props["data-session-boundary-content"] !== undefined) (node.props.ref as { current: unknown }).current = dom; });
    for (const layout of layouts) layout();
  };
  render(); const cleanup = effect!(); t.after(() => { if (cleanup) cleanup(); });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  return { dom, document, window, Form, navigation, requests, emitted, channels, broadcasts,
    verified: () => (tree.props.value as { verified: boolean }).verified,
    response: async (index: number, status: number, session_binding = binding) => { requests[index].resolve({ status, json: async () => ({ authenticated: true, session_binding }) }); await flush(); },
    failure: async (index: number) => { requests[index].reject(new Error("Synthetic connection loss")); await flush(); },
    retry: () => { let click: (() => void) | undefined; visit(tree, node => { if (node.type === "button") click = node.props.onClick as () => void; }); assert.ok(click); click(); },
  };
}

test("component pagehide hides synchronously and cancels stale replies; pageshow must freshly verify", async t => {
  const f = mount(t); assert.equal(f.dom.style.visibility, "hidden"); assert.equal(f.verified(), false);
  await f.response(0, 200); assert.equal(f.dom.style.display, ""); assert.equal(f.verified(), true);
  f.window.emit("pageshow"); const old = f.requests.length - 1;
  f.window.emit("pagehide"); assert.equal(f.dom.style.visibility, "hidden"); assert.equal(f.dom.inert, true); assert.equal(f.requests[old].signal.aborted, true);
  await f.response(old, 200); assert.equal(f.dom.style.display, "none"); assert.equal(f.verified(), false);
  f.window.emit("pageshow"); await f.response(f.requests.length - 1, 200); assert.equal(f.verified(), true);
  f.document.visibilityState = "hidden"; f.document.emit("visibilitychange"); assert.equal(f.dom.style.display, "none"); assert.equal(f.dom.attributes.get("aria-hidden"), "true");
});

test("component 401 clears only recovery pointers, emits invalidation once and replaces login", async t => {
  const f = mount(t); await f.response(0, 401);
  assert.deepEqual(f.navigation, ["/login"]); assert.equal(f.dom.style.display, "none"); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.emitted.map(event => event.type), [stateHelpers.SESSION_INVALIDATED_EVENT]);
  for (const store of [f.window.localStorage, f.window.sessionStorage]) assert.deepEqual([...store.values], [["theme", "dark"]]);
});

test("component changed binding reloads SSR without exposing the old financial subtree", async t => {
  const f = mount(t); await f.response(0, 200, other);
  assert.deepEqual(f.navigation, ["reload"]); assert.equal(f.verified(), false); assert.equal(f.dom.inert, true); assert.equal(f.emitted.length, 1);
});

test("component transport failure remains hidden, does not claim logout and permits explicit retry", async t => {
  const f = mount(t); await f.failure(0);
  assert.deepEqual(f.navigation, []); assert.deepEqual(f.emitted, []); assert.equal(f.dom.style.display, "none");
  f.retry(); await f.response(1, 200); assert.equal(f.verified(), true); assert.equal(f.dom.inert, false);
});

test("captured native logout hides immediately and emits only an anonymous cross-tab hint", async t => {
  const f = mount(t); await f.response(0, 200);
  const event = { target: new f.Form("https://workbench.example.test/api/auth/logout"), defaultPrevented: false };
  f.document.emit("submit", event);
  assert.equal(f.dom.style.display, "none"); assert.equal(event.defaultPrevented, false); assert.deepEqual(f.navigation, []);
  assert.deepEqual(JSON.parse(JSON.stringify(f.broadcasts)), [{ type: "logout", nonce: "synthetic-logout-nonce-1234" }]); assert.equal(f.emitted.length, 1);
});

test("received logout hint cannot automatically reshow even if its first probe outruns server revocation", async t => {
  const f = mount(t); await f.response(0, 200);
  f.channels[0].onmessage!({ data: { type: "logout", nonce: "another-synthetic-nonce" } });
  assert.equal(f.dom.style.display, "none"); await f.response(1, 200); assert.equal(f.verified(), false);
  f.retry(); await f.response(2, 200); assert.equal(f.verified(), true);
});

test("external invalidation from recovery UI hides and reprobes without recursively probing its own event", async t => {
  const f = mount(t); await f.response(0, 200);
  f.window.emit(stateHelpers.SESSION_INVALIDATED_EVENT, { detail: { reason: "changed" } });
  assert.equal(f.dom.style.visibility, "hidden"); assert.equal(f.requests.length, 2);
  await f.response(1, 401); assert.equal(f.requests.length, 2); assert.deepEqual(f.navigation, ["/login"]);
});
