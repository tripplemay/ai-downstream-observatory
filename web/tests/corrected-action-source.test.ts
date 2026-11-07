import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { investorFixture } from "./investor-fixture";
import { actionPython, probeActionMutation, resealActionRow } from "./action-maintenance-fixture";
import { hash } from "../src/server/ledger/service";
import { prepareCorrectedActionSource, replayCorrectedActionSource } from "../src/server/investor/corrected-action-source";
import { readCorrectionConsentBaseline, readCorrectionConsentReceipt } from "../src/server/investor/correction-consent";
import { readRegisteredCorrectionHistory, readRetainedMonitorHistory } from "../src/server/investor/retained-monitor-history";
import { validateCorrectedActionSource, validateInvestorMonitorDataDocument } from "../src/server/investor/kernel-contracts";

const at = "2026-11-07T06:00:04.002Z", later = "2026-11-08T06:00:04.003Z", owner = { id: "synthetic-investor" };
const setup = `
from tests.investor.test_corrected_action_source import CorrectedActionSourceTests,AT,LATER
from worker.investor import corrected_action_source as corrected
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=CorrectedActionSourceTests();case.db=db;case.path=Path(sys.argv[1])
`;
test("independent Node replays the approved baseline/current report preparation and exactly matches Python without publishing or writing", t => {
  const f = investorFixture(); t.after(f.close);
  const expected = actionPython(f.filename, setup + `
try:
 identifier=case.confirmed();first=case.prepare();after_ttl=case.prepare(now='2026-11-07T07:00:00.000Z')
 case.next_reports();later=case.prepare(now=LATER)
 print(json.dumps({'id':identifier,'first':first,'after_ttl':after_ttl,'later':later}))
finally:case.doCleanups()
`, "legacy_transition");
  const reader = new Database(f.filename, { readonly: true }); t.after(() => reader.close()); reader.pragma("query_only=ON");
  assert.deepEqual(prepareCorrectedActionSource(reader, "w", owner, expected.id as string, at), expected.first);
  assert.deepEqual(prepareCorrectedActionSource(reader, "w", owner, expected.id as string, "2026-11-07T07:00:00.000Z"), expected.after_ttl);
  const value = prepareCorrectedActionSource(reader, "w", owner, expected.id as string, later); assert.deepEqual(value, expected.later);
  assert.equal((reader.prepare("SELECT total_changes() n").get() as { n: number }).n, 0);
  assert.equal((reader.pragma("query_only", { simple: true })), 1);
  assert.throws(() => prepareCorrectedActionSource(reader, "w", { id: "foreign" }, expected.id as string, later));
  assert.throws(() => prepareCorrectedActionSource(reader, "w", owner, expected.id as string, "2026-11-09T06:00:04.003Z"));
  for (const patch of [{ maintenance_enabled: true }, { monitoring_resumed: true }, { facts: value.facts }, { provider_calls: 1 }])
    assert.throws(() => validateCorrectedActionSource({ ...value.proof, ...patch }));
  assert.throws(() => validateInvestorMonitorDataDocument("input", value));
  assert.doesNotMatch(JSON.stringify(value.proof), /"(?:gross_per_unit|tax_per_unit|cash_by_currency|quantities|tax_assumption)":/);
  const original = readRegisteredCorrectionHistory(reader, "w", owner, expected.id as string, at), model = original.definition.model_id as string;
  assert.deepEqual(original, readRetainedMonitorHistory(reader, "w", owner, model, at));
  // An untrusted tail is not a valid epoch. Only the consent-bound historical
  // comparison may read its unchanged prefix; latest/current admission still fails.
  probeActionMutation(f.db, ["investor_evidence_model_checkpoints"], () => {
    f.db.prepare(`INSERT INTO investor_evidence_model_checkpoints
      SELECT 'fictional-untrusted-tail',workspace_id,model_id,input_id,sequence+1,content_hash,
        content_hash,projection_hash,created_at,valid_until FROM investor_evidence_model_checkpoints
      WHERE model_id=? ORDER BY sequence DESC LIMIT 1`).run(model);
  }, () => {
    assert.throws(() => readRetainedMonitorHistory(f.db, "w", owner, model, at));
    assert.deepEqual(readRegisteredCorrectionHistory(f.db, "w", owner, expected.id as string, at), original);
    assert.equal(readCorrectionConsentBaseline(f.db, "w", owner, expected.id as string, at).confirmation_id, expected.id);
    const first = expected.first as typeof value;
    assert.deepEqual(replayCorrectedActionSource(f.db, "w", owner, first.proof, at), first);
    assert.throws(() => prepareCorrectedActionSource(f.db, "w", owner, expected.id as string, at));
  });
  probeActionMutation(f.db, ["investor_model_controls"], () => {
    f.db.prepare(`INSERT INTO investor_model_controls
      SELECT 'fictional-later-control',workspace_id,model_id,version+1,0,actor_id,audit_id,'2026-11-07T06:00:04.003Z'
      FROM investor_model_controls WHERE model_id=? ORDER BY version DESC LIMIT 1`).run(model);
  }, () => {
    const checked = "2026-11-07T06:00:04.004Z";
    assert.deepEqual(readRegisteredCorrectionHistory(f.db, "w", owner, expected.id as string, checked).head, original.head);
    assert.notEqual(readRetainedMonitorHistory(f.db, "w", owner, model, checked).proof.control_hash, original.proof.control_hash);
    assert.throws(() => prepareCorrectedActionSource(f.db, "w", owner, expected.id as string, checked));
  });
  probeActionMutation(f.db, ["investor_evidence_checkpoint_payloads"], () => {
    f.db.prepare("DELETE FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?").run(original.proof.origin_checkpoint_id);
  }, () => assert.throws(() => readRegisteredCorrectionHistory(f.db, "w", owner, expected.id as string, at)));
  for (const [actor, scope, id] of [[{ id: "foreign" }, "w", expected.id], [owner, "foreign", expected.id], [owner, "w", original.proof.head_checkpoint_id]] as const)
    assert.throws(() => readRegisteredCorrectionHistory(f.db, scope, actor, id as string, at));
  probeActionMutation(f.db, ["investor_correction_consents", "investor_correction_consent_results", "audit_events"], () => {
    resealActionRow(f.db, "investor_correction_consents", expected.id as string, doc => {
      ((doc.baseline as Record<string, unknown>).original_history as Record<string, unknown>).checkpoint_chain_hash = "0".repeat(64);
    });
    const confirmation = f.db.prepare("SELECT document_json FROM investor_correction_consents WHERE id=?").get(expected.id) as { document_json: string };
    const result = f.db.prepare("SELECT id FROM investor_correction_consent_results WHERE confirmation_id=?").get(expected.id) as { id: string };
    resealActionRow(f.db, "investor_correction_consent_results", result.id, doc => { doc.confirmation_hash = hash(JSON.parse(confirmation.document_json)); });
  }, () => {
    assert.doesNotThrow(() => readCorrectionConsentReceipt(f.db, "w", owner, expected.id as string, at));
    assert.throws(() => readRegisteredCorrectionHistory(f.db, "w", owner, expected.id as string, at));
  });
  assert.deepEqual(readRegisteredCorrectionHistory(reader, "w", owner, expected.id as string, at), original);
  assert.throws(() => readRegisteredCorrectionHistory(reader, "w", owner, expected.id as string, "2026-12-01T06:00:04.002Z"));
  actionPython(f.filename, `
from tests.investor.test_corrected_action_source import CorrectedActionSourceTests
case=CorrectedActionSourceTests();case.db=db
case.value={'member':{'issuer_authority_id':db.execute("SELECT id FROM investor_issuer_authorities WHERE json_extract(document_json,'$.fund_id')='3141'").fetchone()[0]}}
case.next_reports(at='2026-11-09T06:00:04.003Z',gross='6.32109')
print('{}')
`);
  assert.throws(() => prepareCorrectedActionSource(reader, "w", owner, expected.id as string, "2026-11-09T06:00:04.003Z"));
  assert.equal(readCorrectionConsentReceipt(reader, "w", owner, expected.id as string, "2026-11-09T06:00:04.003Z").confirmation_id, expected.id);
  assert.equal(readCorrectionConsentBaseline(reader, "w", owner, expected.id as string, "2026-11-09T06:00:04.003Z").confirmation_id, expected.id);
});
test("cancelled and split corrections retain their explicit economics/knowledge under both source-preparation engines", async t => {
  for (const mode of ["cancel", "split"]) await t.test(mode, t => {
    const f = investorFixture(); t.after(f.close);
    const expected = actionPython(f.filename, setup + `
try:
 identifier=case.confirmed(mode='${mode}');value=case.prepare()
 print(json.dumps({'id':identifier,'value':value}))
finally:case.doCleanups()
`, "legacy_transition");
    const actual = prepareCorrectedActionSource(f.db, "w", owner, expected.id as string, at); assert.deepEqual(actual, expected.value);
    assert.equal(actual.proof.monitoring_resumed, false); assert.equal(actual.proof.maintenance_enabled, false);
    for (const name of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
      assert.equal((f.db.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n, 0);
  });
});
