import assert from "node:assert/strict";
import test from "node:test";
import { ExactJsonNumber } from "../src/server/exact-json";
import { eodhdActionWindow, issuerDistributionUrl, replayEodhdActionDraft } from "../src/server/investor/action-source-parsers";

const retrieved_at="2026-11-01T05:00:03.000Z",parameters={symbol:"VT.US",retrieved_at,...eodhdActionWindow(retrieved_at)};
test("exact numeric constructors reject every trailing line break rather than accepting a prefix",()=>{
  for(const suffix of ["\n","\r","\r\n","\u2028","\u2029"])
    assert.throws(()=>new ExactJsonNumber("1"+suffix));
});
test("issuer fund identifiers require a full four-character match",()=>{
  for(const suffix of ["\n","\r","\r\n","\u2028","\u2029"])
    assert.throws(()=>issuerDistributionUrl("3141"+suffix,false));
});
test("currency codes cannot smuggle a line ending through JavaScript dollar anchors",()=>{
  for(const suffix of ["\n","\r","\r\n","\u2028","\u2029"])
    assert.throws(()=>replayEodhdActionDraft(Buffer.from(JSON.stringify([{date:"2026-09-25",value:1,unadjustedValue:1,currency:"USD"+suffix}])),{...parameters,kind:"div"}));
});
test("split ratio strings must match completely, not just a valid prefix before a line ending",()=>{
  for(const suffix of ["\n","\r","\r\n","\u2028","\u2029"])
    assert.throws(()=>replayEodhdActionDraft(Buffer.from(JSON.stringify([{date:"2026-09-25",split:"2/1"+suffix}])),{...parameters,kind:"splits"}));
});
