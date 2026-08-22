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

/** 建议组合净值 vs 沪深300ETF 基准净值 对照折线 */
export function NavCompareChart({
  data,
}: {
  data: Array<{ d: string; adv: number | null; bm: number | null }>;
}) {
  if (data.length < 2) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        数据点不足（每日运行后积累净值序列）
      </div>
    );
  }
  return (
    <ChartContainer
      config={{ adv: { color: "#dc2626" }, bm: { color: "#2563eb" } }}
      className="h-64"
    >
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
            tickFormatter={(v: number) => v.toFixed(3)}
            domain={["auto", "auto"]}
            width={56}
          />
          <Tooltip
            formatter={(value, name) => [
              Number(value).toFixed(4),
              name === "adv" ? "建议组合" : "沪深300ETF",
            ]}
            labelFormatter={(label) => `日期 ${label}`}
            contentStyle={{
              borderRadius: 8,
              border: "1px solid hsl(var(--border))",
              background: "hsl(var(--popover))",
              color: "hsl(var(--popover-foreground))",
              fontSize: 12,
            }}
          />
          <Legend formatter={(v) => (v === "adv" ? "建议组合" : "沪深300ETF")} />
          <Line
            type="monotone"
            dataKey="adv"
            stroke="#dc2626"
            strokeWidth={1.8}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="bm"
            stroke="#2563eb"
            strokeWidth={1.8}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
}
