import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as client from "../src/components/workbench/verification-client";
import { parseStrictJson } from "../src/server/strict-json";
import { SESSION_INVALIDATED_EVENT } from "../src/components/session-boundary-state";
import { verificationArtifactBody, verificationArtifactSha256, verificationBinding as binding, verificationOtherBinding as otherBinding, verificationReceipt, verificationState } from "./verification-test-fixture";

type Tree = { type: unknown; props: Record<string, unknown> };
type Listener = (event: Record<string, unknown>) => void;
type Effect = () => void | (() => void);
function queue<T>() {
  const items: T[] = [], waiting = new Map<number, ((value: T) => void)[]>();
  return { items, push(value: T) { const i = items.length; items.push(value); for (const resolve of waiting.get(i) ?? []) resolve(value); waiting.delete(i); },
    at(i: number): Promise<T> { return i < items.length ? Promise.resolve(items[i]) : new Promise(resolve => waiting.set(i, [...(waiting.get(i) ?? []), resolve])); } };
}
const compiled = ts.transpileModule(readFileSync(new URL("../src/components/workbench/verification-workspace.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Real component callbacks with controlled network/effects; not native browser evidence.
function mount(t: { after(callback: () => void): void }, options: { verified?: boolean; sessionBinding?: string } = {}) {
  class Surface {
    listeners = new Map<string, Set<Listener>>();
    addEventListener(type: string, callback: Listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(callback); }
    removeEventListener(type: string, callback: Listener) { this.listeners.get(type)?.delete(callback); }
    emit(type: string, event: Record<string, unknown> = {}) { for (const callback of this.listeners.get(type) ?? []) callback(event); }
  }
  const downloads: { href: string; download: string; blob: Blob | undefined }[] = [], blobs = new Map<string, Blob>(), revoked: string[] = [], timers: ReturnType<typeof setTimeout>[] = [];
  const document = Object.assign(new Surface(), { visibilityState: "visible", body: { appendChild() {} }, createElement(type: string) {
    assert.equal(type, "a"); return { href: "", download: "", click() { downloads.push({ href: this.href, download: this.download, blob: blobs.get(this.href) }); }, remove() {} };
  } }), events: string[] = [];
  const window = Object.assign(new Surface(), { confirm: () => true, dispatchEvent(event: { type: string }) { events.push(event.type); window.emit(event.type, event); return true; } });
  const network = queue<{ url: string; options?: RequestInit; resolve(response: Response): void; reject(reason: Error): void }>();
  const validations = queue<{ actual: ReturnType<typeof client.assertVerificationState>; release(value: Awaited<ReturnType<typeof client.assertVerificationState>>): void }>();
  const artifactGates = queue<() => void>();
  let holdValidation = false, holdArtifactValidation = false;
  const hooks: unknown[] = [], effects: { dependencies: unknown[]; cleanup?: () => void }[] = [], queued: { slot: number; callback: Effect }[] = [];
  const renderListeners = new Set<() => void>();
  let cursor = 0, effectCursor = 0, tree: Tree, rendering = false, render: () => void, pageBinding = binding;
  const context = { verified: options.verified ?? true, sessionBinding: options.sessionBinding ?? binding };
  const react = {
    useState(value: unknown) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof value === "function" ? value() : value;
      return [hooks[i], (next: unknown) => { const resolved = typeof next === "function" ? next(hooks[i]) : next; if (Object.is(resolved, hooks[i])) return; hooks[i] = resolved; render(); }]; },
    useRef(value: unknown) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: value }; return hooks[i]; },
    useEffect(callback: Effect, dependencies: unknown[]) { const slot = effectCursor++, old = effects[slot];
      if (!old || dependencies.some((value, i) => !Object.is(value, old.dependencies[i]))) { old?.cleanup?.(); effects[slot] = { dependencies }; queued.push({ slot, callback }); } },
  };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const dependencies: Record<string, unknown> = { react, "react/jsx-runtime": { jsx, jsxs: jsx },
    "@/components/session-boundary": { useSessionBoundary: () => context }, "@/components/session-boundary-state": { SESSION_INVALIDATED_EVENT },
    "@/server/strict-json": { parseStrictJson }, "./verification-client": { ...client, assertVerificationState: (...args: Parameters<typeof client.assertVerificationState>) => {
      const actual = client.assertVerificationState(...args); return holdValidation ? new Promise(resolve => validations.push({ actual, release: resolve })) : actual;
    }, readVerificationArtifact: (...args: Parameters<typeof client.readVerificationArtifact>) => {
      const actual = client.readVerificationArtifact(...args); if (!holdArtifactValidation) return actual;
      const gate = new Promise<void>(resolve => artifactGates.push(resolve));
      return actual.then(async value => { await gate; return value; }, async error => { await gate; throw error; });
    } } };
  const module = { exports: {} as { VerificationWorkspace(props: unknown): Tree } };
  const execute = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { window, document, URLSearchParams, TextEncoder, TextDecoder, Error, crypto,
    URL: { createObjectURL(blob: Blob) { const url = `blob:synthetic/${blobs.size}`; blobs.set(url, blob); return url; }, revokeObjectURL(url: string) { revoked.push(url); blobs.delete(url); } },
    setTimeout(callback: () => void, delay: number) { const timer = setTimeout(callback, delay); timers.push(timer); return timer; },
    CustomEvent: class { constructor(public type: string) {} }, fetch: (url: string, options?: RequestInit) => new Promise((resolve, reject) => network.push({ url, options, resolve, reject })),
  });
  execute((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports);
  render = () => { if (rendering) return; rendering = true; cursor = 0; effectCursor = 0;
    tree = module.exports.VerificationWorkspace({ initialSessionBinding: pageBinding }); rendering = false;
    while (queued.length) { const item = queued.shift()!; const cleanup = item.callback(); if (cleanup) effects[item.slot].cleanup = cleanup; }
    for (const listener of renderListeners) listener();
  };
  render(); t.after(() => { effects.forEach(effect => effect.cleanup?.()); timers.forEach(clearTimeout); });
  const all = () => { const result: Tree[] = []; const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; } if (!value || typeof value !== "object" || !("props" in value)) return;
    const row = value as Tree; result.push(row); visit(row.props.children);
  }; visit(tree); return result; };
  const text = (node: Tree = tree): string => { const visit = (value: unknown): string => Array.isArray(value) ? value.map(visit).join(" ") : typeof value === "string" || typeof value === "number" ? String(value)
    : value && typeof value === "object" && "props" in value ? visit((value as Tree).props.children) : ""; return visit(node); };
  const control = (type: string, predicate: (node: Tree) => boolean = () => true) => { const found = all().find(row => row.type === type && predicate(row)); assert.ok(found, type); return found; };
  const named = (type: string, label: string) => control(type, row => row.props["aria-label"] === label);
  const checkbox = () => control("input", row => row.props.type === "checkbox");
  const change = (node: Tree, value: string | boolean) => (node.props.onChange as (event: unknown) => void)({ target: typeof value === "boolean" ? { checked: value } : { value } });
  const click = (label: string) => { const node = control("button", row => text(row).replace(/\s+/g, " ").trim() === label); assert.equal(!!node.props.disabled, false); (node.props.onClick as () => void)(); };
  const submit = () => (control("form").props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  const renderedText = (pattern: RegExp) => new Promise<void>((resolve, reject) => {
    const check = () => { if (pattern.test(text())) { clearTimeout(timeout); renderListeners.delete(check); resolve(); } };
    const timeout = setTimeout(() => { renderListeners.delete(check); reject(new Error(`Component never rendered ${pattern}: ${text()}`)); }, 10000);
    timers.push(timeout); renderListeners.add(check); check();
  });
  const respond = async (index: number, value: unknown, status = 200, raw = false) => { (await network.at(index)).resolve(new Response(raw ? value as string : JSON.stringify(value), { status })); await flush(); };
  const session = (index: number, value = binding) => respond(index, { authenticated: true, session_binding: value });
  const load = async (index: number, value = verificationState()) => { await session(index); await respond(index + 1, { ...value, session_binding: binding }); await session(index + 2); };
  const ready = async (value = verificationState()) => { const start = network.items.length - 1; await load(start, value); if (network.items.length === start + 4) await load(start + 3, value); };
  return { context, document, window, events, downloads, revoked, requests: network.items, all, text, control, named, checkbox, change, click, submit, flush, respond, session, load, ready, render, renderedText,
    posts: () => network.items.filter(row => row.options?.method === "POST"),
    async reject(index: number) { (await network.at(index)).reject(new Error("SYNTHETIC NETWORK FAILURE")); await flush(); },
    holdValidation(value: boolean) { holdValidation = value; }, async releaseValidation(index = 0) { const value = await validations.at(index); value.release(await value.actual); await flush(); },
    holdArtifactValidation(value: boolean) { holdArtifactValidation = value; }, async releaseArtifactValidation(index = 0) { (await artifactGates.at(index))(); },
    setPageBinding(value: string) { pageBinding = value; render(); },
    async artifact(index: number, body = verificationArtifactBody, responseBinding = binding) {
      (await network.at(index)).resolve(new Response(body, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="verification-artifact.json"',
        "X-Content-Type-Options": "nosniff", "X-Workbench-Session-Binding": responseBinding, "X-Artifact-SHA256": verificationArtifactSha256 } })); await flush();
    },
  };
}
type Fixture = ReturnType<typeof mount>;
function fill(f: Fixture, reason = "SYNTHETIC PRIVATE CHECK REASON") { f.change(f.named("textarea", "工程检查请求理由"), reason); f.change(f.checkbox(), true); }

