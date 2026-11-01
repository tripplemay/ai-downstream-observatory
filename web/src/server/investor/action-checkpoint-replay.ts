import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";
import { hash } from "../ledger/service";
import { actionReviewSourceRetired, checkpointPredecessorReview } from "./action-review-selection";
import { readInvestorMonitorEvidenceSource } from "./monitor-source";
import type { VerifiedSourceReview } from "./source-inputs";

type Obj=Record<string,unknown>;
const scope=new AsyncLocalStorage<{db:Database.Database;workspace:string;now:string;reviews:Map<string,VerifiedSourceReview>}>();
function check(value:unknown):asserts value {if(!value)throw new Error("ACTION_CHECKPOINT_REPLAY_INVALID");}
export function checkpointActionReview(db:Database.Database,workspace:string,id:unknown,now:string) {
  const value=scope.getStore();
  if(!value||value.db!==db||value.workspace!==workspace||value.now!==now||typeof id!=="string")return null;
  const review=value.reviews.get(id);return review?structuredClone(review):null;
}

/** Historical projection only, still bound to a real immutable v4 checkpoint. */
export function readCheckpointMonitorSource(db:Database.Database,workspace:string,model:Obj,checkpoint:Obj,now:string) {
  return db.transaction(()=>{
    const original=readInvestorMonitorEvidenceSource(db,workspace,model.id as string,checkpoint.input_id as string,now,checkpoint.created_at as string);
    if(original.unavailable_reason!=="REFERENCE_SOURCE_NO_LONGER_CURRENT"||original.document.schema_version!=="investor-monitor-data-input-v4")return original;
    const stored=db.prepare("SELECT * FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?").get(checkpoint.id,workspace,model.id) as Obj|undefined;
    check(stored&&hash(stored)===hash(checkpoint)&&now<(stored.valid_until as string)&&original.document.projection_hash===stored.projection_hash);
    const reviews=new Map<string,VerifiedSourceReview>();
    for(const segment of original.document.segments as Obj[]) {
      const snapshot=segment.snapshot as Obj;
      for(const ref of snapshot.review_refs as Obj[])if(actionReviewSourceRetired(db,workspace,ref.review_id,now))
        reviews.set(ref.review_id as string,checkpointPredecessorReview(db,workspace,ref,snapshot.range_start as string,snapshot.range_end as string,now));
    }
    if(!reviews.size)return original;
    return scope.run({db,workspace,now,reviews},()=>{
      const rebuilt=readInvestorMonitorEvidenceSource(db,workspace,model.id as string,stored.input_id as string,now,stored.created_at as string);
      if(rebuilt.projection)check(hash(rebuilt.projection)===stored.projection_hash);
      return rebuilt;
    });
  }).deferred();
}
