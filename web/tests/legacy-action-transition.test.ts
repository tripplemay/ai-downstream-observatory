import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { actionPython, probeActionMutation } from "./action-maintenance-fixture";
import { investorActor, investorFixture } from "./investor-fixture";
import { canonical, hash } from "../src/server/ledger/service";
import { readLegacyActionTransitionPreview } from "../src/server/investor/legacy-action-transition";
import { checkpointActionReview } from "../src/server/investor/action-checkpoint-replay";
import { readInvestorMonitorEvidenceSource, compareInvestorMonitorData, replayInvestorMonitorData } from "../src/server/investor/monitor-source";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";

type Obj = Record<string, unknown>;
const at = "2026-11-03T06:00:04.001Z";
function fixture(t: TestContext, twoCheckpoints = false) {
  const f = investorFixture(); t.after(() => f.close());
  const value = actionPython(f.filename, `
from tests.investor.test_action_review_readmission import ActionReviewReadmissionTests
from tests.investor.test_action_review_workflow import ActionReviewWorkflowTests,CONFIRM
from tests.investor.test_legacy_action_transition import LegacyActionTransitionTests
from worker.investor import legacy_action_transition as transition
from worker.orchestration.db import canonical_json
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=ActionReviewReadmissionTests();case.db=db;case.case=ActionReviewWorkflowTests();case.case.db=db;case.case.path=Path(sys.argv[1]);case.case.version=0
if ${twoCheckpoints ? "True" : "False"}:
 comparison=LegacyActionTransitionTests();comparison.db=db;comparison.case=case
 comparison.test_every_original_checkpoint_is_replayed_not_just_the_last_header()
else:
 case.model(audited=False,known_costs=True);case.confirm()
prepared=transition._prepare_legacy_action_transition(db,'w','synthetic-investor',case.definition['model_id'],now=CONFIRM)
prepared['old_review_id']=case.old
print(canonical_json(prepared))
`, "legacy_transition");
  return { ...f, candidate: value.candidate as Obj, preview: value.preview as Obj, modelId: (value.preview as Obj).model_id as string,
    oldReviewId: value.old_review_id as string };
}

