import {z} from "zod";
import {investorId,investorHash,investorInstant} from "./schemas";
export const epochRegistrationAcknowledgements=["separate_current_epoch","displayed_source_and_correction_bindings","reported_coverage_not_objective_absence",
  "economic_carry_not_point_in_time","preserve_original_model_and_history","no_strategy_cash_or_trading_change"] as const;
const revision=z.number().int().min(1).max(9007199254740990);
export const epochRegistrationSubmitSchema=z.object({schema_version:z.literal("investor-model-epoch-submit-v1"),preview_id:investorId,expected_preview_hash:investorHash,
  expected_revision:revision,idempotency_key:investorId.refine(s=>s.length>=8),
  acknowledgements:z.object(Object.fromEntries(epochRegistrationAcknowledgements.map(k=>[k,z.literal(true)]))).strict(),
}).strict();
export const epochRegistrationResponseSchema=z.object({schema_version:z.literal("investor-epoch-registration-response-v1"),workspace_id:investorId,
  workspace_revision:z.number().int().nonnegative().safe(),model_id:investorId,session_binding:investorHash,lookup_nonce:investorId.nullable(),
  checked_at:investorInstant,refresh_after:investorInstant,read_only:z.boolean(),
  request:z.object({id:investorId,intent_hash:investorHash,preview_id:investorId,created_at:investorInstant,valid_until:investorInstant,
    status:z.enum(["queued","running","registered","expired","unknown","outdated"])}).strict().nullable(),
  receipt:z.object({epoch_id:investorId,registration_hash:investorHash,registered_at:investorInstant,valid_until:investorInstant,
    historical_registration_only:z.literal(true),monitoring_resumed:z.literal(false),current_source_eligibility_restored:z.literal(false),trading_permission:z.literal(false),
  }).strict().nullable(),
  visibility:z.literal("private_owner_only_not_ai"),provider_calls:z.literal(0),trading_permission:z.literal(false),
}).strict();
export type EpochRegistrationSubmit=z.infer<typeof epochRegistrationSubmitSchema>;
export type EpochRegistrationResponse=z.infer<typeof epochRegistrationResponseSchema>;
