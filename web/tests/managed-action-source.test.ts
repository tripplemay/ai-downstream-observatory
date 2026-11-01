import assert from "node:assert/strict";
import test from "node:test";
import { actionMaintenanceFixture, actionPython, LATER, probeActionMutation, resealActionRow } from "./action-maintenance-fixture";
import { readManagedActionHeader, readManagedActionReview, managedActionReviewUnavailable } from "../src/server/investor/managed-action-source";
import { checkNoNewActionCandidate } from "../src/server/investor/action-maintenance-candidate";
import type { ActionSnapshot } from "../src/server/investor/action-maintenance-candidate";
import { actionNyParts } from "../src/server/investor/action-source-parsers";
import type { ActionDraft, ActionObject as Obj } from "../src/server/investor/action-source-parsers";
import { readInvestorDataSnapshot, readInvestorMonitorPriceSnapshot, readInvestorSourceReview } from "../src/server/investor/source-inputs";

test("independent Web standing-rule replay exactly reconstructs both fictional Python virtual reviews with no writes",t=>{
  const f=actionMaintenanceFixture(t),before=f.db.prepare("SELECT total_changes() n").get();
  const expected=f.metadata.reviews as {review:Obj;source:Obj;facts:Obj}[];
  for(const value of expected) {
    const read=readManagedActionReview(f.db,"w",value.review.id,LATER);
    assert.deepEqual(read,{row:value.review,source:value.source,facts:value.facts});
    assert.deepEqual(readManagedActionHeader(f.db,"w",value.review.id,LATER),read);
    assert.equal(managedActionReviewUnavailable(f.db,"w",value.review.id,LATER),null);
  }
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(),before);
});

test("metadata-only inspection does not approve a resealed false input proof",t=>{
  const f=actionMaintenanceFixture(t),publication=(f.metadata.publications as Obj[])[1],id=publication.publication_id as string;
  probeActionMutation(f.db,["investor_action_publications","audit_events"],()=>{
    resealActionRow(f.db,"investor_action_publications",id,doc=>{doc.checked_input_hash="0".repeat(64);});
  },()=>{
    assert.equal(readManagedActionHeader(f.db,"w",id,LATER).row.id,id);
    assert.equal(managedActionReviewUnavailable(f.db,"w",id,LATER),null);
    assert.throws(()=>readManagedActionReview(f.db,"w",id,LATER));
  });
});

test("another fixed ticker cannot substitute for a frozen listing even with the same fictional raw amounts",t=>{
  const f=actionMaintenanceFixture(t),id=(f.metadata.publications as Obj[])[1].publication_id as string;
  const other=f.db.prepare("SELECT c.id,c.content_hash FROM investor_eodhd_captures c JOIN investor_eodhd_requests r ON r.id=c.request_id WHERE r.symbol='BND.US' AND r.kind='div' ORDER BY r.source_day DESC LIMIT 1").get() as {id:string;content_hash:string};
  probeActionMutation(f.db,["investor_action_publications","audit_events"],()=>{
    resealActionRow(f.db,"investor_action_publications",id,doc=>{(doc.capture_refs as Obj).dividends={capture_id:other.id,capture_hash:other.content_hash};});
  },()=>assert.throws(()=>readManagedActionReview(f.db,"w",id,LATER)));
});

test("own-rule and provider withdrawal stop current qualification without rewriting virtual or manual history",t=>{
  const f=actionMaintenanceFixture(t),id=(f.metadata.publications as Obj[])[1].publication_id as string;
  const before=readManagedActionHeader(f.db,"w",id,LATER),manual=f.db.prepare("SELECT rowid,* FROM investor_data_reviews ORDER BY rowid").all();
  actionPython(f.filename,`
from worker.investor import managed_actions as m
r=db.execute('SELECT id FROM investor_action_authorities').fetchone()
m.set_authority_enabled(db,'w','synthetic-investor',r[0],False,now='${LATER}')
print('{}')
`);
  assert.equal(managedActionReviewUnavailable(f.db,"w",id,LATER),"REFERENCE_SOURCE_NO_LONGER_CURRENT");
  assert.throws(()=>readManagedActionReview(f.db,"w",id,LATER));assert.deepEqual(readManagedActionHeader(f.db,"w",id,LATER),before);
  assert.deepEqual(f.db.prepare("SELECT rowid,* FROM investor_data_reviews ORDER BY rowid").all(),manual);
});

