"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { Theme } from "@/lib/queries";

/** 侧栏"主题"列表：链接到 /[slug]，当前主题高亮 */
export function ThemeLinks({ themes }: { themes: Theme[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1 px-3">
      {themes.map((t) => {
        const href = `/${t.id}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={t.id}
            href={href}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              active
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-accent/60"
            )}
          >
            {t.name}
          </Link>
        );
      })}
    </nav>
  );
}
