import { requireSession } from "@/server/auth/session";
import { openWorkbench } from "@/server/workbench-db";
import { workbenchState } from "@/server/ledger/queries";
import { FundingWorkspace } from "@/components/workbench/funding-workspace";

export const dynamic = "force-dynamic";
export default async function FundingPage() {
  const session = await requireSession();
  const db = openWorkbench();
  try { return <FundingWorkspace initial={workbenchState(db, { id: session.userId })} />; }
  finally { db.close(); }
}
