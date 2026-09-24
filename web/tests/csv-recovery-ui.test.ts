import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as stateHelpers from "../src/components/workbench/csv-workspace-state";
import { recoveryResolutionDrafts } from "../src/components/workbench/csv-recovery-client";
import { csvMappingSchema } from "../src/server/ledger/csv-schemas";
import type { CsvConfirmationRecoveryDetailResponse } from "../src/server/ledger/csv-confirmation-recovery-types";

type Tree = { type: unknown; props: Record<string, unknown> };
type Effect = () => void | (() => void);
const sessionBinding = "a".repeat(64), previewHash = "b".repeat(64), reviewHash = "c".repeat(64);
const compiled = ts.transpileModule(readFileSync(new URL("../src/components/workbench/csv-workspace.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function evidence(confirmed = false) {
  const payload = '\ufeff{ "action":"confirm_import", "portfolio_id":"p", "batch_id":"batch", "preview_hash":"' + previewHash + '", "expected_revision":0, "csv_review": {"acknowledge_unverified_mapping":true,"review_hash":"' + reviewHash + '","rows":[]} }\r\n';
  const status = confirmed ? "confirmed" : "preview";
  const detail: CsvConfirmationRecoveryDetailResponse = {
    schema_version: "csv-confirmation-recovery-v1", session_binding: sessionBinding, payload_text: payload, read_only: false, review_error: null,
    attempt: { id: "synthetic-attempt", portfolio_id: "p", account_id: "a", batch_id: "batch", preview_hash: previewHash, expected_revision: 0,
      payload_hash: createHash("sha256").update(payload).digest("hex"), payload_bytes: Buffer.byteLength(payload), created_at: "2026-01-01T00:00:00.000Z",
      batch_status: status, current_revision: Number(confirmed), confirmed_revision: confirmed ? 1 : null },
    batch: { id: "batch", portfolio_id: "p", account_id: "a", parser_version: "csv-v1", status, preview_hash: previewHash, expected_revision: 0,
      confirmed_revision: confirmed ? 1 : null, row_count: 1 },
    confirmation: confirmed ? { status: "confirmed", attempt_matches: true, revision: 1,
      receipts: [{ event_id: "synthetic-event", audit_id: "synthetic-audit", revision: 1, warnings: [] }], duplicate: true }
      : { status: "unconfirmed", attempt_matches: null },
  };
  const batch = { id: "batch", account_id: "a", attachment_id: "synthetic-attachment", status, parser_version: "csv-v1", preview_hash: previewHash, expected_revision: 0,
    rows: [{ row: 1, command: null, errors: [], source: { record_number: 2, line_start: 2, line_end: 2, byte_start: 5, byte_end: 6, cells: ["1"] } }],
    csv: { original_filename: "synthetic.csv", content_hash: "d".repeat(64), mapping_id: "synthetic-mapping", mapping_version: 1, mapping_hash: "e".repeat(64),
      mapping_attachment_id: "synthetic-mapping-attachment", parser_version: "strict-csv-utf8-v1", mapper_version: "csv-mapping-v1", headers: ["Synthetic"],
      document_errors: [], warnings: [], candidates: [], review_hash: reviewHash, required_review_rows: [], broker_format_verified: false } };
  return { detail, batch, payload };
}

// Runs real component callbacks/effects with deterministic hooks; not browser or App Router acceptance.
function mount(t: { after: (callback: () => void) => void }, options: { readOnly?: boolean; deferredRefresh?: boolean; legacyRecoveryOnly?: boolean } = {}) {
  const hooks: unknown[] = [], effects: { dependencies?: readonly unknown[]; callback: Effect; cleanup?: () => void }[] = [];
  let cursor = 0, effectCursor = 0, pendingRender = true, tree: Tree;
  const pendingEffects = new Set<number>(), locks: boolean[] = [], requests: { url: string; init?: RequestInit; resolve: (value: unknown, status?: number) => void }[] = [];
  let session: { verified: boolean; sessionBinding: string } | null = { verified: true, sessionBinding };
  let refreshCalls = 0, invalidations = 0, resolveRefresh: (() => void) | undefined, rejectRefresh: ((error: Error) => void) | undefined;
  const listeners = new Map<string, Set<() => void>>();
  const window = {
    confirm: () => true, location: { href: "https://workbench.example.test/workbench" },
    addEventListener: (type: string, callback: () => void) => { const group = listeners.get(type) ?? new Set(); group.add(callback); listeners.set(type, group); },
    removeEventListener: (type: string, callback: () => void) => { listeners.get(type)?.delete(callback); },
  };
  const invalidate = () => {
    invalidations++; session = null;
    for (const callback of listeners.get("workbench:session-invalidated") ?? []) callback();
    pendingRender = true;
  };
  const document = { addEventListener() {}, removeEventListener() {} };
  const changed = (left?: readonly unknown[], right?: readonly unknown[]) => !left || !right || left.length !== right.length || left.some((value, index) => !Object.is(value, right[index]));
  const react = {
    useState(initial: unknown) {
      const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], (update: unknown) => { const next = typeof update === "function" ? update(hooks[index]) : update; if (!Object.is(next, hooks[index])) { hooks[index] = next; pendingRender = true; } }];
    },
    useRef(initial: unknown) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index]; },
    useMemo(callback: () => unknown, dependencies: readonly unknown[]) {
      const index = cursor++, previous = hooks[index] as { value: unknown; dependencies: readonly unknown[] } | undefined;
      if (!previous || changed(previous.dependencies, dependencies)) hooks[index] = { value: callback(), dependencies };
      return (hooks[index] as { value: unknown }).value;
    },
    useCallback(callback: unknown, dependencies: readonly unknown[]) { return react.useMemo(() => callback, dependencies); },
    useEffect(callback: Effect, dependencies?: readonly unknown[]) {
      const index = effectCursor++, previous = effects[index];
      if (!previous || changed(previous.dependencies, dependencies)) { effects[index] = { callback, dependencies, cleanup: previous?.cleanup }; pendingEffects.add(index); }
    },
  };
  const RecoveryPanel = () => null;
  const dependencies: Record<string, unknown> = {
    react, "react/jsx-runtime": { jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }), jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }) },
    "@/components/ui/button": { Button: "button" }, "@/components/ui/input": { Input: "input" }, "./csv-mapping-wizard": { CsvMappingWizard: "wizard" },
    "@/server/ledger/csv-schemas": { csvMappingSchema }, "@/components/session-boundary": { useSessionBoundary: () => session },
    "./csv-recovery-panel": { CsvRecoveryPanel: RecoveryPanel, fetchCsvRecovery: async () => { throw new Error("not used in this fixture"); },
      invalidateCsvSession: invalidate, verifyCsvSession: async (binding: string) => {
        if (!session?.verified || session.sessionBinding !== binding) throw new Error("CSV_RECOVERY_SESSION_CHANGED");
      } },
    "./csv-recovery-client": { recoveryResolutionDrafts }, "./csv-workspace-state": stateHelpers,
  };
  const module = { exports: {} as { CsvWorkspace: (props: Record<string, unknown>) => Tree } };
  const initialize = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { window, document, Error, TextEncoder, TextDecoder, Uint8Array, URL, URLSearchParams,
    crypto: globalThis.crypto, fetch: (url: string, init?: RequestInit) => new Promise(resolve => requests.push({ url, init,
      resolve: (value, status = 200) => resolve({ ok: status >= 200 && status < 300, status, json: async () => value }) })) });
  initialize((id: string) => { assert.ok(id in dependencies, id); return dependencies[id]; }, module, module.exports);
  const props = { portfolioId: "p", accountId: "a", revision: 0, readOnly: options.readOnly ?? false, legacyRecoveryOnly: options.legacyRecoveryOnly ?? false,
    onScopeLockChange: (locked: boolean) => locks.push(locked), onRestorePendingScope: async () => {},
    onCommitted: () => { refreshCalls++; return options.deferredRefresh ? new Promise<void>((resolve, reject) => { resolveRefresh = resolve; rejectRefresh = reject; }) : Promise.resolve(); } };
  function flush() {
    let iterations = 0;
    while (pendingRender || pendingEffects.size) {
      assert.ok(++iterations < 50, "Hook render loop did not settle");
      if (pendingRender) { pendingRender = false; cursor = 0; effectCursor = 0; tree = module.exports.CsvWorkspace(props); }
      const toRun = [...pendingEffects]; pendingEffects.clear();
      for (const index of toRun) { effects[index].cleanup?.(); const cleanup = effects[index].callback(); effects[index].cleanup = cleanup || undefined; }
    }
  }
  function visit(value: unknown): Tree[] {
    if (Array.isArray(value)) return value.flatMap(item => visit(item));
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    const node = value as Tree; return [node, ...visit(node.props.children)];
  }
  const nodes = () => visit(tree);
  const panel = () => nodes().find(node => node.type === RecoveryPanel)!;
  const settle = async () => { await new Promise<void>(resolve => setImmediate(resolve)); flush(); };
  flush(); t.after(() => { for (const effect of effects) effect?.cleanup?.(); });
  return { requests, locks, panel, nodes, flush, settle, refreshCalls: () => refreshCalls, invalidations: () => invalidations,
    finishRefresh: async () => { resolveRefresh?.(); await settle(); },
    failRefresh: async () => { rejectRefresh?.(new Error("synthetic refresh transport failure")); await settle(); },
    invalidate: () => { invalidate(); flush(); },
    updateScope: (portfolioId: string, accountId: string) => { Object.assign(props, { portfolioId, accountId }); pendingRender = true; flush(); },
    setLegacyRecoveryOnly: (value: boolean) => { props.legacyRecoveryOnly = value; pendingRender = true; flush(); },
  };
}

