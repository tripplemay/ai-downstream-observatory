import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import ts from "typescript";
import { SESSION_INVALIDATED_EVENT } from "../src/components/session-boundary-state";

type Tree = { type: string | ((props: Record<string, unknown>) => Tree); props: Record<string, unknown> };
type Effect = () => void | (() => void);
type Response = { status: number; ok: boolean; json: () => Promise<unknown>; text: () => Promise<string> };
const compiled = new Map<string, string>();
function compile(url: URL) {
  if (!compiled.has(url.href)) {
    const result = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
    assert.deepEqual(result.diagnostics, []); compiled.set(url.href, result.outputText);
  }
  return compiled.get(url.href)!;
}

// Actual component/hook code with controlled events and transport, not a DOM or native-browser acceptance.
export function mountInvestorDisplay<P>(t: { after: (fn: () => void) => void }, source: URL, name: string, initial: P,
  imports: Record<string, unknown>, start: number) {
  let props = initial, wall = start, elapsed = 0, timerId = 0, cursor = 0, scheduled = false, mounted = true, tree: Tree;
  const timers = new Map<number, { callback: () => void; at: number; interval?: number }>(), hooks: unknown[] = [];
  const effects: { dependencies?: unknown[]; cleanup?: () => void }[] = []; let pending: (() => void)[] = [];
  const windowListeners = new Map<string, Set<() => void>>(), documentListeners = new Map<string, Set<() => void>>();
  const listeners = (map: typeof windowListeners) => ({ addEventListener(event: string, fn: () => void) {
    if (!map.has(event)) map.set(event, new Set()); map.get(event)!.add(fn);
  }, removeEventListener(event: string, fn: () => void) { map.get(event)?.delete(fn); } });
  const document = { ...listeners(documentListeners), visibilityState: "visible" }, window = { ...listeners(windowListeners), confirm: () => false,
    dispatchEvent(event: { type: string }) { for (const fn of windowListeners.get(event.type) ?? []) fn(); return true; } };
  const requests: { url: string; method: string; options: RequestInit; resolve: (value: Response) => void; reject: (error: Error) => void }[] = [];
  const requestWaiters = new Set<(error?: Error) => void>();
  const schedule = () => { if (!scheduled && mounted) { scheduled = true; queueMicrotask(() => { scheduled = false; if (mounted) render(); }); } };
  const react = { Fragment: "Fragment", useState(initial: unknown) { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
    return [hooks[index], (value: unknown) => { const next = typeof value === "function" ? value(hooks[index]) : value;
      if (!Object.is(next, hooks[index])) { hooks[index] = next; schedule(); } }]; },
    useRef(initial: unknown) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index]; },
    useCallback(callback: unknown, dependencies: unknown[]) { const index = cursor++, previous = hooks[index] as { value: unknown; dependencies: unknown[] } | undefined;
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) hooks[index] = { value: callback, dependencies };
      return (hooks[index] as { value: unknown }).value; },
    useMemo(callback: () => unknown, dependencies: unknown[]) { const index = cursor++, previous = hooks[index] as { value: unknown; dependencies: unknown[] } | undefined;
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) hooks[index] = { value: callback(), dependencies };
      return (hooks[index] as { value: unknown }).value; },
    useEffect(callback: Effect, dependencies?: unknown[]) { const index = cursor++, previous = effects[index];
      if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous.dependencies?.[i]))) {
        const next = { dependencies, cleanup: undefined as (() => void) | undefined }; effects[index] = next;
        pending.push(() => { previous?.cleanup?.(); const cleanup = callback(); if (cleanup) next.cleanup = cleanup; });
      } },
  };
  const jsx = (type: Tree["type"], value: Tree["props"]) => ({ type, props: value });
  const dependencies = { react: { ...react, default: react }, "react/jsx-runtime": { jsx, jsxs: jsx }, "@/components/ui/button": { Button: "Button" },
    "@/components/session-boundary-state": { SESSION_INVALIDATED_EVENT }, ...imports };
  const arm = (callback: () => void, delay: number, interval?: number) => {
    const id = ++timerId; timers.set(id, { callback, at: elapsed + delay, interval }); return id;
  };
  const context = { window, document, AbortController, TextEncoder, Element: class {}, CustomEvent: class { constructor(public type: string) {} },
    crypto: { randomUUID: () => "fictional-display-command", subtle: webcrypto.subtle },
    Date: class extends Date { static now() { return wall; } }, performance: { now: () => elapsed },
    setTimeout: (fn: () => void, delay: number) => arm(fn, delay), clearTimeout: (id: number) => timers.delete(id),
    setInterval: (fn: () => void, delay: number) => arm(fn, delay, delay), clearInterval: (id: number) => timers.delete(id),
    fetch: (url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
      requests.push({ url, options, method: options.method ?? "GET", resolve, reject });
      for (const notify of [...requestWaiters]) notify();
    }),
  };
  function load(url: URL) {
    const module = { exports: {} as Record<string, (value: P) => Tree> };
    const initialize = runInNewContext(`(function(require,module,exports){${compile(url)}\n})`, context);
    initialize((name: string) => { assert.ok(name in dependencies, name); return dependencies[name as keyof typeof dependencies]; }, module, module.exports);
    return module.exports;
  }
  Object.assign(dependencies, { "./investor-display-clock": load(new URL("../src/components/workbench/investor-display-clock.ts", import.meta.url)) });
  const component = load(source)[name]; assert.equal(typeof component, "function");
  function render() { cursor = 0; pending = []; tree = component(props); for (const effect of pending) effect(); }
  render(); const first = tree!;
  const close = () => {
    mounted = false; for (const effect of effects) effect?.cleanup?.(); timers.clear();
    for (const notify of [...requestWaiters]) notify(new Error("Display fixture closed before expected request"));
  };
  t.after(close);
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const expand = (initial: Tree) => {
    let node = initial;
    while (typeof node.type === "function" && ["Card", "ReferencePlanCard", "ModelChange", "ResearchTask", "ModelWatch", "PolicyReview", "Scenario", "FundedComparisonResults"].includes(node.type.name)) node = node.type(node.props);
    return node;
  };
  const visit = (value: unknown, found: Tree[]) => { if (Array.isArray(value)) { value.forEach(child => visit(child, found)); return; }
    if (value && typeof value === "object" && "props" in value) { const node = expand(value as Tree); found.push(node); visit(node.props.children, found); } };
  const words = (value: unknown): string => Array.isArray(value) ? value.map(words).join("") : value && typeof value === "object" && "props" in value
    ? words(expand(value as Tree).props.children) : typeof value === "string" || typeof value === "number" ? String(value) : "";
  const nodes = () => { const found: Tree[] = []; visit(tree, found); return found; };
  const node = (type: string) => nodes().find(item => item.type === type);
  const button = (label: string) => nodes().find(item => item.type === "Button" && words(item) === label);
  // File I/O and native WebCrypto are not bounded by a number of microtask turns.
  const waitRequests = async (count: number) => {
    if (requests.length >= count) { assert.equal(requests.length, count); return; }
    await new Promise<void>((resolve, reject) => {
      const notify = (error?: Error) => {
        if (!error && requests.length < count) return;
        clearTimeout(timeout); requestWaiters.delete(notify);
        if (error) reject(error);
        else {
          try { assert.equal(requests.length, count); resolve(); } catch (failure) { reject(failure); }
        }
      };
      const timeout = setTimeout(() => notify(new Error(`Expected ${count} requests; observed ${requests.length}`)), 2000);
      requestWaiters.add(notify);
    });
  };
  return { requests, document, timers, windowListeners, documentListeners, first: () => words(first), text: () => words(tree), words, nodes, node, button, flush, close,
    waitRequests,
    click: async (label: string) => { const target = button(label); assert.ok(target, label); assert.equal(!!target.props.disabled, false, label);
      (target.props.onClick as () => void)(); await flush(); },
    change: async (changes: Partial<P>) => { props = { ...props, ...changes }; render(); await flush(); },
    invalidate: async () => { for (const fn of windowListeners.get(SESSION_INVALIDATED_EVENT) ?? []) fn(); await flush(); },
    wake: async () => { for (const fn of documentListeners.get("visibilitychange") ?? []) fn(); await flush(); },
    setWall: (value: number) => { wall = value; },
    advance: async (value: number, duration = Math.max(0, value - wall)) => {
      wall = value; elapsed += duration;
      for (const [id, timer] of [...timers]) if (timer.at <= elapsed) {
        if (timer.interval) timer.at = elapsed + timer.interval; else timers.delete(id); timer.callback();
      }
      await flush();
    },
    reply: async (index: number, value: unknown, status = 200) => { requests[index].resolve({ status, ok: status >= 200 && status < 300,
      json: async () => value, text: async () => JSON.stringify(value) }); await flush(); },
    fail: async (index: number) => { requests[index].reject(new Error("Fictional lost response")); await flush(); },
  };
}
