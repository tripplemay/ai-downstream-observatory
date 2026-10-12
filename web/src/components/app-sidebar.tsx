import Link from "next/link";
import { Separator } from "@/components/ui/separator";
import { Brand } from "@/components/nav";
import { ADVANCED_NAVIGATION, INVESTOR_NAVIGATION } from "@/components/workbench/primary-navigation";

export function AppSidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r bg-sidebar md:flex">
      <Brand />
      <Separator className="bg-sidebar-border" />
      <div className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
        <nav aria-label="主要功能">{INVESTOR_NAVIGATION.map(item => <Link key={item.href} href={item.href} className="block rounded-md px-3 py-3 text-sm hover:bg-accent">{item.label}</Link>)}</nav>
        <details className="pt-4"><summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">高级 / 运营</summary><nav aria-label="高级功能" className="mt-2">{ADVANCED_NAVIGATION.map(item => <Link key={item.href} href={item.href} className="block rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent">{item.label}</Link>)}</nav></details>
      </div>
      <div className="px-5 py-4 text-xs text-muted-foreground">
        真实账户与研究结果隔离
      </div>
    </aside>
  );
}