test("recovery actual callback retains exact payload and stays read-only until explicit user confirmation", async t => {
  const f = mount(t, { readOnly: true }), { detail, batch, payload } = evidence();
  const restore = (f.panel().props.onRestore as (detail: CsvConfirmationRecoveryDetailResponse) => Promise<boolean>)(detail);
  assert.equal(f.requests.length, 1); assert.ok(f.requests[0].url.includes("batch=batch"));
  f.requests[0].resolve(batch); assert.equal(await restore, true); await f.settle();
  assert.equal(f.requests.some(request => request.init?.method === "POST"), false);
  assert.equal(f.refreshCalls(), 0);
  assert.ok(f.nodes().some(node => node.type === "pre" && node.props.children === payload));
  const retry = f.nodes().find(node => node.type === "button" && node.props.children === "重试完全相同的确认请求");
  assert.ok(retry); assert.equal(retry.props.disabled, true);
});

test("session invalidation or scope change while recovery detail's batch fetch waits prevents restoring old payload", async t => {
  for (const action of ["invalidate", "scope"] as const) {
    const f = mount(t), { detail, batch, payload } = evidence();
    const restore = (f.panel().props.onRestore as (detail: CsvConfirmationRecoveryDetailResponse) => Promise<boolean>)(detail);
    if (action === "invalidate") f.invalidate(); else f.updateScope("other-portfolio", "other-account");
    f.requests[0].resolve(batch); assert.equal(await restore, false); await f.settle();
    assert.equal(f.nodes().some(node => node.type === "pre" && node.props.children === payload), false);
    assert.equal(f.requests.some(request => request.init?.method === "POST"), false);
  }
});

