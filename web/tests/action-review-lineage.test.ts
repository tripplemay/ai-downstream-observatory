import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { type TestContext } from "node:test";
import test from "node:test";
import { actionPython, probeActionMutation, resealActionRow } from "./action-maintenance-fixture";
import { investorFixture } from "./investor-fixture";
import { actionAvailabilityRefs } from "../src/server/investor/monitor-action-knowledge";
import { readInvestorAuditedMonitorSnapshot, readInvestorSourceReview } from "../src/server/investor/source-inputs";
import { readActionReviewConfirmation } from "../src/server/investor/action-review-lineage";
import { readManagedActionAnchorContext, readManagedActionComparisonBasis, readManagedActionReview } from "../src/server/investor/managed-action-source";
import { checkReviewedActionAppend } from "../src/server/investor/action-maintenance-candidate";
import { hash } from "../src/server/ledger/service";

type Obj = Record<string, unknown>;
const NOW = "2026-11-03T06:00:04.001Z";
function lineageFixture(t: TestContext, published = true, enabled = false, twice = false, quarantined = false) {
  const f = investorFixture(); t.after(() => {
    try {
      for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
        assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
    } finally { f.close(); }
  });
  const metadata = actionPython(f.filename, `
from tests.investor.test_action_review_workflow import ActionReviewWorkflowTests,CONFIRM
from worker.investor import action_review_workflow as workflow
from worker.investor.data_evidence import resolve_review
from worker.investor.monitor_action_knowledge import _availability_refs
from worker.orchestration.db import canonical_json
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=ActionReviewWorkflowTests();case.db=db;case.path=Path(sys.argv[1])
if ${twice ? "True" : "False"}:
 case.test_two_manual_successions_inherit_each_original_knowledge_time()
 confirmed=json.loads(db.execute('SELECT document_json FROM investor_action_review_confirmations ORDER BY created_at DESC LIMIT 1').fetchone()[0])
else:
 case.retained_reports(published=${published ? "True" : "False"})
 if ${quarantined ? "True" : "False"}:
  from tests.investor.test_action_review_workflow import AT
  assert workflow.managed.publish_current_actions(db,now=AT)[0]['status']=='blocked'
 case.witness();confirmed=case.confirm(case.answers(enable_rule=${enabled ? "True" : "False"}))
at=confirmed['created_at'];review=resolve_review(db,'w',confirmed['new_review_id'],'actions',now=at)
print(canonical_json({'confirmation':confirmed,'refs':_availability_refs(db,'w',[review],at,at),'now':at,
 'base_review_id':case.base['id']}))
`);
  const now = metadata.now as string;
  function manual(id: unknown) {
    const ref = f.db.prepare("SELECT r.id review_id,r.content_hash review_hash,r.source_id,s.content_hash source_hash FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id WHERE r.id=?")
      .get(id) as Obj;
    return readInvestorSourceReview(f.db, "w", ref, now);
  }
  const doc = metadata.confirmation as Obj;
  function current() { return manual(doc.new_review_id); }
  function read(at = now) { return readActionReviewConfirmation(f.db, "w", "synthetic-investor", doc.confirmation_id, at); }
  return { ...f, metadata, doc, now, current, read, manual };
}

test("independent Node inherits only explicitly confirmed old event origins from actual fictional retained bytes", t => {
  const f = lineageFixture(t), before = f.db.prepare("SELECT total_changes() n").get();
  const refs = actionAvailabilityRefs(f.db, "w", [f.current()], NOW, NOW);
  assert.deepEqual(refs, f.metadata.refs);
  assert.equal(refs[0].original_review_id, f.metadata.base_review_id);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
});

test("the original registered confirmation is independently replayed with or without a prior publication and explicit enable", t => {
  for (const [published, enabled] of [[true, false], [false, false], [true, true]]) {
    const f = lineageFixture(t, published, enabled), before = f.db.prepare("SELECT total_changes() n").get();
    assert.deepEqual(f.read(), f.doc);
    assert.equal(f.doc.previous_publication_id === null, !published);
    assert.equal((f.doc.request as Obj).enable_rule, enabled);
    assert.equal(f.read("2026-11-03T06:02:04.001Z").confirmation_id, f.doc.confirmation_id);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  }
});

test("two explicit manual generations retain distinct root, first and second knowledge times without writes", t => {
  const f = lineageFixture(t, true, false, true), before = f.db.prepare("SELECT total_changes() n").get();
  assert.deepEqual(f.read(), f.doc);
  const refs = actionAvailabilityRefs(f.db, "w", [f.current()], f.now, f.now);
  assert.deepEqual(refs, f.metadata.refs);
  assert.deepEqual([...new Set(refs.map(ref => ref.known_at))].sort(), ["2026-10-31T12:00:00.000Z", NOW, f.now]);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
});

