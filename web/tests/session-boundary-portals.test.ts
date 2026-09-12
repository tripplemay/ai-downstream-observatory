import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { SessionBoundary, SessionBoundaryPortal } from "../src/components/session-boundary";
import * as stateHelpers from "../src/components/session-boundary-state";

type Element = { type: unknown; props: Record<string, unknown> };
type Context = { container: unknown; verified: boolean } | null;
const files = ["dialog", "sheet", "select", "dropdown-menu"] as const;
const contentExports = ["DialogContent", "SheetContent", "SelectContent", "DropdownMenuContent"] as const;

// Executes the actual wrapper/render paths; Radix is replaced with a recording portal, not a browser DOM.
function portalHarness() {
  let context: Context = null;
  const portals: Record<string, unknown>[] = [];
  const react = {
    createContext: () => ({}), useContext: () => context,
    forwardRef: (render: (props: Record<string, unknown>, ref: null) => unknown) => (props: Record<string, unknown>) => render(props, null),
  };
  const jsx = { jsx: (type: unknown, props: Record<string, unknown>): Element => ({ type, props }), jsxs: (type: unknown, props: Record<string, unknown>): Element => ({ type, props }) };
  const primitive = new Proxy({}, { get: (_target, key) => key === "Portal"
    ? (props: Record<string, unknown>) => { portals.push(props); return { type: "recorded-portal", props }; }
    : String(key) });
  function load(path: string, additional: Record<string, unknown> = {}) {
    const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const dependencies: Record<string, unknown> = { react, "react/jsx-runtime": jsx, "./session-boundary-state": stateHelpers,
      "@/lib/utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") }, "lucide-react": { X: "icon", Check: "icon", ChevronUp: "icon", ChevronDown: "icon" },
      "@radix-ui/react-dialog": primitive, "@radix-ui/react-select": primitive, "@radix-ui/react-dropdown-menu": primitive, ...additional };
    const module = { exports: {} as Record<string, (props: Record<string, unknown>) => unknown> };
    const initialize = runInNewContext(`(function(require,module,exports){${compiled}\n})`) as (require: (id: string) => unknown, module: unknown, exports: unknown) => void;
    initialize(id => { assert.ok(id in dependencies, id); return dependencies[id]; }, module, module.exports);
    return module.exports;
  }
  const boundary = load("../src/components/session-boundary.tsx");
  const modules = files.map(file => load(`../src/components/ui/${file}.tsx`, { "@/components/session-boundary": boundary }));
  function render(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(render); return; }
    if (!value || typeof value !== "object" || !("props" in value)) return;
    const element = value as Element;
    if (typeof element.type === "function") render(element.type(element.props));
    else render(element.props.children);
  }
  return { portals, setContext(value: Context) { context = value; },
    renderContent(index: number) { render(modules[index][contentExports[index]]({ children: "Synthetic protected selection" })); },
    renderExportedPortal(index: number, container?: unknown) { render(modules[index][index ? "SheetPortal" : "DialogPortal"]({ container, forceMount: true, children: "Synthetic protected dialog" })); },
  };
}

test("SSR cannot call a protected portal renderer before its boundary has verified and mounted", () => {
  let called = false;
  const portal = React.createElement(SessionBoundaryPortal, { children: () => { called = true; return "Sensitive portal contents"; } });
  const html = renderToStaticMarkup(React.createElement(SessionBoundary, { initialBinding: "a".repeat(64), children: portal }));
  assert.equal(called, false); assert.doesNotMatch(html, /Sensitive portal contents/);
  assert.match(html, /data-session-boundary-content="" inert="" aria-hidden="true"/);
});

test("all four protected portal wrappers suppress even force-mounted content before verification or host availability", () => {
  const harness = portalHarness(), container = { node: "protected-boundary" };
  for (const state of [{ container: null, verified: false }, { container, verified: false }, { container: null, verified: true }]) {
    harness.setContext(state);
    for (let i = 0; i < files.length; i++) harness.renderContent(i);
    harness.renderExportedPortal(0, { node: "body" }); harness.renderExportedPortal(1, { node: "body" });
  }
  assert.equal(harness.portals.length, 0);
});

test("verified protected content always targets the exact boundary host, including exported portals with hostile overrides", () => {
  const harness = portalHarness(), container = { node: "protected-boundary" };
  harness.setContext({ container, verified: true });
  for (let i = 0; i < files.length; i++) harness.renderContent(i);
  harness.renderExportedPortal(0, { node: "body" }); harness.renderExportedPortal(1, { node: "unprotected-root" });
  assert.equal(harness.portals.length, 6);
  for (const props of harness.portals) assert.equal(props.container, container);
  assert.equal(harness.portals[4].forceMount, true); assert.equal(harness.portals[5].forceMount, true);
});

test("hidden or changed boundaries do not retain a fallback portal target or borrow another boundary's host", () => {
  const harness = portalHarness(), first = { node: "first" }, second = { node: "second" };
  harness.setContext({ container: first, verified: true }); harness.renderContent(0);
  harness.setContext({ container: first, verified: false }); harness.renderContent(0);
  harness.setContext({ container: second, verified: true }); harness.renderContent(0);
  assert.deepEqual(harness.portals.map(props => props.container), [first, second]);
});

test("UI outside any authenticated boundary preserves default and explicit public portal containers", () => {
  const harness = portalHarness(), custom = { node: "public-custom-root" };
  for (let i = 0; i < files.length; i++) harness.renderContent(i);
  harness.renderExportedPortal(0, custom); harness.renderExportedPortal(1, custom);
  assert.deepEqual(harness.portals.slice(0, 4).map(props => props.container), [undefined, undefined, undefined, undefined]);
  assert.equal(harness.portals[4].container, custom); assert.equal(harness.portals[5].container, custom);
  assert.equal(renderToStaticMarkup(React.createElement(SessionBoundaryPortal, { children: container => container ? "unexpected" : "Public content" })), "Public content");
});

test("source inventory has no additional direct portals bypassing the four controlled wrappers", () => {
  const root = new URL("../src/", import.meta.url);
  const portalFiles = readdirSync(root, { recursive: true }).filter(name => /\.[jt]sx?$/.test(String(name)))
    .map(String).filter(name => /\bcreatePortal\s*\(|\.Portal\b/.test(readFileSync(new URL(name, root), "utf8"))).sort();
  assert.deepEqual(portalFiles, files.map(file => `components/ui/${file}.tsx`).sort());
  for (const file of files) assert.match(readFileSync(new URL(`../src/components/ui/${file}.tsx`, import.meta.url), "utf8"), /SessionBoundaryPortal/);
});
