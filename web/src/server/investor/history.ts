import type Database from "better-sqlite3";
import { z } from "zod";
import { canonical, hash, type Actor } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { investorCommandSchema, investorId, investorInstant, investorReceiptSchema } from "./schemas";
import { observationRecord, type ObservationRow } from "./service";
import { historyDecisionSchema, historyObservationSchema, historyQuerySchema, investorHistorySchema, type HistoryQuery } from "./history-schemas";

const cursorSchema = z.object({ v: z.literal(1), workspace: investorId, observation_head: investorId, decision_head: investorId.nullable(),
  observation: investorId.nullable(), anchor: investorId, direction: z.enum(["older", "newer"]) }).strict();
type Cursor = z.infer<typeof cursorSchema>;
type Ordered = { id: string; sequence: number; created_at: string };
type Decision = Ordered & { observation_id: string; decision: string; note: string; actor_id: string; audit_id: string };
function invalid(): never { throw new Error("INVESTOR_HISTORY_EVIDENCE_INVALID"); }
function cursorInvalid(): never { throw new Error("INVESTOR_HISTORY_CURSOR_INVALID"); }
function decodeCursor(value: string): Cursor {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64url"));
    const result = cursorSchema.parse(parseStrictJson(text));
    if (Buffer.from(canonical(result)).toString("base64url") !== value) cursorInvalid();
    return result;
  } catch { return cursorInvalid(); }
}
function encodeCursor(value: Cursor) { return Buffer.from(canonical(value)).toString("base64url"); }
function ordered(row: Ordered | undefined, now: string): Ordered {
  if (!row || !investorId.safeParse(row.id).success || !Number.isSafeInteger(row.sequence) || row.sequence <= 0
    || !investorInstant.safeParse(row.created_at).success || row.created_at > now) invalid();
  return row;
}
function decisionRecord(db: Database.Database, owner: string, workspace: string, row: Decision, now: string) {
  ordered(row, now);
  const audit = db.prepare("SELECT * FROM audit_events WHERE id=?").get(row.audit_id) as
    { actor_id: string; action: string; object_type: string; object_id: string; portfolio_id: string | null; ledger_revision: number | null; created_at: string; payload_json: string } | undefined;
  if (!audit || row.actor_id !== owner || audit.actor_id !== owner || audit.action !== "investor_review" || audit.object_type !== "investor_workspace"
    || audit.object_id !== workspace || audit.portfolio_id !== null || audit.ledger_revision !== null || audit.created_at !== row.created_at) invalid();
  const body = parseStrictJson(audit.payload_json) as { input: unknown; result: unknown }, input = investorCommandSchema.parse(body.input);
  if (input.action !== "review" || input.observation_id !== row.observation_id || input.decision !== row.decision || input.note !== row.note
    || canonical(body.result) !== canonical({ decision_id: row.id, execution_authorized: false })) invalid();
  const command = db.prepare("SELECT payload_hash,result_json FROM investor_commands WHERE owner_id=? AND idempotency_key=?")
    .get(owner, input.idempotency_key) as { payload_hash: string; result_json: string } | undefined;
  if (!command || command.payload_hash !== hash(input)) invalid();
  const receipt = investorReceiptSchema.parse(parseStrictJson(command.result_json));
  if (receipt.action !== "review" || receipt.resource_id !== row.id || receipt.audit_id !== row.audit_id
    || receipt.workspace_id !== workspace || receipt.revision !== input.expected_revision + 1) invalid();
  return historyDecisionSchema.parse({ id: row.id, observation_id: row.observation_id, decision: row.decision, note: row.note, created_at: row.created_at });
}

