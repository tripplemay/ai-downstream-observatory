import { z } from "zod";
import { investorHash, investorId, investorInstant } from "./schemas";

const revision=z.number().int().nonnegative().safe();
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const epochPreviewSubmitSchema=z.object({schema_version:z.literal("investor-epoch-preview-submit-v1"),
  model_id:investorId,expected_model_hash:investorHash,expected_revision:revision.refine(n=>n>=1),
  idempotency_key:investorId.refine(s=>s.length>=8),acknowledged_preview_only:z.literal(true),
}).strict();
export const epochPreviewResponseSchema=z.object({schema_version:z.literal("investor-epoch-preview-response-v1"),
  workspace_id:investorId,workspace_revision:revision,model_id:investorId,model_hash:investorHash,
  session_binding:investorHash,lookup_nonce:investorId.nullable(),checked_at:investorInstant,refresh_after:investorInstant,read_only:z.boolean(),
  request:z.object({id:investorId,intent_hash:investorHash,model_id:investorId,created_at:investorInstant,valid_until:investorInstant,
    status:z.enum(["queued","running","preview_ready","rejected","expired","unknown","outdated"]),
    code:z.enum(["EPOCH_PREVIEW_READY","EPOCH_PREVIEW_EXPIRED","EPOCH_PREVIEW_CHANGED","EPOCH_PREVIEW_SOURCE_UNAVAILABLE"]).nullable(),
  }).strict().nullable(),
  preview:z.object({id:investorId,content_hash:investorHash,workspace_revision:revision,created_at:investorInstant,valid_until:investorInstant,
    original_head_id:investorId,corrections:z.array(z.object({correction_id:investorId,confirmation_hash:investorHash,handover_id:investorId,handover_hash:investorHash}).strict()).min(1).max(64),
    ranges:z.array(z.object({start_date:date,end_date:date}).strict()).min(1).max(3),
    historical_metadata_only:z.literal(true),current_source_eligibility_restored:z.literal(false),
    epoch_registered:z.literal(false),monitoring_resumed:z.literal(false),
  }).strict().nullable(),
  visibility:z.literal("private_owner_only_not_ai"),provider_calls:z.literal(0),trading_permission:z.literal(false),
}).strict();
export type EpochPreviewSubmit=z.infer<typeof epochPreviewSubmitSchema>;
export type EpochPreviewResponse=z.infer<typeof epochPreviewResponseSchema>;
