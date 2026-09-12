import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { getCurrentSession } from "@/server/auth/session";
import { sessionBinding } from "@/server/auth/session-binding";
import { SessionBoundary } from "@/components/session-boundary";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ETF 投资工作台", template: "%s · ETF 投资工作台" },
  description: "个人 ETF 组合、账本与策略研究工作台。",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const principal = await getCurrentSession();
  const content = <>
    {principal && <AppSidebar />}
    <div className={`flex min-h-screen flex-col ${principal ? "md:pl-60" : ""}`}>
      {principal && <>
        <SiteHeader />
        <form action="/api/auth/logout" method="post" className="flex justify-end px-6 pt-3">
          <button className="text-xs text-muted-foreground hover:text-foreground" type="submit">退出登录</button>
        </form>
      </>}
      <main className="flex-1 p-4 md:p-6">{children}</main>
      <footer className="border-t px-6 py-4 text-xs text-muted-foreground">长期投入不等于持续盈利。研究、预算与真实账户事实分别记录。</footer>
    </div>
    <Toaster />
  </>;
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
          {principal ? <SessionBoundary initialBinding={sessionBinding(principal.sessionId)}>{content}</SessionBoundary> : content}
        </ThemeProvider>
      </body>
    </html>
  );
}
