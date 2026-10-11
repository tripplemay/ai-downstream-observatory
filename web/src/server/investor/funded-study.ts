import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { investorCommandSchema } from "./schemas";
import { readInvestorFunding } from "./funding";
import { latestInvestorResearchInput, readInvestorResearchSource } from "./source-inputs";
import { fundedStudyDenials, fundedStudyRequestSchema, fundedStudyRunSchema, fundedStudyTaskSchema, type FundedStudyRequest } from "./funded-study-schemas";
import { prepareFundedStudyInputs, type FundedStudySource } from "./funded-study-input";
import { prepareFundedHistory } from "./funded-history";
import type { InvestorProfileVersion } from "./types";

type Workspace = { id: string; owner_id: string; revision: number };
type Obj = Record<string, unknown>;
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_FUNDED_STUDY_EVIDENCE_INVALID"); }

export function createFundedStudyRequest(db: Database.Database, ws: Workspace, profile: InvestorProfileVersion, now: string) {
  const funding = readInvestorFunding(db, ws, profile, now);
  if (funding.status !== "planned" || !funding.plan) throw new Error("INVESTOR_FUNDING_CURRENT_PLAN_REQUIRED");
  const head = latestInvestorResearchInput(db, ws.id, now);
  const source = head?.source_kind === "evidence" ? readInvestorResearchSource(db, ws.id, { input_id: null, evidence_input_id: head.id }, now) : null;
  const prepared = source?.payload && source.document ? prepareFundedStudyInputs(funding.plan.document, {
    created_at: source.row.created_at, range_start: (source.document.snapshot as Obj).range_start as string,
    range_end: (source.document.snapshot as Obj).range_end as string, payload: source.payload,
  }, now, profile.document) : { historical_start_date: null, candidate_hashes: [], reason_codes: [source?.unavailable_reason ?? "FUNDED_STUDY_REVIEWED_SOURCE_REQUIRED"] };
  return fundedStudyRequestSchema.parse({ schema_version: "investor-funded-study-request-v1", workspace_id: ws.id,
    profile_id: profile.id, profile_hash: profile.content_hash, funding_plan_id: funding.plan.id, funding_plan_hash: funding.plan.content_hash,
    source_head_id: head?.id ?? null, evidence_input_id: source?.row.id ?? null, input_hash: head?.content_hash ?? null,
    comparison_declared_at: now, window_selection: "earliest_complete_same_calendar_anchor_v1",
    historical_start_date: prepared.historical_start_date, candidate_hashes: prepared.candidate_hashes, reason_codes: prepared.reason_codes,
    ...fundedStudyDenials });
}

