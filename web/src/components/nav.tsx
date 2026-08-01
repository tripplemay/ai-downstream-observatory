"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BookOpen,
  Briefcase,
  ClipboardList,
  FileText,
  LayoutDashboard,
  LineChart,
  TrafficCone,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const NAV_ITEMS = [
  { href: "/", label: "总览", icon: LayoutDashboard },
  { href: "/signals", label: "信号", icon: Activity },
  { href: "/snapshots", label: "快照", icon: LineChart },
  { href: "/reports", label: "报告", icon: FileText },
  { href: "/observations", label: "观测记录", icon: ClipboardList },
  { href: "/thesis", label: "判断与规则", icon: BookOpen },
  { href: "/pool", label: "标的池", icon: Briefcase },
];

export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1 px-3">
      {NAV_ITEMS.map((item) => {
        const active =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
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
    <div className="flex items-center gap-2 px-5 py-4">
      <TrafficCone className="h-5 w-5 text-red-500" />
      <span className="text-sm font-semibold tracking-tight">AI 下游投资观测台</span>
    </div>
  );
}
