import type Database from "better-sqlite3";
import { hash } from "../ledger/service";
import { Decimal } from "../ledger/decimal";
import { parseStrictJson } from "../strict-json";
import { investorInstant, investorProfileSchema, referencePlanSchema, type ReferencePlan } from "./schemas";
import { latestInvestorResearchInput, readInvestorResearchSource } from "./source-inputs";
import { investorResearchRunSchema } from "./research-task";
import { readInvestorTrialRegistry } from "./trial-evidence";
import { validateInvestorReferenceDocument, verifyInvestorKernelResult } from "./kernel-contracts";
import { fixedPolicyDecisionRule, fixedPolicySuffix } from "./fixed-policy";
import { researchEngineForPlan } from "./research-execution";

type JsonObject = Record<string, unknown>;
type SealedRow = { id: string; profile_id: string; document_json: string; content_hash: string; created_at: string };
function requireEvidence(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_EVIDENCE_INVALID"); }
function sealed(row: SealedRow, now: string) {
  const value = parseStrictJson(row.document_json);
  requireEvidence(hash(value) === row.content_hash && investorInstant.safeParse(row.created_at).success && row.created_at <= now);
  return value;
}
function render(profileId: string, requestId: string, runId: string, inputVersion: string,
  source: NonNullable<ReturnType<typeof readInvestorResearchSource>>, result: JsonObject,
  registry: NonNullable<ReturnType<typeof readInvestorTrialRegistry>>, created: string, version: ReferencePlan["schema_version"]): ReferencePlan {
  requireEvidence(source.payload && source.catalog && source.document && source.row.source_qualification === "owner_reviewed_reconstructed"
    && result.status === "reference_ready" && result.data_mode === "reconstructed" && result.qualification === "exploratory_research_only"
    && result.live_advice_eligible === false && registry.freeze_hash && registry.phases.validation.completed === 1 && registry.phases.holdout.completed === 1);
  const parameters = result.selected_parameters as Record<string, unknown> & { weights: Record<string, string> };
  const supported = version === "investor-reference-plan-v2";
  requireEvidence(!supported || parameters.schema_version === "research-fixed-rebalance-parameters-v2");
  const rule = fixedPolicyDecisionRule(parameters, supported);
  const settled = (source.payload.plan as JsonObject).schema_version === "research-plan-v6";
  const eventReview = ["research-plan-v5", "research-plan-v6"].includes((source.payload.plan as JsonObject).schema_version as string);
  const actionAware = ["research-plan-v4", "research-plan-v5", "research-plan-v6"].includes((source.payload.plan as JsonObject).schema_version as string);
  const bounded = ["research-plan-v3", "research-plan-v4", "research-plan-v5", "research-plan-v6"].includes((source.payload.plan as JsonObject).schema_version as string);
  const execution = (source.payload.plan as JsonObject).execution as JsonObject;
  const candidate = (result.candidates as { parameters_hash: string; risk_budget_pass: boolean;
    train: { benchmark_twr: string }; stresses: { label: string; portfolio_return: string }[] }[]).find(row => row.parameters_hash === hash(parameters));
  requireEvidence(candidate?.risk_budget_pass);
  const roles: Record<string, string> = { growth: "成长资产", defensive: "防守资产", diversifier: "分散资产" };
  const percent = (value: string) => new Decimal(value).mul(100).toFixed() + "%";
  const cutoff = source.payload.dataset.observations.filter(row => row.metric === "close" && (row.series_key as string) in parameters.weights)
    .map(row => row.observed_at as string).sort().at(-1);
  requireEvidence(cutoff);
  const cutoffMs = new Date(cutoff).toISOString();
  requireEvidence(cutoff === cutoffMs || cutoff === cutoffMs.replace("Z", "000Z"));
  return referencePlanSchema.parse({ schema_version: version, profile_id: profileId,
    ...(supported ? { fixed_policy: { parameters, evaluation_timezone: (source.payload.plan as JsonObject).evaluation_timezone } } : {}),
    strategy_version: result.engine_version + (bounded ? "+bounded-close-v1" : "") + (actionAware ? "+action-aware-close-v1" : "") + (eventReview ? "+event-review-v1" : "") + (settled ? "+settled-cash-v1" : "") + (rule ? fixedPolicySuffix : ""),
    strategy_evidence: "训练期冻结候选后完成验证与保留期计算；仅为探索性历史研究，保留期独立性未验证。" + (rule ?? ""), input_version: inputVersion,
    data_cutoff: cutoffMs,
    created_at: created, valid_until: source.row.valid_until, data_mode: "reconstructed",
    targets: Object.entries(parameters.weights).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, weight]) => {
      const facts = source.catalog![id]; requireEvidence(facts);
      return { listing_id: id, symbol: facts.provider_symbol, name: facts.provider_symbol, market: facts.market, currency: facts.currency, weight,
        role: roles[facts.role as string], overlap_summary: "未完成基金成分穿透；不同挂牌市场不等于底层资产分散。" };
    }), estimated_cost: "历史比较按冻结费用、滑点与换汇假设；不代表你的券商收费或实际税务成本。" + (bounded
      ? "买入数量按冻结价格缓冲 " + new Decimal(execution.buy_price_buffer_bps as string).div(100).toFixed()
        + "%、外币汇率缓冲 " + new Decimal(execution.buy_fx_buffer_bps as string).div(100).toFixed()
        + "% 及费用预留；超界跳过，不临时缩量。" : "") + (actionAware
        ? "已知公司行动落在决策与预定成交之间时，整批暂不建单，等下一预定评估重新计算；等待仍承担现金机会成本，未知行动仍可取消已建订单。" : "") + (eventReview
        ? "新行动取消尚未成交的整批订单后，仅在预定时点以新价格重新评估并保留替代链；原始取消仍展示，未解决复核或其他执行失败阻止准入。" : "") + (settled
        ? "卖出时只登记尚未冻结的买入意图；完整交收后，在预定决策点按当时现金和目标冻结新买单。未完成或失败意图阻止准入，不重复计入预计卖款。" : ""),
    risk_scenarios: candidate.stresses.map(row => row.label + "：假设组合变化 " + percent(row.portfolio_return) + "；不是发生概率或未来损失上限。"),
    benchmark_summary: "同 ETF 范围、时点与成本口径；训练期基准扣费后 TWR " + percent(candidate.train.benchmark_twr) + "。各阶段重新起算，不是连续个人收益。",
    counterarguments: ["历史目录与可用时点为重建假设，不能排除幸存者偏差或工具外样本曝光。", "较高历史收益不证明未来优势；复杂策略必须与简单基准比较。"],
    uncertainties: ["当前行情、成分重叠、实际费用税务和可买性尚需独立复核。", "保存只登记研究观察模型，不创建实际持仓、现金、批准或订单。"],
    reference_evidence: { request_id: requestId, run_id: runId, source_input_id: source.row.id, experiment_id: registry.experiment_id,
      manifest_hash: registry.manifest_hash, result_hash: result.result_hash, selected_parameters_hash: hash(parameters), holdout_status: registry.holdout_status,
      qualification: "owner_reviewed_reconstructed" }, live_advice_eligible: false });
}

