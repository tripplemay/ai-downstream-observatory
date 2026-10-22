import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as client from "../src/components/workbench/investor-proposal-review-client";
import { mountInvestorDisplay } from "./investor-display-fixture";
import { proposalBinding as binding, proposalContext as context, proposalScope as scope } from "./investor-proposal-fixture";

function mount(t: { after: (callback: () => void) => void }) {
  const commands: unknown[] = [], locks: boolean[] = [];
  const h = mountInvestorDisplay(t, new URL("../src/components/workbench/investor-proposal-review-panel.tsx", import.meta.url), "InvestorProposalReviewPanel",
    { scope, disabled: false, onCommand: (input: unknown) => commands.push(input), onDraftLockChange: (value: boolean) => locks.push(value) },
    { "@/components/session-boundary": { useSessionBoundary: () => ({ verified: true, sessionBinding: binding }) }, "./investor-proposal-review-client": client }, Date.parse(context.checked_at));
  function field(prefix: string) {
    const owner = h.nodes().find(row => row.type === "label" && h.words(row).startsWith(prefix)); assert.ok(owner, prefix);
    const children = (Array.isArray(owner.props.children) ? owner.props.children : [owner.props.children]) as { type: string; props: Record<string, unknown> }[];
    const input = children.find(row => row && ["select", "textarea", "input"].includes(row.type)); assert.ok(input, prefix); return input;
  }
  const handler = () => { const form = h.node("form"); assert.ok(form); return form.props.onSubmit as (event: { preventDefault: () => void }) => void; };
  return { ...h, commands, locks, field, handler,
    input: async (prefix: string, value: string) => { (field(prefix).props.onChange as (event: unknown) => void)({ target: { value } }); await h.flush(); },
    acknowledge: async (checked: boolean) => { const box = h.nodes().find(row => row.type === "input" && row.props.type === "checkbox"); assert.ok(box);
      (box.props.onChange as (event: unknown) => void)({ target: { checked } }); await h.flush(); },
    submit: async (twice = false) => { const fn = handler(); fn({ preventDefault() {} }); if (twice) fn({ preventDefault() {} }); await h.flush(); },
  };
}
async function select(h: ReturnType<typeof mount>, value = context) {
  await h.flush(); await h.click("核对账户级待审清单"); await h.reply(0, { ...value, selected: null, session_binding: binding });
  assert.equal(h.field("选择整张").props.value, ""); await h.input("选择整张", "fictional-proposal"); await h.reply(1, { ...value, session_binding: binding });
}

test("passing check detail stays behind a native closed fold, but blocking reasons remain directly visible", async t => {
  const h = mount(t); await select(h);
  const evidence = () => h.nodes().find(row => row.type === "details" && h.words(row).startsWith("查看风控依据与版本"));
  assert.ok(evidence()); assert.equal(!!evidence()!.props.open, false); assert.match(h.words(evidence()), /确定性风控在本次核对时通过/);
  assert.match(h.text(), /本次只读复核：核对时通过/); h.close();
  const blocked = mount(t); await select(blocked, { ...context, selected: { ...context.selected!,
    current_risk: { ...context.selected!.current_risk, status: "blocked", checks: [{ code: "INSUFFICIENT_AVAILABLE_CASH" }] },
    recorded_risk: { ...context.selected!.recorded_risk!, matches_current: false }, allowed_operations: ["cancel_remainder"] } });
  assert.match(blocked.words(blocked.node("ul")), /可用现金不足/);
  const detail = blocked.nodes().find(row => row.type === "details" && blocked.words(row).startsWith("查看风控依据与版本"));
  assert.ok(detail); assert.doesNotMatch(blocked.words(detail), /可用现金不足/);
});

test("proposal review is on-demand, blank by default and submits one explicitly acknowledged narrow step", async t => {
  const h = mount(t); await h.flush(); assert.equal(h.requests.length, 0); await select(h);
  assert.equal(h.field("本次只执行").props.value, ""); assert.equal(h.locks.at(-1), true);
  await h.input("本次只执行", "approve"); await h.acknowledge(true); await h.input("复核备注", "Fictional review");
  await h.submit(); assert.equal(h.commands.length, 0);
  await h.acknowledge(true); await h.submit(true); assert.equal(h.commands.length, 1); assert.equal(h.requests.length, 2); assert.equal(h.locks.at(-1), false);
  const body = h.commands[0] as Record<string, unknown>; assert.equal(body.operation, "approve"); assert.equal(body.proposal_id, "fictional-proposal");
  assert.ok(!("quantity" in body)); assert.ok(!("command" in body)); assert.ok(!h.text().includes("60000"));
});