test("a quarantined retired predecessor is comparison evidence, never revived current source admission", t => {
  const f = lineageFixture(t, true, false, false, true);
  assert.deepEqual(f.read(), f.doc);
  assert.throws(() => readManagedActionReview(f.db, "w", f.doc.previous_publication_id, NOW));
  assert.equal((f.db.prepare("SELECT enabled FROM investor_action_controls WHERE authority_id=? ORDER BY version DESC LIMIT 1").get(f.doc.previous_authority_id) as Obj).enabled, 0);
});

test("self-resealed false append proof and original preview basis cannot replace original-byte comparison", t => {
  const f = lineageFixture(t);
  for (const mode of ["snapshot", "count", "basis", "authority"]) probeActionMutation(f.db,
    ["investor_action_review_confirmations", "investor_action_review_previews", "audit_events"], () => {
      resealActionRow(f.db, "investor_action_review_confirmations", f.doc.confirmation_id as string, doc => {
        if (mode === "snapshot") (doc.append_proof as Obj).current_snapshot_hash = "0".repeat(64);
        else if (mode === "count") (doc.append_proof as Obj).new_nominal_difference_count = 0;
        else if (mode === "basis") doc.draft_basis_hash = "0".repeat(64);
      });
      if (mode === "basis") resealActionRow(f.db, "investor_action_review_previews", f.doc.preview_id as string, doc => { doc.draft_basis_hash = "0".repeat(64); });
      if (mode === "authority") resealActionRow(f.db, "investor_action_review_previews", f.doc.preview_id as string, doc => { doc.authority_hash = "0".repeat(64); });
    }, () => { assert.throws(() => f.read(), mode); assert.throws(() => actionAvailabilityRefs(f.db, "w", [f.current()], NOW, NOW), mode); });
  assert.deepEqual(f.read(), f.doc);
});

test("resealed tax, time or enable answers still have to match the actual review and immutable control witnesses", t => {
  const f = lineageFixture(t);
  for (const mode of ["tax", "trailing-tax", "pay", "effective", "enable"]) probeActionMutation(f.db, ["investor_action_review_confirmations", "audit_events"], () => {
    const request = structuredClone(f.doc.request as Obj), event = (request.new_events as Obj[])[0];
    if (mode === "tax") event.tax_per_unit = "0";
    else if (mode === "trailing-tax") event.tax_per_unit = "0.432109\n";
    else if (mode === "pay") event.pay_at = "2026-11-10T21:00:00Z";
    else if (mode === "effective") event.at = "2026-11-02T21:01:00Z";
    else request.enable_rule = true;
    const requestHash = hash(request);
    resealActionRow(f.db, "investor_action_review_confirmations", f.doc.confirmation_id as string, doc => {
      doc.request = request; doc.request_hash = requestHash;
    }, { request_hash: requestHash });
  }, () => assert.throws(() => f.read(), mode));
});

test("raw corruption cannot be hidden by unchanged or resealed confirmation metadata", t => {
  const f = lineageFixture(t);
  for (const kind of ["issuer", "eodhd"]) probeActionMutation(f.db, [`investor_${kind}_payloads`], () => {
    const row = f.db.prepare(`SELECT rowid,payload FROM investor_${kind}_payloads LIMIT 1`).get() as { rowid: number; payload: Buffer };
    const altered = Buffer.from(row.payload); altered[0] ^= 1;
    f.db.prepare(`UPDATE investor_${kind}_payloads SET payload=? WHERE rowid=?`).run(altered, row.rowid);
  }, () => assert.throws(() => f.read()));
});

test("current provider withdrawal and expiry stop lineage qualification while immutable history remains", t => {
  const f = lineageFixture(t), rows = f.db.prepare("SELECT rowid,* FROM investor_action_review_confirmations").all();
  assert.throws(() => f.read("2027-01-01T00:00:00.000Z"));
  actionPython(f.filename, `
from worker.investor import eodhd_sources
grant=db.execute("SELECT id FROM investor_eodhd_authorities ORDER BY created_at LIMIT 1").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','synthetic-investor',grant,False,now='${NOW}')
print('{}')
`);
  assert.throws(() => f.read());
  assert.throws(() => actionAvailabilityRefs(f.db, "w", [f.current()], NOW, NOW));
  assert.deepEqual(f.db.prepare("SELECT rowid,* FROM investor_action_review_confirmations").all(), rows);
});

