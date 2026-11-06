import {z} from "zod";
import {investorId as id,investorHash as digest,investorInstant as at} from "./schemas";
const revision=z.number().int().min(0).max(9007199254740990),nonce=id.refine(s=>s.length>=8),day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const historyAcknowledgements=["historical_not_live","old_attempts_unchanged","bounded_download_only","no_trading"] as const;
const shared={schema_version:z.literal("investor-epoch-history-workflow-submit-v1"),model_id:id,expected_revision:revision,idempotency_key:nonce};
export const historyWorkflowSubmitSchema=z.discriminatedUnion("action",[
 z.object({...shared,action:z.literal("prepare"),acknowledged_plan_only:z.literal(true)}).strict(),
 z.object({...shared,action:z.literal("confirm"),preview_id:id,expected_preview_hash:digest,max_calls:z.number().int().min(1).max(4),
  acknowledgements:z.object(Object.fromEntries(historyAcknowledgements.map(k=>[k,z.literal(true)]))).strict()}).strict(),
]);
const range={start_date:day,end_date:day},tile=z.object({...range,symbol:z.string().min(1).max(64),market:z.enum(["CN","HK","US"]),expected_date_count:z.number().int().min(1).max(31)}).strict();
export const historyWorkflowResponseSchema=z.object({schema_version:z.literal("investor-epoch-history-workflow-response-v1"),workspace_id:id,workspace_revision:z.number().int().nonnegative().safe(),model_id:id,session_binding:digest,
 lookup_nonce:id.nullable(),checked_at:at,refresh_after:at,read_only:z.boolean(),epoch:z.object({id,enabled:z.boolean(),valid_until:at}).strict().nullable(),
 request:z.object({id,action:z.enum(["prepare","confirm"]),intent_hash:digest,created_at:at,valid_until:at,status:z.enum(["queued","running","plan_ready","download_queued","rejected","expired","outdated","unknown"]),
  code:z.enum(["HISTORY_WORKFLOW_PLAN_READY","HISTORY_WORKFLOW_DOWNLOAD_QUEUED","HISTORY_WORKFLOW_EXPIRED","HISTORY_WORKFLOW_CHANGED","HISTORY_WORKFLOW_SOURCE_UNAVAILABLE","HISTORY_WORKFLOW_REVIEW_REQUIRED"]).nullable()}).strict().nullable(),
 preview:z.object({id,content_hash:digest,workspace_revision:revision,valid_until:at,plan_status:z.enum(["download_confirmation_required","no_missing_past_closes","overlap_review_required"]),
  expected_date_count:z.number().int().nonnegative().max(73200),retained_date_count:z.number().int().nonnegative().max(73200),missing_date_count:z.number().int().nonnegative().max(73200),
  total_tiles:z.number().int().nonnegative().max(128),tiles:z.array(tile).max(4),prior_callback_count:z.number().int().nonnegative().max(1000),historical_metadata_only:z.literal(true)}).strict().nullable(),
 download:z.object({id,content_hash:digest,created_at:at,valid_until:at,slots:z.array(tile.extend({index:z.number().int().min(0).max(3),reserved:z.boolean(),
  status:z.enum(["queued","running","collected","already_available","superseded","blocked_predecessor","unknown"])}).strict()).min(1).max(4),historical_metadata_only:z.literal(true)}).strict().nullable(),
 visibility:z.literal("private_owner_only_not_ai"),provider_calls:z.literal(0),current_source_eligibility_restored:z.literal(false),monitoring_resumed:z.literal(false),trading_permission:z.literal(false),
}).strict();
export type HistoryWorkflowSubmit=z.infer<typeof historyWorkflowSubmitSchema>;
export type HistoryWorkflowResponse=z.infer<typeof historyWorkflowResponseSchema>;
