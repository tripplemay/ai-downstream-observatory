import type Database from "better-sqlite3";
import { z } from "zod";
import { amount, exact } from "./decimal";
import { hash, type LedgerCommand } from "./service";

export interface CsvCandidateReview {
  row: number;
  missing_source_id: boolean;
  exact_event_ids: string[];
  possible_event_ids: string[];
  exact_prior_rows: number[];
  possible_prior_rows: number[];
}

const numericFields = ["amount", "quantity", "price", "consideration", "cost_amount", "fee", "tax", "gross_amount", "received_amount", "split_numerator", "split_denominator", "market_value"] as const;
const MAX_CANDIDATES = 100000;
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function normalizedFact(command: LedgerCommand): Record<string, unknown> {
  const fact: Record<string, unknown> = { ...command.fact };
  for (const field of numericFields) if (fact[field] !== undefined) fact[field] = exact(amount(fact[field]));
  if (["buy", "sell", "fx", "transfer_out"].includes(command.fact.type)) fact.fee ??= "0";
  if (["dividend", "dividend_accrual"].includes(command.fact.type)) fact.tax_status ??= fact.tax === undefined ? "unknown" : "confirmed";
  if (command.fact.value_evidence?.time_precision === "second") {
    const { source_timezone: _zone, ...evidence } = command.fact.value_evidence;
    void _zone;
    fact.value_evidence = { ...evidence, effective_at: new Date(evidence.effective_at).toISOString() };
  }
  return fact;
}

/** Economic equality, not proof that two broker records describe the same occurrence. */
export function csvEconomicHash(command: LedgerCommand): string {
  return hash({
    portfolio_id: command.portfolio_id,
    effective_at: command.time_precision === "second" ? new Date(command.effective_at).toISOString() : command.effective_at,
    time_precision: command.time_precision,
    ...(command.time_precision === "date" ? { source_timezone: command.source_timezone } : {}),
    fact: normalizedFact(command),
  });
}

function localDay(command: LedgerCommand): string {
  if (command.time_precision === "date") return command.effective_at;
  let formatter = dayFormatters.get(command.source_timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: command.source_timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormatters.set(command.source_timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(command.effective_at));
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}

function possibleHash(command: LedgerCommand): string {
  const fact = normalizedFact(command);
  const fields = ["type", "account_id", "currency", "listing_id", "target_account_id", "target_currency", "direction", ...numericFields];
  return hash({ portfolio_id: command.portfolio_id, day: localDay(command), fact: Object.fromEntries(fields.filter(field => fact[field] !== undefined).map(field => [field, fact[field]])) });
}

interface Candidate<T> { value: T; exact: string }
interface Index<T> { exact: Map<string, T[]>; possible: Map<string, Candidate<T>[]> }
function index<T>(): Index<T> { return { exact: new Map(), possible: new Map() }; }
function add<T>(target: Index<T>, exactHash: string, weakHash: string, value: T): void {
  const exactValues = target.exact.get(exactHash);
  if (exactValues) exactValues.push(value); else target.exact.set(exactHash, [value]);
  const possibleValues = target.possible.get(weakHash);
  const candidate = { value, exact: exactHash };
  if (possibleValues) possibleValues.push(candidate); else target.possible.set(weakHash, [candidate]);
}

/** Caller binds this result to its ledger-revision CAS and recomputes it inside confirmation. */
export function buildCsvReviewCandidates(db: Database.Database, portfolioId: string, accountId: string, rows: readonly { row: number; command: LedgerCommand | null }[]): CsvCandidateReview[] {
  if (!db.prepare("SELECT id FROM accounts WHERE id=? AND portfolio_id=?").get(accountId, portfolioId)) throw new Error("CSV_REVIEW_SCOPE_MISMATCH");
  const rowNumbers = new Set<number>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.row) || row.row < 1 || rowNumbers.has(row.row)) throw new Error("CSV_REVIEW_ROW_INVALID");
    rowNumbers.add(row.row);
    if (row.command && (row.command.portfolio_id !== portfolioId || row.command.fact.account_id !== accountId)) throw new Error("CSV_REVIEW_SCOPE_MISMATCH");
  }
  const events = index<string>(), prior = index<number>();
  const query = db.prepare(`SELECT e.id,e.payload_json FROM ledger_events e
    WHERE e.portfolio_id=? AND e.account_id=? AND e.reversal_of IS NULL
      AND NOT EXISTS(SELECT 1 FROM ledger_events r WHERE r.reversal_of=e.id)
    ORDER BY e.effective_at,e.ledger_revision`);
  for (const value of query.iterate(portfolioId, accountId)) {
    const event = value as { id: string; payload_json: string };
    try {
      const command = JSON.parse(event.payload_json) as LedgerCommand;
      if (command.portfolio_id !== portfolioId || command.fact.account_id !== accountId) throw new Error("scope");
      add(events, csvEconomicHash(command), possibleHash(command), event.id);
    } catch { throw new Error("CSV_REVIEW_STORED_EVENT_INVALID"); }
  }
  let total = 0;
  const results = new Map<number, CsvCandidateReview>();
  for (const row of [...rows].sort((a, b) => a.row - b.row)) {
    const result: CsvCandidateReview = { row: row.row, missing_source_id: !!row.command && !row.command.source_event_id?.trim(), exact_event_ids: [], possible_event_ids: [], exact_prior_rows: [], possible_prior_rows: [] };
    if (row.command) {
      const exactHash = csvEconomicHash(row.command), weakHash = possibleHash(row.command);
      const exactEvents = events.exact.get(exactHash) ?? [], exactRows = prior.exact.get(exactHash) ?? [];
      total += exactEvents.length + exactRows.length;
      if (total > MAX_CANDIDATES) throw new Error("CSV_REVIEW_CANDIDATE_LIMIT");
      result.exact_event_ids = [...exactEvents]; result.exact_prior_rows = [...exactRows];
      for (const candidate of events.possible.get(weakHash) ?? []) {
        if (candidate.exact === exactHash) continue;
        if (++total > MAX_CANDIDATES) throw new Error("CSV_REVIEW_CANDIDATE_LIMIT");
        result.possible_event_ids.push(candidate.value);
      }
      for (const candidate of prior.possible.get(weakHash) ?? []) {
        if (candidate.exact === exactHash) continue;
        if (++total > MAX_CANDIDATES) throw new Error("CSV_REVIEW_CANDIDATE_LIMIT");
        result.possible_prior_rows.push(candidate.value);
      }
      add(prior, exactHash, weakHash, row.row);
    }
    results.set(row.row, result);
  }
  return rows.map(row => results.get(row.row)!);
}

const rowNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reason = z.string().min(1).max(2000).refine(value => !!value.trim());
const rowResolution = z.discriminatedUnion("action", [
  z.object({ row: rowNumber, action: z.literal("record_distinct"), reason }).strict(),
  z.object({ row: rowNumber, action: z.literal("link_existing"), reason, event_id: z.string().min(1).max(160) }).strict(),
  z.object({ row: rowNumber, action: z.literal("link_prior_row"), reason, prior_row: rowNumber }).strict(),
]);
export type CsvRowResolution = z.infer<typeof rowResolution>;
const reviewSchema = z.object({ acknowledge_unverified_mapping: z.literal(true), review_hash: z.string().regex(/^[a-f0-9]{64}$/), rows: z.array(rowResolution).max(10000) }).strict();

export function parseCsvReview(input: unknown, requiredRows: readonly number[], candidates: readonly CsvCandidateReview[], reviewHash: string): Map<number, CsvRowResolution> {
  const parsed = reviewSchema.safeParse(input);
  if (!parsed.success) throw new Error("CSV_REVIEW_INVALID");
  if (parsed.data.review_hash !== reviewHash) throw new Error("CSV_REVIEW_HASH_MISMATCH");
  const required = new Set(requiredRows), byRow = new Map(candidates.map(candidate => [candidate.row, candidate]));
  if (required.size !== requiredRows.length || byRow.size !== candidates.length || requiredRows.some(row => !Number.isSafeInteger(row) || row < 1 || !byRow.has(row))) throw new Error("CSV_REVIEW_ROW_INVALID");
  const resolutions = new Map<number, CsvRowResolution>();
  for (const resolution of parsed.data.rows) {
    if (!required.has(resolution.row) || resolutions.has(resolution.row)) throw new Error("CSV_REVIEW_ROWS_MISMATCH");
    const candidate = byRow.get(resolution.row)!;
    if (resolution.action === "link_existing" && !candidate.exact_event_ids.includes(resolution.event_id)) throw new Error("CSV_REVIEW_LINK_NOT_EXACT");
    if (resolution.action === "link_prior_row" && (resolution.prior_row >= resolution.row || !candidate.exact_prior_rows.includes(resolution.prior_row))) throw new Error("CSV_REVIEW_LINK_NOT_EXACT");
    resolutions.set(resolution.row, resolution);
  }
  if (resolutions.size !== required.size) throw new Error("CSV_REVIEW_ROWS_MISMATCH");
  return resolutions;
}
