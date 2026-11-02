import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const Ajv = require('ajv/dist/2020'), ajv = new Ajv({ strict: true, strictRequired: false });
require('ajv-formats')(ajv);
for (const name of readdirSync(new URL('../../contracts/v1', import.meta.url)).filter(name => name.endsWith('.schema.json')))
  ajv.addSchema(JSON.parse(readFileSync(new URL('../../contracts/v1/' + name, import.meta.url), 'utf8')));
const schema = 'https://etf-workbench.invalid/contracts/v1/investor-action-correction-impact.schema.json';
const valid = ajv.getSchema(schema + '#/$defs/request');
const request = () => ({schema_version:'investor-action-correction-impact-request-v1',model_id:'fictional-model',preview_id:'fictional-preview',
  expected_revision:1,idempotency_key:'fictional-impact',acknowledgements:Object.fromEntries([
    'hypothetical_only','source_differences_seen','explicit_time_and_tax','original_reported_coverage_only','unchanged_tax_assumption'].map(key=>[key,true])),
  decisions:[{date:'2026-11-05',choice:'replace',reason:'Fictional issuer correction, not approval',events:[{
    type:'dividend',at:'2026-11-05T14:30:00Z',pay_at:'2026-11-09T21:00:00.000Z',tax_per_unit:'0.432109'}]}]});

test('closed hypothetical correction answers require separate consent language and explicit times and taxes, never caller prices or gross amounts',()=>{
  assert.equal(valid(request()),true,JSON.stringify(valid.errors));
  for(const choice of ['retain','cancel']){const value=request();Object.assign(value.decisions[0],{choice,events:[]});assert.equal(valid(value),true);}
  for(const key of Object.keys(request().acknowledgements)){
    const value=request();delete value.acknowledgements[key];assert.equal(valid(value),false);
    value.acknowledgements[key]=false;assert.equal(valid(value),false);
  }
  for(const field of ['at','pay_at','tax_per_unit']){const value=request();delete value.decisions[0].events[0][field];assert.equal(valid(value),false);}
  for(const field of ['gross_per_unit','currency','published_at','known_at','ratio']){
    const value=request();value.decisions[0].events[0][field]='1';assert.equal(valid(value),false);
  }
  const old=request();old.acknowledgements={no_historical_restatement:true};assert.equal(valid(old),false);
  const precision=request();precision.decisions[0].events[0].at='2026-11-05T14:30:00.000001Z';assert.equal(valid(precision),false);
});

test('new contract cannot be mistaken for a submitted correction, source qualification, current valuation or trading approval',()=>{
  for(const field of ['enable_rule','tax_assumption','prices','original_actions','corrected_actions','expected_head','valid_until','trading_permission']){
    const value=request();value[field]=true;assert.equal(valid(value),false);
  }
  const value=request();value.decisions[0].choice='replace';value.decisions[0].events=[];assert.equal(valid(value),false);
  value.decisions[0].choice='retain';assert.equal(valid(value),true);
  value.decisions[0].events=[{type:'split',at:'2026-11-05T14:00:00Z'}];assert.equal(valid(value),false);
  value.decisions[0].choice='replace';assert.equal(valid(value),false);
  value.decisions[0].events[0].ratio_direction='provider_numerator_new_units_per_denominator_old_unit_assumed';assert.equal(valid(value),true);
  assert.equal(ajv.getSchema(schema+'#/$defs/result')({schema_version:'investor-action-correction-impact-result-v1'}),false);
});
