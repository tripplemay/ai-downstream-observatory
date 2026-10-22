import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { SESSION_INVALIDATED_EVENT } from "../src/components/session-boundary-state";
import * as client from "../src/components/workbench/investor-trade-recording-client";
import { TRADE_RECORDING_ZONES, type TradeRecordingContext } from "../src/server/investor/trade-recording-schemas";
import type { ReconciliationScope } from "../src/components/workbench/investor-reconciliation-client";

const compiled = ts.transpileModule(readFileSync(new URL("../src/components/workbench/investor-trade-recording-panel.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const binding = "a".repeat(64), other = "b".repeat(64);
const scope: ReconciliationScope = { binding, workspace: "fictional-workspace", revision: 2, portfolio: "fictional-book", ledgerRevision: 3,
  linkId: "fictional-link", linkVersion: 1, accountId: "fictional-account", accountRowVersion: 4 };
const context: TradeRecordingContext = { schema_version: "investor-trade-recording-v1", workspace_id: scope.workspace!, workspace_revision: scope.revision,
  portfolio_id: scope.portfolio, ledger_revision: scope.ledgerRevision, link_id: scope.linkId, link_version: scope.linkVersion, account_id: scope.accountId,
  account_row_version: scope.accountRowVersion, account_status: "active", checked_at: "2026-01-02T12:00:00.000Z", read_only: false, context_hash: "c".repeat(64),
  listings: [{ id: "fictional-listing", ticker: "FICTIONAL", name: "Fictional ETF only", market: "US", currency: "USD" }],
  unsettled_trades: [{ event_id: "fictional-event", direction: "buy", currency: "USD", effective_at: "2026-01-01", source_id: "FICTIONAL", source_event_id: "1" }],
  basis: "metadata_only_no_fact_prefill", execution_authorized: false };
type Tree = { type: string; props: Record<string, unknown> };
type Props = { scope: ReconciliationScope; accountName: string; disabled: boolean; onCommand: (input: unknown) => void; onDraftLockChange: (locked: boolean) => void };

// Hook/event harness only: native form validation, layout and real Next authentication remain separate acceptance.
function mount(t: { after: (callback: () => void) => void }, initial: Partial<Props> = {}) {
  const commands: unknown[] = [], locks: boolean[] = [], listeners = new Map<string, Set<() => void>>(), emitted: string[] = [];
  let props: Props = { scope, accountName: "Fictional private account", disabled: false, onCommand: input => commands.push(input), onDraftLockChange: locked => locks.push(locked), ...initial };
  const window = { addEventListener(name: string, fn: () => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
    removeEventListener(name: string, fn: () => void) { listeners.get(name)?.delete(fn); }, confirm: () => true,
    dispatchEvent(event: { type: string }) { emitted.push(event.type); for (const fn of listeners.get(event.type) ?? []) fn(); return true; } };
  const document = { addEventListener() {}, removeEventListener() {} };
  const requests: { url: string; options: RequestInit; resolve: (value: { status: number; ok: boolean; json: () => Promise<unknown> }) => void; reject: (error: Error) => void }[] = [];
  let cursor = 0, scheduled = false, mounted = true, tree: Tree, timer = 0, verified = true;
  const hooks: unknown[] = [], timers = new Map<number, () => void>();
  const effects: { dependencies?: unknown[]; cleanup?: () => void }[] = []; let pending: (() => void)[] = [];
  const schedule = () => { if (!scheduled && mounted) { scheduled = true; queueMicrotask(() => { scheduled = false; if (mounted) render(); }); } };
  const react = {
    useState(initial: unknown) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], (value: unknown) => {
      const next = typeof value === "function" ? value(hooks[index]) : value; if (!Object.is(next, hooks[index])) { hooks[index] = next; schedule(); }
    }]; },
    useRef(initial: unknown) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index]; },
    useEffect(callback: () => void | (() => void), dependencies?: unknown[]) { const index = cursor++, previous = effects[index];
      if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous.dependencies?.[i]))) {
        const next = { dependencies, cleanup: undefined as (() => void) | undefined }; effects[index] = next;
        pending.push(() => { previous?.cleanup?.(); const cleanup = callback(); if (cleanup) next.cleanup = cleanup; });
      }
    },
  };
  const jsx = (type: string, value: Record<string, unknown>) => ({ type, props: value });
  const dependencies: Record<string, unknown> = { react, "react/jsx-runtime": { jsx, jsxs: jsx }, "next/link": { default: "Link", __esModule: true },
    "@/components/ui/button": { Button: "Button" }, "@/components/ui/input": { Input: "Input" },
    "@/components/session-boundary": { useSessionBoundary: () => ({ verified, sessionBinding: props.scope.binding }) },
    "@/components/session-boundary-state": { SESSION_INVALIDATED_EVENT }, "@/server/investor/trade-recording-schemas": { TRADE_RECORDING_ZONES },
    "./investor-trade-recording-client": client };
  const module = { exports: {} as { InvestorTradeRecordingPanel: (props: Props) => Tree } };
  const initialize = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { window, document, AbortController, Element: class {},
    CustomEvent: class { constructor(public type: string) {} }, setTimeout: (callback: () => void) => { timers.set(++timer, callback); return timer; }, clearTimeout: (id: number) => timers.delete(id),
    fetch: (url: string, options: RequestInit) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  }) as (require: (name: string) => unknown, module: unknown, exports: unknown) => void;
  initialize(name => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports);
  function render() { cursor = 0; pending = []; tree = module.exports.InvestorTradeRecordingPanel(props); for (const effect of pending) effect(); }
  render(); t.after(() => { mounted = false; for (const effect of effects) effect?.cleanup?.(); timers.clear(); });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const visit = (value: unknown, found: Tree[]) => { if (Array.isArray(value)) { value.forEach(child => visit(child, found)); return; }
    if (value && typeof value === "object" && "props" in value) { const node = value as Tree; found.push(node); visit(node.props.children, found); } };
  const nodes = (root: unknown = tree) => { const found: Tree[] = []; visit(root, found); return found; };
  const words = (value: unknown): string => Array.isArray(value) ? value.map(words).join("") : value && typeof value === "object" && "props" in value
    ? words((value as Tree).props.children) : typeof value === "string" || typeof value === "number" ? String(value) : "";
  function field(label: string) { const node = nodes().find(row => row.type === "label" && words(row).startsWith(label)); assert.ok(node, label);
    const input = nodes(node).find(row => ["Input", "select"].includes(row.type)); assert.ok(input, label); return input; }
  return { commands, locks, emitted, requests, text: () => words(tree), fields: () => nodes().filter(row => ["Input", "select"].includes(row.type)),
    click: async (label: string) => { const node = nodes().find(row => row.type === "Button" && words(row) === label); assert.ok(node, label);
      assert.equal(node.props.disabled ?? false, false, label); (node.props.onClick as () => void)(); await flush(); },
    input: async (label: string, value: string) => { (field(label).props.onChange as (event: unknown) => void)({ target: { value } }); await flush(); },
    acknowledge: async (checked: boolean) => { const node = nodes().find(row => row.type === "input" && row.props.type === "checkbox"); assert.ok(node);
      (node.props.onChange as (event: unknown) => void)({ target: { checked } }); await flush(); },
    acknowledged: () => nodes().find(row => row.type === "input" && row.props.type === "checkbox")?.props.checked,
    submit: async (twice = false) => { const node = nodes().find(row => row.type === "form"); assert.ok(node);
      const send = node.props.onSubmit as (event: unknown) => void; send({ preventDefault() {} }); if (twice) send({ preventDefault() {} }); await flush(); },
    change: async (value: Partial<Props>) => { props = { ...props, ...value }; render(); await flush(); },
    unverify: async () => { verified = false; render(); await flush(); },
    invalidate: async () => { window.dispatchEvent({ type: SESSION_INVALIDATED_EVENT }); await flush(); },
    reply: async (index: number, value: unknown = { ...context, session_binding: props.scope.binding }, status = 200) => {
      requests[index].resolve({ status, ok: status >= 200 && status < 300, json: async () => value }); await flush(); },
    fail: async (index: number) => { requests[index].reject(new Error("Fictional lost GET")); await flush(); },
  };
}
async function fill(f: ReturnType<typeof mount>) {
  for (const [name, value] of [["实际成交方向", "buy"], ["证券（", "fictional-listing"], ["实际成交数量", "2"], ["成交本金", "21"], ["实际费用总额", "0.1"],
    ["实际成交日期", "2026-01-01"], ["资料时区", "UTC"], ["来源标识", "FICTIONAL"], ["原始成交", "2"], ["独立资料", "Fictional source"]]) await f.input(name, value);
}