test("expiry preserves authenticated headers, never stale raw admission or a new deadline",t=>{
  const f=actionMaintenanceFixture(t),id=(f.metadata.publications as Obj[])[1].publication_id as string,value=readManagedActionReview(f.db,"w",id,LATER);
  const expiry=value.row.valid_until;
  assert.deepEqual(readManagedActionHeader(f.db,"w",id,expiry),value);
  assert.equal(managedActionReviewUnavailable(f.db,"w",id,expiry),"REFERENCE_SOURCE_EXPIRED");
  assert.throws(()=>readManagedActionReview(f.db,"w",id,expiry));
  assert.throws(()=>readManagedActionReview(f.db,"foreign",id,LATER));
});

test("Node independently rejects new events, corrections, changed old differences, gaps and mixed source days",t=>{
  const f=actionMaintenanceFixture(t),anchor={} as ActionSnapshot,current={} as ActionSnapshot;
  for(const capture of f.metadata.captures as {kind:string;draft:ActionDraft}[]) {
    const draft=capture.draft,source=draft.source;
    if(capture.kind === "issuer" ? source.requested_fund_id !== "3141":source.requested_symbol !== "VT.US")continue;
    const key=capture.kind === "issuer" ? "issuer":source.kind === "div" ? "dividends":"splits";
    (actionNyParts(source.retrieved_at).day === "2026-11-01" ? anchor:current)[key]=draft;
  }
  const facts=f.metadata.facts as Obj,check=(next:ActionSnapshot)=>checkNoNewActionCandidate(facts,anchor,next,"VT.US","synthetic-3141");
  assert.equal(check(current).candidate_range_end,"2026-11-01");
  const mutations:((next:ActionSnapshot)=>void)[]=[
    next=>{next.issuer.records.push({...next.issuer.records[0],ex_date:"2026-11-02"});},
    next=>{next.issuer.records[0].distribution_amount="987.1235";},
    next=>{next.dividends.records[0].unadjusted_value="987.1234";},
    next=>{next.issuer.records=[];},
    next=>{next.splits.records.push({date:"2026-10-31",numerator:"2",denominator:"1"});},
    next=>{next.issuer.source.range_start="2026-10-02";},
    next=>{next.splits.source.retrieved_at="2026-11-01T05:00:03.000000Z";},
    next=>{next.dividends.source.requested_symbol="BND.US";},
  ];
  for(const mutate of mutations){const next=structuredClone(current);mutate(next);assert.throws(()=>check(next));}
});

test("ordinary research and monitor snapshot readers independently replay quote, FX and managed actions",t=>{
  const f=actionMaintenanceFixture(t,true,true),before=f.db.prepare("SELECT total_changes() n").get();
  for(const [kind,value] of Object.entries(f.metadata.snapshots as Record<string,{document:Obj;expected:Obj}>)) {
    const read=(kind === "historical" ? readInvestorDataSnapshot:readInvestorMonitorPriceSnapshot)(f.db,"w",value.document,LATER);
    assert.equal(read.unavailable_reason,null);assert.deepEqual(read.dataset,value.expected.dataset);assert.deepEqual(read.catalog,value.expected.catalog);
    const ref=((value.document.snapshot as Obj).review_refs as Obj[]).find(ref=>(ref.review_id as string).startsWith("managed-actions-review:"))!;
    const reviewed=readInvestorSourceReview(f.db,"w",ref,LATER);assert.equal(reviewed.source.kind,"actions");
    assert.equal(JSON.parse(reviewed.row.document_json).review_basis,"owner_standing_no_new_actions_rule");
    assert.throws(()=>readInvestorSourceReview(f.db,"w",{...ref,review_hash:"0".repeat(64)},LATER));
  }
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(),before);
});

test("ordinary snapshot readers hide withdrawn derived evidence instead of falling back to an earlier manual range",t=>{
  const f=actionMaintenanceFixture(t,true,true),snapshots=f.metadata.snapshots as Record<string,{document:Obj}>;
  actionPython(f.filename,`
from worker.investor import managed_actions as m
r=db.execute('SELECT id FROM investor_action_authorities').fetchone()
m.set_authority_enabled(db,'w','synthetic-investor',r[0],False,now='${LATER}')
print('{}')
`);
  for(const [kind,value] of Object.entries(snapshots)) {
    const read=(kind === "historical" ? readInvestorDataSnapshot:readInvestorMonitorPriceSnapshot)(f.db,"w",value.document,LATER);
    assert.equal(read.dataset,null);assert.equal(read.unavailable_reason,"REFERENCE_SOURCE_NO_LONGER_CURRENT");
  }
  const ref=f.db.prepare("SELECT r.id review_id,r.content_hash review_hash,r.source_id,s.content_hash source_hash FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id WHERE r.id=?").get(f.metadata.base_review_id) as Obj;
  assert.equal(readInvestorSourceReview(f.db,"w",ref,LATER).facts.range_end,"2026-09-30");
});
