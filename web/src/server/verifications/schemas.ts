import { z } from "zod";
import { VERIFICATION_CHECK_ID } from "./types";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u);
export const verificationCommandSchema = z.object({
  portfolio_id: id,
  check_id: z.literal(VERIFICATION_CHECK_ID),
  expected_context_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  reason: z.string().trim().min(1).refine(value => [...value].length <= 1000 && !/[\u0000\u001C-\u001F\u0085\uD800-\uDFFF]/u.test(value)),
  idempotency_key: id,
}).strict();
export const verificationQuerySchema = z.object({
  portfolio: id.optional(), request: id.optional(), cursor: z.string().min(1).max(1024).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict().refine(value => !value.request || Boolean(value.portfolio) && !value.cursor && value.limit === undefined);
