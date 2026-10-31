import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import common from "../../../../contracts/v1/common.schema.json";
import observation from "../../../../contracts/v1/market-observation.schema.json";
import dataset from "../../../../contracts/v1/research-dataset.schema.json";
import plan from "../../../../contracts/v1/research-plan.schema.json";
import boundedPlan from "../../../../contracts/v1/research-plan-v3.schema.json";
import actionAwarePlan from "../../../../contracts/v1/research-plan-v4.schema.json";
import eventReviewPlan from "../../../../contracts/v1/research-plan-v5.schema.json";
import settledPlan from "../../../../contracts/v1/research-plan-v6.schema.json";
import planInput from "../../../../contracts/v1/research-plan-input.schema.json";
import parameters from "../../../../contracts/v1/research-parameters.schema.json";
import fixed from "../../../../contracts/v1/research-fixed-rebalance-parameters.schema.json";
import fixedV2 from "../../../../contracts/v1/research-fixed-rebalance-parameters-v2.schema.json";
import fixedPolicy from "../../../../contracts/v1/research-fixed-policy-parameters.schema.json";
import rotation from "../../../../contracts/v1/research-rotation-parameters.schema.json";
import profile from "../../../../contracts/v1/investor-profile.schema.json";
import policy from "../../../../contracts/v1/investor-strategy-policy.schema.json";
import policyV2 from "../../../../contracts/v1/investor-strategy-policy-v2.schema.json";
import policyV3 from "../../../../contracts/v1/investor-strategy-policy-v3.schema.json";
import policyInput from "../../../../contracts/v1/investor-strategy-policy-input.schema.json";
import monitor from "../../../../contracts/v1/investor-model-monitor.schema.json";
import monitorV2 from "../../../../contracts/v1/investor-model-monitor-v2.schema.json";
import monitorV3 from "../../../../contracts/v1/investor-model-monitor-v3.schema.json";
import fixedPolicyState from "../../../../contracts/v1/investor-fixed-policy-state.schema.json";
import request from "../../../../contracts/v1/investor-kernel-request.schema.json";
import strategyResult from "../../../../contracts/v1/investor-strategy-result.schema.json";
import strategyResultV2 from "../../../../contracts/v1/investor-strategy-result-v2.schema.json";
import strategyResultV3 from "../../../../contracts/v1/investor-strategy-result-v3.schema.json";
import assessment from "../../../../contracts/v1/investor-model-assessment.schema.json";
import assessmentV2 from "../../../../contracts/v1/investor-model-assessment-v2.schema.json";
import modelDefinition from "../../../../contracts/v1/investor-model-definition.schema.json";
import modelDefinitionV2 from "../../../../contracts/v1/investor-model-definition-v2.schema.json";
import modelSnapshot from "../../../../contracts/v1/investor-model-snapshot.schema.json";
import modelCheckpoint from "../../../../contracts/v1/investor-model-checkpoint.schema.json";
import experiment from "../../../../contracts/v1/investor-experiment.schema.json";
import dataFacts from "../../../../contracts/v1/investor-data-facts.schema.json";
import calendarContinuation from "../../../../contracts/v1/investor-calendar-continuation.schema.json";
import dataSnapshot from "../../../../contracts/v1/investor-data-snapshot.schema.json";
import evidenceInput from "../../../../contracts/v1/investor-evidence-input.schema.json";
import referencePlan from "../../../../contracts/v1/investor-reference-plan.schema.json";
import referencePlanV2 from "../../../../contracts/v1/investor-reference-plan-v2.schema.json";
import monitorDataInput from "../../../../contracts/v1/investor-monitor-data-input.schema.json";
import monitorDataInputV2 from "../../../../contracts/v1/investor-monitor-data-input-v2.schema.json";
import monitorDataInputV3 from "../../../../contracts/v1/investor-monitor-data-input-v3.schema.json";
import monitorCosts from "../../../../contracts/v1/investor-monitor-costs.schema.json";
import monitorPriceSnapshot from "../../../../contracts/v1/investor-monitor-price-snapshot.schema.json";
import monitorDataProjection from "../../../../contracts/v1/investor-monitor-data-projection.schema.json";
import evidenceCheckpoint from "../../../../contracts/v1/investor-evidence-model-checkpoint.schema.json";
import evidenceCheckpointV2 from "../../../../contracts/v1/investor-evidence-model-checkpoint-v2.schema.json";
import evidenceCheckpointV3 from "../../../../contracts/v1/investor-evidence-model-checkpoint-v3.schema.json";
import evidenceMonitor from "../../../../contracts/v1/investor-evidence-monitor.schema.json";
import evidenceMonitorRequestV2 from "../../../../contracts/v1/investor-evidence-monitor-request-v2.schema.json";
import plannedFunding from "../../../../contracts/v1/investor-planned-funding-monitor.schema.json";
import fundingPlan from "../../../../contracts/v1/investor-funding-plan.schema.json";
import longHorizonInput from "../../../../contracts/v1/investor-long-horizon-input.schema.json";
import longHorizonResult from "../../../../contracts/v1/investor-long-horizon-result.schema.json";
import longHorizonInputV2 from "../../../../contracts/v1/investor-long-horizon-input-v2.schema.json";
import longHorizonResultV2 from "../../../../contracts/v1/investor-long-horizon-result-v2.schema.json";
import longHorizonInputV3 from "../../../../contracts/v1/investor-long-horizon-input-v3.schema.json";
import longHorizonResultV3 from "../../../../contracts/v1/investor-long-horizon-result-v3.schema.json";
import longHorizonInputV4 from "../../../../contracts/v1/investor-long-horizon-input-v4.schema.json";
import longHorizonResultV4 from "../../../../contracts/v1/investor-long-horizon-result-v4.schema.json";
import longHorizonInputV5 from "../../../../contracts/v1/investor-long-horizon-input-v5.schema.json";
import longHorizonResultV5 from "../../../../contracts/v1/investor-long-horizon-result-v5.schema.json";
import fundedHistoryInput from "../../../../contracts/v1/investor-funded-history-input.schema.json";
import fundedHistoryResult from "../../../../contracts/v1/investor-funded-history-result.schema.json";
import fundedHistoryInputV2 from "../../../../contracts/v1/investor-funded-history-input-v2.schema.json";
import fundedHistoryResultV2 from "../../../../contracts/v1/investor-funded-history-result-v2.schema.json";
import fundedHistoryInputV3 from "../../../../contracts/v1/investor-funded-history-input-v3.schema.json";
import fundedHistoryResultV3 from "../../../../contracts/v1/investor-funded-history-result-v3.schema.json";
import fundedHistoryInputV4 from "../../../../contracts/v1/investor-funded-history-input-v4.schema.json";
import fundedHistoryResultV4 from "../../../../contracts/v1/investor-funded-history-result-v4.schema.json";
import { hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { Decimal } from "../ledger/decimal";
import { observationSchema, type InvestorObservation, type InvestorModelChange } from "./schemas";
import { replayEvidenceAssessment } from "./evidence-model-assessment";
import { verifyBoundedResearchSummary, type BoundedResearchPlan } from "./bounded-research";
import type { ContinuousDataset } from "./continuous-market";
import type { ContinuousParameters } from "./continuous-economics";
import { executionChecksUsable, phaseExecutionReview } from "./research-execution";
import { verifyInvestorKernelProof } from "./kernel-read-scope";

const ajv = new Ajv2020({ strict: true, strictRequired: false });
addFormats(ajv);
ajv.addSchema(calendarContinuation);
for (const schema of [policyV2, policyV3, policyInput, strategyResultV2, strategyResultV3, settledPlan]) ajv.addSchema(schema);
ajv.addSchema(boundedPlan); ajv.addSchema(actionAwarePlan); ajv.addSchema(eventReviewPlan); ajv.addSchema(planInput);
for (const schema of [longHorizonInputV4, longHorizonResultV4, fundedHistoryInputV3, fundedHistoryResultV3]) ajv.addSchema(schema);
for (const schema of [longHorizonInputV5, longHorizonResultV5, fundedHistoryInputV4, fundedHistoryResultV4]) ajv.addSchema(schema);
for (const schema of [common, observation, dataset, plan, parameters, fixed, fixedV2, fixedPolicy, rotation, profile, policy, monitor, monitorV2, monitorV3, fixedPolicyState, request, strategyResult, assessment, assessmentV2, modelDefinition, modelDefinitionV2, modelSnapshot, modelCheckpoint, experiment, dataFacts, dataSnapshot, evidenceInput, referencePlan, referencePlanV2, monitorDataInput, monitorDataInputV2, monitorDataInputV3, monitorCosts, monitorPriceSnapshot, monitorDataProjection, evidenceCheckpoint, evidenceCheckpointV2, evidenceCheckpointV3, evidenceMonitor, evidenceMonitorRequestV2, plannedFunding, fundingPlan, longHorizonInput, longHorizonResult, longHorizonInputV2, longHorizonResultV2, longHorizonInputV3, longHorizonResultV3, fundedHistoryInput, fundedHistoryResult, fundedHistoryInputV2, fundedHistoryResultV2]) ajv.addSchema(schema);
const validateRequest = ajv.getSchema(request.$id)!, validateStrategy = ajv.getSchema(strategyResult.$id)!, validateAssessment = ajv.getSchema(assessment.$id)!;
type JsonObject = Record<string, unknown>;
type Quote = { listing_id: string; market: "CN" | "HK" | "US"; currency: string; close: string; observed_at: string; known_at: string; expected_close_at: string; valid_until: string };
type Fx = { currency: string; value: string; observed_at: string; known_at: string; valid_until: string };
export type ModelMonitorDocument = {
  profile_id: string; profile_version: number; before_weights: Record<string, string>; after_weights: Record<string, string>;
  quantities: Record<string, string>; cash_cny: string; quotes: Quote[]; fx: Fx[];
  non_cash_assets_cny?: string;
  funding_intent: { id: string; amount_cny: string; expected_at: string } | null;
  policy: { max_fx_age_seconds: number }; quality_gaps: string[];
};
export type ModelAssessment = Omit<InvestorModelChange, "assessment_hash" | "market_cutoffs"> & {
  schema_version: "investor-model-assessment-v1" | "investor-model-assessment-v2"; profile_id: string; profile_version: number; input_version: string;
  evaluated_at: string; data_cutoff: string; market_cutoffs: Partial<Record<"CN" | "HK" | "US", string>>; next_review_at: string | null;
  gaps: string[]; reason_codes: string[]; outcome: "observe" | "decision_required" | "insufficient_evidence"; result_hash: string;
};

function fail(): never { throw new Error("INVESTOR_KERNEL_RESULT_INVALID"); }
export function validateFundedHistoryDocument(kind: "input" | "projection" | "result" | "continuous_input", value: unknown) {
  const version = (value as JsonObject | null)?.schema_version;
  const id = kind === "projection" ? fundedHistoryInput.$id + "#/$defs/projection"
    : kind === "input" ? (version === "investor-funded-history-input-v4" ? fundedHistoryInputV4.$id : version === "investor-funded-history-input-v3" ? fundedHistoryInputV3.$id : version === "investor-funded-history-input-v2" ? fundedHistoryInputV2.$id : fundedHistoryInput.$id)
    : kind === "continuous_input" ? (version === "investor-long-horizon-input-v5" ? longHorizonInputV5.$id : version === "investor-long-horizon-input-v4" ? longHorizonInputV4.$id : version === "investor-long-horizon-input-v3" ? longHorizonInputV3.$id : longHorizonInputV2.$id)
    : version === "investor-funded-history-result-v4" ? fundedHistoryResultV4.$id : version === "investor-funded-history-result-v3" ? fundedHistoryResultV3.$id : version === "investor-funded-history-result-v2" ? fundedHistoryResultV2.$id : fundedHistoryResult.$id;
  if (!ajv.getSchema(id)!(value)) throw new Error("INVESTOR_FUNDED_HISTORY_INVALID");
}
export function validateInvestorModelDocument(kind: "definition" | "snapshot" | "checkpoint", value: unknown) {
  const version = (value as JsonObject | null)?.schema_version;
  const schema = kind === "definition" && version === "investor-model-definition-v2" ? modelDefinitionV2 : { definition: modelDefinition, snapshot: modelSnapshot, checkpoint: modelCheckpoint }[kind];
  requireTrue(ajv.getSchema(schema.$id)!(value));
}
export function validateInvestorTrialDocument(kind: "experiment" | "summary", value: unknown, planVersion = "research-plan-v2") {
  requireTrue(ajv.getSchema(kind === "experiment" ? experiment.$id : (planVersion === "research-plan-v6" ? strategyResultV3.$id : planVersion === "research-plan-v5" ? strategyResultV2.$id : strategyResult.$id) + "#/$defs/summary")!(value));
}
export function validateInvestorSourceDocument(kind: "facts" | "snapshot" | "monitor_snapshot" | "input" | "dataset" | "calendar_continuation", value: unknown) {
  requireTrue(ajv.getSchema({ facts: dataFacts.$id, snapshot: dataSnapshot.$id, monitor_snapshot: monitorPriceSnapshot.$id, input: evidenceInput.$id, dataset: dataset.$id, calendar_continuation: calendarContinuation.$id }[kind])!(value));
}
export function validateInvestorReferenceDocument(value: unknown) { requireTrue(ajv.getSchema((value as JsonObject | null)?.schema_version === "investor-reference-plan-v2" ? referencePlanV2.$id : referencePlan.$id)!(value)); }
export function validateInvestorMonitorDataDocument(kind: "input" | "projection", value: unknown) {
  const version = (value as JsonObject | null)?.schema_version;
  requireTrue(ajv.getSchema(kind === "input" ? (version === "investor-monitor-data-input-v3" ? monitorDataInputV3.$id : version === "investor-monitor-data-input-v2" ? monitorDataInputV2.$id : monitorDataInput.$id) : monitorDataProjection.$id)!(value));
}
export function validateInvestorMonitorCostRecord(value: unknown) { requireTrue(ajv.getSchema(monitorCosts.$id + "#/$defs/record")!(value)); }
export function validateInvestorEvidenceCheckpoint(value: unknown) {
  const version = (value as JsonObject | null)?.schema_version;
  requireTrue(ajv.getSchema(version === "investor-evidence-model-checkpoint-v3" ? evidenceCheckpointV3.$id
    : version === "investor-evidence-model-checkpoint-v2" ? evidenceCheckpointV2.$id : evidenceCheckpoint.$id)!(value));
}
export function validateInvestorEvidenceMonitor(kind: "request" | "run" | "observation_ref", value: unknown) {
  requireTrue(ajv.getSchema(kind === "request" && (value as JsonObject | null)?.schema_version === "investor-evidence-monitor-request-v2"
    ? evidenceMonitorRequestV2.$id : evidenceMonitor.$id + "#/$defs/" + kind)!(value));
}
function requireTrue(value: unknown): asserts value { if (!value) fail(); }
function object(value: unknown): JsonObject { requireTrue(value !== null && typeof value === "object" && !Array.isArray(value)); return value as JsonObject; }
function exactInstant(value: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  requireTrue(match && !value.startsWith("0000"));
  const ms = Date.parse(match[1] + "Z");
  requireTrue(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === match[1]);
  return BigInt(ms) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
function milliseconds(value: string) {
  const micros = exactInstant(value); requireTrue(micros % 1000n === 0n);
  return new Date(Number(micros / 1000n)).toISOString();
}
function sealed(value: JsonObject) {
  const { result_hash, ...body } = value;
  requireTrue(hash(body) === result_hash);
}
function numericEqual(value: string, expected: InstanceType<typeof Decimal>) { requireTrue(new Decimal(value).eq(expected)); }
function usableSummary(summary: JsonObject): boolean {
  const keys = ["twr", "annualized_unit_return", "max_drawdown", "benchmark_twr", "benchmark_annualized_unit_return", "benchmark_max_drawdown", "excess_twr"];
  return keys.every(key => typeof summary[key] === "string") && executionChecksUsable({
    execution_failure_count: summary.execution_failure_count as number, benchmark_execution_failure_count: summary.benchmark_execution_failure_count as number,
    ...phaseExecutionReview(summary) })
    && ["max_drawdown", "benchmark_max_drawdown"].every(key => new Decimal(summary[key] as string).gte(-1) && new Decimal(summary[key] as string).lte(0));
}
function withinRisk(summary: JsonObject, stresses: JsonObject[], limit: string) {
  return usableSummary(summary) && new Decimal(summary.max_drawdown as string).negated().lte(limit)
    && stresses.every(row => new Decimal(row.portfolio_return as string).negated().lte(limit));
}

/** Structural/input binding only. Hashes do not certify provider origins or licenses. */
export function verifyInvestorKernelResult(rawRequest: unknown, rawResult: unknown): JsonObject {
  try {
    requireTrue(validateRequest(rawRequest));
    const input = object(rawRequest), result = object(rawResult);
    sealed(result);
    if (input.action === "research") {
      const version = object(input.plan).schema_version;
      requireTrue(version === "research-plan-v6" ? ajv.getSchema(strategyResultV3.$id)!(result)
        : version === "research-plan-v5" ? ajv.getSchema(strategyResultV2.$id)!(result) : validateStrategy(result));
      verifyInvestorKernelProof(() => ["research-plan-v3", "research-plan-v4", "research-plan-v5", "research-plan-v6"].includes(version as string)
        ? hash({
          input, result, decimal: {
            precision: Decimal.precision, rounding: Decimal.rounding,
            minE: Decimal.minE, maxE: Decimal.maxE, toExpNeg: Decimal.toExpNeg, toExpPos: Decimal.toExpPos, modulo: Decimal.modulo
          }
        }) : null, () => {
          for (const name of ["dataset", "plan", "policy", "profile"]) requireTrue(result[name + "_hash"] === hash(input[name]));
          requireTrue(result.data_mode === object(input.dataset).mode);
          const candidates = object(input.policy).candidates as JsonObject[];
          const scenarios = object(input.policy).stress_scenarios as JsonObject[], roles = object(object(input.policy).roles);
          for (const candidate of candidates) {
            if (candidate.schema_version !== "research-fixed-rebalance-parameters-v2") continue;
            const weights = object(candidate.weights), candidateRoles = object(candidate.roles);
            requireTrue(Object.keys(weights).sort().join() === Object.keys(candidateRoles).sort().join());
            requireTrue(Object.keys(weights).every(listing => candidateRoles[listing] === roles[listing]));
            const threshold = new Decimal(candidate.class_drift_threshold as string);
            requireTrue(threshold.gt(0) && threshold.lte(1));
          }
          const loss = object(input.profile).loss_tolerance as string | null;
          const expected = new Map(candidates.map(row => [hash(row), row]));
          const rows = result.candidates as JsonObject[];
          requireTrue(new Set(rows.map(row => row.parameters_hash)).size === rows.length);
          for (const row of rows) {
            requireTrue(expected.has(row.parameters_hash as string));
            requireTrue(hash(row.weights) === hash(expected.get(row.parameters_hash as string)!.weights));
            requireTrue(object(row.train).phase === "train");
            if (["research-plan-v3", "research-plan-v4", "research-plan-v5", "research-plan-v6"].includes(object(input.plan).schema_version as string)) verifyBoundedResearchSummary(input.dataset as ContinuousDataset,
              input.plan as BoundedResearchPlan, expected.get(row.parameters_hash as string)! as unknown as ContinuousParameters, object(row.train), "train");
            const stresses = row.stresses as JsonObject[];
            requireTrue(stresses.length === scenarios.length);
            for (const [index, scenario] of scenarios.entries()) {
              const stress = stresses[index], returns = object(scenario.role_returns);
              requireTrue(stress.id === scenario.id && stress.label === scenario.label);
              let total = new Decimal(0);
              for (const [listing, weight] of Object.entries(object(row.weights))) {
                const shock = new Decimal(returns[roles[listing] as string] as string);
                requireTrue(shock.gte(-1) && shock.lte(1));
                total = total.plus(new Decimal(weight as string).times(shock));
              }
              numericEqual(stress.portfolio_return as string, total);
            }
            requireTrue(row.risk_budget_pass === (loss === null ? null : withinRisk(object(row.train), stresses, loss)));
          }
          if (result.status !== "insufficient_evidence") requireTrue(rows.length === candidates.length);
          const phases = result.phase_evidence as JsonObject[];
          requireTrue(phases.every((row, index) => row.phase === ["train", "validation", "holdout"][index]));
          if (result.selected_parameters !== null) {
            requireTrue(expected.has(hash(result.selected_parameters)));
            requireTrue(loss !== null);
            const chosen = rows.find(row => row.parameters_hash === hash(result.selected_parameters));
            requireTrue(chosen && chosen.risk_budget_pass === true && phases.length > 0 && hash(phases[0]) === hash(chosen.train));
            if (["research-plan-v3", "research-plan-v4", "research-plan-v5", "research-plan-v6"].includes(object(input.plan).schema_version as string)) for (const summary of phases.slice(1))
              verifyBoundedResearchSummary(input.dataset as ContinuousDataset, input.plan as BoundedResearchPlan,
                result.selected_parameters as ContinuousParameters, summary, summary.phase as "validation" | "holdout");
            const eligible = rows.filter(row => row.risk_budget_pass === true).sort((a, b) => {
              const left = object(a.train), right = object(b.train);
              return new Decimal(right.annualized_unit_return as string).cmp(left.annualized_unit_return as string)
                || new Decimal(right.max_drawdown as string).cmp(left.max_drawdown as string)
                || new Decimal(left.buy_turnover_on_mean_observed_nav as string).add(left.sell_turnover_on_mean_observed_nav as string)
                  .cmp(new Decimal(right.buy_turnover_on_mean_observed_nav as string).add(right.sell_turnover_on_mean_observed_nav as string))
                || (a.parameters_hash as string).localeCompare(b.parameters_hash as string, "en");
            });
            requireTrue(eligible[0]?.parameters_hash === hash(result.selected_parameters));
            if (result.status === "reference_ready") requireTrue(phases.every(row => withinRisk(row, chosen.stresses as JsonObject[], loss)));
          }
          if (result.status === "risk_options_ready") requireTrue(loss === null && rows.some(row => usableSummary(object(row.train))));
        });
    } else {
      if (object(input.document).schema_version === "investor-model-monitor-v3") {
        requireTrue(ajv.getSchema(assessmentV2.$id)!(result));
        requireTrue(hash(replayEvidenceAssessment(object(input.document), input.now as string, result.implementation_hash as string)) === hash(result));
        return result;
      }
      requireTrue(validateAssessment(result));
      const document = input.document as ModelMonitorDocument, now = exactInstant(input.now as string), output = result as unknown as ModelAssessment;
      const due = document.funding_intent !== null && exactInstant(document.funding_intent.expected_at) <= now;
      requireTrue(output.profile_id === document.profile_id && output.profile_version === document.profile_version);
      requireTrue(exactInstant(output.evaluated_at) === now && output.input_version === hash({ document, funding_due: due }));
      requireTrue(output.funding_status === (due ? "hypothetical_due" : document.funding_intent ? "not_due" : "none"));
      const cutoffs = [...document.quotes, ...document.fx].map(row => exactInstant(row.observed_at));
      requireTrue(exactInstant(output.data_cutoff) === cutoffs.reduce((a, b) => a < b ? a : b));
      const markets = [...new Set(document.quotes.map(row => row.market))].sort();
      requireTrue(Object.keys(output.market_cutoffs).sort().join() === markets.join());
      for (const market of markets) {
        const sources = document.quotes.filter(row => row.market === market).map(row => exactInstant(row.observed_at));
        requireTrue(exactInstant(output.market_cutoffs[market]!) === sources.reduce((a, b) => a < b ? a : b));
      }
      const deadlines = [...document.quotes, ...document.fx].map(row => exactInstant(row.valid_until));
      if (document.funding_intent && !due) deadlines.push(exactInstant(document.funding_intent.expected_at));
      const next = deadlines.reduce((a, b) => a < b ? a : b);
      requireTrue(next > now ? output.next_review_at !== null && exactInstant(output.next_review_at) === next : output.next_review_at === null);
      if (output.outcome !== "insufficient_evidence") {
        requireTrue(document.quality_gaps.length === 0);
        for (const row of document.quotes) requireTrue(exactInstant(row.known_at) <= now && exactInstant(row.observed_at) <= now
          && exactInstant(row.observed_at) === exactInstant(row.expected_close_at) && exactInstant(row.valid_until) > now);
        for (const row of document.fx) requireTrue(exactInstant(row.known_at) <= now && exactInstant(row.observed_at) <= now
          && exactInstant(row.valid_until) > now && now - exactInstant(row.observed_at) <= BigInt(document.policy.max_fx_age_seconds) * 1000000n);
        const values = new Map(document.quotes.map(row => [row.listing_id, new Decimal(document.quantities[row.listing_id] ?? "0").mul(row.close)
          .mul(row.currency === "CNY" ? "1" : document.fx.find(fx => fx.currency === row.currency)!.value)]));
        const nav = [...values.values()].reduce((sum, value) => sum.add(value), new Decimal(document.cash_cny).add(document.non_cash_assets_cny ?? "0"));
        requireTrue(nav.gt(0)); numericEqual(output.model_nav_cny!, nav);
        const projected = nav.add(due ? document.funding_intent!.amount_cny : "0");
        requireTrue(output.changes.length === values.size && new Set(output.changes.map(row => row.listing_id)).size === values.size);
        for (const row of output.changes) {
          const current = values.get(row.listing_id); requireTrue(current);
          requireTrue(row.before_target_weight === (document.before_weights[row.listing_id] ?? "0")
            || new Decimal(row.before_target_weight).eq(document.before_weights[row.listing_id] ?? "0"));
          numericEqual(row.after_target_weight, new Decimal(document.after_weights[row.listing_id] ?? "0"));
          numericEqual(row.current_model_value_cny, current); numericEqual(row.observed_model_weight, current.div(nav));
          numericEqual(row.hypothetical_target_value_cny, projected.mul(document.after_weights[row.listing_id] ?? "0"));
          numericEqual(row.difference_cny, new Decimal(row.hypothetical_target_value_cny).sub(current));
          numericEqual(row.remaining_target_difference_cny, new Decimal(row.difference_cny).sub(row.proposed_change_cny));
          if (due) requireTrue(new Decimal(row.proposed_change_cny).gte(0));
        }
        if (due && output.outcome === "decision_required") {
          requireTrue(output.allocation_method === "contribution_repair_without_sales" && output.hypothetical_cash_remaining_cny !== null);
          const deployed = output.changes.reduce((sum, row) => sum.add(row.proposed_change_cny), new Decimal(0));
          numericEqual(output.hypothetical_cash_remaining_cny, new Decimal(document.cash_cny).add(document.funding_intent!.amount_cny).sub(deployed).sub(output.estimated_cost_cny!));
          requireTrue(new Decimal(output.hypothetical_cash_remaining_cny).gte(0));
        }
      }
    }
    return result;
  } catch { fail(); }
}

export function parseInvestorKernelOutput(rawRequest: unknown, raw: string): JsonObject {
  requireTrue(Buffer.byteLength(raw) <= 1024 * 1024);
  return verifyInvestorKernelResult(rawRequest, parseStrictJson(raw));
}

const reasonLabels: Record<string, string> = {
  FIXED_POLICY_WITHIN_CLASS_BANDS: "类别偏离未达到冻结阈值，当前也没有到期周期复核；继续观察。",
  POLICY_TARGETS_WITHIN_TOLERANCE: "冻结规则已复核，但证券金额差异仍在容差内；不为精确追逐权重强迫交易。",
  POLICY_COOLDOWN_NO_NEW_ADVICE: "当前仍在研究建议冷却期内，不发布新的全面再平衡建议；这不表示偏离已消失或旧建议已执行。",
  CALENDAR_POLICY_REVIEW: "已到冻结策略的当地半年度或年度复核周期；日期只触发研究，不强制交易。",
  CLASS_WEIGHT_BREACH: "资产类别的绝对偏离已达到冻结百分点阈值；不以单只证券偏离替代类别判断。",
  PLANNED_FUNDING_REVIEW_OPEN: "同一笔假设资金的修复方案仍待决策，不视为已投入，也不重复延后冷却起点。",
  NEW_MODEL_CNY_CASH: "参考模型出现新增人民币现金，已含于模型净值；优先研究不卖出的低配修复。",
  MODEL_CNY_CASH_REVIEW_OPEN: "参考模型现金修复仍待决定，未改变模型单位或实际账户现金。",
  MODEL_WITHIN_CONFIRMED_BANDS: "本次模型计算完成，偏离未超过已确认阈值；继续观察。",
  NEW_PLANNED_FUNDING: "计划投入已到复核日期，优先研究补足低配资产。计划资金仍不等于实际到账。",
  TARGET_WEIGHTS_CHANGED: "参考目标权重发生变化，需要比较维持原方案与调整的理由。",
  MODEL_DRIFT_OUTSIDE_BAND: "模型偏离已超过研究阈值；先比较新资金修复与成本，不自动交易。",
  REQUIRED_INPUTS_NOT_CURRENT: "必要证据未齐或已陈旧，无法得出当前有效的调整结论。",
  CANNOT_COMPARE_CHANGE_COST: "缺少费用假设，无法比较调整成本。",
  CHANGE_NOT_COST_QUALIFIED: "估算调整成本超过研究策略约束。",
  NO_COST_QUALIFIED_CONTRIBUTION_REPAIR: "本次计划投入无法在费用预算内形成有效修复；不能记为零成本投入。",
};

/** Presentation adapter, not a publisher. The source/rights/schedule gates remain separate. */
export function modelAssessmentObservation(request: { action: "monitor"; document: unknown; now: string }, rawResult: unknown): InvestorObservation {
  const result = verifyInvestorKernelResult(request, rawResult) as unknown as ModelAssessment;
  const document = request.document as ModelMonitorDocument;
  const evaluated = milliseconds(result.evaluated_at);
  return observationSchema.parse({ schema_version: "investor-observation-v1", outcome: result.outcome,
    evaluated_at: evaluated, data_cutoff: exactInstant(result.data_cutoff) > exactInstant(evaluated) ? null : milliseconds(result.data_cutoff),
    profile_id: result.profile_id, profile_version: result.profile_version, input_version: result.input_version,
    gaps: result.gaps.map(code => {
      const [base, scope] = code.split(":"), affected = document.quotes.filter(row => scope === undefined || row.market === scope || row.currency === scope).map(row => row.market);
      return { code: base + (scope ? "_" + scope : ""), title: base === "MARKET_DATA_NOT_CURRENT" ? "市场有效收盘数据未齐" : base.startsWith("FX_") ? "汇率证据未齐" : "研究输入待复核",
        detail: `输入检查未通过：${code}。本次不把缺少有效结论当作无需调整。`, affected_markets: [...new Set(affected)], action: "补齐对应来源、身份、日历和费用证据后重新计算。" };
    }), reasons: result.reason_codes.map(code => reasonLabels[code] ?? `研究检查：${code}`),
    next_review_at: result.next_review_at === null ? null : milliseconds(result.next_review_at),
    next_conditions: ["各市场下一次有效收盘或汇率证据更新", "参考目标、风险约束或日期化投入计划发生变化"],
    monitoring: "not_enabled", scope: "research_model", live_advice_eligible: false,
    model_change: { assessment_hash: result.result_hash, model_nav_cny: result.model_nav_cny, estimated_cost_cny: result.estimated_cost_cny,
      ...(result.policy_evaluation ? { policy_evaluation: result.policy_evaluation } : {}),
      hypothetical_cash_remaining_cny: result.hypothetical_cash_remaining_cny, funding_status: result.funding_status,
      allocation_method: result.allocation_method, constraints_not_checked: result.constraints_not_checked, changes: result.changes,
      market_cutoffs: Object.fromEntries(Object.entries(result.market_cutoffs).map(([key, value]) => [key, milliseconds(value)])) },
  });
}
