import { z } from "zod";
import { investorHash, investorId, investorInstant } from "./schemas";

export const investorNoticeSchema = z.object({ id: investorId, publication_id: investorId, workspace_id: investorId, model_id: investorId, observation_id: investorId,
  recorded_outcome: z.enum(["observe", "decision_required", "insufficient_evidence"]), published_at: investorInstant,
  publication_hash: investorHash, read_at: investorInstant.nullable(), is_current_conclusion: z.literal(false), live_advice_eligible: z.literal(false) }).strict();
export const investorInboxSchema = z.object({ schema_version: z.literal("investor-notifications-v1"), workspace_id: investorId.nullable(),
  checked_at: investorInstant, read_only: z.boolean(), entries: z.array(investorNoticeSchema).max(20), has_more: z.boolean(),
  visible_unread_count: z.number().int().min(0).max(20), external_delivery_configured: z.literal(false), live_advice_eligible: z.literal(false) }).strict();
export const investorNoticeReadSchema = z.object({ notice_id: investorId, publication_hash: investorHash }).strict();
export const investorNoticeReceiptSchema = z.object({ schema_version: z.literal("investor-notification-read-v1"), notice_id: investorId,
  publication_hash: investorHash, audit_id: investorId, read_at: investorInstant, financial_state_changed: z.literal(false) }).strict();
export type InvestorNotice = z.infer<typeof investorNoticeSchema>;
export type InvestorInbox = z.infer<typeof investorInboxSchema>;
