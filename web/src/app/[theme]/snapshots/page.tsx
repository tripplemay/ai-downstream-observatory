import type { Metadata } from "next";
export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MetricChart } from "@/components/snapshots/metric-chart";
import { fmtNum } from "@/lib/format";
import { getMetricGroups, getTheme } from "@/lib/queries";

export const metadata: Metadata = { title: "数据快照" };

const CHART_COLORS = ["#2563eb", "#7c3aed", "#0d9488", "#dc2626", "#d97706", "#059669", "#db2777"];

export default async function SnapshotsPage({
  params,
}: {
  params: Promise<{ theme: string }>;
}) {
  const { theme } = await params;
  if (!getTheme(theme)) notFound();
  const groups = getMetricGroups(theme);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        由 worker/fetch_data.py 自动抓取的公开数据（SEC EDGAR / yfinance / TWSE），同一指标同一期幂等覆盖。
      </p>
      {groups.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            暂无快照数据，先运行 <code>./jobs/run_job.sh monthly</code> 抓取。
          </CardContent>
        </Card>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {groups.map((m, i) => (
          <Card key={m.key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{m.label}</CardTitle>
              <CardDescription className="flex items-center gap-2">
                <Badge variant="secondary">{m.source}</Badge>
                <span>{m.unit}</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <MetricChart data={m.points} color={CHART_COLORS[i % CHART_COLORS.length]} />
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>期间</TableHead>
                    <TableHead>数值</TableHead>
                    <TableHead>抓取时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {m.rows.map((r) => (
                    <TableRow key={r.d}>
                      <TableCell className="text-xs">{r.d}</TableCell>
                      <TableCell className="text-xs font-medium">{fmtNum(r.v)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.ts}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
