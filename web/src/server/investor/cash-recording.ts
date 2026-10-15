import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { hash, recordFact, type Actor } from "../ledger/service";
import { getInvestorAccountWorkspace } from "./accounts";
import { cashRecordingContextSchema, cashRecordingIntentSchema, CASH_RECORDING_CURRENCIES, type CashRecordingContext, type CashRecordingIntent } from "./cash-recording-schemas";

export function getCashRecordingContext(db: Database.Database, actor: Actor, accountId: string, now = new Date().toISOString()): CashRecordingContext {
  return db.transaction(() => {
    const scope = getInvestorAccountWorkspace(db, actor, now), link = scope.link;
    const book = scope.books.find(row => row.id === link?.document.portfolio_id), account = scope.accounts.find(row => row.id === accountId);
    if (!book || !link || !account) throw new Error("INVESTOR_ACCOUNT_OUT_OF_SCOPE");
    const count = db.prepare("SELECT count(*) n FROM ledger_events WHERE portfolio_id=?").get(book.id) as { n: number };
    if (count.n > 10000) throw new Error("INVESTOR_CASH_CAPACITY_REQUIRES_REVIEW");
    const identity = { schema_version: "investor-cash-recording-v1" as const, workspace_id: scope.workspace_id!, workspace_revision: scope.workspace_revision,
      portfolio_id: book.id, ledger_revision: book.ledger_revision, link_id: link.id, link_version: link.version, account_id: account.id,
      account_row_version: account.row_version, account_status: account.status, base_currency: account.base_currency,
      allowed_currencies: [...CASH_RECORDING_CURRENCIES], basis: "metadata_only_no_fact_prefill" as const, execution_authorized: false as const };
    return cashRecordingContextSchema.parse({ ...identity, checked_at: now, read_only: scope.read_only, context_hash: hash(identity) });
  }).deferred();
}

export function recordInvestorCashFact(db: Database.Database, actor: Actor, raw: CashRecordingIntent & { idempotency_key: string; expected_revision?: number }, now: string) {
  const { idempotency_key, expected_revision: _, ...intent } = raw;
  const input = { ...cashRecordingIntentSchema.parse(intent), idempotency_key };
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(idempotency_key)) throw new Error("INVESTOR_CASH_INPUT_INVALID");
  assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db);
    const context = getCashRecordingContext(db, actor, input.account_id, now);
    if (context.portfolio_id !== input.portfolio_id) throw new Error("INVESTOR_ACCOUNT_OUT_OF_SCOPE");
    if (context.link_id !== input.expected_link_id || context.link_version !== input.expected_link_version
      || context.ledger_revision !== input.expected_ledger_revision || context.account_row_version !== input.expected_account_row_version
      || context.context_hash !== input.expected_context_hash) throw new Error("INVESTOR_CASH_CONTEXT_CONFLICT");
    if (context.account_status === "disabled") throw new Error("INVESTOR_CASH_ACCOUNT_DISABLED");
    try {
      const result = recordFact(db, actor, { portfolio_id: context.portfolio_id, expected_revision: input.expected_ledger_revision,
        idempotency_key: "investor-cash:" + hash({ owner: actor.id, idempotency_key: input.idempotency_key }), source_id: input.source_id, source_event_id: input.source_event_id,
        effective_at: input.effective_date, time_precision: "date", source_timezone: input.source_timezone,
        reason: "Operator external cash transcription, not a broker file: " + input.source_reference,
        fact: { ...input.entry, account_id: context.account_id } }, now);
      if (result.warnings.includes("ORIGINAL_SOURCE_SUPERSEDED")) throw new Error("INVESTOR_CASH_SOURCE_SUPERSEDED");
      return result;
    } catch (error) {
      if (error instanceof Error) {
        if (["SOURCE_DUPLICATE_CONFLICT", "DUPLICATE_CONFLICT"].includes(error.message)) throw new Error("INVESTOR_CASH_SOURCE_DUPLICATE_CONFLICT");
        if (error.message === "CHRONOLOGY_REVIEW_REQUIRED") throw new Error("INVESTOR_CASH_CHRONOLOGY_REQUIRES_REVIEW");
        if (["FUTURE_FACT_NOT_ALLOWED", "INVALID_EFFECTIVE_TIME", "INVALID_SOURCE_TIMEZONE"].includes(error.message)) throw new Error("INVESTOR_CASH_INPUT_INVALID");
      }
      throw error;
    }
  }).immediate();
}
