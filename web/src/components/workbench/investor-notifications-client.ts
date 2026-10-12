import { investorHash } from "@/server/investor/schemas";
import { investorInboxSchema, investorNoticeReceiptSchema, type InvestorInbox, type InvestorNotice } from "@/server/investor/notification-schemas";

export function parseInvestorInbox(raw: unknown, binding: string, workspace: string | null): InvestorInbox {
  const parsed = investorInboxSchema.extend({ session_binding: investorHash }).strict().safeParse(raw);
  if (!parsed.success || parsed.data.session_binding !== binding || parsed.data.workspace_id !== workspace) throw new Error("INVESTOR_INBOX_RESPONSE_INVALID");
  const { session_binding: _, ...value } = parsed.data;
  if (value.visible_unread_count !== value.entries.filter(row => row.read_at === null).length || value.workspace_id === null && (value.entries.length || value.has_more))
    throw new Error("INVESTOR_INBOX_RESPONSE_INVALID");
  const seen = new Set<string>(), publications = new Set<string>(); let previous: InvestorNotice | undefined;
  for (const row of value.entries) {
    if (seen.has(row.id) || publications.has(row.publication_id) || row.workspace_id !== workspace || row.published_at > value.checked_at
      || row.read_at !== null && (row.read_at < row.published_at || row.read_at > value.checked_at)
      || previous && (row.published_at > previous.published_at || row.published_at === previous.published_at && row.publication_id >= previous.publication_id))
      throw new Error("INVESTOR_INBOX_RESPONSE_INVALID");
    seen.add(row.id); publications.add(row.publication_id); previous = row;
  }
  return value;
}
export function verifyInvestorNoticeReceipt(raw: unknown, binding: string, notice: InvestorNotice) {
  const parsed = investorNoticeReceiptSchema.extend({ session_binding: investorHash }).strict().safeParse(raw);
  if (!parsed.success || parsed.data.session_binding !== binding || parsed.data.notice_id !== notice.id
    || parsed.data.publication_hash !== notice.publication_hash || parsed.data.read_at < notice.published_at) throw new Error("INVESTOR_INBOX_RECEIPT_INVALID");
  return parsed.data;
}
