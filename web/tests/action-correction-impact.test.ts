import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { investorFixture } from "./investor-fixture";
import { actionPython, probeActionMutation } from "./action-maintenance-fixture";
import { compareActionCorrectionImpact } from "../src/server/investor/action-correction-impact";
import { validateActionCorrectionImpact } from "../src/server/investor/kernel-contracts";

type Obj = Record<string, unknown>;
const noFinance = (db: Database.Database) => {
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
};

test("source-bound hypothetical historical correction independently replays the full history and original-point economics, without approvals or writes", async t => {
  const f = investorFixture(); t.after(() => f.close());
  const value = actionPython(f.filename, `
from tests.investor.test_action_correction_impact import correction_case
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from worker.investor.action_correction_impact import compare_action_correction_impact
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
with offline_protocol_fixture():
 value=correction_case(db,Path(sys.argv[1]));before=db.total_changes
 value['expected']=compare_action_correction_impact(db,'w','synthetic-investor',value['request'],now=value['checked_at'])
 assert db.total_changes==before
 retained=json.loads(json.dumps(value['request']));retained['decisions'][0].update(choice='retain',events=[])
 value['retained_request']=retained
 value['retained_expected']=compare_action_correction_impact(db,'w','synthetic-investor',retained,now=value['checked_at'])
 print(json.dumps(value))
`, "legacy_transition");
  const sql: string[] = [], reader = new Database(f.filename, { readonly: true, verbose: query => sql.push(String(query)) }); t.after(() => reader.close());
  const request = value.request as Obj, at = value.checked_at as string, before = reader.prepare("SELECT total_changes() n").get();
  const read = (raw = request, now = at) => compareActionCorrectionImpact(reader, "w", { id: "synthetic-investor" }, raw, now);
  const result = read(); assert.deepEqual(result, value.expected);
  assert.equal(result.comparison.economics_changed, true); assert.equal(result.source_evidence_verified, false);
  assert.equal(result.economic_correction_approved, false); assert.equal(result.monitoring_resumed, false);
  assert.equal(result.knowledge_not_before, at); assert.deepEqual(reader.prepare("SELECT total_changes() n").get(), before);
  assert.ok(sql.some(query => /^BEGIN/.test(query))); assert.ok(sql.some(query => /^COMMIT/.test(query)));
  assert.equal(sql.some(query => /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP)\b/i.test(query)), false); noFinance(reader);
  assert.deepEqual(read(value.retained_request as Obj), value.retained_expected);

  await t.test("unknown, missing or guessed owner answers and normal append consent cannot become correction approval", () => {
    for (const mode of ["tax", "time", "gross", "knowledge", "currency", "ack", "extra_ack", "no_restatement", "cancel", "duplicate", "unrelated", "tax_negative", "tax_excess", "pay_day", "date", "blank"]) {
      const changed = structuredClone(request), decisions = changed.decisions as Obj[], decision = decisions[0], event = (decision.events as Obj[])[0];
      if (mode === "tax") delete event.tax_per_unit;
      else if (mode === "time") delete event.at;
      else if (mode === "gross") event.gross_per_unit = "99999";
      else if (mode === "knowledge") event.published_at = "2026-01-01T00:00:00Z";
      else if (mode === "currency") event.currency = "HKD";
      else if (mode === "ack") (changed.acknowledgements as Obj).hypothetical_only = false;
      else if (mode === "extra_ack") (changed.acknowledgements as Obj).trading_permission = true;
      else if (mode === "no_restatement") changed.acknowledgements = { no_historical_restatement: true };
      else if (mode === "cancel") Object.assign(decision, { choice: "cancel", events: [] });
      else if (mode === "duplicate") decisions.push(structuredClone(decision));
      else if (mode === "unrelated") decision.date = "2026-11-04";
      else if (mode === "tax_negative") event.tax_per_unit = "-1";
      else if (mode === "tax_excess") event.tax_per_unit = "10000";
      else if (mode === "pay_day") event.pay_at = "2026-11-10T21:00:00Z";
      else if (mode === "date") event.at = "2026-11-04T14:30:00Z";
      else decision.reason = "  ";
      assert.throws(() => read(changed), mode);
    }
    for (const key of ["source_evidence_verified", "economic_correction_approved", "monitoring_resumed", "checkpoint_created"]) {
      const forged = structuredClone(result) as Obj; forged[key] = true; assert.throws(() => validateActionCorrectionImpact("result", forged));
    }
    assert.deepEqual(read(), result); noFinance(reader);
  });

  await t.test("expiry, revision, foreign owner, unavailable retained bytes and changed authority remain closed", () => {
    assert.throws(() => read(request, result.valid_until));
    assert.throws(() => read({ ...request, expected_revision: Number(request.expected_revision) + 1 }));
    sql.length = 0;
    assert.throws(() => compareActionCorrectionImpact(reader, "w", { id: "foreign" }, request, at));
    assert.equal(sql.some(query => /payloads|investor_data_reviews/.test(query)), false);
    probeActionMutation(f.db, ["investor_issuer_payloads"], () => f.db.prepare("UPDATE investor_issuer_payloads SET payload=zeroblob(raw_bytes)").run(),
      () => assert.throws(() => compareActionCorrectionImpact(f.db, "w", { id: "synthetic-investor" }, request, at)));
    assert.deepEqual(read(), result);
    actionPython(f.filename, `
from worker.investor import managed_actions
managed_actions.set_authority_enabled(db,'w','synthetic-investor','${value.authority_id}',True,now='${at}')
print('{}')
`);
    assert.throws(read); noFinance(reader);
  });
});

test("independent retained-report cancellation and split hypotheses preserve principal and all financial tables", async t => {
  for (const mode of ["cancel", "split"]) await t.test(mode, t => {
    const f = investorFixture(); t.after(() => f.close());
    const value = actionPython(f.filename, `
from tests.investor.test_action_correction_impact import correction_case
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from worker.investor.action_correction_impact import compare_action_correction_impact
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
with offline_protocol_fixture():
 value=correction_case(db,Path(sys.argv[1]),mode='${mode}');before=db.total_changes
 value['expected']=compare_action_correction_impact(db,'w','synthetic-investor',value['request'],now=value['checked_at'])
 assert db.total_changes==before
 print(json.dumps(value))
`, "legacy_transition");
    const before = f.db.prepare("SELECT total_changes() n").get();
    if (mode === "split") {
      const implicit = structuredClone(value.request) as Obj;
      delete ((((implicit.decisions as Obj[])[0].events as Obj[])[1]).ratio_direction);
      assert.throws(() => compareActionCorrectionImpact(f.db, "w", { id: "synthetic-investor" }, implicit, value.checked_at as string));
    }
    const result = compareActionCorrectionImpact(f.db, "w", { id: "synthetic-investor" }, value.request, value.checked_at as string);
    assert.deepEqual(result, value.expected); assert.equal((result.comparison.restated as Obj).initial_notional_cny, "10000");
    assert.equal(result.comparison.economics_changed, true); assert.equal(result.economic_correction_approved, false);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); noFinance(f.db);
  });
});
