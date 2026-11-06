import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {writeFileSync,unlinkSync} from "node:fs";
import path from "node:path";
import { investorFixture } from "./investor-fixture";
import { actionPython } from "./action-maintenance-fixture";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { readEvidenceMonitorRun, readEvidenceCheckpoint } from "../src/server/investor/evidence-monitor";
import { validateEpochContinuation } from "../src/server/investor/kernel-contracts";
import { readEpochContinuationChain, readEpochContinuationHeader } from "../src/server/investor/epoch-continuation";
import { replayModelEpochContinuationSource } from "../src/server/investor/model-epoch-continuation-source";
import { canonical, hash, audit } from "../src/server/ledger/service";
import { Decimal } from "../src/server/ledger/decimal";
import { assertCurrentEpochSourceSelection } from "../src/server/investor/current-epoch-sources";
import { readEvidenceReference } from "../src/server/investor/reference-evidence";
import {submitEpochControl,readEpochControlResponse} from "../src/server/investor/epoch-control-jobs";
import {actionJobStartedByMillisecond} from "../src/server/investor/action-source-proof";
import {readInvestorNotifications,readInvestorNotification} from "../src/server/investor/notifications";
import {verifyHistoryService} from "./epoch-history-service-fixture";
test("ordinary history intents reach async core, bounded real-role stub collection and independent Node continuation without trading",verifyHistoryService);
import {verifyHistoryResolutionService} from "./epoch-history-resolution-fixture";
test("explicit acknowledgement authenticates terminal unknown and expired-lease history, preserves old journals, and only a separate new confirmation enqueues work",verifyHistoryResolutionService);

