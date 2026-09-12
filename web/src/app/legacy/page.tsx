import Link from "next/link";
import { requireSession } from "@/server/auth/session";
import { getThemes } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function LegacyPage() {
  await requireSession();
  let themes: Awaited<ReturnType<typeof getThemes>>;
  try { themes = await getThemes(); }
  catch { return <section className="p-6"><h1 className="text-2xl font-semibold">历史研究档案未挂载</h1><p className="mt-3 text-muted-foreground">请核对只读旧库路径。工作台不会创建空档案、运行种子或修改旧数据库。</p></section>; }
  return <section className="space-y-5 p-6"><h1 className="text-2xl font-semibold">历史研究档案</h1><p className="text-muted-foreground">旧主题、建议和模拟净值仅供溯源，不是新组合的真实账户、有效政策或准入证据。</p><div className="grid gap-4 md:grid-cols-2">{themes.map(t => <Link key={t.id} href={`/${t.id}`} className="rounded-xl border p-5 hover:bg-accent"><h2 className="font-semibold">{t.name}</h2><p className="mt-2 text-sm text-muted-foreground">{t.description}</p><p className="mt-3 text-xs">只读历史记录</p></Link>)}</div></section>;
}
