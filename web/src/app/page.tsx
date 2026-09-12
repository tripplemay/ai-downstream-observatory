import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await requireSession();
  redirect("/workbench");
}
