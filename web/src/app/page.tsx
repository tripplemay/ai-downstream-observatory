export const dynamic = "force-dynamic";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LightDot } from "@/components/light";
import {
  getLastObservation,
  getLastReport,
  getOverview,
  getThemes,
} from "@/lib/queries";

export default function HomePage() {
  const themes = getThemes();
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">投资观测台</h2>
        <p className="text-sm text-muted-foreground">按主题跟踪证实/证伪信号，选择主题进入。</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {themes.map((t) => {
          const overview = getOverview(t.id);
          const lastObs = getLastObservation(t.id);
          const lastReport = getLastReport(t.id);
          return (
            <Link key={t.id} href={`/${t.id}`} className="group">
              <Card className="h-full transition-colors group-hover:border-foreground/30">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <LightDot light={overview?.light ?? ""} />
                    {t.name}
                    <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </CardTitle>
                  {t.description && <CardDescription>{t.description}</CardDescription>}
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="line-clamp-2 text-sm">{overview?.conclusion ?? "—"}</p>
                  <div className="text-xs text-muted-foreground">
                    {lastObs ? `最近观测：${lastObs.date}` : "尚无观测记录"}
                    <span className="mx-1.5">·</span>
                    {lastReport ? `最近报告：${lastReport.run_date}` : "尚无报告"}
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
        {themes.length === 0 && (
          <p className="text-sm text-muted-foreground">暂无启用的主题。</p>
        )}
      </div>
    </div>
  );
}
