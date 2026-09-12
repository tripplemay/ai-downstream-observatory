import { requireSession } from "@/server/auth/session";
import { openWorkbench } from "@/server/workbench-db";
import { catalogWorkspace } from "@/server/catalog/queries";
import { CatalogWorkspace } from "@/components/workbench/catalog-workspace";

export const dynamic = "force-dynamic";
export default async function CatalogPage() {
  await requireSession();
  const db = openWorkbench();
  try { return <CatalogWorkspace initial={catalogWorkspace(db, { limit: 20 })} />; }
  finally { db.close(); }
}
