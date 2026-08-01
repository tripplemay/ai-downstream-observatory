/** 数值与信号灯展示辅助（移植自 Flask app.py） */

export const LIGHT_NAMES: Record<string, string> = {
  red: "红灯",
  yellow: "黄灯",
  green: "绿灯",
};

export function lightName(light: string | null | undefined): string {
  return (light && LIGHT_NAMES[light]) || "—";
}

export function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return v
    .toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 3 })
    .replace(/\.0+$/, "");
}

export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
}

export function shortNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return v.toFixed(2);
}
