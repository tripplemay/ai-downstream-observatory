import type { Metadata } from "next";
export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import { getPool, getTheme } from "@/lib/queries";
import { PoolManager } from "@/components/pool/pool-manager";

export const metadata: Metadata = { title: "标的池" };

export default async function PoolPage({
  params,
}: {
  params: Promise<{ theme: string }>;
}) {
  const { theme } = await params;
  const t = await getTheme(theme);
  if (!t || t.type === "strategy") notFound();
  return <PoolManager items={await getPool(theme)} themeId={theme} />;
}
