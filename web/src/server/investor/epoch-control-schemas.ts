import { z } from "zod";
import { investorHash, investorId, investorInstant } from "./schemas";

const revision=z.number().int().nonnegative().safe();
export const epochControlAcknowledgements=["current_epoch_seen","continuous_research_only","preserve_history_and_human_trading"] as const;
const ref=z.object({id:investorId,content_hash:investorHash}).strict();
export const epochControlSubmitSchema=z.object({schema_version:z.literal("investor-epoch-control-submit-v1"),epoch_id:investorId,
  expected_registration_hash:investorHash,expected_checkpoint:ref,expected_revision:revision.refine(value=>value>=1),
  idempotency_key:investorId.refine(value=>value.length>=8),enabled:z.boolean(),
  acknowledgements:z.object(Object.fromEntries(epochControlAcknowledgements.map(key=>[key,z.literal(true)]))).strict(),
}).strict();
export const epochControlResponseSchema=z.object({schema_version:z.literal("investor-epoch-control-response-v1"),
  workspace_id:investorId,workspace_revision:revision,model_id:investorId,session_binding:investorHash,lookup_nonce:investorId.nullable(),
  checked_at:investorInstant,refresh_after:investorInstant,read_only:z.boolean(),
  epoch:z.object({id:investorId,registration_hash:investorHash,registered_at:investorInstant,valid_until:investorInstant,checkpoint:ref,
    enabled:z.boolean(),control_id:investorId.nullable(),control_version:revision,global_control_matches:z.boolean(),
  }).strict().nullable(),
  request:z.object({id:investorId,intent_hash:investorHash,epoch_id:investorId,created_at:investorInstant,valid_until:investorInstant,
    status:z.enum(["queued","running","applied","rejected","expired","unknown","superseded"]),
    code:z.enum(["EPOCH_CONTROL_APPLIED","EPOCH_CONTROL_EXPIRED","EPOCH_CONTROL_CHANGED","EPOCH_CONTROL_SOURCE_UNAVAILABLE"]).nullable(),
  }).strict().nullable(),
  receipt:z.object({control_id:investorId,intent_hash:investorHash,epoch_id:investorId,enabled:z.boolean()}).strict().nullable(),
  visibility:z.literal("private_owner_only_not_ai"),provider_calls:z.literal(0),trading_permission:z.literal(false),
}).strict();
export type EpochControlSubmit=z.infer<typeof epochControlSubmitSchema>;
export type EpochControlResponse=z.infer<typeof epochControlResponseSchema>;
