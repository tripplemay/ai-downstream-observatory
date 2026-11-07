import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { hash } from "../src/server/ledger/service";
import { blankCorrectionDrafts, buildCorrectionAttempt, parseCorrectionResponse } from "../src/components/workbench/investor-correction-impact-client";
import { correctionView, correctionResponse, filledCorrectionDrafts, readyCorrectionResponse } from "./correction-impact-client-fixture";
import { reviewAt, reviewNow, reviewBinding } from "./action-review-client-fixture";

Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
const scope={workspace:"w",binding:reviewBinding,model:"fictional-model",preview:correctionView().preview.preview_id};
test("hypotheses start blank and require distinct per-date choices, explicit tax/time and separate consent; source gross is not sent",()=>{
  const view=correctionView(),blank=blankCorrectionDrafts(view);
  assert.equal(blank[0].choice,"");assert.equal(blank[0].tax,"");assert.equal(blank[0].ratio_ack,false);
  assert.throws(()=>buildCorrectionAttempt(view,scope.model,blank,true,"fictional",reviewNow));
  const filled=filledCorrectionDrafts();assert.throws(()=>buildCorrectionAttempt(view,scope.model,filled,false,"fictional",reviewNow));
  for(const field of ["tax","dividend_at","pay_at","reason"] as const){const bad=structuredClone(filled);bad[0][field]="";assert.throws(()=>buildCorrectionAttempt(view,scope.model,bad,true,"fictional",reviewNow));}
  const attempt=buildCorrectionAttempt(view,scope.model,filled,true,"fictional-impact",reviewNow);
  assert.equal(attempt.intent.acknowledgements.hypothetical_only,true);assert.doesNotMatch(attempt.body,/gross_per_unit|prices|quotes|enable_rule|no_historical_restatement/);
  const unknown=filled.map(row=>({...row,choice:"cancel" as const}));assert.throws(()=>buildCorrectionAttempt(view,scope.model,unknown,true,"fictional",reviewNow));
  const duplicate=[...filled,...filled];assert.throws(()=>buildCorrectionAttempt(view,scope.model,duplicate,true,"fictional",reviewNow));
  assert.throws(()=>buildCorrectionAttempt(view,scope.model,filled,true,"fictional",Date.parse(view.preview.valid_until)));
});
test("responses bind session, model, witness, nonce, submitted intent and derived summary without reusable consent",async()=>{
  const attempt=buildCorrectionAttempt(correctionView(),scope.model,filledCorrectionDrafts(),true,"fictional-impact",reviewNow);
  const ready=readyCorrectionResponse({lookup_nonce:attempt.nonce});
  assert.equal(ready.request!.intent_hash,hash(attempt.intent));assert.equal((await parseCorrectionResponse(ready,scope,attempt,reviewNow)).summary!.difference_cny,"2.5");
  for(const change of [{session_binding:"b".repeat(64)},{workspace_id:"other"},{lookup_nonce:"wrong"},{summary_hash:"0".repeat(64)},
    {request:{...ready.request!,model_id:"other"}},{request:{...ready.request!,preview_id:"other"}},{request:{...ready.request!,intent_hash:"0".repeat(64)}}])
    await assert.rejects(()=>parseCorrectionResponse({...ready,...change},scope,attempt,reviewNow));
  await assert.rejects(()=>parseCorrectionResponse(correctionResponse({request:null,lookup_nonce:"wrong"}),scope,attempt,reviewNow));
  const altered=structuredClone(ready);altered.summary!.difference_cny="9999";await assert.rejects(()=>parseCorrectionResponse(altered,scope,attempt,reviewNow));
  const expired=structuredClone(ready);expired.summary!.valid_until=reviewAt;expired.summary_hash=hash(expired.summary);
  await assert.rejects(()=>parseCorrectionResponse(expired,scope,attempt,reviewNow));
});
