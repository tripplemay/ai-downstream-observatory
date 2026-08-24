"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer } from "@/components/chart";

export interface NavLine {
  key: string;
  label: string;
  color: string;
}

/** 净值对照折线（任意条线，缺数日期 connectNulls 跨接） */
export function NavCompareChart({
  data,
  lines,
}: {
  data: Array<Record<string, number | string | null>>;
  lines: NavLine[];
}) {
  if (data.length < 2) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        数据点不足（每日运行后积累净值序列）
      </div>
    );
  }
  const labelOf = (k: string) => lines.find((l) => l.key === k)?.label ?? k;
  const config = Object.fromEntries(lines.map((l) => [l.key, { color: l.color }]));
  return (
    <ChartContainer config={config} className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
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
            tickFormatter={(v: number) => v.toFixed(2)}
            domain={["auto", "auto"]}
            width={56}
          />
          <Tooltip
            formatter={(value, name) => [Number(value).toFixed(4), labelOf(String(name))]}
            labelFormatter={(label) => `日期 ${label}`}
            contentStyle={{
              borderRadius: 8,
              border: "1px solid hsl(var(--border))",
              background: "hsl(var(--popover))",
              color: "hsl(var(--popover-foreground))",
              fontSize: 12,
            }}
          />
          <Legend formatter={(v) => labelOf(String(v))} />
          {lines.map((l) => (
            <Line
              key={l.key}
              type="monotone"
              dataKey={l.key}
              stroke={l.color}
              strokeWidth={1.8}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
}
