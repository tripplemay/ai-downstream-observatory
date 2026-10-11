import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { SESSION_INVALIDATED_EVENT } from "../src/components/session-boundary-state";
import * as client from "../src/components/workbench/investor-notifications-client";
import type { InvestorInbox } from "../src/server/investor/notification-schemas";

const compiled = ts.transpileModule(readFileSync(new URL("../src/components/workbench/investor-notifications-panel.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const binding = "a".repeat(64), other = "b".repeat(64), at = "2026-01-03T12:15:04.000Z";
const notice = { id: "fictional-notice", publication_id: "fictional-publication", workspace_id: "fictional-workspace", model_id: "fictional-model",
  observation_id: "fictional-observation", recorded_outcome: "decision_required" as const, published_at: at, publication_hash: "c".repeat(64),
  read_at: null, is_current_conclusion: false as const, live_advice_eligible: false as const };
const inbox: InvestorInbox = { schema_version: "investor-notifications-v1", workspace_id: notice.workspace_id, checked_at: at,
  entries: [notice], read_only: false, has_more: false, visible_unread_count: 1, external_delivery_configured: false, live_advice_eligible: false };
type Tree = { type: string; props: Record<string, unknown> };
type Effect = () => void | (() => void);
type Props = { workspaceId: string | null; binding: string; disabled: boolean; readOnly: boolean; revision: number };

// A deterministic hook/event harness; this does not replace Radix, layout or native-browser acceptance.
function mount(t: { after: (callback: () => void) => void }, initial: Partial<Props> = {}) {
  let props: Props = { workspaceId: notice.workspace_id, binding, disabled: false, readOnly: false, revision: 1, ...initial };
  const listeners = new Map<string, Set<() => void>>(), emitted: string[] = [];
  const window = { addEventListener(name: string, fn: () => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
    removeEventListener(name: string, fn: () => void) { listeners.get(name)?.delete(fn); },
    dispatchEvent(event: { type: string }) { emitted.push(event.type); for (const fn of listeners.get(event.type) ?? []) fn(); return true; } };
  const document = { visibilityState: "visible" };
  const requests: { method: string; options: RequestInit; resolve: (response: { status: number; ok: boolean; json: () => Promise<unknown> }) => void; reject: (error: Error) => void }[] = [];
  let clock = 0, timerId = 0, cursor = 0, scheduled = false, mounted = true, tree: Tree;
  const timers = new Map<number, { callback: () => void; at: number; interval?: number }>(), hooks: unknown[] = [];
  const effects: { dependencies?: unknown[]; cleanup?: () => void }[] = []; let pending: (() => void)[] = [];
  const schedule = () => { if (!scheduled && mounted) { scheduled = true; queueMicrotask(() => { scheduled = false; if (mounted) render(); }); } };
  const react = {
    useState(initial: unknown) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], (value: unknown) => { const next = typeof value === "function" ? value(hooks[index]) : value; if (!Object.is(next, hooks[index])) { hooks[index] = next; schedule(); } }]; },
    useRef(initial: unknown) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index]; },
    useEffect(callback: Effect, dependencies?: unknown[]) { const index = cursor++, previous = effects[index];
      if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous.dependencies?.[i]))) {
        const next = { dependencies, cleanup: undefined as (() => void) | undefined }; effects[index] = next;
        pending.push(() => { previous?.cleanup?.(); const cleanup = callback(); if (cleanup) next.cleanup = cleanup; });
      }
    },
  };
  const jsx = (type: string, value: Record<string, unknown>) => ({ type, props: value });
  const dependencies: Record<string, unknown> = { react, "react/jsx-runtime": { jsx, jsxs: jsx }, "next/link": { default: "Link", __esModule: true },
    "lucide-react": { Bell: "Bell" }, "@/components/ui/button": { Button: "Button" },
    "@/components/ui/dialog": Object.fromEntries(["Dialog", "DialogContent", "DialogDescription", "DialogHeader", "DialogTitle", "DialogTrigger"].map(name => [name, name])),
    "@/components/session-boundary-state": { SESSION_INVALIDATED_EVENT }, "./investor-notifications-client": client };
  const module = { exports: {} as { InvestorNotificationsPanel: (props: Props) => Tree } };
  const initialize = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { window, document, AbortController,
    CustomEvent: class { constructor(public type: string) {} },
    setTimeout: (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { callback, at: clock + delay, interval: delay }); return id; },
    clearInterval: (id: number) => timers.delete(id),
    fetch: (url: string, options: RequestInit) => { assert.equal(url, "/api/workbench/investor/notifications");
      return new Promise((resolve, reject) => requests.push({ method: options.method ?? "GET", options, resolve, reject })); },
  }) as (require: (name: string) => unknown, module: unknown, exports: unknown) => void;
  initialize(name => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports);
  function render() { cursor = 0; pending = []; tree = module.exports.InvestorNotificationsPanel(props); for (const effect of pending) effect(); }
  render(); t.after(() => { mounted = false; for (const effect of effects) effect?.cleanup?.(); timers.clear(); });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const visit = (value: unknown, found: Tree[]) => { if (Array.isArray(value)) { value.forEach(child => visit(child, found)); return; }
    if (value && typeof value === "object" && "props" in value) { const node = value as Tree; found.push(node); visit(node.props.children, found); } };
  const nodes = () => { const found: Tree[] = []; visit(tree, found); return found; };
  const words = (value: unknown): string => Array.isArray(value) ? value.map(words).join("") : value && typeof value === "object" && "props" in value
    ? words((value as Tree).props.children) : typeof value === "string" || typeof value === "number" ? String(value) : "";
  return { requests, document, emitted, timers, open: () => tree.props.open, text: () => words(tree),
    links: () => nodes().filter(item => item.type === "Link"),
    show: async () => { (tree.props.onOpenChange as (value: boolean) => void)(true); await flush(); },
    click: async (label: string) => { const node = nodes().find(item => item.type === "Button" && words(item) === label); assert.ok(node, label);
      assert.equal(node.props.disabled, false, label); (node.props.onClick as () => void)(); await flush(); },
    disabled: (label: string) => nodes().find(item => item.type === "Button" && words(item) === label)?.props.disabled,
    change: async (changes: Partial<Props>) => { props = { ...props, ...changes }; render(); await flush(); },
    invalidate: async () => { window.dispatchEvent({ type: SESSION_INVALIDATED_EVENT }); await flush(); },
    reply: async (index: number, value: unknown = { ...inbox, session_binding: props.binding }, status = 200) => { requests[index].resolve({ status, ok: status >= 200 && status < 300, json: async () => value }); await flush(); },
    fail: async (index: number) => { requests[index].reject(new Error("Fictional lost response")); await flush(); },
    tick: async (milliseconds: number) => { clock += milliseconds; for (const [id, timer] of [...timers]) if (timer.at <= clock) {
      if (timer.interval) timer.at = clock + timer.interval; else timers.delete(id); timer.callback(); } await flush(); },
  };
}