test("confirmed recovery keeps the parent scope locked until the real onCommitted refresh finishes", async t => {
  const f = mount(t, { deferredRefresh: true }), { detail, batch } = evidence(true);
  (f.panel().props.onBusyChange as (busy: boolean) => void)(true); f.flush();
  const restore = (f.panel().props.onRestore as (detail: CsvConfirmationRecoveryDetailResponse) => Promise<boolean>)(detail);
  f.requests[0].resolve(batch); assert.equal(await restore, true); await f.settle();
  (f.panel().props.onBusyChange as (busy: boolean) => void)(false); f.flush();
  assert.equal(f.refreshCalls(), 1); assert.equal(f.requests.some(request => request.init?.method === "POST"), false);
  assert.equal(f.locks.at(-1), true, "Parent unlocks while a stale portfolio refresh can still overwrite its next selection");
  for (const label of ["核对服务器批次状态", "结束审计展示，准备新预览"]) {
    const button = f.nodes().find(node => node.type === "button" && node.props.children === label);
    assert.ok(button); (button.props.onClick as () => void)(); await f.settle();
  }
  assert.equal(f.requests.length, 1, "Refresh in progress must reject concurrent status lookups");
  assert.ok(f.nodes().some(node => node.type === "pre" && node.props.children === detail.payload_text), "Refresh in progress must retain the recovery audit");
  await f.finishRefresh(); assert.equal(f.locks.at(-1), false);
});

