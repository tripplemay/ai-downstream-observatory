import type Database from "better-sqlite3";
import { revision, type Actor } from "./ledger/service";

interface Experiment {
  id: string; plan_hash: string; dataset_hash: string; created_at: string;
  mode: string; hypothesis: string | null; trial_budgets_json: string | null;
}
export interface ResearchTrial {
  id: string; experiment_id: string; run_id: string; trial_number: number;
  phase: string; parameters_json: string; parameters_hash: string; status: string; completed_at: string | null;
  plan_schema_version: string | null; engine_version: string | null;
  data_mode: string | null; profit_cny: string | null; twr: string | null;
  initial_equity_cny: string | null; contributions_cny: string | null; ending_nav_cny: string | null;
  fees_cny: string | null; fx_fees_cny: string | null; slippage_cny: string | null; cash_rounding_cny: string | null;
  buy_turnover_on_mean_observed_nav: string | null; sell_turnover_on_mean_observed_nav: string | null;
  total_turnover_on_mean_observed_nav: string | null; ending_cash_ratio: string | null;
  execution_failure_count: number | null;
  monthly_evaluation_counts: { proposed: number; unchanged: number; blocked: number } | null;
  benchmark_twr: string | null; excess_twr: string | null; max_drawdown: string | null;
  result_hash: string | null; gates_json: string | null; error: string | null; error_code: string | null;
}

function monthlyCounts(raw: string | null): ResearchTrial["monthly_evaluation_counts"] {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 3 || !["proposed", "unchanged", "blocked"].every(key => typeof row[key] === "number" && Number.isSafeInteger(row[key]) && row[key] >= 0)) return null;
  return row as NonNullable<ResearchTrial["monthly_evaluation_counts"]>;
}

export function getResearchState(db: Database.Database, actor: Actor, portfolioId: string) {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  return db.transaction(() => ({
    portfolio_id: portfolioId, revision: revision(db, portfolioId), read_only: db.readonly,
    experiments: db.prepare(`SELECT id,plan_hash,dataset_hash,created_at,
      json_extract(dataset_manifest_json,'$.dataset.mode') mode,
      json_extract(plan_json,'$.hypothesis') hypothesis,
      json_extract(plan_json,'$.trial_budgets') trial_budgets_json
      FROM research_experiments WHERE portfolio_id=? ORDER BY created_at DESC,id DESC LIMIT 100`).all(portfolioId) as Experiment[],
    trials: (db.prepare(`SELECT t.id,t.experiment_id,t.run_id,t.trial_number,t.phase,t.parameters_json,t.parameters_hash,
      r.status,r.completed_at,json_extract(r.result_json,'$.data_mode') data_mode,
      json_extract(e.plan_json,'$.schema_version') plan_schema_version,
      json_extract(r.result_json,'$.strategy.engine_version') engine_version,
      json_extract(r.result_json,'$.strategy.initial_equity_cny') initial_equity_cny,
      json_extract(r.result_json,'$.strategy.contributions_cny') contributions_cny,
      json_extract(r.result_json,'$.strategy.ending_nav_cny') ending_nav_cny,
      json_extract(r.result_json,'$.strategy.profit_cny') profit_cny,
      json_extract(r.result_json,'$.strategy.fees_cny') fees_cny,
      json_extract(r.result_json,'$.strategy.fx_fees_cny') fx_fees_cny,
      json_extract(r.result_json,'$.strategy.slippage_cny') slippage_cny,
      json_extract(r.result_json,'$.strategy.cash_rounding_cny') cash_rounding_cny,
      json_extract(r.result_json,'$.strategy.buy_turnover_on_mean_observed_nav') buy_turnover_on_mean_observed_nav,
      json_extract(r.result_json,'$.strategy.sell_turnover_on_mean_observed_nav') sell_turnover_on_mean_observed_nav,
      json_extract(r.result_json,'$.strategy.total_turnover_on_mean_observed_nav') total_turnover_on_mean_observed_nav,
      json_extract(r.result_json,'$.strategy.ending_cash_ratio') ending_cash_ratio,
      json_extract(r.result_json,'$.strategy.execution_failure_count') execution_failure_count,
      json_extract(r.result_json,'$.strategy.monthly_evaluation_counts') monthly_counts_json,
      json_extract(r.result_json,'$.strategy.twr') twr,
      json_extract(r.result_json,'$.benchmark.twr') benchmark_twr,
      json_extract(r.result_json,'$.excess_twr') excess_twr,
      json_extract(r.result_json,'$.strategy.max_drawdown') max_drawdown,
      json_extract(r.result_json,'$.result_hash') result_hash,
      json_extract(r.result_json,'$.strategy_gates') gates_json,
      json_extract(r.result_json,'$.error') error,json_extract(r.result_json,'$.code') error_code
      FROM research_trials t JOIN research_runs r ON r.id=t.run_id JOIN research_experiments e ON e.id=t.experiment_id
      WHERE r.portfolio_id=? AND e.portfolio_id=r.portfolio_id ORDER BY t.created_at DESC,t.id DESC LIMIT 100`).all(portfolioId) as (Omit<ResearchTrial, "monthly_evaluation_counts"> & { monthly_counts_json: string | null })[])
      .map(({ monthly_counts_json, ...trial }) => ({ ...trial, monthly_evaluation_counts: monthlyCounts(monthly_counts_json) })),
    holdout_events: db.prepare(`SELECT h.id,h.experiment_id,h.trial_id,h.action,h.parameters_hash,h.created_at
      FROM research_holdout_events h JOIN research_experiments e ON e.id=h.experiment_id
      WHERE e.portfolio_id=? ORDER BY h.created_at DESC,h.id DESC LIMIT 100`).all(portfolioId) as { id: string; experiment_id: string; trial_id: string | null; action: string; parameters_hash: string; created_at: string }[],
    ai_reviews: db.prepare("SELECT id,research_run_id,model,prompt_version,status,quality_json,created_at FROM ai_runs WHERE portfolio_id=? ORDER BY created_at DESC,id DESC LIMIT 50").all(portfolioId) as { id: string; research_run_id: string | null; model: string; prompt_version: string; status: string; quality_json: string; created_at: string }[],
    live_advice_eligible: false,
    limits: { experiments: 100, trials: 100, holdout_events: 100, ai_reviews: 50 },
  }))();
}

export type ResearchState = ReturnType<typeof getResearchState>;
