import type Database from "better-sqlite3";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import initialSchema from "../../../../contracts/v1/investor-initial-prices.schema.json";
import confirmedSchema from "../../../../contracts/v1/investor-confirmed-feed.schema.json";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { priceInstant } from "../market-price-source";
import { acquisitionSchema, referencePlanSchema, type InvestorAcquisition, type InvestorModelWatch } from "./schemas";
import { validateInvestorModelDocument, validateInvestorMonitorDataDocument } from "./kernel-contracts";
import { modelDefinitionHash } from "./fixed-policy";
import type { InvestorProfileVersion } from "./types";

type Obj = Record<string, unknown>;
type Stored = { id: string; workspace_id: string; model_id: string; document_json: string; content_hash: string; actor_id: string; audit_id: string; created_at: string };
type Request = Stored & { control_id: string; market: "CN" | "HK" | "US"; session_date: string; listing_id?: string; reference_input_id?: string; input_id?: string; not_before?: string; latest_start?: string; stop_at?: string };
type Run = Stored & { request_id: string; job_id: string; capture_id: string | null; status: string };
type Job = { id: string; command_request_id: string | null; job_type: string; scope: string; period: string; input_version: string; status: string;
  max_attempts: number; attempt_count: number; lease_until: string | null; lease_owner: string | null; not_before: string; created_at: string; updated_at: string; result_json: string | null };
