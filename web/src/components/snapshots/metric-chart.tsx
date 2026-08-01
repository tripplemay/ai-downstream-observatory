"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer } from "@/components/chart";
import { shortNum } from "@/lib/format";

/** 单指标折线（面积渐变 + hover 十字线） */
export function MetricChart({
  data,
  color = "#2563eb",
}: {
  data: Array<{ d: string; v: number }>;
  color?: string;
}) {
  const gid = `g-${Math.random().toString(36).slice(2, 8)}`;
  if (data.length < 2) {
    return <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">数据点不足</div>;
  }
  return (
    <ChartContainer config={{ v: { color } }} className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
          <XAxis
            dataKey="d"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            tickFormatter={(d: string) => d.slice(2)}
            minTickGap={40}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            tickFormatter={shortNum}
            domain={["auto", "auto"]}
            width={56}
          />
          <Tooltip
            cursor={{ stroke: color, strokeWidth: 1 }}
            formatter={(value) => [shortNum(Number(value)), "数值"]}
            labelFormatter={(label) => `期间 ${label}`}
            contentStyle={{
              borderRadius: 8,
              border: "1px solid hsl(var(--border))",
              background: "hsl(var(--popover))",
              color: "hsl(var(--popover-foreground))",
              fontSize: 12,
            }}
          />
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.8} fill={`url(#${gid})`} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
}
