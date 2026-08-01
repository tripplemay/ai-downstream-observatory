import type { Metadata } from "next";
export const dynamic = "force-dynamic";
import { getPages } from "@/lib/queries";
import { ThesisForm } from "@/components/thesis/thesis-form";

export const metadata: Metadata = { title: "判断与规则" };

export default function ThesisPage() {
  const pages = getPages();
  return <ThesisForm thesis={pages.thesis ?? ""} rules={pages.rules ?? ""} />;
}
