import { z } from "zod";

export const priceScheduleIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
export const priceScheduleDateSchema = z.string().regex(/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/).refine(value => {
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
});
export const PRICE_MARKET_ZONES = { CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" } as const;
const ids = z.array(priceScheduleIdSchema).min(1).max(4).refine(values => new Set(values).size === values.length);
export const priceCollectionScheduleSchema = z.object({
  schema_version: z.literal("price-collection-schedule-v1"), provider: z.literal("longport"),
  frequency: z.literal("daily"), publish: z.literal(true), market: z.enum(["CN", "HK", "US"]),
  timezone: z.enum(["Asia/Shanghai", "Asia/Hong_Kong", "America/New_York"]),
  mapping_version_ids: ids, calendar_version_ids: ids,
  start_date: priceScheduleDateSchema, end_date: priceScheduleDateSchema,
  trigger_local: z.object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }).strict(),
  deadline_seconds: z.number().int().min(60).max(86400), max_attempts: z.number().int().min(1).max(5),
  missed_policy: z.literal("record_no_backfill"),
}).strict().refine(value => value.timezone === PRICE_MARKET_ZONES[value.market] && value.end_date >= value.start_date
  && (Date.parse(value.end_date) - Date.parse(value.start_date)) / 86400000 < 3660);
export type PriceCollectionScheduleDefinition = z.infer<typeof priceCollectionScheduleSchema>;
const reason = z.string().refine(value => value.trim().length > 0 && [...value].length <= 1000 && !/[\u0000\u001c-\u001f\u0085\uD800-\uDFFF]/u.test(value));
const base = z.object({ portfolio_id: priceScheduleIdSchema, idempotency_key: priceScheduleIdSchema, reason, acknowledgement: z.literal(true) });
export const savePriceCollectionScheduleSchema = base.extend({ expected_schedule_id: priceScheduleIdSchema.nullable(), expected_schedule_revision: z.number().int().safe().nonnegative(), definition_json: z.string().min(1).max(65536) }).strict();
export const setPriceCollectionScheduleStatusSchema = base.extend({ schedule_id: priceScheduleIdSchema, expected_schedule_revision: z.number().int().safe().positive(), status: z.enum(["enabled", "paused"]) }).strict();
export const priceCollectionQuerySchema = z.object({ portfolio_id: priceScheduleIdSchema.optional(), schedule_id: priceScheduleIdSchema.optional(), cursor: z.string().min(1).max(1024).optional(), limit: z.number().int().min(1).max(50).optional() }).strict();
export const priceCollectionSlotQuerySchema = z.object({ portfolio_id: priceScheduleIdSchema, slot_id: priceScheduleIdSchema }).strict();