type Obj = Record<string, unknown>;
const now = "2026-10-21T10:00:03.000Z";
function obj(value: unknown): Obj { assert.ok(value && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
test("paused epoch roots create no notice; actual continuation notices remain historical and independently acknowledge without source access or financial effects",t=>{
  const f=investorFixture();t.after(f.close);const at="2026-10-20T10:00:03.000Z",actor={id:"owner"};
  const seeded=actionPython(f.filename,`
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.test_epoch_continuation import EpochContinuationTests
with offline_protocol_fixture():
 case=EpochContinuationTests();case.db=db;case.path=Path(sys.argv[1]);case.seed()
 print(json.dumps({'epoch':case.epoch_id,'run':case.saved['registration']['monitor_run_id']}))
`,"core_readmission");
  const original=readInvestorNotifications(f.db,actor,at);
  assert.ok(original.entries.length>0);assert.ok(original.entries.every(n=>n.publication_id!==seeded.run));
  const rootJob=obj(f.db.prepare("SELECT j.id,j.result_json FROM job_runs j JOIN investor_model_epochs e ON e.job_id=j.id WHERE e.id=?").get(seeded.epoch));
  f.db.prepare("UPDATE job_runs SET result_json='{}' WHERE id=?").run(rootJob.id);
  assert.throws(()=>readInvestorNotifications(f.db,actor,at));
  f.db.prepare("UPDATE job_runs SET result_json=? WHERE id=?").run(rootJob.result_json,rootJob.id);
  f.db.exec("SAVEPOINT fictional_root_notice");
  try{
    const root=obj(f.db.prepare("SELECT * FROM investor_evidence_monitor_runs WHERE id=?").get(seeded.run));
    f.db.prepare("INSERT INTO outbox(id,dedup_key,topic,payload_json,status,not_before,created_at) VALUES(?,?,'investor.observation.changed',?,'pending',?,?)")
      .run("fictional-forged-root-notice","investor-monitor:"+root.id,canonical({workspace_id:"w",model_id:root.model_id,observation_id:root.observation_id,outcome:root.status,live_advice_eligible:false}),at,at.replace("Z","000Z"));
    assert.throws(()=>readInvestorNotifications(f.db,actor,at));
    assert.throws(()=>audit(f.db,actor,"investor_notification_read","investor_notification","fictional-forged-root-notice",null,null,{workspace_id:"w",publication_hash:"a".repeat(64)},at),/binding is invalid/);
  }finally{f.db.exec("ROLLBACK TO fictional_root_notice; RELEASE fictional_root_notice");}
  actionPython(f.filename,`
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.test_epoch_continuation import EpochContinuationTests
with offline_protocol_fixture():
 case=EpochContinuationTests();case.db=db;case.path=Path(sys.argv[1]);case.epoch_id='${seeded.epoch}'
 case.activate();result=case.run_core('${at}')
 print(json.dumps(result['result']))
`,"core_readmission");
  const before=hash(Object.fromEntries(["investor_workspaces","investor_models","investor_model_controls","investor_observations","job_runs","outbox","investor_epoch_controls","investor_epoch_continuations"]
    .map(name=>[name,f.db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all()])));
  const feed=readInvestorNotifications(f.db,actor,at);assert.equal(feed.entries.length,original.entries.length+1);
  const notice=feed.entries.find(n=>!original.entries.some(old=>old.id===n.id))!;assert.ok(notice);assert.equal(notice.recorded_outcome,"observe");
  assert.equal(notice.is_current_conclusion,false);assert.equal(notice.live_advice_eligible,false);
  const input={notice_id:notice.id,publication_hash:notice.publication_hash};
  const receipt=readInvestorNotification(f.db,actor,input,at);assert.deepEqual(readInvestorNotification(f.db,actor,input,at),receipt);
  const reader=new Database(f.filename,{readonly:true});t.after(()=>reader.close());reader.pragma("query_only=ON");
  assert.equal(readInvestorNotifications(reader,actor,at).entries.find(n=>n.id===notice.id)?.read_at,at);
  assert.equal((reader.prepare("SELECT total_changes() n").get() as {n:number}).n,0);
  assert.equal(hash(Object.fromEntries(["investor_workspaces","investor_models","investor_model_controls","investor_observations","job_runs","outbox","investor_epoch_controls","investor_epoch_continuations"]
    .map(name=>[name,f.db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all()]))),before);
  assert.deepEqual(readInvestorNotifications(f.db,{id:"foreign"},at).entries,[]);
  assert.throws(()=>readInvestorNotification(f.db,{id:"foreign"},input,at),/NOT_FOUND/);
  assert.throws(()=>readInvestorNotification(f.db,actor,{...input,publication_hash:"a".repeat(64)},at),/CHANGED/);
  const savedOutbox=obj(f.db.prepare("SELECT * FROM outbox WHERE id=?").get(notice.id));
  for(const [column,value] of [["payload_json","{}"],["dedup_key","investor-monitor:"+notice.publication_id],["created_at",notice.published_at]] as const){
    f.db.prepare(`UPDATE outbox SET ${column}=? WHERE id=?`).run(value,notice.id);
    assert.throws(()=>readInvestorNotifications(f.db,actor,at));assert.throws(()=>readInvestorNotification(f.db,actor,input,at));
    assert.throws(()=>audit(f.db,actor,"investor_notification_read","investor_notification",notice.id,null,null,{workspace_id:"w",publication_hash:notice.publication_hash},at),/binding is invalid/);
    f.db.prepare(`UPDATE outbox SET ${column}=? WHERE id=?`).run(savedOutbox[column],notice.id);
  }
  const run=obj(f.db.prepare("SELECT job_id FROM investor_evidence_monitor_runs WHERE id=?").get(notice.publication_id));
  const job=obj(f.db.prepare("SELECT result_json FROM job_runs WHERE id=?").get(run.job_id));
  f.db.prepare("UPDATE job_runs SET result_json='{}' WHERE id=?").run(run.job_id);
  assert.throws(()=>readInvestorNotifications(f.db,actor,at));
  assert.throws(()=>audit(f.db,actor,"investor_notification_read","investor_notification",notice.id,null,null,{workspace_id:"w",publication_hash:notice.publication_hash},at),/binding is invalid/);
  f.db.prepare("UPDATE job_runs SET result_json=? WHERE id=?").run(job.result_json,run.job_id);
  assert.equal(readInvestorNotifications(f.db,actor,at).entries.find(n=>n.id===notice.id)?.read_at,at);
  actionPython(f.filename,`
from worker.investor import eodhd_sources
grant=db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','owner',grant,False,now='${at}')
print('{}')
`);
  const retained=readInvestorNotifications(f.db,actor,"2027-02-01T00:00:00.000Z");assert.deepEqual(retained.entries,readInvestorNotifications(f.db,actor,at).entries);
  assert.ok(retained.entries.every(n=>!n.is_current_conclusion&&!n.live_advice_eligible));
  assert.doesNotMatch(JSON.stringify(retained),/"(?:quotes|quantities|source_proof|tax_per_unit|baseline|cash_by_currency|approved_facts)":/);
  f.db.exec("SAVEPOINT fictional_unavailable_payload_tables");
  try{
    for(const name of ["investor_price_payloads","investor_evidence_checkpoint_payloads","investor_evidence_run_payloads"])
      f.db.exec(`DROP TABLE ${name}`);
    assert.deepEqual(readInvestorNotifications(f.db,actor,"2027-02-01T00:00:00.000Z").entries,retained.entries);
  }finally{f.db.exec("ROLLBACK TO fictional_unavailable_payload_tables; RELEASE fictional_unavailable_payload_tables");}
  const marker=path.join(f.directory,"RESTORE_PENDING_REVIEW");writeFileSync(marker,"Fictional recovery lock");
  try{assert.equal(readInvestorNotifications(f.db,actor,at).read_only,true);assert.throws(()=>readInvestorNotification(f.db,actor,input,at),/READ_ONLY/);}
  finally{unlinkSync(marker);}
  for(const name of ["portfolios","accounts","ledger_events","postings","approval_events","activations","reservations","execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${name}`).get() as {n:number}).n,0);
});
test("millisecond publication buckets accept finer same-bucket attempt starts but reject the exact next millisecond",()=>{
  const recorded="2026-11-04T18:34:55.367Z";
  assert.equal(actionJobStartedByMillisecond("2026-11-04T18:34:55.367073Z",recorded),true);
  assert.equal(actionJobStartedByMillisecond("2026-11-04T18:34:55.367999Z",recorded),true);
  assert.equal(actionJobStartedByMillisecond("2026-11-04T18:34:55.368000Z",recorded),false);
  assert.equal(actionJobStartedByMillisecond("2026-11-04T18:34:55.369000Z",recorded),false);
  assert.throws(()=>actionJobStartedByMillisecond(recorded,"2026-11-04T18:34:55.367001Z"));
});
test("ordinary owner activation queues one real core check; immediate metadata-only pause invalidates stale enable work without changing global control",t=>{
  const f=investorFixture();t.after(f.close);const at="2026-10-20T10:00:03.000Z",actor={id:"owner"},binding="a".repeat(64);
  const seeded=actionPython(f.filename,`
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.test_epoch_continuation import EpochContinuationTests
with offline_protocol_fixture():
 case=EpochContinuationTests();case.db=db;case.path=Path(sys.argv[1]);case.seed()
 print(json.dumps({'body':case.body(),'model':case.saved['registration']['model_id']}))
`,"core_readmission");
  const body=seeded.body as Obj,model=String(seeded.model),before=f.db.prepare("SELECT count(*) n FROM investor_epoch_controls").get() as {n:number};
  const initial=readEpochControlResponse(f.db,actor,binding,{model},at);assert.equal(initial.epoch?.enabled,false);assert.equal(initial.epoch?.control_version,0);
  const intent=submitEpochControl(f.db,actor,body,at);assert.deepEqual(submitEpochControl(f.db,actor,body,at),intent);
  assert.equal((f.db.prepare("SELECT count(*) n FROM investor_epoch_controls").get() as {n:number}).n,before.n);
  assert.equal(readEpochControlResponse(f.db,actor,binding,{nonce:body.idempotency_key as string},at).request?.status,"queued");
  const global=f.db.prepare("SELECT * FROM investor_model_controls ORDER BY version").all();
  actionPython(f.filename,`
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from worker.orchestration.runtime import run_pending_once
with offline_protocol_fixture():
 result=run_pending_once(db,'fictional-web-owner-control',clock=lambda:'${at}')
 assert result['status']=='succeeded',result
 assert json.loads(result['result_json'])['outcome']=='applied'
 print('{}')
`,"core_readmission");
  const applied=readEpochControlResponse(f.db,actor,binding,{nonce:body.idempotency_key as string},at);
  assert.equal(applied.request?.status,"applied");assert.equal(applied.epoch?.enabled,true);assert.equal(applied.receipt?.enabled,true);
  const currentBody={...body,expected_revision:applied.workspace_revision,idempotency_key:"fictional-stale-queued-enable"};
  submitEpochControl(f.db,actor,currentBody,at);
  assert.throws(()=>submitEpochControl(f.db,actor,{...currentBody,idempotency_key:"fictional-second-enable"},at),/BUSY/);
  const pause={...currentBody,idempotency_key:"fictional-immediate-pause",enabled:false};submitEpochControl(f.db,actor,pause,at);
  const paused=readEpochControlResponse(f.db,actor,binding,{nonce:pause.idempotency_key},at);
  assert.equal(paused.epoch?.enabled,false);assert.equal(paused.receipt?.enabled,false);
  assert.equal(readEpochControlResponse(f.db,actor,binding,{nonce:currentBody.idempotency_key},at).request?.status,"superseded");
  assert.deepEqual(submitEpochControl(f.db,actor,pause,at),submitEpochControl(f.db,actor,pause,at));
  actionPython(f.filename,`
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from worker.orchestration.runtime import run_pending_once
from worker.investor.epoch_continuation import _control
with offline_protocol_fixture():
 control=_control(db,'w','owner','${paused.receipt!.control_id}')[1]
 assert control['body']['enabled'] is False
 result=run_pending_once(db,'fictional-web-obsolete-enable',clock=lambda:'${at}')
 assert result['status']=='succeeded',result
 assert json.loads(result['result_json'])['outcome']=='rejected'
 print('{}')
`,"core_readmission");
  assert.equal(readEpochControlResponse(f.db,actor,binding,{nonce:currentBody.idempotency_key},at).request?.status,"rejected");
  assert.equal(readEpochControlResponse(f.db,actor,binding,{model},at).epoch?.enabled,false);
  assert.deepEqual(f.db.prepare("SELECT * FROM investor_model_controls ORDER BY version").all(),global);
  assert.throws(()=>readEpochControlResponse(f.db,{id:"foreign"},binding,{model},at));
  for(const table of ["portfolios","accounts","ledger_events","postings"])assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n,0);
});
test("actual ongoing research requires independent full replay and current unambiguous sources; expiry or changed evidence hides derivatives", t => {
  const f = investorFixture(); t.after(f.close);
  const metadata = actionPython(f.filename, `
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.epoch_continuation_source_fixture import create,next_sources,NOW
from tests.investor.epoch_source_fixture import NOW as FIRST
from worker.investor import epoch_continuation as runtime
from worker.orchestration.runtime import run_pending_once
with offline_protocol_fixture():
 saved=create(db,Path(sys.argv[1]));identifier=saved['registration']['epoch']['id']
 root=db.execute('SELECT content_hash FROM investor_model_epochs WHERE id=?',(identifier,)).fetchone()[0]
 head=dict(db.execute('SELECT id,content_hash FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1').fetchone())
 body={'schema_version':'investor-epoch-control-submit-v1','epoch_id':identifier,'expected_registration_hash':root,'expected_checkpoint':head,
  'expected_revision':db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0],'idempotency_key':'fictional-web-explicit-epoch-start','enabled':True,
  'acknowledgements':{key:True for key in runtime.ACKS}}
 runtime.set_epoch_continuation_control(db,'w','owner',body,owner_interaction=True,now=FIRST)
 first=run_pending_once(db,'fictional-web-epoch-core',clock=lambda:FIRST);assert first['status']=='succeeded',first
 next_sources(db,saved)
 second=run_pending_once(db,'fictional-web-epoch-core',clock=lambda:NOW);assert second['status']=='succeeded',second
 chain=runtime.read_epoch_continuation_chain(db,'w','owner',identifier,now=NOW)
 assert chain['publication_count']==2
 result=json.loads(second['result_json'])
print(json.dumps({'result':result,'body':body,'chain':chain,'first_result':json.loads(first['result_json'])}))
`, "core_readmission");
  const result = metadata.result as Obj;
  validateEpochContinuation("control_submit", metadata.body);
  assert.throws(() => validateEpochContinuation("control_submit", { ...metadata.body as Obj, acknowledgements: {} }));
  const reader = new Database(f.filename, { readonly: true }); t.after(() => reader.close()); reader.pragma("query_only=ON");
  const expected = obj(metadata.chain), epochId = String(obj(obj(obj(expected.root).registration).epoch).id);
  const replay = (at = now) => readEpochContinuationChain(reader, "w", { id: "owner" }, epochId, at);
  assert.deepEqual(replay(), expected);
  assert.deepEqual(replay("2026-10-21T21:00:00.000Z").source, expected.source);
  assert.throws(() => readEpochContinuationChain(reader, "w", { id: "foreign" }, epochId, now));
  assert.throws(() => readEpochContinuationChain(reader, "w", { id: "owner" }, "fictional-unregistered-epoch", now));
  assert.throws(() => replay("2026-10-21T10:00:02.000Z"));
  const additional = actionPython(f.filename, `
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from worker.investor.epoch_continuation import read_epoch_continuation_chain
from worker.investor.model_epoch_continuation_source import prepare_model_epoch_continuation
with offline_protocol_fixture():
 prefix=read_epoch_continuation_chain(db,'w','owner','${epochId}',now='${now}',publication_id='${obj(metadata.first_result).publication_id}')
 prepared=prepare_model_epoch_continuation(db,'w','owner','${epochId}',now='${now}')
print(json.dumps({'prefix':prefix,'prepared':prepared}))
`, "core_readmission");
  assert.deepEqual(readEpochContinuationChain(reader, "w", { id: "owner" }, epochId, now, String(obj(metadata.first_result).publication_id)), additional.prefix);
  const prepared = obj(additional.prepared), implementation = String(obj(obj(prepared.candidate).assessment).implementation_hash);
  assert.deepEqual(replayModelEpochContinuationSource(reader, "w", { id: "owner" }, epochId, prepared.input, now, implementation), prepared);
  const current = readEvidenceMonitorRun(reader, "w", String(result.monitor_run_id), now);
  assert.equal(current.unavailable_reason, null);
  const assessment = obj(obj(obj(expected.source).candidate).assessment);
  assert.equal(current.observation.outcome, assessment.outcome); assert.equal(current.observation.monitoring, "active");
  assert.equal(current.observation.model_change?.model_nav_cny, assessment.model_nav_cny);
  const expired = readEvidenceMonitorRun(reader, "w", String(result.monitor_run_id), current.observation.next_review_at!);
  assert.equal(expired.unavailable_reason, "MONITOR_COST_ASSUMPTIONS_CHANGED"); assert.equal(expired.observation.model_change, undefined);
  const superseded = readEvidenceMonitorRun(reader, "w", String(obj(metadata.first_result).monitor_run_id), now);
  assert.equal(superseded.unavailable_reason, "MONITOR_EPOCH_RUN_SUPERSEDED"); assert.equal(superseded.observation.model_change, undefined);
  const state = getInvestorState(reader, { id: "owner" }, now);
  assert.equal(current.observation.next_review_at, state.monitor_costs?.valid_until, "the fictional owner's fee evidence is the earliest current deadline");
  assert.equal(state.observations[0].document.outcome, assessment.outcome);
  assert.equal(state.model_watch?.status, assessment.outcome === "observe" ? "research_observe" : "research_decision");
  assert.equal(state.model_watch?.model_nav_cny, assessment.model_nav_cny);
  assert.equal(getInvestorState(reader, { id: "owner" }, current.observation.next_review_at!).model_watch?.model_nav_cny, null);
  f.db.exec("SAVEPOINT fictional_current_human_decision");
  try {
    const intent = { action: "review" as const, observation_id: String(result.observation_id), decision: "defer" as const,
      expected_revision: state.revision, idempotency_key: "fictional-current-epoch-human-defer", note: "Fictional observation only; no trade" };
    if (current.observation.outcome === "decision_required") {
      const first = executeInvestorCommand(f.db, { id: "owner" }, intent, now);
      assert.deepEqual(executeInvestorCommand(f.db, { id: "owner" }, intent, now), first);
      assert.equal((f.db.prepare("SELECT count(*) n FROM investor_decisions WHERE observation_id=?").get(result.observation_id) as { n: number }).n, 1);
      const revision = (f.db.prepare("SELECT revision FROM investor_workspaces WHERE id='w'").get() as { revision: number }).revision;
      assert.throws(() => executeInvestorCommand(f.db, { id: "owner" }, { ...intent, expected_revision: revision, idempotency_key: "fictional-new-review-after-current-deadline" },
        current.observation.next_review_at!), /INVESTOR_NO_DECISION_REQUIRED/);
    } else assert.throws(() => executeInvestorCommand(f.db, { id: "owner" }, intent, now), /INVESTOR_NO_DECISION_REQUIRED/);
    assert.deepEqual(readEpochContinuationChain(f.db, "w", { id: "owner" }, epochId, now).source, expected.source);
    for (const table of ["portfolios", "accounts", "ledger_events", "postings"])
      assert.equal((f.db.prepare("SELECT count(*) n FROM " + table).get() as { n: number }).n, 0);
  } finally { f.db.exec("ROLLBACK TO fictional_current_human_decision; RELEASE fictional_current_human_decision"); }
  const model = reader.prepare("SELECT * FROM investor_models WHERE id=?").get(obj(expected.definition).model_id) as Obj;
  assert.deepEqual(readEvidenceCheckpoint(reader, "w", model, obj(expected.definition), obj(obj(expected.head).checkpoint).id, now).checkpoint, obj(obj(obj(expected.source).candidate).checkpoint));
  assert.equal((reader.prepare("SELECT total_changes() n").get() as { n: number }).n, 0);
  f.db.exec("SAVEPOINT fictional_later_epoch_choices");
  try {
    const later = "2026-10-21T10:00:05.000Z";
    executeInvestorCommand(f.db, { id: "owner" }, { action: "set_monitor_costs", model_id: String(model.id), model_hash: state.monitor_costs!.model_hash,
      expected_cost_version: state.monitor_costs!.version, expected_revision: state.revision, idempotency_key: "fictional-continuation-cost-choice",
      acknowledged_research_only: true, costs: null, validity_days: null }, later);
    assert.deepEqual(readEpochContinuationChain(f.db, "w", { id: "owner" }, epochId, later).source, expected.source);
    const beforeCost = readEvidenceMonitorRun(f.db, "w", String(result.monitor_run_id), later);
    assert.equal(beforeCost.unavailable_reason, null); assert.equal(beforeCost.observation.next_review_at, "2026-10-21T10:00:05.001Z");
    assert.equal(readEvidenceMonitorRun(f.db, "w", String(result.monitor_run_id), "2026-10-21T10:00:05.001Z").unavailable_reason, "MONITOR_COST_ASSUMPTIONS_CHANGED");
    let revision = (f.db.prepare("SELECT revision FROM investor_workspaces WHERE id='w'").get() as { revision: number }).revision;
    executeInvestorCommand(f.db, { id: "owner" }, { action: "save_funding_plan", expected_revision: revision, idempotency_key: "fictional-continuation-funding-choice",
      funding_plan: { schema_version: "investor-funding-plan-v1", start_date: "2026-10-22", horizon_years: 1, evaluation_timezone: "Asia/Shanghai",
        initial_capital_cny: "100.01", annual_contribution_cny: "10.01", first_annual_date: "2027-01-01", entry_method: "three_tranches_60_days",
        actual_arrivals_confirmed: false, execution_authorized: false, live_advice_eligible: false } }, later);
    assert.deepEqual(readEpochContinuationChain(f.db, "w", { id: "owner" }, epochId, later).source, expected.source);
    assert.equal(readEvidenceMonitorRun(f.db, "w", String(result.monitor_run_id), later).unavailable_reason, "MONITOR_FUNDING_PLAN_CHANGED");
    revision = (f.db.prepare("SELECT revision FROM investor_workspaces WHERE id='w'").get() as { revision: number }).revision;
    executeInvestorCommand(f.db, { id: "owner" }, { action: "set_monitoring", model_id: String(model.id), enabled: false,
      expected_revision: revision, idempotency_key: "fictional-continuation-global-pause" }, later);
    assert.deepEqual(readEpochContinuationChain(f.db, "w", { id: "owner" }, epochId, later).source, expected.source);
    assert.equal(readEvidenceMonitorRun(f.db, "w", String(result.monitor_run_id), later).unavailable_reason, "MONITOR_EPOCH_MONITORING_PAUSED");
    assert.equal(getInvestorState(f.db, { id: "owner" }, later).model_watch?.status, "paused");
    assert.throws(() => replayModelEpochContinuationSource(f.db, "w", { id: "owner" }, epochId, prepared.input, later, implementation), /CONTROL_CHANGED/);
  } finally { f.db.exec("ROLLBACK TO fictional_later_epoch_choices; RELEASE fictional_later_epoch_choices"); }
  f.db.exec("SAVEPOINT fictional_unknown_continuation_tail");
  try {
    f.db.exec("DROP TRIGGER investor_evidence_checkpoint_insert; DROP TRIGGER investor_epoch_checkpoint_insert");
    f.db.prepare(`INSERT INTO investor_evidence_model_checkpoints SELECT 'fictional-unregistered-continuation-tail',workspace_id,model_id,input_id,sequence+1,
      content_hash,content_hash,projection_hash,created_at,valid_until FROM investor_evidence_model_checkpoints WHERE id=?`).run(obj(obj(expected.head).checkpoint).id);
    assert.deepEqual(readEpochContinuationChain(f.db, "w", { id: "owner" }, epochId, now), expected);
    assert.throws(() => replayModelEpochContinuationSource(f.db, "w", { id: "owner" }, epochId, prepared.input, now, implementation), /LATEST_HEAD_CHANGED/);
    assert.equal(readEvidenceMonitorRun(f.db, "w", String(result.monitor_run_id), now).unavailable_reason, "MONITOR_EPOCH_CONTINUATION_NOT_VERIFIED");
  } finally { f.db.exec("ROLLBACK TO fictional_unknown_continuation_tail; RELEASE fictional_unknown_continuation_tail"); }
  f.db.exec("SAVEPOINT fictional_resealed_continuation");
  try {
    const publication = obj(f.db.prepare("SELECT * FROM investor_epoch_continuations WHERE id=?").get(result.publication_id)), record = JSON.parse(String(publication.document_json)) as Obj;
    const checkpointId = String(publication.checkpoint_id), checkpoint = JSON.parse((f.db.prepare("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?").get(checkpointId) as { payload: Buffer }).payload.toString()) as Obj;
    const quantities = obj(checkpoint.quantities), listing = Object.keys(quantities).sort()[0]; quantities[listing] = new Decimal(String(quantities[listing])).add(1).toString();
    obj(record.checkpoint).content_hash = hash(checkpoint);
    const runRow = obj(f.db.prepare("SELECT * FROM investor_evidence_monitor_runs WHERE id=?").get(result.monitor_run_id)), run = JSON.parse(String(runRow.document_json)) as Obj;
    run.checkpoint_hash = hash(checkpoint);
    for (const trigger of ["investor_evidence_checkpoint_payload_update", "investor_evidence_checkpoint_no_update", "investor_epoch_continuation_update", "investor_evidence_run_no_update", "audit_events_no_update"])
      f.db.exec("DROP TRIGGER " + trigger);
    f.db.prepare("UPDATE investor_evidence_checkpoint_payloads SET payload=? WHERE checkpoint_id=?").run(Buffer.from(canonical(checkpoint)), checkpointId);
    f.db.prepare("UPDATE investor_evidence_model_checkpoints SET content_hash=? WHERE id=?").run(hash(checkpoint), checkpointId);
    f.db.prepare("UPDATE investor_epoch_continuations SET document_json=?,content_hash=? WHERE id=?").run(canonical(record), hash(record), result.publication_id);
    f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(canonical({ content_hash: hash(record) }), publication.audit_id);
    f.db.prepare("UPDATE investor_evidence_monitor_runs SET document_json=?,content_hash=? WHERE id=?").run(canonical(run), hash(run), result.monitor_run_id);
    readEpochContinuationHeader(f.db, "w", { id: "owner" }, String(result.publication_id), now);
    assert.throws(() => readEpochContinuationChain(f.db, "w", { id: "owner" }, epochId, now), /CHECKPOINT_CHANGED/);
    const bad = readEvidenceMonitorRun(f.db, "w", String(result.monitor_run_id), now);
    assert.equal(bad.observation.outcome, "insufficient_evidence"); assert.equal(bad.observation.model_change, undefined);
  } finally { f.db.exec("ROLLBACK TO fictional_resealed_continuation; RELEASE fictional_resealed_continuation"); }
  assert.deepEqual(replay(), expected);
  for (const kind of ["fx", "actions"]) {
    const duplicate = actionPython(f.filename, `
from tests.investor import current_correction_fixture as current
from worker.investor import data_evidence
document=json.loads(db.execute('SELECT document_json FROM investor_monitor_evidence_inputs ORDER BY rowid DESC LIMIT 1').fetchone()[0])
values=[]
for segment in document['segments']:
 for ref in segment['snapshot']['review_refs']:
  try:values.append(data_evidence.resolve_review(db,'w',ref['review_id'],'${kind}',now='${now}'))
  except Exception:pass
assert values
facts=values[0]['facts'].copy()
if '${kind}'=='fx':facts.pop('monitor_series',None)
value=current.reviewed(db,'${kind}',facts,'${now}',values[0]['review']['valid_until'],'unrelated-equal-${kind}-still-ambiguous')
print(json.dumps({'source_id':value['source_id'],'valid_until':value['valid_until']}))
`);
    const ambiguous = readEvidenceMonitorRun(reader, "w", String(result.monitor_run_id), now);
    assert.equal(ambiguous.observation.outcome, "insufficient_evidence"); assert.equal(ambiguous.observation.model_change, undefined);
    actionPython(f.filename, `
from worker.investor import data_evidence
data_evidence.review_source(db,'w','owner','${duplicate.source_id}','rejected',None,'Fictional separate rejection restores unambiguous selection','${duplicate.valid_until}',now='${now}')
print('{}')
`);
    assert.equal(readEvidenceMonitorRun(reader, "w", String(result.monitor_run_id), now).unavailable_reason, null);
  }
  actionPython(f.filename, `
from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo
from unittest.mock import patch
from hashlib import sha256
from worker.investor import confirmed_capture as captures,data_evidence
from worker.market.providers import longport_confirmed as receiver
from worker.orchestration.db import canonical_json,content_hash
from tests.investor.confirmed_capture_fixture import stamp
at='${now}'
bases=db.execute("SELECT * FROM investor_price_captures WHERE json_extract(receipt_json,'$.request.end_date')='2026-10-20' ORDER BY id").fetchall()
targets=[{**{kind+'_review_id':row[kind+'_review_id'] for kind in ('rights','listing','calendar')},'session_date':'2026-10-20'} for row in bases]
prices={value['records'][0]['listing_id']:Decimal(value['records'][0]['value']) for value in [data_evidence.resolve_capture(db,'w',row['id'],now=at) for row in bases]}
def receive(request,**kwargs):
 assert not kwargs['stop_requested']()
 started=stamp(captures.instant(at));frames=[{'frame':'ready','watch_id':request['watch_id'],'request_hash':content_hash(request),'started_at':started,'sdk_version':'4.3.7','adapter_version':receiver.ADAPTER_VERSION}]
 for sequence,target in enumerate(request['targets'],1):
  price=prices[target['mapping']['listing_id']]
  candle={'timestamp':datetime(2026,10,20,tzinfo=ZoneInfo('America/New_York')),'open':price,'high':price,'low':price,'close':price,'turnover':price*1000,'volume':1000,'trade_session':0}
  value=receiver.normalize_confirmed_day(candle,target,watch_id=request['watch_id'],started_at=started,received_at=started)
  frames.append({'frame':'bar','sequence':sequence,'projection':value['projection'],'sha256':value['projection_sha256']})
 frames.append({'frame':'finished','watch_id':request['watch_id'],'events':len(request['targets']),'reason':'watch_window_elapsed'})
 raw=b''.join(canonical_json(frame).encode()+b'\\n' for frame in frames)
 return {'qualification':captures.OFFICIAL,'protocol_bytes':raw,'protocol_sha256':sha256(raw).hexdigest(),'call_started_at':started,'call_returned_at':started}
millis,parse=captures._milliseconds,captures.instant
with patch.object(receiver,'collect_confirmed_days',side_effect=receive),patch.object(captures,'_milliseconds',side_effect=lambda value=None:millis(at if value is None else value)),patch.object(captures,'instant',side_effect=lambda value=None:parse(at if value is None else value)):
 value=captures.collect_confirmed_prices(db,'w','owner',targets,watch_seconds=1)
assert value['qualification']=='isolated_official_sdk_callback' and value['status']=='complete'
print('{}')
`);
  // Equal SDK and callback receipts must agree, not silently replace one another.
  assert.equal(readEvidenceMonitorRun(reader, "w", String(result.monitor_run_id), now).unavailable_reason, null);
  actionPython(f.filename, `
from datetime import datetime
from decimal import Decimal
from unittest.mock import patch
from zoneinfo import ZoneInfo
from worker.investor import data_evidence as evidence
from worker.market.providers import longport
from worker.orchestration.db import instant
at='2026-10-21T10:00:04.000Z'
base=db.execute("SELECT * FROM investor_price_captures WHERE json_extract(receipt_json,'$.request.end_date')='2026-10-20' ORDER BY created_at DESC,id LIMIT 1").fetchone()
request=json.loads(base['receipt_json'])['request'];price=Decimal('12.345678')
bars=[{'timestamp':datetime(2026,10,20,tzinfo=ZoneInfo('America/New_York')),'open':price,'high':price,'low':price,'close':price,'volume':1000,'turnover':price*1000,'trade_session':0}]
projection=longport._normalize(bars,request=request,sdk_version='4.3.7',call_started_at=at,call_returned_at=at,datetime_basis='runtime_utc_from_unix_timestamp',collector_runtime='isolated_official_sdk')
millis,parse=evidence._milliseconds,evidence.instant
with patch.object(longport,'_collect_isolated',return_value=projection),patch.object(evidence,'_milliseconds',side_effect=lambda value=None:millis(at if value is None else value)),patch.object(evidence,'instant',side_effect=lambda value=None:parse(at if value is None else value)):
 evidence.collect_prices(db,'w','owner',base['rights_review_id'],base['listing_review_id'],base['calendar_review_id'],'2026-10-20','2026-10-20')
print('{}')
`);
  const conflictAt = "2026-10-21T10:00:04.000Z", definition = obj(expected.definition), source = obj(expected.source);
  const reference = readEvidenceReference(reader, "w", String(definition.plan_id), conflictAt);
  assert.deepEqual(replay(conflictAt).source, expected.source);
  assert.throws(() => assertCurrentEpochSourceSelection(reader, "w", reference.document.targets as unknown as Obj[], definition, obj(source.input), obj(obj(source.projection).economic_projection), conflictAt), /PRICES_CONFLICT/);
  const conflicting = readEvidenceMonitorRun(reader, "w", String(result.monitor_run_id), conflictAt);
  assert.equal(conflicting.unavailable_reason, "MONITOR_EPOCH_CURRENT_SOURCE_SELECTION_CHANGED"); assert.equal(conflicting.observation.model_change, undefined);
  actionPython(f.filename, `
from worker.investor import epoch_continuation as runtime
head=dict(db.execute('SELECT id,content_hash FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1').fetchone())
root=db.execute('SELECT content_hash FROM investor_model_epochs WHERE id=?',('${epochId}',)).fetchone()[0]
body={'schema_version':'investor-epoch-control-submit-v1','epoch_id':'${epochId}','expected_registration_hash':root,'expected_checkpoint':head,
 'expected_revision':db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0],'idempotency_key':'fictional-explicit-pause-despite-price-conflict','enabled':False,
 'acknowledgements':{key:True for key in runtime.ACKS}}
runtime.set_epoch_continuation_control(db,'w','owner',body,owner_interaction=True,now='2026-10-21T10:00:05.000Z')
print('{}')
`);
  const pausedAt = "2026-10-21T10:00:05.000Z";
  assert.deepEqual(replay(pausedAt).source, expected.source);
  const paused = readEvidenceMonitorRun(reader, "w", String(result.monitor_run_id), pausedAt);
  assert.equal(paused.unavailable_reason, "MONITOR_EPOCH_CONTINUATION_PAUSED"); assert.equal(paused.observation.model_change, undefined);
  assert.equal(getInvestorState(reader, { id: "owner" }, pausedAt).model_watch?.status, "paused");
  actionPython(f.filename, `
from worker.investor import eodhd_sources
grant=db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','owner',grant,False,now='2026-10-21T10:00:06.000Z')
print('{}')
`);
  assert.throws(() => replay("2026-10-21T10:00:06.000Z"));
  const revoked = readEvidenceMonitorRun(reader, "w", String(result.monitor_run_id), "2026-10-21T10:00:06.000Z");
  assert.equal(revoked.observation.outcome, "insufficient_evidence"); assert.equal(revoked.observation.model_change, undefined);
  for (const table of ["portfolios", "accounts", "ledger_events", "postings"])
    assert.equal((reader.prepare("SELECT count(*) n FROM " + table).get() as { n: number }).n, 0);
  assert.equal((reader.prepare("SELECT total_changes() n").get() as { n: number }).n, 0);
});
