import type Database from "better-sqlite3";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import common from "../../../../contracts/v1/common.schema.json";
import schema from "../../../../contracts/v1/investor-eodhd-source.schema.json";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { priceInstant } from "../market-price-source";
import { acquisitionDisplayInstant } from "./acquisition";
import { actionDraftProgressSchema, type ActionDraftProgress } from "./action-draft-progress-schemas";

type Obj = Record<string, unknown>;
type Grant = { row: Obj; policy: Obj; controls: Obj[]; latest: Obj };
const ajv = new Ajv2020({ strict: true, strictRequired: false });
addFormats(ajv); ajv.addSchema(common); ajv.addSchema(schema);
const ny = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_ACTION_DRAFT_PROGRESS_INVALID"); }
function object(value: unknown): Obj { check(value && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function json(raw: unknown, maximum: number) { check(typeof raw === "string" && Buffer.byteLength(raw) <= maximum); return object(parseStrictJson(raw)); }
function sealed(row: Obj, kind: string, now: string) {
  const value = json(row.document_json, 16384);
  check(ajv.getSchema(schema.$id + "#/$defs/" + kind)!(value) && canonical(value) === row.document_json && hash(value) === row.content_hash
    && priceInstant(row.created_at) <= priceInstant(now));
  return value;
}
function audit(db: Database.Database, row: Obj, owner: string, action: string, type: string) {
  const event = "audit_event_id" in row ? row.audit_event_id ? { actor_id: row.audit_actor_id, action: row.audit_action,
    object_type: row.audit_object_type, object_id: row.audit_object_id, created_at: row.audit_created_at, payload_json: row.audit_payload_json } : undefined
    : db.prepare("SELECT * FROM audit_events WHERE id=?").get(row.audit_id) as Obj | undefined;
  check(row.actor_id === owner && event && event.actor_id === owner && event.action === action && event.object_type === type
    && event.object_id === row.id && event.created_at === row.created_at
    && canonical(json(event.payload_json, 2048)) === canonical({ content_hash: row.content_hash }));
}
function grant(db: Database.Database, row: Obj, owner: string, now: string): Grant {
  const policy = sealed(row, "policy", now); audit(db, row, owner, "investor_register_eodhd_authority", "investor_eodhd_authority");
  check(policy.valid_from === acquisitionDisplayInstant(policy.valid_from as string) && policy.valid_until === acquisitionDisplayInstant(policy.valid_until as string)
    && priceInstant(policy.valid_from) < priceInstant(policy.valid_until));
  const controls = db.prepare(`SELECT c.*,a.id audit_event_id,a.actor_id audit_actor_id,a.action audit_action,a.object_type audit_object_type,
    a.object_id audit_object_id,a.created_at audit_created_at,a.payload_json audit_payload_json FROM investor_eodhd_controls c
    LEFT JOIN audit_events a ON a.id=c.audit_id WHERE c.workspace_id=? AND c.authority_id=? ORDER BY c.version LIMIT 1001`)
    .all(row.workspace_id, row.id) as Obj[];
  check(controls.length > 0 && controls.length <= 1000);
  let previous = row.created_at;
  controls.forEach((control, index) => {
    const value = sealed(control, "control", now); audit(db, control, owner, "investor_control_eodhd_authority", "investor_eodhd_control");
    check(control.authority_id === row.id && control.actor_id === row.actor_id && value.authority_id === row.id
      && value.authority_hash === row.content_hash && control.version === index + 1 && value.version === control.version
      && [0, 1].includes(control.enabled as number) && value.enabled === Boolean(control.enabled)
      && value.created_at === control.created_at && priceInstant(previous) <= priceInstant(control.created_at)
      && (index !== 0 || control.enabled === 0)); previous = control.created_at;
  });
  return { row, policy, controls, latest: controls.at(-1)! };
}
export function unavailableActionDraftProgress(now: string): ActionDraftProgress {
  return actionDraftProgressSchema.parse({ schema_version: "investor-action-draft-progress-v1", checked_at: now,
    refresh_after: new Date(Date.parse(now) + 60000).toISOString(), status: "unavailable", valid_from: null, valid_until: null,
    latest_source_day: null, entries: [], evidence_scope: "task_metadata_not_payload_verification", provider_online_verified: false,
    corporate_actions_complete: false, research_admitted: false, live_advice_eligible: false });
}

/** Bounded owner-scoped task metadata only: never reads raw payloads or grants data eligibility. */
export function readActionDraftProgress(db: Database.Database, workspace: string, owner: string, now: string): ActionDraftProgress {
  return db.transaction(() => readProgress(db, workspace, owner, now)).deferred();
}
function readProgress(db: Database.Database, workspace: string, owner: string, now: string): ActionDraftProgress {
  const owned = db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as Obj | undefined;
  check(owned?.owner_id === owner);
  const result = { ...unavailableActionDraftProgress(now), status: "not_configured" as ActionDraftProgress["status"] };
  const active = db.prepare(`SELECT a.* FROM investor_eodhd_authorities a JOIN investor_eodhd_controls c ON c.authority_id=a.id
    WHERE a.workspace_id=? AND c.enabled=1 AND c.version=(SELECT max(version) FROM investor_eodhd_controls WHERE authority_id=a.id)
      AND json_extract(a.document_json,'$.valid_from')<=? AND json_extract(a.document_json,'$.valid_until')>?
    ORDER BY a.created_at DESC,a.rowid DESC LIMIT 2`).all(workspace, now, now) as Obj[];
  check(active.length <= 1);
  const selectedRow = active[0] ?? db.prepare("SELECT * FROM investor_eodhd_authorities WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(workspace) as Obj | undefined;
  if (!selectedRow) return actionDraftProgressSchema.parse(result);
  const grants = new Map<unknown, Grant>();
  const load = (row: Obj) => {
    let value = grants.get(row.id);
    if (!value) { value = grant(db, row, owner, now); grants.set(row.id, value); }
    return value;
  };
  const selected = load(selectedRow);
  result.valid_from = selected.policy.valid_from as string; result.valid_until = selected.policy.valid_until as string;
  result.status = selected.latest.enabled === 0 ? "disabled" : now >= result.valid_until ? "expired" : now < result.valid_from ? "future" : "waiting_scheduler";
  const deadlines = [result.refresh_after, result.valid_from, result.valid_until];
  if (result.status === "waiting_scheduler") {
    const latest = db.prepare("SELECT source_day FROM investor_eodhd_requests WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(workspace) as Obj | undefined;
    if (latest) {
      const requests = db.prepare("SELECT * FROM investor_eodhd_requests WHERE workspace_id=? AND source_day=? ORDER BY symbol,kind LIMIT 5").all(workspace, latest.source_day) as Obj[];
      check(requests.length === 4); result.latest_source_day = latest.source_day as string;
      result.entries = requests.map(row => {
        const requested = sealed(row, "request", now); audit(db, row, owner, "investor_schedule_eodhd_capture", "investor_eodhd_request");
        const source = db.prepare("SELECT * FROM investor_eodhd_authorities WHERE id=? AND workspace_id=?").get(row.authority_id, workspace) as Obj | undefined;
        check(source); const authority = load(source), control = authority.controls.find(value => value.id === row.control_id);
        check(authority && control && control.enabled === 1 && row.authority_id === requested.authority_id && row.control_id === requested.control_id
          && row.source_day === requested.source_day && row.created_at === requested.created_at && row.valid_until === requested.valid_until
          && requested.authority_hash === authority.row.content_hash && requested.control_hash === control.content_hash
          && priceInstant(control.created_at) <= priceInstant(row.created_at)
          && authority.policy.valid_from! <= row.created_at! && row.created_at! < authority.policy.valid_until!);
        const parameters = object(requested.parameters), parts = Object.fromEntries(ny.formatToParts(new Date(row.created_at as string)).map(part => [part.type, part.value]));
        const day = `${parts.year}-${parts.month}-${parts.day}`, midnight = Date.parse(day + "T00:00:00.000Z");
        check(row.symbol === parameters.symbol && row.kind === parameters.kind && row.source_day === day && Number(parts.hour) >= 1
          && parameters.end_date === new Date(midnight - 86400000).toISOString().slice(0, 10)
          && parameters.start_date === new Date(midnight - 365 * 86400000).toISOString().slice(0, 10));
        deadlines.push(row.valid_until as string);
        const entry: ActionDraftProgress["entries"][number] = { symbol: row.symbol as "VT.US" | "BND.US", kind: row.kind as "div" | "splits",
          status: "closed", qualification: "none", reason_code: null };
        const job = db.prepare("SELECT * FROM job_runs WHERE job_type='investor_eodhd_capture' AND scope=? AND period=? AND input_version=?")
          .get(workspace, row.id, row.content_hash) as Obj | undefined;
        check(job && job.command_request_id === null && job.max_attempts === 1 && [0, 1].includes(job.attempt_count as number)
          && priceInstant(job.created_at) >= priceInstant(row.created_at) && priceInstant(job.updated_at) <= priceInstant(now));
        const capture = db.prepare("SELECT * FROM investor_eodhd_captures WHERE workspace_id=? AND request_id=?").get(workspace, row.id) as Obj | undefined;
        const attempt = db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1").get(job.id) as Obj | undefined;
        if (capture) {
          const document = sealed(capture, "capture", now); audit(db, capture, owner, "investor_finish_eodhd_capture", "investor_eodhd_capture");
          const expected = { captured: "succeeded", transport_failed: "failed", superseded: "skipped" }[capture.status as string];
          check(attempt && expected && job.status === expected && attempt.status === expected && job.attempt_count === 1 && attempt.attempt === 1
            && job.fencing_token === attempt.fencing_token && attempt.fencing_token === capture.fencing_token
            && priceInstant(attempt.started_at) >= priceInstant(row.created_at) && priceInstant(attempt.finished_at) <= priceInstant(now)
            && document.capture_id === capture.id && document.request_id === row.id && document.request_hash === row.content_hash
            && document.workspace_id === workspace && document.job_id === job.id && capture.job_id === job.id
            && document.fencing_token === capture.fencing_token && document.status === capture.status && document.qualification === capture.qualification
            && document.created_at === capture.created_at && document.retain_until === capture.retain_until
            && priceInstant(row.created_at) <= priceInstant(capture.created_at)
            && canonical(json(job.result_json, 2048)) === canonical({ capture_id: capture.id, code: document.reason_code, research_admitted: false }));
          entry.status = capture.status === "captured" ? now >= (capture.retain_until as string) ? "retention_expired" : "captured_draft" : capture.status as "transport_failed" | "superseded";
          entry.qualification = capture.qualification === "injected_test_eodhd" ? "synthetic_test" : "official_transport";
          entry.reason_code = document.reason_code as typeof entry.reason_code;
        } else if (job.attempt_count === 1) {
          check(attempt && priceInstant(attempt.started_at) <= priceInstant(now));
          if (job.status === "running") {
            check(attempt.fencing_token === job.fencing_token && attempt.status === "running" && attempt.finished_at === null && job.lease_until && job.lease_owner);
            entry.status = priceInstant(job.lease_until) <= priceInstant(now) ? "lease_expired" : "running";
            deadlines.push(acquisitionDisplayInstant(job.lease_until as string));
          } else {
            check(priceInstant(attempt.finished_at) <= priceInstant(now) && job.status === "failed"
              && (attempt.fencing_token === job.fencing_token && attempt.status === "failed"
                || attempt.status === "lease_expired" && Number(attempt.fencing_token) + 1 === job.fencing_token));
            entry.status = "indeterminate_no_retry";
          }
        } else {
          check(!attempt && ["queued", "cancelled"].includes(job.status as string));
          entry.status = job.status === "queued" && row.valid_until! > now ? "queued" : "closed";
        }
        return entry;
      }); result.status = "visible";
    }
  }
  result.refresh_after = deadlines.filter(value => value > now).sort()[0];
  return actionDraftProgressSchema.parse(result);
}
