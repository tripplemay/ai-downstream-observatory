import { investorPage } from "@/server/investor/page";
export const dynamic = "force-dynamic";
export default async function Page() { return investorPage("observations"); }
