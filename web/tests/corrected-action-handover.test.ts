import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { investorFixture } from "./investor-fixture";
import { actionPython, probeActionMutation, resealActionRow } from "./action-maintenance-fixture";
import { hash } from "../src/server/ledger/service";
import { enqueueCorrectedActionHandoverJob, readActionReviewJobStatus } from "../src/server/investor/action-review-jobs";
import { readActionReviewConfirmation, readActionReviewConfirmationReceipt, confirmedEventOrigins, retainedConfirmedEventOrigins } from "../src/server/investor/action-review-lineage";
import { readManagedActionAnchorContext } from "../src/server/investor/managed-action-source";
import { readCorrectionConsentBaseline } from "../src/server/investor/correction-consent";

type Obj = Record<string, unknown>;
const actor = { id: "synthetic-investor" }, at = "2026-11-07T06:00:05.002Z", later = "2026-11-08T06:00:05.002Z";
test("ordinary Node intent reaches default core, explicit corrected-source activation, independent replay and next-day bounded maintenance without a monitor epoch", t => {
  const f = investorFixture(); t.after(f.close);
  const input = actionPython(f.filename, `
from tests.investor.test_corrected_action_handover import CorrectedActionHandoverTests
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=CorrectedActionHandoverTests();case.db=db;case.path=Path(sys.argv[1])
try:print(json.dumps(case.prepared(enable=True)))
finally:case.doCleanups()
`, "legacy_transition");
  const original = f.db.prepare("SELECT count(*) n FROM investor_evidence_model_checkpoints").get() as { n: number };
  const request = enqueueCorrectedActionHandoverJob(f.db, actor, { kind: "confirmation", body: input }, at);
  assert.equal(request.schema_version, "investor-action-review-job-request-v3");
  assert.deepEqual(enqueueCorrectedActionHandoverJob(f.db, actor, { kind: "confirmation", body: input }, at), request);
  assert.throws(() => enqueueCorrectedActionHandoverJob(f.db, actor, { kind: "confirmation", body: { ...input, enable_rule: false } }, at));
  const completed = actionPython(f.filename, `
from tests.investor.test_corrected_action_handover import CorrectedActionHandoverTests
from worker.investor import action_review_workflow as review
from worker.orchestration.runtime import run_pending_once
for _ in range(12):
 value=run_pending_once(db,'fictional-Node-handover-core',clock=lambda:'${at}')
 row=db.execute("SELECT * FROM investor_action_review_job_results WHERE request_id=?",('${request.request_id}',)).fetchone()
 if row:break
 assert value is not None
assert row['outcome']=='confirmed',dict(row)
doc=review.resolve_action_review_confirmation(db,'w','synthetic-investor',row['resource_id'],now='${at}')
print(json.dumps(doc))
`);
  const reader = new Database(f.filename, { readonly: true }); t.after(() => reader.close()); reader.pragma("query_only=ON");
  const doc = readActionReviewConfirmation(reader, "w", actor.id, completed.confirmation_id, at);
  assert.deepEqual(doc, completed); assert.equal(doc.request && (doc.request as Obj).enable_rule, true);
  const status = readActionReviewJobStatus(reader, actor, request.request_id as string, at);
  assert.equal(status.request?.status, "confirmed");
  const value = readManagedActionAnchorContext(reader, "w", doc.new_authority_id, at);
  assert.equal(value.grant.current.enabled, 1); assert.equal(value.grant.current.version, 2);
  const origins = confirmedEventOrigins(reader, "w", value.base, at), proof = doc.source_proof as Obj;
  assert.throws(() => retainedConfirmedEventOrigins(reader, "w", value.base, at), /CURRENT_EPOCH_PROTOCOL_REQUIRED/);
  const event = (value.base.facts.events as Obj[]).find(row => String(row.id).startsWith("reviewed-correction:"))!;
  assert.equal(origins.get(event.id as string)?.known_at, proof.knowledge_at); assert.notEqual(proof.knowledge_at, doc.created_at);
  assert.equal(readCorrectionConsentBaseline(reader, "w", actor, input.correction_id as string, at).confirmation_id, input.correction_id);
  assert.equal((reader.prepare("SELECT total_changes() n").get() as { n: number }).n, 0);
  const extended = actionPython(f.filename, `
from tests.investor.test_corrected_action_source import CorrectedActionSourceTests
from worker.investor import managed_actions,action_review_workflow as review
case=CorrectedActionSourceTests();case.db=db
case.value={'member':{'issuer_authority_id':db.execute("SELECT id FROM investor_issuer_authorities WHERE json_extract(document_json,'$.fund_id')='3141'").fetchone()[0]}}
case.next_reports(at='${later}')
publications=managed_actions.publish_current_actions(db,now='${later}');assert len(publications)==1,publications
assert publications[0]['status']=='published',publications
print(json.dumps({'document':review.resolve_action_review_confirmation(db,'w','synthetic-investor','${completed.confirmation_id}',now='${later}')}))
`);
  assert.deepEqual(readActionReviewConfirmation(reader, "w", actor.id, completed.confirmation_id, later), extended.document);
  assert.equal((reader.prepare("SELECT count(*) n FROM investor_evidence_model_checkpoints").get() as { n: number }).n, original.n);
  for (const name of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((reader.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n, 0);
  probeActionMutation(f.db, ["investor_action_review_confirmations", "audit_events"], () => {
    resealActionRow(f.db, "investor_action_review_confirmations", completed.confirmation_id as string, value => { (value.source_proof as Obj).candidate_facts_hash = hash("forged"); });
  }, () => {
    assert.doesNotThrow(() => readActionReviewConfirmationReceipt(f.db, "w", actor.id, completed.confirmation_id, later));
    assert.throws(() => readActionReviewConfirmation(f.db, "w", actor.id, completed.confirmation_id, later));
  });
  actionPython(f.filename, `
from worker.investor import eodhd_sources
grant=db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','synthetic-investor',grant,False,now='${later}')
print('{}')
`);
  assert.doesNotThrow(() => readActionReviewConfirmationReceipt(reader, "w", actor.id, completed.confirmation_id, later));
  assert.throws(() => readActionReviewConfirmation(reader, "w", actor.id, completed.confirmation_id, later));
});
