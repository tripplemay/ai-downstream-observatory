import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { NextResponse } from "next/server";
import { AuthError, requireSameOrigin } from "../src/server/auth/core";
import { parseStrictJson } from "../src/server/strict-json";
import * as schemas from "../src/server/investor/schemas";
import * as funding from "../src/server/investor/funding-schemas";
import * as study from "../src/server/investor/funded-study-schemas";
import * as costs from "../src/server/investor/monitor-cost-schemas";
import { getInvestorState } from "../src/server/investor/service";
import { actionDraftProgressRequest, actionDraftProgressSchema } from "../src/server/investor/action-draft-progress-schemas";
import { actionMaintenanceProgressRequest } from "../src/server/investor/action-maintenance-progress-schemas";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { investorActor as actor, investorFixture, saveSyntheticProfile } from "./investor-fixture";

const binding = "a".repeat(64), at = "2026-01-02T12:00:02.000Z", origin = "https://synthetic.example.test";
function moduleFrom(source: string, dependencies: Record<string, unknown>) {
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as Record<string, (...args: any[]) => any> };
  const init = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { Error, Buffer, URL, TextDecoder });
  init((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports);
  return module.exports;
}
function legacyClient(withDrafts=false) {
  // Reconstruct the exact pre-increment consumer without needing Git history in shallow CI.
  let text = readFileSync(new URL("../src/components/workbench/investor-client.ts", import.meta.url), "utf8");
  for (const line of [
    'import { actionMaintenanceProgressSchema } from "@/server/investor/action-maintenance-progress-schemas";\n',
    '  action_maintenance: actionMaintenanceProgressSchema.optional(),\n',
    '  if (state.action_maintenance && (state.workspace_id === null || state.action_maintenance.checked_at !== state.checked_at)) throw new Error("INVESTOR_RESPONSE_INVALID");\n',
    ...(!withDrafts ? ['import { actionDraftProgressSchema } from "@/server/investor/action-draft-progress-schemas";\n',
    '  action_drafts: actionDraftProgressSchema.optional(),\n',
    '  if (state.action_drafts && (state.workspace_id === null || state.action_drafts.checked_at !== state.checked_at)) throw new Error("INVESTOR_RESPONSE_INVALID");\n'] : []),
  ]) { assert.equal(text.split(line).length - 1, 1); text = text.replace(line, ""); }
  assert.equal(createHash("sha256").update(text).digest("hex"), withDrafts ? "81da04e85b419d45464f47658426e5168cde83634992c9e7651ea8919e0a59cc" : "b20243ba1af22d427e660cd0c2e3e50647524b2bdd827f4699ea656e7f2c733d", "FROZEN_OLD_CONSUMER_DRIFT");
  return moduleFrom(text, { zod: { z }, "@/server/investor/schemas": schemas, "@/server/investor/funding-schemas": funding,
    "@/server/investor/funded-study-schemas": study, "@/server/investor/monitor-cost-schemas": costs,
    "@/server/investor/action-draft-progress-schemas":{actionDraftProgressSchema} }).parseInvestorState;
}
function harness(t: { after: (fn: () => void) => void }, options: { denied?: boolean; changed?: boolean } = {}) {
  const f = investorFixture(); t.after(f.close); saveSyntheticProfile(f);
  const calls: string[] = []; let sessionReads = 0, current: Request;
  const authenticate = async () => {
    calls.push("authenticate"); if (options.denied) throw new AuthError("UNAUTHENTICATED", 401);
    return { userId: actor.id, sessionId: options.changed && sessionReads++ > 0 ? "other" : "sid" };
  };
  const db = new Proxy(f.db, { get(target, key) { if (key === "close") return () => calls.push("close");
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
  const exports = moduleFrom(readFileSync(new URL("../src/app/api/workbench/investor/route.ts", import.meta.url), "utf8"), {
    "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError },
    "@/server/auth/session": { requireApiSession: authenticate, requireMutationSession: async () => {
      const session = await authenticate(); requireSameOrigin(current.headers, { origin } as Parameters<typeof requireSameOrigin>[1]); return session;
    } },
    "@/server/auth/session-binding": { sessionBinding: () => binding, assertRequestSessionBinding: (request: Request) => {
      const found = request.headers.get("X-Workbench-Session-Binding"); if (found !== null && found !== binding) throw new AuthError("SESSION_CHANGED", 401);
    } },
    "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return db; } }, "@/server/strict-json": { parseStrictJson },
    "@/server/investor/action-draft-progress-schemas": { actionDraftProgressRequest },
    "@/server/investor/action-maintenance-progress-schemas": { actionMaintenanceProgressRequest },
    "@/server/investor/service": { isInvestorClientError: () => false, getInvestorState: (_db: unknown, principal: typeof actor, _now: unknown, settings: any) => {
      calls.push("read"); return getInvestorState(f.db, principal, at, settings);
    }, executeInvestorCommand: () => { calls.push("explicit-command"); return { receipt_only: true }; } },
  });
  return { f, calls, async GET(headers: Record<string, string> = {}, query = "", omitBinding = false) {
    current = new Request(origin + "/api/workbench/investor" + query, { headers: { ...(!omitBinding ? { "X-Workbench-Session-Binding": binding } : {}), ...headers } });
    return exports.GET(current) as Promise<Response>;
  }, async POST() {
    current = new Request(origin + "/api/workbench/investor", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json",
      "X-Workbench-Session-Binding": binding, [actionDraftProgressRequest.header]: actionDraftProgressRequest.value }, body: JSON.stringify({ action: "evaluate" }) });
    return exports.POST(current) as Promise<Response>;
  } };
}

test("exact old strict consumer continues to accept legacy GETs while new clients explicitly opt into private progress", async t => {
  const h = harness(t), old = legacyClient(), before = h.f.db.prepare("SELECT total_changes() n").get();
  const legacyResponse = await h.GET(), legacy = await legacyResponse.json();
  assert.equal(legacyResponse.status, 200); assert.equal("action_drafts" in legacy, false); old(legacy, binding);
  const nextResponse = await h.GET({ [actionDraftProgressRequest.header]: actionDraftProgressRequest.value }), next = await nextResponse.json();
  assert.equal(nextResponse.status, 200); assert.equal(next.action_drafts.status, "not_configured"); parseInvestorState(next, binding);
  assert.throws(() => old(next, binding), /RESPONSE_INVALID/);
  const { action_drafts: _, ...shared } = next; assert.deepEqual(shared, legacy);
  assert.equal(nextResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(nextResponse.headers.get("vary"), "Cookie, " + actionDraftProgressRequest.header);
  assert.deepEqual(h.f.db.prepare("SELECT total_changes() n").get(), before); assert.ok(!h.calls.includes("explicit-command"));
});

test("missing or unknown feature versions retain the closed legacy shape without reading optional source metadata", async t => {
  const h = harness(t), old = legacyClient();
  for (const version of ["", "action-drafts-v0", "action-drafts-v999", "action-drafts-v1,other", "true"]) {
    const response = await h.GET({ [actionDraftProgressRequest.header]: version }), value = await response.json();
    assert.equal(response.status, 200); assert.equal("action_drafts" in value, false); old(value, binding);
  }
  const legacy = getInvestorState(h.f.db, actor, at, { includeActionDraftProgress: false });
  assert.equal("action_drafts" in legacy, false);
  assert.equal(getInvestorState(h.f.db, actor, at).action_drafts?.status, "not_configured");
});

test("frozen v1 consumer remains compatible while v2 alone receives standing-rule metadata",async t=>{
  const h=harness(t),old=legacyClient(true);
  const prior=await (await h.GET({[actionDraftProgressRequest.header]:actionDraftProgressRequest.value})).json();
  old(prior,binding);assert.equal("action_maintenance" in prior,false);
  const response=await h.GET({[actionMaintenanceProgressRequest.header]:actionMaintenanceProgressRequest.value}),next=await response.json();
  assert.equal(response.status,200);assert.equal(next.action_maintenance.status,"not_configured");
  parseInvestorState(next,binding);assert.throws(()=>old(next,binding),/RESPONSE_INVALID/);
  const {action_maintenance:_,...same}=next;assert.deepEqual(same,prior);
});

test("view negotiation cannot bypass authentication, session binding or query checks and never changes explicit command receipts", async t => {
  for (const version of [actionDraftProgressRequest,actionMaintenanceProgressRequest]) for (const mode of ["anonymous", "changed", "binding", "missing", "empty", "query"]) {
    const opted = { [version.header]: version.value };
    const h = harness(t, { denied: mode === "anonymous", changed: mode === "changed" });
    const response = await h.GET({ ...opted, ...(mode === "binding" ? { "X-Workbench-Session-Binding": "b".repeat(64) } : mode === "empty" ? { "X-Workbench-Session-Binding": "" } : {}) }, mode === "query" ? "?owner=forged" : "", mode === "missing");
    assert.equal(response.status, ["missing", "query"].includes(mode) ? 400 : 401); assert.ok(!h.calls.includes("open"));
  }
  const h = harness(t), response = await h.POST(); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { receipt_only: true, session_binding: binding });
  assert.equal(response.headers.get("vary"), "Cookie"); assert.equal(h.calls.filter(value => value === "explicit-command").length, 1);
  assert.ok(!h.calls.includes("read"));
});
