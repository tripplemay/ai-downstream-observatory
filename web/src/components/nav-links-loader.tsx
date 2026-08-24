import { connection } from "next/server";
import { getThemes } from "@/lib/queries";
import { NavLinks } from "@/components/nav";

/** 查 themes 把 slug→type 映射传给 NavLinks。await connection() 与 ThemeNav 同理：
 * 构建期预渲染（/_not-found 等）经 Suspense 跳过，避免构建期访问数据库。 */
export async function NavLinksLoader() {
  await connection();
  const themeTypes = Object.fromEntries(getThemes().map((t) => [t.id, t.type]));
  return <NavLinks themeTypes={themeTypes} />;
}
