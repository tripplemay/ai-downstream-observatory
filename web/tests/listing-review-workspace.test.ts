import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as client from "../src/components/workbench/listing-review-client";
import { parseStrictJson } from "../src/server/strict-json";
import { SESSION_INVALIDATED_EVENT } from "../src/components/session-boundary-state";
import type { ListingReviewState } from "../src/server/listing-reviews/types";

type Tree = { type: unknown; props: Record<string, unknown> };
type Listener = (event: Record<string, unknown>) => void;
type Effect = () => void | (() => void);
function queue<T>() {
  const items: T[] = [], waiting = new Map<number, Array<(value: T) => void>>();
  return { items, push(value: T) { const index = items.length; items.push(value); for (const resolve of waiting.get(index) ?? []) resolve(value); waiting.delete(index); },
    at(index: number): Promise<T> { if (index < items.length) return Promise.resolve(items[index]); return new Promise(resolve => waiting.set(index, [...(waiting.get(index) ?? []), resolve])); } };
}
const binding = "a".repeat(64), otherBinding = "b".repeat(64), at = "2026-09-01T00:00:00.000000Z";
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object"
  ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
const hash = (value: unknown) => createHash("sha256").update(canonical(value), "utf8").digest("hex");
function initial(portfolio = "p", listing: string | null = null): ListingReviewState {
  const identity = { listing_id: "CN:SYNTH", instrument_id: "synthetic-fund", market: "CN" as const, exchange: "SYNTH", ticker: "001234", currency: "CNY" };
  const row = { identity, identity_hash: hash(identity), name: "SYNTHETIC ETF IDENTITY", review_revision: 0, quality: "blocked" as const, issues: ["LISTING_REVIEW_MISSING"], current: null };
  return { schema_version: "listing-review-state-v1", portfolios: [{ id: "p", name: "SYNTHETIC SCOPE A" }, { id: "p2", name: "SYNTHETIC SCOPE B" }], portfolios_truncated: false,
    selected_portfolio_id: portfolio, selected_listing_id: listing, catalog_revision: 1, read_only: false, checked_at: at, resource_hash: "d".repeat(64),
    rows: [row], selected: listing ? row : null, next_cursor: null,
    sources: [{ id: "synthetic-source", portfolio_id: portfolio, reference: "SYNTHETIC PRIVATE REFERENCE", content_hash: "c".repeat(64), known_at: at, created_by: "synthetic-human" }],
    sources_truncated: false, history: [], history_truncated: false };
}
const compiled = ts.transpileModule(readFileSync(new URL("../src/components/workbench/listing-review-workspace.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Real component callbacks with controlled effects, not native browser/BFCache evidence.
function mount(t: { after(callback: () => void): void }, options: { delayedReceipt?: boolean; verified?: boolean; binding?: string } = {}) {
  class Surface {
    listeners = new Map<string, Set<Listener>>();
    addEventListener(type: string, callback: Listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(callback); }
    removeEventListener(type: string, callback: Listener) { this.listeners.get(type)?.delete(callback); }
    emit(type: string, event: Record<string, unknown> = {}) { for (const callback of this.listeners.get(type) ?? []) callback(event); }
  }
  class Element { closest(_selector: string): Element | null { return null; } }
  class Anchor extends Element {
    href: string; target: string; download = "";
    constructor(href: string, target = "") { super(); this.href = new URL(href, "https://synthetic.invalid/workbench/market/listings").href; this.target = target; }
    closest(_selector: string) { return this; }
    hasAttribute(name: string) { return name === "download" && this.download !== ""; }
  }
  const document = Object.assign(new Surface(), { visibilityState: "visible" });
  let confirmResult = false;
  const prompts: string[] = [], events: string[] = [];
  const window = Object.assign(new Surface(), { location: new URL("https://synthetic.invalid/workbench/market/listings"),
    confirm(message: string) { prompts.push(message); return confirmResult; },
    dispatchEvent(event: { type: string }) { events.push(event.type); window.emit(event.type, event); return true; } });
  const network = queue<{ url: string; options?: RequestInit; resolve(response: Response): void; reject(reason: Error): void }>();
  type Receipt = Awaited<ReturnType<typeof client.assertListingReviewReceipt>>;
  const receipts = queue<{ actual: Promise<Receipt>; release(value: Receipt): void }>();
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
    "./listing-review-client": { ...client, assertListingReviewReceipt: (...args: Parameters<typeof client.assertListingReviewReceipt>) => {
      const actual = client.assertListingReviewReceipt(...args);
      return options.delayedReceipt ? new Promise<Receipt>(release => receipts.push({ actual, release })) : actual;
    } } };
  const module = { exports: {} as { ListingReviewWorkspace(props: unknown): Tree } };
  const execute = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { window, document, URL, URLSearchParams, Element, HTMLAnchorElement: Anchor,
    TextEncoder, TextDecoder, crypto, Error, CustomEvent: class { constructor(public type: string) {} },
    fetch: (url: string, options?: RequestInit) => new Promise((resolve, reject) => network.push({ url, options, resolve, reject })),
  }) as (require: (id: string) => unknown, module: unknown, exports: unknown) => void;
  execute(id => { assert.ok(id in dependencies, id); return dependencies[id]; }, module, module.exports);
  render = () => {
    if (rendering) return; rendering = true; cursor = 0; effectCursor = 0;
    tree = module.exports.ListingReviewWorkspace({ initialSessionBinding: pageBinding }); rendering = false;
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
  const click = (label: string) => { const node = control("button", row => text(row).replace(/\s+/g, " ").trim() === label); assert.equal(!!node.props.disabled, false); (node.props.onClick as () => void)(); };
  const submit = () => (control("form").props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
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
  return { context, document, window, events, prompts, all, control, named, checkbox, change, click, submit, text, ready, load, respond, session, flush, render,
    requests: network.items, waitForRequest: network.at, waitForReceipt: receipts.at, beforeUnload, navigate,
    setConfirm(value: boolean) { confirmResult = value; }, setPageBinding(value: string) { pageBinding = value; render(); },
    postRequests: () => network.items.filter(item => item.options?.method === "POST"),
    async reject(index: number) { (await network.at(index)).reject(new Error("Synthetic network loss")); await flush(); },
    async releaseReceipt(index = 0) { const item = await receipts.at(index), result = await item.actual; item.release(result); await flush(); return result; } };
}

type Fixture = ReturnType<typeof mount>;
async function selected(f: Fixture, value = initial("p", "CN:SYNTH")) {
  await f.ready(); f.click("选择 001234"); await f.ready(value);
}
function fill(f: Fixture) {
  f.change(f.named("input", "审核来源ID"), "synthetic-source");
  for (const [label, value] of [["证券种类", "ETF"], ["挂牌生命周期", "active"], ["杠杆结构", "unleveraged"], ["方向结构", "long_only"]]) f.change(f.named("select", label), value);
  for (const [label, value] of [["数量步长（空白为未知）", "100"], ["价格步长（空白为未知）", "0.000000000000000001"],
    ["审核失效时刻 UTC，含六位小数", "2026-10-01T00:00:00.000000Z"], ["本次人工核实理由", "SYNTHETIC PRIVATE REVIEW REASON"]]) f.change(f.named("input", label), value);
  f.change(f.checkbox(), true);
}
function receipt(body: string, sessionBinding = binding) {
  const command = JSON.parse(body).command;
  const document = { schema_version: "listing-review-v1", id: "synthetic-review-receipt", portfolio_id: command.portfolio_id,
    listing_id: command.listing_id, revision: command.expected_review_revision + 1, source_id: command.source_id, source_hash: command.source_hash,
    source_known_at: at, identity_snapshot: initial().rows[0].identity, identity_hash: command.expected_identity_hash,
    known_at: "2026-09-01T00:00:00.000001Z", created_by: "synthetic-human", review_until: command.review_until,
    reason: command.reason, review_basis: "human_reviewed_not_provider_verified", facts: command.facts };
  return { id: document.id, portfolio_id: document.portfolio_id, listing_id: document.listing_id, revision: document.revision,
    content_hash: hash(document), identity_hash: document.identity_hash, source_id: document.source_id, source_hash: document.source_hash,
    known_at: document.known_at, review_until: document.review_until, review_basis: document.review_basis, audit_id: "synthetic-audit",
    document, session_binding: sessionBinding };
}

test("initial private directory is hidden until same-session probes and new review has no implicit facts or financial defaults", async t => {
  for (const options of [{ verified: false }, { binding: otherBinding }]) {
    const f = mount(t, options); assert.equal(f.requests.length, 0); assert.doesNotMatch(f.text(), /SYNTHETIC ETF|SYNTHETIC SCOPE/);
  }
  const f = mount(t); await selected(f);
  for (const label of ["证券种类", "挂牌生命周期", "杠杆结构", "方向结构"]) assert.equal(f.named("select", label).props.value, "");
  for (const label of ["审核来源ID", "来源原字节 SHA256", "数量步长（空白为未知）", "价格步长（空白为未知）", "审核失效时刻 UTC，含六位小数", "本次人工核实理由"]) assert.equal(f.named("input", label).props.value, "");
  assert.equal(f.checkbox().props.checked, false); assert.equal(f.postRequests().length, 0);
  assert.match(f.text(), /不是行情供应商认证、账户可买性、策略准入或投资批准/);
  assert.match(f.text(), /没有默认有效期/);
});

test("explicit reason and acknowledgement are required and any field edit revokes confirmation", async t => {
  const f = mount(t); await selected(f); fill(f);
  f.change(f.named("input", "本次人工核实理由"), "Changed synthetic reason"); assert.equal(f.checkbox().props.checked, false);
  const untouched = f.requests.length; f.submit(); assert.equal(f.requests.length, untouched);
  f.change(f.named("input", "本次人工核实理由"), "   "); f.change(f.checkbox(), true); f.submit(); await f.session(untouched);
  assert.equal(f.postRequests().length, 0); assert.match(f.text(), /LISTING_REVIEW_INVALID_COMMAND/);
});

test("pre-submit session probe cannot publish after hide or a boundary SID switch", async t => {
  for (const cause of ["blur", "hidden", "sid"] as const) {
    const f = mount(t); await selected(f); fill(f); const start = f.requests.length; f.submit(); f.submit();
    assert.equal(f.requests.length, start + 1);
    if (cause === "blur") f.window.emit("blur");
    if (cause === "hidden") { f.document.visibilityState = "hidden"; f.document.emit("visibilitychange"); }
    if (cause === "sid") { f.context.sessionBinding = otherBinding; f.render(); }
    await f.session(start); assert.equal(f.postRequests().length, 0, cause); assert.doesNotMatch(f.text(), /PRIVATE REVIEW REASON|SYNTHETIC ETF/);
  }
});

test("lost response retains exact identity hash, original revision, decimal strings and idempotency after same-SID refresh", async t => {
  const f = mount(t); await selected(f); fill(f); const start = f.requests.length; f.submit(); await f.session(start);
  const request = await f.waitForRequest(start + 1), body = request.options!.body as string, command = JSON.parse(body).command;
  assert.equal(command.expected_identity_hash, initial().rows[0].identity_hash); assert.equal(command.expected_review_revision, 0);
  assert.equal(command.facts.price_step, "0.000000000000000001"); assert.equal(command.facts.fund_identifier, null);
  assert.deepEqual(command.facts.product_structure, { leverage: "unleveraged", direction: "long_only" });
  await f.reject(start + 1); assert.equal(f.named("select", "身份审核组合").props.disabled, true);
  const updated = initial("p", "CN:SYNTH"); updated.selected!.review_revision = 9;
  updated.selected!.identity = { ...updated.selected!.identity, ticker: "009999" }; updated.selected!.identity_hash = hash(updated.selected!.identity);
  f.click("重新核对会话与身份审核"); await f.ready(updated); assert.equal(f.postRequests().length, 1); assert.equal(f.checkbox().props.checked, false);
  const retry = f.requests.length; f.change(f.checkbox(), true); f.submit(); await f.session(retry);
  const resent = await f.waitForRequest(retry + 1); assert.equal(resent.options!.body, body);
  assert.equal(new Headers(resent.options!.headers).get("X-Workbench-Session-Binding"), binding);
});

test("receipt hash await cannot reveal or accept an old operation after blur, hidden document or session invalidation", async t => {
  for (const cause of ["blur", "hidden", "invalidated"] as const) {
    const f = mount(t, { delayedReceipt: true }); await selected(f); fill(f); const start = f.requests.length; f.submit(); await f.session(start);
    const request = await f.waitForRequest(start + 1); await f.respond(start + 1, receipt(request.options!.body as string));
    await (await f.waitForReceipt(0)).actual;
    if (cause === "blur") f.window.emit("blur");
    if (cause === "hidden") { f.document.visibilityState = "hidden"; f.document.emit("visibilitychange"); }
    if (cause === "invalidated") f.window.dispatchEvent({ type: SESSION_INVALIDATED_EVENT });
    const count = f.requests.length; await f.releaseReceipt(); assert.equal(f.requests.length, count);
    assert.doesNotMatch(f.text(), /synthetic-review-receipt|PRIVATE REVIEW REASON|SYNTHETIC ETF/);
    if (cause === "invalidated") assert.equal(f.beforeUnload().defaultPrevented, false);
  }
});

test("bad receipt hash keeps pending; valid exact receipt requires a post-response probe and never sends another POST", async t => {
  const f = mount(t); await selected(f); fill(f); const start = f.requests.length; f.submit(); await f.session(start);
  const original = (await f.waitForRequest(start + 1)).options!.body as string;
  await f.respond(start + 1, { ...receipt(original), content_hash: "e".repeat(64) });
  assert.equal(f.postRequests().length, 1); assert.match(f.text(), /LISTING_REVIEW_RESPONSE_INVALID/); assert.equal(f.beforeUnload().defaultPrevented, true);
  f.change(f.checkbox(), true); const retry = f.requests.length; f.submit(); await f.session(retry);
  assert.equal((await f.waitForRequest(retry + 1)).options!.body, original); await f.respond(retry + 1, receipt(original));
  assert.doesNotMatch(f.text(), /原文与身份 hash 已核验的审核回执/);
  await f.session(retry + 2); await f.ready(initial("p", "CN:SYNTH"));
  assert.match(f.text(), /原文与身份 hash 已核验的审核回执/); assert.equal(f.postRequests().length, 2);
  assert.equal(f.checkbox().props.checked, false); assert.equal(f.beforeUnload().defaultPrevented, false);
});

test("POST 401 invalidates before parsing a broken response body and removes pending memory", async t => {
  const f = mount(t); await selected(f); fill(f); const start = f.requests.length; f.submit(); await f.session(start);
  await f.respond(start + 1, "SYNTHETIC SENSITIVE BROKEN BODY", 401, true);
  assert.deepEqual(f.events, [SESSION_INVALIDATED_EVENT]); assert.equal(f.beforeUnload().defaultPrevented, false);
  assert.doesNotMatch(f.text(), /PRIVATE REVIEW REASON|BROKEN BODY|SYNTHETIC ETF/);
});

test("successful HTTP responses from a changed SID invalidate rather than retaining private pending state", async t => {
  for (const stage of ["get", "post"] as const) {
    const f = mount(t); await selected(f); fill(f); const start = f.requests.length;
    if (stage === "get") {
      f.click("重新核对会话与身份审核"); await f.session(start);
      await f.respond(start + 1, { ...initial("p", "CN:SYNTH"), session_binding: otherBinding });
    } else {
      f.submit(); await f.session(start); const request = await f.waitForRequest(start + 1);
      await f.respond(start + 1, receipt(request.options!.body as string, otherBinding));
    }
    assert.deepEqual(f.events, [SESSION_INVALIDATED_EVENT], stage);
    assert.doesNotMatch(f.text(), /SYNTHETIC ETF|PRIVATE REVIEW REASON/); assert.equal(f.beforeUnload().defaultPrevented, false);
  }
});

test("503 or blur retains an exact pending attempt but requires verified read and a new human confirmation", async t => {
  const f = mount(t); await selected(f); fill(f); const start = f.requests.length; f.submit(); await f.session(start);
  const original = (await f.waitForRequest(start + 1)).options!.body;
  await f.respond(start + 1, { error: "WORKBENCH_UNAVAILABLE" }, 503); assert.equal(f.events.length, 0);
  f.window.emit("blur"); assert.doesNotMatch(f.text(), /PRIVATE REVIEW REASON|SYNTHETIC ETF/);
  f.click("重新核对会话与身份审核"); await f.ready(initial("p", "CN:SYNTH")); assert.equal(f.postRequests().length, 1);
  assert.equal(f.checkbox().props.checked, false); const retry = f.requests.length;
  f.change(f.checkbox(), true); f.submit(); await f.session(retry); assert.equal((await f.waitForRequest(retry + 1)).options!.body, original);
});

test("same-tab navigation warns for pending while downloads, new tabs and logout invalidation are not blocked", async t => {
  const f = mount(t); await selected(f); fill(f); const start = f.requests.length; f.submit(); await f.session(start); await f.reject(start + 1);
  assert.equal(f.beforeUnload().defaultPrevented, true); assert.equal(f.navigate("/workbench").defaultPrevented, true);
  assert.equal(f.navigate("/workbench", "_blank").defaultPrevented, false);
  assert.equal(f.navigate("/source", "", { download: true }).defaultPrevented, false);
  assert.equal(f.navigate("#source").defaultPrevented, false);
  f.setConfirm(true); assert.equal(f.navigate("/workbench").defaultPrevented, false);
  f.window.dispatchEvent({ type: SESSION_INVALIDATED_EVENT }); assert.equal(f.beforeUnload().defaultPrevented, false);
  assert.equal(f.navigate("/login").defaultPrevented, false);
});

test("read-only state and rejected reads lock mutations without inventing a review or auto retry", async t => {
  const f = mount(t), readOnly = initial("p", "CN:SYNTH"); readOnly.read_only = true; await selected(f, readOnly); fill(f);
  const count = f.requests.length; f.submit(); assert.equal(f.requests.length, count); assert.equal(f.postRequests().length, 0);
  assert.match(f.text(), /恢复\/只读模式/);
  f.click("重新核对会话与身份审核"); await f.session(count); await f.respond(count + 1, { error: "WORKBENCH_UNAVAILABLE" }, 503);
  assert.equal(f.postRequests().length, 0); assert.doesNotMatch(f.text(), /SYNTHETIC ETF/);
});

test("A-B-A scope race ignores obsolete unauthorized responses and pagination remains a read of the selected scope", async t => {
  const f = mount(t); await f.ready(); const original = f.named("select", "身份审核组合"), start = f.requests.length;
  f.change(original, "p2"); f.change(original, "p");
  await f.respond(start, "obsolete malformed body", 401, true); assert.equal(f.events.length, 0);
  const page = initial(); page.next_cursor = "opaque+/=cursor"; await f.load(start + 1, page);
  assert.match(f.text(), /SYNTHETIC SCOPE A/); const next = f.requests.length; f.click("读取下一页目录"); await f.session(next);
  const request = await f.waitForRequest(next + 1), url = new URL(request.url, "https://synthetic.invalid");
  assert.equal(url.searchParams.get("portfolio"), "p"); assert.equal(url.searchParams.get("cursor"), page.next_cursor);
  assert.equal(f.postRequests().length, 0);
  await f.respond(next + 1, { ...initial("p2"), session_binding: binding }); assert.doesNotMatch(f.text(), /SYNTHETIC ETF/);
});
