import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { investorFixture } from "./investor-fixture";
import { actionPython } from "./action-maintenance-fixture";
import { getInvestorState } from "../src/server/investor/service";
import { readEvidenceMonitorRun, readEvidenceCheckpoint } from "../src/server/investor/evidence-monitor";
import { validateEpochContinuation } from "../src/server/investor/kernel-contracts";

type Obj = Record<string, unknown>;
const now = "2026-10-21T10:00:03.000Z";
test("actual default-core epoch continuations do not crash ordinary reads or expose stored NAV before independent chain verification", t => {
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
print(json.dumps({'result':result,'body':body,'definition':chain['definition'],'checkpoint':chain['head']['checkpoint']}))
`, "core_readmission");
  const result = metadata.result as Obj;
  validateEpochContinuation("control_submit", metadata.body);
  assert.throws(() => validateEpochContinuation("control_submit", { ...metadata.body as Obj, acknowledgements: {} }));
  const reader = new Database(f.filename, { readonly: true }); t.after(() => reader.close()); reader.pragma("query_only=ON");
  const current = readEvidenceMonitorRun(reader, "w", String(result.monitor_run_id), now);
  assert.equal(current.unavailable_reason, "MONITOR_EPOCH_CHAIN_VERIFICATION_PENDING");
  assert.equal(current.observation.outcome, "insufficient_evidence"); assert.equal(current.observation.model_change, undefined);
  const state = getInvestorState(reader, { id: "owner" }, now);
  assert.equal(state.observations[0].document.outcome, "insufficient_evidence");
  assert.equal(state.model_watch?.model_nav_cny, null);
  const model = reader.prepare("SELECT * FROM investor_models WHERE id=?").get((metadata.definition as Obj).model_id) as Obj;
  assert.equal(readEvidenceCheckpoint(reader, "w", model, metadata.definition as Obj, (metadata.checkpoint as Obj).id, now).checkpoint, null);
  assert.equal((reader.prepare("SELECT total_changes() n").get() as { n: number }).n, 0);
});
