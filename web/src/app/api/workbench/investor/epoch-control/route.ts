import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError } from "@/server/auth/core";
import { requireApiSession, requireMutationSession } from "@/server/auth/session";
import { assertRequestSessionBinding, sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { parseStrictJson } from "@/server/strict-json";
import { investorId } from "@/server/investor/schemas";
import { epochControlSubmitSchema } from "@/server/investor/epoch-control-schemas";
import { submitEpochControl, readEpochControlResponse } from "@/server/investor/epoch-control-jobs";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",Vary:"Cookie"};
function failure(error:unknown){
  if(error instanceof AuthError)return NextResponse.json({error:error.code},{status:error.status,headers:{...headers,...(error.status===413?{Connection:"close"}:{})}});
  if(error instanceof z.ZodError)return NextResponse.json({error:"EPOCH_CONTROL_INPUT_INVALID"},{status:400,headers});
  const allowed=new Set(["EPOCH_CONTROL_VERSION_CHANGED","EPOCH_CONTROL_CHANGED","EPOCH_CONTROL_EXPIRED","EPOCH_CONTROL_BUSY","EPOCH_CONTROL_DUPLICATE_CONFLICT","EPOCH_CONTROL_LOOKUP_MISSING","EPOCH_CONTROL_WORKSPACE_REQUIRED","WORKBENCH_READ_ONLY"]);
  const code=error instanceof Error&&allowed.has(error.message)?error.message:"EPOCH_CONTROL_UNAVAILABLE";
  return NextResponse.json({error:code},{status:code==="WORKBENCH_READ_ONLY"?423:allowed.has(code)?409:503,headers});
}
function bind(request:Request,sid:string){
  if(!request.headers.get("X-Workbench-Session-Binding"))throw new AuthError("SESSION_BINDING_REQUIRED",400);
  assertRequestSessionBinding(request,sid);
}
function query(request:Request){
  const params=new URL(request.url).searchParams,keys=[...params.keys()];
  if(new Set(keys).size!==keys.length)throw new AuthError("INVALID_QUERY",400);
  return z.object({model:investorId.optional(),nonce:investorId.optional()}).strict().refine(value=>Object.keys(value).length===1).parse(Object.fromEntries(params));
}
async function body(request:Request){
  if(new URL(request.url).searchParams.size)throw new AuthError("INVALID_QUERY",400);
  if(request.headers.get("content-type")?.split(";",1)[0].trim().toLowerCase()!=="application/json")throw new AuthError("JSON_REQUIRED",415);
  const limit=16384,length=request.headers.get("content-length");
  if(length&&(!/^[0-9]+$/.test(length)||Number(length)>limit))throw new AuthError("REQUEST_TOO_LARGE",413);
  const reader=request.body?.getReader();if(!reader)throw new AuthError("INVALID_JSON",400);
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){if(request.signal.aborted)throw new AuthError("REQUEST_ABORTED",400);const {value,done}=await reader.read();if(done)break;
    size+=value.byteLength;if(size>limit){void reader.cancel().catch(()=>{});throw new AuthError("REQUEST_TOO_LARGE",413);}chunks.push(value);
  }}finally{reader.releaseLock();}
  let parsed:unknown;try{parsed=parseStrictJson(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new AuthError("INVALID_JSON",400);}
  return epochControlSubmitSchema.parse(parsed);
}
export async function GET(request:Request){
  try{
    const initial=await requireApiSession();bind(request,initial.sessionId);const selection=query(request),db=openWorkbench();
    try{
      const value=readEpochControlResponse(db,{id:initial.userId},sessionBinding(initial.sessionId),selection);
      const current=await requireApiSession();bind(request,current.sessionId);
      if(current.userId!==initial.userId||current.sessionId!==initial.sessionId)throw new AuthError("SESSION_CHANGED",401);
      return NextResponse.json(value,{headers});
    }finally{db.close();}
  }catch(error){return failure(error);}
}
export async function POST(request:Request){
  try{
    const initial=await requireMutationSession();bind(request,initial.sessionId);const input=await body(request);
    const guard=async()=>{const current=await requireMutationSession();bind(request,current.sessionId);
      if(current.userId!==initial.userId||current.sessionId!==initial.sessionId)throw new AuthError("SESSION_CHANGED",401);};
    await guard();if(request.signal.aborted)throw new AuthError("REQUEST_ABORTED",400);const db=openWorkbench();
    try{
      submitEpochControl(db,{id:initial.userId},input);
      const value=readEpochControlResponse(db,{id:initial.userId},sessionBinding(initial.sessionId),{nonce:input.idempotency_key});
      await guard();return NextResponse.json(value,{status:input.enabled&&["queued","running"].includes(value.request?.status??"")?202:200,headers});
    }finally{db.close();}
  }catch(error){return failure(error);}
}
