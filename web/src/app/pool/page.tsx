import type { Metadata } from "next";
export const dynamic = "force-dynamic";
import { getPool } from "@/lib/queries";
import { PoolManager } from "@/components/pool/pool-manager";

export const metadata: Metadata = { title: "标的池" };

export default function PoolPage() {
  return <PoolManager items={getPool()} />;
}
