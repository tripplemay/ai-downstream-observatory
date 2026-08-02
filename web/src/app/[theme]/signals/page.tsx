import type { Metadata } from "next";
export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import { getSignalGroups, getTheme } from "@/lib/queries";
import { SignalsTabs } from "@/components/signals/signals-tabs";

export const metadata: Metadata = { title: "信号" };

export default async function SignalsPage({
  params,
}: {
  params: Promise<{ theme: string }>;
}) {
  const { theme } = await params;
  if (!getTheme(theme)) notFound();
  const groups = getSignalGroups(theme);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        跟踪 C1–C11 证实信号与 F1–F5 证伪信号；编辑会同步写入 signal_history。
      </p>
      <SignalsTabs groups={groups} themeId={theme} />
    </div>
  );
}
