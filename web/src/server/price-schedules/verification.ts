import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { instant, priceDeadlineAt, priceTriggerAt, readPriceCollectionHistory } from "./core";
import { assertPriceReferenceHeads, priceSessionDisposition } from "./references";
import type { PriceCollectionSlotRow, ScheduledPriceCollectionBinding } from "./types";

export type PriceCollectionRequestRow = { id: string; portfolio_id: string; actor_id: string; command_type: string; idempotency_key: string; payload_hash: string; payload_json: string; created_at: string };
export function verifyPriceCollectionSlotIdentity(db: Database.Database, slot: PriceCollectionSlotRow) {
  if (!Number.isSafeInteger(slot.authorization_revision) || slot.authorization_revision < 1 || slot.authorization_revision > 1023) throw new Error("PRICE_COLLECTION_EVIDENCE_INVALID");
  const history = readPriceCollectionHistory(db, slot.portfolio_id, slot.schedule_id, slot.authorization_revision + 1);
  const version = history.versions.get(slot.schedule_version_id), control = history.controls[slot.authorization_revision - 1], next = history.controls[slot.authorization_revision];
  if (!version || !control || control.status !== "enabled" || slot.period < version.definition.start_date || slot.period > version.definition.end_date
    || slot.scope_key !== history.schedule.scope_key || slot.authorization_audit_id !== control.audit_id || slot.schedule_version_id !== control.version_id
    || slot.reference_binding_json !== version.reference_binding_json || slot.reference_binding_hash !== version.reference_binding_hash
    || slot.scheduled_at !== priceTriggerAt(version.definition, slot.period) || slot.deadline_at !== priceDeadlineAt(version.definition, slot.period)
    || instant(slot.scheduled_at) < instant(control.created_at) || instant(slot.created_at) < instant(slot.scheduled_at)
    || (next && instant(slot.scheduled_at) >= instant(next.created_at))) throw new Error("PRICE_COLLECTION_EVIDENCE_INVALID");
  return { history, version, control, next };
}
export function verifyScheduledPriceCollectionRequest(db: Database.Database, request: PriceCollectionRequestRow): ScheduledPriceCollectionBinding | null {
  try {
    const stored = db.prepare("SELECT id,portfolio_id,actor_id,command_type,idempotency_key,payload_hash,payload_json,created_at FROM command_requests WHERE id=?").get(request.id) as PriceCollectionRequestRow | undefined;
    if (!stored || Object.keys(stored).some(key => stored[key as keyof PriceCollectionRequestRow] !== request[key as keyof PriceCollectionRequestRow])) throw new Error();
    const slot = db.prepare("SELECT * FROM price_collection_schedule_slots WHERE command_request_id=?").get(request.id) as PriceCollectionSlotRow | undefined;
    if (!slot) { if (typeof request.actor_id !== "string" || /^system(?::|$)/i.test(request.actor_id)) throw new Error(); return null; }
    const { history, control, version, next } = verifyPriceCollectionSlotIdentity(db, slot);
    if (request.actor_id !== "system:price-collection-discovery" || request.command_type !== "market_collect_prices"
      || slot.portfolio_id !== request.portfolio_id || slot.disposition !== "requested" || slot.reason_code !== null
      || slot.command_request_id !== request.id || request.idempotency_key !== "price-collection:" + slot.id || slot.created_at !== request.created_at
      || !Number.isSafeInteger(slot.expected_publication_revision) || slot.expected_publication_revision! < 0
      || instant(slot.created_at) >= instant(slot.deadline_at) || (next && instant(slot.created_at) >= instant(next.created_at))) throw new Error();
    assertPriceReferenceHeads(db, version.reference_binding, slot.created_at);
    if (priceSessionDisposition(db, slot.portfolio_id, version.reference_binding, slot.period) !== "open") throw new Error();
    const definition = version.definition;
    const payload = parseStrictJson(request.payload_json), expected = { schema_version: "market-price-collect-v1", provider: "longport",
      mapping_version_ids: definition.mapping_version_ids, calendar_version_ids: definition.calendar_version_ids,
      start_date: slot.period, end_date: slot.period, expected_publication_revision: slot.expected_publication_revision, publish: true };
    if (canonical(payload) !== canonical(expected) || hash(payload) !== request.payload_hash) throw new Error();
    return { slot, definition, schedule: history.schedule, authorization: { ...control, ended_at: next?.created_at ?? null } };
  } catch { throw new Error("PRICE_COLLECTION_EVIDENCE_INVALID"); }
}
