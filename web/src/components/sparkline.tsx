"use client";

import { Area, AreaChart, ResponsiveContainer } from "recharts";

/** 迷你面积图（sparkline），无坐标轴 */
export function Sparkline({
  data,
  color = "#2563eb",
  height = 48,
}: {
  data: Array<{ d: string; v: number }>;
  color?: string;
  height?: number;
}) {
  if (data.length < 2) return null;
  const id = `spark-${color.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#${id})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