test("confirmed recovery refresh rejected after session invalidation cannot revive errors, original payload or a scope lock", async t => {
  const f = mount(t, { deferredRefresh: true }), { detail, batch, payload } = evidence(true);
  const restore = (f.panel().props.onRestore as (detail: CsvConfirmationRecoveryDetailResponse) => Promise<boolean>)(detail);
  f.requests[0].resolve(batch); assert.equal(await restore, true); await f.settle();
  assert.equal(f.refreshCalls(), 1); assert.equal(f.locks.at(-1), true);
  f.invalidate(); assert.equal(f.locks.at(-1), false);
  await f.failRefresh();
  assert.equal(f.nodes().some(node => node.props.role === "alert"), false);
  assert.equal(f.nodes().some(node => node.type === "pre" && node.props.children === payload), false);
  assert.equal(f.locks.at(-1), false);
  assert.equal(f.requests.some(request => request.init?.method === "POST"), false);
});

test("restoring a batch that changed after verified detail refuses the stale proof without any POST", async t => {
  for (const mutation of [
    { id: "other-batch" }, { account_id: "other-account" }, { preview_hash: "f".repeat(64) },
    { expected_revision: 1 }, { rows: [] }, { status: "confirmed" },
  ]) {
    const f = mount(t), { detail, batch, payload } = evidence();
    const restore = (f.panel().props.onRestore as (detail: CsvConfirmationRecoveryDetailResponse) => Promise<boolean>)(detail);
    f.requests[0].resolve({ ...batch, ...mutation }); assert.equal(await restore, false); await f.settle();
    assert.ok(f.nodes().some(node => node.props.role === "alert"));
    assert.equal(f.nodes().some(node => node.type === "pre" && node.props.children === payload), false);
    assert.equal(f.requests.some(request => request.init?.method === "POST"), false);
    assert.equal(f.refreshCalls(), 0);
  }
});

test("an already confirmed batch with a different human decision remains audit-only, preserving the unsuccessful original attempt", async t => {
  const f = mount(t), { detail, batch, payload } = evidence(true);
  assert.equal(detail.confirmation.status, "confirmed");
  if (detail.confirmation.status === "confirmed") detail.confirmation.attempt_matches = false;
  const restore = (f.panel().props.onRestore as (detail: CsvConfirmationRecoveryDetailResponse) => Promise<boolean>)(detail);
  f.requests[0].resolve(batch); assert.equal(await restore, true); await f.settle();
  assert.ok(f.nodes().some(node => typeof node.props.children === "string" && node.props.children.includes("不认定此尝试成功")));
  assert.ok(f.nodes().some(node => node.type === "pre" && node.props.children === payload));
  assert.equal(f.nodes().some(node => node.type === "button" && node.props.children === "重试完全相同的确认请求"), false);
  assert.equal(f.requests.some(request => request.init?.method === "POST"), false);
});

test("explicit recovery retries send byte-identical BOM payloads with the current session binding, never an automatic retry after failure", async t => {
  const f = mount(t), { detail, batch, payload } = evidence();
  const restore = (f.panel().props.onRestore as (detail: CsvConfirmationRecoveryDetailResponse) => Promise<boolean>)(detail);
  f.requests[0].resolve(batch); assert.equal(await restore, true); await f.settle();
  assert.equal(f.requests.length, 1);
  for (const status of [503, 200]) {
    const retry = f.nodes().find(node => node.type === "button" && node.props.children === "重试完全相同的确认请求");
    assert.ok(retry); assert.equal(retry.props.disabled, false);
    (retry.props.onClick as () => void)(); await f.settle();
    const request = f.requests.at(-1)!;
    assert.equal(request.url, "/api/workbench"); assert.equal(request.init?.method, "POST");
    assert.equal(request.init.body, payload);
    assert.deepEqual(Buffer.from(String(request.init.body), "utf8"), Buffer.from(payload, "utf8"));
    assert.equal(createHash("sha256").update(String(request.init.body), "utf8").digest("hex"), detail.attempt.payload_hash);
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get("X-Workbench-Session-Binding"), sessionBinding);
    assert.equal(headers.get("Content-Type"), "application/json");
    request.resolve(status === 503 ? { error: "WORKBENCH_UNAVAILABLE" }
      : { revision: 1, receipts: [{ event_id: "synthetic-event", audit_id: "synthetic-audit", revision: 1, warnings: [] }], duplicate: true }, status);
    await f.settle(); await f.settle();
    if (status === 503) {
      assert.equal(f.requests.length, 2, "HTTP failure must not automatically resubmit the frozen request");
      assert.equal(f.refreshCalls(), 0);
      assert.ok(f.nodes().some(node => node.type === "pre" && node.props.children === payload));
    }
  }
  assert.equal(f.requests.filter(request => request.init?.method === "POST").length, 2);
  assert.equal(f.refreshCalls(), 1); assert.equal(f.invalidations(), 0);
});

