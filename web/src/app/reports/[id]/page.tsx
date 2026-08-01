import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { LightBadge } from "@/components/light";
import { getReport } from "@/lib/queries";

export const metadata: Metadata = { title: "报告详情" };

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const report = getReport(Number(id));
  if (!report) notFound();

  return (
    <div className="space-y-4">
      <Link
        href="/reports"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> 返回报告列表
      </Link>
      <Card>
        <CardContent className="pt-6">
          <div className="mb-4 flex flex-wrap items-center gap-2 border-b pb-4">
            {report.light && <LightBadge light={report.light} />}
            <span className="font-semibold">{report.run_date}</span>
            <Badge variant={report.run_type === "quarterly" ? "violet" : "blue"}>
              {report.run_type === "quarterly" ? "季度核对" : "月度纪要"}
            </Badge>
            <span className="text-xs text-muted-foreground">生成于 {report.created_at}</span>
          </div>
          <article className="prose prose-sm max-w-none dark:prose-invert prose-table:text-xs">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.narrative}</ReactMarkdown>
          </article>
        </CardContent>
      </Card>
    </div>
  );
}
