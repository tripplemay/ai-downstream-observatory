import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as client from "../src/components/workbench/investor-execution-followup-client";
import { mountInvestorDisplay } from "./investor-display-fixture";
import { executionBinding as binding, executionContext as context, executionScope as scope } from "./investor-execution-fixture";

function mount(t: { after: (callback: () => void) => void }) {
  const commands: unknown[] = [], locks: boolean[] = [];
  const h = mountInvestorDisplay(t, new URL("../src/components/workbench/investor-execution-followup-panel.tsx", import.meta.url), "InvestorExecutionFollowupPanel",
    { scope, disabled: false, onCommand: (input: unknown) => commands.push(input), onDraftLockChange: (locked: boolean) => locks.push(locked) },
    { "@/components/ui/input": { Input: "Input" }, "@/components/session-boundary": { useSessionBoundary: () => ({ verified: true, sessionBinding: binding }) },
      "./investor-execution-followup-client": client }, Date.parse(context.checked_at));
  function field(label: string) {
    const owner = h.nodes().find(row => row.type === "label" && h.words(row).startsWith(label)); assert.ok(owner, label);
    const children = (Array.isArray(owner.props.children) ? owner.props.children : [owner.props.children]) as { type: string; props: Record<string, unknown> }[];
    const input = children.find(row => row && ["Input", "select"].includes(row.type)); assert.ok(input, label); return input;
  }
  const handler = () => { const form = h.node("form"); assert.ok(form); return form.props.onSubmit as (event: { preventDefault: () => void }) => void; };
  return { ...h, commands, locks, field, handler,
    input: async (label: string, value: string) => { (field(label).props.onChange as (value: unknown) => void)({ target: { value } }); await h.flush(); },
    chooseFile: async (file: File) => { (field("存证另一份").props.onChange as (event: unknown) => void)({ target: { files: [file] } }); await h.flush(); },
    acknowledge: async (checked: boolean) => { const box = h.nodes().find(row => row.type === "input" && row.props.type === "checkbox"); assert.ok(box);
      (box.props.onChange as (event: unknown) => void)({ target: { checked } }); await h.flush(); },
    submit: async (twice = false) => { const send = handler(); send({ preventDefault() {} }); if (twice) send({ preventDefault() {} }); await h.flush(); },
  };
}
async function begin(h: ReturnType<typeof mount>, mode = "关联已入账成交") {
  await h.flush(); await h.click(mode); await h.reply(0, { ...context, session_binding: binding });
}
async function select(h: ReturnType<typeof mount>) {
  await h.input("对应的历史", "fictional-item"); await h.input("已经入账", "fictional-fact"); await h.input("独立原件", "fictional-evidence");
}

test("link UI starts blank, never guesses a proposal, and hands one explicit immutable link to the existing parent", async t => {
  const h = mount(t); await h.flush(); assert.equal(h.requests.length, 0); await begin(h);
  assert.equal(h.locks.at(-1), true); assert.equal(h.field("对应的历史").props.value, ""); assert.equal(h.field("已经入账").props.value, "");
  await select(h); await h.acknowledge(true); await h.input("独立原件", "fictional-evidence"); await h.submit(); assert.equal(h.commands.length, 0);
  await h.acknowledge(true); await h.submit(true); assert.equal(h.commands.length, 1); assert.equal(h.requests.length, 1); assert.equal(h.locks.at(-1), false);
  const command = h.commands[0] as Record<string, unknown>; assert.equal(command.action, "link_recorded_execution_fact"); assert.equal(command.event_id, "fictional-fact");
  assert.ok(!("quantity" in command)); assert.ok(!("command" in command)); assert.ok(!h.text().includes("本金 20000"));
});

test("typed status-report UI never substitutes planned quantities or creates a trade", async t => {
  const h = mount(t); await begin(h, "登记券商状态回报");
  assert.equal(h.field("原回报数量").props.value, ""); assert.equal(h.field("原回报状态").props.value, "");
  for (const [label, value] of [["对应的历史", "fictional-item"], ["独立原件", "fictional-evidence"], ["原回报状态", "filled"],
    ["原回报数量", "200"], ["来源标识", "FICTIONAL"], ["原回报唯一", "report-1"], ["原回报说明", "Fictional only"]]) await h.input(label, value);
  await h.acknowledge(true); await h.submit();
  assert.equal((h.commands[0] as { action: string }).action, "record_linked_execution_report"); assert.equal(h.requests.length, 1);
});

