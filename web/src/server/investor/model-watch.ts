import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { investorId, investorHash, investorInstant, modelWatchSchema, referencePlanSchema, fixedPolicyBindingSchema, type ReferencePlan } from "./schemas";
import { validateInvestorModelDocument, modelAssessmentObservation } from "./kernel-contracts";
import { Decimal } from "../ledger/decimal";
import type { InvestorProfileVersion } from "./types";
import { readEvidenceModelWatch } from "./evidence-monitor";
import { fixedPolicyUnsupported, modelDefinitionHash } from "./fixed-policy";

type Row = { id: string; workspace_id: string; profile_id: string; plan_id: string; document_json: string; content_hash: string; created_at: string };
const target = z.object({ listing_id: investorId, market: z.enum(["CN", "HK", "US"]), currency: z.enum(["CNY", "HKD", "USD"]), weight: z.string() }).strict();
const definitionV1Schema = z.object({ schema_version: z.literal("investor-model-definition-v1"), model_id: investorId,
  profile_id: investorId, profile_version: z.number().int().positive().safe(), profile_hash: investorHash,
  plan_id: investorId, plan_hash: investorHash, target_definition_hash: investorHash, targets: z.array(target).min(1).max(20),
  created_at: investorInstant, valid_until: investorInstant, data_mode: z.enum(["live_observed", "synthetic", "reconstructed"]),
  scope: z.literal("research_model"), live_advice_eligible: z.literal(false) }).strict();
const definitionSchema = z.union([definitionV1Schema, definitionV1Schema.extend({ schema_version: z.literal("investor-model-definition-v2"),
  data_mode: z.literal("reconstructed"), fixed_policy: fixedPolicyBindingSchema }).strict()]);
const requestSchema = z.object({ schema_version: z.literal("investor-monitor-request-v1"), engine_version: z.literal("investor-model-watcher-v1"),
  model_hash: investorHash, profile_hash: investorHash, control_id: investorId, input_hash: investorHash.nullable(), checkpoint_hash: investorHash.nullable() }).strict();
const runSchema = z.object({ schema_version: z.literal("investor-monitor-run-v1"), request_id: investorId, model_id: investorId,
  input_version: investorHash, implementation_hash: investorHash, status: z.enum(["blocked", "synthetic_preview"]),
  reason_codes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/)).min(1).max(40), result: z.object({
    checkpoint: z.record(z.string(), z.unknown()).nullable(), monitor_request: z.object({ action: z.literal("monitor"), document: z.record(z.string(), z.unknown()), now: z.string() }).strict(),
    assessment: z.record(z.string(), z.unknown()) }).strict().nullable(), next_check_at: investorInstant.nullable(), created_at: investorInstant }).strict();

function invalid(): never { throw new Error("INVESTOR_EVIDENCE_INVALID"); }
function checkClock(now: string, ...times: string[]) {
  if (times.some(value => !investorInstant.safeParse(value).success || value > now)) invalid();
}
function decode(row: { document_json: string; content_hash: string }) {
  const document = parseStrictJson(row.document_json); if (hash(document) !== row.content_hash) invalid(); return document;
}
function definition(row: Row) {
  const value = definitionSchema.parse(decode(row)); validateInvestorModelDocument("definition", value);
  if (value.model_id !== row.id || value.profile_id !== row.profile_id || value.plan_id !== row.plan_id || value.created_at !== row.created_at
    || value.target_definition_hash !== modelDefinitionHash(value)) invalid();
  return value;
}

