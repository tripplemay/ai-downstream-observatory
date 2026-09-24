import { requireSession } from "@/server/auth/session";
import { sessionBinding } from "@/server/auth/session-binding";
import { PriceScheduleWorkspace } from "@/components/workbench/price-schedule-workspace";

export const dynamic = "force-dynamic";
export default async function PriceSchedulesPage() {
  const session = await requireSession();
  return <PriceScheduleWorkspace initialSessionBinding={sessionBinding(session.sessionId)} />;
}
