import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const require=createRequire(new URL('../../web/package.json',import.meta.url)),Ajv=require('ajv/dist/2020'),formats=require('ajv-formats');
test('first-close request is closed, reference-bound, non-trading and cannot impersonate a seeded monitor',()=>{
 const ajv=new Ajv({strict:true,strictRequired:false});formats(ajv);
 for(const name of ['investor-confirmed-feed.schema.json','investor-initial-close.schema.json'])ajv.addSchema(JSON.parse(readFileSync(new URL('../../contracts/v1/'+name,import.meta.url))));
 const validate=ajv.getSchema('investor-initial-close.schema.json#/$defs/request'),request={schema_version:'investor-initial-close-request-v1',engine_version:'investor-initial-close-producer-v1',
  workspace_id:'fictional-w',model_id:'fictional-m',model_hash:'a'.repeat(64),control_id:'fictional-c',reference_input_id:'fictional-reference',reference_input_hash:'b'.repeat(64),market:'CN',session_date:'2026-01-04',
  targets:[{rights_review_id:'r',listing_review_id:'l',calendar_review_id:'c',session_date:'2026-01-04'}],binding_hash:'c'.repeat(64),not_before:'2026-01-04T06:58:00Z',
  latest_start:'2026-01-04T06:59:30Z',stop_at:'2026-01-04T07:03:00Z',valid_until:'2026-01-05T00:00:00Z',live_advice_eligible:false};
 assert.equal(validate(request),true);
 for(const patch of [{live_advice_eligible:true},{input_id:'invented-monitor'},{targets:[{...request.targets[0],price:'1'}]},{source_url:'https://fictional.invalid'},
  {reference_input_hash:'no-hash'},{schema_version:'investor-confirmed-feed-request-v1'},{targets:[]}])assert.equal(validate({...request,...patch}),false);
});
