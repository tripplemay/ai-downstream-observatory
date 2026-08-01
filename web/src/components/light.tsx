import { cn } from "@/lib/utils";
import { lightName } from "@/lib/format";
import { Badge } from "@/components/ui/badge";

export const LIGHT_DOT: Record<string, string> = {
  red: "bg-red-500",
  yellow: "bg-amber-400",
  green: "bg-emerald-500",
};

export function LightDot({ light, className }: { light: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-2.5 w-2.5 rounded-full",
        LIGHT_DOT[light] ?? "bg-zinc-300 dark:bg-zinc-600",
        className
      )}
    />
  );
}

export function LightBadge({ light }: { light: string }) {
  if (!light) return <span className="text-muted-foreground">—</span>;
  const variant = light === "red" ? "red" : light === "yellow" ? "yellow" : "green";
  return (
    <Badge variant={variant}>
      <LightDot light={light} className="mr-1.5 h-2 w-2" />
      {lightName(light)}
    </Badge>
  );
}

/** 信号灯大色块：总览 hero 用 */
export function lightBlockClass(light: string): string {
  switch (light) {
    case "green":
      return "bg-emerald-500 text-white";
    case "yellow":
      return "bg-amber-400 text-amber-950";
    default:
      return "bg-red-500 text-white";
  }
}
