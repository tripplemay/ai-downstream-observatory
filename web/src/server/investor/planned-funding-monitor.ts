import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import common from "../../../../contracts/v1/common.schema.json";
import fundingPlan from "../../../../contracts/v1/investor-funding-plan.schema.json";
import contract from "../../../../contracts/v1/investor-planned-funding-monitor.schema.json";
import { canonical, hash } from "../ledger/service";
import { fundingCents, fundingTimeline, type InvestorFundingPlan } from "./funding-schemas";
import { economicInstant, economicMidnight } from "./continuous-market";

export type PlannedFundingBinding = { funding_plan_id: string; funding_plan_hash: string; profile_hash: string;
  model_id: string; model_hash: string; model_created_at: string; plan_declared_at: string };
export type PlannedFundingRequest = { schema_version: "investor-planned-funding-monitor-v1";
  funding_plan: InvestorFundingPlan; binding: PlannedFundingBinding; evaluated_at: string };
type Release = { id: string; release_date: string; expected_at: string;
  status: "excluded_before_anchor" | "excluded_outside_horizon" | "due" | "scheduled" };
export type PlannedFundingProjection = {
  schema_version: "investor-planned-funding-monitor-projection-v1"; input_version: string; binding: PlannedFundingBinding; binding_hash: string;
  evaluated_at: string; anchor_at: string; horizon_end_at: string; evaluation_timezone: InvestorFundingPlan["evaluation_timezone"];
  initial_notional_cny: "10000"; normalization: "sum_selected_annual_cents_divided_by_initial_cents_times_10000_floor_18_places";
  status: "none" | "not_due" | "hypothetical_due" | "no_eligible_releases" | "expired";
  releases: Release[]; due_amount_normalized_cny: string; funding_intent: { id: string; amount_cny: string; expected_at: string } | null;
  next_release_at: string | null; valid_until: string | null; qualification: "unadmitted_planned_funding_projection";
  actual_arrivals_confirmed: false; model_cash_changed: false; model_units_changed: false; execution_authorized: false; live_advice_eligible: false;
  result_hash: string;
};
const ajv = new Ajv2020({ strict: true, strictRequired: false });
addFormats(ajv);
for (const schema of [common, fundingPlan, contract]) ajv.addSchema(schema);
const validateRequest = ajv.getSchema(contract.$id)!, validateProjection = ajv.getSchema(contract.$id + "#/$defs/projection")!;
const scale = 10n ** 18n;
function normalized(cents: bigint, initial: bigint) {
  const scaled = cents * 10000n * scale / initial, tail = String(scaled % scale).padStart(18, "0").replace(/0+$/, "");
  return String(scaled / scale) + (tail ? "." + tail : "");
}
function stamp(at: bigint) {
  if (at % 1000n !== 0n) throw new Error("INVESTOR_PLANNED_FUNDING_INPUT_INVALID");
  return new Date(Number(at / 1000n)).toISOString();
}

/** Pure, unadmitted assumptions. Supplied IDs/hashes do not prove database authority. */
export function projectPlannedFundingMonitor(value: unknown): PlannedFundingProjection {
  if (!validateRequest(value)) throw new Error("INVESTOR_PLANNED_FUNDING_INPUT_INVALID");
  const request = value as PlannedFundingRequest, plan = request.funding_plan, binding = request.binding;
  if (hash(plan) !== binding.funding_plan_hash) throw new Error("INVESTOR_PLANNED_FUNDING_HASH_INVALID");
  const timeline = fundingTimeline(plan), evaluated = economicInstant(request.evaluated_at);
  const origin = economicInstant(binding.model_created_at), declared = economicInstant(binding.plan_declared_at), anchor = origin > declared ? origin : declared;
  if (anchor > evaluated) throw new Error("INVESTOR_PLANNED_FUNDING_CLOCK_REGRESSION");
  const end = economicMidnight(timeline.horizon_end_exclusive, plan.evaluation_timezone);
  const releases: Release[] = [], due: { release: Release; cents: bigint }[] = [], future: typeof due = [];
  for (const lot of timeline.lots) {
    if (lot.lot_id === "initial") continue;
    for (const [index, tranche] of lot.tranches.entries()) {
      const at = economicMidnight(tranche.release_date, plan.evaluation_timezone);
      const status: Release["status"] = !tranche.within_horizon ? "excluded_outside_horizon" : at < anchor ? "excluded_before_anchor" : at <= evaluated ? "due" : "scheduled";
      const release: Release = { id: `${lot.lot_id}:tranche:${index}`, release_date: tranche.release_date, expected_at: stamp(at), status };
      releases.push(release);
      if (status === "due" || status === "scheduled") (status === "due" ? due : future).push({ release, cents: fundingCents(tranche.amount_cny) });
    }
  }
  const initial = fundingCents(plan.initial_capital_cny), nextAt = future.map(row => row.release.expected_at).sort()[0] ?? null;
  const selected = due.length ? due : future.filter(row => row.release.expected_at === nextAt), expired = evaluated >= end, bindingHash = hash(binding);
  const intent = selected.length && !expired ? { id: "planned-annual:" + hash({ binding_hash: bindingHash, release_ids: selected.map(row => row.release.id) }),
    amount_cny: normalized(selected.reduce((sum, row) => sum + row.cents, 0n), initial),
    expected_at: selected.map(row => row.release.expected_at).sort().at(-1)! } : null;
  const status: PlannedFundingProjection["status"] = expired ? "expired" : due.length ? "hypothetical_due" : future.length ? "not_due"
    : plan.first_annual_date === null ? "none" : "no_eligible_releases";
  const body: Omit<PlannedFundingProjection, "result_hash"> = { schema_version: "investor-planned-funding-monitor-projection-v1",
    input_version: hash(request), binding: structuredClone(binding), binding_hash: bindingHash, evaluated_at: request.evaluated_at,
    anchor_at: stamp(anchor), horizon_end_at: stamp(end), evaluation_timezone: plan.evaluation_timezone, initial_notional_cny: "10000",
    normalization: "sum_selected_annual_cents_divided_by_initial_cents_times_10000_floor_18_places", status, releases,
    due_amount_normalized_cny: normalized(due.reduce((sum, row) => sum + row.cents, 0n), initial), funding_intent: intent,
    next_release_at: expired ? null : nextAt, valid_until: expired ? null : [nextAt ?? stamp(end), stamp(end)].sort()[0],
    qualification: "unadmitted_planned_funding_projection", actual_arrivals_confirmed: false, model_cash_changed: false,
    model_units_changed: false, execution_authorized: false, live_advice_eligible: false };
  const result = { ...body, result_hash: hash(body) };
  if (!validateProjection(result)) throw new Error("INVESTOR_PLANNED_FUNDING_RESULT_INVALID");
  return result;
}

export function verifyPlannedFundingMonitor(request: unknown, result: unknown): PlannedFundingProjection {
  if (!validateProjection(result) || canonical(result) !== canonical(projectPlannedFundingMonitor(request)))
    throw new Error("INVESTOR_PLANNED_FUNDING_RESULT_INVALID");
  return structuredClone(result as PlannedFundingProjection);
}

/** Stable release bucket, independently rebuilt; not a market/source attestation. */
export function plannedFundingContextHash(request: unknown): string {
  const result = projectPlannedFundingMonitor(request);
  return hash({ schema_version: "investor-planned-funding-context-v1", binding_hash: result.binding_hash,
    status: result.status, releases: result.releases, due_amount_normalized_cny: result.due_amount_normalized_cny,
    funding_intent: result.funding_intent, next_release_at: result.next_release_at, valid_until: result.valid_until });
}