type Market = InvestorAcquisition["markets"][number];
const ajv = new Ajv2020({ strict: true, strictRequired: false }); addFormats(ajv); ajv.addSchema(initialSchema); ajv.addSchema(confirmedSchema);
const schemas = { initial_prices: initialSchema, confirmed_close: confirmedSchema };
const codes: Record<string, string> = { collected: "INITIAL_PRICE_COLLECTED", already_available: "INITIAL_PRICE_ALREADY_AVAILABLE", superseded: "INITIAL_PRICE_SUPERSEDED", transport_failed: "INITIAL_PRICE_TRANSPORT_FAILED" };
const confirmedCodes: Record<string, string> = { complete: "CONFIRMED_FEED_COMPLETE", partial: "CONFIRMED_FEED_PARTIAL", no_confirmed_events: "CONFIRMED_FEED_NO_EVENTS", missed_window: "CONFIRMED_FEED_MISSED_WINDOW", superseded: "CONFIRMED_FEED_SUPERSEDED", transport_failed: "CONFIRMED_FEED_TRANSPORT_FAILED" };
function requireTrue(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_ACQUISITION_EVIDENCE_INVALID"); }
function object(value: unknown): Obj { requireTrue(value && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function sealed(row: { document_json: string; content_hash: string }, maximum: number): Obj {
  requireTrue(Buffer.byteLength(row.document_json) <= maximum);
  const value = object(parseStrictJson(row.document_json)); requireTrue(canonical(value) === row.document_json && hash(value) === row.content_hash); return value;
}
function validate(phase: InvestorAcquisition["phase"], kind: "request" | "run" | "admission", value: Obj) {
  requireTrue(ajv.getSchema(schemas[phase].$id + "#/$defs/" + kind)!(value));
}
function audit(db: Database.Database, row: Stored, owner: string, action: string, type: string, at: bigint, id = row.id) {
  const value = db.prepare("SELECT actor_id,action,object_type,object_id,created_at,payload_json FROM audit_events WHERE id=?").get(row.audit_id) as
    { actor_id: string; action: string; object_type: string; object_id: string; created_at: string; payload_json: string } | undefined;
  requireTrue(row.actor_id === owner && priceInstant(row.created_at) <= at && value && value.actor_id === owner && value.action === action
    && value.object_type === type && value.object_id === id && value.created_at === row.created_at && Buffer.byteLength(value.payload_json) <= 2048);
  requireTrue(object(parseStrictJson(value.payload_json)).content_hash === row.content_hash);
}
// Only display clocks are rounded: starts upward, expiry/deadlines downward. Authority keeps microseconds.
export function acquisitionDisplayInstant(value: string, direction: "start" | "deadline" = "deadline"): string {
  const micros = priceInstant(value), remainder = ((micros % 1000n) + 1000n) % 1000n;
  const floor = (micros - remainder) / 1000n;
  return new Date(Number(floor + (direction === "start" && remainder !== 0n ? 1n : 0n))).toISOString();
}
function earliest(values: (string | null)[], direction: "start" | "deadline" = "deadline") {
  const found = values.filter((value): value is string => value !== null).sort((a, b) => priceInstant(a) < priceInstant(b) ? -1 : priceInstant(a) > priceInstant(b) ? 1 : 0);
  return found[0] ? acquisitionDisplayInstant(found[0], direction) : null;
}
function emptyMarket(market: Market["market"], count: number): Market {
  return { market, target_count: count, registered_count: 0, completed_count: 0, status: "not_registered", session_date: null,
    scheduled_at: null, latest_start_at: null, stop_at: null, lease_until: null, valid_until: null, completed_at: null };
}

function requestMetadata(db: Database.Database, row: Request, phase: InvestorAcquisition["phase"], owner: string, modelHash: string,
  modelCreated: string, controlCreated: string, plan: Obj, targets: { listing_id: string; market: Market["market"] }[], at: bigint) {
  const initial = phase === "initial_prices", value = sealed(row, initial ? 8192 : 16384); validate(phase, "request", value);
  audit(db, row, owner, initial ? "investor_schedule_initial_price" : "investor_schedule_confirmed_feed",
    initial ? "investor_initial_price_request" : "investor_confirmed_feed_request", at);
  for (const key of ["workspace_id", "model_id", "control_id", "market", "session_date"]) requireTrue(value[key] === row[key as keyof Request]);
  requireTrue(value.model_hash === modelHash && priceInstant(modelCreated) <= priceInstant(row.created_at) && priceInstant(controlCreated) <= priceInstant(row.created_at));
  const id = initial ? row.reference_input_id : row.input_id;
  const source = db.prepare(initial ? "SELECT content_hash,created_at FROM investor_evidence_inputs WHERE id=? AND workspace_id=?"
    : "SELECT content_hash,created_at FROM investor_monitor_evidence_inputs WHERE id=? AND workspace_id=? AND model_id=?")
    .get(...(initial ? [id, row.workspace_id] : [id, row.workspace_id, row.model_id])) as { content_hash: string; created_at: string } | undefined;
  requireTrue(source && value[initial ? "reference_input_id" : "input_id"] === id
    && value[initial ? "reference_input_hash" : "input_hash"] === source.content_hash && priceInstant(source.created_at) <= priceInstant(row.created_at));
  if (initial) {
    requireTrue(object(plan.reference_evidence).source_input_id === id && value.listing_id === row.listing_id
      && targets.some(target => target.listing_id === row.listing_id && target.market === row.market));
    for (const key of ["rights_review_id", "listing_review_id", "calendar_review_id"]) requireTrue(value[key] === (row as unknown as Obj)[key]);
  } else {
    requireTrue(value.not_before === row.not_before && value.latest_start === row.latest_start && value.stop_at === row.stop_at
      && priceInstant(row.created_at) < priceInstant(value.valid_until) && priceInstant(row.not_before!) <= priceInstant(row.latest_start!)
      && priceInstant(row.latest_start!) < priceInstant(row.stop_at!) && priceInstant(row.stop_at!) < priceInstant(value.valid_until));
    const selected = targets.filter(target => target.market === row.market), seen = new Set<string>();
    for (const target of value.targets as Obj[]) {
      requireTrue(target.session_date === row.session_date);
      const review = db.prepare(`SELECT json_extract(r.document_json,'$.facts.listing_id') listing_id,
        json_extract(r.document_json,'$.facts.market') market FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id AND s.workspace_id=r.workspace_id
        WHERE r.id=? AND r.workspace_id=? AND s.kind='listing'`).get(target.listing_review_id, row.workspace_id) as { listing_id: string; market: string } | undefined;
      requireTrue(review && review.market === row.market && selected.some(item => item.listing_id === review.listing_id) && !seen.has(review.listing_id)); seen.add(review.listing_id);
    }
    requireTrue(seen.size === selected.length);
  }
  priceInstant(value.valid_until); return value;
}

function task(db: Database.Database, row: Request, value: Obj, phase: InvestorAcquisition["phase"], owner: string, currentInput: string | null, at: bigint): Market {
  const initial = phase === "initial_prices", type = initial ? "investor_initial_prices" : "investor_confirmed_watch";
  const count = initial ? 1 : (value.targets as Obj[]).length;
  const result: Market = { ...emptyMarket(row.market, count), registered_count: count, session_date: row.session_date,
    valid_until: acquisitionDisplayInstant(value.valid_until as string), scheduled_at: initial ? null : acquisitionDisplayInstant(row.not_before!, "start"),
    latest_start_at: initial ? null : acquisitionDisplayInstant(row.latest_start!), stop_at: initial ? null : acquisitionDisplayInstant(row.stop_at!) };
  const jobs = db.prepare("SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=?").all(type, row.workspace_id, row.id) as Job[];
  requireTrue(jobs.length <= 1);
  if (!jobs.length) { result.status = "incomplete"; return result; }
  const job = jobs[0];
  requireTrue(job.input_version === row.content_hash && job.command_request_id === null && job.max_attempts === 1
    && Number.isInteger(job.attempt_count) && job.attempt_count >= 0 && job.attempt_count <= 1
    && priceInstant(row.created_at) <= priceInstant(job.created_at) && priceInstant(job.created_at) <= priceInstant(job.updated_at) && priceInstant(job.updated_at) <= at
    && typeof job.not_before === "string"); priceInstant(job.not_before);
  if (!initial) requireTrue(job.not_before === row.not_before || ["failed", "partial"].includes(job.status));
  const run = db.prepare(`SELECT * FROM ${initial ? "investor_initial_price_runs" : "investor_confirmed_feed_runs"} WHERE request_id=? AND workspace_id=? AND model_id=?`)
    .get(row.id, row.workspace_id, row.model_id) as Run | undefined;
  if (run) {
    const doc = sealed(run, 4096); validate(phase, "run", doc);
    audit(db, run, owner, initial ? "investor_complete_initial_price" : "investor_complete_confirmed_feed", initial ? "investor_initial_price_run" : "investor_confirmed_feed_run", at);
    for (const key of ["request_id", "job_id", "capture_id", "status", "created_at"]) requireTrue(doc[key] === run[key as keyof Run]);
    const code = (initial ? codes : confirmedCodes)[run.status];
    const expected = initial ? run.status === "collected" ? "succeeded" : run.status === "transport_failed" ? "failed" : "skipped"
      : run.status === "complete" ? "succeeded" : ["partial", "no_confirmed_events"].includes(run.status) ? "partial" : run.status === "transport_failed" ? "failed" : "skipped";
    requireTrue(run.job_id === job.id && doc.request_hash === row.content_hash && doc.reason_code === code && job.status === expected
      && priceInstant(job.created_at) <= priceInstant(run.created_at) && priceInstant(run.created_at) <= priceInstant(job.updated_at));
    requireTrue(job.result_json !== null && Buffer.byteLength(job.result_json) <= 4096);
    requireTrue(canonical(object(parseStrictJson(job.result_json))) === canonical({ run_id: run.id, code, live_advice_eligible: false }));
    const captured = initial ? run.status === "collected" : ["complete", "partial", "no_confirmed_events"].includes(run.status);
    requireTrue(captured === (run.capture_id !== null) && captured === (doc.receipt_hash !== null));
    if (captured) {
      const capture = db.prepare(`SELECT receipt_hash,qualification,created_at FROM ${initial ? "investor_price_captures" : "investor_confirmed_captures"} WHERE id=? AND workspace_id=?`)
        .get(run.capture_id, row.workspace_id) as { receipt_hash: string; qualification: string; created_at: string } | undefined;
      requireTrue(capture && capture.receipt_hash === doc.receipt_hash && capture.qualification === (initial ? "isolated_official_sdk" : "isolated_official_sdk_callback")
        && priceInstant(capture.created_at) <= priceInstant(run.created_at));
    }
    result.completed_at = acquisitionDisplayInstant(run.created_at);
    const complete = ["collected", "already_available", "complete"].includes(run.status);
    result.completed_count = complete ? count : 0;
    result.status = complete ? "waiting_core" : ({ transport_failed: "failed", no_confirmed_events: "no_events" } as Record<string, Market["status"]>)[run.status] ?? run.status as Market["status"];
    if (!initial && run.status === "complete") {
      const admission = db.prepare("SELECT *,run_id id FROM investor_confirmed_feed_admissions WHERE run_id=? AND workspace_id=? AND model_id=?")
        .get(run.id, row.workspace_id, row.model_id) as (Stored & { input_id: string | null; status: string }) | undefined;
      if (admission) {
        const doc = sealed(admission, 4096); validate(phase, "admission", doc);
        audit(db, admission, owner, "investor_admit_confirmed_feed", "investor_confirmed_feed_run", at, run.id);
        const code = ({ admitted: "CONFIRMED_FEED_ADMITTED", blocked: "CONFIRMED_FEED_INPUT_GAP", superseded: "CONFIRMED_FEED_SUPERSEDED" } as Record<string, string>)[admission.status];
        requireTrue(doc.run_id === run.id && doc.run_hash === run.content_hash && doc.input_id === admission.input_id && doc.status === admission.status
          && doc.created_at === admission.created_at && doc.reason_code === code && priceInstant(job.updated_at) <= priceInstant(admission.created_at));
        if (admission.status === "admitted") {
          const input = db.prepare("SELECT content_hash,created_at FROM investor_monitor_evidence_inputs WHERE id=? AND workspace_id=? AND model_id=?")
            .get(admission.input_id, row.workspace_id, row.model_id) as { content_hash: string; created_at: string } | undefined;
          requireTrue(input && doc.input_hash === input.content_hash && priceInstant(input.created_at) <= priceInstant(admission.created_at));
          result.status = "input_registered";
        } else { requireTrue(admission.input_id === null && doc.input_hash === null); result.status = admission.status === "blocked" ? "incomplete" : "superseded"; }
      }
    }
    return result;
  }
  requireTrue(["queued", "running", "failed"].includes(job.status));
  if (job.status === "failed") { result.status = "failed"; return result; }
  if (!initial && row.input_id !== currentInput) { result.status = "superseded"; return result; }
  if (priceInstant(result.valid_until!) <= at) { result.status = "expired"; return result; }
  if (job.status === "running") {
    requireTrue(job.attempt_count === 1 && job.lease_owner && job.lease_until);
    result.lease_until = acquisitionDisplayInstant(job.lease_until);
    result.status = priceInstant(result.lease_until) > at ? "running" : "lease_expired";
    return result;
  }
  requireTrue(job.attempt_count === 0 && job.lease_until === null && job.lease_owner === null);
  if (!initial && priceInstant(result.latest_start_at!) < at) result.status = "missed_window";
  else { result.scheduled_at = acquisitionDisplayInstant(job.not_before, "start"); result.status = priceInstant(result.scheduled_at) > at ? "scheduled" : "queued"; }
  return result;
}

export function readInvestorAcquisition(db: Database.Database, workspace: string, watch: InvestorModelWatch,
  profile: InvestorProfileVersion, now: string, referenceAvailable: boolean): InvestorAcquisition | undefined {
  const model = db.prepare("SELECT * FROM investor_models WHERE id=? AND workspace_id=?").get(watch.id, workspace) as Stored & { profile_id: string; plan_id: string };
  requireTrue(model); const definition = sealed(model, 16384); validateInvestorModelDocument("definition", definition);
  if (definition.data_mode !== "reconstructed") return undefined;
  requireTrue(definition.model_id === model.id && definition.profile_id === model.profile_id && definition.plan_id === model.plan_id
    && definition.created_at === model.created_at && definition.target_definition_hash === modelDefinitionHash({
      profile_hash: definition.profile_hash, plan_hash: definition.plan_hash, targets: definition.targets,
      schema_version: definition.schema_version, fixed_policy: definition.fixed_policy }));
  const input = db.prepare("SELECT * FROM investor_monitor_evidence_inputs WHERE model_id=? AND workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1")
    .get(model.id, workspace) as Stored | undefined;
  const phase = input ? "confirmed_close" : "initial_prices";
  const base = { model_id: watch.id, checked_at: now, phase, markets: [], evidence_scope: "task_metadata_only", live_advice_eligible: false };
  const status = !watch.enabled ? "paused" : definition.profile_id !== profile.id || definition.profile_hash !== profile.content_hash ? "outdated"
    : priceInstant(definition.valid_until) <= priceInstant(now) ? "expired" : !referenceAvailable ? "source_unavailable" : null;
  if (status) return acquisitionSchema.parse({ ...base, status });
  const control = db.prepare("SELECT id,enabled,created_at FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1")
    .get(workspace, model.id) as { id: string; enabled: number; created_at: string } | undefined;
  const owner = db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as { owner_id: string } | undefined;
  requireTrue(control && control.enabled === 1 && owner && priceInstant(control.created_at) <= priceInstant(now));
  if (input) { const doc = sealed(input, 2097152); validateInvestorMonitorDataDocument("input", doc); requireTrue(doc.model_id === model.id && priceInstant(input.created_at) <= priceInstant(now)); }
  const plan = db.prepare("SELECT document_json,content_hash FROM investor_reference_plans WHERE id=? AND workspace_id=?").get(model.plan_id, workspace) as Stored | undefined;
  requireTrue(plan && plan.content_hash === definition.plan_hash); const reference = referencePlanSchema.parse(sealed(plan, 65536));
  const targets = definition.targets as { listing_id: string; market: Market["market"] }[];
  const initial = phase === "initial_prices", table = initial ? "investor_initial_price_requests" : "investor_confirmed_feed_requests";
  const rows = db.prepare(`SELECT * FROM (SELECT *,row_number() OVER (PARTITION BY ${initial ? "listing_id" : "market"} ORDER BY created_at DESC,rowid DESC) rank
    FROM ${table} WHERE workspace_id=? AND model_id=? AND control_id=?) WHERE rank=1 LIMIT 21`).all(workspace, model.id, control.id) as Request[];
  requireTrue(rows.length <= (initial ? targets.length : 3));
  const projected = rows.map(row => task(db, row, requestMetadata(db, row, phase, owner.owner_id, model.content_hash, model.created_at, control.created_at,
    reference as unknown as Obj, targets, priceInstant(now)), phase, owner.owner_id, input?.id ?? null, priceInstant(now)));
  const priority: Market["status"][] = ["failed", "lease_expired", "expired", "superseded", "missed_window", "partial", "no_events", "running", "queued", "scheduled"];
  const markets = (["CN", "HK", "US"] as const).filter(market => targets.some(target => target.market === market)).map(market => {
    const count = targets.filter(target => target.market === market).length, members = projected.filter(row => row.market === market), result = emptyMarket(market, count);
    if (!members.length) return result;
    result.registered_count = members.reduce((sum, row) => sum + row.registered_count, 0); result.completed_count = members.reduce((sum, row) => sum + row.completed_count, 0);
    result.status = priority.find(status => members.some(row => row.status === status))
      ?? (result.completed_count < count ? "incomplete" : members.every(row => row.status === "input_registered") ? "input_registered" : "waiting_core");
    const active = members.filter(row => ["queued", "scheduled", "running"].includes(row.status));
    result.session_date = new Set(members.map(row => row.session_date)).size === 1 ? members[0].session_date : null;
    result.scheduled_at = earliest((active.length ? active : members).map(row => row.scheduled_at), "start");
    result.latest_start_at = earliest(members.map(row => row.latest_start_at)); result.stop_at = earliest(members.map(row => row.stop_at));
    result.lease_until = earliest(members.filter(row => row.status === "running").map(row => row.lease_until));
    result.valid_until = earliest((active.length ? active : members).map(row => row.valid_until));
    result.completed_at = members.map(row => row.completed_at).filter((at): at is string => at !== null).sort().at(-1) ?? null;
    return result;
  });
  return acquisitionSchema.parse({ ...base, status: "visible", markets });
}

export function investorAcquisitionUnavailable(watch: InvestorModelWatch, now: string): InvestorAcquisition {
  return acquisitionSchema.parse({ model_id: watch.id, checked_at: now, phase: "initial_prices", status: "unavailable", markets: [],
    evidence_scope: "task_metadata_only", live_advice_eligible: false });
}
