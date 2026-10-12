import test from "node:test";
import assert from "node:assert/strict";
import { AiExplanationMemory } from "../src/server/investor/ai-explanation-memory";

function fixture() {
  let wall = 0, monotonic = 0, id = 0;
  const timers = new Map<number, { callback: () => void; deadline: number }>();
  const disposed: string[] = [];
  type Value = { text: string; abort: AbortController };
  const cache = new AiExplanationMemory<Value>(value => { disposed.push(value.text); value.text = ""; value.abort.abort(); }, {
    wall: () => wall, monotonic: () => monotonic,
    schedule: (callback, delay) => { const handle = ++id; timers.set(handle, { callback, deadline: monotonic + delay }); return handle as unknown as ReturnType<typeof setTimeout>; },
    cancel: handle => { timers.delete(handle as unknown as number); },
  });
  const tick = (milliseconds: number) => {
    wall += milliseconds; monotonic += milliseconds;
    for (const [handle, timer] of [...timers]) if (timer.deadline <= monotonic) { timers.delete(handle); timer.callback(); }
  };
  const value = (text: string) => ({ text, abort: new AbortController() });
  return { cache, tick, disposed, timers, value, wallJump: (amount: number) => { wall += amount; } };
}

test("independent timer clears derived text and aborts even without a GET or POST", () => {
  const f = fixture(), value = f.value("fictional derived text");
  f.cache.set("a", value, "owner-a", 5000); f.tick(4999);
  assert.equal(f.cache.size, 1); assert.equal(value.abort.signal.aborted, false);
  f.tick(1);
  assert.equal(f.cache.size, 0); assert.equal(value.text, ""); assert.equal(value.abort.signal.aborted, true);
  assert.equal(f.timers.size, 0); assert.equal(f.disposed.length, 1);
});

test("clock rollback cannot extend retention; a forward jump fails closed on lookup", () => {
  const f = fixture(); f.cache.set("a", f.value("a"), "a", 5000);
  f.wallJump(-100000); f.tick(5000); assert.equal(f.cache.size, 0);
  f.cache.set("b", f.value("b"), "b", 5000); f.wallJump(100000);
  assert.equal(f.cache.get("b"), undefined); assert.equal(f.timers.size, 0);
});

test("scope invalidation clears text without touching another principal or current key", () => {
  const f = fixture();
  f.cache.set("old", f.value("old"), "a", 5000); f.cache.set("new", f.value("new"), "a", 5000);
  f.cache.set("foreign", f.value("foreign"), "b", 5000); f.cache.clearScope("a", "new");
  assert.deepEqual(f.cache.values().map(value => value.text), ["new", "foreign"]);
  f.cache.clearScope("a"); assert.equal(f.cache.size, 1); assert.equal(f.cache.get("foreign")?.text, "foreign");
  f.tick(5000); assert.equal(f.cache.size, 0); assert.equal(f.disposed.length, 3);
});

test("replacement cancels the obsolete timer and long deadlines use bounded timer intervals", () => {
  const f = fixture(), before = f.value("before"), after = f.value("after");
  f.cache.set("a", before, "a", 10); f.cache.set("a", after, "a", 20); f.tick(10);
  assert.equal(before.abort.signal.aborted, true); assert.equal(f.cache.get("a"), after);
  f.tick(10); assert.equal(f.cache.size, 0);
  f.cache.set("long", f.value("long"), "long", 30 * 86400000); f.tick(2147483647);
  assert.equal(f.cache.size, 1); assert.equal(f.timers.size, 1);
  f.tick(30 * 86400000 - 2147483647); assert.equal(f.cache.size, 0);
});

test("invalid retention never registers a result or timer", () => {
  const f = fixture();
  for (const ttl of [0, -1, NaN, Infinity, 32 * 86400000]) assert.throws(() => f.cache.set("a", f.value("a"), "a", ttl));
  assert.equal(f.cache.size, 0); assert.equal(f.timers.size, 0);
});
