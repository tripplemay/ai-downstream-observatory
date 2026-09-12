import { requireSession } from "@/server/auth/session";
import { openWorkbench } from "@/server/workbench-db";
import { workbenchState } from "@/server/ledger/queries";
import { Workbench } from "@/components/workbench/workbench";

export const dynamic = "force-dynamic";

export default async function WorkbenchPage() {
  const session = await requireSession();
  try {
    const db = openWorkbench();
    try { return <Workbench initial={workbenchState(db, { id: session.userId })} />; }
    finally { db.close(); }
  } catch {
    return <main className="mx-auto max-w-3xl p-8"><h1 className="text-2xl font-semibold">ETF 投资工作台</h1><p className="mt-4 text-muted-foreground">工作台数据库尚未就绪。请先完成显式迁移并核对 WORKBENCH_DB_PATH；系统不会自动创建现金、账户或替换旧库。</p><p className="mt-4">当前禁止生成实盘建议，原始资料与账本不会因刷新页面而改变。</p></main>;
  }
}
