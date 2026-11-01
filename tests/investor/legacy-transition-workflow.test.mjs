import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(path.join(root,'web/package.json'));
const Ajv=require('ajv/dist/2020'),addFormats=require('ajv-formats'),ajv=new Ajv({strict:true,strictRequired:false});addFormats(ajv);
for(const name of fs.readdirSync(path.join(root,'contracts/v1')).filter(name=>name.endsWith('.schema.json')))
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(root,'contracts/v1',name),'utf8')));
const schema='https://etf-workbench.invalid/contracts/v1/investor-legacy-transition-workflow.schema.json';
let saved;
function fixture() {
  if(!saved){
    const result=spawnSync(process.env.WORKBENCH_TEST_PYTHON||'python3',['-m','tests.investor.test_legacy_transition_workflow','--contract'],
      {cwd:root,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
    assert.equal(result.status,0,result.stderr);saved=JSON.parse(result.stdout);
  }
  return structuredClone(saved);
}

test('independent closed schemas validate real fictional workflow output, not hand-written confirmation examples',()=>{
  const f=fixture();for(const kind of ['preview_request','preview','submit','confirmation'])
    assert.equal(ajv.getSchema(schema+'#/$defs/'+kind)(f[kind]),true,kind);
  assert.equal(f.confirmation.research_admitted,false);assert.equal(f.confirmation.monitoring_activated,false);
  assert.equal(f.confirmation.monitor_data_readmission_required,true);
});

test('every affirmative acknowledgement and the complete expected witness hash are mandatory',()=>{
  const validate=ajv.getSchema(schema+'#/$defs/submit');
  for(const key of Object.keys(fixture().submit.acknowledgements)){
    for(const mode of ['missing','false']){const value=fixture().submit;if(mode==='missing')delete value.acknowledgements[key];else value.acknowledgements[key]=false;
      assert.equal(validate(value),false,key+':'+mode);}
  }
  const value=fixture().submit;delete value.expected_preview_hash;assert.equal(validate(value),false);
});

test('metadata-only consent cannot claim admission, trading, current prices or a reset principal',()=>{
  const validate=ajv.getSchema(schema+'#/$defs/confirmation');
  for(const [key,value] of [['research_admitted',true],['monitoring_activated',true],['trading_permission',true],['raw_ai_sharing',true],
    ['provider_calls',1],['quotes',[]],['model_nav_cny','1'],['principal','1']]){
    const doc=fixture().confirmation;doc[key]=value;assert.equal(validate(doc),false,key);
  }
});
