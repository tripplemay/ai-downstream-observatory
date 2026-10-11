import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { investorCommandSchema, investorInstant, investorProfileSchema } from "./schemas";
import { emptyFundingState, fundingPlanSchema, fundingTimeline, type InvestorFundingPlan, type InvestorFundingState } from "./funding-schemas";
import type { InvestorProfileVersion } from "./types";

type Workspace = { id: string; owner_id: string; revision: number };
type Row = { id: string; version: number; workspace_id: string; profile_id: string; profile_hash: string; document_json: string;
  content_hash: string; actor_id: string; created_at: string; audit_id: string };
function invalid(): never { throw new Error("INVESTOR_FUNDING_EVIDENCE_INVALID"); }

/** Frozen private-plan metadata only; not a current model, market or cash gate. */
export function readInvestorFundingVersion(db: Database.Database, ws: Workspace, id: string, now: string) {
  try {
    const owner = db.prepare("SELECT owner_id,revision FROM investor_workspaces WHERE id=?").get(ws.id) as
      { owner_id: string; revision: number } | undefined;
    if (!owner || owner.owner_id !== ws.owner_id || owner.revision !== ws.revision || !investorInstant.safeParse(now).success) invalid();
    const row = db.prepare("SELECT * FROM investor_funding_plans WHERE workspace_id=? AND id=?").get(ws.id, id) as Row | undefined;
    if (!row) invalid();
    const history = db.prepare("SELECT count(*) n,max(created_at) last_at FROM investor_funding_plans WHERE workspace_id=? AND version<=?")
      .get(ws.id, row.version) as { n: number; last_at: string };
    if (history.n !== row.version || history.last_at !== row.created_at || row.actor_id !== ws.owner_id
      || !investorInstant.safeParse(row.created_at).success || row.created_at > now) invalid();
    const document = fundingPlanSchema.parse(parseStrictJson(row.document_json));
    if (hash(document) !== row.content_hash) invalid();
    const bound = db.prepare("SELECT document_json,content_hash,created_at FROM investor_profiles WHERE id=? AND workspace_id=?").get(row.profile_id, ws.id) as
      { document_json: string; content_hash: string; created_at: string } | undefined;
    if (!bound || bound.content_hash !== row.profile_hash || !investorInstant.safeParse(bound.created_at).success || bound.created_at > row.created_at) invalid();
    const boundProfile = investorProfileSchema.parse(parseStrictJson(bound.document_json));
    if (hash(boundProfile) !== row.profile_hash || document.horizon_years > boundProfile.horizon_years) invalid();
    const audit = db.prepare("SELECT * FROM audit_events WHERE id=?").get(row.audit_id) as Record<string, unknown> | undefined;
    if (!audit || audit.actor_id !== ws.owner_id || audit.action !== "investor_save_funding_plan" || audit.object_type !== "investor_workspace"
      || audit.object_id !== ws.id || audit.portfolio_id !== null || audit.ledger_revision !== null || audit.created_at !== row.created_at) invalid();
    const payload = parseStrictJson(audit.payload_json as string) as { input: unknown; result: unknown };
    if (!payload || canonical(Object.keys(payload).sort()) !== canonical(["input", "result"])) invalid();
    const command = investorCommandSchema.parse(payload.input);
    if (command.action !== "save_funding_plan" || command.expected_revision >= ws.revision || canonical(command.funding_plan) !== canonical(document)
      || canonical(payload.result) !== canonical({ funding_plan_id: row.id, version: row.version, profile_id: row.profile_id,
        profile_hash: row.profile_hash, actual_arrivals_confirmed: false, execution_authorized: false })) invalid();
    return { id: row.id, version: row.version, profile_id: row.profile_id, profile_hash: row.profile_hash, content_hash: row.content_hash,
      created_at: row.created_at, document, timeline: fundingTimeline(document) };
  } catch { invalid(); }
}

export function readInvestorFunding(db: Database.Database, ws: Workspace, profile: InvestorProfileVersion, now: string): InvestorFundingState {
  const row = db.prepare("SELECT id FROM investor_funding_plans WHERE workspace_id=? ORDER BY version DESC LIMIT 1").get(ws.id) as { id: string } | undefined;
  if (!row) return emptyFundingState();
  const plan = readInvestorFundingVersion(db, ws, row.id, now);
  return { status: plan.profile_id === profile.id ? "planned" : "requires_review", plan,
    actual_cash_linked: false, execution_authorized: false, live_advice_eligible: false };
}

export function appendInvestorFunding(db: Database.Database, ws: Workspace, profile: InvestorProfileVersion,
  document: InvestorFundingPlan, id: string, auditId: string, now: string) {
  if (document.horizon_years > profile.document.horizon_years) throw new Error("INVESTOR_FUNDING_HORIZON_CONFLICT");
  const prior = readInvestorFunding(db, ws, profile, now), version = (prior.plan?.version ?? 0) + 1;
  db.prepare(`INSERT INTO investor_funding_plans(id,workspace_id,profile_id,version,profile_hash,document_json,content_hash,actor_id,created_at,audit_id)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, ws.id, profile.id, version, profile.content_hash, canonical(document), hash(document), ws.owner_id, now, auditId);
}
