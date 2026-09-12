import { requireSession } from "@/server/auth/session";

export default async function LegacyThemeLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  return <><div className="mb-5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">历史研究档案（只读）。旧建议、参数与模拟收益不属于新工作台的实盘策略或真实账户表现。</div>{children}</>;
}
