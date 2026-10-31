import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { canonical, hash, createPortfolio, createAccount, type Actor } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { investorCommandSchema, investorInstant, investorProfileSchema, investorReceiptSchema, observationSchema,
  referencePlanSchema, type InvestorObservation, type InvestorProfile } from "./schemas";
import type { InvestorObservationRecord, InvestorProfileVersion, InvestorReceipt, InvestorState } from "./types";
import { enqueueInvestorResearch, readInvestorResearchTask } from "./research-task";
import { appendModelControl, ensureInvestorModel, readInvestorModelWatch } from "./model-watch";
import { readEvidenceReference } from "./reference-evidence";
import { readEvidenceObservationRecord } from "./evidence-monitor";
import { appendInvestorPortfolioLink, ownedInvestorBook, readInvestorPortfolioLink } from "./account-links";
import { getInvestorAccountWorkspace } from "./accounts";
import { reconcileInvestorAccount } from "./reconciliation";
import { recordInvestorTradeFact } from "./trade-recording";
import { recordInvestorExecutionFollowup } from "./execution-followup";
import { reviewInvestorProposal } from "./proposal-review";
import { recordInvestorCashFact } from "./cash-recording";
import { requestInvestorValuation } from "./valuation";
import type { AttachmentOptions } from "../ledger/attachments";
import { fixedPolicyMonitorGap, fixedPolicyUnsupported } from "./fixed-policy";
import { appendInvestorFunding, readInvestorFunding } from "./funding";
import { emptyFundingState } from "./funding-schemas";
import { appendFundedStudyRequest, createFundedStudyRequest, readFundedStudyTask } from "./funded-study";
import { readInvestorAcquisition, investorAcquisitionUnavailable } from "./acquisition";
import { appendMonitorCosts, readMonitorCostState } from "./monitor-costs";

type Workspace = { id: string; owner_id: string; revision: number };
type ProfileRow = { id: string; version: number; document_json: string; content_hash: string; created_at: string };
export type ObservationRow = { id: string; outcome: string; candidate_plan_id: string | null; document_json: string; content_hash: string; profile_id: string; profile_version: number; input_version: string; created_at: string };

function principal(actor: Actor) {
  if (!actor || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(actor.id)) throw new Error("UNAUTHENTICATED");
  return actor.id;
}
function clock(now: string) {
  if (!investorInstant.safeParse(now).success) throw new Error("INVESTOR_INVALID_CLOCK");
  return now;
}
function workspace(db: Database.Database, owner: string) {
  return db.prepare("SELECT id,owner_id,revision FROM investor_workspaces WHERE owner_id=?").get(owner) as Workspace | undefined;
}
function decode<T>(json: string, expected: string, parse: (value: unknown) => T): T {
  try { const value = parseStrictJson(json); if (hash(value) !== expected) throw new Error(); return parse(value); }
  catch { throw new Error("INVESTOR_EVIDENCE_INVALID"); }
}
function profileRecord(row: ProfileRow): InvestorProfileVersion {
  return { id: row.id, version: row.version, content_hash: row.content_hash, created_at: row.created_at,
    document: decode(row.document_json, row.content_hash, value => investorProfileSchema.parse(value)) };
}
function latestProfile(db: Database.Database, id: string) {
  const row = db.prepare("SELECT id,version,document_json,content_hash,created_at FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 1").get(id) as ProfileRow | undefined;
  return row ? profileRecord(row) : null;
}
function checkProfileClock(profile: InvestorProfileVersion | null, now: string) {
  if (profile && (!investorInstant.safeParse(profile.created_at).success || profile.created_at > now)) throw new Error("INVESTOR_INVALID_CLOCK");
}
export function observationRecord(row: ObservationRow, db?: Database.Database, workspaceId?: string, now?: string): InvestorObservationRecord {
  if ((parseStrictJson(row.document_json) as { schema_version?: string }).schema_version === "investor-model-observation-ref-v1") {
    if (!db || !workspaceId || !now) throw new Error("INVESTOR_EVIDENCE_INVALID");
    return readEvidenceObservationRecord(db, workspaceId, row, now);
  }
  const document = decode(row.document_json, row.content_hash, value => observationSchema.parse(value));
  if (document.profile_id !== row.profile_id || document.profile_version !== row.profile_version
      || document.input_version !== row.input_version || document.evaluated_at !== row.created_at || document.outcome !== row.outcome) throw new Error("INVESTOR_EVIDENCE_INVALID");
  return { id: row.id, candidate_plan_id: row.candidate_plan_id, content_hash: row.content_hash, document };
}

