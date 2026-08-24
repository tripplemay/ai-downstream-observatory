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
import { pct } from "@/lib/format";
import {
  getPaperAccount,
  getPaperNavSeries,
  getPaperPositions,
  getPaperTrades,
  getSeries,
  getTheme,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "模拟盘" };

function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 序列最大回撤（负数） */
function maxDrawdown(series: Array<{ d: string; v: number }>): number | null {
  if (series.length < 2) return null;
  let peak = series[0].v;
  let mdd = 0;
  for (const p of series) {
    if (p.v > peak) peak = p.v;
    if (peak > 0) mdd = Math.min(mdd, p.v / peak - 1);
  }
  return mdd;
}

function PnlText({ v, suffix }: { v: number | null; suffix?: string }) {
  if (v === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={cn(
        "font-medium",
        v >= 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"
      )}
    >
      {v >= 0 ? "+" : ""}
      {v.toFixed(2)}
      {suffix}
    </span>
  );
}

export default async function PaperPage({
  params,
}: {
  params: Promise<{ theme: string }>;
}) {
  const { theme } = await params;
  const t = getTheme(theme);
  if (!t || t.type !== "strategy") notFound();
  const account = getPaperAccount();

  if (!account) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            模拟盘未初始化，等待 worker 创建账户。
          </CardContent>
        </Card>
      </div>
    );
  }

  const positions = getPaperPositions(account.id);
  const trades = getPaperTrades(account.id, 50);
  const navSeries = getPaperNavSeries(account.initial_cash);
  const paperAbs = getSeries("paper:nav");
  const advAbs = getSeries("adv:nav");
  const latestNav = paperAbs.length ? paperAbs[paperAbs.length - 1].v : null;
  const cumRet = latestNav !== null ? latestNav / account.initial_cash - 1 : null;
  const cashPct = latestNav !== null && latestNav > 0 ? account.cash / latestNav : null;
  const mdd = maxDrawdown(paperAbs);
  const advLatest = advAbs.length ? advAbs[advAbs.length - 1].v : null;
  const excess =
    latestNav !== null && advLatest !== null
      ? latestNav / account.initial_cash - advLatest
      : null;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        次日收盘成交 · 佣金万 1 · 100 股整手 · QDII 溢价已含在场内价格中
      </p>

      {/* 概览 */}
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>总资产</CardDescription>
            <CardTitle className="text-2xl">{money(latestNav)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            初始 {money(account.initial_cash)} · {account.name}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>累计收益</CardDescription>
            <CardTitle
              className={cn(
                "text-2xl",
                cumRet !== null &&
                  (cumRet >= 0
                    ? "text-red-600 dark:text-red-400"
                    : "text-emerald-600 dark:text-emerald-400")
              )}
            >
              {pct(cumRet)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {paperAbs.length ? `截至 ${paperAbs[paperAbs.length - 1].d}` : "—"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>现金</CardDescription>
            <CardTitle className="text-2xl">{money(account.cash)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            占比 {cashPct !== null ? `${(cashPct * 100).toFixed(1)}%` : "—"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>最大回撤</CardDescription>
            <CardTitle
              className={cn(
                "text-2xl",
                mdd !== null &&
                  mdd < 0 &&
                  "text-emerald-600 dark:text-emerald-400"
              )}
            >
              {mdd !== null ? `${(mdd * 100).toFixed(2)}%` : "—"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">由净值序列计算</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>相对理想建议超额</CardDescription>
            <CardTitle
              className={cn(
                "text-2xl",
                excess !== null &&
                  (excess >= 0
                    ? "text-red-600 dark:text-red-400"
                    : "text-emerald-600 dark:text-emerald-400")
              )}
            >
              {excess !== null ? `${excess >= 0 ? "+" : ""}${(excess * 100).toFixed(2)}pp` : "—"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">自模拟盘启动</CardContent>
        </Card>
      </div>

      {/* 净值对照 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">净值对照</CardTitle>
          <CardDescription>
            模拟盘（按初始资金归一，从 1 起）vs 理想建议（adv:nav）vs 沪深300ETF 基准
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NavCompareChart
            data={navSeries}
            lines={[
              { key: "paper", label: "模拟盘", color: "#dc2626" },
              { key: "adv", label: "理想建议", color: "#7c3aed" },
              { key: "bm", label: "沪深300ETF", color: "#2563eb" },
            ]}
          />
        </CardContent>
      </Card>

      {/* 当前持仓 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">当前持仓</CardTitle>
          <CardDescription>{positions.length} 只</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {positions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">全部持币。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>代码</TableHead>
                  <TableHead className="text-right">股数</TableHead>
                  <TableHead className="text-right">成本价</TableHead>
                  <TableHead className="text-right">最新价</TableHead>
                  <TableHead className="text-right">市值</TableHead>
                  <TableHead className="text-right">浮动盈亏</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((p) => (
                  <TableRow key={p.code}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{p.code}</TableCell>
                    <TableCell className="text-right text-xs">
                      {p.shares.toLocaleString("en-US")}
                    </TableCell>
                    <TableCell className="text-right text-xs">{p.cost.toFixed(4)}</TableCell>
                    <TableCell className="text-right text-xs">
                      {p.lastPx !== null ? p.lastPx.toFixed(4) : "—"}
                      {p.lastPxDate && (
                        <div className="text-[10px] text-muted-foreground">{p.lastPxDate}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs">{money(p.mktval)}</TableCell>
                    <TableCell className="text-right text-xs">
                      <div>
                        <PnlText v={p.pnl} />
                      </div>
                      <div>
                        {p.pnlPct !== null ? (
                          <span
                            className={cn(
                              p.pnlPct >= 0
                                ? "text-red-600 dark:text-red-400"
                                : "text-emerald-600 dark:text-emerald-400"
                            )}
                          >
                            {pct(p.pnlPct)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 交易流水 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">交易流水</CardTitle>
          <CardDescription>最近 {trades.length} 条（倒序）</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {trades.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">暂无交易。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">日期</TableHead>
                  <TableHead>买卖</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead className="text-right">股数</TableHead>
                  <TableHead className="text-right">价格</TableHead>
                  <TableHead className="text-right">费用</TableHead>
                  <TableHead>理由</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trades.map((tr) => (
                  <TableRow key={tr.id}>
                    <TableCell className="text-xs">{tr.date}</TableCell>
                    <TableCell>
                      <Badge variant={tr.side === "buy" ? "red" : "green"}>
                        {tr.side === "buy" ? "买入" : "卖出"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {tr.name}
                      <span className="ml-1 text-muted-foreground">{tr.code}</span>
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {tr.shares.toLocaleString("en-US")}
                    </TableCell>
                    <TableCell className="text-right text-xs">{tr.price.toFixed(4)}</TableCell>
                    <TableCell className="text-right text-xs">{tr.fee.toFixed(2)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{tr.note}</TableCell>
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
