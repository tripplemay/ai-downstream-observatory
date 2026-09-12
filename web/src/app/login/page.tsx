import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import { getAuthConfig } from "@/server/auth/core";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getCurrentSession()) redirect("/");
  const { error } = await searchParams;
  let configured = true;
  try { getAuthConfig(); } catch { configured = false; }
  return (
    <section className="mx-auto mt-20 max-w-sm rounded-xl border bg-card p-8 shadow-sm">
      <p className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">Private workspace</p>
      <h1 className="text-2xl font-semibold">ETF 投资工作台</h1>
      <p className="mt-3 text-sm text-muted-foreground">请登录以查看账户与研究数据。</p>
      {!configured ? <p role="alert" className="mt-6 text-sm text-destructive">认证尚未配置，访问已关闭。请由管理员完成安全配置。</p> : (
        <form action="/api/auth/login" method="post" className="mt-6 space-y-4">
          <label htmlFor="password" className="block text-sm font-medium">工作台密码</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={1024}
            className="w-full rounded-md border bg-background px-3 py-2" />
          {error && <p role="alert" className="text-sm text-destructive">登录失败，请检查密码后重试。请求过多时请稍后再试。</p>}
          <button type="submit" className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground">登录</button>
        </form>
      )}
    </section>
  );
}
