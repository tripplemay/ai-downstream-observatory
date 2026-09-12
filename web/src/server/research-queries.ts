import type Database from "better-sqlite3";
import { revision, type Actor } from "./ledger/service";

interface Experiment {
  id: string; plan_hash: string; dataset_hash: string; created_at: string;
  mode: string; hypothesis: string | null; trial_budgets_json: string | null;
}
interface Trial {
  id: string; experiment_id: string; run_id: string; trial_number: number;
  phase: string; parameters_hash: string; status: string; completed_at: string | null;
  data_mode: string | null; profit_cny: string | null; twr: string | null;
  benchmark_twr: string | null; excess_twr: string | null; max_drawdown: string | null;
  result_hash: string | null; gates_json: string | null; error: string | null;
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
    trials: db.prepare(`SELECT t.id,t.experiment_id,t.run_id,t.trial_number,t.phase,t.parameters_hash,
      r.status,r.completed_at,json_extract(r.result_json,'$.data_mode') data_mode,
      json_extract(r.result_json,'$.strategy.profit_cny') profit_cny,
      json_extract(r.result_json,'$.strategy.twr') twr,
      json_extract(r.result_json,'$.benchmark.twr') benchmark_twr,
      json_extract(r.result_json,'$.excess_twr') excess_twr,
      json_extract(r.result_json,'$.strategy.max_drawdown') max_drawdown,
      json_extract(r.result_json,'$.result_hash') result_hash,
      json_extract(r.result_json,'$.strategy_gates') gates_json,
      json_extract(r.result_json,'$.error') error
      FROM research_trials t JOIN research_runs r ON r.id=t.run_id
      WHERE r.portfolio_id=? ORDER BY t.created_at DESC,t.id DESC LIMIT 100`).all(portfolioId) as Trial[],
    holdout_events: db.prepare(`SELECT h.id,h.experiment_id,h.trial_id,h.action,h.parameters_hash,h.created_at
      FROM research_holdout_events h JOIN research_experiments e ON e.id=h.experiment_id
      WHERE e.portfolio_id=? ORDER BY h.created_at DESC,h.id DESC LIMIT 100`).all(portfolioId) as { id: string; experiment_id: string; trial_id: string | null; action: string; parameters_hash: string; created_at: string }[],
    ai_reviews: db.prepare("SELECT id,research_run_id,model,prompt_version,status,quality_json,created_at FROM ai_runs WHERE portfolio_id=? ORDER BY created_at DESC,id DESC LIMIT 50").all(portfolioId) as { id: string; research_run_id: string | null; model: string; prompt_version: string; status: string; quality_json: string; created_at: string }[],
    live_advice_eligible: false,
    limits: { experiments: 100, trials: 100, holdout_events: 100, ai_reviews: 50 },
  }))();
}

export type ResearchState = ReturnType<typeof getResearchState>;
