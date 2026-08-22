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
import { pct } from "@/lib/format";
import { getAdviceCurrent, getUniverseMonitor } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "全行业监测" };

const THEME = "etf-universe";
const CAT_ORDER = ["行业主题", "宽基/策略", "跨境"];

export default async function UniversePage({
  params,
}: {
  params: Promise<{ theme: string }>;
}) {
  const { theme } = await params;
  if (theme !== THEME) notFound();
  const rows = getUniverseMonitor();
  const advice = getAdviceCurrent();

  const above = rows.filter((r) => r.aboveMa200 === true).length;
  const abovePct = rows.length ? above / rows.length : null;
  const cats = [
    ...CAT_ORDER.filter((c) => rows.some((r) => r.cat === c)),
    ...[...new Set(rows.map((r) => r.cat))].filter((c) => !CAT_ORDER.includes(c)),
  ];

  return (
    <div className="space-y-4">
      {/* 摘要行 */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-card p-4 text-sm shadow-sm">
        <span>
          宇宙总数 <span className="font-semibold">{rows.length}</span>
        </span>
        <span>
          站上 200 日线{" "}
          <span className="font-semibold">
            {above} 只{abovePct !== null && `（${(abovePct * 100).toFixed(0)}%）`}
          </span>
        </span>
        <span>
          当前建议持有{" "}
          {advice && advice.basket.length > 0 ? (
            <span className="font-semibold">
              {advice.basket.map((b) => `${b.name}(${(b.weight * 100).toFixed(0)}%)`).join("、")}
            </span>
          ) : (
            <span className="text-muted-foreground">无（全部持币）</span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">按 20 日动量降序</span>
      </div>

      {rows.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            宇宙为空，先运行 worker 构建 etf_universe。
          </CardContent>
        </Card>
      )}

      {cats.map((cat) => {
        const group = rows.filter((r) => r.cat === cat);
        return (
          <Card key={cat}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{cat}</CardTitle>
              <CardDescription>{group.length} 只</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>代码</TableHead>
                    <TableHead className="text-right">最新价</TableHead>
                    <TableHead className="text-right">20日动量</TableHead>
                    <TableHead>200日线</TableHead>
                    <TableHead className="text-right">PE分位</TableHead>
                    <TableHead className="text-right">规模(亿)</TableHead>
                    <TableHead>建议持有</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.map((r) => (
                    <TableRow key={r.code}>
                      <TableCell className="max-w-56 truncate font-medium">{r.name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.code}</TableCell>
                      <TableCell className="text-right text-xs">
                        {r.lastPx !== null ? r.lastPx.toFixed(3) : "—"}
                        {r.lastPxDate && (
                          <div className="text-[10px] text-muted-foreground">{r.lastPxDate}</div>
                        )}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-medium",
                          r.mom20 === null
                            ? "text-muted-foreground"
                            : r.mom20 >= 0
                              ? "text-red-600 dark:text-red-400"
                              : "text-emerald-600 dark:text-emerald-400"
                        )}
                      >
                        {pct(r.mom20)}
                      </TableCell>
                      <TableCell>
                        {r.aboveMa200 === null ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : r.aboveMa200 ? (
                          <Badge variant="green">站上</Badge>
                        ) : (
                          <Badge variant="secondary">跌破</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {r.pePct !== null ? (
                          <span
                            className={cn(
                              "rounded px-1",
                              (r.pePct < 10 || r.pePct > 90) &&
                                "bg-yellow-200/70 font-medium dark:bg-yellow-500/25"
                            )}
                          >
                            {r.pePct.toFixed(0)}%
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {r.mktcap !== null ? (r.mktcap / 1e8).toFixed(1) : "—"}
                      </TableCell>
                      <TableCell>
                        {r.held ? (
                          <Badge variant="blue">
                            持有{r.heldWeight !== null && ` ${(r.heldWeight * 100).toFixed(0)}%`}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
