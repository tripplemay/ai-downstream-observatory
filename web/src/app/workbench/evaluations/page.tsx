import { requireSession } from "@/server/auth/session";
import { sessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { getEvaluationState } from "@/server/evaluation/service";
import { EvaluationWorkspace } from "@/components/workbench/evaluation-workspace";

export const dynamic = "force-dynamic";
export default async function EvaluationsPage() {
  const session = await requireSession();
  const db = openWorkbench();
  try { return <EvaluationWorkspace initial={getEvaluationState(db, { id: session.userId, kind: "human" })} initialSessionBinding={sessionBinding(session.sessionId)} />; }
  finally { db.close(); }
}
