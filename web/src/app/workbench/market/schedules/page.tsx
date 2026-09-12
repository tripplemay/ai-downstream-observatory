import { requireSession } from "@/server/auth/session";
import { sessionBinding } from "@/server/auth/session-binding";
import { CollectionScheduleWorkspace } from "@/components/workbench/collection-schedule-workspace";
export const dynamic = "force-dynamic";
export default async function CollectionSchedulesPage() { const session = await requireSession(); return <CollectionScheduleWorkspace initialSessionBinding={sessionBinding(session.sessionId)} />; }
