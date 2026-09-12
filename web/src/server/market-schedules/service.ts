import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { audit, canonical, hash } from "../ledger/service";
import { assertWritableDatabase } from "../workbench-db";
import { collectionClock, collectionScope, firstFutureTrigger, instant, parseCollectionDefinition, rawHash, readCollectionHistory, requireCollectionPortfolio } from "./core";
import { saveCollectionScheduleSchema, setCollectionScheduleStatusSchema } from "./schemas";
import type { CollectionActor, CollectionOptions, CollectionScheduleReceipt } from "./types";
export { isCollectionClientError } from "./core";
type Envelope = { portfolio_id: string; idempotency_key: string; expected_schedule_revision: number };
function transact<T>(db: Database.Database, actor: CollectionActor, action: string, input: Envelope, options: CollectionOptions, effect: (now: string) => T): T {
  if (!actor?.id?.trim() || actor.kind !== "human" || actor.id.startsWith("system:")) throw new Error("COLLECTION_PERMISSION_DENIED");
  assertWritableDatabase(db); const now = collectionClock(options), { idempotency_key, ...semantic } = input;
  const fingerprint = hash({ actor_id: actor.id, input: semantic }), scope = `collection:${action}:${input.portfolio_id}`;
  return db.transaction(() => {
    assertWritableDatabase(db); requireCollectionPortfolio(db, input.portfolio_id);
    const previous = db.prepare("SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?").get(scope, idempotency_key) as { payload_hash: string; result_json: string } | undefined;
    if (previous) { if (previous.payload_hash !== fingerprint) throw new Error("COLLECTION_IDEMPOTENCY_CONFLICT"); assertWritableDatabase(db); return JSON.parse(previous.result_json) as T; }
    const result = effect(now);
    db.prepare("INSERT INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(scope, idempotency_key, fingerprint, canonical(result), now);
    assertWritableDatabase(db); return result;
  }).immediate();
}
export function saveCollectionSchedule(db: Database.Database, actor: CollectionActor, raw: unknown, options: CollectionOptions = {}) {
  const parsed = saveCollectionScheduleSchema.safeParse(raw); if (!parsed.success) throw new Error("COLLECTION_INVALID_COMMAND"); const input = parsed.data;
  const definition = parseCollectionDefinition(input.definition_json), scope = collectionScope(definition);
  return transact(db, actor, "save", input, options, now => {
    const existing = db.prepare("SELECT id FROM collection_schedules WHERE portfolio_id=? AND scope_key=?").get(input.portfolio_id, scope) as { id: string } | undefined;
    if ((existing?.id ?? null) !== input.expected_schedule_id) throw new Error("COLLECTION_SCHEDULE_CONFLICT");
    const history = existing ? readCollectionHistory(db, input.portfolio_id, existing.id) : null;
    if ((history?.head.revision ?? 0) !== input.expected_schedule_revision || input.expected_schedule_revision >= Number.MAX_SAFE_INTEGER) throw new Error("COLLECTION_SCHEDULE_CONFLICT");
    if (history && instant(now) < instant(history.head.updated_at)) throw new Error("COLLECTION_INVALID_CLOCK");
    const scheduleId = existing?.id ?? randomUUID(), versionId = randomUUID(), version = history ? history.versions.size + 1 : 1, revision = input.expected_schedule_revision + 1;
    if (version > 1023 || revision > 1023) throw new Error("COLLECTION_LIMIT_REACHED");
    if (!existing) db.prepare("INSERT INTO collection_schedules(id,portfolio_id,provider,scope_key,created_by,created_at) VALUES(?,?,'ecb',?,?,?)").run(scheduleId, input.portfolio_id, scope, actor.id, now);
    const result: CollectionScheduleReceipt = { schedule_id: scheduleId, version_id: versionId, version, schedule_revision: revision, status: "paused", scope_key: scope, content_hash: rawHash(input.definition_json) };
    const auditId = audit(db, actor, "save_collection_schedule", "collection_schedule", scheduleId, input.portfolio_id, null, { actor_kind: "human", input, result }, now);
    db.prepare("INSERT INTO collection_schedule_versions(id,schedule_id,version,definition_json,content_hash,created_by,created_at,audit_id) VALUES(?,?,?,?,?,?,?,?)").run(versionId, scheduleId, version, input.definition_json, result.content_hash, actor.id, now, auditId);
    db.prepare("INSERT INTO collection_schedule_controls(schedule_id,revision,version_id,status,audit_id,created_at) VALUES(?,?,?,'paused',?,?)").run(scheduleId, revision, versionId, auditId, now);
    if (existing) db.prepare("UPDATE collection_schedule_heads SET current_version_id=?,revision=?,status='paused',last_audit_id=?,updated_at=? WHERE schedule_id=? AND revision=?").run(versionId, revision, auditId, now, scheduleId, input.expected_schedule_revision);
    else db.prepare("INSERT INTO collection_schedule_heads(schedule_id,scope_key,current_version_id,revision,status,last_audit_id,updated_at) VALUES(?,?,?,1,'paused',?,?)").run(scheduleId, scope, versionId, auditId, now);
    return result;
  });
}
export function setCollectionScheduleStatus(db: Database.Database, actor: CollectionActor, raw: unknown, options: CollectionOptions = {}) {
  const parsed = setCollectionScheduleStatusSchema.safeParse(raw); if (!parsed.success) throw new Error("COLLECTION_INVALID_COMMAND"); const input = parsed.data;
  return transact(db, actor, "status", input, options, now => {
    const history = readCollectionHistory(db, input.portfolio_id, input.schedule_id), { head, schedule } = history, version = history.versions.get(head.current_version_id)!;
    if (head.revision !== input.expected_schedule_revision) throw new Error("COLLECTION_SCHEDULE_CONFLICT");
    if (head.revision >= 1024 || (head.revision === 1023 && (head.status !== "enabled" || input.status !== "paused"))) throw new Error("COLLECTION_LIMIT_REACHED");
    if (instant(now) < instant(head.updated_at)) throw new Error("COLLECTION_INVALID_CLOCK");
    if (input.status === "enabled") {
      if (!firstFutureTrigger(version.definition, now)) throw new Error("COLLECTION_NO_FUTURE_TRIGGER");
      if (db.prepare("SELECT 1 FROM collection_schedule_heads WHERE scope_key=? AND status='enabled' AND schedule_id<>?").get(schedule.scope_key, schedule.id)) throw new Error("COLLECTION_SCOPE_CONFLICT");
    }
    const result: CollectionScheduleReceipt = { schedule_id: schedule.id, version_id: version.id, version: version.version, schedule_revision: head.revision + 1, status: input.status, scope_key: schedule.scope_key, content_hash: version.content_hash };
    const auditId = audit(db, actor, "set_collection_schedule_status", "collection_schedule", schedule.id, input.portfolio_id, null, { actor_kind: "human", input, result }, now);
    db.prepare("INSERT INTO collection_schedule_controls(schedule_id,revision,version_id,status,audit_id,created_at) VALUES(?,?,?,?,?,?)").run(schedule.id, result.schedule_revision, version.id, input.status, auditId, now);
    db.prepare("UPDATE collection_schedule_heads SET revision=?,status=?,last_audit_id=?,updated_at=? WHERE schedule_id=? AND revision=?").run(result.schedule_revision, input.status, auditId, now, schedule.id, input.expected_schedule_revision);
    return result;
  });
}
