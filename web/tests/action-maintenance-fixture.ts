import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { canonical, hash } from "../src/server/ledger/service";

export const AT="2026-11-01T05:00:03.000Z",LATER="2026-11-02T06:00:03.000Z";
export function actionPython(filename:string,code:string,budget:"source"|"core_readmission"|"legacy_transition"="source") {
  assert.ok(budget==="source"||budget==="core_readmission"||budget==="legacy_transition","UNKNOWN_ACTION_FIXTURE_BUDGET");
  // Full retained-core replay includes research, callbacks and two checkpoints.
  // Keep ordinary source probes unchanged and never change a production deadline.
  const timeout=budget==="source"?30000:120000;
  const child=spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3",["-c",`
import json,socket,sys
from pathlib import Path
from worker.orchestration.db import open_database
def forbidden(*a,**k):raise AssertionError('OFFLINE_FIXTURE_NETWORK_FORBIDDEN')
socket.create_connection=forbidden;socket.getaddrinfo=forbidden
db=open_database(sys.argv[1])
try:
${code.split("\n").map(line=>" "+line).join("\n")}
finally:db.close()
`,filename],{cwd:new URL("../../",import.meta.url),encoding:"utf8",timeout,env:{PATH:process.env.PATH,NODE_ENV:"test"}});
  const failure=child.error as NodeJS.ErrnoException|undefined;
  assert.ok(!failure,`OFFLINE_ACTION_FIXTURE_${failure?.code??"SPAWN_FAILURE"} deadline_ms=${timeout}`);
  assert.equal(child.signal,null,"OFFLINE_ACTION_FIXTURE_INTERRUPTED");
  assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout) as Record<string,unknown>;
}
export function actionMaintenanceFixture(t:TestContext,official=true,withSnapshot=false) {
  const directory=mkdtempSync(path.join(tmpdir(),"fictional-action-proof-")),filename=path.join(directory,"workbench.db");
  t.after(()=>rmSync(directory,{recursive:true,force:true}));migrateWorkbench(filename);
  const metadata=actionPython(filename,`
from tests.investor.test_managed_actions import ManagedActionTests,AT,LATER
from worker.investor import issuer_sources,eodhd_sources,managed_actions
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,?)",(AT,))
case=ManagedActionTests();case.db=db;case.path=Path(sys.argv[1]);case.prepare(official=${official ? "True":"False"})
publications=[]
if ${official ? "True":"False"}:
 case.grant();publications+=managed_actions.publish_current_actions(db,now=AT)
 case.next_source_day();publications+=managed_actions.publish_current_actions(db,now=LATER)
captures=[]
for kind,module in (('issuer',issuer_sources),('eodhd',eodhd_sources)):
 for row in db.execute('SELECT * FROM investor_'+kind+'_captures ORDER BY created_at,id').fetchall():
  fn=module.resolve_issuer_capture if kind=='issuer' else module.resolve_eodhd_capture
  value=fn(db,'w','synthetic-investor',row['id'],now=LATER,allow_synthetic=True)
  request=db.execute('SELECT * FROM investor_'+kind+'_requests WHERE id=?',(row['request_id'],)).fetchone()
  grant,policy,control=module._grant(db,'w',request['authority_id'],LATER)
  from worker.investor.action_reconciliation import _binding
  captures.append({'kind':kind,'id':row['id'],'draft':value['draft'],'binding':_binding(value,grant,control)})
