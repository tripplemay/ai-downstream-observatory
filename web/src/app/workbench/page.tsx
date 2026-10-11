import { investorPage } from "@/server/investor/page";

export const dynamic = "force-dynamic";

export default async function WorkbenchPage() {
  return investorPage("overview");
}