export function ensureInvestorModel(db: Database.Database, workspaceId: string, profile: InvestorProfileVersion,
  plan: { id: string; content_hash: string; document: ReferencePlan }, selectionId: string, actorId: string, auditId: string, now: string) {
  const existing = db.prepare("SELECT * FROM investor_models WHERE workspace_id=? AND plan_id=?").get(workspaceId, plan.id) as Row | undefined;
  if (existing) { const value = definition(existing); if (value.profile_hash !== profile.content_hash || value.plan_hash !== plan.content_hash) invalid(); return existing.id; }
  const targets = plan.document.targets.map(({ listing_id, market, currency, weight }) => ({ listing_id, market, currency, weight }));
  const fixed = plan.document.schema_version === "investor-reference-plan-v2" ? plan.document.fixed_policy : null;
  const basis = { schema_version: fixed ? "investor-model-definition-v2" : "investor-model-definition-v1", profile_hash: profile.content_hash,
    plan_hash: plan.content_hash, targets, ...(fixed ? { fixed_policy: fixed } : {}) };
  const value = definitionSchema.parse({ schema_version: basis.schema_version, model_id: randomUUID(),
    profile_id: profile.id, profile_version: profile.version, profile_hash: profile.content_hash, plan_id: plan.id, plan_hash: plan.content_hash,
    target_definition_hash: modelDefinitionHash(basis), targets, created_at: now, ...(fixed ? { fixed_policy: fixed } : {}),
    valid_until: plan.document.valid_until, data_mode: plan.document.data_mode, scope: "research_model", live_advice_eligible: false });
  validateInvestorModelDocument("definition", value);
  db.prepare("INSERT INTO investor_models(id,workspace_id,profile_id,plan_id,selection_id,document_json,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(value.model_id, workspaceId, profile.id, plan.id, selectionId, canonical(value), hash(value), now);
  appendModelControl(db, workspaceId, value.model_id, !fixedPolicyUnsupported(plan.document), actorId, auditId, now);
  return value.model_id;
}

export function appendModelControl(db: Database.Database, workspaceId: string, modelId: string, enabled: boolean, actorId: string, auditId: string, now: string) {
  const prior = db.prepare("SELECT version,created_at FROM investor_model_controls WHERE model_id=? AND workspace_id=? ORDER BY version DESC LIMIT 1")
    .get(modelId, workspaceId) as { version: number; created_at: string } | undefined;
  if (prior) checkClock(now, prior.created_at);
  const id = randomUUID();
  db.prepare("INSERT INTO investor_model_controls(id,workspace_id,model_id,version,enabled,actor_id,audit_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(id, workspaceId, modelId, (prior?.version ?? 0) + 1, enabled ? 1 : 0, actorId, auditId, now);
  return id;
}

export function readInvestorModelWatch(db: Database.Database, workspaceId: string, profile: InvestorProfileVersion, now: string, referenceAvailable = true) {
  const model = db.prepare(`SELECT m.* FROM investor_models m WHERE m.workspace_id=? AND m.plan_id=
    (SELECT plan_id FROM investor_plan_selections WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1)`).get(workspaceId, workspaceId) as Row | undefined;
  if (!model) return null;
  const value = definition(model); checkClock(now, model.created_at);
  const plan = db.prepare("SELECT document_json,content_hash FROM investor_reference_plans WHERE id=? AND workspace_id=?").get(model.plan_id, workspaceId) as { document_json: string; content_hash: string } | undefined;
  if (!plan || plan.content_hash !== value.plan_hash) invalid();
  const reference = referencePlanSchema.parse(decode(plan));
  if (reference.profile_id !== value.profile_id || reference.valid_until !== value.valid_until || reference.data_mode !== value.data_mode
    || hash(reference.targets.map(({ listing_id, market, currency, weight }) => ({ listing_id, market, currency, weight }))) !== hash(value.targets)) invalid();
  if ((value.schema_version === "investor-model-definition-v2") !== (reference.schema_version === "investor-reference-plan-v2")
    || reference.schema_version === "investor-reference-plan-v2" && value.schema_version === "investor-model-definition-v2" && hash(reference.fixed_policy) !== hash(value.fixed_policy)) invalid();
  if (fixedPolicyUnsupported(reference)) {
    const control = db.prepare("SELECT enabled,created_at FROM investor_model_controls WHERE model_id=? ORDER BY version DESC LIMIT 1")
      .get(model.id) as { enabled: number; created_at: string } | undefined;
    if (!control || ![0, 1].includes(control.enabled)) invalid(); checkClock(now, control.created_at);
    return modelWatchSchema.parse({ id: model.id, profile_id: value.profile_id, plan_id: model.plan_id, plan_hash: value.plan_hash,
      valid_until: value.valid_until, enabled: control.enabled === 1, status: control.enabled ? "blocked" : "paused", created_at: model.created_at,
      completed_at: null, next_check_at: null, checkpoint_sequence: 0, initial_notional_cny: "10000", model_nav_cny: null,
      source_qualification: "not_available", live_advice_eligible: false });
  }
  if (value.data_mode === "reconstructed") {
    const watched = readEvidenceModelWatch(db, workspaceId, model, value, profile, now, referenceAvailable);
    if (watched) return watched;
  }
  const control = db.prepare("SELECT id,enabled,created_at FROM investor_model_controls WHERE model_id=? ORDER BY version DESC LIMIT 1")
    .get(model.id) as { id: string; enabled: number; created_at: string } | undefined;
  if (!control || ![0, 1].includes(control.enabled)) invalid(); checkClock(now, control.created_at);
  const input = db.prepare("SELECT * FROM investor_model_inputs WHERE model_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(model.id) as { id: string; source_qualification: string; document_json: string; content_hash: string; created_at: string } | undefined;
  if (input) { checkClock(now, input.created_at); const snapshot = decode(input) as Record<string, unknown>; validateInvestorModelDocument("snapshot", snapshot); if (snapshot.model_id !== model.id || input.source_qualification !== "synthetic_test_only") invalid(); }
  const checkpoint = db.prepare("SELECT * FROM investor_model_checkpoints WHERE model_id=? ORDER BY sequence DESC LIMIT 1").get(model.id) as { id: string; sequence: number; document_json: string; content_hash: string; created_at: string } | undefined;
  if (checkpoint) { checkClock(now, checkpoint.created_at); const document = decode(checkpoint) as Record<string, unknown>; validateInvestorModelDocument("checkpoint", document); if (document.model_id !== model.id || document.profile_id !== model.profile_id || document.target_definition_hash !== value.target_definition_hash || document.sequence !== checkpoint.sequence) invalid(); }
  const row = db.prepare(`SELECT r.*,j.status job_status,j.lease_until,j.attempt_count,
    u.status run_status,u.document_json run_json,u.content_hash run_hash,u.created_at run_at,u.checkpoint_id published_checkpoint_id
    FROM investor_monitor_requests r LEFT JOIN job_runs j ON j.job_type='investor_monitor' AND j.scope=r.workspace_id
      AND j.period=r.id AND j.input_version=r.input_version AND j.command_request_id IS NULL
    LEFT JOIN investor_monitor_runs u ON u.request_id=r.id AND u.job_id=j.id AND u.workspace_id=r.workspace_id
    WHERE r.model_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).get(model.id) as {
      id: string; control_id: string; input_id: string | null; input_version: string; document_json: string; created_at: string;
      job_status: string | null; lease_until: string | null; attempt_count: number | null;
      run_status: string | null; run_json: string | null; run_hash: string | null; run_at: string | null; published_checkpoint_id: string | null;
    } | undefined;
  let status: z.infer<typeof modelWatchSchema>["status"] = "awaiting_inputs", completed: string | null = null, next: string | null = null, nav: string | null = null;
  if (row) {
    checkClock(now, row.created_at);
    const bound = requestSchema.parse(parseStrictJson(row.document_json));
    if (hash(bound) !== row.input_version || bound.model_hash !== model.content_hash || bound.profile_hash !== value.profile_hash || bound.control_id !== row.control_id) invalid();
    status = row.job_status === "failed" ? "failed" : row.job_status === "running" && row.lease_until && row.lease_until > now ? "running"
      : (row.attempt_count ?? 0) > 0 ? "retrying" : "queued";
    if (row.run_json !== null) {
      const run = runSchema.parse(parseStrictJson(row.run_json));
      if (hash(run) !== row.run_hash || run.request_id !== row.id || run.model_id !== model.id || run.input_version !== row.input_version
        || run.status !== row.run_status || run.created_at !== row.run_at || run.created_at < row.created_at || row.job_status !== "succeeded") invalid();
      checkClock(now, run.created_at); completed = run.created_at; next = run.next_check_at;
      status = run.status;
      if (run.result) {
        const retained = db.prepare("SELECT document_json,content_hash FROM investor_model_inputs WHERE id=? AND model_id=? AND workspace_id=?")
          .get(row.input_id, model.id, workspaceId) as { document_json: string; content_hash: string } | undefined;
        if (!retained || retained.content_hash !== bound.input_hash) invalid();
        const snapshot = decode(retained) as Record<string, unknown>; validateInvestorModelDocument("snapshot", snapshot);
        const document = run.result.monitor_request.document;
        for (const key of ["quotes", "fx", "funding_intent", "policy"]) if (hash(document[key]) !== hash(snapshot[key])) invalid();
        const gaps = document.quality_gaps as string[];
        if (!Array.isArray(gaps) || !(snapshot.quality_gaps as string[]).every(code => gaps.includes(code))
          || Object.values(snapshot.corporate_action_coverage as Record<string, { complete: boolean }>).some(row => !row.complete)
            && !gaps.includes("CORPORATE_ACTION_COVERAGE_INCOMPLETE")) invalid();
        const weights = Object.fromEntries(value.targets.map(target => [target.listing_id, target.weight]));
        if (document.before_plan_hash !== value.target_definition_hash || document.after_plan_hash !== value.target_definition_hash
          || hash(document.before_weights) !== hash(weights) || hash(document.after_weights) !== hash(weights)
          || document.profile_id !== value.profile_id || document.profile_version !== value.profile_version) invalid();
        const result = modelAssessmentObservation(run.result.monitor_request, run.result.assessment);
        if (run.result.assessment.implementation_hash !== run.implementation_hash || run.result.monitor_request.document.model_id !== model.id
          || run.result.monitor_request.document.profile_hash !== value.profile_hash || result.evaluated_at > run.created_at) invalid();
        if (run.result.checkpoint) {
          validateInvestorModelDocument("checkpoint", run.result.checkpoint);
          const stored = db.prepare("SELECT document_json,content_hash FROM investor_model_checkpoints WHERE id=? AND model_id=?").get(row.published_checkpoint_id, model.id) as { document_json: string; content_hash: string } | undefined;
          if (!stored || hash(run.result.checkpoint) !== stored.content_hash || hash(decode(stored)) !== stored.content_hash
            || document.model_state_hash !== stored.content_hash || run.result.checkpoint.input_hash !== bound.input_hash
            || hash(document.quantities) !== hash(run.result.checkpoint.quantities)) invalid();
          const cash = run.result.checkpoint.cash_by_currency as Record<string, string>, fx = snapshot.fx as { currency: string; value: string }[];
          const conversion = (currency: string) => currency === "CNY" ? "1" : fx.find(row => row.currency === currency)?.value ?? invalid();
          let nonCash = Object.entries(cash).filter(([currency]) => currency !== "CNY").reduce((sum, [currency, amount]) =>
            new Decimal(amount).isZero() ? sum : sum.add(new Decimal(amount).mul(conversion(currency))), new Decimal(0));
          for (const receivable of run.result.checkpoint.receivables as { currency: string; amount: string }[]) nonCash = nonCash.add(new Decimal(receivable.amount).mul(conversion(receivable.currency)));
          if (document.cash_cny !== cash.CNY || !nonCash.eq(document.non_cash_assets_cny as string)) invalid();
          nav = result.model_change?.model_nav_cny ?? null;
        } else if (row.published_checkpoint_id !== null) invalid();
        if (result.outcome === "insufficient_evidence") status = "blocked";
        if (result.next_review_at !== null && (!next || result.next_review_at < next)) next = result.next_review_at;
      } else if (run.status !== "blocked" || row.published_checkpoint_id !== null) invalid();
    } else if (row.job_status === "succeeded" || row.job_status === "skipped") status = "outdated";
    if (row.control_id !== control.id || row.input_id !== (input?.id ?? null) || bound.input_hash !== (input?.content_hash ?? null)) status = "outdated";
  }
  if (next && next <= now) status = "overdue";
  if (!referenceAvailable) status = "outdated";
  if (value.profile_id !== profile.id || value.profile_hash !== profile.content_hash) status = "outdated";
  else if (value.valid_until <= now) status = "expired";
  if (!control.enabled) status = "paused";
  return modelWatchSchema.parse({ id: model.id, profile_id: value.profile_id, plan_id: model.plan_id, plan_hash: value.plan_hash, valid_until: value.valid_until, enabled: control.enabled === 1,
    status, created_at: model.created_at, completed_at: completed, next_check_at: next,
    checkpoint_sequence: checkpoint?.sequence ?? 0, initial_notional_cny: "10000", model_nav_cny: status === "synthetic_preview" ? nav : null,
    source_qualification: input ? "synthetic_test_only" : "not_available", live_advice_eligible: false });
}
