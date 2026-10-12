import { RECONCILIATION_BALANCES } from "@/server/ledger/reconciliation-schemas";
import { investorHash } from "@/server/investor/schemas";
import { reconciliationContextSchema, reconciliationIntentSchema, reconciliationInstantMicros,
  type ReconciliationContext, type ReconciliationIntent } from "@/server/investor/reconciliation-schemas";

export const STATEMENT_ZONES = ["Asia/Shanghai", "Asia/Hong_Kong", "America/New_York", "UTC"] as const;
const responseSchema = reconciliationContextSchema.innerType().extend({ session_binding: investorHash }).strict();
export type ReconciliationScope = { binding: string; workspace: string | null; revision: number; portfolio: string; ledgerRevision: number;
  linkId: string; linkVersion: number; accountId: string; accountRowVersion: number };
export function parseInvestorReconciliation(value: unknown, expected: ReconciliationScope): ReconciliationContext {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw new Error("INVESTOR_RECONCILIATION_RESPONSE_INVALID");
  const { session_binding, ...document } = parsed.data, checked = reconciliationContextSchema.safeParse(document);
  if (!checked.success || session_binding !== expected.binding || document.workspace_id !== expected.workspace
    || document.workspace_revision !== expected.revision || document.portfolio_id !== expected.portfolio
    || document.ledger_revision !== expected.ledgerRevision || document.link_id !== expected.linkId || document.link_version !== expected.linkVersion
    || document.account_id !== expected.accountId || document.account_row_version !== expected.accountRowVersion) throw new Error("INVESTOR_RECONCILIATION_RESPONSE_INVALID");
  return checked.data;
}

export type StatementDraft = { source: string; date: string; zone: string; acknowledged: boolean; resolutionReason: string; resolves: string[];
  currencies: { currency: string; zeroOthers: boolean; balances: Record<typeof RECONCILIATION_BALANCES[number], string> }[];
  positions: { listingId: string; quantity: string }[]; transits: { transferId: string; quantity: string }[] };
export function blankStatementDraft(context: ReconciliationContext): StatementDraft {
  return { source: "", date: "", zone: "", acknowledged: false, resolutionReason: "", resolves: [],
    currencies: context.requirements.currencies.map(blankStatementCurrency),
    positions: context.requirements.known_positions.map(listingId => ({ listingId, quantity: "" })),
    transits: context.requirements.transits.map(row => ({ transferId: row.transfer_event_id, quantity: "" })) };
}
export function blankStatementCurrency(currency: string): StatementDraft["currencies"][number] {
  return { currency, zeroOthers: false, balances: Object.fromEntries(RECONCILIATION_BALANCES.map(key => [key, ""])) as StatementDraft["currencies"][number]["balances"] };
}
export function statementDayCutoff(date: string, zone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !STATEMENT_ZONES.some(value => value === zone)
    || reconciliationInstantMicros(date + "T00:00:00Z") === null) return null;
  const next = new Date(Date.parse(date + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return null;
  const target = Date.parse(next + "T00:00:00Z"), format = new Intl.DateTimeFormat("en-CA", { timeZone: zone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = format.formatToParts(new Date(candidate)), part = (type: string) => parts.find(row => row.type === type)!.value;
    const local = `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
    if (local === next + "T00:00:00") return new Date(candidate).toISOString();
    candidate += target - Date.parse(local + "Z");
  }
  return null;
}
export function buildReconciliationIntent(context: ReconciliationContext, draft: StatementDraft): ReconciliationIntent {
  const cutoff = statementDayCutoff(draft.date, draft.zone);
  if (!cutoff || reconciliationInstantMicros(cutoff)! > reconciliationInstantMicros(context.checked_at)! || context.read_only
    || draft.resolves.length && context.history_status !== "verified") throw new Error("INVESTOR_RECONCILIATION_DRAFT_INVALID");
  const listings = new Map(context.requirements.listings.map(row => [row.id, row]));
  const statement = { schema_version: 1, portfolio_id: context.portfolio_id, account_id: context.account_id, cutoff_at: cutoff,
    coverage: { currencies: draft.currencies.map(row => row.currency), ledger_accounts: [...RECONCILIATION_BALANCES],
      positions_complete: true, balances_complete: true, security_transits_complete: true },
    balances: draft.currencies.flatMap(row => RECONCILIATION_BALANCES.map(ledger_account => ({ currency: row.currency, ledger_account,
      balance: row.zeroOthers && ledger_account !== "cash_settled" ? "0" : row.balances[ledger_account].trim() }))),
    positions: draft.positions.map(row => ({ listing_id: row.listingId, currency: listings.get(row.listingId)?.currency ?? "", quantity: row.quantity.trim() })),
    security_transits: draft.transits.map(row => { const identity = context.requirements.transits.find(value => value.transfer_event_id === row.transferId);
      if (!identity) throw new Error("INVESTOR_RECONCILIATION_DRAFT_INVALID");
      const { source_name: _, target_name: __, ...values } = identity; return { ...values, quantity: row.quantity.trim() }; }) };
  const intent = reconciliationIntentSchema.safeParse({ action: "reconcile_linked_account", portfolio_id: context.portfolio_id, account_id: context.account_id,
    expected_ledger_revision: context.ledger_revision, expected_account_row_version: context.account_row_version, expected_link_id: context.link_id,
    expected_link_version: context.link_version, source_reference: draft.source, basis: "operator_transcription_not_broker_file", acknowledgement: draft.acknowledged,
    statement, resolves_issue_ids: draft.resolves, resolution_reason: draft.resolutionReason });
  if (!intent.success || new Set(draft.resolves).size !== draft.resolves.length || draft.resolves.some(id => !context.open_issues.some(row => row.id === id))
    || draft.resolves.length && !draft.resolutionReason.trim() || new TextEncoder().encode(JSON.stringify({ ...intent.data, expected_revision: context.workspace_revision,
      idempotency_key: "0".repeat(36) })).byteLength > 32768) throw new Error("INVESTOR_RECONCILIATION_DRAFT_INVALID");
  return intent.data;
}