export function appendFundedStudyRequest(db: Database.Database, ws: Workspace, document: FundedStudyRequest, id: string, audit: string) {
  db.prepare(`INSERT INTO investor_funded_study_requests(id,workspace_id,profile_id,funding_plan_id,evidence_input_id,input_version,document_json,actor_id,created_at,audit_id)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, ws.id, document.profile_id, document.funding_plan_id, document.evidence_input_id,
      hash(document), canonical(document), ws.owner_id, document.comparison_declared_at, audit);
}

export function readFundedStudyContext(db: Database.Database, ws: Workspace, profile: InvestorProfileVersion, now: string) {
  try {
    const row = db.prepare(`SELECT r.*,j.id job_id,j.status job_status,j.lease_until,u.id run_id,u.status run_status,u.document_json run_json,u.content_hash run_hash,u.created_at run_at
      FROM investor_funded_study_requests r LEFT JOIN job_runs j ON j.job_type='investor_funded_study' AND j.command_request_id IS NULL
        AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.input_version
      LEFT JOIN investor_funded_study_runs u ON u.request_id=r.id AND u.workspace_id=r.workspace_id AND u.job_id=j.id
      WHERE r.workspace_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).get(ws.id) as Obj | undefined;
    if (!row) return null;
    const document = fundedStudyRequestSchema.parse(parseStrictJson(row.document_json as string));
    check(hash(document) === row.input_version && document.workspace_id === ws.id && row.actor_id === ws.owner_id
      && document.profile_id === row.profile_id && document.funding_plan_id === row.funding_plan_id
      && document.evidence_input_id === row.evidence_input_id && document.comparison_declared_at === row.created_at && document.comparison_declared_at <= now);
    const bound = db.prepare("SELECT content_hash,created_at FROM investor_profiles WHERE id=? AND workspace_id=?").get(document.profile_id, ws.id) as Obj | undefined;
    const funding = db.prepare("SELECT content_hash,profile_id,created_at FROM investor_funding_plans WHERE id=? AND workspace_id=?").get(document.funding_plan_id, ws.id) as Obj | undefined;
    check(bound?.content_hash === document.profile_hash && (bound.created_at as string) <= document.comparison_declared_at
      && funding?.content_hash === document.funding_plan_hash && funding.profile_id === document.profile_id && (funding.created_at as string) <= document.comparison_declared_at);
    const event = db.prepare("SELECT * FROM audit_events WHERE id=?").get(row.audit_id) as Obj | undefined;
    check(event?.actor_id === ws.owner_id && event.action === "investor_compare_funding" && event.object_type === "investor_workspace"
      && event.object_id === ws.id && event.portfolio_id === null && event.ledger_revision === null && event.created_at === row.created_at);
    const audit = parseStrictJson(event.payload_json as string) as { input: unknown; result: unknown };
    check(canonical(Object.keys(audit).sort()) === canonical(["input", "result"]));
    const command = investorCommandSchema.parse(audit.input);
    check(command.action === "compare_funding" && command.expected_revision < ws.revision
      && hash(audit.result) === hash({ request_id: row.id, input_version: row.input_version, execution_authorized: false }));
    const currentFunding = readInvestorFunding(db, ws, profile, now), head = latestInvestorResearchInput(db, ws.id, now);
    let outdated = currentFunding.status !== "planned" || currentFunding.plan?.id !== document.funding_plan_id || profile.id !== document.profile_id
      || (head?.id ?? null) !== document.source_head_id || (head?.content_hash ?? null) !== document.input_hash;
    const source = document.evidence_input_id ? readInvestorResearchSource(db, ws.id, { input_id: null, evidence_input_id: document.evidence_input_id }, now) : null;
    if (source) check(source.row.content_hash === document.input_hash && source.row.created_at <= document.comparison_declared_at);
    if (!source) check(document.historical_start_date === null && document.candidate_hashes.length === 0
      && hash(document.reason_codes) === hash(["FUNDED_STUDY_REVIEWED_SOURCE_REQUIRED"]));
    if (source?.unavailable_reason) outdated = true;
    let prepared: ReturnType<typeof prepareFundedStudyInputs> | null = null;
    if (!outdated && source?.payload && source.document && currentFunding.plan) {
      const input: FundedStudySource = { created_at: source.row.created_at, range_start: (source.document.snapshot as Obj).range_start as string,
        range_end: (source.document.snapshot as Obj).range_end as string, payload: source.payload };
      prepared = prepareFundedStudyInputs(currentFunding.plan.document, input, document.comparison_declared_at, profile.document);
      check(hash({ historical_start_date: prepared.historical_start_date, candidate_hashes: prepared.candidate_hashes, reason_codes: prepared.reason_codes })
        === hash({ historical_start_date: document.historical_start_date, candidate_hashes: document.candidate_hashes, reason_codes: document.reason_codes }));
    }
    let reasons = document.reason_codes, status: string = "queued", run: ReturnType<typeof fundedStudyRunSchema.parse> | null = null;
    if (row.run_json !== null) {
      run = fundedStudyRunSchema.parse(parseStrictJson(row.run_json as string));
      check(hash(run) === row.run_hash && run.request_id === row.id && run.input_version === row.input_version && run.status === row.run_status
        && run.created_at === row.run_at && run.created_at >= document.comparison_declared_at && run.created_at <= now && row.job_status === "succeeded");
      check(document.reason_codes.length ? run.status === "blocked" && hash(run.reason_codes) === hash(document.reason_codes)
        : run.status !== "blocked" && hash(run.candidates.map(value => value.parameters_hash)) === hash(document.candidate_hashes));
      if (prepared && run.status !== "blocked") prepared.inputs.forEach((input, index) => {
        check(run!.candidates[index].input_hash === hash(input) && run!.candidates[index].projection_hash === hash(prepareFundedHistory(input).projection));
      });
      reasons = run.reason_codes; status = run.status;
    } else {
      check(row.job_status !== "succeeded");
      check(row.job_status === null || ["queued", "running", "retry_queued", "failed", "skipped", "cancelled"].includes(row.job_status as string));
      status = row.job_status === "running" && Date.parse(row.lease_until as string) > Date.parse(now) ? "running"
        : ["running", "retry_queued"].includes(row.job_status as string) ? "retrying" : row.job_status === "failed" ? "failed"
        : ["skipped", "cancelled"].includes(row.job_status as string) ? "outdated" : "queued";
    }
    if (outdated) { status = "outdated"; reasons = [source?.unavailable_reason ?? "FUNDED_STUDY_BINDING_CHANGED"]; }
    const task = fundedStudyTaskSchema.parse({ id: row.id, profile_id: document.profile_id, funding_plan_id: document.funding_plan_id,
      input_version: row.input_version, status, created_at: row.created_at, completed_at: row.run_at,
      historical_start_date: document.historical_start_date, candidate_count: document.candidate_hashes.length, reason_codes: reasons, ...fundedStudyDenials });
    return { task, request: document, run, run_id: row.run_id as string | null, prepared, source };
  } catch { throw new Error("INVESTOR_FUNDED_STUDY_EVIDENCE_INVALID"); }
}

export function readFundedStudyTask(db: Database.Database, ws: Workspace, profile: InvestorProfileVersion, now: string) {
  return readFundedStudyContext(db, ws, profile, now)?.task ?? null;
}