test("inbox mount, refresh and visible polling only GET; one human read mark POSTs closed metadata then verifies GET", async t => {
  const f = mount(t); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, "GET");
  await f.reply(0); assert.match(f.text(), /最近未读 1/); await f.show(); assert.equal(f.open(), true);
  await f.tick(60000); assert.equal(f.requests[1].method, "GET"); await f.reply(1);
  f.document.visibilityState = "hidden"; await f.tick(60000); assert.equal(f.requests.length, 2); f.document.visibilityState = "visible";
  await f.click("标记已读"); assert.equal(f.requests[2].method, "POST");
  assert.deepEqual(JSON.parse(String(f.requests[2].options.body)), { notice_id: notice.id, publication_hash: notice.publication_hash });
  assert.equal(f.requests[2].options.credentials, "same-origin"); assert.equal(f.disabled("标记已读"), true);
  await f.reply(2, { schema_version: "investor-notification-read-v1", notice_id: notice.id, publication_hash: notice.publication_hash,
    audit_id: "fictional-audit", read_at: at, financial_state_changed: false, session_binding: binding });
  assert.equal(f.requests[3].method, "GET"); await f.reply(3, { ...inbox, entries: [{ ...notice, read_at: at }], visible_unread_count: 0, session_binding: binding });
  assert.match(f.text(), /最近未读 0/); assert.equal(f.requests.filter(row => row.method === "POST").length, 1);
});

