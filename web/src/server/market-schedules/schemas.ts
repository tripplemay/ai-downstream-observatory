import { z } from "zod";

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const date = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).refine(value => {
  if (value.startsWith("0000")) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
});
export const COLLECTION_CURRENCIES = ["CNY", "HKD", "USD", "EUR", "GBP", "JPY", "CHF", "SGD"] as const;
export const collectionScheduleSchema = z.object({
  schema_version: z.literal("collection-schedule-v1"), provider: z.literal("ecb"), feed: z.literal("daily"),
  currencies: z.array(z.enum(COLLECTION_CURRENCIES)).min(1).max(8).refine(values => new Set(values).size === values.length),
  frequency: z.literal("daily"), timezone: z.literal("UTC"), start_date: date, end_date: date.nullable(),
  trigger: z.object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }).strict(),
  deadline_seconds: z.number().int().min(60).max(86400), max_attempts: z.number().int().min(1).max(5),
  publish: z.literal(true), missed_policy: z.literal("record_no_backfill"),
}).strict().refine(value => value.end_date === null || value.end_date >= value.start_date);
export type CollectionScheduleDefinition = z.infer<typeof collectionScheduleSchema>;
const base = z.object({ portfolio_id: id, idempotency_key: id, reason: z.string().min(1).max(2000).refine(value => !!value.trim()), acknowledgement: z.literal(true) });
export const saveCollectionScheduleSchema = base.extend({ expected_schedule_id: id.nullable(), expected_schedule_revision: z.number().int().safe().nonnegative(), definition_json: z.string().min(1).max(65536) }).strict();
export const setCollectionScheduleStatusSchema = base.extend({ schedule_id: id, expected_schedule_revision: z.number().int().safe().positive(), status: z.enum(["enabled", "paused"]) }).strict();
export const collectionQuerySchema = z.object({ portfolio_id: id.optional(), schedule_id: id.optional(), cursor: z.string().min(1).max(1024).optional(), limit: z.number().int().min(1).max(50).optional() }).strict();
export const collectionSlotQuerySchema = z.object({ portfolio_id: id, slot_id: id }).strict();
