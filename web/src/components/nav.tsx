"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BookOpen,
  Briefcase,
  ClipboardList,
  FileText,
  Home,
  LayoutDashboard,
  Lightbulb,
  LineChart,
  Radar,
  TrafficCone,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** path 为主题内相对路径；实际 href 由当前路径第一段（theme slug）拼前缀 */
export const NAV_ITEMS = [
  { path: "/", label: "总览", icon: LayoutDashboard },
  { path: "/signals", label: "信号", icon: Activity },
  { path: "/snapshots", label: "快照", icon: LineChart },
  { path: "/reports", label: "报告", icon: FileText },
  { path: "/observations", label: "观测记录", icon: ClipboardList },
  { path: "/thesis", label: "判断与规则", icon: BookOpen },
  { path: "/pool", label: "标的池", icon: Briefcase },
];

/** etf-universe 主题专属页面 */
const ETF_UNIVERSE_ITEMS = [
  { path: "/universe", label: "监测", icon: Radar },
  { path: "/advice", label: "建议", icon: Lightbulb },
];

/** 当前路径的第一段即主题 slug；根路径视为不在主题内 */
export function themeSlugFromPath(pathname: string): string | null {
  const seg = pathname.split("/")[1] ?? "";
  return seg || null;
}

export function navHref(slug: string, path: string): string {
  return `/${slug}${path === "/" ? "" : path}`;
}

export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const slug = themeSlugFromPath(pathname);
  const items = slug
    ? [...NAV_ITEMS, ...(slug === "etf-universe" ? ETF_UNIVERSE_ITEMS : [])].map((item) => ({
        ...item,
        href: navHref(slug, item.path),
      }))
    : [{ href: "/", label: "首页", icon: Home }];
  return (
    <nav className="flex flex-col gap-1 px-3">
      {items.map((item) => {
        const active =
          item.href === "/" || item.href === `/${slug}`
            ? pathname === item.href
            : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              active
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-accent/60"
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 px-5 py-4">
      <TrafficCone className="h-5 w-5 text-red-500" />
      <span className="text-sm font-semibold tracking-tight">投资观测台</span>
    </Link>
  );
}