test("observation navigation closes the inbox without marking read or changing its publication identity", async t => {
  const f = mount(t); await f.reply(0); await f.show();
  const [link] = f.links();
  assert.equal(link.props.href, "/workbench/observations#research-observation-fictional-observation");
  assert.equal(link.props.onClick, undefined, "Modified clicks keep the source dialog; only Next navigation closes it.");
  const navigate = link.props.onNavigate as () => void;
  navigate(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.open(), false);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, "GET");
  await f.show(); assert.equal(f.open(), true); assert.match(f.text(), /最近未读 1/);
  assert.equal(f.links()[0].props.href, link.props.href);
});

test("unknown read receipt never auto-retries a mutation and manual refresh recovers only through GET", async t => {
  const f = mount(t); await f.reply(0); await f.click("标记已读"); await f.fail(1);
  assert.match(f.text(), /不能推定失败/); assert.doesNotMatch(f.text(), /记录状态：/);
  await f.tick(60000); assert.equal(f.requests[2].method, "GET"); await f.reply(2);
  await f.click("刷新通知"); assert.equal(f.requests[3].method, "GET"); await f.reply(3);
  assert.equal(f.requests.filter(row => row.method === "POST").length, 1);
});

test("logout closes and clears the dialog, aborts in-flight work, suppresses stale replies and stops polling", async t => {
  const f = mount(t); await f.reply(0); await f.show(); await f.click("刷新通知");
  await f.invalidate(); assert.equal(f.open(), false); assert.equal(f.requests[1].options.signal?.aborted, true);
  await f.reply(1); assert.doesNotMatch(f.text(), /记录状态：/); await f.tick(60000); assert.equal(f.requests.length, 2);
});

test("old-binding 401 cannot invalidate a new scope; a current 401 does invalidate the global boundary", async t => {
  const f = mount(t); await f.change({ binding: other }); assert.equal(f.requests.length, 2); assert.equal(f.requests[0].options.signal?.aborted, true);
  await f.reply(0, {}, 401); assert.deepEqual(f.emitted, []); await f.reply(1, { ...inbox, session_binding: other });
  assert.match(f.text(), /最近未读 1/); await f.show(); await f.click("刷新通知"); await f.reply(2, {}, 401);
  assert.deepEqual(f.emitted, [SESSION_INVALIDATED_EVENT]); assert.equal(f.open(), false); assert.doesNotMatch(f.text(), /记录状态：/);
});

test("recovery read-only mode keeps metadata visible and never enables a read-mark mutation", async t => {
  const f = mount(t, { readOnly: true }); await f.reply(0, { ...inbox, read_only: true, session_binding: binding });
  assert.match(f.text(), /恢复只读模式/); assert.equal(f.disabled("标记已读"), true); await f.tick(60000);
  assert.equal(f.requests.every(row => row.method === "GET"), true);
});

test("foreign workspace and promoted advice are hidden; locked scope aborts and never polls or writes", async t => {
  const f = mount(t); await f.reply(0, { ...inbox, workspace_id: "foreign", session_binding: binding });
  assert.doesNotMatch(f.text(), /记录状态：/); assert.match(f.text(), /暂时无法核对/);
  await f.click("刷新通知"); await f.reply(1, { ...inbox, entries: [{ ...notice, is_current_conclusion: true }], session_binding: binding });
  assert.doesNotMatch(f.text(), /记录状态：/); await f.change({ disabled: true }); await f.tick(60000); assert.equal(f.requests.length, 2);
});
