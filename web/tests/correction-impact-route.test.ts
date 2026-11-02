import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import test from "node:test";
import ts from "typescript";
import {NextResponse} from "next/server";
import {z} from "zod";
import {AuthError} from "../src/server/auth/core";
import {parseStrictJson} from "../src/server/strict-json";
import {investorId} from "../src/server/investor/schemas";
import {correctionImpactInputSchema} from "../src/server/investor/correction-impact-schemas";
import {buildCorrectionAttempt} from "../src/components/workbench/investor-correction-impact-client";
import {correctionView,correctionResponse,filledCorrectionDrafts} from "./correction-impact-client-fixture";
import {reviewNow,reviewBinding as binding} from "./action-review-client-fixture";

const input=buildCorrectionAttempt(correctionView(),"fictional-model",filledCorrectionDrafts(),true,"fictional-impact",reviewNow).intent;
const compiled=ts.transpileModule(readFileSync(new URL("../src/app/api/workbench/investor/correction-impact/route.ts",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function harness(options:{deny?:boolean;origin?:boolean;changeAt?:number;failure?:string}={}){
  const calls:string[]=[],args:unknown[][]=[];let count=0;
  const auth=async()=>{calls.push("auth");count++;if(options.deny)throw new AuthError("UNAUTHENTICATED",401);if(options.origin)throw new AuthError("ORIGIN_DENIED",403);
    return {userId:"fictional-owner",sessionId:options.changeAt&&count>=options.changeAt?"changed":"same"};};
  const imports:Record<string,unknown>={"next/server":{NextResponse},zod:{z},"@/server/auth/core":{AuthError},"@/server/auth/session":{requireApiSession:auth,requireMutationSession:auth},
    "@/server/auth/session-binding":{sessionBinding:()=>binding,assertRequestSessionBinding:(request:Request)=>{calls.push("bind");if(request.headers.get("X-Workbench-Session-Binding")!==binding)throw new AuthError("SESSION_CHANGED",401);}},
    "@/server/workbench-db":{openWorkbench:()=>{calls.push("open");return {close(){calls.push("close");}};}},"@/server/strict-json":{parseStrictJson},"@/server/investor/schemas":{investorId},
    "@/server/investor/correction-impact-schemas":{correctionImpactInputSchema},"@/server/investor/correction-impact-jobs":{
      enqueueCorrectionImpact:(...values:unknown[])=>{calls.push("enqueue");args.push(values);if(options.failure)throw new Error(options.failure);return {request_id:"fictional-job"};},
      readCorrectionImpactResponse:(...values:unknown[])=>{calls.push("read");args.push(values);if(options.failure)throw new Error(options.failure);return correctionResponse({request:null});}}};
  const module={exports:{} as {GET:(request:Request)=>Promise<Response>;POST:(request:Request)=>Promise<Response>}};
  runInNewContext(`(function(require,module,exports){${compiled}\n})`,{Error,Buffer,URL,TextDecoder})((name:string)=>{assert.ok(name in imports,name);return imports[name];},module,module.exports);
  return {...module.exports,calls,args};
}
const request=(raw:string|Uint8Array=JSON.stringify(input),method="POST",query="")=>new Request("https://fictional.example.test/api/workbench/investor/correction-impact"+query,
  {method,headers:{"Content-Type":"application/json","X-Workbench-Session-Binding":binding},...(method==="POST"?{body:typeof raw==="string"?raw:new Uint8Array(raw).buffer}:{})});

test("authentication, origin, binding and reauthentication precede enqueue; no private response follows a changed session",async()=>{
  for(const option of [{deny:true},{origin:true}]){const h=harness(option),r=request();assert.ok([401,403].includes((await h.POST(r)).status));assert.equal(r.bodyUsed,false);assert.equal(h.calls.includes("open"),false);}
  const missing=request();missing.headers.delete("X-Workbench-Session-Binding");assert.equal((await harness().POST(missing)).status,400);assert.equal(missing.bodyUsed,false);
  const early=harness({changeAt:2});assert.equal((await early.POST(request())).status,401);assert.equal(early.calls.includes("open"),false);
  const late=harness({changeAt:3});assert.equal((await late.POST(request())).status,401);assert.equal(late.calls.includes("enqueue"),true);assert.equal(late.calls.at(-1),"close");
});
test("GET is pure metadata/derived read; nonce miss cannot fall back and duplicate or multiple query selectors are rejected",async()=>{
  const h=harness(),response=await h.GET(request("","GET","?nonce=fictional-missing"));assert.equal(response.status,200);assert.equal(h.calls.includes("enqueue"),false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.args[0][3])),{nonce:"fictional-missing"});assert.equal(response.headers.get("cache-control"),"private, no-store");
  assert.equal(response.headers.get("vary"),"Cookie");assert.equal(response.headers.get("x-content-type-options"),"nosniff");
  for(const query of ["?request=a&nonce=b","?preview=a&request=b","?preview=a&preview=b","?actor_id=other"]){const bad=harness();assert.equal((await bad.GET(request("","GET",query))).status,400);assert.equal(bad.calls.includes("open"),false);}
});
test("strict bounded transport rejects duplicate JSON, caller facts, unknown body and invalid UTF8 without opening storage",async()=>{
  for(const raw of ['{"model_id":"a","model_id":"b"}',JSON.stringify({...input,gross_per_unit:"123"}),JSON.stringify({...input,actor_id:"other"}),new Uint8Array([255])]){
    const h=harness();assert.equal((await h.POST(request(raw))).status,400);assert.equal(h.calls.includes("open"),false);}
  let cancelled=false;const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(524289));},cancel(){cancelled=true;return new Promise<void>(()=>{});}});
  const huge=new Request("https://fictional.example.test/api/workbench/investor/correction-impact",{method:"POST",headers:{"Content-Type":"application/json","X-Workbench-Session-Binding":binding},body,duplex:"half"} as RequestInit);
  const h=harness(),response=await h.POST(huge);assert.equal(response.status,413);assert.equal(cancelled,true);assert.equal(h.calls.includes("open"),false);
});
test("intent is owner-bound; conflicts and read-only state are explicit while private internal errors remain opaque",async()=>{
  const h=harness(),response=await h.POST(request());assert.equal(response.status,200);assert.deepEqual(JSON.parse(JSON.stringify(h.args[0][1])),{id:"fictional-owner"});
  assert.deepEqual(JSON.parse(JSON.stringify(h.args[0][2])),input);assert.equal((await response.json()).lookup_nonce,input.idempotency_key);
  for(const [failure,status] of [["CORRECTION_IMPACT_BUSY",409],["CORRECTION_IMPACT_VERSION_CHANGED",409],["WORKBENCH_READ_ONLY",423],["SYNTHETIC_PRIVATE_SQL_MARKER",503]] as const){
    const output=await harness({failure}).POST(request());assert.equal(output.status,status);assert.deepEqual(await output.json(),{error:status===503?"CORRECTION_IMPACT_UNAVAILABLE":failure});}
});
