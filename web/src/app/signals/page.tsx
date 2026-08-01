import type { Metadata } from "next";
export const dynamic = "force-dynamic";
import { getSignalGroups } from "@/lib/queries";
import { SignalsTabs } from "@/components/signals/signals-tabs";

export const metadata: Metadata = { title: "信号" };

export default function SignalsPage() {
  const groups = getSignalGroups();
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        跟踪 C1–C10 证实信号与 F1–F5 证伪信号；编辑会同步写入 signal_history。
      </p>
      <SignalsTabs groups={groups} />
    </div>
  );
}