reviews=[managed_actions.resolve_managed_review(db,'w',p['publication_id'],now=LATER) for p in publications]
snapshots={}
if ${withSnapshot ? "True":"False"}:
 from datetime import datetime
 from decimal import Decimal
 from unittest.mock import patch
 from zoneinfo import ZoneInfo
 from worker.investor import data_evidence as evidence
 from worker.investor.data_snapshot import build_dataset,build_monitor_dataset
 from worker.market.providers import longport
 from worker.orchestration.db import instant,content_hash
 def reviewed(kind,facts):
  source=evidence.store_source(db,'w','synthetic-investor',kind,{'title':'Fictional '+kind,'reference':'synthetic://node-action/'+kind,'excerpt':'Offline software fixture only'},now=LATER)
  return evidence.review_source(db,'w','synthetic-investor',source['id'],'approved',facts,'Fictional only','2026-11-10T00:00:00.000Z',now=LATER)
 rights=reviewed('rights',{'provider':'longport','account_region':'HK','markets':['US'],'uses':['private_research','private_retention','private_display','private_backup'],
  'retention_days':30,'valid_from':'2026-01-01T00:00:00Z','valid_until':'2026-11-10T00:00:00.000Z','clause_references':['Fictional only']})
 day='2026-10-30'
 calendar=reviewed('calendar',{'market':'US','range_start':day,'range_end':day,'days':[{'date':day,'kind':'full','close_at':day+'T20:00:00Z','available_at':day+'T20:01:00Z',
  'settled_at':'2026-11-02T21:00:00Z','settlement_rule_known_at':'2026-01-01T00:00:00Z'}]})
 fx=reviewed('fx',{'currency':'USD','unit':'CNY_per_unit_currency','rows':[{'observed_at':day+'T20:00:00Z','assumed_available_at':day+'T20:01:00Z','value':'1.23'}]})
 mapping={'listing_id':'synthetic-3141','provider_symbol':'VT.US','market':'US','currency':'USD'}
 request=longport._request(mapping,day,day,[day])
 rows=[{'timestamp':datetime(2026,10,30,tzinfo=ZoneInfo('America/New_York')),'open':Decimal('10'),'high':Decimal('12'),'low':Decimal('9'),'close':Decimal('11.25'),
  'turnover':Decimal('11250'),'volume':1000,'trade_session':0}]
 projection=longport._normalize(rows,request=request,sdk_version='4.3.7',call_started_at=LATER,call_returned_at=LATER,
  datetime_basis='runtime_utc_from_unix_timestamp',collector_runtime='isolated_official_sdk')
 original_millis=evidence._milliseconds
 with patch.object(longport,'_collect_isolated',return_value=projection),patch.object(evidence,'_milliseconds',side_effect=lambda value=None:original_millis(LATER if value is None else value)), \
   patch.object(evidence,'instant',side_effect=lambda value=None:instant(LATER if value is None else value)):
  capture=evidence.collect_prices(db,'w','synthetic-investor',rights['id'],case.member['listing_review_id'],calendar['id'],day,day)
 from worker.investor import confirmed_capture as confirmed_store
 from worker.market.providers import longport_confirmed as confirmed_receiver
 from tests.investor.confirmed_capture_fixture import FictionalReceiver
 mock=FictionalReceiver(now=LATER)
 original_confirmed_millis,original_confirmed_instant=confirmed_store._milliseconds,confirmed_store.instant
 with patch.object(confirmed_receiver,'collect_confirmed_days',side_effect=lambda request,**kwargs:mock(request,kwargs['stop_requested'])), \
   patch.object(confirmed_store,'_milliseconds',side_effect=lambda value=None:original_confirmed_millis(LATER if value is None else value)), \
   patch.object(confirmed_store,'instant',side_effect=lambda value=None:original_confirmed_instant(LATER if value is None else value)):
  confirmed=confirmed_store.collect_confirmed_prices(db,'w','synthetic-investor',[{'rights_review_id':rights['id'],'listing_review_id':case.member['listing_review_id'],
   'calendar_review_id':calendar['id'],'session_date':day}],watch_seconds=1)
 for kind in ('historical','monitor'):
  args=(db,'w',[capture['id']],[publications[-1]['publication_id']],[fx['id']],day,day) if kind=='historical' else (db,'w',[],[confirmed['id']],[publications[-1]['publication_id']],[fx['id']],day,day)
  result=(build_dataset if kind=='historical' else build_monitor_dataset)(*args,now=LATER)
  snapshots[kind]={'expected':result,'document':{'snapshot':result['manifest'],'dataset_hash':result['dataset_hash'],'catalog_hash':content_hash(result['catalog']),
   'valid_until':result['valid_until'],'created_at':LATER}}
print(json.dumps({'captures':captures,'publications':publications,'reviews':reviews,'snapshots':snapshots,'base_review_id':case.base['id'],
 'listing_review_id':case.member['listing_review_id'],'authority_id':case.authority['id'] if publications else None,
 'facts':case.base_facts}))
`);
  const db=new Database(filename);db.pragma("foreign_keys=ON");t.after(()=>db.close());
  return {db,filename,metadata};
}
export function probeActionMutation(db:Database.Database,tables:string[],change:()=>void,verify:()=>void) {
  db.exec("SAVEPOINT fictional_mutation");
  try {
    for(const table of tables) {
      const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table) as {name:string}[];
      for(const {name} of triggers){assert.match(name,/^[A-Za-z0-9_]+$/);db.exec(`DROP TRIGGER ${name}`);}
    }
    change();verify();
  } finally {db.exec("ROLLBACK TO fictional_mutation; RELEASE fictional_mutation");}
}
export function resealActionRow(db:Database.Database,table:string,id:string,change:(doc:Record<string,unknown>)=>void,columns:Record<string,unknown>={}) {
  const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string,unknown>;
  const doc=JSON.parse(row.document_json as string) as Record<string,unknown>;change(doc);
  const digest=hash(doc),values={...columns,document_json:canonical(doc),content_hash:digest};
  const keys=Object.keys(values);db.prepare(`UPDATE ${table} SET ${keys.map(key=>key+"=?").join(",")} WHERE id=?`).run(...keys.map(key=>values[key as keyof typeof values]),id);
  db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(canonical({content_hash:digest}),row.audit_id);
}
