import assert from "node:assert/strict";
import test from "node:test";
import { actionMaintenanceFixture, actionPython, LATER, probeActionMutation, resealActionRow } from "./action-maintenance-fixture";
import { readActionCaptureHeader, replayActionSourceCapture } from "../src/server/investor/action-source-proof";
import type { ActionSourceKind } from "../src/server/investor/action-source-proof";

type Capture={id:string;kind:ActionSourceKind;draft:unknown;binding:unknown};
test("independent Node replays eleven fictional manual/scheduled issuer and EODHD captures exactly with zero writes",t=>{
  const f=actionMaintenanceFixture(t),changes=()=>f.db.prepare('SELECT total_changes() n').get() as {n:number},before=changes();
  for(const capture of f.metadata.captures as Capture[]) {
    const value=replayActionSourceCapture(f.db,"w",capture.id,capture.kind,LATER);
    assert.deepEqual(value.draft,capture.draft);assert.deepEqual(value.binding,capture.binding);
  }
  assert.deepEqual(changes(),before);
});

test("ordinary source proof rejects injected captures and foreign workspace",t=>{
  const f=actionMaintenanceFixture(t,false);
  for(const capture of f.metadata.captures as Capture[]) {
    assert.throws(()=>replayActionSourceCapture(f.db,"w",capture.id,capture.kind,LATER));
    assert.throws(()=>readActionCaptureHeader(f.db,"foreign",capture.id,capture.kind,LATER));
  }
});

test("corrupt bytes and resealed fixed-route transport changes cannot be accepted",t=>{
  const f=actionMaintenanceFixture(t),captures=f.metadata.captures as Capture[];
  for(const kind of ["issuer","eodhd"] as const) {
    const capture=captures.find(row=>row.kind === kind)!;
    const prefix="investor_"+kind,row=f.db.prepare(`SELECT * FROM ${prefix}_captures WHERE id=?`).get(capture.id) as Record<string,unknown>;
    probeActionMutation(f.db,[prefix+"_payloads"],()=>{
      const original=f.db.prepare(`SELECT payload FROM ${prefix}_payloads WHERE raw_sha256=?`).get(row.raw_sha256) as {payload:Buffer};
      const corrupt=Buffer.from(original.payload);corrupt[0]^=1;
      f.db.prepare(`UPDATE ${prefix}_payloads SET payload=? WHERE raw_sha256=?`).run(corrupt,row.raw_sha256);
    },()=>assert.throws(()=>replayActionSourceCapture(f.db,"w",capture.id,kind,LATER)));
    probeActionMutation(f.db,[prefix+"_captures","audit_events"],()=>{
      resealActionRow(f.db,prefix+"_captures",capture.id,doc=>{
        const transport=doc.transport as Record<string,unknown>;
        transport[kind === "issuer" ? "source_url":"url_without_credentials"]="https://fictional.invalid/wrong";
      });
    },()=>assert.throws(()=>replayActionSourceCapture(f.db,"w",capture.id,kind,LATER)));
  }
});

test("a resealed EODHD success still needs its actual matching single-attempt job and fence",t=>{
  const f=actionMaintenanceFixture(t),capture=(f.metadata.captures as Capture[]).find(row=>row.kind === "eodhd")!;
  const row=f.db.prepare("SELECT * FROM investor_eodhd_captures WHERE id=?").get(capture.id) as Record<string,unknown>;
  for(const change of [{job_type:"fictional-unrelated"},{scope:"foreign"},{attempt_count:2},{status:"failed"}]) {
    probeActionMutation(f.db,["job_runs"],()=>{
      const [key,value]=Object.entries(change)[0];f.db.prepare(`UPDATE job_runs SET ${key}=? WHERE id=?`).run(value,row.job_id);
    },()=>assert.throws(()=>replayActionSourceCapture(f.db,"w",capture.id,"eodhd",LATER)));
  }
});

test("current source withdrawal prevents replay but leaves authenticated history metadata readable",t=>{
  const f=actionMaintenanceFixture(t),capture=(f.metadata.captures as Capture[]).find(row=>row.kind === "eodhd")!;
  actionPython(f.filename,`
from worker.investor import eodhd_sources as s
r=db.execute('SELECT authority_id FROM investor_eodhd_requests ORDER BY rowid LIMIT 1').fetchone()
s.set_authority_enabled(db,'w','synthetic-investor',r[0],False,now='${LATER}')
print('{}')
`);
  assert.equal(readActionCaptureHeader(f.db,"w",capture.id,"eodhd",LATER).grant.current.enabled,0);
  assert.throws(()=>replayActionSourceCapture(f.db,"w",capture.id,"eodhd",LATER));
});
