import { hash } from "../src/server/ledger/service";
import { epochControlAcknowledgements, type EpochControlResponse, type EpochControlSubmit } from "../src/server/investor/epoch-control-schemas";
import { reviewBinding, reviewNow } from "./action-review-client-fixture";
export const epochScope={workspace:"w",model:"fictional-model",binding:reviewBinding};
export const epochAnswers=Object.fromEntries(epochControlAcknowledgements.map(key=>[key,true]));
export function epochResponse(patch:Partial<EpochControlResponse>={}):EpochControlResponse{
  return {schema_version:"investor-epoch-control-response-v1",workspace_id:"w",workspace_revision:1,model_id:"fictional-model",session_binding:reviewBinding,lookup_nonce:null,
    checked_at:new Date(reviewNow).toISOString(),refresh_after:new Date(reviewNow+15000).toISOString(),read_only:false,
    epoch:{id:"fictional-epoch",registration_hash:"a".repeat(64),registered_at:new Date(reviewNow-1000).toISOString(),valid_until:new Date(reviewNow+60000).toISOString(),
      checkpoint:{id:"fictional-checkpoint",content_hash:"b".repeat(64)},enabled:false,control_id:null,control_version:0,global_control_matches:true},
    request:null,receipt:null,visibility:"private_owner_only_not_ai",provider_calls:0,trading_permission:false,...patch};
}
export function queuedEpochControl(intent:EpochControlSubmit):EpochControlResponse{
  return epochResponse({lookup_nonce:intent.idempotency_key,request:{id:"fictional-control-request",intent_hash:hash(intent),epoch_id:intent.epoch_id,
    created_at:new Date(reviewNow).toISOString(),valid_until:new Date(reviewNow+60000).toISOString(),status:"queued",code:null}});
}
export function pausedEpochControl(intent:EpochControlSubmit):EpochControlResponse{
  return epochResponse({workspace_revision:2,lookup_nonce:intent.idempotency_key,epoch:{...epochResponse().epoch!,enabled:false,control_id:"fictional-pause",control_version:1},
    receipt:{control_id:"fictional-pause",intent_hash:hash(intent),epoch_id:intent.epoch_id,enabled:false}});
}
