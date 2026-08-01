"use client";

import { Badge } from "@/components/ui/badge";

/** 信号状态 → 徽标颜色 */
export function statusVariant(
  status: string
): "green" | "yellow" | "secondary" | "red" {
  switch (status) {
    case "已验证":
      return "green";
    case "验证中":
      return "yellow";
    case "反向":
    case "已触发":
      return "red";
    default:
      return "secondary";
  }
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={statusVariant(status)}>{status || "—"}</Badge>;
}
