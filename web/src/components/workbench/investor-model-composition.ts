import type { InvestorState } from "@/server/investor/types";
import { currentInvestorDisplay } from "./research-format";

export function researchDecimalDifference(left: string, right: string): string {
  const parse = (value: string) => {
    if (value.length > 200 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,120})?$/.test(value)) throw new Error("INVESTOR_DISPLAY_DECIMAL_INVALID");
    const negative = value.startsWith("-"), [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
    return { number: BigInt(whole + fraction) * (negative ? -1n : 1n), scale: fraction.length };
  };
  const a = parse(left), b = parse(right), scale = Math.max(a.scale, b.scale);
  const result = a.number * 10n ** BigInt(scale - a.scale) - b.number * 10n ** BigInt(scale - b.scale);
  if (result === 0n) return "0";
  const digits = (result < 0n ? -result : result).toString().padStart(scale + 1, "0");
  const value = scale ? digits.slice(0, -scale) + "." + digits.slice(-scale).replace(/0+$/, "") : digits;
  return (result < 0n ? "-" : "") + value.replace(/\.$/, "");
}

export function currentResearchModelComposition(state: InvestorState, nowMs: number) {
  const display = currentInvestorDisplay(state, nowMs), { plan, modelWatch: watch } = display;
  const latest = state.latest, profile = state.profile, change = latest?.document.model_change;
  if (!Number.isFinite(nowMs) || display.gaps.length || !["observe", "decision_required"].includes(display.outcome)
    || !plan || plan.quality !== "current" || !plan.saved_for_observation || plan.document.data_mode !== "reconstructed"
    || plan.document.reference_evidence?.qualification !== "owner_reviewed_reconstructed" || !profile || profile.document.loss_tolerance === null
    || plan.document.profile_id !== profile.id || !watch || !watch.enabled
    || !latest || !change || latest.document.outcome !== display.outcome || latest.document.monitoring !== "active"
    || watch.status !== (display.outcome === "observe" ? "research_observe" : "research_decision")
    || watch.source_qualification !== "owner_reviewed_reconstructed" || watch.checkpoint_sequence < 1 || watch.model_nav_cny === null
    || watch.plan_id !== plan.id || watch.plan_hash !== plan.content_hash || latest.candidate_plan_id !== plan.id
    || watch.profile_id !== profile.id || latest.document.profile_id !== profile.id || latest.document.profile_version !== profile.version
    || watch.evaluation_input_version !== latest.document.input_version || !latest.document.data_cutoff
    || !watch.next_check_at || !latest.document.next_review_at || !watch.completed_at
    || Date.parse(latest.document.evaluated_at) < Date.parse(watch.created_at)
    || Date.parse(watch.completed_at) < Date.parse(latest.document.evaluated_at)
    || ["pending", "unavailable"].includes(state.monitor_costs?.status ?? "")) return null;
  try {
    const nav = researchDecimalDifference(watch.model_nav_cny, "0");
    if (nav === "0" || nav.startsWith("-") || change.model_nav_cny === null
      || researchDecimalDifference(change.model_nav_cny, watch.model_nav_cny) !== "0") return null;
    const rows = new Map(change.changes.map(row => [row.listing_id, row]));
    if (rows.size !== plan.document.targets.length || rows.size !== change.changes.length
      || new Set(plan.document.targets.map(target => target.listing_id)).size !== rows.size) return null;
    const targets = plan.document.targets.map(target => {
      const row = rows.get(target.listing_id), cutoff = change.market_cutoffs[target.market];
      const excess = row ? researchDecimalDifference(row.observed_model_weight, "1") : "0";
      if (!row || !cutoff || !Number.isFinite(Date.parse(cutoff)) || Date.parse(cutoff) > Date.parse(latest.document.evaluated_at)
        || researchDecimalDifference(row.current_model_value_cny, "0").startsWith("-")
        || researchDecimalDifference(row.observed_model_weight, "0").startsWith("-")
        || excess !== "0" && !excess.startsWith("-")
        || researchDecimalDifference(row.after_target_weight, target.weight) !== "0") throw new Error("INVESTOR_MODEL_COMPOSITION_BINDING");
      return { ...target, observed_weight: row.observed_model_weight, value_cny: row.current_model_value_cny,
        weight_difference: researchDecimalDifference(row.observed_model_weight, target.weight), data_cutoff: cutoff };
    });
    return { model_id: watch.id, observation_id: latest.id, evaluated_at: latest.document.evaluated_at,
      data_cutoff: latest.document.data_cutoff, model_nav_cny: watch.model_nav_cny, targets };
  } catch { return null; }
}
export type ResearchModelComposition = NonNullable<ReturnType<typeof currentResearchModelComposition>>;
