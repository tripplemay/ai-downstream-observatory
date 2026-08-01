"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Brand, NAV_ITEMS, NavLinks, navHref, themeSlugFromPath } from "@/components/nav";
import { ThemeToggle } from "@/components/theme-toggle";

export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const slug = themeSlugFromPath(pathname);
  const current = slug
    ? NAV_ITEMS.find((i) => {
        const href = navHref(slug, i.path);
        return i.path === "/" ? pathname === href : pathname.startsWith(href);
      })
    : null;
  const title = slug ? (current ?? NAV_ITEMS[0]).label : "首页";
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
          <div className="py-3">
            <NavLinks onNavigate={() => setOpen(false)} />
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