test("initial GET is session guarded and never creates a check or supplies reason/confirmation defaults", async t => {
  for (const options of [{ verified: false }, { sessionBinding: otherBinding }]) { const f = mount(t, options); assert.equal(f.requests.length, 0); assert.doesNotMatch(f.text(), /SYNTHETIC SCOPE/); }
  const f = mount(t); await f.ready(); assert.equal(f.posts().length, 0); assert.equal(f.named("textarea", "工程检查请求理由").props.value, ""); assert.equal(f.checkbox().props.checked, false);
  assert.match(f.text(), /synthetic/); assert.match(f.text(), /engineering_subcheck/); assert.match(f.text(), /通过不代表完整 E-02、G-03、G-04、策略准入或生产验收/);
});
test("reason editing revokes confirmation and blank reason cannot reach POST", async t => {
  const f = mount(t); await f.ready(); fill(f); f.change(f.named("textarea", "工程检查请求理由"), "Changed synthetic reason"); assert.equal(f.checkbox().props.checked, false);
  const start = f.requests.length; f.submit(); assert.equal(f.requests.length, start); fill(f, "   "); f.submit(); await f.session(start);
  assert.equal(f.posts().length, 0); assert.match(f.text(), /VERIFICATION_COMMAND_INVALID/);
});
test("successful explicit submit displays a queued receipt, then separately reads actual verified execution", async t => {
  const f = mount(t); await f.ready(); fill(f); const start = f.requests.length; f.submit(); f.submit(); await f.session(start);
  assert.equal(f.posts().length, 1); const body = f.posts()[0].options!.body as string;
  assert.equal(JSON.parse(body).command.reason, "SYNTHETIC PRIVATE CHECK REASON"); assert.equal(JSON.parse(body).command.expected_context_hash, "c".repeat(64));
  await f.respond(start + 1, verificationReceipt(body)); await f.session(start + 2); await f.load(start + 3, verificationState("p", true));
  assert.match(f.text(), /服务端排队回执（不是执行通过）/); assert.match(f.text(), /真实执行结果： pass/); assert.equal(f.posts().length, 1);
  assert.equal(f.named("textarea", "工程检查请求理由").props.value, ""); assert.equal(f.checkbox().props.checked, false);
  assert.equal(f.all().filter(node => node.type === "a").length, 0); assert.match(f.text(), /下载私有执行原件/);
});
test("readonly and missing runtime states permit reads but prevent synthetic job creation", async t => {
  for (const unavailable of [false, true]) {
    const f = mount(t), data = verificationState(); data.read_only = !unavailable;
    if (unavailable) { data.check.available = false; data.check.context_hash = null; data.check.issues = ["VERIFICATION_SOURCE_UNAVAILABLE"]; }
    await f.ready(data); assert.equal(f.checkbox().props.disabled, true); assert.equal(f.named("textarea", "工程检查请求理由").props.disabled, true);
    fill(f); const before = f.requests.length; f.submit(); await f.flush();
    if (unavailable && f.requests.length > before) await f.session(before);
    assert.equal(f.posts().length, 0); assert.match(f.text(), unavailable ? /源码或运行包未就绪/ : /恢复\/只读模式/);
  }
});
test("uncertain POST preserves original context and exact bytes for manual retry without automatic resubmission", async t => {
  const f = mount(t); await f.ready(); fill(f); const start = f.requests.length; f.submit(); await f.session(start);
  const original = f.posts()[0].options!.body; await f.respond(start + 1, { error: "WORKBENCH_UNAVAILABLE" }, 503);
  assert.match(f.text(), /原请求保留，未自动重发/); assert.equal(f.posts().length, 1); assert.equal(f.named("textarea", "工程检查请求理由").props.disabled, true);
  const refresh = f.requests.length; f.click("刷新会话、任务与工件"); const changed = verificationState(); changed.check.context_hash = "f".repeat(64); await f.load(refresh, changed);
  f.change(f.checkbox(), true); const retry = f.requests.length; f.submit(); await f.session(retry); assert.equal(f.posts().length, 2); assert.equal(f.posts()[1].options!.body, original);
  await f.respond(retry + 1, verificationReceipt(original as string)); await f.session(retry + 2); await f.load(retry + 3, changed);
  assert.equal(f.posts().length, 2);
});
test("pre-submit blur and changed session cannot send stale queued work", async t => {
  for (const cause of ["blur", "binding"] as const) {
    const f = mount(t); await f.ready(); fill(f); const start = f.requests.length; f.submit();
    if (cause === "blur") { f.window.emit("blur"); await f.session(start); }
    else await f.session(start, otherBinding);
    assert.equal(f.posts().length, 0); assert.doesNotMatch(f.text(), /SYNTHETIC PRIVATE CHECK REASON/);
    if (cause === "binding") assert.ok(f.events.includes(SESSION_INVALIDATED_EVENT));
  }
});
test("401 invalidates before parsing a malformed response and a foreign-binding 200 is not displayed", async t => {
  for (const foreign of [false, true]) {
    const f = mount(t); await f.ready(); fill(f); const start = f.requests.length; f.submit(); await f.session(start);
    const body = f.posts()[0].options!.body as string;
    await f.respond(start + 1, foreign ? verificationReceipt(body, otherBinding) : "SYNTHETIC_PRIVATE_BODY", foreign ? 200 : 401, !foreign);
    assert.ok(f.events.includes(SESSION_INVALIDATED_EVENT)); assert.doesNotMatch(f.text(), /SYNTHETIC_PRIVATE_BODY|synthetic-request|SYNTHETIC SCOPE/);
  }
});
test("A-B-A scope switching clears reason and results, never carrying a prior request into another portfolio", async t => {
  const f = mount(t); await f.ready(verificationState("p", true)); fill(f);
  f.change(f.named("select", "工程检查组合"), "p2"); await f.ready(verificationState("p2"));
  assert.equal(f.named("textarea", "工程检查请求理由").props.value, ""); assert.equal(f.checkbox().props.checked, false); assert.doesNotMatch(f.text(), /synthetic-request|synthetic-artifact/);
  f.change(f.named("select", "工程检查组合"), "p"); await f.ready(); assert.equal(f.named("textarea", "工程检查请求理由").props.value, ""); assert.equal(f.posts().length, 0);
});
test("late validation or old session response cannot restore hidden private results", async t => {
  const f = mount(t); await f.ready(); const start = f.requests.length; f.click("刷新会话、任务与工件"); await f.session(start);
  f.holdValidation(true); await f.respond(start + 1, { ...verificationState("p", true), session_binding: binding }); f.window.emit("blur"); await f.releaseValidation();
  assert.doesNotMatch(f.text(), /synthetic-request|synthetic-artifact/); assert.equal(f.requests.length, start + 2);
  f.holdValidation(false); const next = f.requests.length; f.click("刷新会话、任务与工件"); await f.session(next);
  f.context.sessionBinding = otherBinding; f.setPageBinding(otherBinding);
  await f.respond(next + 1, { ...verificationState("p", true), session_binding: binding }); assert.doesNotMatch(f.text(), /synthetic-request|synthetic-artifact/);
});
test("a delayed A response remains stale after a complete A-B-A scope round trip", async t => {
  const f = mount(t); await f.ready(); const old = f.requests.length; f.click("刷新会话、任务与工件"); await f.session(old);
  f.holdValidation(true); const previous = verificationState("p", true); previous.requests[0].id = "synthetic-old-request";
  await f.respond(old + 1, { ...previous, session_binding: binding }); f.window.emit("blur"); f.holdValidation(false);
  const refresh = f.requests.length; f.click("刷新会话、任务与工件"); await f.load(refresh);
  f.change(f.named("select", "工程检查组合"), "p2"); await f.ready(verificationState("p2"));
  f.change(f.named("select", "工程检查组合"), "p"); await f.ready(); const before = f.requests.length;
  await f.releaseValidation(); assert.equal(f.requests.length, before); assert.doesNotMatch(f.text(), /synthetic-old-request|synthetic-artifact/); assert.equal(f.posts().length, 0);
});
test("current GET with foreign binding invalidates while a mismatched POST receipt remains an explicit unresolved request", async t => {
  const f = mount(t); await f.ready(); const refresh = f.requests.length; f.click("刷新会话、任务与工件"); await f.session(refresh);
  await f.respond(refresh + 1, { ...verificationState("p", true), session_binding: otherBinding }); assert.ok(f.events.includes(SESSION_INVALIDATED_EVENT)); assert.doesNotMatch(f.text(), /synthetic-artifact/);
  const other = mount(t); await other.ready(); fill(other); const start = other.requests.length; other.submit(); await other.session(start);
  const body = other.posts()[0].options!.body as string;
  await other.respond(start + 1, { ...verificationReceipt(body), context_hash: "f".repeat(64) });
  assert.match(other.text(), /VERIFICATION_RESPONSE_INVALID/); assert.match(other.text(), /冻结的原请求/); assert.doesNotMatch(other.text(), /服务端排队回执/); assert.equal(other.posts().length, 1);
});
test("detail and cursor reads keep exact scope and never trigger a verification POST", async t => {
  const f = mount(t), data = verificationState("p", true); data.next_cursor = "synthetic-cursor"; await f.ready(data);
  let start = f.requests.length; f.click("读取下一页检查请求"); await f.session(start); assert.match(f.requests[start + 1].url, /portfolio=p&cursor=synthetic-cursor$/);
  await f.respond(start + 1, { ...verificationState("p", true), session_binding: binding }); await f.session(start + 2);
  start = f.requests.length; f.click("读取请求 synthetic-request"); await f.session(start); assert.match(f.requests[start + 1].url, /portfolio=p&request=synthetic-request$/);
  await f.respond(start + 1, { ...verificationState("p", true), session_binding: binding }); await f.session(start + 2);
  assert.equal(f.posts().length, 0); assert.match(f.text(), /返回本组合请求列表/);
});
test("long private identifiers and evidence issues use wrapping without hiding their contents", async t => {
  const f = mount(t), data = verificationState("p", true); data.requests[0].id = "SYNTHETIC-".padEnd(200, "X"); data.requests[0].evidence_issues = ["VERIFICATION_SYNTHETIC_LONG_ISSUE_".padEnd(180, "X")];
  await f.ready(data); const article = f.control("article"); assert.match(String(article.props.className), /overflow-wrap:anywhere/); assert.doesNotMatch(String(article.props.className), /truncate|overflow-hidden/);
  const requestButton = f.control("button", node => f.text(node).startsWith("读取请求 ")); assert.match(String(requestButton.props.className), /max-w-full.*whitespace-normal/);
  assert.match(f.text(), /VERIFICATION_SYNTHETIC_LONG_ISSUE_/);
});
test("readonly private artifact download uses an exact bound GET, validates bytes and probes before saving inert content", async t => {
  const f = mount(t), data = verificationState("p", true); data.read_only = true; await f.ready(data);
  const start = f.requests.length; f.click("下载私有执行原件（JSON 附件，不执行）"); assert.equal(f.downloads.length, 0); await f.session(start);
  assert.equal(f.requests[start + 1].url, "/api/workbench/verifications?portfolio=p&artifact=synthetic-artifact");
  assert.equal(new Headers(f.requests[start + 1].options!.headers).get("X-Workbench-Session-Binding"), binding);
  assert.equal(f.requests[start + 1].options!.cache, "no-store"); await f.artifact(start + 1); assert.equal(f.downloads.length, 0);
  await f.session(start + 2); assert.equal(f.downloads.length, 1); assert.equal(f.downloads[0].download, "verification-artifact.json");
  assert.equal(f.downloads[0].blob!.type, "application/octet-stream"); assert.equal(await f.downloads[0].blob!.text(), verificationArtifactBody); assert.equal(f.posts().length, 0);
  f.window.emit("blur"); assert.ok(f.revoked.includes(f.downloads[0].href));
});
test("private downloads reject tampered bytes, foreign sessions, 401 before parsing, and late hidden responses", async t => {
  for (const failure of ["hash", "binding", "401", "hidden", "post-probe"] as const) {
    const f = mount(t); await f.ready(verificationState("p", true)); f.holdArtifactValidation(failure === "hash");
    const start = f.requests.length; f.click("下载私有执行原件（JSON 附件，不执行）"); await f.session(start);
    if (failure === "hidden") f.window.emit("blur");
    if (failure === "401") await f.respond(start + 1, "SYNTHETIC_PRIVATE_BODY", 401, true);
    else await f.artifact(start + 1, failure === "hash" ? "SYNTHETIC_TAMPERED" : verificationArtifactBody, failure === "binding" ? otherBinding : binding);
    if (failure === "post-probe") await f.session(start + 2, otherBinding);
    if (failure === "hash") {
      assert.equal(f.control("main").props["aria-busy"], true); assert.doesNotMatch(f.text(), /VERIFICATION_ARTIFACT_INVALID/);
      // Release the real validator's result after event-loop ticks, then await its actual rendered error.
      const rendered = f.renderedText(/VERIFICATION_ARTIFACT_INVALID/); await f.releaseArtifactValidation(); await rendered;
    }
    assert.equal(f.downloads.length, 0); assert.equal(f.posts().length, 0);
    if (["binding", "401", "post-probe"].includes(failure)) assert.ok(f.events.includes(SESSION_INVALIDATED_EVENT));
    if (failure === "hash") assert.match(f.text(), /VERIFICATION_ARTIFACT_INVALID/);
  }
});
test("a boundary-binding round trip clears the private reason and unresolved retry even without a page-prop change", async t => {
  const f = mount(t); await f.ready(); fill(f); const start = f.requests.length; f.submit(); await f.session(start);
  await f.respond(start + 1, { error: "WORKBENCH_UNAVAILABLE" }, 503); assert.match(f.text(), /冻结的原请求/);
  f.context.sessionBinding = otherBinding; f.render(); assert.doesNotMatch(f.text(), /SYNTHETIC PRIVATE CHECK REASON/);
  f.context.sessionBinding = binding; f.render(); await f.ready();
  assert.equal(f.named("textarea", "工程检查请求理由").props.value, ""); assert.doesNotMatch(f.text(), /冻结的原请求/); assert.equal(f.posts().length, 1);
});
