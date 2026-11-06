import {NextResponse} from "next/server";
import {z} from "zod";
import {AuthError} from "@/server/auth/core";
import {requireApiSession,requireMutationSession} from "@/server/auth/session";
import {assertRequestSessionBinding,sessionBinding} from "@/server/auth/session-binding";
import {openWorkbench} from "@/server/workbench-db";
import {parseStrictJson} from "@/server/strict-json";
import {investorId} from "@/server/investor/schemas";
import {historyWorkflowSubmitSchema} from "@/server/investor/epoch-history-schemas";
import {submitHistoryWorkflow,readHistoryWorkflowResponse} from "@/server/investor/epoch-history-workflow";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",Vary:"Cookie"};
function failure(error:unknown){
 if(error instanceof AuthError)return NextResponse.json({error:error.code},{status:error.status,headers:{...headers,...(error.status===413?{Connection:"close"}:{})}});
 if(error instanceof z.ZodError)return NextResponse.json({error:"HISTORY_WORKFLOW_INPUT_INVALID"},{status:400,headers});
 const allowed=new Set(["HISTORY_WORKFLOW_VERSION_CHANGED","HISTORY_WORKFLOW_PREVIEW_CHANGED","HISTORY_WORKFLOW_SOURCE_CHANGED","HISTORY_WORKFLOW_EXPIRED","HISTORY_WORKFLOW_BUSY","HISTORY_WORKFLOW_DUPLICATE_CONFLICT","HISTORY_WORKFLOW_LOOKUP_MISSING","HISTORY_WORKFLOW_WORKSPACE_REQUIRED","HISTORY_WORKFLOW_ACTIVATION_REQUIRED","WORKBENCH_READ_ONLY"]);
 const code=error instanceof Error&&allowed.has(error.message)?error.message:"HISTORY_WORKFLOW_UNAVAILABLE";
 return NextResponse.json({error:code},{status:code==="WORKBENCH_READ_ONLY"?423:allowed.has(code)?409:503,headers});
}
function bind(r:Request,id:string){if(!r.headers.get("X-Workbench-Session-Binding"))throw new AuthError("SESSION_BINDING_REQUIRED",400);assertRequestSessionBinding(r,id);}
function query(r:Request){const p=new URL(r.url).searchParams,k=[...p.keys()];if(new Set(k).size!==k.length)throw new AuthError("INVALID_QUERY",400);
 return z.object({model:investorId.optional(),nonce:investorId.optional()}).strict().refine(v=>Object.keys(v).length===1).parse(Object.fromEntries(p));}
async function body(r:Request){
 if(new URL(r.url).searchParams.size)throw new AuthError("INVALID_QUERY",400);
 if(r.headers.get("content-type")?.split(";",1)[0].trim().toLowerCase()!=="application/json")throw new AuthError("JSON_REQUIRED",415);
 const length=r.headers.get("content-length"),limit=4096;if(length&&(!/^[0-9]+$/.test(length)||Number(length)>limit))throw new AuthError("REQUEST_TOO_LARGE",413);
 const reader=r.body?.getReader();if(!reader)throw new AuthError("INVALID_JSON",400);const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){if(r.signal.aborted)throw new AuthError("REQUEST_ABORTED",400);const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
  if(size>limit){void reader.cancel().catch(()=>{});throw new AuthError("REQUEST_TOO_LARGE",413);}chunks.push(value);}}finally{reader.releaseLock();}
 let parsed:unknown;try{parsed=parseStrictJson(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new AuthError("INVALID_JSON",400);}
 return historyWorkflowSubmitSchema.parse(parsed);
}
export async function GET(request:Request){try{
 const initial=await requireApiSession();bind(request,initial.sessionId);const selected=query(request),db=openWorkbench();
 try{const value=readHistoryWorkflowResponse(db,{id:initial.userId},sessionBinding(initial.sessionId),selected);const current=await requireApiSession();bind(request,current.sessionId);
  if(current.userId!==initial.userId||current.sessionId!==initial.sessionId)throw new AuthError("SESSION_CHANGED",401);return NextResponse.json(value,{headers});}finally{db.close();}
}catch(error){return failure(error);}}
export async function POST(request:Request){try{
 const initial=await requireMutationSession();bind(request,initial.sessionId);const input=await body(request);
 const guard=async()=>{const current=await requireMutationSession();bind(request,current.sessionId);if(current.userId!==initial.userId||current.sessionId!==initial.sessionId)throw new AuthError("SESSION_CHANGED",401);};
 await guard();if(request.signal.aborted)throw new AuthError("REQUEST_ABORTED",400);const db=openWorkbench();
 try{submitHistoryWorkflow(db,{id:initial.userId},input);const value=readHistoryWorkflowResponse(db,{id:initial.userId},sessionBinding(initial.sessionId),{nonce:input.idempotency_key});
  await guard();return NextResponse.json(value,{status:["queued","running"].includes(value.request?.status??"")?202:200,headers});}finally{db.close();}
}catch(error){return failure(error);}}
