import { requireSession } from "@/server/auth/session";
import { sessionBinding } from "@/server/auth/session-binding";
import { ListingReviewWorkspace } from "@/components/workbench/listing-review-workspace";
export const dynamic = "force-dynamic";
export default async function ListingReviewsPage() { const session = await requireSession(); return <ListingReviewWorkspace initialSessionBinding={sessionBinding(session.sessionId)} />; }
