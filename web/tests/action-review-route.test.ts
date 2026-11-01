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
import {actionReviewInputSchema} from "../src/server/investor/action-review-schemas";
import {reviewBinding as binding,reviewIntent,reviewResponse} from "./action-review-client-fixture";

const compiled=ts.transpileModule(readFileSync(new URL("../src/app/api/workbench/investor/action-review/route.ts",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function harness(options:{deny?:boolean;origin?:boolean;changeAt?:number;failure?:string;found?:string}={}) {
  const calls:string[]=[],args:unknown[][]=[];let auth=0;
  const authenticate=async()=>{calls.push("auth");auth++;if(options.deny)throw new AuthError("UNAUTHENTICATED",401);
    if(options.origin)throw new AuthError("ORIGIN_DENIED",403);return {userId:"fictional-owner",sessionId:options.changeAt&&auth>=options.changeAt?"changed":"same"};};
  const dependencies:Record<string,unknown>={"next/server":{NextResponse},zod:{z},"@/server/auth/core":{AuthError},"@/server/auth/session":{requireApiSession:authenticate,requireMutationSession:authenticate},
    "@/server/auth/session-binding":{sessionBinding:()=>binding,assertRequestSessionBinding:(request:Request)=>{calls.push("bind");if(request.headers.get("X-Workbench-Session-Binding")!==binding)throw new AuthError("SESSION_CHANGED",401);}},
    "@/server/workbench-db":{openWorkbench:()=>{calls.push("open");return {close(){calls.push("close");}};}},"@/server/strict-json":{parseStrictJson},"@/server/investor/schemas":{investorId},
    "@/server/investor/action-review-schemas":{actionReviewInputSchema},"@/server/investor/action-review-jobs":{enqueueActionReviewJob:(...input:unknown[])=>{calls.push("enqueue");args.push(input);if(options.failure)throw new Error(options.failure);return {request_id:"fictional-job"};},
      findActionReviewRequest:(...input:unknown[])=>{calls.push("find");args.push(input);return options.found;}},
    "@/server/investor/action-review-read":{readActionReviewResponse:(...input:unknown[])=>{calls.push("read");args.push(input);if(options.failure)throw new Error(options.failure);return reviewResponse({view:null,request:null});}}};
  const module={exports:{} as {POST:(request:Request)=>Promise<Response>;GET:(request:Request)=>Promise<Response>}};
  const initialize=runInNewContext(`(function(require,module,exports){${compiled}\n})`,{Error,Buffer,URL,TextDecoder});
  initialize((name:string)=>{assert.ok(name in dependencies,name);return dependencies[name];},module,module.exports);return {...module.exports,calls,args};
}
function request(raw:string|Uint8Array=JSON.stringify(reviewIntent),method="POST",query="") {
  return new Request("https://fictional.example.test/api/workbench/investor/action-review"+query,{method,headers:{"Content-Type":"application/json","X-Workbench-Session-Binding":binding},...(method==="POST"?{body:typeof raw==="string"?raw:new Uint8Array(raw).buffer}:{})});
}
test("authentication, Origin and mandatory binding precede body access; changed session before enqueue opens no database",async()=>{
  for(const opts of [{deny:true},{origin:true}]) {const h=harness(opts),body=request();assert.ok([401,403].includes((await h.POST(body)).status));assert.equal(body.bodyUsed,false);assert.equal(h.calls.includes("open"),false);}
  for(const missing of [true,false]) {const body=request();if(missing)body.headers.delete("X-Workbench-Session-Binding");else body.headers.set("X-Workbench-Session-Binding","b".repeat(64));
    assert.ok([400,401].includes((await harness().POST(body)).status));assert.equal(body.bodyUsed,false);}
  const h=harness({changeAt:2});assert.equal((await h.POST(request())).status,401);assert.equal(h.calls.includes("open"),false);
});
test("POST enqueues server owner intent only; session change after durable acceptance withholds every private response fact",async()=>{
  const h=harness(),response=await h.POST(request());assert.equal(response.status,200);
  assert.deepEqual(h.calls,["auth","bind","auth","bind","open","enqueue","read","auth","bind","close"]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.args[0][1])),{id:"fictional-owner"});assert.deepEqual(JSON.parse(JSON.stringify(h.args[0][2])),reviewIntent);
  assert.equal(response.headers.get("cache-control"),"private, no-store");assert.equal(response.headers.get("vary"),"Cookie");assert.equal(response.headers.get("x-content-type-options"),"nosniff");
  const changed=harness({changeAt:3}),withheld=await changed.POST(request());assert.equal(withheld.status,401);assert.equal(changed.calls.includes("enqueue"),true);
  assert.deepEqual(await withheld.json(),{error:"SESSION_CHANGED"});assert.equal(changed.calls.at(-1),"close");
});
test("GET is read-only and reauthenticated; nonce misses explicitly prohibit latest-request fallback",async()=>{
  const h=harness(),response=await h.GET(request("","GET","?nonce=fictional-lost"));assert.equal(response.status,200);assert.equal(h.calls.includes("enqueue"),false);
  const args=h.args.at(-1)!;assert.equal(args[3],null);assert.deepEqual(JSON.parse(JSON.stringify(args[5])),{latest:false,lookupNonce:"fictional-lost"});
  assert.deepEqual(h.calls,["auth","bind","open","find","read","auth","bind","close"]);
  const changed=harness({changeAt:2});assert.equal((await changed.GET(request("","GET"))).status,401);assert.equal(changed.calls.at(-1),"close");
  for(const query of ["?nonce=x&request=y","?request=a&request=b","?nonce=a&nonce=b","?actor_id=other"]) {const invalid=harness();assert.equal((await invalid.GET(request("","GET",query))).status,400);assert.equal(invalid.calls.includes("open"),false);}
});
test("strict bounded body rejects unknown actors, duplicate keys, missing answer fields and invalid UTF8 without writes",async()=>{
  for(const raw of ['{"kind":"preview","kind":"preview"}',JSON.stringify({...reviewIntent,actor_id:"other"}),'{"kind":"confirmation","body":{}}',new Uint8Array([255]),"SYNTHETIC_PRIVATE_MARKER"]) {
    const h=harness(),response=await h.POST(request(raw));assert.equal(response.status,400);assert.equal(h.calls.includes("open"),false);assert.doesNotMatch(await response.text(),/SYNTHETIC_PRIVATE_MARKER|actor_id/);
  }
  let cancelled=false;const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(524289));},cancel(){cancelled=true;return new Promise<void>(()=>{});}});
  const huge=new Request("https://fictional.example.test/api/workbench/investor/action-review",{method:"POST",headers:{"Content-Type":"application/json","X-Workbench-Session-Binding":binding},body:stream,duplex:"half"} as RequestInit);
  const h=harness(),response=await h.POST(huge);assert.equal(response.status,413);assert.equal(response.headers.get("connection"),"close");assert.equal(cancelled,true);assert.equal(h.calls.includes("open"),false);
});
test("business conflicts are explicit and private source/native errors are sanitized",async()=>{
  for(const [failure,status] of [["ACTION_REVIEW_JOB_BUSY",409],["ACTION_REVIEW_JOB_VERSION_CHANGED",409],["WORKBENCH_READ_ONLY",423],["SYNTHETIC_PRIVATE_MARKER SQLITE",503]] as const) {
    const response=await harness({failure}).POST(request());assert.equal(response.status,status);assert.deepEqual(await response.json(),{error:status===503?"ACTION_REVIEW_UNAVAILABLE":failure});
  }
});