function writeAudit(db: Database.Database, actor: string, action: string, id: string, input: unknown, result: unknown, now: string) {
  const auditId = randomUUID();
  db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,portfolio_id,ledger_revision,payload_json,created_at) VALUES(?,?,?,'investor_workspace',?,NULL,NULL,?,?)")
    .run(auditId, actor, "investor_" + action, id, canonical({ input, result }), now);
  return auditId;
}

function evaluateMissingInputs(profile: InvestorProfileVersion, now: string): InvestorObservation {
  const gaps: InvestorObservation["gaps"] = [];
  const add = (code: string, title: string, detail: string, action: string, affected_markets: InvestorProfile["markets"] = []) => gaps.push({ code, title, detail, action, affected_markets });
  if (profile.document.loss_tolerance === null) add("RISK_BUDGET_UNCONFIRMED", "风险预算尚未确认", "投资期限长不代表可以承担无限损失；未填写损失承受能力时不推定风险分档。", "确认阶段性损失承受范围，或先阅读损失情景。");
  if (profile.document.liquidity_need !== "none_in_horizon") add("LIQUIDITY_REVIEW_REQUIRED", "流动性安排需要核对", "预计用款或流动性需求不确定，需先确认可投资期限与预留资金。", "核对未来用款安排；研究预算不能替代实际可用现金。");
  add("REFERENCE_DATASET_NOT_READY", "策略研究数据尚未就绪", "局部行情读取已不等于合格研究数据。仍需将 ETF 身份、当地日历、历史价格、分红/总收益、汇率及数据许可绑定为可复核输入。", "完成所选市场的数据接入和质量验收。", profile.document.markets);
  add("REFERENCE_STRATEGY_NOT_READY", "参考策略证据尚未就绪", "尚无与本版约束绑定、具备同口径成本/风险/基准证据的参考策略，不能输出确定权重。", "完成版本化参考策略及基准验证。", profile.document.markets);
  const inputVersion = hash({ profile: profile.content_hash, dataset: null, strategy: null });
  return observationSchema.parse({ schema_version: "investor-observation-v1", outcome: "insufficient_evidence",
    evaluated_at: now, data_cutoff: null, profile_id: profile.id, profile_version: profile.version,
    input_version: inputVersion, gaps, reasons: ["研究偏好已保存，但当前输入不足以形成可信参考权重。没有把缺数据当作无需调整。"],
    next_review_at: null, next_conditions: ["风险与流动性约束补齐后复核", "合格研究数据或参考策略更新后复核"],
    monitoring: "not_enabled", scope: "research_model", live_advice_eligible: false });
}

function appendObservation(db: Database.Database, ws: Workspace, profile: InvestorProfileVersion, now: string) {
  const document = evaluateMissingInputs(profile, now), id = randomUUID();
  db.prepare("INSERT INTO investor_observations(id,workspace_id,profile_id,candidate_plan_id,outcome,document_json,content_hash,input_version,created_at) VALUES(?,?,?,NULL,?,?,?,?,?)")
    .run(id, ws.id, profile.id, document.outcome, canonical(document), hash(document), document.input_version, now);
  return id;
}

