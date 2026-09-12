import type Database from "better-sqlite3";
import { amount, exact } from "./ledger/decimal";
import { currentPlan, fundingHead } from "./funding/core";

export function fundingSummary(db: Database.Database, portfolio: string | null,
  row: { version: number; plan_json: string; funding_revision: number } | null) {
  const empty = { status: row ? "needs_review" : "not_configured", version: row?.version ?? null,
    funding_revision: row?.funding_revision ?? 0, title: null as string | null,
    review_reason: row ? "UNCONFIRMED_FUNDING_PLAN" : null,
    source_count: 0, tranche_count: 0, period_start: null as string | null, period_end: null as string | null,
    totals: [] as { currency: string; planned_amount: string }[] };
  if (!row?.funding_revision) return empty;
  const summarize = () => {
    try {
      // Reuse the funding view's hash and item checks inside the ledger's read snapshot.
      const current = portfolio ? currentPlan(db, portfolio) : null;
      if (!current || current.row.version !== row.version || current.row.plan_json !== row.plan_json
          || fundingHead(db, portfolio!)?.revision !== row.funding_revision) throw new Error("UNVERIFIED_PLAN");
      const plan = current.plan, sources = plan.sources.filter(source => source.status === "planned");
      const totals = new Map<string, ReturnType<typeof amount>>();
      for (const source of sources) totals.set(source.currency, (totals.get(source.currency) ?? amount("0")).add(source.planned_amount));
      return { ...empty, status: "confirmed_plan", review_reason: null, title: plan.title, source_count: sources.length,
        tranche_count: plan.tranches.filter(tranche => tranche.status === "planned").length,
        period_start: sources.map(source => source.period_start).sort()[0] ?? null,
        period_end: sources.map(source => source.period_end).sort().at(-1) ?? null,
        totals: [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, total]) => ({ currency, planned_amount: exact(total) })) };
    } catch {
      return { ...empty, review_reason: "FUNDING_PLAN_INTEGRITY_FAILED" };
    }
  };
  return db.inTransaction ? summarize() : db.transaction(summarize).deferred();
}