test("401 from an explicit recovered confirmation invalidates the session and clears the exact request without any automatic POST retry", async t => {
  const f = mount(t), { detail, batch, payload } = evidence();
  const restore = (f.panel().props.onRestore as (detail: CsvConfirmationRecoveryDetailResponse) => Promise<boolean>)(detail);
  f.requests[0].resolve(batch); assert.equal(await restore, true); await f.settle();
  const retry = f.nodes().find(node => node.type === "button" && node.props.children === "重试完全相同的确认请求");
  assert.ok(retry); (retry.props.onClick as () => void)(); await f.settle();
  assert.equal(f.requests[1].init?.body, payload);
  assert.equal(new Headers(f.requests[1].init?.headers).get("X-Workbench-Session-Binding"), sessionBinding);
  f.requests[1].resolve({ error: "UNAUTHENTICATED" }, 401); await f.settle(); await f.settle();
  assert.equal(f.invalidations(), 1); assert.equal(f.refreshCalls(), 0);
  assert.equal(f.requests.filter(request => request.init?.method === "POST").length, 1);
  assert.equal(f.nodes().some(node => node.type === "pre" && node.props.children === payload), false);
  assert.equal(f.nodes().some(node => node.type === "button" && node.props.children === "重试完全相同的确认请求"), false);
  assert.equal(f.nodes().some(node => node.props.role === "alert"), false);
  assert.equal(f.locks.at(-1), false);
});

test("legacy recovery mode omits the new upload and mapping UI while default mode remains unchanged", t => {
  const legacy = mount(t, { legacyRecoveryOnly: true });
  assert.ok(legacy.panel());
  assert.equal(legacy.nodes().some(node => node.type === "form" || node.type === "wizard" || node.props.type === "file"), false);
  assert.ok(legacy.nodes().some(node => node.type === "h2" && node.props.children === "旧 CSV 确认恢复与审计"));
  assert.equal(legacy.requests.length, 0);
  const original = mount(t);
  assert.ok(original.nodes().some(node => node.type === "form"));
  assert.ok(original.nodes().some(node => node.type === "wizard"));
});

test("switching to legacy-only rejects retained upload and wizard callbacks before reading new file bytes", async t => {
  const f = mount(t); let reads = 0;
  const file = { name: "synthetic.csv", size: 1, arrayBuffer: async () => { reads++; return new Uint8Array([49]).buffer; } };
  const fileInput = f.nodes().find(node => node.props["aria-label"] === "CSV 原文件")!;
  (fileInput.props.onChange as (event: unknown) => void)({ target: { files: [file] } }); f.flush();
  const wizard = f.nodes().find(node => node.type === "wizard")!;
  const apply = wizard.props.onApply as (text: string, hash: string) => boolean;
  assert.equal(apply("{}", "synthetic-hash"), true); f.flush();
  const submit = f.nodes().find(node => node.type === "form")!.props.onSubmit as (event: unknown) => Promise<void>;
  f.setLegacyRecoveryOnly(true);
  assert.equal(apply("changed", "changed-hash"), false);
  await submit({ preventDefault() {} }); await f.settle();
  assert.equal(reads, 0); assert.equal(f.requests.length, 0);
  assert.equal(f.nodes().some(node => node.type === "form" || node.type === "wizard"), false);
});

