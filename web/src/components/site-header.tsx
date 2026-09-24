"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ALL_NAV_ITEMS, Brand, navHref, themeSlugFromPath } from "@/components/nav";
import { ThemeToggle } from "@/components/theme-toggle";

/** nav 为 server 侧注入的 NavLinksLoader 节点（带 slug→type 映射） */
export function SiteHeader({ nav }: { nav?: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const slug = themeSlugFromPath(pathname);
  const current = slug
    ? ALL_NAV_ITEMS.find((i) => {
        const href = navHref(slug, i.path);
        return i.path === "/" ? pathname === href : pathname.startsWith(href);
      })
    : null;
  const title = pathname.startsWith("/workbench") ? "ETF 投资工作台" : slug ? (current ?? ALL_NAV_ITEMS[0]).label : "首页";
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur md:px-6">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="打开导航">
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent className="bg-sidebar p-0">
          <SheetTitle className="sr-only">导航菜单</SheetTitle>
          <div onClick={() => setOpen(false)}>
            <Brand />
          </div>
          <div className="py-3" onClick={() => setOpen(false)}>
            {nav ?? <nav className="space-y-2 px-4">
              <Link className="block px-3 py-2 text-sm" href="/workbench">ETF 投资工作台</Link>
              <Link className="block px-3 py-2 text-sm" href="/workbench/funding">资金计划与投入批次</Link>
              <Link className="block px-3 py-2 text-sm" href="/workbench/catalog">ETF 标的与持仓比较</Link>
              <Link className="block px-3 py-2 text-sm" href="/workbench/research">策略研究与 AI</Link>
              <Link className="block px-3 py-2 text-sm" href="/workbench/governance">政策与执行审批</Link>
              <Link className="block px-3 py-2 text-sm" href="/workbench/verifications">受控工程子检查</Link>
              <Link className="block px-3 py-2 text-sm" href="/legacy">历史研究档案</Link>
            </nav>}
          </div>
        </SheetContent>
      </Sheet>
      <p className="text-sm font-semibold">{title}</p>
      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
      </div>
    </header>
  );
}
