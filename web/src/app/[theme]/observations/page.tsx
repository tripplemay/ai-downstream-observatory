import type { Metadata } from "next";
export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { LightBadge } from "@/components/light";
import { ObservationForm } from "@/components/observations/observation-form";
import { getObservations, getTheme } from "@/lib/queries";

export const metadata: Metadata = { title: "观测记录" };

export default async function ObservationsPage({
  params,
}: {
  params: Promise<{ theme: string }>;
}) {
  const { theme } = await params;
  if (!getTheme(theme)) notFound();
  const observations = getObservations(theme);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-4">
      <ObservationForm today={today} themeId={theme} />
      <div className="space-y-3">
        {observations.map((o) => {
          let snapshot: Record<string, string> = {};
          try {
            snapshot = JSON.parse(o.snapshot);
          } catch {
            /* 忽略坏数据 */
          }
          return (
            <Card key={o.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <LightBadge light={o.light} />
                  <span className="font-semibold">{o.date}</span>
                  <span className="text-xs text-muted-foreground">记录于 {o.created_at}</span>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {o.note && <p className="text-sm">{o.note}</p>}
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(snapshot).map(([k, v]) => (
                    <Badge key={k} variant="secondary" className="font-normal">
                      <span className="font-mono">{k}</span>
                      <span className="mx-1 text-muted-foreground">·</span>
                      {v || "—"}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}
        {observations.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">尚无核对记录。</p>
        )}
      </div>
    </div>
  );
}
