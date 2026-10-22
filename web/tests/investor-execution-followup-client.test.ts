import assert from "node:assert/strict";
import test from "node:test";
import { blankExecutionDraft, buildExecutionFollowup, executionDeviationMessage, executionUploadForm, parseExecutionEvidenceReceipt, parseExecutionFollowup, prepareExecutionUpload } from "../src/components/workbench/investor-execution-followup-client";
import { executionContext as context, executionScope as scope, executionBinding as binding } from "./investor-execution-fixture";

test("execution context rejects cross-session/account or forged authority and inconsistent historical bindings", () => {
  assert.deepEqual(parseExecutionFollowup({ ...context, session_binding: binding }, scope), context);
  for (const patch of [{ session_binding: "b".repeat(64) }, { account_id: "foreign" }, { workspace_revision: 3 },
    { execution_authorized: true }, { broker_ordering_enabled: true }, { owner_id: "forged" }, { evidence: [{ ...context.evidence[0], retention_policy: "hidden" }] },
    { items: [...context.items, context.items[0]] }, { facts: [{ ...context.facts[0], effective_at: "2027-01-01" }] },
    { reports: [{ id: "forged", proposal_item_id: "foreign", status: "filled", reported_quantity: "1", deviations: [], recorded_at: context.checked_at,
      source_id: "FICTIONAL", source_event_id: "report", reason: "Fictional source", attachment_id: "fictional-evidence", fact_confirmed: false }] }])
    assert.throws(() => parseExecutionFollowup({ ...context, session_binding: binding, ...patch }, scope));
});

test("historical second and microsecond timestamps are compared exactly, never rounded into current evidence", () => {
  assert.ok(parseExecutionFollowup({ ...context, items: [{ ...context.items[0], expires_at: "2026-01-05T11:30:00Z" }], session_binding: binding }, scope));
  assert.throws(() => parseExecutionFollowup({ ...context, evidence: [{ ...context.evidence[0], created_at: "2026-01-05T12:00:00.000001Z" }], session_binding: binding }, scope));
});

test("linkage selects all three independent records explicitly and report quantities are never inferred", () => {
  const draft = blankExecutionDraft("link"); assert.ok(Object.values(draft).every(value => value === "link" || value === "" || value === false));
  assert.throws(() => buildExecutionFollowup(context, draft));
  Object.assign(draft, { item: "fictional-item", fact: "fictional-fact", evidence: "fictional-evidence", acknowledged: true });
  const linked = buildExecutionFollowup(context, draft); assert.equal(linked.action, "link_recorded_execution_fact");
  assert.ok(!("quantity" in linked)); assert.ok(!("command" in linked));
  for (const patch of [{ acknowledged: false }, { item: "foreign" }, { evidence: "foreign" }, { fact: "foreign" }])
    assert.throws(() => buildExecutionFollowup(context, { ...draft, ...patch }));
  assert.throws(() => buildExecutionFollowup({ ...context, facts: [{ ...context.facts[0], side: "sell" }] }, draft));
  const report = { ...draft, mode: "report" as const, fact: "", status: "filled", source: "FICTIONAL", sourceEvent: "report-1", reason: "Fictional status only" };
  assert.throws(() => buildExecutionFollowup(context, report));
  assert.equal(buildExecutionFollowup(context, { ...report, quantity: "200" }).action, "record_linked_execution_report");
  assert.throws(() => buildExecutionFollowup({ ...context, read_only: true }, draft));
});

test("evidence request preserves BOM/CRLF bytes and immutable identity, without sending the private filename", async () => {
  const bytes = Buffer.from("\ufefffield,FICTIONAL\r\n1,NOT_REAL\r\n");
  const request = await prepareExecutionUpload(context, new File([bytes], "private-account-fictional.csv"), "original-request-1");
  const first = executionUploadForm(request), second = executionUploadForm(request);
  assert.deepEqual(Buffer.from(await (first.get("file") as File).arrayBuffer()), bytes);
  assert.equal((first.get("file") as File).name, "evidence.csv"); assert.equal(first.get("scope"), second.get("scope"));
  assert.equal(first.get("idempotency_key"), second.get("idempotency_key"));
  const receipt = { schema_version: "investor-execution-evidence-v1", workspace_id: scope.workspace, portfolio_id: scope.portfolio,
    account_id: scope.accountId, attachment_id: "fictional-upload", content_hash: request.content_hash, byte_size: bytes.length,
    media_type: "text/csv", audit_id: "fictional-audit", session_binding: binding };
  assert.equal(parseExecutionEvidenceReceipt(receipt, request, binding).attachment_id, "fictional-upload");
  for (const patch of [{ content_hash: "f".repeat(64) }, { account_id: "foreign" }, { session_binding: "b".repeat(64) }, { byte_size: 1 }, { execution_authorized: true }])
    assert.throws(() => parseExecutionEvidenceReceipt({ ...receipt, ...patch }, request, binding));
  for (const file of [new File([], "empty.csv"), new File([bytes], "unsupported.pdf"), new File([new Uint8Array(4 * 1024 * 1024 + 1)], "large.csv")])
    await assert.rejects(prepareExecutionUpload(context, file, "invalid"));
});

test("historical execution deviations use human explanations, without claiming approval or inferring unknown causes", () => {
  assert.match(executionDeviationMessage("FACT_AGAINST_STALE_PROPOSAL"), /不追认过去交易/);
  assert.match(executionDeviationMessage("NO_ACTIVE_RESERVATION"), /没有新建预占/);
  assert.match(executionDeviationMessage("REPORTED_WITHOUT_APPROVAL"), /不能补成批准/);
  assert.match(executionDeviationMessage("UNCLASSIFIED_FICTIONAL_CODE"), /其他已登记偏离/);
});
