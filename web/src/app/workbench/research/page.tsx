import { requireSession } from "@/server/auth/session";
import { openWorkbench } from "@/server/workbench-db";
import { workbenchState } from "@/server/ledger/queries";
import { DecisionWorkspace } from "@/components/workbench/decision-workspace";

export const dynamic = "force-dynamic";
export default async function ResearchPage() {
  const session = await requireSession();
  const db = openWorkbench();
  try { return <DecisionWorkspace initial={workbenchState(db, { id: session.userId })} mode="research" />; }
  finally { db.close(); }
}
