import { z } from "zod";

export const valuationCalendarCheckSchema = z.object({ market: z.enum(["CN", "HK", "US"]), exchange: z.string().min(1).max(200),
  version_id: z.string().min(1).max(200), content_hash: z.string().regex(/^[a-f0-9]{64}$/), expected_session: z.string().date() }).strict();
export type ValuationCalendarCheck = z.infer<typeof valuationCalendarCheckSchema>;