test("Node independently replays actual retained legacy bytes and every checkpoint, not the Python summary", t => {
  const f = fixture(t, true), before = f.db.prepare("SELECT total_changes() n").get();
  t.mock.method(globalThis, "fetch", () => { throw new Error("NO_NETWORK"); });
  const value = readLegacyActionTransitionPreview(f.db, investorActor, "w", f.modelId, f.candidate, at);
  assert.deepEqual(value, f.preview); assert.equal((value.checkpoint as Obj).sequence, 2);
  assert.equal(value.admission_performed, false); assert.equal(value.live_advice_eligible, false);
  assert.ok((value.projection_quality_gaps as string[]).length > 0);
  const ro = new Database(f.filename, { readonly: true, fileMustExist: true });
  try { assert.deepEqual(readLegacyActionTransitionPreview(ro, investorActor, "w", f.modelId, f.candidate, at), value);
    assert.equal((ro.prepare("SELECT total_changes() n").get() as Obj).n, 0);
    assert.equal(checkpointActionReview(ro, "w", f.oldReviewId, at), null);
  } finally { ro.close(); }
  assert.equal(readInvestorMonitorEvidenceSource(f.db, "w", f.modelId, value.legacy_input_id as string, at).projection, null);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  const queries: string[] = [];
  const guarded = new Proxy(f.db, { get(target, key) {
    if (key === "prepare") return (sql: string) => { queries.push(sql); return target.prepare(sql); };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  assert.deepEqual(readLegacyActionTransitionPreview(guarded, investorActor, "w", f.modelId, f.candidate, at), value);
  assert.equal(checkpointActionReview(guarded, "w", f.oldReviewId, at), null);
  for (const table of ["investor_price_payloads", "investor_issuer_payloads", "investor_eodhd_payloads", "investor_evidence_checkpoint_payloads"])
    assert.ok(queries.some(sql => /\bSELECT\b/i.test(sql) && sql.includes(table)), table);
  assert.ok(queries.every(sql => !/^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(sql)));
  assert.equal(checkpointActionReview(f.db, "w", f.oldReviewId, at), null);
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "approval_events", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as Obj).n, 0);
});

test("untrusted candidate knowledge and sealed hashes cannot replace original source replay or actor binding", t => {
  const f = fixture(t), before = f.db.prepare("SELECT total_changes() n").get();
  assert.throws(() => readLegacyActionTransitionPreview(f.db, { id: "other" }, "w", f.modelId, f.candidate, at));
  for (const mutate of [(doc: Obj) => { doc.projection_hash = "0".repeat(64); }, (doc: Obj) => {
    const snapshots = (doc.segments as Obj[]).map(segment => segment.snapshot as Obj);
    const refs = snapshots.flatMap(snapshot => snapshot.action_availability_refs as Obj[]); assert.ok(refs.length);
    refs[0].original_review_hash = "0".repeat(64);
  }, (doc: Obj) => { (doc.settings as Obj).funding_intent = { id: "forged", amount_cny: "1", expected_at: at }; },
  (doc: Obj) => { doc.workspace_id = "other"; }, (doc: Obj) => { doc.model_id = "other"; }]) {
    const candidate = structuredClone(f.candidate); mutate(candidate);
    assert.throws(() => readLegacyActionTransitionPreview(f.db, investorActor, "w", f.modelId, candidate, at));
    assert.equal(checkpointActionReview(f.db, "w", f.oldReviewId, at), null);
  }
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  assert.throws(() => readLegacyActionTransitionPreview(f.db, investorActor, "w", f.modelId, f.candidate, "2026-11-03T06:05:04.002Z"));
});

test("a complete self-consistent unrelated candidate cannot win over the actual approved succession", t => {
  const f = fixture(t);
  const value = actionPython(f.filename, `
from worker.investor import data_evidence,monitor_data,confirmed_feed
from worker.orchestration.db import canonical_json
doc=json.loads(${JSON.stringify(JSON.stringify(f.candidate))})
confirmation=json.loads(db.execute('SELECT document_json FROM investor_action_review_confirmations ORDER BY created_at DESC LIMIT 1').fetchone()[0])
facts=json.loads(db.execute('SELECT document_json FROM investor_data_reviews WHERE id=?',(confirmation['new_review_id'],)).fetchone()[0])['facts']
source=data_evidence.store_source(db,'w','synthetic-investor','actions',{'title':'Fictional unrelated transition','reference':'synthetic://unrelated-transition','excerpt':'Not an approved succession'},now='${at}')
unrelated=data_evidence.review_source(db,'w','synthetic-investor',source['id'],'approved',facts,'Unrelated fictional assertion','2026-11-10T00:00:00.000Z',now='${at}')
windows=confirmed_feed._windows(db,'w',doc)
for _,window in windows:
 window['action_review_ids']=[unrelated['id'] if identifier==confirmation['new_review_id'] else identifier for identifier in window['action_review_ids']]
definition=json.loads(db.execute('SELECT document_json FROM investor_models').fetchone()[0])
candidate=monitor_data.build_monitor_data(db,'w',definition,[window for _,window in windows],doc['settings'],now='${at}',audited_action_knowledge=True)
print(canonical_json(candidate['document']))
`);
  const model = f.db.prepare("SELECT document_json FROM investor_models").get() as { document_json: string };
  const reference = f.db.prepare("SELECT document_json FROM investor_reference_plans ORDER BY created_at DESC LIMIT 1").get() as { document_json: string };
  assert.ok(compareInvestorMonitorData(f.db, "w", JSON.parse(model.document_json), (JSON.parse(reference.document_json) as Obj).targets as Obj[], value, at).comparison_projection);
  assert.throws(() => readLegacyActionTransitionPreview(f.db, investorActor, "w", f.modelId, value, at));
  assert.equal(checkpointActionReview(f.db, "w", f.oldReviewId, at), null);
});

test("a separately confirmed owner cost change fences old previews and resolves the retired-source refresh cycle without rewriting legacy fees", t => {
  const f = fixture(t), declared = "2026-11-03T06:00:04.002Z", effective = "2026-11-03T06:00:04.004Z";
  const old = f.db.prepare("SELECT rowid,* FROM investor_monitor_evidence_inputs ORDER BY rowid").all();
  const heads = f.db.prepare("SELECT rowid,* FROM investor_evidence_model_checkpoints ORDER BY sequence").all();
  const s = getInvestorState(f.db, investorActor, declared); assert.ok(s.monitor_costs);
  executeInvestorCommand(f.db, investorActor, { action: "set_monitor_costs", model_id: f.modelId, model_hash: s.monitor_costs.model_hash,
    expected_cost_version: s.monitor_costs.version, expected_revision: s.revision, idempotency_key: "fictional-legacy-explicit-costs",
    costs: { commission_bps: "1", minimum_fee_cny: "1", fx_bps: "2", slippage_bps: "3", maximum_cost_fraction: "0.01" },
    validity_days: 1, acknowledged_research_only: true }, declared);
  assert.throws(() => readLegacyActionTransitionPreview(f.db, investorActor, "w", f.modelId, f.candidate, effective));
  const all = actionPython(f.filename, `
from worker.investor.legacy_action_transition import _prepare_legacy_action_transition
from worker.orchestration.db import canonical_json
times={'initial':'${effective}','before':'2026-11-04T06:00:04.001Z','after':'2026-11-04T06:00:04.003Z'}
print(canonical_json({key:_prepare_legacy_action_transition(db,'w','synthetic-investor','${f.modelId}',now=stamp) for key,stamp in times.items()}))
`);
  const prepared = all.initial as Obj;
  const candidate = prepared.candidate as Obj, before = f.db.prepare("SELECT total_changes() n").get();
  assert.ok((candidate.settings as Obj).cost_assumptions);
  const preview = readLegacyActionTransitionPreview(f.db, investorActor, "w", f.modelId, candidate, effective);
  assert.deepEqual(preview, prepared.preview); assert.notEqual(preview.settings_hash, f.preview.settings_hash);
  assert.ok((preview.source_valid_until as string) <= "2026-11-04T06:00:04.002Z");
  const beforeExpiry = all.before as Obj, beforeTime = "2026-11-04T06:00:04.001Z", afterTime = "2026-11-04T06:00:04.003Z";
  const justBefore = readLegacyActionTransitionPreview(f.db, investorActor, "w", f.modelId, beforeExpiry.candidate, beforeTime);
  assert.deepEqual(justBefore, beforeExpiry.preview); assert.equal(justBefore.source_valid_until, "2026-11-04T06:00:04.002Z");
  assert.throws(() => readLegacyActionTransitionPreview(f.db, investorActor, "w", f.modelId, beforeExpiry.candidate, afterTime));
  const afterExpiry = all.after as Obj;
  assert.equal((((afterExpiry.candidate as Obj).settings as Obj).policy as Obj).costs, null);
  assert.deepEqual(readLegacyActionTransitionPreview(f.db, investorActor, "w", f.modelId, afterExpiry.candidate, afterTime), afterExpiry.preview);
  assert.deepEqual(f.db.prepare("SELECT rowid,* FROM investor_monitor_evidence_inputs ORDER BY rowid").all(), old);
  assert.deepEqual(f.db.prepare("SELECT rowid,* FROM investor_evidence_model_checkpoints ORDER BY sequence").all(), heads);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  assert.equal(checkpointActionReview(f.db, "w", f.oldReviewId, effective), null);
  assert.equal(checkpointActionReview(f.db, "w", f.oldReviewId, afterTime), null);
});

test("a self-consistently resealed original checkpoint is rejected by actual independent arithmetic", t => {
  const f = fixture(t), head = f.db.prepare("SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence LIMIT 1").get() as Obj;
  probeActionMutation(f.db, ["investor_evidence_model_checkpoints", "investor_evidence_checkpoint_payloads"], () => {
    const raw = f.db.prepare("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?").get(head.id) as { payload: Buffer };
    const state = JSON.parse(raw.payload.toString()) as Obj; (state.quantities as Obj)[Object.keys(state.quantities as Obj)[0]] = "1";
    f.db.prepare("UPDATE investor_evidence_checkpoint_payloads SET payload=? WHERE checkpoint_id=?").run(Buffer.from(canonical(state)), head.id);
    f.db.prepare("UPDATE investor_evidence_model_checkpoints SET content_hash=? WHERE id=?").run(hash(state), head.id);
  }, () => assert.throws(() => readLegacyActionTransitionPreview(f.db, investorActor, "w", f.modelId, f.candidate, at)));
  assert.deepEqual(readLegacyActionTransitionPreview(f.db, investorActor, "w", f.modelId, f.candidate, at), f.preview);
});

test("supplier withdrawal after a successful read prevents reuse without altering original rows", t => {
  const f = fixture(t); readLegacyActionTransitionPreview(f.db, investorActor, "w", f.modelId, f.candidate, at);
  actionPython(f.filename, `
from worker.investor import eodhd_sources
grant=db.execute("SELECT authority_id FROM investor_eodhd_requests WHERE symbol='VT.US' LIMIT 1").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','synthetic-investor',grant,False,now='${at}')
print('{}')
`);
  const before = f.db.prepare("SELECT total_changes() n").get();
  assert.throws(() => readLegacyActionTransitionPreview(f.db, investorActor, "w", f.modelId, f.candidate, at));
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  assert.equal(checkpointActionReview(f.db, "w", f.oldReviewId, at), null);
});

test("a failure inside actual historical source comparison clears the exact old-review scope", t => {
  const f = fixture(t), before = f.db.prepare("SELECT total_changes() n").get(); let entered = false;
  let guarded: Database.Database;
  guarded = new Proxy(f.db, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      if (sql.includes("investor_price_payloads") && checkpointActionReview(guarded, "w", f.oldReviewId, at)) {
        entered = true; throw new Error("FICTIONAL_LEGACY_SOURCE_FAILURE");
      }
      return target.prepare(sql);
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  assert.throws(() => readLegacyActionTransitionPreview(guarded, investorActor, "w", f.modelId, f.candidate, at));
  assert.equal(entered, true); assert.equal(checkpointActionReview(guarded, "w", f.oldReviewId, at), null);
  assert.deepEqual(readLegacyActionTransitionPreview(f.db, investorActor, "w", f.modelId, f.candidate, at), f.preview);
  assert.equal(readInvestorMonitorEvidenceSource(f.db, "w", f.modelId, f.preview.legacy_input_id as string, at).projection, null);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
});

test("historical comparison never revives an expired projection in the normal resolver", t => {
  const f = fixture(t), model = f.db.prepare("SELECT document_json FROM investor_models WHERE id=?").get(f.modelId) as { document_json: string };
  const definition = JSON.parse(model.document_json) as Obj, target = f.db.prepare("SELECT document_json FROM investor_reference_plans ORDER BY created_at DESC LIMIT 1").get() as { document_json: string };
  const targets = (JSON.parse(target.document_json) as Obj).targets as Obj[], later = "2026-11-08T06:00:04.001Z";
  const normal = replayInvestorMonitorData(f.db, "w", definition, targets, f.candidate, later);
  assert.equal(normal.projection, null); assert.equal(normal.unavailable_reason, "MONITOR_DATA_PROJECTION_EXPIRED");
  const comparison = compareInvestorMonitorData(f.db, "w", definition, targets, f.candidate, later);
  assert.ok(comparison.comparison_projection); assert.equal(comparison.unavailable_reason, normal.unavailable_reason);
  assert.equal(Object.hasOwn(comparison, "projection"), false);
  assert.equal(replayInvestorMonitorData(f.db, "w", definition, targets, f.candidate, later).projection, null);
});
