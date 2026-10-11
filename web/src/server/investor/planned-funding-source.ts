import type Database from "better-sqlite3";
import { Decimal } from "../ledger/decimal";
import { hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { readInvestorFunding, readInvestorFundingVersion } from "./funding";
import { investorInstant, investorProfileSchema } from "./schemas";
import type { InvestorProfileVersion } from "./types";
import { validateInvestorModelDocument } from "./kernel-contracts";
import { modelDefinitionHash, fixedPolicyUnsupported } from "./fixed-policy";
import { readEvidenceReference } from "./reference-evidence";
import { plannedFundingContextHash, projectPlannedFundingMonitor, type PlannedFundingBinding, type PlannedFundingRequest } from "./planned-funding-monitor";

type Obj = Record<string, unknown>;
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_PLANNED_FUNDING_SOURCE_INVALID"); }
function text(value: unknown): string { check(typeof value === "string"); return value; }
function sealed(row: Obj) { const document = parseStrictJson(text(row.document_json)); check(hash(document) === row.content_hash); return document as Obj; }
function clock(now: string, ...values: unknown[]) {
  check(investorInstant.safeParse(now).success);
  for (const value of values) check(investorInstant.safeParse(value).success && text(value) <= now);
}

/** Historical calendar assumptions only. Current source/selection/control gates remain independent. */
export function readBoundPlannedFundingMonitor(db: Database.Database, actor: { id: string }, workspaceId: string,
  binding: PlannedFundingBinding, evaluatedAt: string, now: string) {
  return db.transaction(() => {
    clock(now, evaluatedAt);
    const ws = db.prepare("SELECT * FROM investor_workspaces WHERE id=? AND owner_id=?").get(workspaceId, actor.id) as
      { id: string; owner_id: string; revision: number } | undefined;
    check(ws);
    const model = db.prepare("SELECT * FROM investor_models WHERE workspace_id=? AND id=?").get(workspaceId, binding.model_id) as Obj | undefined;
    check(model && model.content_hash === binding.model_hash && model.created_at === binding.model_created_at);
    clock(evaluatedAt, model.created_at, binding.plan_declared_at);
    const definition = sealed(model);
    validateInvestorModelDocument("definition", definition);
    check(definition.model_id === model.id && definition.profile_id === model.profile_id && definition.plan_id === model.plan_id
      && definition.created_at === model.created_at && definition.profile_hash === binding.profile_hash && definition.data_mode === "reconstructed"
      && definition.target_definition_hash === modelDefinitionHash(definition as Parameters<typeof modelDefinitionHash>[0]));
    if (definition.schema_version === "investor-model-definition-v2") {
      const rule = definition.fixed_policy as { evaluation_timezone: string; parameters: { weights: Record<string, string>; roles: Obj } };
      const targets = definition.targets as { listing_id: string; weight: string }[];
      new Intl.DateTimeFormat("en-US", { timeZone: rule.evaluation_timezone });
      const ids = targets.map(row => row.listing_id).sort();
      check(new Set(ids).size === ids.length && hash(ids) === hash(Object.keys(rule.parameters.weights).sort())
        && hash(ids) === hash(Object.keys(rule.parameters.roles).sort())
        && targets.every(row => new Decimal(row.weight).eq(rule.parameters.weights[row.listing_id])));
    }
    const funding = readInvestorFundingVersion(db, ws, binding.funding_plan_id, evaluatedAt);
    check(funding.content_hash === binding.funding_plan_hash && funding.created_at === binding.plan_declared_at
      && funding.profile_id === model.profile_id && funding.profile_hash === binding.profile_hash);
    const profile = db.prepare("SELECT * FROM investor_profiles WHERE workspace_id=? AND id=?").get(workspaceId, funding.profile_id) as Obj | undefined;
    check(profile && profile.content_hash === funding.profile_hash && profile.version === definition.profile_version);
    investorProfileSchema.parse(sealed(profile));
    const request: PlannedFundingRequest = { schema_version: "investor-planned-funding-monitor-v1", funding_plan: funding.document,
      binding: { funding_plan_id: funding.id, funding_plan_hash: funding.content_hash, profile_hash: funding.profile_hash,
        model_id: text(model.id), model_hash: text(model.content_hash), model_created_at: text(model.created_at), plan_declared_at: funding.created_at },
      evaluated_at: evaluatedAt };
    check(hash(request.binding) === hash(binding));
    return { request, projection: projectPlannedFundingMonitor(request), context_hash: plannedFundingContextHash(request) };
  }).deferred();
}

/** Read-only preparation, not automatic core admission or a new monitoring result. */
export function readPlannedFundingMonitor(db: Database.Database, actor: { id: string }, workspaceId: string, modelId: string, now: string) {
  return db.transaction(() => {
    const ws = db.prepare("SELECT * FROM investor_workspaces WHERE id=? AND owner_id=?").get(workspaceId, actor.id) as
      { id: string; owner_id: string; revision: number } | undefined;
    check(ws);
    const profile = db.prepare("SELECT * FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 1").get(workspaceId) as Obj | undefined;
    const selected = db.prepare("SELECT plan_id,created_at FROM investor_plan_selections WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1")
      .get(workspaceId) as Obj | undefined;
    const model = db.prepare("SELECT * FROM investor_models WHERE workspace_id=? AND id=?").get(workspaceId, modelId) as Obj | undefined;
    const control = db.prepare("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1")
      .get(workspaceId, modelId) as Obj | undefined;
    check(profile && selected && model && control && control.enabled === 1);
    clock(now, profile.created_at, selected.created_at, model.created_at, control.created_at);
    const preferences = investorProfileSchema.parse(sealed(profile)), definition = sealed(model);
    validateInvestorModelDocument("definition", definition);
    check(definition.model_id === model.id && definition.profile_id === profile.id && model.profile_id === profile.id
      && definition.profile_hash === profile.content_hash && definition.profile_version === profile.version
      && definition.plan_id === model.plan_id && selected.plan_id === model.plan_id && definition.created_at === model.created_at
      && definition.target_definition_hash === modelDefinitionHash(definition as Parameters<typeof modelDefinitionHash>[0])
      && definition.data_mode === "reconstructed" && investorInstant.safeParse(definition.valid_until).success && text(definition.valid_until) > now);
    const reference = readEvidenceReference(db, workspaceId, text(model.plan_id), now);
    check(!reference.unavailable_reason && reference.document.data_mode === "reconstructed" && !fixedPolicyUnsupported(reference.document)
      && reference.row.content_hash === definition.plan_hash && reference.document.profile_id === profile.id
      && reference.document.valid_until === definition.valid_until
      && hash(reference.document.targets.map(({ listing_id, market, currency, weight }) => ({ listing_id, market, currency, weight }))) === hash(definition.targets)
      && (reference.document.schema_version === "investor-reference-plan-v2") === (definition.schema_version === "investor-model-definition-v2")
      && (reference.document.schema_version !== "investor-reference-plan-v2" || hash(reference.document.fixed_policy) === hash(definition.fixed_policy)));
    const boundProfile: InvestorProfileVersion = { id: text(profile.id), version: profile.version as number, content_hash: text(profile.content_hash),
      created_at: text(profile.created_at), document: preferences };
    const funding = readInvestorFunding(db, ws, boundProfile, now);
    if (funding.status === "not_configured") return null;
    check(funding.status === "planned" && funding.plan);
    const request: PlannedFundingRequest = { schema_version: "investor-planned-funding-monitor-v1", funding_plan: funding.plan.document,
      binding: { funding_plan_id: funding.plan.id, funding_plan_hash: funding.plan.content_hash, profile_hash: funding.plan.profile_hash,
        model_id: modelId, model_hash: text(model.content_hash), model_created_at: text(model.created_at), plan_declared_at: funding.plan.created_at }, evaluated_at: now };
    return readBoundPlannedFundingMonitor(db, actor, workspaceId, request.binding, now, now);
  }).deferred();
}
