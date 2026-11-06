import {z} from "zod";
import {investorId as id,investorHash as digest,investorInstant as at} from "./schemas";
const ref=z.object({id,content_hash:digest}).strict();
export const historyResolutionAcknowledgements=["outcome_stays_unknown","may_have_consumed_quota","separate_future_confirmation"] as const;
export const historyResolutionSubmitSchema=z.object({schema_version:z.literal("investor-epoch-history-resolution-submit-v1"),action:z.literal("acknowledge_unknown"),model_id:id,
 expected_revision:z.number().int().min(0).max(9007199254740990),idempotency_key:id.refine(v=>v.length>=8),batch:ref,slot:ref,attempt:ref,state_hash:digest,reviewed_at:at,valid_until:at,
 acknowledgements:z.object(Object.fromEntries(historyResolutionAcknowledgements.map(k=>[k,z.literal(true)]))).strict()}).strict();
export const historyUnknownReviewSchema=z.object({batch:ref,slot:ref,attempt:ref,state_hash:digest,reviewed_at:at,valid_until:at,available_after:at,eligible:z.boolean(),
 resolution:ref.extend({created_at:at}).strict().nullable()}).strict();
export const historyResolutionResultSchema=z.object({id,content_hash:digest,created_at:at,nonce:id,intent_hash:digest,old_outcome_known:z.literal(false),new_download_authorized:z.literal(false)}).strict();