test("legacy-only explicit retries preserve the original BOM payload across failure without creating a background request", async t => {
  const f = mount(t, { legacyRecoveryOnly: true }), { detail, batch, payload } = evidence();
  const restore = (f.panel().props.onRestore as (detail: CsvConfirmationRecoveryDetailResponse) => Promise<boolean>)(detail);
  f.requests[0].resolve(batch); assert.equal(await restore, true); await f.settle();
  assert.equal(f.requests.length, 1);
  for (const status of [503, 200]) {
    const retry = f.nodes().find(node => node.type === "button" && node.props.children === "重试完全相同的确认请求")!;
    assert.equal(retry.props.disabled, false); (retry.props.onClick as () => void)(); await f.settle();
    const request = f.requests.at(-1)!;
    assert.equal(request.url, "/api/workbench"); assert.equal(request.init?.method, "POST");
    assert.deepEqual(Buffer.from(String(request.init.body)), Buffer.from(payload));
    assert.equal(new Headers(request.init.headers).get("X-Workbench-Session-Binding"), sessionBinding);
    request.resolve(status === 503 ? { error: "WORKBENCH_UNAVAILABLE" } : { revision: 1,
      receipts: [{ event_id: "synthetic-event", audit_id: "synthetic-audit", revision: 1, warnings: [] }], duplicate: true }, status);
    await f.settle(); await f.settle();
    assert.equal(f.nodes().some(node => node.type === "form" || node.type === "wizard"), false);
    if (status === 503) { assert.equal(f.requests.length, 2); assert.equal(f.refreshCalls(), 0); }
  }
  assert.equal(f.refreshCalls(), 1); assert.equal(f.requests.filter(request => request.init?.method === "POST").length, 2);
  assert.equal(f.requests.some(request => request.url === "/api/workbench/csv/jobs" || request.url === "/api/workbench/csv"), false);
});

test("background-owned recovery preserves the frozen request but directs users back to tasks instead of retrying or falling back", async t => {
  const f = mount(t, { legacyRecoveryOnly: true }), { detail, batch, payload } = evidence();
  const restore = (f.panel().props.onRestore as (detail: CsvConfirmationRecoveryDetailResponse) => Promise<boolean>)(detail);
  f.requests[0].resolve(batch); assert.equal(await restore, true); await f.settle();
  const retry = () => f.nodes().find(node => node.type === "button" && node.props.children === "重试完全相同的确认请求")!;
  (retry().props.onClick as () => void)(); await f.settle();
  assert.equal(f.requests[1].init?.body, payload);
  f.requests[1].resolve({ error: "CSV_BACKGROUND_CONFIRM_REQUIRED" }, 409); await f.settle(); await f.settle();
  assert.ok(f.nodes().some(node => node.props.role === "alert" && String(node.props.children).includes("返回后台 CSV 任务入口核对状态")));
  assert.ok(f.nodes().some(node => node.type === "pre" && node.props.children === payload));
  assert.equal(retry().props.disabled, true); (retry().props.onClick as () => void)(); await f.settle();
  assert.equal(f.requests.length, 2); assert.equal(f.refreshCalls(), 0);
  const finish = f.nodes().find(node => node.type === "button" && node.props.children === "结束旧恢复展示，返回任务入口")!;
  (finish.props.onClick as () => void)(); await f.settle();
  assert.equal(f.nodes().some(node => node.type === "pre" && node.props.children === payload), false);
  assert.equal(f.nodes().some(node => node.type === "form" || node.type === "wizard"), false);
  assert.equal(f.panel().props.disabled, false); assert.equal(f.requests.length, 2);
});

test("legacy-only recovery in restore read-only mode retains audit and download links without permitting confirmation", async t => {
  const f = mount(t, { legacyRecoveryOnly: true, readOnly: true }), { detail, batch, payload } = evidence();
  const restore = (f.panel().props.onRestore as (detail: CsvConfirmationRecoveryDetailResponse) => Promise<boolean>)(detail);
  f.requests[0].resolve(batch); assert.equal(await restore, true); await f.settle();
  assert.ok(f.nodes().some(node => node.type === "pre" && node.props.children === payload));
  assert.equal(f.nodes().filter(node => node.type === "a" && node.props.download).length, 2);
  const retry = f.nodes().find(node => node.type === "button" && node.props.children === "重试完全相同的确认请求")!;
  assert.equal(retry.props.disabled, true); (retry.props.onClick as () => void)(); await f.settle();
  assert.equal(f.requests.length, 1); assert.equal(f.refreshCalls(), 0);
  assert.equal(f.nodes().some(node => node.type === "form" || node.type === "wizard"), false);
});
