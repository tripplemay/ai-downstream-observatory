import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { deadlineAt, instant, readCollectionHistory, triggerAt } from "./core";
import type { CollectionSlotRow, ScheduledCollectionBinding } from "./types";
export type CollectionRequestRow = { id: string; portfolio_id: string; actor_id: string; command_type: string; payload_hash: string; payload_json: string; created_at: string };
export function verifyScheduledCollectionRequest(db: Database.Database, request: CollectionRequestRow): ScheduledCollectionBinding | null {
  try {
    const stored = db.prepare("SELECT id,portfolio_id,actor_id,command_type,payload_hash,payload_json,created_at FROM command_requests WHERE id=?").get(request.id) as CollectionRequestRow | undefined;
    if (!stored || Object.keys(stored).some(key => stored[key as keyof CollectionRequestRow] !== request[key as keyof CollectionRequestRow])) throw new Error();
    const slot = db.prepare("SELECT * FROM collection_schedule_slots WHERE command_request_id=?").get(request.id) as CollectionSlotRow | undefined;
    if (!slot) { if (request.actor_id.startsWith("system:")) throw new Error(); return null; }
    if (!Number.isSafeInteger(slot.authorization_revision) || slot.authorization_revision < 1 || slot.authorization_revision > 1023) throw new Error();
    const history = readCollectionHistory(db, request.portfolio_id, slot.schedule_id, slot.authorization_revision + 1), control = history.controls[slot.authorization_revision - 1], version = history.versions.get(slot.schedule_version_id), next = history.controls[slot.authorization_revision];
    if (!version || !control || request.actor_id !== "system:collection-discovery" || request.command_type !== "market_collect" || control.status !== "enabled" || control.audit_id !== slot.authorization_audit_id || control.version_id !== slot.schedule_version_id || slot.portfolio_id !== request.portfolio_id || slot.scope_key !== history.schedule.scope_key || slot.disposition !== "requested" || slot.reason_code !== null || slot.command_request_id !== request.id || slot.created_at !== request.created_at || !Number.isSafeInteger(slot.expected_publication_revision) || slot.expected_publication_revision! < 0) throw new Error();
    const definition = version.definition;
    if (slot.period < definition.start_date || (definition.end_date !== null && slot.period > definition.end_date) || slot.scheduled_at !== triggerAt(definition, slot.period) || slot.deadline_at !== deadlineAt(definition, slot.period) || instant(slot.scheduled_at) < instant(control.created_at) || instant(slot.created_at) < instant(slot.scheduled_at) || instant(slot.created_at) >= instant(slot.deadline_at) || (next && instant(slot.created_at) >= instant(next.created_at))) throw new Error();
    const payload = parseStrictJson(request.payload_json), expected = { provider: "ecb", feed: "daily", currencies: definition.currencies, expected_publication_revision: slot.expected_publication_revision, publish: true };
    if (canonical(payload) !== canonical(expected) || hash(payload) !== request.payload_hash) throw new Error();
    return { slot, definition, schedule: history.schedule, authorization: { ...control, ended_at: next?.created_at ?? null } };
  } catch { throw new Error("COLLECTION_EVIDENCE_INVALID"); }
}
