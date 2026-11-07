import assert from "node:assert/strict";
import test from "node:test";
import { hash } from "../src/server/ledger/service";
import { actionReviewAcknowledgements } from "../src/server/investor/action-review-schemas";
import { actionReviewAttempt, actionReviewErrorText, blankActionReviewDrafts, buildActionReviewConfirmation, parseActionReviewResponse, readActionReviewJson } from "../src/components/workbench/investor-action-review-client";
import { filledReviewDrafts, reviewAt, reviewBinding as binding, reviewIntent, reviewNow as now, reviewResponse, reviewView } from "./action-review-client-fixture";

test("all research assumptions start blank; only explicit tax, UTC instants, consent and separate enable choice enter the exact closed intent",()=>{
  const view=reviewView(),blank=blankActionReviewDrafts(view);
  assert.deepEqual(blank,[{type:"dividend",date:"2026-11-02",at:"",pay_at:"",tax_per_unit:""}]);
  assert.throws(()=>buildActionReviewConfirmation(view,blank,true,false,"fictional-confirm",now),/TIME_REQUIRED/);
  assert.throws(()=>buildActionReviewConfirmation(view,filledReviewDrafts(),false,false,"fictional-confirm",now),/ACK_REQUIRED/);
  const intent=buildActionReviewConfirmation(view,filledReviewDrafts(),true,false,"fictional-confirm",now);
  assert.equal(intent.body.enable_rule,false);assert.deepEqual(intent.body.new_events,[{type:"dividend",date:"2026-11-02",at:"2026-11-02T14:30:00Z",pay_at:"2026-11-09T21:00:00Z",tax_per_unit:"0.432109"}]);
  assert.deepEqual(intent.body.acknowledgements,Object.fromEntries(actionReviewAcknowledgements.map(key=>[key,true])));
  assert.equal(buildActionReviewConfirmation(view,filledReviewDrafts(),true,true,"fictional-confirm",now).body.enable_rule,true);
  assert.doesNotMatch(JSON.stringify(intent),/gross_per_unit|unchanged private|distribution_amount|authority_id/);
});
test("tax never defaults to zero and cannot exceed exact issuer gross; dates must map to the reported New York dates",()=>{
  for(const tax of ["","-1","4.321090000000000001","1e-2","01","NaN"]) {
    const drafts=filledReviewDrafts();drafts[0].tax_per_unit=tax;
    assert.throws(()=>buildActionReviewConfirmation(reviewView(),drafts,true,false,"fictional",now),/TAX_REQUIRED/);
  }
  for(const tax of ["0","4.32109"]) {const drafts=filledReviewDrafts();drafts[0].tax_per_unit=tax;
    assert.equal(buildActionReviewConfirmation(reviewView(),drafts,true,false,"fictional",now).body.new_events[0].type,"dividend");}
  for(const changes of [{at:"2026-11-02T00:00"},{pay_at:"2026-11-09T00:00"},{at:""},{pay_at:""}]) {
    const drafts=filledReviewDrafts();Object.assign(drafts[0],changes);
    assert.throws(()=>buildActionReviewConfirmation(reviewView(),drafts,true,false,"fictional",now),/TIME_REQUIRED/);
  }
});
test("missing, duplicate, foreign events, historical corrections and original expiry cannot become ordinary confirmation",()=>{
  const drafts=filledReviewDrafts(),view=reviewView();
  for(const rows of [[],[...drafts,...drafts],[{...drafts[0],date:"2026-11-01"}]])assert.throws(()=>buildActionReviewConfirmation(view,rows,true,false,"fictional",now),/EVENTS_CHANGED/);
  assert.throws(()=>buildActionReviewConfirmation({...view,confirmation_supported:false},drafts,true,false,"fictional",now),/ACK_REQUIRED/);
  assert.throws(()=>buildActionReviewConfirmation(view,drafts,true,false,"fictional",Date.parse(view.refresh_after)),/VIEW_STALE/);
  assert.throws(()=>buildActionReviewConfirmation({...view,refresh_after:"2026-11-03T07:00:00Z"},drafts,true,false,"fictional",Date.parse(view.preview.valid_until)),/VIEW_STALE/);
});
test("private response requires exact session, workspace, immutable intent and original witness hash rather than ready metadata alone",async()=>{
  const attempt=actionReviewAttempt(reviewIntent,binding,"w"),response=reviewResponse({lookup_nonce:attempt.nonce});
  assert.equal((await parseActionReviewResponse(response,binding,"w",now,attempt)).view!.preview.valid_until,response.view!.preview.valid_until);
  const changes=[{session_binding:"2".repeat(64)},{workspace_id:"other"},{lookup_nonce:"other"},
    {request:{...response.request!,intent_hash:"3".repeat(64)}},{request:{...response.request!,resource_hash:"4".repeat(64)}},
    {workspace_revision:2},{refresh_after:reviewAt},{view:{...response.view!,status:"historical_correction_required" as const}}];
  for(const change of changes)await assert.rejects(parseActionReviewResponse({...response,...change},binding,"w",now,attempt));
  const noFacts=reviewResponse({view:null,preview_error:"ACTION_REVIEW_VIEW_UNAVAILABLE"});
  assert.equal((await parseActionReviewResponse(noFacts,binding,"w",now)).view,null);
  const empty=reviewResponse({request:null,view:null,lookup_nonce:attempt.nonce});
  assert.equal((await parseActionReviewResponse(empty,binding,"w",now,attempt)).request,null);
  assert.equal(response.request!.intent_hash,hash(JSON.parse(attempt.body)));
});
test("client JSON transport is bounded fatal UTF8 and duplicate-key strict, with nonblocking oversize cancellation and fixed error text",async()=>{
  assert.deepEqual(await readActionReviewJson(new Response('{"ok":true}')),{ok:true});
  for(const response of [new Response('{"ok":true,"ok":false}'),new Response(new Uint8Array([255]))])await assert.rejects(readActionReviewJson(response));
  let cancelled=false;const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(4194305));},cancel(){cancelled=true;return new Promise<void>(()=>{});}});
  await assert.rejects(readActionReviewJson(new Response(stream)),/RESPONSE_INVALID/);assert.equal(cancelled,true);
  assert.doesNotMatch(actionReviewErrorText(new Error("SYNTHETIC_PRIVATE_VALUE")),/SYNTHETIC_PRIVATE_VALUE/);
});
