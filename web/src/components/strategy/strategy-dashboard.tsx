/** 策略型主题仪表盘（server component）：状态灯 + 当前建议 + 净值对照 + 市场宽度 + 参数 */
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { lightBlockClass } from "@/components/light";
import { Sparkline } from "@/components/sparkline";
import { NavCompareChart } from "@/components/advice/nav-compare-chart";
import { StrategyParamsForm } from "@/components/strategy/params-form";
import { lightName } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  getAdviceCurrent,
  getMarketWidth,
  getNavCompareFull,
  getOverview,
  getStrategyParams,
  getStrategyParamsHistory,
} from "@/lib/queries";

export function StrategyDashboard({ themeId }: { themeId: string }) {
  const overview = getOverview(themeId);
  const advice = getAdviceCurrent();
  const navFull = getNavCompareFull();
  const width = getMarketWidth();
  const params = getStrategyParams(themeId);
  const paramsHistory = getStrategyParamsHistory(themeId);
  const light = overview?.light ?? "red";
  const cash = advice ? Math.max(0, 1 - advice.basket.reduce((s, b) => s + b.weight, 0)) : 1;

  return (
    <div className="space-y-6">
      {/* 策略状态灯（规则引擎输出：green 正常 / yellow 超额走弱 / red 失效预警） */}
      <div className={cn("rounded-xl p-6 shadow-sm md:p-8", lightBlockClass(light))}>
        <div className="text-xs font-medium uppercase tracking-widest opacity-80">策略状态</div>
        <div className="mt-1 text-4xl font-bold md:text-5xl">{lightName(light)}</div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed opacity-90 md:text-base">
          {overview?.conclusion ?? "—"}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 当前建议组合摘要 */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">当前建议组合</CardTitle>
            <CardDescription>
              {advice ? `建议日期 ${advice.date}` : "尚无建议记录"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {advice && advice.basket.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {advice.basket.map((b) => (
                  <div
                    key={b.code}
                    className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                  >
                    <span className="font-medium">{b.name}</span>
                    <span className="text-xs text-muted-foreground">{b.code}</span>
                    <Badge variant="blue">{(b.weight * 100).toFixed(1)}%</Badge>
                  </div>
                ))}
                {cash > 0.001 && (
                  <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
                    <span>现金</span>
                    <Badge variant="secondary">{(cash * 100).toFixed(1)}%</Badge>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">当前无合格标的，全部持币。</p>
            )}
            <Link
              href={`/${themeId}/advice`}
              className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400"
            >
              查看详情 <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </CardContent>
        </Card>

        {/* 市场宽度 */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">市场宽度</CardTitle>
            <CardDescription>站上 200 日线的 ETF 占比（全宇宙）· 近 60 日</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-3xl font-bold">
              {width.latest ? `${width.latest.v.toFixed(1)}%` : "—"}
              {width.latest && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {width.latest.d}
                </span>
              )}
            </div>
            <Sparkline data={width.series} color="#0d9488" height={48} />
          </CardContent>
        </Card>
      </div>

      {/* 净值对照：实盘建议 vs 基准 vs 回测模拟 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">净值对照</CardTitle>
          <CardDescription>
            回测模拟（2020 起全历史）vs 实盘建议（自 2026-08-21）vs 沪深300ETF 基准
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NavCompareChart
            data={navFull}
            lines={[
              { key: "sim", label: "回测模拟", color: "#7c3aed" },
              { key: "adv", label: "实盘建议", color: "#dc2626" },
              { key: "bm", label: "沪深300ETF", color: "#2563eb" },
            ]}
          />
        </CardContent>
      </Card>

      {/* 策略参数 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">策略参数</CardTitle>
          <CardDescription>追加式版本管理，最新一条生效；改参数必须留痕写理由</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {params ? (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {Object.keys(params.params).map((k) => (
                      <TableHead key={k} className="whitespace-nowrap">
                        {k}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    {Object.values(params.params).map((v, i) => (
                      <TableCell key={i} className="text-sm font-medium">
                        {String(v)}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">尚无参数版本。</p>
          )}
          <StrategyParamsForm
            themeId={themeId}
            currentJson={params ? JSON.stringify(params.params, null, 2) : "{}"}
          />
          {paramsHistory.length > 0 && (
            <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
              <div className="font-medium text-foreground">版本历史</div>
              {paramsHistory.map((p) => (
                <div key={p.id}>
                  #{p.id} · {p.created_at} · {p.note || "（无理由）"}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
