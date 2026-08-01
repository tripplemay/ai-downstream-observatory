import { z } from "zod";
import { CONFIRM_STATUSES, FALSIFY_STATUSES } from "./seed";

export const signalUpdateSchema = z.object({
  themeId: z.string().min(1),
  id: z.string().min(1),
  status: z.string().min(1, "请选择状态"),
  current_value: z.string().max(500).default(""),
  note: z.string().max(1000).default(""),
});
export type SignalUpdateInput = z.infer<typeof signalUpdateSchema>;

export const observationSchema = z.object({
  themeId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD"),
  light: z.enum(["red", "yellow", "green"]),
  note: z.string().max(1000).default(""),
});
export type ObservationInput = z.infer<typeof observationSchema>;

export const thesisSchema = z.object({
  themeId: z.string().min(1),
  thesis: z.string().max(20000).default(""),
  rules: z.string().max(20000).default(""),
});
export type ThesisInput = z.infer<typeof thesisSchema>;

export const poolItemSchema = z.object({
  themeId: z.string().min(1),
  id: z.number().int().positive().optional(),
  name: z.string().min(1, "名称必填").max(100),
  code: z.string().max(100).default(""),
  channel: z.string().max(100).default(""),
  position: z.string().max(200).default(""),
  note: z.string().max(500).default(""),
});
export type PoolItemInput = z.infer<typeof poolItemSchema>;

export const ALL_STATUSES = [...CONFIRM_STATUSES, ...FALSIFY_STATUSES];
