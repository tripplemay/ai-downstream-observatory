import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("../src/components/workbench/investor-display-clock.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
});
assert.deepEqual(compiled.diagnostics, []);
function mount(checked: number, deadlines: number[]) {
  let clock = checked, elapsed = 0, state: number | null = null, cleanup: (() => void) | undefined, dependencies: unknown[] | undefined;
  const ref = { current: null };
  let id = 0, checkedAt: string | null = new Date(checked).toISOString(), key = deadlines.join("|");
  const timers = new Map<number, { at: number; fn: () => void }>(), listeners = new Set<() => void>();
  let pending: (() => void) | undefined;
  const react = { useRef() { return ref; }, useState() { return [state, (value: ((old: number | null) => number) | number) => { state = typeof value === "function" ? value(state) : value; }]; },
    useEffect(callback: () => () => void, next: unknown[]) {
      if (!dependencies || next.some((value, i) => !Object.is(value, dependencies![i]))) { pending = () => { cleanup?.(); cleanup = callback(); }; dependencies = next; }
    } };
  const module = { exports: {} as { useInvestorDisplayClock: (at: string | null, key: string) => number } };
  const initialize = runInNewContext(`(function(require,module,exports){${compiled.outputText}\n})`, {
    Date: { parse: Date.parse, now: () => clock }, performance: { now: () => elapsed }, document: { addEventListener(name: string, fn: () => void) { assert.equal(name, "visibilitychange"); listeners.add(fn); },
      removeEventListener(name: string, fn: () => void) { assert.equal(name, "visibilitychange"); listeners.delete(fn); } },
    setTimeout(fn: () => void, delay: number) { assert.ok(delay > 0 && delay <= 2147483647); const next = ++id; timers.set(next, { at: elapsed + delay, fn }); return next; },
    clearTimeout(value: number) { timers.delete(value); },
  }) as (require: (name: string) => unknown, module: unknown, exports: unknown) => void;
  initialize(name => { assert.equal(name, "react"); return react; }, module, module.exports);
  const render = () => module.exports.useInvestorDisplayClock(checkedAt, key);
  const first = render(); const commit = () => { pending?.(); pending = undefined; }; commit();
  return { first, render, timers, listeners, setClock(value: number) { clock = value; },
    advance(value: number, duration = Math.max(0, value - clock)) { clock = value; elapsed += duration; for (const [id, timer] of [...timers]) if (timer.at <= elapsed) { timers.delete(id); timer.fn(); } },
    update(at: number, deadlines: number[]) { checkedAt = new Date(at).toISOString(); key = deadlines.join("|"); render(); commit(); },
    wake() { for (const fn of listeners) fn(); }, close() { cleanup?.(); } };
}
test("display clock hydrates from checked time, then crosses exact deadlines without any fetch or polling", () => {
  const h = mount(1000, [1100, 1200]);
  try { assert.equal(h.first, 1000); h.advance(1100); assert.equal(h.render(), 1100); assert.equal(h.timers.size, 1);
    h.advance(1200); assert.equal(h.render(), 1200); assert.equal(h.timers.size, 0); }
  finally { h.close(); }
});
test("background wake and updated inputs cancel obsolete timers; unmount releases all subscriptions", () => {
  const h = mount(1000, [1100, 1200]);
  h.setClock(1300); h.wake(); assert.equal(h.render(), 1300); assert.equal(h.timers.size, 0);
  h.update(1300, [1400]); assert.equal(h.timers.size, 1); assert.equal(h.listeners.size, 1);
  h.advance(1400); assert.equal(h.render(), 1400); h.close(); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
});
test("long deadlines retain the platform timeout cap and clock regression never revives old display state", () => {
  const h = mount(1000, [3000000000]);
  try { assert.equal([...h.timers.values()][0].at, 2147483647); h.advance(2147484647); assert.equal(h.timers.size, 1);
    h.setClock(900); h.wake(); assert.equal(h.render(), 2147484647); h.advance(3000000000); assert.equal(h.timers.size, 0); }
  finally { h.close(); }
});
test("wall-clock rollback before expiry cannot postpone a monotonic deadline", () => {
  const h = mount(1000, [1100]);
  try { h.advance(500, 100); assert.equal(h.render(), 1100); assert.equal(h.timers.size, 0);
    h.setClock(400); h.wake(); assert.equal(h.render(), 1100); }
  finally { h.close(); }
});
test("a newer baseline advances the clock but an older refreshed baseline never revives expired display", () => {
  const h = mount(1000, [1100]);
  try { h.advance(1100); h.setClock(900); h.update(800, [1050]); assert.equal(h.render(), 1100); assert.equal(h.timers.size, 0);
    h.update(1200, [1300]); assert.equal(h.render(), 1200); h.advance(900, 100); assert.equal(h.render(), 1300); }
  finally { h.close(); }
});
test("a forward wall-clock jump observed during rendering is latched before any timeout or wake", () => {
  const h = mount(1000, [1100]);
  try { h.setClock(1200); assert.equal(h.render(), 1200); h.setClock(900); assert.equal(h.render(), 1200);
    h.wake(); assert.equal(h.timers.size, 0); }
  finally { h.close(); }
});
