export const dynamic = "force-dynamic";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LightDot, lightBlockClass } from "@/components/light";
import { Sparkline } from "@/components/sparkline";
import { lightName, pct } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  getLastObservation,
  getLastReport,
  getOverview,
  getScissorData,
  getStatusCounts,
  getStrengthData,
  getTheme,
  lastJobStatus,
} from "@/lib/queries";

const LAYER_CARDS: Array<{ key: "layer1" | "layer2" | "layer3"; title: string; badge: string }> = [
  { key: "layer1", title: "第一层 上游趋同", badge: "blue" },
  { key: "layer2", title: "第二层 下游利润", badge: "violet" },
  { key: "layer3", title: "第三层 平台归属", badge: "teal" },
];

export default async function ThemeDashboardPage({
  params,
}: {
  params: Promise<{ theme: string }>;
}) {
  const { theme } = await params;
  if (!getTheme(theme)) notFound();
  const overview = getOverview(theme);
  const lastObs = getLastObservation(theme);
  const counts = getStatusCounts(theme);
  const lastReport = getLastReport(theme);
  const lastStatus = lastJobStatus();
  const scissor = getScissorData(theme);
  const strength = getStrengthData(theme);
  const light = overview?.light ?? "red";
  const failed = lastStatus?.includes("FAILED") ?? false;

  return (
    <div className="space-y-6">
      {/* Hero 信号灯 */}
      <div className={cn("rounded-xl p-6 shadow-sm md:p-8", lightBlockClass(light))}>
        <div className="text-xs font-medium uppercase tracking-widest opacity-80">当前信号灯</div>
        <div className="mt-1 text-4xl font-bold md:text-5xl">{lightName(light)}</div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed opacity-90 md:text-base">
          {overview?.conclusion ?? "—"}
        </p>
        <div className="mt-4 text-xs opacity-75">
          {lastObs ? `最近核对：${lastObs.date}` : "尚无核对记录"}
        </div>
      </div>

      {/* 三层判断 + 最近自动运行 */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {LAYER_CARDS.map(({ key, title, badge }) => {
          const status = overview?.[`${key}_status`];
          const evidence = overview?.[`${key}_evidence`];
          return (
            <Card key={key}>
              <CardHeader className="pb-2">
                <CardDescription>{title}</CardDescription>
                <CardTitle>
                  <Badge variant={badge as "blue"}>{status ?? "—"}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="line-clamp-4 text-sm text-muted-foreground">{evidence ?? "—"}</p>
              </CardContent>
            </Card>
          );
        })}
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>最近自动运行</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              {lastReport ? (
                <>
                  {lastReport.light && <LightDot light={lastReport.light} />}
                  <span>{lastReport.run_date}</span>
                  <Badge variant="secondary">
                    {lastReport.run_type === "quarterly" ? "季度核对" : "月度纪要"}
                  </Badge>
                </>
              ) : (
                <span className="text-muted-foreground">尚未运行</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {lastStatus && (
              <p className={cn("flex items-start gap-1.5", failed ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground")}>
                {failed && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                <span className="break-all">{lastStatus}</span>
              </p>
            )}
            {lastReport && (
              <Link href={`/${theme}/reports/${lastReport.id}`} className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400">
                查看报告 <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 关键指标速览：剪刀差 + 上下游强弱（主题一专属图表） */}
      {scissor && strength && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">云厂商剪刀差（C4）</CardTitle>
              <CardDescription>最近季度 Capex 同比 vs 收入同比 · 缺口为正代表剪刀差未收敛</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {scissor.map((c) => {
                const gap =
                  c.capexYoY !== null && c.revenueYoY !== null ? c.capexYoY - c.revenueYoY : null;
                return (
                  <div key={c.ticker} className="flex items-center gap-4">
                    <div className="w-16 shrink-0">
                      <div className="text-sm font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">{c.period}</div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <Sparkline data={c.capex} color="#ef4444" height={36} />
                    </div>
                    <div className="w-40 shrink-0 text-right text-xs leading-5">
                      <div>
                        Capex <span className="font-semibold text-red-600 dark:text-red-400">{pct(c.capexYoY)}</span>
                      </div>
                      <div>
                        收入 <span className="font-semibold">{pct(c.revenueYoY)}</span>
                      </div>
                    </div>
                    <Badge variant={gap !== null && gap > 0 ? "red" : "green"} className="w-20 justify-center">
                      差 {pct(gap)}
                    </Badge>
                  </div>
                );
              })}
              {scissor.every((c) => c.capex.length === 0) && (
                <p className="text-sm text-muted-foreground">暂无数据，等待 fetch_data 抓取。</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">上下游相对强弱（C7）</CardTitle>
              <CardDescription>近 3 个月涨跌幅 · 下游（软件/中概）vs 上游（半导体/纳指科技）</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {strength.map((s) => (
                <div key={s.key} className="flex items-center gap-4">
                  <div className="w-36 shrink-0">
                    <div className="truncate text-sm font-medium">{s.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.side === "down" ? "下游" : "上游"} · {s.period}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <Sparkline
                      data={s.series}
                      color={s.chg !== null && s.chg >= 0 ? "#10b981" : "#ef4444"}
                      height={36}
                    />
                  </div>
                  <span
                    className={cn(
                      "w-16 shrink-0 text-right text-sm font-semibold",
                      s.chg !== null && s.chg >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400"
                    )}
                  >
                    {pct(s.chg)}
                  </span>
                </div>
              ))}
              {strength.every((s) => s.series.length === 0) && (
                <p className="text-sm text-muted-foreground">暂无数据，等待 fetch_data 抓取。</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* 状态统计 */}
      <div className="flex flex-wrap gap-2">
        <Badge variant="green">已验证 {counts["已验证"] ?? 0}</Badge>
        <Badge variant="yellow">验证中 {counts["验证中"] ?? 0}</Badge>
        <Badge variant="secondary">未验证 {counts["未验证"] ?? 0}</Badge>
        <Badge variant="red">反向 {counts["反向"] ?? 0}</Badge>
        <Badge variant="red">已触发(证伪) {counts["已触发"] ?? 0}</Badge>
        <Badge variant="secondary">未触发(证伪) {counts["未触发"] ?? 0}</Badge>
      </div>
    </div>
  );
}
