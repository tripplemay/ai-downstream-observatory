import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { investorFixture } from "./investor-fixture";
import { actionPython } from "./action-maintenance-fixture";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { readEvidenceMonitorRun, readEvidenceCheckpoint } from "../src/server/investor/evidence-monitor";
import { validateEpochContinuation } from "../src/server/investor/kernel-contracts";
import { readEpochContinuationChain, readEpochContinuationHeader } from "../src/server/investor/epoch-continuation";
import { replayModelEpochContinuationSource } from "../src/server/investor/model-epoch-continuation-source";
import { canonical, hash } from "../src/server/ledger/service";
import { Decimal } from "../src/server/ledger/decimal";

type Obj = Record<string, unknown>;
const now = "2026-10-21T10:00:03.000Z";
function obj(value: unknown): Obj { assert.ok(value && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
test("independent query-only full chain replays reuse and next-close states; historical proof is not current-source eligibility", t => {
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
  assert.equal(current.unavailable_reason, "MONITOR_EPOCH_CURRENT_SOURCE_SELECTION_PENDING");
  assert.equal(current.observation.outcome, "insufficient_evidence"); assert.equal(current.observation.model_change, undefined);
  const state = getInvestorState(reader, { id: "owner" }, now);
  assert.equal(state.observations[0].document.outcome, "insufficient_evidence");
  assert.equal(state.model_watch?.model_nav_cny, null);
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
    let revision = (f.db.prepare("SELECT revision FROM investor_workspaces WHERE id='w'").get() as { revision: number }).revision;
    executeInvestorCommand(f.db, { id: "owner" }, { action: "save_funding_plan", expected_revision: revision, idempotency_key: "fictional-continuation-funding-choice",
      funding_plan: { schema_version: "investor-funding-plan-v1", start_date: "2026-10-22", horizon_years: 1, evaluation_timezone: "Asia/Shanghai",
        initial_capital_cny: "100.01", annual_contribution_cny: "10.01", first_annual_date: "2027-01-01", entry_method: "three_tranches_60_days",
        actual_arrivals_confirmed: false, execution_authorized: false, live_advice_eligible: false } }, later);
    assert.deepEqual(readEpochContinuationChain(f.db, "w", { id: "owner" }, epochId, later).source, expected.source);
    revision = (f.db.prepare("SELECT revision FROM investor_workspaces WHERE id='w'").get() as { revision: number }).revision;
    executeInvestorCommand(f.db, { id: "owner" }, { action: "set_monitoring", model_id: String(model.id), enabled: false,
      expected_revision: revision, idempotency_key: "fictional-continuation-global-pause" }, later);
    assert.deepEqual(readEpochContinuationChain(f.db, "w", { id: "owner" }, epochId, later).source, expected.source);
    assert.throws(() => replayModelEpochContinuationSource(f.db, "w", { id: "owner" }, epochId, prepared.input, later, implementation), /CONTROL_CHANGED/);
  } finally { f.db.exec("ROLLBACK TO fictional_later_epoch_choices; RELEASE fictional_later_epoch_choices"); }
  f.db.exec("SAVEPOINT fictional_unknown_continuation_tail");
  try {
    f.db.exec("DROP TRIGGER investor_evidence_checkpoint_insert; DROP TRIGGER investor_epoch_checkpoint_insert");
    f.db.prepare(`INSERT INTO investor_evidence_model_checkpoints SELECT 'fictional-unregistered-continuation-tail',workspace_id,model_id,input_id,sequence+1,
      content_hash,content_hash,projection_hash,created_at,valid_until FROM investor_evidence_model_checkpoints WHERE id=?`).run(obj(obj(expected.head).checkpoint).id);
    assert.deepEqual(readEpochContinuationChain(f.db, "w", { id: "owner" }, epochId, now), expected);
    assert.throws(() => replayModelEpochContinuationSource(f.db, "w", { id: "owner" }, epochId, prepared.input, now, implementation), /LATEST_HEAD_CHANGED/);
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
  } finally { f.db.exec("ROLLBACK TO fictional_resealed_continuation; RELEASE fictional_resealed_continuation"); }
  assert.deepEqual(replay(), expected);
  actionPython(f.filename, `
from worker.investor import eodhd_sources
grant=db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','owner',grant,False,now='${now}')
print('{}')
`);
  assert.throws(() => replay());
  const revoked = readEvidenceMonitorRun(reader, "w", String(result.monitor_run_id), now);
  assert.equal(revoked.observation.outcome, "insufficient_evidence"); assert.equal(revoked.observation.model_change, undefined);
  for (const table of ["portfolios", "accounts", "ledger_events", "postings"])
    assert.equal((reader.prepare("SELECT count(*) n FROM " + table).get() as { n: number }).n, 0);
});
