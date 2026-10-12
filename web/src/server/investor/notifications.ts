import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { audit, canonical, hash, type Actor } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { investorId, investorInstant } from "./schemas";
import { validateInvestorEvidenceMonitor } from "./kernel-contracts";
import { investorInboxSchema, investorNoticeSchema, investorNoticeReadSchema, investorNoticeReceiptSchema, type InvestorNotice } from "./notification-schemas";

type Obj = Record<string, unknown>;
const action = "investor_notification_read", objectType = "investor_notification";
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_NOTIFICATION_EVIDENCE_INVALID"); }
function object(value: unknown): Obj { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function json(value: unknown, maximum = 8192) { check(typeof value === "string" && Buffer.byteLength(value) <= maximum); return object(parseStrictJson(value)); }
function sealed(row: Obj) { const document = json(row.document_json); check(hash(document) === row.content_hash); return document; }
function workspace(db: Database.Database, actor: Actor) {
  investorId.parse(actor.id);
  return db.prepare("SELECT id FROM investor_workspaces WHERE owner_id=?").get(actor.id) as { id: string } | undefined;
}
const query = `SELECT r.*,o.id notice_id,o.topic,o.dedup_key,o.payload_json notice_payload,o.created_at notice_created_at,
  j.status job_status,j.job_type,j.scope job_scope,j.period job_period,j.input_version job_input,j.command_request_id,j.result_json job_result
  FROM investor_evidence_monitor_runs r LEFT JOIN outbox o ON o.dedup_key='investor-monitor:' || r.id
  LEFT JOIN job_runs j ON j.id=r.job_id`;

function publication(db: Database.Database, ws: string, row: Obj, now: string): Omit<InvestorNotice, "read_at"> {
  check(row.workspace_id === ws && row.notice_id && row.topic === "investor.observation.changed"
    && row.dedup_key === "investor-monitor:" + row.id
    && row.notice_created_at === investorInstant.parse(row.created_at).slice(0, -1) + "000Z"
    && row.job_status === "succeeded" && row.job_type === "investor_evidence_monitor" && row.job_scope === ws
    && row.command_request_id === null && investorInstant.parse(row.created_at) <= now);
  const run = sealed(row); validateInvestorEvidenceMonitor("run", run);
  check(run.request_id === row.request_id && run.model_id === row.model_id && run.status === row.status
    && run.created_at === row.created_at && run.valid_until === row.valid_until && run.input_version === row.job_input && row.job_period === row.request_id);
  const observation = db.prepare("SELECT * FROM investor_observations WHERE id=? AND workspace_id=?").get(row.observation_id, ws) as Obj | undefined;
  check(observation); const ref = sealed(observation); validateInvestorEvidenceMonitor("observation_ref", ref);
  const outcome = row.status === "blocked" ? "insufficient_evidence" : row.status;
  check(ref.run_id === row.id && ref.outcome === outcome && observation.outcome === outcome && ref.input_version === run.input_version
    && ref.input_version === observation.input_version && ref.profile_id === observation.profile_id && ref.published_at === row.created_at
    && observation.created_at === row.created_at);
  const payload = json(row.notice_payload, 2048), job = json(row.job_result, 1024);
  check(canonical(payload) === canonical({ workspace_id: ws, model_id: row.model_id, observation_id: row.observation_id,
    outcome, live_advice_eligible: false }) && canonical(job) === canonical({ monitor_run_id: row.id, observation_id: row.observation_id,
    status: row.status, live_advice_eligible: false }));
  const identity = { id: row.notice_id, publication_id: row.id, workspace_id: ws, model_id: row.model_id, observation_id: row.observation_id,
    recorded_outcome: outcome, published_at: row.created_at };
  // This proves historical publication metadata only, never current market/strategy eligibility.
  return investorNoticeSchema.omit({ read_at: true }).parse({ ...identity, publication_hash: hash(identity), is_current_conclusion: false, live_advice_eligible: false });
}
function priorRead(db: Database.Database, actor: Actor, notice: Omit<InvestorNotice, "read_at">, now: string) {
  const row = db.prepare("SELECT * FROM audit_events WHERE actor_id=? AND action='investor_notification_read' AND object_type=? AND object_id=?")
    .get(actor.id, objectType, notice.id) as Obj | undefined;
  if (!row) return null;
  check(row.portfolio_id === null && row.ledger_revision === null);
  const readAt = investorInstant.parse(row.created_at);
  check(readAt >= notice.published_at && readAt <= now
    && canonical(json(row.payload_json, 1024)) === canonical({ workspace_id: notice.workspace_id, publication_hash: notice.publication_hash }));
  return { audit_id: investorId.parse(row.id), read_at: readAt };
}
export function readInvestorNotifications(db: Database.Database, actor: Actor, now = new Date().toISOString()) {
  investorInstant.parse(now);
  return db.transaction(() => {
    let readOnly = false;
    try { assertWritableDatabase(db); } catch (error) { if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") readOnly = true; else throw error; }
    const ws = workspace(db, actor), rows = ws ? db.prepare(query + " WHERE r.workspace_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT 21").all(ws.id) as Obj[] : [];
    const entries = rows.slice(0, 20).map(row => {
      const notice = publication(db, ws!.id, row, now); return { ...notice, read_at: priorRead(db, actor, notice, now)?.read_at ?? null };
    });
    return investorInboxSchema.parse({ schema_version: "investor-notifications-v1", workspace_id: ws?.id ?? null, checked_at: now,
      read_only: readOnly, entries, has_more: rows.length > 20, visible_unread_count: entries.filter(entry => entry.read_at === null).length,
      external_delivery_configured: false, live_advice_eligible: false });
  }).deferred();
}
export function readInvestorNotification(db: Database.Database, actor: Actor, raw: unknown, now = new Date().toISOString()) {
  const input = investorNoticeReadSchema.parse(raw); investorInstant.parse(now); assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db); const ws = workspace(db, actor);
    const row = ws ? db.prepare(query + " WHERE r.workspace_id=? AND o.id=?").get(ws.id, input.notice_id) as Obj | undefined : undefined;
    if (!row) throw new Error("INVESTOR_NOTIFICATION_NOT_FOUND");
    const notice = publication(db, ws!.id, row, now);
    if (notice.publication_hash !== input.publication_hash) throw new Error("INVESTOR_NOTIFICATION_CHANGED");
    const existing = priorRead(db, actor, notice, now), saved = existing ?? { read_at: now,
      audit_id: audit(db, actor, action, objectType, notice.id, null, null, { workspace_id: ws!.id, publication_hash: notice.publication_hash }, now) };
    return investorNoticeReceiptSchema.parse({ schema_version: "investor-notification-read-v1", ...input, ...saved, financial_state_changed: false });
  }).immediate();
}