test("manual entry is lazy and blank; edits reset acknowledgement; one confirmation hands an immutable fact to the existing parent", async t => {
  const f = mount(t); assert.equal(f.requests.length, 0); assert.equal(f.commands.length, 0);
  await f.click("录入已发生成交"); assert.equal(f.requests[0].options.method ?? "GET", "GET"); assert.equal(f.locks.at(-1), true);
  assert.match(f.requests[0].url, /trade-recording\?account=fictional-account$/); await f.reply(0);
  assert.ok(f.fields().every(row => row.props.value === "")); assert.equal(f.acknowledged(), false); await fill(f);
  await f.acknowledge(true); await f.input("实际费用总额", "0.2"); assert.equal(f.acknowledged(), false); await f.submit(); assert.equal(f.commands.length, 0);
  await f.acknowledge(true); await f.submit(true); assert.equal(f.commands.length, 1); assert.equal(f.locks.at(-1), false);
  const input = f.commands[0] as { entry: unknown }; assert.deepEqual(input.entry, { type: "buy", listing_id: "fictional-listing", currency: "USD", quantity: "2", consideration: "21", fee: "0.2" });
  assert.equal(f.requests.length, 1); assert.ok(!f.text().includes("数量 2"));
});

test("settlement form requires parent choice and actual cash; cancel releases the account scope without a mutation", async t => {
  const f = mount(t); await f.click("录入实际交收"); await f.reply(0);
  assert.ok(f.fields().every(row => row.props.value === "")); assert.equal(f.commands.length, 0);
  await f.input("关联的未完成", "fictional-event"); await f.input("本次实际交收现金", "4"); assert.match(f.text(), /本次现金 4/);
  await f.click("取消并清除草稿"); assert.equal(f.locks.at(-1), false); assert.equal(f.commands.length, 0); assert.ok(!f.text().includes("本次现金 4"));
});

