"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** 轻量 shadcn chart 封装：注入 config 里的颜色 CSS 变量，配合 Recharts 使用 */
export type ChartConfig = Record<string, { label?: string; color?: string }>;

export function ChartContainer({
  config,
  className,
  children,
}: {
  config: ChartConfig;
  className?: string;
  children: React.ReactNode;
}) {
  const style: Record<string, string> = {};
  for (const [key, item] of Object.entries(config)) {
    if (item.color) style[`--color-${key}`] = item.color;
  }
  return (
    <div className={cn("w-full", className)} style={style as React.CSSProperties}>
      {children}
    </div>
  );
}