export function executeInvestorCommand(db: Database.Database, actor: Actor, raw: unknown, now = new Date().toISOString(), options: AttachmentOptions = {}): InvestorReceipt {
  const owner = principal(actor), input = investorCommandSchema.parse(raw); clock(now); assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db);
    const fingerprint = hash(input), prior = db.prepare("SELECT payload_hash,result_json FROM investor_commands WHERE owner_id=? AND idempotency_key=?").get(owner, input.idempotency_key) as { payload_hash: string; result_json: string } | undefined;
    if (prior) {
      if (prior.payload_hash !== fingerprint) throw new Error("INVESTOR_DUPLICATE_CONFLICT");
      const result = investorReceiptSchema.safeParse(parseStrictJson(prior.result_json));
      if (!result.success || result.data.workspace_id !== workspace(db, owner)?.id || result.data.action !== input.action
          || result.data.revision !== input.expected_revision + 1) throw new Error("INVESTOR_EVIDENCE_INVALID");
      return result.data;
    }
    let ws = workspace(db, owner);
    if ((ws?.revision ?? 0) !== input.expected_revision) throw new Error("INVESTOR_VERSION_CONFLICT");
    if (!ws) {
      if (input.action !== "save_profile") throw new Error("INVESTOR_PROFILE_REQUIRED");
      ws = { id: randomUUID(), owner_id: owner, revision: 0 };
      db.prepare("INSERT INTO investor_workspaces(id,owner_id,revision,created_at) VALUES(?,?,0,?)").run(ws.id, owner, now);
    }
    let resourceId: string, auditId: string;
    checkProfileClock(latestProfile(db, ws.id), now);
    if (input.action === "save_profile") {
      const current = latestProfile(db, ws.id), id = randomUUID(), version = (current?.version ?? 0) + 1;
      auditId = writeAudit(db, owner, input.action, ws.id, input, { profile_id: id, version }, now);
      db.prepare("INSERT INTO investor_profiles(id,workspace_id,version,document_json,content_hash,actor_id,created_at,audit_id) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, ws.id, version, canonical(input.profile), hash(input.profile), owner, now, auditId);
      const profile = { id, version, document: input.profile, content_hash: hash(input.profile), created_at: now };
      resourceId = appendObservation(db, ws, profile, now);
      enqueueInvestorResearch(db, ws.id, profile, now);
    } else if (input.action === "save_funding_plan") {
      const profile = latestProfile(db, ws.id); if (!profile) throw new Error("INVESTOR_PROFILE_REQUIRED");
      const priorFunding = readInvestorFunding(db, ws, profile, now);
      resourceId = randomUUID();
      auditId = writeAudit(db, owner, input.action, ws.id, input, { funding_plan_id: resourceId,
        version: (priorFunding.plan?.version ?? 0) + 1, profile_id: profile.id, profile_hash: profile.content_hash,
        actual_arrivals_confirmed: false, execution_authorized: false }, now);
      appendInvestorFunding(db, ws, profile, input.funding_plan, resourceId, auditId, now);
    } else if (input.action === "compare_funding") {
      const profile = latestProfile(db, ws.id); if (!profile) throw new Error("INVESTOR_PROFILE_REQUIRED");
      readFundedStudyTask(db, ws, profile, now);
      const document = createFundedStudyRequest(db, ws, profile, now);
      resourceId = randomUUID();
      auditId = writeAudit(db, owner, input.action, ws.id, input, { request_id: resourceId, input_version: hash(document), execution_authorized: false }, now);
      appendFundedStudyRequest(db, ws, document, resourceId, auditId);
    } else if (input.action === "evaluate") {
      const profile = latestProfile(db, ws.id); if (!profile) throw new Error("INVESTOR_PROFILE_REQUIRED");
      resourceId = appendObservation(db, ws, profile, now);
      enqueueInvestorResearch(db, ws.id, profile, now);
      auditId = writeAudit(db, owner, input.action, ws.id, input, { observation_id: resourceId }, now);
    } else if (input.action === "review") {
      const row = db.prepare("SELECT o.*,p.version profile_version FROM investor_observations o JOIN investor_profiles p ON p.id=o.profile_id AND p.workspace_id=o.workspace_id WHERE o.id=? AND o.workspace_id=?").get(input.observation_id, ws.id) as ObservationRow | undefined;
      if (!row) throw new Error("INVESTOR_OBSERVATION_OUT_OF_SCOPE");
      const record = observationRecord(row, db, ws.id, now);
      if (record.document.outcome !== "decision_required") throw new Error("INVESTOR_NO_DECISION_REQUIRED");
      const current = latestProfile(db, ws.id);
      if (current?.id !== record.document.profile_id) throw new Error("INVESTOR_PROFILE_CHANGED");
      const state = getInvestorState(db, actor, now);
      if (state.latest?.id !== input.observation_id || state.effective_outcome !== "decision_required") throw new Error("INVESTOR_OBSERVATION_NOT_CURRENT");
      resourceId = randomUUID();
      auditId = writeAudit(db, owner, input.action, ws.id, input, { decision_id: resourceId, execution_authorized: false }, now);
      db.prepare("INSERT INTO investor_decisions(id,workspace_id,observation_id,decision,note,actor_id,created_at,audit_id) VALUES(?,?,?,?,?,?,?,?)")
        .run(resourceId, ws.id, input.observation_id, input.decision, input.note, owner, now, auditId);
    } else if (input.action === "set_monitor_costs") {
      const state = getInvestorState(db, actor, now);
      if (!state.model_watch || state.model_watch.id !== input.model_id || !state.monitor_costs?.editable) throw new Error("INVESTOR_MONITOR_COSTS_CONTEXT_CONFLICT");
      const { expected_revision: _, idempotency_key: __, ...intent } = input;
      const saved = appendMonitorCosts(db, ws.id, owner, intent, now);
      resourceId = saved.id; auditId = saved.audit_id;
    } else if (input.action === "set_monitoring") {
      const state = getInvestorState(db, actor, now);
      if (!state.model_watch || state.model_watch.id !== input.model_id) throw new Error("INVESTOR_MODEL_OUT_OF_SCOPE");
      if (input.enabled && state.model_watch.profile_id !== state.profile?.id) throw new Error("INVESTOR_PROFILE_CHANGED");
      if (input.enabled && state.model_watch.valid_until <= now) throw new Error("INVESTOR_PLAN_EXPIRED");
      if (input.enabled) {
        const reference = readEvidenceReference(db, ws.id, state.model_watch.plan_id, now);
        if (reference.unavailable_reason) throw new Error("INVESTOR_PLAN_SOURCE_UNAVAILABLE");
        if (fixedPolicyUnsupported(reference.document)) throw new Error(fixedPolicyMonitorGap);
      }
      auditId = writeAudit(db, owner, input.action, ws.id, input, { model_id: input.model_id, enabled: input.enabled, execution_authorized: false }, now);
      resourceId = appendModelControl(db, ws.id, input.model_id, input.enabled, owner, auditId, now);
    } else if (input.action === "link_portfolio") {
      resourceId = randomUUID();
      auditId = writeAudit(db, owner, input.action, ws.id, input, { link_id: resourceId, portfolio_id: input.portfolio_id, execution_authorized: false }, now);
      appendInvestorPortfolioLink(db, ws, input.portfolio_id, input.expected_ledger_revision, resourceId, auditId, now);
    } else if (input.action === "create_account_book") {
      if (getInvestorAccountWorkspace(db, actor, now).books.length >= 100) throw new Error("INVESTOR_ACCOUNT_CAPACITY_REQUIRES_REVIEW");
      const portfolioId = createPortfolio(db, actor, input.book_name, now);
      const accountId = createAccount(db, actor, portfolioId, input.account.name, input.account.broker, input.account.currency, now);
      resourceId = randomUUID();
      auditId = writeAudit(db, owner, input.action, ws.id, input, { link_id: resourceId, portfolio_id: portfolioId, account_id: accountId, execution_authorized: false }, now);
      appendInvestorPortfolioLink(db, ws, portfolioId, 0, resourceId, auditId, now);
    } else if (input.action === "add_linked_account") {
      const link = readInvestorPortfolioLink(db, ws, now);
      if (link?.document.portfolio_id !== input.portfolio_id) throw new Error("INVESTOR_ACCOUNT_OUT_OF_SCOPE");
      const book = ownedInvestorBook(db, owner, input.portfolio_id, now);
      if (book.ledger_revision !== input.expected_ledger_revision) throw new Error("INVESTOR_LEDGER_VERSION_CONFLICT");
      if (getInvestorAccountWorkspace(db, actor, now).accounts.length >= 200) throw new Error("INVESTOR_ACCOUNT_CAPACITY_REQUIRES_REVIEW");
      resourceId = createAccount(db, actor, book.id, input.account.name, input.account.broker, input.account.currency, now);
      auditId = writeAudit(db, owner, input.action, ws.id, input, { account_id: resourceId, portfolio_id: book.id, execution_authorized: false }, now);
    } else if (input.action === "record_linked_trade_fact") {
      const recorded = recordInvestorTradeFact(db, actor, input, now);
      resourceId = recorded.event_id;
      auditId = writeAudit(db, owner, input.action, ws.id, input, { ledger_event_id: recorded.event_id, ledger_revision: recorded.revision,
        ledger_audit_id: recorded.audit_id, duplicate: recorded.duplicate === true, warnings: recorded.warnings,
        basis: "operator_transcription_not_broker_file", execution_authorized: false }, now);
    } else if (input.action === "review_linked_proposal") {
      const recorded = reviewInvestorProposal(db, actor, input, now, options);
      resourceId = recorded.resource_id;
      auditId = writeAudit(db, owner, input.action, ws.id, input, recorded, now);
    } else if (input.action === "link_recorded_execution_fact" || input.action === "record_linked_execution_report") {
      const recorded = recordInvestorExecutionFollowup(db, actor, input, now, options);
      resourceId = recorded.resource_id;
      auditId = writeAudit(db, owner, input.action, ws.id, input, recorded, now);
    } else if (input.action === "record_linked_cash_fact") {
      const recorded = recordInvestorCashFact(db, actor, input, now);
      resourceId = recorded.event_id;
      auditId = writeAudit(db, owner, input.action, ws.id, input, { ledger_event_id: recorded.event_id, ledger_revision: recorded.revision,
        ledger_audit_id: recorded.audit_id, duplicate: recorded.duplicate === true, warnings: recorded.warnings,
        basis: "operator_external_cash_transcription_not_broker_file", execution_authorized: false }, now);
    } else if (input.action === "request_linked_valuation") {
      const request = requestInvestorValuation(db, actor, input, now, options);
      resourceId = request.request_id;
      auditId = writeAudit(db, owner, input.action, ws.id, input, { request_id: resourceId, payload_hash: request.payload_hash,
        status: request.status, basis: input.basis, execution_authorized: false }, now);
    } else if (input.action === "reconcile_linked_account") {
      const run = reconcileInvestorAccount(db, actor, input, now, options);
      resourceId = run.id;
      auditId = writeAudit(db, owner, input.action, ws.id, input, { reconciliation_id: run.id, status: run.status,
        issue_count: run.issues.length, prior_open_issues: run.prior_open_issues, execution_authorized: false }, now);
    } else {
      const row = db.prepare("SELECT id,profile_id,document_json,content_hash,created_at FROM investor_reference_plans WHERE id=? AND workspace_id=?").get(input.plan_id, ws.id) as { id: string; profile_id: string; document_json: string; content_hash: string; created_at: string } | undefined;
      if (!row) throw new Error("INVESTOR_PLAN_OUT_OF_SCOPE");
      const plan = decode(row.document_json, row.content_hash, value => referencePlanSchema.parse(value));
      if (plan.created_at !== row.created_at) throw new Error("INVESTOR_EVIDENCE_INVALID");
      if (plan.profile_id !== row.profile_id || latestProfile(db, ws.id)?.id !== plan.profile_id) throw new Error("INVESTOR_PROFILE_CHANGED");
      if (plan.created_at > now || plan.data_cutoff > now || plan.valid_until <= now) throw new Error("INVESTOR_PLAN_EXPIRED");
      if (readEvidenceReference(db, ws.id, row.id, now).unavailable_reason) throw new Error("INVESTOR_PLAN_SOURCE_UNAVAILABLE");
      resourceId = randomUUID();
      auditId = writeAudit(db, owner, input.action, ws.id, input, { selection_id: resourceId, plan_id: row.id, execution_authorized: false }, now);
      db.prepare("INSERT INTO investor_plan_selections(id,workspace_id,plan_id,actor_id,created_at,audit_id) VALUES(?,?,?,?,?,?)")
        .run(resourceId, ws.id, row.id, owner, now, auditId);
      ensureInvestorModel(db, ws.id, latestProfile(db, ws.id)!, { id: row.id, content_hash: row.content_hash, document: plan }, resourceId, owner, auditId, now);
    }
    const result: InvestorReceipt = { workspace_id: ws.id, revision: ws.revision + 1, action: input.action, resource_id: resourceId, audit_id: auditId };
    db.prepare("UPDATE investor_workspaces SET revision=revision+1 WHERE id=? AND revision=?").run(ws.id, ws.revision);
    db.prepare("INSERT INTO investor_commands(owner_id,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(owner, input.idempotency_key, fingerprint, canonical(result), now);
    assertWritableDatabase(db); return result;
  }).immediate();
}

