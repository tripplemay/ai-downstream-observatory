import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { csvMappingSchema } from "../src/server/ledger/csv-schemas";
import * as review from "../src/components/workbench/csv-background-review";
import type { CsvBackgroundPreviewPage, CsvBackgroundRowItem, CsvBackgroundSummary } from "../src/server/csv-background/query-types";

type Tree = { type: unknown; props: Record<string, unknown> };
const binding = "a".repeat(64), hash = "b".repeat(64), stamp = "2030-01-01T00:00:00.000000Z";
const common = { schema_version: "csv-background-page-v1", portfolio_id: "p", server_now: stamp, read_only: false };
const identity = { request_id: "request", result_hash: hash, batch_id: "batch", preview_hash: hash, review_hash: hash };
function summary(options: Partial<CsvBackgroundSummary> = {}): CsvBackgroundSummary {
  return { request_id: "request", portfolio_id: "p", account_id: "a", operation: "preview", input_hash: hash, expected_revision: 3,
    created_at: stamp, expires_at: "2030-01-01T00:15:00.000000Z", status: "succeeded", job: null, attempts: [], cancelled_at: null, result_hash: hash,
    result: { schema_version: "csv-background-result-v1", request_id: "request", operation: "preview", input_hash: hash, batch_id: "batch", preview_hash: hash,
      expected_revision: 3, batch_status: "preview", row_count: 2, error_count: 0, review_hash: hash, required_review_count: 0, confirmed_revision: null, receipts_hash: null }, ...options };
}
function metadata(options: Partial<CsvBackgroundPreviewPage["preview"]> = {}): CsvBackgroundPreviewPage {
  return { ...common, schema_version: "csv-background-page-v1", ...identity, view: "preview", preview: { account_id: "a", expected_revision: 3, current_revision: 3,
    batch_status: "preview", confirmed_revision: null, original_filename: "synthetic.csv", attachment_id: "attachment", content_hash: hash,
    mapping_version_id: "mapping-version", mapping_id: "mapping", mapping_version: 1, mapping_hash: hash, mapping_attachment_id: "mapping-attachment", mapping_attachment_hash: hash,
    parser_version: "csv-v1", mapper_version: "explicit-csv-mapping-v1", headers: ["source", "amount"], document_errors: [], warnings: [], broker_format_verified: false,
    row_count: 2, error_count: 0, required_review_count: 0, ...options } };
}
function row(number: number, required = false): CsvBackgroundRowItem {
  return { row: number, source: { record_number: number + 1, line_start: number + 1, line_end: number + 1, byte_start: number * 10, byte_end: number * 10 + 9,
    cells: ["SYNTHETIC PRIVATE ROW", String(number)], formula_columns: [], command: null, errors: [], warnings: [] }, outcome: { kind: "new", warnings: [] }, command: null,
    errors: [], requires_review: required, missing_source_id: required, candidate_counts: { exact_event_ids: 0, possible_event_ids: 0, exact_prior_rows: 0, possible_prior_rows: 0 } };
}
function rows(items = [row(1), row(2)], extra = {}) { return { ...common, ...identity, view: "rows", review_only: false, total: 2, receipts_hash: null, items, next_cursor: null, ...extra }; }
function list(items: CsvBackgroundSummary[] = []) { return { ...common, view: "list", items, next_cursor: null }; }
const compiled = ts.transpileModule(readFileSync(new URL("../src/components/workbench/csv-background-workspace.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Runs the actual component callbacks. Client protocol/crypto parsing has separate real-helper tests.
function mount(t: { after(callback: () => void): void }, options: { readOnly?: boolean; verified?: boolean } = {}) {
  type Listener = (event: Record<string, unknown>) => void;
  class Surface {
    listeners = new Map<string, Set<Listener>>();
    addEventListener(type: string, listener: Listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(listener); }
    removeEventListener(type: string, listener: Listener) { this.listeners.get(type)?.delete(listener); }
    emit(type: string, event: Record<string, unknown> = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  }
  class Element { constructor(private anchor?: HTMLAnchorElement) {} closest() { return this.anchor; } }
  class HTMLAnchorElement extends Element { constructor(public href: string, public target = "") { super(); } hasAttribute() { return false; } }
  let confirmation = true;
  const window = Object.assign(new Surface(), { location: new URL("http://localhost/workbench"), confirm: () => confirmation }), document = new Surface();
  const context = { verified: options.verified ?? true, sessionBinding: binding };
  const props = { portfolioId: "p", accountId: "a", revision: 3, readOnly: options.readOnly ?? false, onCommitted: () => { commits++; }, onScopeLockChange: (value: boolean) => { locked = value; } };
  const hooks: unknown[] = [], effects: { dependencies: unknown[]; cleanup?: () => void }[] = [], queued: { slot: number; callback: () => void | (() => void) }[] = [];
  const listeners = new Set<() => void>();
  let cursor = 0, effectCursor = 0, rendering = false, rerender = false, tree: Tree, render: () => void, commits = 0, locked = false;
  const react = {
    useState(value: unknown) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = typeof value === "function" ? value() : value;
      return [hooks[slot], (next: unknown) => { const resolved = typeof next === "function" ? next(hooks[slot]) : next; if (Object.is(resolved, hooks[slot])) return; hooks[slot] = resolved; render(); }]; },
    useRef(value: unknown) { const slot = cursor++; if (!(slot in hooks)) hooks[slot] = { current: value }; return hooks[slot]; },
    useCallback(callback: unknown) { return callback; },
    useEffect(callback: () => void | (() => void), dependencies: unknown[]) { const slot = effectCursor++, previous = effects[slot];
      if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) { previous?.cleanup?.(); effects[slot] = { dependencies }; queued.push({ slot, callback }); } },
  };
  interface Request { method: "GET" | "POST"; input: Record<string, unknown>; options: { isCurrent(): boolean; signal?: AbortSignal; sessionBinding: string }; resolve(value: unknown): void; reject(error: Error): void; settled: boolean }
  const requests: Request[] = [];
  const enqueue = (method: Request["method"], input: Record<string, unknown>, call: Request["options"]) => new Promise((resolve, reject) => {
    assert.equal(call.isCurrent(), true);
    const request: Request = { method, input, options: call, settled: false, resolve: value => { request.settled = true; resolve(value); }, reject: error => { request.settled = true; reject(error); } };
    requests.push(request); listeners.forEach(listener => listener());
  });
  const client = {
    fetchCsvBackground: (query: Record<string, unknown>, call: Request["options"]) => enqueue("GET", query, call),
    sendCsvBackground: (prepared: Record<string, unknown>, call: Request["options"]) => enqueue("POST", prepared, call),
    prepareCsvBackgroundPreview: async (input: Record<string, unknown>) => Object.freeze({ ...input, kind: "preview" }),
    prepareCsvBackgroundConfirmation: async (input: Record<string, unknown>) => Object.freeze({ ...input, kind: "confirm", body: JSON.stringify(input) }),
    prepareCsvBackgroundCancellation: (input: Record<string, unknown>) => Object.freeze({ ...input, kind: "cancel", body: JSON.stringify(input) }),
  };
  const jsx = (type: unknown, props: Record<string, unknown>): Tree => typeof type === "function" ? type(props) : { type, props };
  const dependencies: Record<string, unknown> = { react, "react/jsx-runtime": { jsx, jsxs: jsx },
    "@/components/ui/button": { Button: "button" }, "@/components/ui/input": { Input: "input" },
    "@/components/session-boundary": { useSessionBoundary: () => context }, "@/components/session-boundary-state": { SESSION_INVALIDATED_EVENT: "workbench:session-invalidated" },
    "@/server/ledger/csv-schemas": { csvMappingSchema }, "./csv-mapping-wizard": { CsvMappingWizard: "wizard" }, "./csv-background-client": client,
    "./csv-background-review": review, "./csv-workspace-state": { shouldWarnCsvNavigation: (href: string, location: string, target: string) => target !== "_blank" && new URL(href, location).pathname !== new URL(location).pathname } };
  const module = { exports: {} as { CsvBackgroundWorkspace(props: unknown): Tree } };
  runInNewContext(`(function(require,module,exports){${compiled}\n})`, { window, document, Element, HTMLAnchorElement, URL, TextEncoder, TextDecoder, AbortController, Error, crypto })(
    (name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports);
  render = () => {
    if (rendering) { rerender = true; return; }
    do {
      rendering = true; rerender = false; cursor = 0; effectCursor = 0; tree = module.exports.CsvBackgroundWorkspace(props);
      // Effect state updates render after the current effect batch, not recursively between setters.
      while (queued.length) { const effect = queued.shift()!, cleanup = effect.callback(); if (cleanup) effects[effect.slot].cleanup = cleanup; }
      rendering = false;
    } while (rerender);
    listeners.forEach(listener => listener());
  };
  render(); t.after(() => effects.forEach(effect => effect.cleanup?.()));
  const all = () => { const values: Tree[] = []; const visit = (value: unknown) => { if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object" && "props" in value) { const node = value as Tree; values.push(node); visit(node.props.children); } }; visit(tree); return values; };
  const text = (node: Tree = tree): string => { const visit = (value: unknown): string => Array.isArray(value) ? value.map(visit).join(" ") : typeof value === "string" || typeof value === "number" ? String(value)
    : value && typeof value === "object" && "props" in value ? visit((value as Tree).props.children) : ""; return visit(node); };
  const control = (type: string, match: (node: Tree) => boolean = () => true) => { const found = all().find(node => node.type === type && match(node)); assert.ok(found, `${type}: ${text()}`); return found; };
  const named = (type: string, name: string) => control(type, node => node.props["aria-label"] === name);
  const button = (label: string) => control("button", node => text(node).replace(/\s+/g, "") === label.replace(/\s+/g, ""));
  const change = (node: Tree, value: string | boolean | File) => (node.props.onChange as (event: unknown) => void)({ target: typeof value === "boolean" ? { checked: value } : typeof value === "string" ? { value } : { files: [value] } });
  const click = (label: string) => { const node = button(label); assert.equal(!!node.props.disabled, false, label); (node.props.onClick as () => void)(); };
  const until = (condition: () => boolean, label: string) => new Promise<void>((resolve, reject) => {
    const poll = () => { if (condition()) { clearTimeout(timer); listeners.delete(poll); resolve(); } };
    const timer = setTimeout(() => { listeners.delete(poll); reject(new Error(`${label}: ${text()}`)); }, 10000); listeners.add(poll); poll();
  });
  const next = async () => { await until(() => requests.some(request => !request.settled), "request"); return requests.find(request => !request.settled)!; };
  const reply = async (value: unknown) => { (await next()).resolve(value); };
  const settled = () => until(() => !named("section", "后台 CSV 导入").props["aria-busy"], "settlement");
  const ready = async (items: CsvBackgroundSummary[] = []) => { await reply(list(items)); await settled(); };
  const load = async (item = summary(), meta = metadata(), page = rows()) => { await reply({ ...common, view: "status", item }); await reply(meta); await reply(page); await settled(); };
  return { context, props, requests, window, document, text, all, control, named, change, click, button, until, next, reply, ready, load, settled, render,
    posts: () => requests.filter(request => request.method === "POST"), commits: () => commits, locked: () => locked, confirm(value: boolean) { confirmation = value; },
    submit: () => (control("form").props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} }),
    scope(portfolioId: string, accountId = "a", revision = 3) { Object.assign(props, { portfolioId, accountId, revision }); render(); },
    invalidate() { window.emit("workbench:session-invalidated"); },
    navigate() { const event = { button: 0, target: new Element(new HTMLAnchorElement("/workbench/market")), prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; document.emit("click", event); return event; },
  };
}
type Fixture = ReturnType<typeof mount>;
function uploadFields(f: Fixture, file = new File(["source,amount\nsynthetic,1\n"], "synthetic.csv", { type: "text/csv" })) {
  f.change(f.named("select", "后台 CSV 映射方式"), "advanced"); f.change(f.named("input", "后台 CSV 原件"), file);
  f.change(f.named("textarea", "后台 CSV 原始映射"), "{\n  \"synthetic\": true\n}\n");
}

test("background workspace initially queries only and requires separate unchecked acknowledgements", async t => {
  const f = mount(t); await f.ready(); assert.equal(f.posts().length, 0); assert.equal(f.named("input", "授权后台预览").props.checked, false);
  uploadFields(f); await f.submit(); assert.equal(f.posts().length, 0); assert.match(f.text(), /退出不会取消/); assert.match(f.text(), /GET/);
  const hidden = mount(t, { verified: false }); assert.equal(hidden.requests.length, 0); assert.doesNotMatch(hidden.text(), /SYNTHETIC PRIVATE/);
});

test("ambiguous preview retains exact original file, mapping and key; only acknowledged manual retry writes", async t => {
  const f = mount(t); await f.ready(); uploadFields(f); f.change(f.named("input", "授权后台预览"), true);
  const submitted = f.submit(); void f.submit(); const first = await f.next(); assert.equal(first.method, "POST"); assert.equal(f.posts().length, 1);
  first.reject(new Error("WORKBENCH_UNAVAILABLE")); await submitted; assert.match(f.text(), /原请求保留/); assert.equal(f.locked(), true);
  f.click("刷新任务与状态（只读）"); await f.reply(list()); await f.settled(); assert.equal(f.posts().length, 1);
  f.change(f.named("input", "确认原样重试"), true); f.click("原样重试未决请求"); const retry = await f.next(); assert.equal(retry.method, "POST"); assert.equal(retry.input, first.input);
  retry.reject(new Error("WORKBENCH_UNAVAILABLE")); await f.settled(); assert.equal(f.posts().length, 2); assert.equal(f.named("input", "确认原样重试").props.checked, false);
  f.confirm(false); const navigation = f.navigate(); assert.equal(navigation.prevented, true); assert.equal(navigation.stopped, true);
  f.confirm(true); f.click("清除本页（不取消任务）"); assert.equal(f.locked(), false); assert.equal(f.posts().length, 2); assert.doesNotMatch(f.text(), /响应未决/);
});

test("queued receipt is not success, queries do not execute, cancel needs reason and preserves retry body", async t => {
  const queued = summary({ status: "queued", result: null, result_hash: null });
  const f = mount(t); await f.ready([queued]); f.click("核对任务"); await f.reply({ ...common, view: "status", item: queued }); await f.settled();
  assert.match(f.text(), /尚无已核验执行结果/); assert.equal(f.commits(), 0); assert.equal(f.button("明确取消此后台任务").props.disabled, true);
  f.change(f.named("input", "后台 CSV 取消理由"), "SYNTHETIC EXPLICIT CANCEL"); f.click("明确取消此后台任务"); const cancel = await f.next(); assert.equal(cancel.method, "POST"); assert.equal(cancel.input.reason, "SYNTHETIC EXPLICIT CANCEL");
  cancel.reject(new Error("WORKBENCH_UNAVAILABLE")); await f.settled(); f.change(f.named("input", "确认原样重试"), true); f.click("原样重试未决请求"); const retry = await f.next(); assert.equal(retry.input, cancel.input); retry.reject(new Error("WORKBENCH_UNAVAILABLE")); await f.settled();
});

test("accepted preview becomes reviewable only after queried result; confirmation uses new authorization and verified result", async t => {
  const f = mount(t); await f.ready(); const bytes = "source,amount\nsynthetic,1\n";
  uploadFields(f, new File([bytes], "synthetic.csv")); f.change(f.named("input", "授权后台预览"), true);
  const submitted = f.submit(); const post = await f.next(); assert.equal(post.method, "POST");
  post.resolve({ request_id: "request", status: "queued", operation: "preview", input_hash: hash });
  const queued = summary({ status: "queued", result: null, result_hash: null }); await f.reply(list([queued])); await f.reply({ ...common, view: "status", item: queued }); await submitted;
  assert.equal(f.commits(), 0); assert.equal(f.named("input", "授权后台预览").props.checked, false); assert.equal(f.locked(), true); assert.doesNotMatch(f.text(), /3\. 完整证据/);
  f.click("刷新任务与状态（只读）"); await f.reply(list([summary()])); await f.load(summary(), metadata({ content_hash: createHash("sha256").update(bytes).digest("hex") }));
  assert.equal(f.posts().length, 1); assert.equal(f.locked(), false); assert.equal(f.named("input", "授权后台确认").props.checked, false);
  f.change(f.named("input", "确认完整复核 CSV"), true); f.change(f.named("input", "授权后台确认"), true); f.click("提交后台确认授权");
  const confirm = await f.next(); assert.equal(confirm.method, "POST"); assert.notEqual(confirm.input.idempotencyKey, post.input.idempotencyKey);
  const confirmed = summary({ request_id: "confirmed-request", operation: "confirm", result_hash: "c".repeat(64) });
  confirmed.result = { ...confirmed.result!, request_id: "confirmed-request", operation: "confirm", batch_status: "confirmed", confirmed_revision: 3, receipts_hash: hash };
  confirm.resolve({ request_id: "confirmed-request", status: "queued", operation: "confirm", input_hash: hash });
  await f.reply(list([confirmed])); await f.load(confirmed, { ...metadata({ batch_status: "confirmed", confirmed_revision: 3 }), request_id: confirmed.request_id, result_hash: confirmed.result_hash! },
    rows(undefined, { request_id: confirmed.request_id, result_hash: confirmed.result_hash! }));
  assert.equal(f.commits(), 1); assert.equal(f.posts().length, 2); assert.match(f.text(), /服务器已独立核验确认结果/); assert.equal(f.button("提交后台确认授权").props.disabled, true);
});

test("new session history re-reviews bounded rows and exact candidates before separate confirmation authorization", async t => {
  const item = summary(), first = row(1, true), second = row(2, true); first.candidate_counts.exact_event_ids = 21;
  const f = mount(t); await f.ready([item]); f.click("核对任务"); await f.load(item, metadata({ required_review_count: 2 }), rows([first], { next_cursor: "rows-next" }));
  assert.equal(f.posts().length, 0); assert.equal(f.named("input", "授权后台确认").props.checked, false);
  f.change(f.named("select", "第 1 行人工决定"), "link_existing"); f.change(f.named("input", "第 1 行核对理由"), "verified synthetic existing occurrence");
  f.click("完全相同的已有事实（21）"); const lookup = await f.next(); assert.equal(lookup.input.limit, 20); assert.equal(lookup.input.row, 1);
  lookup.resolve({ ...common, ...identity, view: "candidates", row: 1, kind: "exact_event_ids", total: 21, items: ["event-one"], next_cursor: "candidate-next" }); await f.settled();
  f.click("下一页候选"); const nextCandidate = await f.next(); assert.equal(nextCandidate.input.cursor, "candidate-next"); nextCandidate.resolve({ ...common, ...identity, view: "candidates", row: 1, kind: "exact_event_ids", total: 21, items: ["event-last"], next_cursor: null }); await f.settled();
  f.click("选择此完全相同候选"); f.change(f.named("input", "确认完整复核 CSV"), true); f.change(f.named("input", "授权后台确认"), true);
  assert.equal(f.button("提交后台确认授权").props.disabled, true);
  f.click("下一页记录"); const nextRows = await f.next(); assert.equal(nextRows.input.cursor, "rows-next"); assert.equal(nextRows.input.limit, 25); nextRows.resolve(rows([second])); await f.settled();
  f.change(f.named("select", "第 2 行人工决定"), "record_distinct"); f.change(f.named("input", "第 2 行核对理由"), "verified separate occurrence");
  assert.equal(f.named("input", "授权后台确认").props.checked, false); f.change(f.named("input", "授权后台确认"), true); f.click("提交后台确认授权");
  const posted = await f.next(); assert.equal(posted.method, "POST"); assert.equal(posted.input.kind, "confirm");
  const payload = JSON.parse(posted.input.payloadText as string); assert.equal(payload.csv_review.rows.length, 2); assert.equal(payload.csv_review.rows[0].event_id, "event-last"); assert.equal(payload.csv_review.review_hash, hash);
  posted.reject(new Error("WORKBENCH_UNAVAILABLE")); await f.settled(); assert.match(f.text(), /原确认字节与幂等键保留/);
});

test("review-only uses a new server cursor scope and no automatic candidate or receipt scans", async t => {
  const f = mount(t); await f.ready([summary()]); f.click("核对任务"); await f.load(); const before = f.requests.length;
  f.change(f.named("input", "只看必须复核行"), true); const request = await f.next(); assert.equal(request.input.review_only, true); assert.equal(request.input.cursor, undefined);
  request.resolve(rows([], { review_only: true, total: 0 })); await f.settled(); assert.equal(f.requests.length, before + 1); assert.equal(f.posts().length, 0);
});

test("A-B-A rejects old reads and logout clears rows, drafts and late results", async t => {
  const f = mount(t); const a = await f.next(); f.scope("other"); const b = await f.next(); // a is still pending; select exact new request below.
  void b;
  const other = f.requests.find(request => request !== a && request.input.portfolio_id === "other")!; assert.ok(other);
  f.scope("p"); const fresh = f.requests.at(-1)!; assert.notEqual(fresh, a);
  a.resolve(list([summary({ request_id: "old-private" })])); other.resolve({ ...list(), portfolio_id: "other" }); fresh.resolve(list([summary()])); await f.settled();
  assert.doesNotMatch(f.text(), /old-private/); f.click("核对任务"); await f.load(); assert.match(f.text(), /SYNTHETIC PRIVATE ROW/);
  f.click("刷新任务与状态（只读）"); const pending = await f.next(); f.invalidate(); pending.resolve(list([summary({ request_id: "late-private" })]));
  await Promise.resolve(); assert.doesNotMatch(f.text(), /SYNTHETIC PRIVATE|late-private/); assert.equal(f.locked(), false);
});

test("late file read cannot submit after scope change or logout", async t => {
  let release!: (value: ArrayBuffer) => void;
  const file = new File(["synthetic"], "synthetic.csv"); Object.defineProperty(file, "arrayBuffer", { value: () => new Promise<ArrayBuffer>(resolve => { release = resolve; }) });
  const f = mount(t); await f.ready(); uploadFields(f, file); f.change(f.named("input", "授权后台预览"), true); const submitted = f.submit();
  f.scope("other"); release(new TextEncoder().encode("synthetic").buffer); await submitted; assert.equal(f.posts().length, 0); assert.equal(f.named("input", "授权后台预览").props.checked, false);
  const g = mount(t); await g.ready(); uploadFields(g, file); g.change(g.named("input", "授权后台预览"), true); const logoutSubmission = g.submit(); g.invalidate(); release(new TextEncoder().encode("synthetic").buffer); await logoutSubmission; assert.equal(g.posts().length, 0);
});

test("native SHA completion after logout cannot resurrect pending bytes or POST", async t => {
  const native = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void, entered!: () => void;
  const digestEntered = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(crypto.subtle, "digest", async (...args: Parameters<typeof crypto.subtle.digest>) => {
    const actual = await native(...args);
    await new Promise<void>(resolve => { release = resolve; entered(); });
    return actual;
  });
  const f = mount(t); await f.ready(); uploadFields(f); f.change(f.named("input", "授权后台预览"), true); const submitted = f.submit();
  await digestEntered; f.invalidate(); release(); await submitted;
  assert.equal(f.posts().length, 0); assert.doesNotMatch(f.text(), /响应未决|synthetic\.csv/); assert.equal(f.locked(), false);
});

test("selected-task A-B-A never sends A request in B scope or restores prior drafts", async t => {
  const f = mount(t); await f.ready([summary()]); f.click("核对任务"); await f.load(summary(), metadata({ required_review_count: 1 }), rows([row(1, true)]));
  f.change(f.named("input", "第 1 行核对理由"), "PRIVATE OLD DRAFT");
  f.scope("other"); const b = await f.next(); assert.equal(b.input.portfolio_id, "other"); assert.equal(b.input.request_id, undefined);
  f.scope("p"); const fresh = f.requests.at(-1)!; assert.equal(fresh.input.portfolio_id, "p"); assert.equal(fresh.input.request_id, undefined);
  b.resolve({ ...list(), portfolio_id: "other" }); fresh.resolve(list([summary()])); await f.settled();
  assert.doesNotMatch(f.text(), /PRIVATE OLD DRAFT|SYNTHETIC PRIVATE ROW/); f.click("核对任务"); await f.load(summary(), metadata({ required_review_count: 1 }), rows([row(1, true)]));
  assert.equal(f.named("input", "第 1 行核对理由").props.value, ""); assert.equal(f.posts().length, 0);
});

test("session binding replacement clears ambiguous write and new session never reconstructs old request", async t => {
  const f = mount(t); await f.ready(); uploadFields(f); f.change(f.named("input", "授权后台预览"), true); const submitted = f.submit();
  (await f.next()).reject(new Error("WORKBENCH_UNAVAILABLE")); await submitted; assert.match(f.text(), /响应未决/);
  f.context.sessionBinding = "c".repeat(64); f.render(); const query = await f.next(); assert.equal(query.method, "GET"); assert.equal(query.options.sessionBinding, f.context.sessionBinding);
  query.resolve(list([summary()])); await f.settled(); assert.doesNotMatch(f.text(), /响应未决/); assert.equal(f.posts().length, 1); assert.equal(f.named("textarea", "后台 CSV 原始映射").props.value, "");
  f.click("核对任务"); await f.load(); assert.equal(f.posts().length, 1); assert.equal(f.named("input", "授权后台确认").props.checked, false);
});

test("failed refresh blocks previously ready confirmation until complete verified detail is read again", async t => {
  const f = mount(t); await f.ready([summary()]); f.click("核对任务"); await f.load();
  f.change(f.named("input", "确认完整复核 CSV"), true); f.change(f.named("input", "授权后台确认"), true); assert.equal(f.button("提交后台确认授权").props.disabled, false);
  f.click("刷新任务与状态（只读）"); await f.reply(list([summary()])); await f.reply({ ...common, view: "status", item: summary() }); await f.reply(metadata());
  (await f.next()).reject(new Error("CSV_BACKGROUND_RESPONSE_INVALID")); await f.settled(); assert.equal(f.button("提交后台确认授权").props.disabled, true); assert.equal(f.posts().length, 0);
});

test("read-only permits history and receipts but no upload, confirm or cancel POST", async t => {
  const item = summary({ operation: "confirm" }); item.result = { ...item.result!, operation: "confirm", batch_status: "confirmed", confirmed_revision: 3, receipts_hash: hash };
  const f = mount(t, { readOnly: true }); await f.ready([item]); f.click("核对任务"); await f.load(item, metadata({ batch_status: "confirmed", confirmed_revision: 3 }));
  assert.equal(f.commits(), 1); f.click("读取实际回执（分页）"); const request = await f.next(); assert.equal(request.input.view, "receipts"); assert.equal(request.input.limit, 25);
  request.resolve({ ...common, ...identity, view: "receipts", total: 2, receipts_hash: hash, items: [{ row: 1, receipt: { event_id: "same", revision: 3, audit_id: "audit", warnings: [] }, resolution: null }], next_cursor: "receipt-next" }); await f.settled();
  f.click("下一页回执"); const next = await f.next(); assert.equal(next.input.cursor, "receipt-next"); next.resolve({ ...common, ...identity, view: "receipts", total: 2, receipts_hash: hash, items: [{ row: 2, receipt: { event_id: "same", revision: 3, audit_id: "audit", warnings: [] }, resolution: null }], next_cursor: null }); await f.settled();
  await f.submit(); assert.equal(f.posts().length, 0); assert.equal(f.button("提交后台确认授权").props.disabled, true); assert.match(f.text(), /恢复只读/);
  const downloads = f.all().filter(node => node.type === "a"); assert.equal(downloads.length, 2);
  assert.ok(downloads.every(node => node.props.download === true && String(node.props.href).includes("?portfolio=p")));
});

test("current confirmed status, revision conflict and document errors independently block confirmation", async t => {
  for (const patch of [{ batch_status: "confirmed" as const, confirmed_revision: 3 }, { current_revision: 4 }, { error_count: 1 }, { document_errors: [{ code: "INVALID_DOCUMENT" }] }]) {
    const f = mount(t); await f.ready([summary()]); f.click("核对任务"); await f.load(summary(), metadata(patch));
    f.change(f.named("input", "确认完整复核 CSV"), true); f.change(f.named("input", "授权后台确认"), true); assert.equal(f.button("提交后台确认授权").props.disabled, true); assert.equal(f.posts().length, 0);
  }
});

test("review drafts reject cross-hash choices, link-only distinct facts and nonexact candidates", () => {
  const required = row(2, true), draft = review.backgroundReviewDraft(required, hash);
  assert.equal(review.backgroundReviewResolution({ ...draft, reason: "reason", action: "record_distinct" }, "c".repeat(64)), null);
  assert.equal(review.backgroundReviewResolution({ ...draft, reason: "reason", action: "record_distinct", linkOnly: true }, hash), null);
  assert.equal(review.backgroundReviewResolution({ ...draft, reason: "reason", action: "link_existing", picked: { kind: "possible_event_ids", value: "event" } }, hash), null);
  assert.equal(review.backgroundReviewResolution({ ...draft, reason: "reason", action: "link_prior_row", picked: { kind: "exact_prior_rows", value: 2 } }, hash), null);
});

test("workbench mounts background by default and exposes only explicit legacy recovery, never a synchronous upload fallback", () => {
  const source = readFileSync(new URL("../src/components/workbench/workbench.tsx", import.meta.url), "utf8");
  assert.match(source, /legacyCsvRecovery, setLegacyCsvRecovery\] = useState\(false\)/);
  assert.match(source, /legacyCsvRecovery \? <CsvWorkspace legacyRecoveryOnly/); assert.match(source, /: <CsvBackgroundWorkspace/);
  assert.match(source, /disabled=\{csvScopeLocked\} onClick=\{\(\) => \{ if \(!csvScopeLocked\) setLegacyCsvRecovery/);
});