test("failed reads do not loop, foreign or read-only context never becomes an editable draft, and locking hides but can discard a local draft", async t => {
  const f = mount(t); await f.click("录入已发生成交"); await f.fail(0); assert.equal(f.requests.length, 1); assert.equal(f.locks.at(-1), false);
  await f.click("录入已发生成交"); await f.reply(1, { ...context, account_id: "foreign", session_binding: binding }); assert.equal(f.fields().length, 0);
  await f.click("录入已发生成交"); await f.reply(2, { ...context, read_only: true, session_binding: binding }); assert.equal(f.fields().length, 0);
  await f.click("录入已发生成交"); await f.reply(3); await fill(f); await f.change({ disabled: true });
  assert.ok(!f.text().includes("数量 2")); assert.equal(f.commands.length, 0); await f.click("取消并清除草稿"); assert.equal(f.locks.at(-1), false);
});

test("scope changes abort old GETs and suppress old 401s; current logout clears private drafts and never submits", async t => {
  const f = mount(t); await f.click("录入已发生成交"); await f.change({ scope: { ...scope, binding: other } }); assert.equal(f.requests[0].options.signal?.aborted, true);
  await f.reply(0, {}, 401); assert.deepEqual(f.emitted, []); await f.click("录入已发生成交"); await f.reply(1); await fill(f);
  await f.invalidate(); assert.equal(f.fields().length, 0); assert.equal(f.commands.length, 0); assert.equal(f.locks.at(-1), false);
});

test("loss of session verification clears amounts, and a current metadata 401 invalidates the global session", async t => {
  const f = mount(t); await f.click("录入已发生成交"); await f.reply(0); await fill(f); await f.unverify();
  assert.equal(f.fields().length, 0); assert.ok(!f.text().includes("数量 2")); assert.equal(f.commands.length, 0);
  const g = mount(t); await g.click("录入已发生成交"); await g.reply(0, {}, 401); assert.deepEqual(g.emitted, [SESSION_INVALIDATED_EVENT]); assert.equal(g.commands.length, 0);
});

test("optional account CSV is a native initially closed fold with its existing workspace always mounted inside", () => {
  const source = ts.createSourceFile("account.tsx", readFileSync(new URL("../src/components/workbench/investor-account-workspace.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let fold: ts.JsxElement | undefined;
  function find(node: ts.Node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "details" && node.openingElement.attributes.properties.some(attribute =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "data-testid" && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === "optional-account-csv")) fold = node;
    ts.forEachChild(node, find);
  }
  find(source); const section = fold as ts.JsxElement | undefined; assert.ok(section);
  assert.ok(!section.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && ["open", "onToggle"].includes(attribute.name.getText(source))));
  const workspaces: ts.JsxSelfClosingElement[] = [];
  function workspacesIn(node: ts.Node) { if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "CsvBackgroundWorkspace") workspaces.push(node); ts.forEachChild(node, workspacesIn); }
  workspacesIn(section); assert.equal(workspaces.length, 1);
  assert.ok(ts.isJsxElement(workspaces[0].parent)); assert.equal(workspaces[0].parent.parent, section);
  assert.match(section.getText(source), /csvLocked && <span role="status">/);
});

test("account integration includes manual draft in CSV, selectors, reconciliation, holdings and parent scope locks", () => {
  const source = readFileSync(new URL("../src/components/workbench/investor-account-workspace.tsx", import.meta.url), "utf8");
  assert.match(source, /csvLocked \|\| reconciliationLocked \|\| tradeLocked/);
  assert.match(source, /!csvLocked && !reconciliationLocked && !tradeLocked/);
  assert.match(source, /readOnly=\{disabled \|\| reconciliationLocked \|\| tradeLocked/);
  assert.match(source, /onDraftLockChange=\{setTradeLocked\}/);
  assert.match(source, /disabled=\{disabled \|\| busy \|\| csvLocked \|\| tradeLocked \|\| cashLocked \|\| valuationLocked \|\| executionLocked \|\| !visible\}/);
  assert.match(source, /disabled=\{disabled \|\| busy \|\| csvLocked \|\| reconciliationLocked \|\| tradeLocked \|\| cashLocked \|\| valuationLocked \|\| !visible\}/);
  assert.match(source, /onDraftLockChange=\{setValuationLocked\}/);
  assert.match(source, /readOnly=\{disabled \|\| reconciliationLocked \|\| tradeLocked \|\| cashLocked \|\| valuationLocked/);
});
