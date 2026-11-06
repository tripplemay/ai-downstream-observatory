import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import ts from "typescript";
import {NextResponse} from "next/server";
import {z} from "zod";
import {AuthError} from "../src/server/auth/core";
import {parseStrictJson} from "../src/server/strict-json";
import {investorId} from "../src/server/investor/schemas";
import {historyWorkflowSubmitSchema} from "../src/server/investor/epoch-history-schemas";
const binding="0".repeat(64),input={schema_version:"investor-epoch-history-workflow-submit-v1",action:"prepare",model_id:"fictional-model",expected_revision:1,idempotency_key:"fictional-history-route",acknowledged_plan_only:true};
const compiled=ts.transpileModule(readFileSync(new URL("../src/app/api/workbench/investor/epoch-history/route.ts",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function harness(options:{deny?:boolean;origin?:boolean;changeAt?:number;failure?:string}={}){const calls:string[]=[];let count=0;
 const auth=async()=>{calls.push("auth");count++;if(options.deny)throw new AuthError("UNAUTHENTICATED",401);if(options.origin)throw new AuthError("ORIGIN_DENIED",403);return {userId:"owner",sessionId:options.changeAt&&count>=options.changeAt?"changed":"same"};};
 const imports:Record<string,unknown>={"next/server":{NextResponse},zod:{z},"@/server/auth/core":{AuthError},"@/server/auth/session":{requireApiSession:auth,requireMutationSession:auth},
  "@/server/auth/session-binding":{sessionBinding:()=>binding,assertRequestSessionBinding:(r:Request)=>{if(r.headers.get("X-Workbench-Session-Binding")!==binding)throw new AuthError("SESSION_CHANGED",401);}},
  "@/server/workbench-db":{openWorkbench:()=>{calls.push("open");return {close(){calls.push("close");}};}},"@/server/strict-json":{parseStrictJson},"@/server/investor/schemas":{investorId},
  "@/server/investor/epoch-history-schemas":{historyWorkflowSubmitSchema},"@/server/investor/epoch-history-workflow":{
   submitHistoryWorkflow:(_db:unknown,actor:unknown,body:unknown)=>{calls.push("submit");assert.deepEqual(JSON.parse(JSON.stringify(actor)),{id:"owner"});assert.deepEqual(JSON.parse(JSON.stringify(body)),input);if(options.failure)throw new Error(options.failure);},
   readHistoryWorkflowResponse:()=>{calls.push("read");if(options.failure)throw new Error(options.failure);return {request:{status:"queued"}};}}};
 const module={exports:{} as {GET:(r:Request)=>Promise<Response>;POST:(r:Request)=>Promise<Response>}};
 runInNewContext("(function(require,module,exports){"+compiled+"\n})",{Error,Buffer,URL,TextDecoder})((name:string)=>{assert.ok(name in imports,name);return imports[name];},module,module.exports);return {...module.exports,calls};
}
const request=(raw:string|Uint8Array=JSON.stringify(input),method="POST",query="")=>new Request("https://fictional.invalid/api/workbench/investor/epoch-history"+query,{method,
 headers:{"Content-Type":"application/json","X-Workbench-Session-Binding":binding},...(method==="POST"?{body:typeof raw==="string"?raw:new Uint8Array(raw).buffer}:{})});
export async function verifyHistoryRoute(){
 for(const options of [{deny:true},{origin:true}]){const h=harness(options),r=request();assert.ok([401,403].includes((await h.POST(r)).status));assert.equal(r.bodyUsed,false);assert.equal(h.calls.includes("open"),false);}
 const missing=request();missing.headers.delete("X-Workbench-Session-Binding");assert.equal((await harness().POST(missing)).status,400);assert.equal(missing.bodyUsed,false);
 const early=harness({changeAt:2});assert.equal((await early.POST(request())).status,401);assert.equal(early.calls.includes("open"),false);
 const late=harness({changeAt:3});assert.equal((await late.POST(request())).status,401);assert.equal(late.calls.filter(c=>c==="submit").length,1);assert.equal(late.calls.at(-1),"close");
 for(const raw of ['{"action":"prepare","action":"confirm"}',JSON.stringify({...input,prices:[]}),JSON.stringify({...input,acknowledged_plan_only:false}),new Uint8Array([255])]){const h=harness();assert.equal((await h.POST(request(raw))).status,400);assert.equal(h.calls.includes("open"),false);}
 for(const q of ["","?model=a&nonce=b","?model=a&model=b","?actor_id=other"]){const h=harness();assert.equal((await h.GET(request("","GET",q))).status,400);assert.equal(h.calls.includes("open"),false);}
 let cancelled=false;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(4097));},cancel(){cancelled=true;return new Promise<void>(()=>{});}});
 const huge=new Request("https://fictional.invalid/api/workbench/investor/epoch-history",{method:"POST",headers:{"Content-Type":"application/json","X-Workbench-Session-Binding":binding},body:stream,duplex:"half"} as RequestInit);
 assert.equal((await harness().POST(huge)).status,413);assert.equal(cancelled,true);
 const value=await harness().POST(request());assert.equal(value.status,202);assert.equal(value.headers.get("cache-control"),"private, no-store");assert.equal(value.headers.get("vary"),"Cookie");
 const read=harness();assert.equal((await read.GET(request("","GET","?nonce=fictional-history-route"))).status,200);assert.equal(read.calls.includes("submit"),false);
 for(const [failure,status] of [["HISTORY_WORKFLOW_BUSY",409],["WORKBENCH_READ_ONLY",423],["FICTIONAL_PRIVATE_SQL",503]] as const){const r=await harness({failure}).POST(request());assert.equal(r.status,status);assert.deepEqual(await r.json(),{error:status===503?"HISTORY_WORKFLOW_UNAVAILABLE":failure});}
}
