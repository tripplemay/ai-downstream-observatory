import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "投资观测台", template: "%s · 投资观测台" },
  description: "个人研究框架：按主题跟踪证实/证伪信号。不构成投资建议。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
          <AppSidebar />
          <div className="flex min-h-screen flex-col md:pl-60">
            <SiteHeader />
            <main className="flex-1 p-4 md:p-6">{children}</main>
            <footer className="border-t px-6 py-4 text-xs text-muted-foreground">
              个人研究框架，不构成投资建议。数据以 Wind 与公司季报为准。
            </footer>
          </div>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
