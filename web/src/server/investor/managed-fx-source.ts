import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import common from "../../../../contracts/v1/common.schema.json";
import schema from "../../../../contracts/v1/investor-managed-fx.schema.json";
import { canonical, hash } from "../ledger/service";
import { priceInstant } from "../market-price-source";
import { parseStrictJson } from "../strict-json";
import { currentEcbCollectionWindow, replayCurrentEcbDraft } from "./ecb-reference-source";

type Obj = Record<string, unknown>;
const ajv = new Ajv2020({ strict: true, strictRequired: false });
addFormats(ajv); ajv.addSchema(common); ajv.addSchema(schema);
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_FX_SOURCE_INVALID"); }
function object(value: unknown): Obj { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function json(value: unknown, maximum = 16384) { check(typeof value === "string" && Buffer.byteLength(value) <= maximum); return object(parseStrictJson(value)); }
function read(db: Database.Database, table: string, id: unknown, workspace: string) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND workspace_id=?`).get(id, workspace) as Obj | undefined; check(row); return row;
}
function sealed(row: Obj, kind: string, now: string) {
  const doc = json(row.document_json); check(ajv.getSchema(schema.$id + "#/$defs/" + kind)!(doc)
    && canonical(doc) === row.document_json && hash(doc) === row.content_hash && priceInstant(row.created_at) <= priceInstant(now));
  return doc;
}
function audit(db: Database.Database, row: Obj, workspace: string, action: string, kind: string) {
  const owner = db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as Obj | undefined;
  const event = db.prepare("SELECT * FROM audit_events WHERE id=?").get(row.audit_id) as Obj | undefined;
  check(owner?.owner_id === row.actor_id && event && event.actor_id === row.actor_id && event.action === action
    && event.object_type === kind && event.object_id === row.id && event.created_at === row.created_at
    && hash(json(event.payload_json)) === hash({ content_hash: row.content_hash }));
}
function control(db: Database.Database, row: Obj, authority: Obj, now: string) {
  const doc = sealed(row, "control", now); audit(db, row, authority.workspace_id as string, "investor_control_fx_authority", "investor_fx_control");
  check(row.workspace_id === authority.workspace_id && row.actor_id === authority.actor_id && row.authority_id === authority.id
    && doc.authority_id === authority.id && doc.authority_hash === authority.content_hash && doc.version === row.version
    && typeof row.enabled === "number" && doc.enabled === !!row.enabled && doc.created_at === row.created_at
    && priceInstant(authority.created_at) <= priceInstant(row.created_at));
  return doc;
}
function authority(db: Database.Database, workspace: string, id: unknown, now: string) {
  const row = read(db, "investor_fx_authorities", id, workspace), doc = sealed(row, "authority", now);
  audit(db, row, workspace, "investor_register_fx_authority", "investor_fx_authority");
  check(priceInstant(doc.valid_from) < priceInstant(doc.valid_until) && Array.isArray(doc.currencies)
    && canonical(doc.currencies) === canonical([...doc.currencies].sort()));
  const current = db.prepare("SELECT * FROM investor_fx_controls WHERE authority_id=? AND workspace_id=? ORDER BY version DESC LIMIT 1").get(id, workspace) as Obj | undefined;
  check(current); control(db, current, row, now); return { row, doc, current };
}
function publication(db: Database.Database, workspace: string, id: unknown, now: string) {
  const row = read(db, "investor_fx_publications", id, workspace), doc = sealed(row, "publication", now);
  audit(db, row, workspace, "investor_publish_fx_source", "investor_fx_publication");
  for (const key of ["workspace_id", "authority_id", "capture_id", "sequence", "previous_id", "status", "created_at"]) check(doc[key] === row[key]);
  const refs = object(doc.refs);
  check(doc.publication_id === row.id && (refs.USD ? object(refs.USD).review_id : null) === row.usd_review_id
    && (refs.HKD ? object(refs.HKD).review_id : null) === row.hkd_review_id);
  if (row.previous_id) {
    const previous = read(db, "investor_fx_publications", row.previous_id, workspace), previousDoc = sealed(previous, "publication", now);
    audit(db, previous, workspace, "investor_publish_fx_source", "investor_fx_publication");
    check(previous.authority_id === row.authority_id && previous.status === "published" && previousDoc.status === "published"
      && previous.content_hash === doc.previous_hash && Number(previous.sequence) < Number(row.sequence)
      && priceInstant(previous.created_at) <= priceInstant(row.created_at));
  } else check(doc.previous_hash === null);
  return { row, doc, refs };
}
function state(db: Database.Database, workspace: string, pubId: unknown, now: string) {
  const pub = publication(db, workspace, pubId, now), grant = authority(db, workspace, pub.row.authority_id, now);
  const original = read(db, "investor_fx_controls", pub.doc.control_id, workspace); control(db, original, grant.row, now);
  const capture = read(db, "investor_fx_captures", pub.row.capture_id, workspace), doc = sealed(capture, "capture", now);
  audit(db, capture, workspace, "investor_finish_fx_capture", "investor_fx_capture");
  check(pub.row.actor_id === grant.row.actor_id && capture.actor_id === grant.row.actor_id && pub.doc.authority_hash === grant.row.content_hash
    && pub.doc.control_hash === original.content_hash && pub.doc.capture_hash === capture.content_hash && original.enabled === 1
    && capture.status === "captured" && doc.status === "captured" && doc.capture_id === capture.id
    && doc.retain_until === capture.retain_until && doc.not_before === capture.not_before
    && priceInstant(capture.created_at) <= priceInstant(pub.row.created_at) && priceInstant(capture.not_before) <= priceInstant(pub.row.created_at));
  return { pub, grant, original, capture, doc };
}
function unavailable(db: Database.Database, workspace: string, value: ReturnType<typeof state>, now: string) {
  const { pub, grant, original, capture } = value;
  if (priceInstant(now) >= priceInstant(capture.retain_until) || priceInstant(now) >= priceInstant(grant.doc.valid_until)) return "REFERENCE_SOURCE_EXPIRED";
  if (!grant.current.enabled || grant.current.id !== original.id || priceInstant(now) < priceInstant(grant.doc.valid_from)) return "REFERENCE_SOURCE_NO_LONGER_CURRENT";
  const blocked = db.prepare("SELECT id FROM investor_fx_publications WHERE workspace_id=? AND authority_id=? AND status='blocked' ORDER BY sequence DESC LIMIT 1").get(workspace, pub.row.authority_id) as Obj | undefined;
  if (blocked) { check(publication(db, workspace, blocked.id, now).row.status === "blocked"); return "REFERENCE_SOURCE_NO_LONGER_CURRENT"; }
  if (db.prepare("SELECT 1 FROM investor_fx_purges WHERE capture_id=? AND workspace_id=?").get(capture.id, workspace)) return "REFERENCE_SOURCE_PAYLOAD_PURGED";
  return null;
}

export function managedFxReviewUnavailable(db: Database.Database, workspace: string, reviewId: unknown, now: string) {
  const pub = db.prepare("SELECT id FROM investor_fx_publications WHERE workspace_id=? AND (usd_review_id=? OR hkd_review_id=?)").get(workspace, reviewId, reviewId) as Obj | undefined;
  return pub ? unavailable(db, workspace, state(db, workspace, pub.id, now), now) : null;
}

/** Replays the original XML independently; source approval is the standing owner rule. */
export function verifyManagedFxReview(db: Database.Database, workspace: string, reviewed: Obj, facts: Obj, now: string) {
  if (!facts.monitor_series) return;
  const series = object(facts.monitor_series);
  const registered = db.prepare("SELECT id FROM investor_fx_authorities WHERE id=? AND workspace_id=?").get(series.authority_id, workspace) as Obj | undefined;
  if (!registered) return;
  const pubId = db.prepare("SELECT id FROM investor_fx_publications WHERE workspace_id=? AND authority_id=? AND (usd_review_id=? OR hkd_review_id=?)")
    .get(workspace, registered.id, reviewed.id, reviewed.id) as Obj | undefined;
  check(pubId); const value = state(db, workspace, pubId.id, now), { pub, grant, capture, doc } = value;
  check(!unavailable(db, workspace, value, now));
  check(pub.row.status === "published" && canonical(Object.keys(pub.refs).sort()) === canonical(grant.doc.currencies));
  for (const key of ["workspace_id", "request_id", "job_id", "status", "raw_sha256", "raw_bytes", "not_before", "created_at", "retain_until"]) check(doc[key] === capture[key]);
  const request = read(db, "investor_fx_requests", capture.request_id, workspace), requested = sealed(request, "request", now);
  audit(db, request, workspace, "investor_schedule_fx_capture", "investor_fx_request");
  for (const key of ["workspace_id", "authority_id", "control_id", "feed_day", "created_at", "valid_until"]) check(requested[key] === request[key]);
  check(request.authority_id === grant.row.id && request.control_id === value.original.id && request.actor_id === capture.actor_id
    && requested.authority_hash === grant.row.content_hash && requested.control_hash === value.original.content_hash
    && doc.request_hash === request.content_hash && priceInstant(request.created_at) <= priceInstant(capture.created_at));
  const window = currentEcbCollectionWindow(request.created_at as string);
  const expiry = [priceInstant(window.valid_until), priceInstant(grant.doc.valid_until)].reduce((a,b) => a < b ? a : b);
  check(request.feed_day === window.feed_day && priceInstant(request.valid_until) === expiry
    && priceInstant(grant.row.created_at) <= priceInstant(request.created_at)
    && priceInstant(value.original.created_at) <= priceInstant(request.created_at)
    && priceInstant(grant.doc.valid_from) <= priceInstant(request.created_at)
    && priceInstant(capture.created_at) < expiry);
  const job = db.prepare("SELECT * FROM job_runs WHERE id=?").get(capture.job_id) as Obj | undefined;
  const attempt = db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1").get(capture.job_id) as Obj | undefined;
  check(job && attempt && job.status === "succeeded" && job.job_type === "investor_current_fx" && job.scope === workspace
    && job.period === request.id && job.input_version === request.content_hash && job.max_attempts === 1 && job.attempt_count === 1
    && attempt.fencing_token === doc.fencing_token && hash(json(job.result_json)) === hash({ capture_id: capture.id, code: "FX_DRAFT_CAPTURED", production_admitted: false }));
  const payload = db.prepare("SELECT * FROM investor_fx_payloads WHERE workspace_id=? AND raw_sha256=?").get(workspace, capture.raw_sha256) as Obj | undefined;
  check(payload && Buffer.isBuffer(payload.payload) && payload.payload.length === capture.raw_bytes && payload.raw_bytes === capture.raw_bytes
    && payload.payload.length > 0 && payload.payload.length <= 2097152
    && createHash("sha256").update(payload.payload).digest("hex") === capture.raw_sha256);
  const transport = object(doc.transport), headers = object(transport.headers);
  const contentType = (headers["content-type"] as string).split(";");
  check(["application/xml", "text/xml"].includes(contentType[0].trim().toLowerCase()));
  const charset = contentType.slice(1).filter(part => /^\s*charset\s*=/i.test(part));
  check(charset.length <= 1 && (!charset.length || /^\s*charset\s*=\s*(?:"(?:utf-8|utf8)"|utf-8|utf8)\s*$/i.test(charset[0])));
  check(Object.values(headers).every(text => typeof text === "string" && text.length <= 1024 && [...text].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)));
  if (headers["content-length"] !== undefined) check(typeof headers["content-length"] === "string" && /^[0-9]{1,7}$/.test(headers["content-length"]) && Number(headers["content-length"]) === payload.payload.length);
  const before = [priceInstant(request.created_at), priceInstant(attempt.started_at)].reduce((a,b) => a > b ? a : b);
  check(transport.raw_sha256 === capture.raw_sha256 && transport.raw_bytes === capture.raw_bytes && transport.retrieved_at === transport.completed_at
    && before <= priceInstant(transport.started_at) && priceInstant(transport.started_at) <= priceInstant(transport.completed_at)
    && priceInstant(transport.completed_at) < priceInstant(capture.created_at) + 1000n);
  const retain = [priceInstant(grant.doc.valid_until), priceInstant(capture.created_at) + BigInt(grant.doc.retention_days as number) * 86400000000n].reduce((a,b) => a < b ? a : b);
  check(priceInstant(capture.retain_until) === retain);
  const draft = replayCurrentEcbDraft(payload.payload, transport.retrieved_at as string, grant.doc.currencies as string[]);
  check(hash(draft) === doc.draft_hash && draft.metadata.not_before === capture.not_before);
  const expected = { ...draft.facts[facts.currency as string], monitor_series: { authority_id: grant.row.id, revision_policy: "append_only_no_restatements" } };
  const ref = object(pub.refs[facts.currency as string]);
  check(ref.review_id === reviewed.id && ref.review_hash === reviewed.content_hash && ref.source_id === reviewed.source_id
    && ref.facts_hash === hash(expected) && hash(expected) === hash(facts) && reviewed.created_at === pub.row.created_at
    && reviewed.valid_until === capture.retain_until);
  const source = read(db, "investor_data_sources", ref.source_id, workspace), sourceDoc = json(source.document_json, 131072);
  check(source.kind === "fx" && source.content_hash === ref.source_hash && hash(sourceDoc) === source.content_hash
    && source.actor_id === grant.row.actor_id && source.created_at === pub.row.created_at);
  check(hash(sourceDoc) === hash({ title: "Managed ECB reference FX under owner standing rule", reference: draft.source_document.reference,
    excerpt: canonical({ publication_id: pub.row.id, authority_id: grant.row.id, authority_hash: grant.row.content_hash,
      capture_id: capture.id, capture_hash: capture.content_hash, currency: facts.currency, draft_hash: doc.draft_hash,
      human_review_performed: false, basis: "standing_owner_derivation_rule_not_provider_certified", metadata: draft.metadata }) }));
}
