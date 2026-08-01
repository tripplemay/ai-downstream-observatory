import { connection } from "next/server";
import { getThemes } from "@/lib/queries";
import { ThemeLinks } from "@/components/theme-links";

/** 侧栏"主题"区块。await connection() 使构建期预渲染（/_not-found 等）经 Suspense 跳过，
 * 避免构建期访问数据库。 */
export async function ThemeNav() {
  await connection();
  const themes = getThemes();
  return (
    <div className="pb-3">
      <div className="px-5 pb-1 text-xs font-medium text-muted-foreground">主题</div>
      <ThemeLinks themes={themes} />
    </div>
  );
}