test("deadline passage latches and cannot be undone by wall-clock rollback or a stale submit handler", async t => {
  const h = mount(t); await select(h); await h.input("本次只执行", "approve"); await h.acknowledge(true); const send = h.handler();
  const deadline = Date.parse(context.selected!.expires_at); await h.advance(deadline); assert.match(h.text(), /清单有效期已到/);
  h.setWall(Date.parse(context.checked_at)); await h.wake(); send({ preventDefault() {} }); await h.flush();
  assert.equal(h.commands.length, 0); assert.match(h.text(), /到期或输入变化/);
  await h.input("本次只执行", "cancel_remainder"); await h.acknowledge(true); await h.submit();
  assert.equal((h.commands[0] as { operation: string }).operation, "cancel_remainder");
});

test("late GET/401 and retained submit/read/close callbacks cannot affect another scope or logout", async t => {
  const h = mount(t); await h.flush(); await h.click("核对账户级待审清单"); await h.change({ scope: { ...scope, revision: 3 } });
  await h.reply(0, null, 401); assert.equal(h.button("核对账户级待审清单")!.props.disabled, false);
  await h.change({ scope }); await h.click("核对账户级待审清单"); await h.reply(1, { ...context, selected: null, session_binding: binding });
  await h.input("选择整张", "fictional-proposal"); await h.reply(2, { ...context, session_binding: binding });
  await h.input("本次只执行", "approve"); await h.acknowledge(true);
  const send = h.handler(), close = h.button("关闭并清除本地复核草稿")!.props.onClick as () => void;
  const read = h.button("核对账户级待审清单")!.props.onClick as () => void;
  await h.change({ scope: { ...scope, portfolio: "foreign" } }); send({ preventDefault() {} }); read(); close(); await h.flush();
  assert.equal(h.commands.length, 0); assert.equal(h.requests.length, 3); assert.ok(!h.text().includes("FICTIONAL"));
  await h.invalidate(); send({ preventDefault() {} }); read(); close(); await h.flush();
  assert.equal(h.commands.length, 0); assert.equal(h.requests.length, 3); assert.equal(h.locks.at(-1), false);
  h.close(); assert.equal(h.timers.size, 0);
});

test("a failed read has no automatic retry and a readonly review has no mutation choice", async t => {
  const h = mount(t); await h.flush(); await h.click("核对账户级待审清单"); await h.fail(0);
  assert.equal(h.requests.length, 1); assert.match(h.text(), /未通过当前账本范围/);
  await h.click("核对账户级待审清单"); await h.reply(1, { ...context, selected: null, read_only: true, session_binding: binding });
  await h.input("选择整张", "fictional-proposal"); await h.reply(2, { ...context, read_only: true, selected: { ...context.selected!, allowed_operations: [] }, session_binding: binding });
  assert.equal(h.node("fieldset")!.props.disabled, true); assert.equal(h.commands.length, 0);
});

test("whole-book proposal drafts freeze sibling writers, CSV and parent refresh without self-disabling", () => {
  const source = readFileSync(new URL("../src/components/workbench/investor-account-workspace.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("account.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), found = new Map<string, string>();
  function visit(node: ts.Node) { if (ts.isJsxSelfClosingElement(node)) {
    const attribute = node.attributes.properties.find(value => ts.isJsxAttribute(value) && value.name.getText(tree) === "disabled");
    if (attribute) found.set(node.tagName.getText(tree), attribute.getText(tree));
  } ts.forEachChild(node, visit); } visit(tree);
  for (const name of ["InvestorCashRecordingPanel", "InvestorTradeRecordingPanel", "InvestorExecutionFollowupPanel", "InvestorReconciliationPanel", "InvestorValuationPanel", "InvestorHoldingsPanel"])
    assert.ok(found.get(name)?.includes("proposalLocked"), name);
  assert.ok(!found.get("InvestorProposalReviewPanel")!.includes("proposalLocked"));
  assert.match(source, /onDraftLockChange=\{setProposalLocked\}/); assert.match(source, /!executionLocked && !proposalLocked/);
  assert.match(source, /readOnly=\{[^}]*proposalLocked/);
});