export function getInvestorState(db: Database.Database, actor: Actor, now = new Date().toISOString(), options: { includeRecentHistory?: boolean } = {}): InvestorState {
  const owner = principal(actor); clock(now);
  const observationLimit = options.includeRecentHistory === false ? 1 : 50, decisionLimit = options.includeRecentHistory === false ? 0 : 50;
  return db.transaction(() => {
    const ws = workspace(db, owner);
    let readOnly = false;
    try { assertWritableDatabase(db); } catch (error) { if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") readOnly = true; else throw error; }
    const empty: InvestorState = { schema_version: "investor-state-v1", workspace_id: ws?.id ?? null, revision: ws?.revision ?? 0,
      checked_at: now, read_only: readOnly, profile: null, profile_history: [],
      latest: null, observations: [], observations_truncated: false, decisions: [], decisions_truncated: false, plan: null, research_task: null, model_watch: null, monitor_costs: null, funding: emptyFundingState(), funded_study: null, funded_study_unavailable: false,
      effective_outcome: "not_started", effective_gaps: [],
      live_advice_eligible: false, actual_holdings_status: "not_linked", ai_status: "not_configured" };
    if (!ws) return empty;
    const profiles = (db.prepare("SELECT id,version,document_json,content_hash,created_at FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 20").all(ws.id) as ProfileRow[]).map(profileRecord);
    if (!profiles.length) throw new Error("INVESTOR_EVIDENCE_INVALID");
    profiles.forEach(profile => checkProfileClock(profile, now));
    const rows = db.prepare(`SELECT o.*,p.version profile_version FROM investor_observations o JOIN investor_profiles p ON p.id=o.profile_id AND p.workspace_id=o.workspace_id WHERE o.workspace_id=? ORDER BY o.created_at DESC,o.rowid DESC LIMIT ${observationLimit + 1}`).all(ws.id) as ObservationRow[];
    const observations = rows.slice(0, observationLimit).map(row => observationRecord(row, db, ws.id, now));
    if (observations.some(row => row.document.evaluated_at > now)) throw new Error("INVESTOR_INVALID_CLOCK");
    const decisions = db.prepare(`SELECT id,observation_id,decision,note,created_at FROM investor_decisions WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT ${decisionLimit + 1}`).all(ws.id) as InvestorState["decisions"];
    if (decisions.some(row => !investorInstant.safeParse(row.created_at).success || row.created_at > now)) throw new Error("INVESTOR_INVALID_CLOCK");
    const selection = db.prepare("SELECT plan_id FROM investor_plan_selections WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(ws.id) as { plan_id: string } | undefined;
    const produced = db.prepare(`SELECT e.plan_id FROM investor_reference_evidence e JOIN investor_reference_plans p ON p.id=e.plan_id AND p.workspace_id=e.workspace_id
      WHERE e.workspace_id=? AND p.profile_id=? ORDER BY e.created_at DESC,e.rowid DESC LIMIT 1`).get(ws.id, profiles[0].id) as { plan_id: string } | undefined;
    const planId = observations[0]?.candidate_plan_id ?? produced?.plan_id ?? selection?.plan_id;
    let plan: InvestorState["plan"] = null;
    let unavailablePlan: string | null = null;
    if (planId) {
      const row = db.prepare("SELECT id,profile_id,document_json,content_hash,created_at FROM investor_reference_plans WHERE id=? AND workspace_id=?").get(planId, ws.id) as { id: string; profile_id: string; document_json: string; content_hash: string; created_at: string } | undefined;
      if (!row) throw new Error("INVESTOR_EVIDENCE_INVALID");
      const document = decode(row.document_json, row.content_hash, value => referencePlanSchema.parse(value));
      if (document.profile_id !== row.profile_id || document.created_at !== row.created_at || document.created_at > now) throw new Error("INVESTOR_EVIDENCE_INVALID");
      const evidence = readEvidenceReference(db, ws.id, row.id, now);
      unavailablePlan = evidence.unavailable_reason;
      if (!unavailablePlan) plan = { id: row.id, content_hash: row.content_hash, document, saved_for_observation: selection?.plan_id === row.id,
        quality: document.profile_id !== profiles[0]?.id ? "different_profile" : document.valid_until <= now ? "expired" : "current" };
    }
    const latest = observations[0] ?? null, effectiveGaps = [...latest?.document.gaps ?? []];
    const gap = (code: string, title: string, detail: string) => effectiveGaps.push({ code, title, detail, affected_markets: profiles[0]?.document.markets ?? [], action: "使用当前约束和有效数据重新评估，保留旧记录。" });
    if (unavailablePlan) gap(unavailablePlan, "参考方案来源已失效", "保留不可变历史记录，但不继续展示或保存旧权重。");
    if (plan && fixedPolicyUnsupported(plan.document)) gap(fixedPolicyMonitorGap, "低频策略持续监测待接入", "此旧版方案未绑定有状态监测规则；请重新研究并保存带冻结规则的新版方案，不套用旧规则给出调整或无需调整结论。");
    if (latest && latest.document.profile_id !== profiles[0]?.id) gap("PROFILE_CHANGED", "约束已更新", "这条结论不属于当前约束版本，不能继续作为当前研究结论。");
    if (latest && latest.document.outcome !== "insufficient_evidence") {
      if (!plan || plan.quality !== "current") gap("REFERENCE_PLAN_NOT_CURRENT", "参考方案已失效或不属于当前约束", "不把历史参考权重作为现在有效的研究结果；需要重新检查来源和约束。");
      if (latest.document.next_review_at !== null && latest.document.next_review_at <= now) gap("MONITOR_REVIEW_OVERDUE", "复核已到期", "尚无按计划提交的新评估，不能把后台没有算出结果当作无需调整。");
      const qualifiedMonitor = (parseStrictJson(rows[0].document_json) as { schema_version?: string }).schema_version === "investor-model-observation-ref-v1";
      if (latest.document.data_cutoff === null || !qualifiedMonitor && plan && (latest.document.input_version !== plan.document.input_version || latest.document.data_cutoff !== plan.document.data_cutoff)) throw new Error("INVESTOR_EVIDENCE_INVALID");
    }
    const researchTask = readInvestorResearchTask(db, ws.id, profiles[0], now);
    const sourceGap = researchTask?.reason_codes.find(code => code.startsWith("REFERENCE_SOURCE_"));
    if (sourceGap && !effectiveGaps.some(value => value.code === sourceGap)) gap(sourceGap, "研究来源已失效", "来源过期、撤回、改版或载荷已删除；旧候选不再作为当前依据。");
    const selectedReference = selection ? selection.plan_id === planId ? unavailablePlan : readEvidenceReference(db, ws.id, selection.plan_id, now).unavailable_reason : null;
    const modelWatch = readInvestorModelWatch(db, ws.id, profiles[0], now, !selectedReference);
    let monitorCosts: InvestorState["monitor_costs"] = null;
    if (modelWatch) {
      let costsUnavailable = false;
      try {
        monitorCosts = readMonitorCostState(db, ws.id, modelWatch.id, now, !readOnly && !selectedReference
          && plan?.id === modelWatch.plan_id && plan.document.data_mode === "reconstructed" && plan.quality === "current"
          && modelWatch.profile_id === profiles[0].id && modelWatch.valid_until > now && !fixedPolicyUnsupported(plan.document));
        costsUnavailable = monitorCosts.status === "pending" || monitorCosts.status === "unavailable";
      } catch { costsUnavailable = true; }
      if (costsUnavailable) {
        gap("MONITOR_COST_ASSUMPTIONS_PENDING", "研究监测费用尚未应用", "费用假设已变化、到期或无法核验；等待按当前证据重新评估，不沿用旧调整结论。");
        modelWatch.model_nav_cny = null;
        if (!["paused", "outdated", "expired"].includes(modelWatch.status)) modelWatch.status = "awaiting_evaluation";
      }
    }
    if (modelWatch) {
      try {
        const acquisition = readInvestorAcquisition(db, ws.id, modelWatch, profiles[0], now, !selectedReference);
        if (acquisition) modelWatch.acquisition = acquisition;
      } catch {
        // Optional task metadata never promotes prices or disables independently checked research.
        modelWatch.acquisition = investorAcquisitionUnavailable(modelWatch, now);
      }
    }
    if (latest?.document.outcome !== "insufficient_evidence" && modelWatch && ["paused", "outdated", "expired", "overdue", "awaiting_evaluation", "queued", "running", "retrying", "failed"].includes(modelWatch.status))
      gap("MONITOR_NOT_CURRENT", "观察任务未提供当前有效结论", "任务暂停、输入变更、失败或复核到期时，不将旧估值作为现在无需调整的依据。");
    const effectiveOutcome: InvestorState["effective_outcome"] = latest === null && !effectiveGaps.length ? "not_started" : effectiveGaps.length ? "insufficient_evidence" : latest!.document.outcome;
    let actualHoldingsStatus: InvestorState["actual_holdings_status"] = "not_linked";
    try { if (readInvestorPortfolioLink(db, ws, now)?.document.portfolio_id) actualHoldingsStatus = "linked"; }
    catch (error) {
      // Optional account evidence must not promote holdings or disable independent research.
      if (error instanceof Error && ["INVESTOR_ACCOUNT_EVIDENCE_INVALID", "INVESTOR_ACCOUNT_OUT_OF_SCOPE"].includes(error.message)) actualHoldingsStatus = "unavailable";
      else throw error;
    }
    let funding = emptyFundingState();
    try { funding = readInvestorFunding(db, ws, profiles[0], now); }
    catch (error) {
      if (error instanceof Error && error.message === "INVESTOR_FUNDING_EVIDENCE_INVALID") funding = emptyFundingState("unavailable");
      else throw error;
    }
    let fundedStudy = null, fundedStudyUnavailable = false;
    try { fundedStudy = readFundedStudyTask(db, ws, profiles[0], now); }
    catch (error) {
      if (error instanceof Error && error.message === "INVESTOR_FUNDED_STUDY_EVIDENCE_INVALID") fundedStudyUnavailable = true;
      else throw error;
    }
    return { ...empty, profile: profiles[0] ?? null, profile_history: profiles, latest: observations[0] ?? null, observations, funding,
      funded_study: fundedStudy, funded_study_unavailable: fundedStudyUnavailable,
      observations_truncated: rows.length > observationLimit, decisions: decisions.slice(0, decisionLimit), decisions_truncated: decisions.length > decisionLimit,
      plan, research_task: researchTask, model_watch: modelWatch, monitor_costs: monitorCosts, effective_outcome: effectiveOutcome, effective_gaps: effectiveGaps,
      actual_holdings_status: actualHoldingsStatus };
  })();
}

export function isInvestorClientError(code: string) {
  if (/^INVESTOR_MONITOR_COSTS_(CONTEXT_CONFLICT|INPUT_INVALID|INVALID)$/.test(code)) return true;
  if (/^INVESTOR_PROPOSAL_(CONTEXT_CONFLICT|CAPACITY_REQUIRES_REVIEW|SELECTION_INVALID|OPERATION_BLOCKED)$/.test(code)) return true;
  if (/^INVESTOR_EXECUTION_(CONTEXT_CONFLICT|CAPACITY_REQUIRES_REVIEW|SELECTION_INVALID|FACT_ALREADY_LINKED|REPORT_DUPLICATE_CONFLICT|UPLOAD_INVALID|UPLOAD_DUPLICATE_CONFLICT)$/.test(code)) return true;
  if (/^INVESTOR_VALUATION_(CONTEXT_CONFLICT|CAPACITY_REQUIRES_REVIEW|RECONCILIATION_REQUIRED|INPUT_INVALID|SOURCE_UNAVAILABLE)$/.test(code)) return true;
  if (/^INVESTOR_CASH_(CONTEXT_CONFLICT|CAPACITY_REQUIRES_REVIEW|ACCOUNT_DISABLED|INPUT_INVALID|SOURCE_SUPERSEDED|SOURCE_DUPLICATE_CONFLICT|CHRONOLOGY_REQUIRES_REVIEW)$/.test(code)) return true;
  if (/^INVESTOR_TRADE_(CONTEXT_CONFLICT|CAPACITY_REQUIRES_REVIEW|ACCOUNT_DISABLED|INPUT_INVALID|SOURCE_SUPERSEDED|SOURCE_DUPLICATE_CONFLICT|CHRONOLOGY_REQUIRES_REVIEW|POSITION_HISTORY_REQUIRED|SETTLEMENT_REVIEW_REQUIRED)$/.test(code)) return true;
  return /^INVESTOR_(VERSION_CONFLICT|DUPLICATE_CONFLICT|PROFILE_REQUIRED|OBSERVATION_OUT_OF_SCOPE|PLAN_OUT_OF_SCOPE|MODEL_OUT_OF_SCOPE|ACCOUNT_OUT_OF_SCOPE|ACCOUNT_INPUT_INVALID|ACCOUNT_CAPACITY_REQUIRES_REVIEW|LEDGER_VERSION_CONFLICT|RECONCILIATION_CONTEXT_CONFLICT|RECONCILIATION_INPUT_INVALID|RECONCILIATION_CUTOFF_UNSUPPORTED|RECONCILIATION_CAPACITY_REQUIRES_REVIEW|FUNDING_HORIZON_CONFLICT|FUNDING_CURRENT_PLAN_REQUIRED|NO_DECISION_REQUIRED|OBSERVATION_NOT_CURRENT|PROFILE_CHANGED|PLAN_EXPIRED|PLAN_SOURCE_UNAVAILABLE|MONITOR_FIXED_POLICY_UNSUPPORTED|INVALID_CLOCK)$/.test(code);
}
