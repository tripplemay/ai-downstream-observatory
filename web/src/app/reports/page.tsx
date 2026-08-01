import type { Metadata } from "next";
export const dynamic = "force-dynamic";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LightBadge } from "@/components/light";
import { getReports } from "@/lib/queries";

export const metadata: Metadata = { title: "AI 报告" };

export default function ReportsPage() {
  const reports = getReports();
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        由定时任务自动运行生成（月度纪要 / 季度结构化核对）。
      </p>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>运行日期</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>信号灯</TableHead>
              <TableHead className="hidden md:table-cell">生成时间</TableHead>
              <TableHead className="hidden md:table-cell">摘要</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {reports.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap font-medium">{r.run_date}</TableCell>
                <TableCell>
                  <Badge variant={r.run_type === "quarterly" ? "violet" : "blue"}>
                    {r.run_type === "quarterly" ? "季度核对" : "月度纪要"}
                  </Badge>
                </TableCell>
                <TableCell>{r.light ? <LightBadge light={r.light} /> : "—"}</TableCell>
                <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">{r.created_at}</TableCell>
                <TableCell className="hidden max-w-64 md:table-cell">
                  <span className="line-clamp-1 text-xs text-muted-foreground">
                    {r.narrative.slice(0, 60)}…
                  </span>
                </TableCell>
                <TableCell>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/reports/${r.id}`}>查看</Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {reports.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  暂无报告，先运行 <code>./jobs/run_job.sh monthly</code>。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
