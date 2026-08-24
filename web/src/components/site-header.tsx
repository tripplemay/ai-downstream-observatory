"use client";

import * as React from "react";
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
  const title = slug ? (current ?? ALL_NAV_ITEMS[0]).label : "首页";
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
            {nav}
          </div>
        </SheetContent>
      </Sheet>
      <h1 className="text-sm font-semibold">{title}</h1>
      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
      </div>
    </header>
  );
}
