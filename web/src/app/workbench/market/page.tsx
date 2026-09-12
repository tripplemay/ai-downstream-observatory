import { requireSession } from "@/server/auth/session";
import { sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { getMarketReferenceState } from "@/server/market-references/queries";
import { MarketReferenceWorkspace } from "@/components/workbench/market-reference-workspace";

export const dynamic = "force-dynamic";
export default async function MarketPage() {
  const session = await requireSession(), db = openWorkbench();
  try { return <MarketReferenceWorkspace initial={getMarketReferenceState(db)} initialSessionBinding={sessionBinding(session.sessionId)} />; }
  finally { db.close(); }
}
