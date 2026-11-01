import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import test from "node:test";
import { actionMaintenanceFixture, LATER, probeActionMutation, resealActionRow } from "./action-maintenance-fixture";
import { readManagedActionHeader, readManagedActionReview } from "../src/server/investor/managed-action-source";
import { hash } from "../src/server/ledger/service";

type Obj=Record<string,unknown>;
function created(db:Database.Database,table:string,id:string,at:string,documentHasTime:boolean) {
  resealActionRow(db,table,id,doc=>{if(documentHasTime)doc.created_at=at;},{created_at:at});
  const row=db.prepare(`SELECT audit_id FROM ${table} WHERE id=?`).get(id) as {audit_id:string};
  db.prepare("UPDATE audit_events SET created_at=? WHERE id=?").run(at,row.audit_id);
}
test("a re-sealed rule cannot be registered before its immutable anchor existed",t=>{
  const f=actionMaintenanceFixture(t),id=(f.metadata.publications as Obj[])[0].publication_id as string;
  probeActionMutation(f.db,["investor_action_authorities","audit_events"],()=>{
    created(f.db,"investor_action_authorities",f.metadata.authority_id as string,"2026-11-01T05:00:02.000Z",false);
  },()=>assert.throws(()=>readManagedActionReview(f.db,"w",id,LATER)));
});
test("a re-sealed publication cannot use evidence captured after its claimed creation time",t=>{
  const f=actionMaintenanceFixture(t),id=(f.metadata.publications as Obj[])[1].publication_id as string;
  const row=f.db.prepare("SELECT * FROM investor_action_publications WHERE id=?").get(id) as Obj,early="2026-11-02T06:00:02.000Z";
  probeActionMutation(f.db,["investor_action_requests","investor_action_publications","investor_data_sources","audit_events"],()=>{
    created(f.db,"investor_action_requests",row.request_id as string,early,true);
    const request=f.db.prepare("SELECT content_hash FROM investor_action_requests WHERE id=?").get(row.request_id) as {content_hash:string};
    resealActionRow(f.db,"investor_action_publications",id,doc=>{doc.request_hash=request.content_hash;});
    created(f.db,"investor_action_publications",id,early,true);created(f.db,"investor_data_sources",row.source_id as string,early,false);
  },()=>assert.throws(()=>readManagedActionReview(f.db,"w",id,LATER)));
});
test("a self-consistent delayed publication cannot cross the fixed intent deadline",t=>{
  const f=actionMaintenanceFixture(t),id=(f.metadata.publications as Obj[])[0].publication_id as string;
  const row=f.db.prepare("SELECT * FROM investor_action_publications WHERE id=?").get(id) as Obj,late="2026-11-02T05:00:00.000Z";
  probeActionMutation(f.db,["investor_action_publications","investor_data_sources","audit_events"],()=>{
    created(f.db,"investor_action_publications",id,late,true);created(f.db,"investor_data_sources",row.source_id as string,late,false);
  },()=>assert.throws(()=>readManagedActionReview(f.db,"w",id,LATER)));
});
test("a published virtual header must advance beyond the prior published coverage",t=>{
  const f=actionMaintenanceFixture(t),id=(f.metadata.publications as Obj[])[1].publication_id as string;
  const review=JSON.parse(readManagedActionHeader(f.db,"w",id,LATER).row.document_json) as Obj;
  (review.facts as Obj).range_end="2026-10-31";
  probeActionMutation(f.db,["investor_action_publications","audit_events"],()=>{
    resealActionRow(f.db,"investor_action_publications",id,doc=>{
      doc.coverage_end="2026-10-31";doc.candidate_facts_hash=hash(review.facts);doc.review_hash=hash(review);
    },{coverage_end:"2026-10-31",review_hash:hash(review)});
  },()=>assert.throws(()=>readManagedActionHeader(f.db,"w",id,LATER)));
});
