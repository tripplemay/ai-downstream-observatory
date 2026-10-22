import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const require=createRequire(new URL('../../web/package.json',import.meta.url));
const Ajv=require('ajv/dist/2020').default,formats=require('ajv-formats').default,ajv=new Ajv({strict:true,strictRequired:false});formats(ajv);
const dir=new URL('../../contracts/v1/',import.meta.url);
for(const name of readdirSync(dir).filter(name=>name.endsWith('.schema.json')))ajv.addSchema(JSON.parse(readFileSync(new URL(name,dir),'utf8')));
const id='https://etf-workbench.invalid/contracts/v1/bounded-cash-journal.schema.json';
const child=spawnSync(process.env.WORKBENCH_TEST_PYTHON??process.env.WORKBENCH_PYTHON??'python3',['-c',
 "import json; from tests.execution_sandbox.journal_fixtures import scenario; from worker.execution_sandbox.journal import replay_journal; f=scenario(); print(json.dumps({'journal':f['journal'],'declaration':f['declaration'],'command':f['commands'][0],'event':f['journal']['events'][0],'state':replay_journal(f['journal'])}))"],
 {cwd:new URL('../../',import.meta.url),encoding:'utf8',maxBuffer:1024*1024,timeout:30000});
assert.equal(child.status,0,child.stderr);const documents=JSON.parse(child.stdout);

test('synthetic declaration, command, event, journal and state share strict closed contracts',()=>{
 for(const [kind,value] of Object.entries(documents)) {
  const validate=ajv.getSchema(id+'#/$defs/'+kind);assert.equal(validate(value),true,kind);
  assert.equal(validate({...value,execution_authorized:true}),false);assert.equal(validate({...value,actual_holdings_linked:true}),false);
 }
 assert.equal(ajv.getSchema(id)(documents.journal),true);
});
test('declarations cannot pretend independent registration, real data or live advice',()=>{
 const validate=ajv.getSchema(id+'#/$defs/declaration');
 for(const change of [{parameters_independently_preregistered:true},{live_advice_eligible:true},{qualification:'owner_reviewed_reconstructed'},
  {policy:{...documents.declaration.policy,currency:'USD'}}]) assert.equal(validate({...documents.declaration,...change}),false);
});
test('event payload kind cannot be swapped, cash cannot be floated, and histories are bounded',()=>{
 const command=ajv.getSchema(id+'#/$defs/command');
 assert.equal(command({...documents.command,kind:'buy_resolution'}),false);
 assert.equal(command({...documents.command,payload:{...documents.command.payload,amount_cny:2204}}),false);
 assert.equal(command({...documents.command,payload:{...documents.command.payload,expected_arrival:true}}),false);
 assert.equal(ajv.getSchema(id)({...documents.journal,events:Array(513).fill(documents.event)}),false);
});
test('the original kernel union never routes journal registration or state into production research',()=>{
 const validate=ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-kernel-request.schema.json');
 for(const action of ['cash_journal','research','monitor']) assert.equal(validate({action,...documents.journal}),false);
});
