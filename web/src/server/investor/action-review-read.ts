import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { canonical } from "../ledger/service";
import { actionReviewResponseSchema } from "./action-review-schemas";
import { readActionReviewPreview } from "./action-review-lineage";
import { actionReviewSymbols, readActionReviewJobStatus } from "./action-review-jobs";

export function readActionReviewResponse(db:Database.Database,actor:{id:string},binding:string,id:string|null=null,now=new Date().toISOString(),options:{latest?:boolean;lookupNonce?:string}={}) {
  return db.transaction(()=>{
    const status=readActionReviewJobStatus(db,actor,id,now,options.latest??true);let view=null,previewError:null|"ACTION_REVIEW_VIEW_UNAVAILABLE"|"ACTION_REVIEW_VIEW_CHANGED"=null;
    if(status.request?.status === "preview_ready") {
      try { view=readActionReviewPreview(db,status.workspace_id as string,actor.id,status.request.resource_id,now); }
      catch(error) { previewError=error instanceof Error && error.message === "ACTION_REVIEW_VIEW_CHANGED" ? "ACTION_REVIEW_VIEW_CHANGED":"ACTION_REVIEW_VIEW_UNAVAILABLE"; }
    }
    let refresh=Date.parse(now)+15000;if(view)refresh=Math.min(refresh,Date.parse(view.refresh_after),Date.parse(view.preview.valid_until));
    let readOnly=false;try{assertWritableDatabase(db);}catch(error){if(error instanceof Error && error.message === "WORKBENCH_READ_ONLY")readOnly=true;else throw error;}
    const result=actionReviewResponseSchema.parse({...status,schema_version:"investor-action-review-response-v1",read_only:readOnly,
      symbols:actionReviewSymbols(db,actor,now),lookup_nonce:options.lookupNonce??null,refresh_after:new Date(refresh).toISOString(),view,preview_error:previewError,session_binding:binding});
    if(Buffer.byteLength(canonical(result))>4194304)throw new Error("ACTION_REVIEW_RESPONSE_TOO_LARGE");return result;
  }).deferred();
}
