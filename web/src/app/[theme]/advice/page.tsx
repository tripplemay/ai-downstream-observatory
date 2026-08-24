import type { Metadata } from "next";
export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
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
import { NavCompareChart } from "@/components/advice/nav-compare-chart";
import { getAdviceCurrent, getAdviceHistory, getAdviceNavSeries } from "@/lib/queries";

export const metadata: Metadata = { title: "轮动建议" };

const THEME = "etf-universe";

export default async function AdvicePage({
  params,
}: {
  params: Promise<{ theme: string }>;
}) {
  const { theme } = await params;
  if (theme !== THEME) notFound();
  const current = getAdviceCurrent();
  const navSeries = getAdviceNavSeries();
  const history = getAdviceHistory(50);
  const latestNav = [...navSeries].reverse().find((r) => r.adv !== null)?.adv ?? null;
  const latestBm = [...navSeries].reverse().find((r) => r.bm !== null)?.bm ?? null;
  const cash = current ? Math.max(0, 1 - current.basket.reduce((s, b) => s + b.weight, 0)) : 1;

  return (
    <div className="space-y-4">
      {/* 当前建议组合 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">当前建议组合</CardTitle>
          <CardDescription>
            {current ? `建议日期 ${current.date} · 生成于 ${current.created_at}` : "尚无建议记录"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {current && current.basket.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {current.basket.map((b) => (
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
          {current?.reason && (
            <p className="text-sm leading-relaxed text-muted-foreground">理由：{current.reason}</p>
          )}
        </CardContent>
      </Card>

      {/* 净值对照 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">建议净值 vs 沪深300ETF</CardTitle>
          <CardDescription>
            adv:nav 从 1 起算 · 最新{" "}
            <span className="font-medium text-foreground">
              {latestNav !== null ? latestNav.toFixed(4) : "—"}
            </span>{" "}
            · 基准{" "}
            <span className="font-medium text-foreground">
              {latestBm !== null ? latestBm.toFixed(4) : "—"}
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NavCompareChart
            data={navSeries}
            lines={[
              { key: "adv", label: "建议组合", color: "#dc2626" },
              { key: "bm", label: "沪深300ETF", color: "#2563eb" },
            ]}
          />
        </CardContent>
      </Card>

      {/* 历史建议 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">历史建议记录</CardTitle>
          <CardDescription>最近 {history.length} 条</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {history.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">暂无历史建议。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">日期</TableHead>
                  <TableHead>组合</TableHead>
                  <TableHead>理由</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="text-xs">{a.date}</TableCell>
                    <TableCell className="text-xs">
                      {a.basket.length > 0
                        ? a.basket
                            .map((b) => `${b.name} ${(b.weight * 100).toFixed(0)}%`)
                            .join("、")
                        : "空仓（全部持币）"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{a.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