/** Replay sealed research and sources before displaying or selecting a plan. */
export function readEvidenceReference(db: Database.Database, workspaceId: string, planId: string, now: string) {
  try {
    const plan = db.prepare("SELECT * FROM investor_reference_plans WHERE id=? AND workspace_id=?").get(planId, workspaceId) as SealedRow | undefined;
    requireEvidence(plan);
    const document = referencePlanSchema.parse(sealed(plan, now)); validateInvestorReferenceDocument(document);
    requireEvidence(document.profile_id === plan.profile_id && document.created_at === plan.created_at);
    const link = db.prepare("SELECT * FROM investor_reference_evidence WHERE plan_id=? AND workspace_id=?").get(planId, workspaceId) as {
      request_id: string; run_id: string; evidence_input_id: string; result_hash: string; created_at: string } | undefined;
    requireEvidence((document.data_mode === "reconstructed") === (link !== undefined));
    if (!link) return { row: plan, document, unavailable_reason: null };
    requireEvidence(link && link.created_at === plan.created_at && document.reference_evidence!.request_id === link.request_id
      && document.reference_evidence!.run_id === link.run_id && document.reference_evidence!.source_input_id === link.evidence_input_id
      && document.reference_evidence!.result_hash === link.result_hash);
    const request = db.prepare("SELECT * FROM investor_research_requests WHERE id=? AND workspace_id=?").get(link.request_id, workspaceId) as {
      id: string; profile_id: string; input_id: string | null; evidence_input_id: string; input_version: string; document_json: string; created_at: string } | undefined;
    requireEvidence(request && request.profile_id === plan.profile_id && request.evidence_input_id === link.evidence_input_id && request.input_id === null
      && investorInstant.safeParse(request.created_at).success && request.created_at <= plan.created_at);
    const profile = db.prepare("SELECT * FROM investor_profiles WHERE id=? AND workspace_id=?").get(plan.profile_id, workspaceId) as SealedRow | undefined;
    requireEvidence(profile);
    const preferences = investorProfileSchema.parse(sealed(profile, now));
    const source = readInvestorResearchSource(db, workspaceId, request, now); requireEvidence(source);
    const bound = parseStrictJson(request.document_json);
    requireEvidence(hash(bound) === request.input_version && hash(bound) === hash({ schema_version: "investor-research-request-v1",
      engine_version: researchEngineForPlan(source.payload?.plan ?? source.document?.plan), profile_hash: profile.content_hash, input_hash: source.row.content_hash })
      && document.input_version === request.input_version && source.row.created_at <= request.created_at);
    if (source.unavailable_reason) return { row: plan, document, unavailable_reason: source.unavailable_reason };
    const head = latestInvestorResearchInput(db, workspaceId, now);
    if (head?.id !== link.evidence_input_id) return { row: plan, document, unavailable_reason: "REFERENCE_PLAN_SOURCE_CHANGED" };
    const row = db.prepare("SELECT u.*,j.status job_status,j.job_type,j.scope,j.period,j.input_version job_input,j.command_request_id FROM investor_research_runs u JOIN job_runs j ON j.id=u.job_id WHERE u.id=? AND u.workspace_id=?")
      .get(link.run_id, workspaceId) as SealedRow & { request_id: string; status: string; job_status: string; job_type: string; scope: string; period: string; job_input: string; command_request_id: string | null } | undefined;
    requireEvidence(row && row.request_id === request.id && row.created_at === plan.created_at && row.status === "calculated"
      && row.job_status === "succeeded" && row.job_type === "investor_research" && row.scope === workspaceId && row.period === request.id && row.job_input === request.input_version && row.command_request_id === null);
    const run = investorResearchRunSchema.parse(sealed(row, now));
    requireEvidence(run.result && source.payload && run.request_id === request.id && run.profile_id === plan.profile_id
      && run.created_at === plan.created_at && run.input_version === request.input_version && run.status === row.status);
    const result = verifyInvestorKernelResult({ action: "research", ...source.payload, profile: preferences }, run.result);
    requireEvidence(result.result_hash === link.result_hash && result.implementation_hash === run.implementation_hash);
    const registry = readInvestorTrialRegistry(db, workspaceId, request, profile.content_hash, now, run, source); requireEvidence(registry);
    const expected = render(plan.profile_id, request.id, row.id, request.input_version, source, result, registry, plan.created_at, document.schema_version);
    requireEvidence(hash(expected) === plan.content_hash);
    return { row: plan, document, unavailable_reason: null };
  } catch { throw new Error("INVESTOR_EVIDENCE_INVALID"); }
}
