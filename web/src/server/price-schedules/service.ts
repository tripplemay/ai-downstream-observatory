import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { audit, canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { assertWritableDatabase } from "../workbench-db";
import { firstFuturePriceTrigger, instant, parsePriceCollectionDefinition, priceCollectionClock, rawHash, readPriceCollectionHistory, requirePriceCollectionPortfolio, validHumanId } from "./core";
import { assertPriceReferenceHeads, priceCollectionScope, priceScheduleReferences } from "./references";
import { savePriceCollectionScheduleSchema, setPriceCollectionScheduleStatusSchema } from "./schemas";
import type { PriceCollectionActor, PriceCollectionOptions, PriceCollectionScheduleReceipt } from "./types";
export { isPriceCollectionClientError } from "./core";
type Envelope = { portfolio_id: string; idempotency_key: string; expected_schedule_revision: number };
function transact(db: Database.Database, actor: PriceCollectionActor, action: string, input: Envelope, options: PriceCollectionOptions, effect: (now: string) => PriceCollectionScheduleReceipt): PriceCollectionScheduleReceipt {
  if (actor?.kind !== "human" || !validHumanId(actor.id)) throw new Error("PRICE_COLLECTION_PERMISSION_DENIED");
  assertWritableDatabase(db); const now = priceCollectionClock(options), { idempotency_key, ...semantic } = input;
  const fingerprint = hash({ actor_id: actor.id, input: semantic }), scope = `price-collection:${action}:${input.portfolio_id}`;
  return db.transaction(() => {
    assertWritableDatabase(db); requirePriceCollectionPortfolio(db, input.portfolio_id);
    const previous = db.prepare("SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?").get(scope, idempotency_key) as { payload_hash: string; result_json: string } | undefined;
    if (previous) {
      if (previous.payload_hash !== fingerprint) throw new Error("PRICE_COLLECTION_IDEMPOTENCY_CONFLICT");
      try {
        const receipt = parseStrictJson(previous.result_json) as PriceCollectionScheduleReceipt;
        const history = readPriceCollectionHistory(db, input.portfolio_id, receipt.schedule_id, receipt.schedule_revision);
        const control = history.controls.at(-1), version = control && history.versions.get(control.version_id);
        if (!control || !version || control.revision !== receipt.schedule_revision) throw new Error();
        const result: PriceCollectionScheduleReceipt = { schedule_id: history.schedule.id, version_id: version.id, version: version.version, schedule_revision: control.revision, status: control.status, scope_key: history.schedule.scope_key, content_hash: version.content_hash };
        const event = db.prepare("SELECT actor_id,action,payload_json FROM audit_events WHERE id=?").get(control.audit_id) as { actor_id: string; action: string; payload_json: string };
        if (!event || event.actor_id !== actor.id || event.action !== (action === "save" ? "save_price_collection_schedule" : "set_price_collection_schedule_status")
          || canonical(result) !== canonical(receipt) || canonical(parseStrictJson(event.payload_json)) !== canonical({ actor_kind: "human", input, result })) throw new Error();
        return result;
      } catch { throw new Error("PRICE_COLLECTION_IDEMPOTENCY_CONFLICT"); }
    }
    const result = effect(now);
    db.prepare("INSERT INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(scope, idempotency_key, fingerprint, canonical(result), now);
    assertWritableDatabase(db); return result;
  }).immediate();
}
export function savePriceCollectionSchedule(db: Database.Database, actor: PriceCollectionActor, raw: unknown, options: PriceCollectionOptions = {}): PriceCollectionScheduleReceipt {
  const parsed = savePriceCollectionScheduleSchema.safeParse(raw); if (!parsed.success) throw new Error("PRICE_COLLECTION_INVALID_COMMAND"); const input = parsed.data;
  const definition = parsePriceCollectionDefinition(input.definition_json);
  return transact(db, actor, "save", input, options, now => {
    const binding = priceScheduleReferences(db, input.portfolio_id, definition, now, true), scope = priceCollectionScope(binding);
    const existing = db.prepare("SELECT id FROM price_collection_schedules WHERE portfolio_id=? AND scope_key=?").get(input.portfolio_id, scope) as { id: string } | undefined;
    if ((existing?.id ?? null) !== input.expected_schedule_id) throw new Error("PRICE_COLLECTION_SCHEDULE_CONFLICT");
    const history = existing ? readPriceCollectionHistory(db, input.portfolio_id, existing.id) : null;
    if ((history?.head.revision ?? 0) !== input.expected_schedule_revision) throw new Error("PRICE_COLLECTION_SCHEDULE_CONFLICT");
    if (history && instant(now) < instant(history.head.updated_at)) throw new Error("PRICE_COLLECTION_INVALID_CLOCK");
    const scheduleId = existing?.id ?? randomUUID(), versionId = randomUUID(), version = history ? history.versions.size + 1 : 1, revision = input.expected_schedule_revision + 1;
    if (version > 1023 || revision > 1023) throw new Error("PRICE_COLLECTION_LIMIT_REACHED");
    if (!existing) db.prepare("INSERT INTO price_collection_schedules(id,portfolio_id,provider,market,scope_key,created_by,created_at) VALUES(?,?,'longport',?,?,?,?)").run(scheduleId, input.portfolio_id, definition.market, scope, actor.id, now);
    const result: PriceCollectionScheduleReceipt = { schedule_id: scheduleId, version_id: versionId, version, schedule_revision: revision, status: "paused", scope_key: scope, content_hash: rawHash(input.definition_json) };
    const auditId = audit(db, actor, "save_price_collection_schedule", "price_collection_schedule", scheduleId, input.portfolio_id, null, { actor_kind: "human", input, result }, now);
    db.prepare("INSERT INTO price_collection_schedule_versions(id,schedule_id,version,definition_json,content_hash,reference_binding_json,reference_binding_hash,created_by,created_at,audit_id) VALUES(?,?,?,?,?,?,?,?,?,?)").run(versionId, scheduleId, version, input.definition_json, result.content_hash, canonical(binding), hash(binding), actor.id, now, auditId);
    db.prepare("INSERT INTO price_collection_schedule_controls(schedule_id,revision,version_id,status,audit_id,created_at) VALUES(?,?,?,'paused',?,?)").run(scheduleId, revision, versionId, auditId, now);
    if (existing) db.prepare("UPDATE price_collection_schedule_heads SET current_version_id=?,revision=?,status='paused',last_audit_id=?,updated_at=? WHERE schedule_id=? AND revision=?").run(versionId, revision, auditId, now, scheduleId, input.expected_schedule_revision);
    else db.prepare("INSERT INTO price_collection_schedule_heads(schedule_id,scope_key,current_version_id,revision,status,last_audit_id,updated_at) VALUES(?,?,?,1,'paused',?,?)").run(scheduleId, scope, versionId, auditId, now);
    return result;
  });
}
export function setPriceCollectionScheduleStatus(db: Database.Database, actor: PriceCollectionActor, raw: unknown, options: PriceCollectionOptions = {}): PriceCollectionScheduleReceipt {
  const parsed = setPriceCollectionScheduleStatusSchema.safeParse(raw); if (!parsed.success) throw new Error("PRICE_COLLECTION_INVALID_COMMAND"); const input = parsed.data;
  return transact(db, actor, "status", input, options, now => {
    const history = readPriceCollectionHistory(db, input.portfolio_id, input.schedule_id), { head, schedule } = history, version = history.versions.get(head.current_version_id)!;
    if (head.revision !== input.expected_schedule_revision) throw new Error("PRICE_COLLECTION_SCHEDULE_CONFLICT");
    if (head.revision >= 1024 || (head.revision === 1023 && (head.status !== "enabled" || input.status !== "paused"))) throw new Error("PRICE_COLLECTION_LIMIT_REACHED");
    if (instant(now) < instant(head.updated_at)) throw new Error("PRICE_COLLECTION_INVALID_CLOCK");
    if (input.status === "enabled") {
      if (!firstFuturePriceTrigger(version.definition, now)) throw new Error("PRICE_COLLECTION_NO_FUTURE_TRIGGER");
      assertPriceReferenceHeads(db, version.reference_binding);
      priceScheduleReferences(db, input.portfolio_id, version.definition, now, true);
      if (db.prepare("SELECT 1 FROM price_collection_schedule_heads WHERE scope_key=? AND status='enabled' AND schedule_id<>?").get(schedule.scope_key, schedule.id)) throw new Error("PRICE_COLLECTION_SCOPE_CONFLICT");
    }
    const result: PriceCollectionScheduleReceipt = { schedule_id: schedule.id, version_id: version.id, version: version.version, schedule_revision: head.revision + 1, status: input.status, scope_key: schedule.scope_key, content_hash: version.content_hash };
    const auditId = audit(db, actor, "set_price_collection_schedule_status", "price_collection_schedule", schedule.id, input.portfolio_id, null, { actor_kind: "human", input, result }, now);
    db.prepare("INSERT INTO price_collection_schedule_controls(schedule_id,revision,version_id,status,audit_id,created_at) VALUES(?,?,?,?,?,?)").run(schedule.id, result.schedule_revision, version.id, input.status, auditId, now);
    db.prepare("UPDATE price_collection_schedule_heads SET revision=?,status=?,last_audit_id=?,updated_at=? WHERE schedule_id=? AND revision=?").run(result.schedule_revision, input.status, auditId, now, schedule.id, input.expected_schedule_revision);
    return result;
  });
}
