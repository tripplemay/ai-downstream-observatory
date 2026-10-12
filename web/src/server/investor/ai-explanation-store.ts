import type Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { audit, canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { assertWritableDatabase } from "../workbench-db";
import { investorHash, investorId, investorInstant } from "./schemas";
import { validateAiMonitorReview, type AiExplanationStatus, type AiMonitorContext, type AiMonitorReview } from "./ai-explanation-schemas";

const requestSchema = z.object({ schema_version: z.literal("investor-ai-request-v1"), id: investorId, workspace_id: investorId,
  actor_id: investorId, observation_id: investorId, binding_hash: investorHash, source_binding_hash: investorHash, context_hash: investorHash,
  config_hash: investorHash, consent_hash: investorHash, implementation_hash: investorHash, created_at: investorInstant, valid_until: investorInstant }).strict();
type Request = z.infer<typeof requestSchema>;
export type AiRequestBinding = Omit<Request, "schema_version" | "id" | "created_at">;
type Obj = Record<string, unknown>;
type Stored = { request: Request; dispatch?: { token: string; started_at: string; deadline: string }; outcome?: {
  status: "complete" | "failed" | "unknown"; reason_code: string | null; review_hash: string | null; created_at: string };
  payload: Buffer | null; purged: boolean };
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_AI_EVIDENCE_INVALID"); }
function owner(db: Database.Database, binding: Pick<Request, "workspace_id" | "actor_id">) {
  check((db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(binding.workspace_id) as Obj | undefined)?.owner_id === binding.actor_id);
}
function auditMatches(db: Database.Database, id: unknown, request: Request, action: string, at: string, payload: unknown) {
  const row = db.prepare("SELECT * FROM audit_events WHERE id=?").get(id) as Obj | undefined;
  check(row && row.actor_id === request.actor_id && row.action === action && row.object_type === "investor_ai_request" && row.object_id === request.id
    && row.portfolio_id === null && row.ledger_revision === null && row.created_at === at && hash(parseStrictJson(row.payload_json as string)) === hash(payload));
}
function key(binding: AiRequestBinding) {
  return hash({ binding: binding.source_binding_hash, context: binding.context_hash, config: binding.config_hash,
    consent: binding.consent_hash, implementation: binding.implementation_hash, valid_until: binding.valid_until });
}
function stored(db: Database.Database, binding: AiRequestBinding, now: string): Stored | null {
  owner(db, binding); investorInstant.parse(now); check(binding.binding_hash === key(binding));
  const row = db.prepare("SELECT * FROM investor_ai_requests WHERE workspace_id=? AND binding_hash=?").get(binding.workspace_id, binding.binding_hash) as Obj | undefined;
  if (!row) return null;
  const request = requestSchema.parse(parseStrictJson(row.document_json as string));
  check(hash(request) === row.content_hash && request.id === row.id && request.workspace_id === row.workspace_id
    && request.observation_id === row.observation_id && request.actor_id === row.actor_id && request.binding_hash === row.binding_hash
    && request.created_at === row.created_at && request.valid_until === row.valid_until && request.created_at <= now && request.created_at < request.valid_until);
  const { id: _, schema_version: __, created_at: ___, ...recordedBinding } = request;
  check(hash(recordedBinding) === hash(binding));
  auditMatches(db, row.audit_id, request, "investor_ai_request", request.created_at, { content_hash: hash(request) });
  const rawDispatch = db.prepare("SELECT * FROM investor_ai_dispatches WHERE request_id=?").get(request.id) as Obj | undefined;
  const dispatch = rawDispatch ? z.object({ token: z.string().regex(/^[a-f0-9]{48}$/), started_at: investorInstant, deadline: investorInstant }).strict()
    .parse({ token: rawDispatch.token, started_at: rawDispatch.started_at, deadline: rawDispatch.deadline })
    : undefined;
  if (dispatch && rawDispatch) {
    check(dispatch.started_at >= request.created_at && dispatch.started_at <= now && dispatch.deadline > dispatch.started_at
      && dispatch.deadline <= request.valid_until && Date.parse(dispatch.deadline) - Date.parse(dispatch.started_at) <= 45000);
    auditMatches(db, rawDispatch.audit_id, request, "investor_ai_dispatch", dispatch.started_at, { token: dispatch.token, deadline: dispatch.deadline });
  }
  const rawPurge = db.prepare("SELECT * FROM investor_ai_purges WHERE request_id=?").get(request.id) as Obj | undefined;
  if (rawPurge) {
    const at = investorInstant.parse(rawPurge.created_at), reason = z.enum(["retention_expired", "binding_changed"]).parse(rawPurge.reason);
    check(rawPurge.actor_id === request.actor_id && at >= request.created_at && at <= now && (reason !== "retention_expired" || at >= request.valid_until));
    auditMatches(db, rawPurge.audit_id, request, "investor_ai_purge", at, { reason });
  }
  const rawOutcome = db.prepare("SELECT * FROM investor_ai_outcomes WHERE request_id=?").get(request.id) as Obj | undefined;
  let outcome: Stored["outcome"];
  if (rawOutcome) {
    check(dispatch);
    outcome = z.object({ status: z.enum(["complete", "failed", "unknown"]), reason_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).nullable(),
      review_hash: investorHash.nullable(), created_at: investorInstant }).strict()
      .parse({ status: rawOutcome.status, reason_code: rawOutcome.reason_code, review_hash: rawOutcome.review_hash, created_at: rawOutcome.created_at });
    check(rawOutcome.token === dispatch.token && outcome.created_at >= dispatch.started_at && outcome.created_at <= now
      && (outcome.status === "complete" ? outcome.reason_code === null && outcome.review_hash !== null
        && outcome.created_at < dispatch.deadline && outcome.created_at < request.valid_until : outcome.reason_code !== null && outcome.review_hash === null)
      && (outcome.status !== "unknown" || outcome.reason_code === "INVESTOR_AI_OUTCOME_UNKNOWN" && outcome.created_at >= dispatch.deadline));
    auditMatches(db, rawOutcome.audit_id, request, "investor_ai_outcome", outcome.created_at, {
      token: dispatch.token, status: outcome.status, reason_code: outcome.reason_code, review_hash: outcome.review_hash });
  }
  const payload = (db.prepare("SELECT payload FROM investor_ai_payloads WHERE request_id=?").get(request.id) as { payload: Buffer } | undefined)?.payload ?? null;
  check(!rawPurge || payload === null);
  check(outcome?.status === "complete" ? Boolean(payload) !== Boolean(rawPurge) : payload === null);
  return { request, dispatch, outcome, payload, purged: Boolean(rawPurge) };
}
export function readDurableAiStatus(db: Database.Database, binding: AiRequestBinding, context: AiMonitorContext, now: string): Pick<AiExplanationStatus, "status" | "reason_code" | "review"> | null {
  return db.transaction(() => readStatus(db, binding, context, now)).deferred();
}
function readStatus(db: Database.Database, binding: AiRequestBinding, context: AiMonitorContext, now: string): Pick<AiExplanationStatus, "status" | "reason_code" | "review"> | null {
  check(hash(context) === binding.context_hash);
  const value = stored(db, binding, now); if (!value) return null;
  if (value.purged) return { status: "failed", reason_code: "INVESTOR_AI_RESULT_PURGED", review: null };
  if (!value.dispatch) {
    check(now < binding.valid_until);
    return { status: "queued", reason_code: null, review: null };
  }
  if (!value.outcome) return value.dispatch.deadline <= now ? { status: "failed", reason_code: "INVESTOR_AI_OUTCOME_UNKNOWN", review: null }
    : { status: "running", reason_code: null, review: null };
  if (value.outcome.status !== "complete") return { status: "failed", reason_code: value.outcome.reason_code, review: null };
  check(now < binding.valid_until && value.payload && value.payload.byteLength <= 16384);
  const review = validateAiMonitorReview(parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(value.payload)), context);
  check(hash(review) === value.outcome.review_hash);
  return { status: "complete", reason_code: null, review };
}
function insertRequest(db: Database.Database, binding: AiRequestBinding, now: string) {
  const request = requestSchema.parse({ ...binding, schema_version: "investor-ai-request-v1", id: randomUUID(), created_at: now });
  check(now < request.valid_until);
  const requestAudit = audit(db, { id: binding.actor_id }, "investor_ai_request", "investor_ai_request", request.id, null, null, { content_hash: hash(request) }, now);
  db.prepare("INSERT INTO investor_ai_requests(id,workspace_id,observation_id,actor_id,binding_hash,document_json,content_hash,created_at,valid_until,audit_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(request.id, request.workspace_id, request.observation_id, request.actor_id, request.binding_hash, canonical(request), hash(request), now, request.valid_until, requestAudit);
  return request;
}
function pendingCount(db: Database.Database) {
  return (db.prepare(`SELECT count(*) n FROM investor_ai_requests r LEFT JOIN investor_ai_dispatches d ON d.request_id=r.id
    LEFT JOIN investor_ai_purges p ON p.request_id=r.id WHERE d.request_id IS NULL AND p.request_id IS NULL`).get() as { n: number }).n;
}
/** Registration is local intent, not proof that any external call was sent. */
export function registerDurableAiRequest(db: Database.Database, binding: AiRequestBinding, now: string) {
  assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db); owner(db, binding); investorInstant.parse(now); check(binding.binding_hash === key(binding));
    const old = stored(db, binding, now); if (old) return old.request.id;
    if (pendingCount(db) >= 64) throw new Error("INVESTOR_AI_BUSY");
    return insertRequest(db, binding, now).id;
  }).immediate();
}
/** The irreversible dispatch latch is committed before invoking any transport. */
export function claimDurableAiRequest(db: Database.Database, binding: AiRequestBinding, now: string): { id: string; token: string } | null {
  assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db); owner(db, binding); investorInstant.parse(now); check(binding.binding_hash === key(binding));
    const old = stored(db, binding, now);
    if (old?.dispatch || old?.purged) return null;
    check(now < binding.valid_until);
    const pending = db.prepare(`SELECT r.workspace_id FROM investor_ai_requests r JOIN investor_ai_dispatches d ON d.request_id=r.id
      LEFT JOIN investor_ai_outcomes o ON o.request_id=r.id WHERE o.request_id IS NULL AND d.deadline>?`).all(now) as { workspace_id: string }[];
    if (pending.length >= 2 || pending.some(row => row.workspace_id === binding.workspace_id)
      || (db.prepare("SELECT count(*) n FROM investor_ai_payloads").get() as { n: number }).n + pending.length >= 64) throw new Error("INVESTOR_AI_BUSY");
    const request = old?.request ?? insertRequest(db, binding, now);
    const token = randomBytes(24).toString("hex"), deadline = new Date(Math.min(Date.parse(now) + 45000, Date.parse(request.valid_until))).toISOString();
    const dispatchAudit = audit(db, { id: binding.actor_id }, "investor_ai_dispatch", "investor_ai_request", request.id, null, null, { token, deadline }, now);
    db.prepare("INSERT INTO investor_ai_dispatches(request_id,token,started_at,deadline,audit_id) VALUES(?,?,?,?,?)").run(request.id, token, now, deadline, dispatchAudit);
    return { id: request.id, token };
  }).immediate();
}
export function finishDurableAiRequest(db: Database.Database, binding: AiRequestBinding, claim: { id: string; token: string }, context: AiMonitorContext,
  now: string, review: AiMonitorReview | null, reason: string | null) {
  assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db); const value = stored(db, binding, now);
    check(value && value.dispatch && value.request.id === claim.id && value.dispatch.token === claim.token && !value.outcome);
    let status = review ? "complete" : "failed", code = reason, reviewHash: string | null = null;
    if (now >= value.dispatch.deadline) { status = "unknown"; code = "INVESTOR_AI_OUTCOME_UNKNOWN"; review = null; }
    if (value.purged && review) { status = "failed"; code = "INVESTOR_AI_BINDING_CHANGED"; review = null; }
    if (review) { check(hash(context) === binding.context_hash); validateAiMonitorReview(review, context); reviewHash = hash(review); }
    check(status === "complete" ? code === null : typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code));
    const event = audit(db, { id: binding.actor_id }, "investor_ai_outcome", "investor_ai_request", claim.id, null, null,
      { token: claim.token, status, reason_code: code, review_hash: reviewHash }, now);
    db.prepare("INSERT INTO investor_ai_outcomes(request_id,token,status,reason_code,review_hash,created_at,audit_id) VALUES(?,?,?,?,?,?,?)")
      .run(claim.id, claim.token, status, code, reviewHash, now, event);
    if (review) db.prepare("INSERT INTO investor_ai_payloads(request_id,payload) VALUES(?,?)").run(claim.id, Buffer.from(canonical(review)));
    return status;
  }).immediate();
}
/** Keep append-only request/outcome hashes, physically remove expired derived text. */
export function purgeDurableAiScope(db: Database.Database, actor: { id: string }, now: string, currentKey: string | null) {
  assertWritableDatabase(db); investorInstant.parse(now);
  return db.transaction(() => {
    assertWritableDatabase(db);
    const rows = db.prepare(`SELECT r.* FROM investor_ai_requests r JOIN investor_workspaces w ON w.id=r.workspace_id
      LEFT JOIN investor_ai_purges p ON p.request_id=r.id WHERE w.owner_id=? AND r.actor_id=? AND p.request_id IS NULL
        AND r.created_at<=? AND (r.valid_until<=? OR r.binding_hash IS NOT ?)`)
      .all(actor.id, actor.id, now, now, currentKey) as Obj[];
    for (const row of rows) {
      const reason = (row.valid_until as string) <= now ? "retention_expired" : "binding_changed";
      const event = audit(db, actor, "investor_ai_purge", "investor_ai_request", row.id as string, null, null, { reason }, now);
      db.prepare("INSERT INTO investor_ai_purges(request_id,actor_id,reason,created_at,audit_id) VALUES(?,?,?,?,?)").run(row.id, actor.id, reason, now, event);
      db.prepare("DELETE FROM investor_ai_payloads WHERE request_id=?").run(row.id);
    }
    return rows.length;
  }).immediate();
}
