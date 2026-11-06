import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { investorFixture } from "./investor-fixture";
import { actionPython } from "./action-maintenance-fixture";
import { replayModelEpochContinuationSource } from "../src/server/investor/model-epoch-continuation-source";
import { validateInvestorMonitorDataDocument, validateModelEpochContinuationSource } from "../src/server/investor/kernel-contracts";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { readEpochContinuationChain } from "../src/server/investor/epoch-continuation";

type Obj = Record<string, unknown>;
function obj(value: unknown): Obj { assert.ok(value && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
const actor = { id: "owner" }, now = "2026-10-21T10:00:03.000Z", first = "2026-10-20T10:00:03.000Z";

test("retained intermediate and multi-day originals survive a stopped core interval with independent current replay and no fabricated past observations",t=>{
  const f=investorFixture();t.after(f.close);
  const setup=actionPython(f.filename,`
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor import epoch_gap_fixture as gap
from worker.investor.model_epoch_continuation_source import prepare_model_epoch_continuation
with offline_protocol_fixture():
 value=gap.create(db,Path(sys.argv[1]));saved=value['saved'];epoch=saved['registration']['epoch']['id']
 tiles=gap.add_prices(db,saved,['2026-10-20','2026-10-21'])
 prepared=prepare_model_epoch_continuation(db,'w','owner',epoch,now=gap.NOW)
print(json.dumps({'saved':saved,'prepared':prepared,'tiles':tiles,'now':gap.NOW}))
`,"core_readmission");
  const prepared=obj(setup.prepared),saved=obj(setup.saved),epochId=String(obj(obj(saved.registration).epoch).id),at=String(setup.now);
  const implementation=String(obj(obj(prepared.candidate).assessment).implementation_hash);
  const reader=new Database(f.filename,{readonly:true});t.after(()=>reader.close());reader.pragma("query_only=ON");
  assert.deepEqual(replayModelEpochContinuationSource(reader,"w",actor,epochId,prepared.input,at,implementation),prepared);
  const published=actionPython(f.filename,`
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from worker.investor import epoch_continuation as epochs
from worker.orchestration.runtime import run_pending_once
with offline_protocol_fixture():
 epoch=db.execute('SELECT * FROM investor_model_epochs').fetchone()
 head=dict(db.execute('SELECT id,content_hash FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1').fetchone())
 body={'schema_version':'investor-epoch-control-submit-v1','epoch_id':epoch['id'],'expected_registration_hash':epoch['content_hash'],'expected_checkpoint':head,
  'expected_revision':db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0],'idempotency_key':'fictional-retained-gap-activation','enabled':True,'acknowledgements':{k:True for k in epochs.ACKS}}
 epochs.set_epoch_continuation_control(db,'w','owner',body,owner_interaction=True,now='${at}')
 result=run_pending_once(db,'fictional-retained-gap-default-core',clock=lambda:'${at}')
 assert result['status']=='succeeded',result
 chain=epochs.read_epoch_continuation_chain(db,'w','owner',epoch['id'],now='${at}')
 assert chain['publication_count']==1
print(json.dumps(chain))
`,"core_readmission");
  assert.deepEqual(readEpochContinuationChain(reader,"w",actor,epochId,at),published);
  const assessment=obj(obj(obj(published.source).candidate).assessment),state=getInvestorState(reader,actor,at);
  assert.equal(state.model_watch?.status,assessment.outcome==="observe"?"research_observe":"research_decision");assert.equal(state.model_watch?.model_nav_cny,assessment.model_nav_cny);
  assert.equal((reader.prepare("SELECT count(*) n FROM investor_epoch_continuations").get() as {n:number}).n,1);
  assert.equal((reader.prepare("SELECT total_changes() n").get() as {n:number}).n,0);
  // A later conflicting intermediate close must hide current economics, while
  // authenticated historical publications remain independently replayable.
  actionPython(f.filename,`
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor import epoch_gap_fixture as gap
with offline_protocol_fixture():
 preview=json.loads(db.execute('SELECT document_json FROM investor_model_epoch_previews').fetchone()[0])
 gap.add_prices(db,{'preview':preview},['2026-10-20'],delta='1')
print('{}')
`,"core_readmission");
  const hidden=getInvestorState(reader,actor,at);assert.equal(hidden.model_watch?.model_nav_cny,null);assert.ok(!["research_observe","research_decision"].includes(hidden.model_watch?.status??""));
  assert.deepEqual(readEpochContinuationChain(reader,"w",actor,epochId,at),published);
  for(const table of ["portfolios","accounts","ledger_events","postings"])assert.equal((f.db.prepare("SELECT count(*) n FROM "+table).get() as {n:number}).n,0);
});

test("independent registered-parent and current SDK/calendar/action/FX replay advances the same economic epoch without publishing or resetting", t => {
  const f = investorFixture(); t.after(f.close);
  const expected = actionPython(f.filename, `
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.epoch_continuation_source_fixture import create,next_sources,NOW
from worker.investor.model_epoch_continuation_source import prepare_model_epoch_continuation
with offline_protocol_fixture():
 saved=create(db,Path(sys.argv[1]));identifier=saved['registration']['epoch']['id']
 same=prepare_model_epoch_continuation(db,'w','owner',identifier,now='${first}')
 next_sources(db,saved)
 value=prepare_model_epoch_continuation(db,'w','owner',identifier,now=NOW)
print(json.dumps({'saved':saved,'same':same,'value':value}))
`, "core_readmission");
  const value = obj(expected.value), saved = obj(expected.saved), record = obj(saved.registration), epochId = String(obj(record.epoch).id);
  const implementation = String(obj(obj(value.candidate).assessment).implementation_hash);
  const reader = new Database(f.filename, { readonly: true }); t.after(() => reader.close()); reader.pragma("query_only=ON");
  const replay = () => replayModelEpochContinuationSource(reader, "w", actor, epochId, value.input, now, implementation);
  assert.deepEqual(replay(), value);
  const parent = obj(saved.checkpoint), next = obj(obj(value.candidate).checkpoint);
  assert.equal(Number(next.sequence), Number(parent.sequence) + 1); assert.deepEqual(next.epoch_binding, parent.epoch_binding);
  for (const field of ["initial_notional_cny", "initialized_at", "quantities", "cash_by_currency", "entitlements", "receivables", "processed_actions"])
    assert.deepEqual(next[field], parent[field], field);
  assert.deepEqual(obj(obj(expected.same).candidate).checkpoint, parent);
  assert.equal((reader.prepare("SELECT total_changes() n").get() as { n: number }).n, 0);
  assert.throws(() => validateInvestorMonitorDataDocument("input", value.input));
  for (const change of [{ continuation_admitted: true }, { current_source_eligibility_restored: true }, { checkpoint_created: true }, { monitoring_resumed: true },
    { trading_permission: true }, { database_writes: 1 }, { provider_calls: 1 }, { quotes: [] }, { tax_assumption: "invented" }])
    assert.throws(() => validateModelEpochContinuationSource({ ...obj(value.proof), ...change }));
  for (const change of [{ carry_hash: "0".repeat(64) }, { carry_count: 0 }, { projection_hash: "0".repeat(64) }, { epoch: { id: epochId, content_hash: "0".repeat(64) } }])
    assert.throws(() => replayModelEpochContinuationSource(reader, "w", actor, epochId, { ...obj(value.input), ...change }, now, implementation));
  assert.throws(() => replayModelEpochContinuationSource(reader, "w", actor, epochId, obj(expected.same).input, now, implementation));
  assert.throws(() => replayModelEpochContinuationSource(reader, "w", { id: "foreign" }, epochId, value.input, now, implementation));
  assert.throws(() => replayModelEpochContinuationSource(reader, "w", actor, "unregistered", value.input, now, implementation));
  assert.throws(() => replayModelEpochContinuationSource(reader, "w", actor, epochId, value.input, "2026-10-24T16:00:00.000Z", implementation));
  f.db.exec("SAVEPOINT fictional_unknown_epoch_tail");
  try {
    f.db.exec("DROP TRIGGER investor_evidence_checkpoint_insert; DROP TRIGGER investor_epoch_checkpoint_insert");
    f.db.prepare(`INSERT INTO investor_evidence_model_checkpoints SELECT 'fictional-unknown-tail',workspace_id,model_id,input_id,sequence+1,
      content_hash,content_hash,projection_hash,created_at,valid_until FROM investor_evidence_model_checkpoints WHERE id=?`).run(obj(record.checkpoint).id);
    assert.throws(() => replayModelEpochContinuationSource(f.db, "w", actor, epochId, value.input, now, implementation), /LATEST_HEAD_CHANGED/);
  } finally { f.db.exec("ROLLBACK TO fictional_unknown_epoch_tail; RELEASE fictional_unknown_epoch_tail"); }
  f.db.exec("SAVEPOINT fictional_later_control");
  try {
    const state = getInvestorState(f.db, actor, now);
    executeInvestorCommand(f.db, actor, { action: "set_monitoring", model_id: String(record.model_id), enabled: false,
      expected_revision: state.revision, idempotency_key: "fictional-stop-epoch-continuation" }, now);
    assert.throws(() => replayModelEpochContinuationSource(f.db, "w", actor, epochId, value.input, now, implementation));
  } finally { f.db.exec("ROLLBACK TO fictional_later_control; RELEASE fictional_later_control"); }
  actionPython(f.filename, `
from tests.investor import current_correction_fixture as current
from worker.investor import data_evidence
db.execute('SAVEPOINT fictional_ambiguous_fx')
source=db.execute("SELECT r.id,r.valid_until FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id WHERE s.kind='fx' ORDER BY r.created_at DESC LIMIT 1").fetchone()
facts=data_evidence.resolve_review(db,'w',source['id'],'fx',now='${now}')['facts']
facts={key:value for key,value in facts.items() if key!='monitor_series'}
current.reviewed(db,'fx',facts,'${now}',source['valid_until'],'unrelated-equal-fx-must-not-win')
db.execute('RELEASE fictional_ambiguous_fx')
print('{}')
`);
  // This separate, committed fictional source must not become newest-wins.
  assert.throws(replay, /FX_AUTHORITY_AMBIGUOUS/);
  actionPython(f.filename, `
from worker.investor import eodhd_sources
grant=db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','owner',grant,False,now='${now}')
print('{}')
`);
  assert.throws(replay, error => error instanceof Error && !/FX_AUTHORITY_AMBIGUOUS/.test(error.message));
  for (const table of ["portfolios", "accounts", "ledger_events", "postings"])
    assert.equal((f.db.prepare("SELECT count(*) n FROM " + table).get() as { n: number }).n, 0);
});
