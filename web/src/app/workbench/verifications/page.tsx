import { requireSession } from "@/server/auth/session";
import { sessionBinding } from "@/server/auth/session-binding";
import { VerificationWorkspace } from "@/components/workbench/verification-workspace";

export const dynamic = "force-dynamic";
export default async function VerificationsPage() {
  const session = await requireSession();
  return <VerificationWorkspace initialSessionBinding={sessionBinding(session.sessionId)} />;
}
