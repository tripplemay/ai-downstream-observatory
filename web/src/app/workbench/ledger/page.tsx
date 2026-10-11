import Link from "next/link";
import { requireSession } from "@/server/auth/session";
import { openWorkbench } from "@/server/workbench-db";
import { workbenchState } from "@/server/ledger/queries";
import { Workbench } from "@/components/workbench/workbench";
export const dynamic = "force-dynamic";
export default async function Page() {
  const session = await requireSession();
  try {
    const db = openWorkbench();
    try { return <><Link href="/workbench" className="mb-4 inline-block text-sm underline">返回组合总览</Link><Workbench initial={workbenchState(db, { id: session.userId })} /></>; }
    finally { db.close(); }
  } catch {
    return <section className="mx-auto max-w-3xl p-8"><h1 className="text-2xl font-semibold">高级账本暂不可用</h1><p className="mt-4">请核对数据库和恢复状态。系统不会自动创建现金、账户或替换旧库。</p></section>;
  }
}
