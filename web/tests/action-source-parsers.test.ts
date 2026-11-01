import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { actionDeadline, actionNyParts, eodhdActionWindow, replayEodhdActionDraft, replayIssuerActionDraft } from "../src/server/investor/action-source-parsers";

const at = "2026-11-01T05:00:03.123456Z";
const issuer = { fund_id:"3141", has_distribution_yield:false, retrieved_at:at, start_date:"2025-11-02", end_date:"2026-11-01" };
const eod = { kind:"div", symbol:"VT.US", retrieved_at:at, ...eodhdActionWindow(at) };
const row = '{"amount":0.123456789123456789,"exDividendDate":"2026-09-25","recordDate":"2026-09-25","payableDate":"2026-09-30","reinvestDate":"not inferred","reinvestPrice":null,"typeCode":"INC"}';
const dividend = '{"date":"2026-09-25","value":0.123456789123456788,"unadjustedValue":0.123456789123456789,"currency":"USD","recordDate":"2026-09-25","paymentDate":"2026-09-30","period":"fictional"}';
type Fixture = { kind:"issuer"|"eodhd"; raw:string; parameters:Record<string,unknown> };
function replay(value: Fixture) { return value.kind === "issuer" ? replayIssuerActionDraft(Buffer.from(value.raw),value.parameters) : replayEodhdActionDraft(Buffer.from(value.raw),value.parameters); }
function python(cases:Fixture[]) {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3",["-c",`
import json,sys
from worker.market.providers.vanguard_distributions import parse_vanguard_distributions
from worker.market.providers.eodhd_actions import parse_eodhd_actions
def evaluate(case):
 try:
  fn=parse_vanguard_distributions if case['kind']=='issuer' else parse_eodhd_actions
  return fn(case['raw'].encode(),**case['parameters'])
 except Exception:return None
print(json.dumps([evaluate(case) for case in json.load(sys.stdin)]))
`],{cwd:new URL("../../",import.meta.url),input:JSON.stringify(cases),encoding:"utf8",timeout:10000,env:{PATH:process.env.PATH,NODE_ENV:"test"}});
  assert.equal(child.status,0,child.stderr); return JSON.parse(child.stdout) as unknown[];
}

test("independent exact issuer and EODHD parsers reproduce complete fictional Python drafts",()=>{
  const cases:Fixture[] = [
    {kind:"issuer",raw:"["+row+"]",parameters:issuer},
    {kind:"issuer",raw:"\ufeff["+row+","+row.replace('"INC"','"CGLT"').replace("0.123456789123456789","1.234e-10")+"]",parameters:{...issuer,has_distribution_yield:true}},
    {kind:"issuer",raw:"["+row.replace(/2026-/g,"2010-")+","+row+"]",parameters:issuer},
    {kind:"eodhd",raw:"["+dividend+"]",parameters:eod},
    {kind:"eodhd",raw:'[{"date":"2026-09-25","value":-0,"unadjustedValue":1e-18,"currency":"USD"}]',parameters:eod},
    {kind:"eodhd",raw:'[{"date":"2026-09-26","split":"0002.000/01"},{"date":"2026-09-25","split":"3/2"}]',parameters:{...eod,kind:"splits"}},
    {kind:"eodhd",raw:"[]",parameters:{...eod,kind:"splits",symbol:"BND.US"}},
  ];
  const expected = python(cases); cases.forEach((value,index)=>{assert.notEqual(expected[index],null);assert.deepEqual(replay(value),expected[index]);});
});

test("both parsers reject fictional ambiguous, rounded, malformed or enlarged inputs rather than repairing them",()=>{
  const cases:Fixture[] = [
    ...["[]","["+row+","+row+"]","["+row.replace('"INC"','"OTHER"')+"]","["+row.replace("0.123456789123456789","1e9999")+"]",
      "["+row.replace("0.123456789123456789","1.2300000000000000000")+"]","["+row.replace('"amount":', '"amount":1,"amount":')+"]",
      "["+row.replace('"typeCode"','"unexpected":true,"typeCode"')+"]"].map(raw=>({kind:"issuer" as const,raw,parameters:issuer})),
    ...["\ufeff[]","["+dividend.replace("USD","US")+"]","["+dividend+","+dividend+"]",
      "["+dividend.replace("2026-09-25","2026-02-30")+"]","["+dividend.replace('"value":0.123456789123456788','"value":"0.123"')+"]",
      "["+dividend.replace('"period":"fictional"','"period":"bad\\nline"')+"]",
      "["+dividend.replace('"value":0.123456789123456788','"value":-0.01')+"]"].map(raw=>({kind:"eodhd" as const,raw,parameters:eod})),
    {kind:"eodhd",raw:'[{"date":"2026-09-25","split":"2/0"}]',parameters:{...eod,kind:"splits"}},
  ];
  const expected=python(cases);cases.forEach((value,index)=>{assert.equal(expected[index],null);assert.throws(()=>replay(value));});
});

test("date windows bind New York cutoff and both repeated DST hours to the same day",()=>{
  assert.deepEqual(eodhdActionWindow(at),{start_date:"2025-11-01",end_date:"2026-10-31"});
  assert.equal(actionNyParts(at).hour,1);assert.equal(actionNyParts("2026-11-01T06:00:03.000Z").hour,1);
  assert.equal(actionDeadline(at,"2027-01-01T00:00:00.000Z"),"2026-11-02T05:00:00.000Z");
  assert.equal(actionDeadline("2026-03-08T06:00:00Z","2027-01-01T00:00:00Z"),"2026-03-09T04:00:00.000Z");
  assert.throws(()=>replayEodhdActionDraft(Buffer.from("[]"),{...eod,end_date:"2026-11-01"}));
  assert.throws(()=>replayIssuerActionDraft(Buffer.from("["+row+"]"),{...issuer,end_date:"2026-11-02"}));
});

test("pure parser boundaries reject invalid UTF8, excessive bytes and do not turn empty splits into absence proof",()=>{
  assert.throws(()=>replayIssuerActionDraft(Buffer.from([0xff]),issuer));
  assert.throws(()=>replayEodhdActionDraft(Buffer.alloc(262145,32),eod));
  assert.throws(()=>replayIssuerActionDraft(Buffer.alloc(1048577,32),issuer));
  const empty=replayEodhdActionDraft(Buffer.from("[]"),{...eod,kind:"splits"});
  assert.equal(empty.empty_is_not_absence_proof,true);assert.equal(empty.corporate_actions_complete,false);assert.equal(empty.research_admitted,false);
});
