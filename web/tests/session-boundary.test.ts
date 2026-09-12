import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionBoundary, useSessionBoundary } from "../src/components/session-boundary";
import { clearCsvRecoveryPointers, initialSessionBoundaryState, isSessionLogoutSignal, reduceSessionBoundary, sessionBoundaryVerified,
  CSV_RECOVERY_POINTER_PREFIX, type SessionBoundaryState } from "../src/components/session-boundary-state";

const binding = "a".repeat(64), other = "b".repeat(64);
const checking = () => reduceSessionBoundary(initialSessionBoundaryState(binding), { type: "check" });
const reply = (state: SessionBoundaryState, session_binding = binding, sequence = state.sequence) => reduceSessionBoundary(state, {
  type: "response", sequence, status: 200, payload: { authenticated: true, session_binding },
});

test("SSR renders protected children invisible, inert and inaccessible before any client probe", () => {
  const Context = () => React.createElement("span", null, JSON.stringify(useSessionBoundary()));
  assert.equal(renderToStaticMarkup(React.createElement(Context)), "<span>null</span>");
  const html = renderToStaticMarkup(React.createElement(SessionBoundary, { initialBinding: binding, children: React.createElement(Context) }));
  assert.match(html, /data-session-boundary-content="" inert="" aria-hidden="true" style="visibility:hidden;display:none"/);
  assert.match(html, /&quot;verified&quot;:false/);
  assert.match(html, /data-session-boundary-status="hidden"/);
  assert.equal(sessionBoundaryVerified(initialSessionBoundaryState(binding), binding), false);
});

test("only strict authenticated same-binding probe responses make the current boundary visible", () => {
  assert.equal(sessionBoundaryVerified(reply(checking()), binding), true);
  for (const payload of [null, [], {}, { authenticated: false, session_binding: binding }, { authenticated: true },
    { authenticated: true, session_binding: "short" }, { authenticated: true, session_binding: binding, sid: "synthetic-forbidden" }]) {
    const state = checking(), result = reduceSessionBoundary(state, { type: "response", sequence: state.sequence, status: 200, payload });
    assert.equal(result.phase, "failed"); assert.equal(sessionBoundaryVerified(result, binding), false);
  }
});

test("pagehide invalidates every older response, including delayed successes and delayed 401s", () => {
  const pending = checking(), hidden = reduceSessionBoundary(pending, { type: "hide" });
  assert.equal(hidden.phase, "hidden"); assert.ok(hidden.sequence > pending.sequence);
  assert.deepEqual(reply(hidden, binding, pending.sequence), hidden);
  assert.deepEqual(reduceSessionBoundary(hidden, { type: "response", sequence: pending.sequence, status: 401, payload: null }), hidden);
  const resumed = reduceSessionBoundary(hidden, { type: "check" });
  assert.deepEqual(reply(resumed, other, pending.sequence), resumed);
  assert.equal(reply(resumed).phase, "verified");
});

test("duplicate or superseded probes cannot undo the newer result", () => {
  const first = checking(), second = reduceSessionBoundary(first, { type: "check" }), visible = reply(second);
  assert.deepEqual(reply(visible, other, first.sequence), visible);
  assert.deepEqual(reduceSessionBoundary(visible, { type: "response", sequence: second.sequence, status: 401, payload: null }), visible);
});

test("401 and changed binding are terminal invalidations rather than retriable visible states", () => {
  for (const result of [reply(checking(), other), reduceSessionBoundary(checking(), { type: "response", sequence: checking().sequence, status: 401, payload: null })]) {
    assert.equal(result.phase, "invalidated"); assert.equal(sessionBoundaryVerified(result, binding), false);
    assert.deepEqual(reduceSessionBoundary(result, { type: "check", releaseHold: true }), result);
    assert.deepEqual(reply(result), result);
  }
  assert.equal(reply(checking(), other).invalidatedReason, "changed");
});

test("network and server failures stay hidden without pretending logout, and manual retry can recover", () => {
  for (const status of [0, 302, 403, 500, 503]) {
    const pending = checking(), failed = reduceSessionBoundary(pending, { type: "response", sequence: pending.sequence, status, payload: null });
    assert.equal(failed.phase, "failed"); assert.equal(failed.invalidatedReason, null);
    assert.equal(reply(reduceSessionBoundary(failed, { type: "check", releaseHold: true })).phase, "verified");
  }
});

test("anonymous logout hints cannot grant access or let a pre-revocation success automatically redisplay content", () => {
  const visible = reply(checking()), signal = reduceSessionBoundary(visible, { type: "signal" });
  const held = reply(reduceSessionBoundary(signal, { type: "check" }));
  assert.equal(held.phase, "held"); assert.equal(held.invalidatedReason, null); assert.equal(sessionBoundaryVerified(held, binding), false);
  assert.equal(reply(reduceSessionBoundary(held, { type: "check" })).phase, "held");
  assert.equal(reply(reduceSessionBoundary(held, { type: "check", releaseHold: true })).phase, "verified");
  assert.equal(isSessionLogoutSignal({ type: "logout", nonce: "synthetic-nonce-1234" }), true);
  for (const value of [null, { type: "login", nonce: "synthetic-nonce-1234" }, { type: "logout", nonce: "x" }, { type: "logout", nonce: "synthetic-nonce-1234", authenticated: true }]) assert.equal(isSessionLogoutSignal(value), false);
});

test("logout invalidation conceals a verified page and prevents late verification", () => {
  const visible = reply(checking()), invalidated = reduceSessionBoundary(visible, { type: "invalidate", reason: "logout" });
  assert.equal(invalidated.invalidatedReason, "logout"); assert.equal(sessionBoundaryVerified(invalidated, binding), false);
  assert.deepEqual(reply(invalidated, binding, visible.sequence), invalidated);
});

test("a new SSR binding is immediately unverified and resets with monotonically increasing response identity", () => {
  const old = reply(checking()); assert.equal(sessionBoundaryVerified(old, other), false);
  const fresh = reduceSessionBoundary(old, { type: "reset", binding: other });
  assert.ok(fresh.sequence > old.sequence); assert.equal(fresh.phase, "hidden");
  const pending = reduceSessionBoundary(fresh, { type: "check" });
  assert.deepEqual(reply(pending, binding, old.sequence), pending);
  assert.equal(reply(pending, other).phase, "verified");
});

test("pointer cleanup only removes the agreed prefix, without reading or writing stored payloads", () => {
  const values = new Map([[`${CSV_RECOVERY_POINTER_PREFIX}one`, "opaque-id-one"], [`${CSV_RECOVERY_POINTER_PREFIX}two`, "opaque-id-two"], ["workbench:theme", "dark"], ["workbench:csv-recovery-not-a-prefix", "keep"]]);
  const storage = { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, removeItem: (key: string) => { values.delete(key); } };
  assert.equal(clearCsvRecoveryPointers(storage), 2);
  assert.deepEqual([...values.keys()], ["workbench:theme", "workbench:csv-recovery-not-a-prefix"]);
  assert.equal(clearCsvRecoveryPointers({ get length(): number { throw new Error("Storage disabled"); }, key: () => null, removeItem: () => { throw new Error("must not write"); } }), 0);
});
