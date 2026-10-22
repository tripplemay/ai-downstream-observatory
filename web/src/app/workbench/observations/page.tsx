import { investorPage } from "@/server/investor/page";
import { investorId } from "@/server/investor/schemas";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<{ observation?: string | string[] }> }) {
  const query = await searchParams;
  if (query.observation !== undefined && !investorId.safeParse(query.observation).success)
    return <section className="p-8"><h1 className="text-xl font-semibold">观察编号无效</h1><a className="mt-4 inline-block underline" href="/workbench/observations">返回观察归档</a></section>;
  return investorPage("observations", query.observation as string | undefined ?? null);
}