test("owner scope is checked before any private confirmation, fact or payload is read", t => {
  const f = lineageFixture(t), queries: string[] = [];
  const guarded = { transaction: f.db.transaction.bind(f.db), prepare(sql: string) {
    queries.push(sql); assert.equal(sql, "SELECT owner_id FROM investor_workspaces WHERE id=?"); return f.db.prepare(sql);
  } } as Database.Database;
  assert.throws(() => readActionReviewConfirmation(guarded, "w", "fictional-foreign", f.doc.confirmation_id, NOW));
  assert.deepEqual(queries, ["SELECT owner_id FROM investor_workspaces WHERE id=?"]);
  assert.throws(() => readActionReviewConfirmation(f.db, "foreign-workspace", "synthetic-investor", f.doc.confirmation_id, NOW));
});

test("genuinely readonly connections replay confirmation lineage without any attempted writes", t => {
  const f = lineageFixture(t), reader = new Database(f.filename, { readonly: true });
  try {
    assert.deepEqual(readActionReviewConfirmation(reader, "w", "synthetic-investor", f.doc.confirmation_id, NOW), f.doc);
    assert.equal((reader.prepare("SELECT total_changes() n").get() as { n: number }).n, 0);
  } finally { reader.close(); }
});

test("all lineage source reads share a single deferred snapshot rather than mixing control generations", t => {
  const f = lineageFixture(t), review = f.current(), queries: string[] = [];
  const guarded = { transaction: f.db.transaction.bind(f.db), prepare(sql: string) {
    assert.equal(f.db.inTransaction, true); queries.push(sql); return f.db.prepare(sql);
  } } as Database.Database;
  assert.deepEqual(readActionReviewConfirmation(guarded, "w", "synthetic-investor", f.doc.confirmation_id, NOW), f.doc);
  assert.deepEqual(actionAvailabilityRefs(guarded, "w", [review], NOW, NOW), f.metadata.refs);
  assert.ok(queries.some(sql => sql.includes("investor_issuer_payloads")));
  assert.equal(f.db.inTransaction, false);
});

test("the independently rebuilt pure append rejects corrections, missing actions and nonnominal conflicts", t => {
  const f = lineageFixture(t), before = readManagedActionComparisonBasis(f.db, "w", f.doc.previous_authority_id, NOW);
  const after = readManagedActionAnchorContext(f.db, "w", f.doc.new_authority_id, NOW);
  const proof = f.doc.append_proof as Obj, facts = after.base.facts;
  const floor = (facts.events as Obj[]).at(-1)!.published_at as string;
  const verify = (next = structuredClone(after.anchor.snapshots), reviewed = structuredClone(facts)) =>
    checkReviewedActionAppend(before.prior.facts, reviewed, before.previous, next, "VT.US", facts.listing_id as string, floor, NOW);
  assert.deepEqual(verify(), proof);
  for (const mode of ["old-amount", "missing-split", "currency", "record-date", "late-event"]) {
    const next = structuredClone(after.anchor.snapshots);
    if (mode === "old-amount") next.issuer.records[0].distribution_amount = "987.1235";
    else if (mode === "missing-split") next.splits.records.push({ date: "2026-11-02", numerator: "2", denominator: "1" });
    else if (mode === "currency") next.dividends.records.at(-1)!.reported_currency = "HKD";
    else if (mode === "record-date") next.dividends.records.at(-1)!.record_date = null;
    else next.issuer.records.push({ ...next.issuer.records.at(-1)!, ex_date: "2026-11-03" });
    assert.throws(() => verify(next), mode);
  }
});

test("an unlinked same-facts manual approval cannot borrow a predecessor knowledge time", t => {
  const f = lineageFixture(t), original = f.current();
  const other = actionPython(f.filename, `
from worker.investor.data_evidence import store_source,review_source
row=db.execute('SELECT document_json FROM investor_data_reviews WHERE id=?',('${original.row.id}',)).fetchone()
facts=json.loads(row[0])['facts']
source=store_source(db,'w','synthetic-investor','actions',{'title':'Unlinked fictional approval','reference':'synthetic://unlinked','excerpt':'No succession claim'},now='${NOW}')
review=review_source(db,'w','synthetic-investor',source['id'],'approved',facts,'Explicit fictional separate approval','2026-11-10T00:00:00.000Z',now='${NOW}')
print(json.dumps({'id':review['id']}))
`);
  const refs = actionAvailabilityRefs(f.db, "w", [f.manual(other.id)], NOW, NOW);
  assert.equal(refs.length, 2); for (const ref of refs) { assert.equal(ref.original_review_id, other.id); assert.equal(ref.known_at, NOW); }
});

