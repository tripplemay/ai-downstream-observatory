import type { Metadata } from "next";
export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import { getPages, getTheme } from "@/lib/queries";
import { ThesisForm } from "@/components/thesis/thesis-form";

export const metadata: Metadata = { title: "判断与规则" };

export default async function ThesisPage({
  params,
}: {
  params: Promise<{ theme: string }>;
}) {
  const { theme } = await params;
  if (!getTheme(theme)) notFound();
  const pages = getPages(theme);
  return <ThesisForm thesis={pages.thesis ?? ""} rules={pages.rules ?? ""} themeId={theme} />;
}
