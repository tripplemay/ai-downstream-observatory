import Link from "next/link";
import { Separator } from "@/components/ui/separator";
import { Brand } from "@/components/nav";

export function AppSidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r bg-sidebar md:flex">
      <Brand />
      <Separator className="bg-sidebar-border" />
      <div className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
        <Link href="/workbench" className="block rounded-md px-3 py-2 text-sm hover:bg-accent">ETF 投资工作台</Link>
        <Link href="/workbench/funding" className="block rounded-md px-3 py-2 text-sm hover:bg-accent">资金计划与投入批次</Link>
        <Link href="/workbench/catalog" className="block rounded-md px-3 py-2 text-sm hover:bg-accent">ETF 标的与持仓比较</Link>
        <Link href="/workbench/research" className="block rounded-md px-3 py-2 text-sm hover:bg-accent">策略研究与 AI</Link>
        <Link href="/workbench/governance" className="block rounded-md px-3 py-2 text-sm hover:bg-accent">政策与执行审批</Link>
        <Link href="/workbench/evaluations" className="block rounded-md px-3 py-2 text-sm hover:bg-accent">月度策略评估</Link>
        <Link href="/legacy" className="block rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent">历史研究档案</Link>
      </div>
      <div className="px-5 py-4 text-xs text-muted-foreground">
        真实账户与研究结果隔离
      </div>
    </aside>
  );
}