test("ordinary audited snapshot independently reconstructs prices, FX and explicitly inherited action lineage", t => {
  const f = lineageFixture(t), at = "2026-11-03T06:00:05.001Z";
  const value = actionPython(f.filename, `
from datetime import datetime
from decimal import Decimal
from unittest.mock import patch
from zoneinfo import ZoneInfo
from worker.investor import data_evidence as evidence
from worker.investor.data_snapshot import build_audited_monitor_dataset
from worker.market.providers import longport
from worker.orchestration.db import canonical_json,content_hash,instant
at='${at}';day='2026-11-02'
def reviewed(kind,facts):
 source=evidence.store_source(db,'w','synthetic-investor',kind,{'title':'Fictional lineage snapshot '+kind,'reference':'synthetic://lineage/'+kind,'excerpt':'Offline fixture, no actual market evidence'},now=at)
 return evidence.review_source(db,'w','synthetic-investor',source['id'],'approved',facts,'Fictional only','2026-11-10T00:00:00.000Z',now=at)
rights=reviewed('rights',{'provider':'longport','account_region':'HK','markets':['US'],'uses':['private_research','private_retention','private_display','private_backup'],
 'retention_days':30,'valid_from':'2026-01-01T00:00:00Z','valid_until':'2026-11-10T00:00:00.000Z','clause_references':['Fictional only']})
calendar=reviewed('calendar',{'market':'US','range_start':day,'range_end':day,'days':[{'date':day,'kind':'full','close_at':day+'T21:00:00Z','available_at':day+'T21:01:00Z',
 'settled_at':'2026-11-03T21:00:00Z','settlement_rule_known_at':'2026-01-01T00:00:00Z'}]})
fx=reviewed('fx',{'currency':'USD','unit':'CNY_per_unit_currency','rows':[{'observed_at':day+'T21:00:00Z','assumed_available_at':day+'T21:01:00Z','value':'1.23'}]})
mapping={'listing_id':'synthetic-3141','provider_symbol':'VT.US','market':'US','currency':'USD'}
request=longport._request(mapping,day,day,[day])
rows=[{'timestamp':datetime(2026,11,2,tzinfo=ZoneInfo('America/New_York')),'open':Decimal('10'),'high':Decimal('12'),'low':Decimal('9'),'close':Decimal('11.25'),
 'turnover':Decimal('11250'),'volume':1000,'trade_session':0}]
projection=longport._normalize(rows,request=request,sdk_version='4.3.7',call_started_at=at,call_returned_at=at,
 datetime_basis='runtime_utc_from_unix_timestamp',collector_runtime='isolated_official_sdk')
listing=db.execute('SELECT listing_review_id FROM investor_action_authorities WHERE id=?',('${f.doc.new_authority_id}',)).fetchone()[0]
original_millis=evidence._milliseconds
class FictionalClock(datetime):
 @classmethod
 def now(cls,tz=None):return instant(at).astimezone(tz)
with patch.object(longport,'_collect_isolated',return_value=projection) as sdk,patch.object(longport,'read_private_credentials_file',side_effect=AssertionError('NO_CREDENTIAL_READ')) as credentials, \
 patch.object(longport,'datetime',FictionalClock), \
 patch.object(evidence,'_milliseconds',side_effect=lambda value=None:original_millis(at if value is None else value)), \
 patch.object(evidence,'instant',side_effect=lambda value=None:instant(at if value is None else value)):
 capture=evidence.collect_prices(db,'w','synthetic-investor',rights['id'],listing,calendar['id'],day,day)
 sdk.assert_called_once();credentials.assert_not_called()
result=build_audited_monitor_dataset(db,'w',[capture['id']],[],['${f.doc.new_review_id}'],[fx['id']],day,day,now=at)
print(canonical_json({'expected':result['dataset'],'catalog':result['catalog'],'document':{'snapshot':result['manifest'],'created_at':at,'valid_until':result['valid_until'],
 'dataset_hash':result['dataset_hash'],'catalog_hash':content_hash(result['catalog'])}}))
`);
  const before = f.db.prepare("SELECT total_changes() n").get();
  const guarded = { transaction: f.db.transaction.bind(f.db), prepare(sql: string) {
    assert.equal(f.db.inTransaction, true); return f.db.prepare(sql);
  } } as Database.Database;
  const source = readInvestorAuditedMonitorSnapshot(guarded, "w", value.document as Obj, at);
  assert.equal(source.unavailable_reason, null); assert.deepEqual(source.dataset, value.expected); assert.deepEqual(source.catalog, value.catalog);
  assert.ok(source.dataset && "reviewed_actions" in source.dataset);
  assert.equal(source.dataset.reviewed_actions.length, 1);
  assert.equal((source.dataset.reviewed_actions[0].availability as Obj).known_at, NOW);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
});
