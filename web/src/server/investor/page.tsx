import { requireSession } from "@/server/auth/session";
import { sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { getInvestorState } from "./service";
import { InvestorWorkspace, type InvestorView } from "@/components/workbench/investor-workspace";

export async function investorPage(view: InvestorView, historyObservationId: string | null = null) {
  const session = await requireSession();
  try {
    const db = openWorkbench();
    try { return <InvestorWorkspace initial={getInvestorState(db, { id: session.userId }, undefined, { includeRecentHistory: view !== "observations", includeActionMaintenanceProgress: true })} initialSessionBinding={sessionBinding(session.sessionId)} view={view} historyObservationId={historyObservationId} />; }
    finally { db.close(); }
  } catch {
    return <section className="mx-auto max-w-3xl rounded-2xl border p-8"><h1 className="text-2xl font-semibold">研究工作区暂不可用</h1><p className="mt-4 text-muted-foreground">当前资料未通过读取或版本核验，暂不能展示参考组合。请由运营者核对数据库、迁移和恢复状态；系统不会用演示权重代替。</p></section>;
  }
}