/** Bounded immutable archive pages. No current advice, prices, weights, AI, jobs or writes. */
export function readInvestorHistory(db: Database.Database, actor: Actor, raw: HistoryQuery = {}, now = new Date().toISOString()) {
  const owner = investorId.parse(actor.id), input = historyQuerySchema.parse(raw); investorInstant.parse(now);
  return db.transaction(() => {
    const ws = db.prepare("SELECT id FROM investor_workspaces WHERE owner_id=?").get(owner) as { id: string } | undefined;
    const parsed = input.cursor ? decodeCursor(input.cursor) : null;
    if (parsed && (parsed.workspace !== ws?.id || parsed.observation !== (input.observation ?? null))) cursorInvalid();
    if (!ws) {
      if (input.observation) throw new Error("INVESTOR_HISTORY_NOT_FOUND");
      return investorHistorySchema.parse({ schema_version: "investor-history-v1", workspace_id: null, checked_at: now, mode: "observations", observation_id: null,
        entries: [], decisions: [], previous_cursor: null, next_cursor: null, historical_only: true, is_current_conclusion: false, live_advice_eligible: false });
    }
    const head = (table: string, id?: string | null) => id === null ? undefined : db.prepare(`SELECT rowid sequence,id,created_at FROM ${table} WHERE workspace_id=? ${id ? "AND id=?" : "ORDER BY rowid DESC LIMIT 1"}`)
      .get(...(id ? [ws.id, id] : [ws.id])) as Ordered | undefined;
    const observationHead = parsed ? ordered(head("investor_observations", parsed.observation_head), now) : head("investor_observations");
    const decisionHead = parsed ? parsed.decision_head ? ordered(head("investor_decisions", parsed.decision_head), now) : undefined : head("investor_decisions");
    if (observationHead) ordered(observationHead, now);
    if (decisionHead) ordered(decisionHead, now);
    const observationRows = "SELECT o.*,o.rowid sequence,p.version profile_version FROM investor_observations o JOIN investor_profiles p ON p.id=o.profile_id AND p.workspace_id=o.workspace_id";
    const readObservation = (id: string) => db.prepare(observationRows + " WHERE o.workspace_id=? AND o.id=?").get(ws.id, id) as (ObservationRow & Ordered) | undefined;
    const summary = (row: ObservationRow & Ordered) => {
      ordered(row, now);
      const record = observationRecord(row, db, ws.id, now), doc = record.document;
      const decisions = db.prepare(`SELECT *,rowid sequence FROM investor_decisions WHERE workspace_id=? AND observation_id=? AND rowid<=?
        ORDER BY created_at DESC,rowid DESC LIMIT 2`).all(ws.id, row.id, decisionHead?.sequence ?? 0) as Decision[];
      return historyObservationSchema.parse({ id: row.id, recorded_outcome: row.outcome, read_outcome: doc.outcome, evaluated_at: row.created_at,
        profile_version: row.profile_version, input_version: row.input_version, data_cutoff: doc.data_cutoff, reasons: doc.reasons,
        gaps: doc.gaps, next_review_at: doc.next_review_at, next_conditions: doc.next_conditions,
        latest_decision: decisions[0] ? decisionRecord(db, owner, ws.id, decisions[0], now) : null, more_decisions: decisions.length > 1 });
    };
    const selected = input.observation ? readObservation(input.observation) : null;
    if (input.observation && (!selected || !observationHead || selected.sequence > observationHead.sequence)) throw new Error("INVESTOR_HISTORY_NOT_FOUND");
    const table = input.observation ? "investor_decisions" : "investor_observations", maximum = input.observation ? decisionHead?.sequence ?? 0 : observationHead?.sequence ?? 0;
    const anchor = parsed ? head(table, parsed.anchor) : undefined;
    if (parsed && (!anchor || anchor.sequence > maximum || input.observation && (db.prepare("SELECT observation_id FROM investor_decisions WHERE id=? AND workspace_id=?").get(anchor.id, ws.id) as { observation_id: string })?.observation_id !== input.observation)) cursorInvalid();
    if (anchor) ordered(anchor, now);
    const filters = `workspace_id=? AND rowid<=?${input.observation ? " AND observation_id=?" : ""}`;
    const bindings = input.observation ? [ws.id, maximum, input.observation] : [ws.id, maximum];
    const order = parsed?.direction === "newer" ? "ASC" : "DESC", operator = order === "ASC" ? ">" : "<";
    const rows = db.prepare(`SELECT *,rowid sequence FROM ${table} WHERE ${filters}${anchor ? ` AND (created_at,rowid) ${operator} (?,?)` : ""}
      ORDER BY created_at ${order},rowid ${order} LIMIT 20`).all(...bindings, ...(anchor ? [anchor.created_at, anchor.sequence] : [])) as (Decision & ObservationRow)[];
    if (order === "ASC") rows.reverse();
    const cursor = (row: Ordered | undefined, direction: Cursor["direction"]) => {
      if (!row || !observationHead) return null;
      const op = direction === "older" ? "<" : ">";
      const exists = db.prepare(`SELECT 1 FROM ${table} WHERE ${filters} AND (created_at,rowid) ${op} (?,?) LIMIT 1`).get(...bindings, row.created_at, row.sequence);
      return exists ? encodeCursor({ v: 1, workspace: ws.id, observation_head: observationHead.id, decision_head: decisionHead?.id ?? null,
        observation: input.observation ?? null, anchor: row.id, direction }) : null;
    };
    const entries = selected ? [summary(selected)] : rows.map(row => {
      const observation = readObservation(row.id); if (!observation) invalid(); return summary(observation);
    });
    return investorHistorySchema.parse({ schema_version: "investor-history-v1", workspace_id: ws.id, checked_at: now,
      mode: input.observation ? "decisions" : "observations", observation_id: input.observation ?? null, entries,
      decisions: input.observation ? rows.map(row => decisionRecord(db, owner, ws.id, row, now)) : [],
      previous_cursor: cursor(rows[0], "newer"), next_cursor: cursor(rows.at(-1), "older"),
      historical_only: true, is_current_conclusion: false, live_advice_eligible: false });
  }).deferred();
}
