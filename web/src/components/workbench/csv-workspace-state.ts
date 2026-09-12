export interface CsvScope { portfolioId: string; accountId: string }
export interface CsvContext extends CsvScope { revision: number }
export interface CsvPendingConfirmation {
  context: CsvContext;
  batchId: string;
  payload: string;
}
export interface CsvOperation {
  id: number;
  kind: "preview" | "confirm" | "mapping" | "status";
  context: CsvContext;
}

export function sameCsvScope(left: CsvScope, right: CsvScope): boolean {
  return left.portfolioId === right.portfolioId && left.accountId === right.accountId;
}

export function csvScopeKey(scope: CsvScope): string {
  return JSON.stringify([scope.portfolioId, scope.accountId]);
}

export function isCsvOperationCurrent(operation: CsvOperation, active: CsvOperation | null, current: CsvContext): boolean {
  if (operation !== active || !sameCsvScope(operation.context, current)) return false;
  return operation.kind === "confirm" || operation.kind === "status" || operation.context.revision === current.revision;
}

export function canRetryCsvConfirmation(pending: CsvPendingConfirmation, current: CsvContext,
  preview: { id: string; account_id: string; expected_revision: number }, readOnly: boolean): boolean {
  return !readOnly && sameCsvScope(pending.context, current) && preview.account_id === pending.context.accountId
    && preview.id === pending.batchId && preview.expected_revision === pending.context.revision;
}

export function csvContextDisposition(previous: CsvContext, current: CsvContext, pending: CsvPendingConfirmation | null): "unchanged" | "retain_pending" | "reset" {
  if (sameCsvScope(previous, current) && previous.revision === current.revision) return "unchanged";
  return pending ? "retain_pending" : "reset";
}

export function canClearCsvPreview(pending: CsvPendingConfirmation | null, explicitlyAbandon = false): boolean {
  return pending === null || explicitlyAbandon;
}

export function retainCsvConfirmedRefresh(confirmed: { scope: string; revision: number | null } | null, current: CsvContext): boolean {
  return !!confirmed && confirmed.scope === csvScopeKey(current) && (confirmed.revision === null || confirmed.revision === current.revision);
}

export function shouldWarnCsvNavigation(href: string, location: string, target = "", download = false): boolean {
  if (download || (target && target !== "_self")) return false;
  try {
    const destination = new URL(href, location), current = new URL(location);
    return destination.origin !== current.origin || destination.pathname !== current.pathname || destination.search !== current.search;
  } catch { return true; }
}
