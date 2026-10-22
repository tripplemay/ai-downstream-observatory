import assert from "node:assert/strict";
import test from "node:test";
import { mountInvestorDisplay } from "./investor-display-fixture";
import { historyBinding as binding, historyPage as page } from "./investor-history-fixture";
import * as client from "../src/components/workbench/investor-history-client";
function mount(t: { after: (callback: () => void) => void }) {
  return mountInvestorDisplay(t, new URL("../src/components/workbench/investor-history-panel.tsx", import.meta.url), "InvestorHistoryPanel",
    { workspaceId: page.workspace_id, binding, disabled: false, observationId: null as string | null }, {
      "next/link": { default: "Link", __esModule: true }, "@/components/session-boundary": { useSessionBoundary: () => ({ verified: true, sessionBinding: binding }) },
      "./investor-history-client": client }, Date.parse(page.checked_at));
}
test("history reads only on entry or explicit navigation, never POSTs or promotes a historical decision to a current action", async t => {
  const h = mount(t); await h.flush(); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, "/api/workbench/investor/history");
  await h.reply(0, { ...page, session_binding: binding }); assert.match(h.text(), /Fictional historical observation only/);
  assert.match(h.text(), /历史记录/); assert.equal(h.button("采纳思路"), undefined);
  await h.advance(Date.parse("2026-01-05T12:00:00.000Z")); assert.equal(h.requests.length, 1); assert.match(h.text(), /Fictional historical observation only/);
  await h.click("更早记录"); assert.match(h.requests[1].url, /cursor=fictional_cursor/);
  await h.reply(1, { ...page, entries: [], previous_cursor: "previous_cursor", next_cursor: null, session_binding: binding });
  await h.click("较新记录"); assert.match(h.requests[2].url, /cursor=previous_cursor/);
  assert.ok(h.requests.every(row => row.method === "GET"));
});
test("scope changes and logout clear private archive data; obsolete GET/401 and cached page callbacks cannot cross identities", async t => {
  const h = mount(t); await h.flush(); await h.change({ observationId: "new-observation" });
  await h.reply(0, null, 401); assert.equal(h.requests.length, 2);
  await h.reply(1, { ...page, mode: "decisions", observation_id: "new-observation", entries: [{ ...page.entries[0], id: "new-observation" }], session_binding: binding });
  const click = h.button("更早记录")!.props.onClick as () => void;
  await h.change({ workspaceId: "foreign-workspace" }); click(); await h.flush(); assert.equal(h.requests.length, 3); assert.doesNotMatch(h.text(), /Fictional historical observation only/);
  await h.invalidate(); click(); await h.flush(); assert.equal(h.requests.length, 3); assert.doesNotMatch(h.text(), /Fictional historical observation only/);
  h.close(); assert.equal(h.timers.size, 0);
});
test("parent refresh pauses interactions without refetching or losing a verified snapshot; failed reads require explicit retry", async t => {
  const h = mount(t); await h.flush(); await h.reply(0, { ...page, session_binding: binding });
  await h.change({ disabled: true }); assert.doesNotMatch(h.text(), /Fictional historical observation only/);
  await h.change({ disabled: false }); assert.match(h.text(), /Fictional historical observation only/); assert.equal(h.requests.length, 1);
  await h.click("刷新记录"); await h.fail(1); assert.match(h.text(), /暂未通过核对/);
  await h.change({ disabled: true }); await h.change({ disabled: false }); assert.equal(h.requests.length, 2);
  await h.click("刷新记录"); assert.equal(h.requests.length, 3);
});
test("strict history parser rejects foreign scope, current-advice promotion, injected prices, future decisions and mixed observation pages", () => {
  const good = { ...page, session_binding: binding };
  assert.equal(client.parseInvestorHistory(good, binding, page.workspace_id, {}).historical_only, true);
  for (const patch of [{ workspace_id: "foreign" }, { is_current_conclusion: true }, { model_change: { money: "100" } },
    { entries: [{ ...page.entries[0], model_change: { amount: "100" } }] }, { observation_id: page.entries[0].id },
    { entries: [{ ...page.entries[0], evaluated_at: "2026-01-03T12:00:00.000Z" }] }])
    assert.throws(() => client.parseInvestorHistory({ ...good, ...patch }, binding, page.workspace_id, {}));
  assert.throws(() => client.parseInvestorHistory(good, "f".repeat(64), page.workspace_id, {}));
});