test("lost evidence response retains the original file/key/scope; explicit retry verifies it before enabling association", async t => {
  const h = mount(t); await begin(h); await select(h);
  const file = new File(["\ufefffictional,only\r\n1,not_real\r\n"], "private-name.csv"); await h.chooseFile(file);
  await h.click("仅存证此原件，不导入事实"); await h.waitRequests(2); assert.equal(h.requests[1].method, "POST");
  const first = h.requests[1].options.body as FormData;
  await h.fail(1); assert.match(h.text(), /原件上传尚未完成核对/); assert.equal(h.locks.at(-1), true); assert.equal(h.commands.length, 0);
  await h.click("核对并重试原件上传原请求"); await h.waitRequests(3);
  const second = h.requests[2].options.body as FormData;
  assert.equal(first.get("scope"), second.get("scope")); assert.equal(first.get("idempotency_key"), second.get("idempotency_key"));
  assert.deepEqual(Buffer.from(await (first.get("file") as File).arrayBuffer()), Buffer.from(await (second.get("file") as File).arrayBuffer()));
  assert.equal((first.get("file") as File).name, "evidence.csv");
  const prepared = await client.prepareExecutionUpload(context, file, "fictional-display-command");
  await h.reply(2, { schema_version: "investor-execution-evidence-v1", workspace_id: scope.workspace, portfolio_id: scope.portfolio,
    account_id: scope.accountId, attachment_id: "fictional-upload", content_hash: prepared.content_hash, byte_size: file.size, media_type: "text/csv", audit_id: "fictional-audit", session_binding: binding });
  await h.waitRequests(4); await h.reply(3, { ...context, context_hash: "f".repeat(64), evidence: [...context.evidence,
    { id: "fictional-upload", content_hash: prepared.content_hash, byte_size: file.size, media_type: "text/csv", created_at: context.checked_at }], session_binding: binding });
  assert.equal(h.field("独立原件").props.value, "fictional-upload"); await h.acknowledge(true); await h.submit(); assert.equal(h.commands.length, 1);
  assert.equal((h.commands[0] as { expected_context_hash: string }).expected_context_hash, "f".repeat(64));
});

test("upload waits for actual asynchronous bytes and digest before its first request, not a fixed number of loop turns", async t => {
  const h = mount(t); await begin(h); await select(h);
  const file = new File(["fictional,delayed\r\n"], "delayed.csv");
  const bytes = await file.arrayBuffer();
  let release!: (value: ArrayBuffer) => void;
  const reading = new Promise<ArrayBuffer>(resolve => { release = resolve; });
  Object.defineProperty(file, "arrayBuffer", { value: () => reading });
  await h.chooseFile(file); await h.click("仅存证此原件，不导入事实");
  for (let i = 0; i < 120; i++) await h.flush();
  assert.equal(h.requests.length, 1); assert.equal(h.commands.length, 0);
  const sent = h.waitRequests(2); release(bytes); await sent;
  assert.equal(h.requests[1].method, "POST");
  const body = h.requests[1].options.body as FormData;
  assert.deepEqual(Buffer.from(await (body.get("file") as File).arrayBuffer()), Buffer.from(bytes));
  await h.fail(1); assert.match(h.text(), /原件上传尚未完成核对/);
  assert.equal(h.commands.length, 0); assert.equal(h.locks.at(-1), true);
});

test("request waiters fail explicitly when their fixture closes without authorizing an upload", async t => {
  const h = mount(t);
  const waiting = h.waitRequests(1);
  h.close();
  await assert.rejects(waiting, /fixture closed/);
  assert.equal(h.requests.length, 0); assert.equal(h.commands.length, 0);
});

test("late GET/401, stale submit and upload callbacks cannot cross scope or logout boundaries", async t => {
  const h = mount(t); await h.flush(); await h.click("关联已入账成交"); await h.change({ scope: { ...scope, revision: 3 } });
  await h.reply(0, null, 401); assert.equal(h.button("关联已入账成交")!.props.disabled, false);
  await h.change({ scope }); await h.click("关联已入账成交"); await h.reply(1, { ...context, session_binding: binding }); await select(h); await h.acknowledge(true);
  await h.chooseFile(new File(["fictional"], "original.csv"));
  const send = h.handler(), upload = h.button("仅存证此原件，不导入事实")!.props.onClick as () => void;
  await h.change({ scope: { ...scope, accountId: "foreign" } }); send({ preventDefault() {} }); upload(); await h.flush();
  assert.equal(h.commands.length, 0); assert.equal(h.requests.length, 2); assert.ok(!h.text().includes("本金 20000"));
  await h.invalidate(); send({ preventDefault() {} }); upload(); await h.flush(); assert.equal(h.commands.length, 0); assert.equal(h.requests.length, 2);
  assert.equal(h.locks.at(-1), false); h.close(); assert.equal(h.timers.size, 0);
});

test("execution drafts freeze sibling account writers without disabling their own panel", () => {
  const source = readFileSync(new URL("../src/components/workbench/investor-account-workspace.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("account.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Map<string, string>();
  function visit(node: ts.Node) { if (ts.isJsxSelfClosingElement(node)) {
    const attribute = node.attributes.properties.find(value => ts.isJsxAttribute(value) && value.name.getText(tree) === "disabled");
    if (attribute) found.set(node.tagName.getText(tree), attribute.getText(tree));
  } ts.forEachChild(node, visit); } visit(tree);
  for (const name of ["InvestorCashRecordingPanel", "InvestorTradeRecordingPanel", "InvestorReconciliationPanel", "InvestorValuationPanel", "InvestorHoldingsPanel"])
    assert.ok(found.get(name)?.includes("executionLocked"), name);
  assert.ok(found.has("InvestorExecutionFollowupPanel")); assert.ok(!found.get("InvestorExecutionFollowupPanel")!.includes("executionLocked"));
  assert.match(source, /onDraftLockChange=\{setExecutionLocked\}/); assert.match(source, /!valuationLocked && !executionLocked/);
});
