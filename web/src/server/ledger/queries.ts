import type Database from "better-sqlite3";
import { revision, type Actor } from "./service";
import { performanceFreshness, valuationFreshness } from "../valuation-freshness";
import { fundingSummary } from "../funding-summary";
import { assertWritableDatabase } from "../workbench-db";

export function workbenchState(db: Database.Database, actor: Actor, portfolioId?: string) {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  // A worker may publish while this response is being assembled.
  return db.transaction(() => readWorkbenchState(db, portfolioId))();
}

function readWorkbenchState(db: Database.Database, portfolioId?: string) {
  const portfolios = db.prepare("SELECT id,name,base_currency,performance_inception_at FROM portfolios ORDER BY created_at,id").all() as { id: string; name: string; base_currency: string; performance_inception_at: string | null }[];
  const selected = portfolioId ?? portfolios[0]?.id;
  if (selected && !portfolios.some(p => p.id === selected)) throw new Error("PORTFOLIO_NOT_FOUND");
  const currentRevision = selected ? revision(db, selected) : 0;
  const valuations = selected ? (db.prepare("SELECT id,ledger_revision,market_manifest,cutoff_at,quality,nav_cny,issues_json,method_version,created_at FROM valuation_runs WHERE portfolio_id=? ORDER BY created_at DESC,id DESC LIMIT 25")
    .all(selected) as { id: string; ledger_revision: number; market_manifest: string; cutoff_at: string; quality: "complete" | "provisional" | "blocked"; nav_cny: string | null; issues_json: string; method_version: string; created_at: string }[])
    .map(row => { const { market_manifest: _, ...result } = row; return { ...result, stale_reasons: valuationFreshness(db, row, currentRevision) }; }) : [];
  const latestValuation = valuations[0];
  const plan = selected ? (db.prepare(`SELECT v.version,v.plan_json,COALESCE(h.revision,0) funding_revision
    FROM funding_plan_versions v LEFT JOIN funding_plan_heads h ON h.portfolio_id=v.portfolio_id
    WHERE v.portfolio_id=? AND v.id=COALESCE(h.current_version_id,
      (SELECT id FROM funding_plan_versions WHERE portfolio_id=? ORDER BY version DESC LIMIT 1))`).get(selected, selected) as
    { version: number; plan_json: string; funding_revision: number } | undefined) ?? null : null;
  let readOnly = db.readonly;
  try { assertWritableDatabase(db); } catch (error) {
    if (!(error instanceof Error) || error.message !== "WORKBENCH_READ_ONLY") throw error;
    readOnly = true;
  }
  return {
    portfolios, selected: selected ?? null, revision: currentRevision, read_only: readOnly,
    accounts: selected ? db.prepare("SELECT id,name,broker,base_currency,status FROM accounts WHERE portfolio_id=? ORDER BY created_at,id").all(selected) as { id: string; name: string; broker: string; base_currency: string; status: string }[] : [],
    balances: selected ? db.prepare("SELECT p.account_id,p.currency,p.ledger_account,p.balance FROM account_projections p JOIN accounts a ON a.id=p.account_id WHERE a.portfolio_id=? ORDER BY a.id,p.currency,p.ledger_account").all(selected) as { account_id: string; currency: string; ledger_account: string; balance: string }[] : [],
    positions: selected ? db.prepare("SELECT p.account_id,p.listing_id,l.ticker,i.name,p.quantity,p.cost_amount,p.cost_known,p.currency FROM position_projections p JOIN accounts a ON a.id=p.account_id JOIN listings l ON l.id=p.listing_id JOIN instruments i ON i.id=l.instrument_id WHERE a.portfolio_id=? ORDER BY a.id,l.ticker").all(selected) as { account_id: string; listing_id: string; ticker: string; name: string; quantity: string; cost_amount: string; cost_known: number; currency: string }[] : [],
    security_transits: selected ? db.prepare("SELECT p.transfer_event_id,p.source_account_id,p.target_account_id,p.listing_id,l.ticker,i.name,p.quantity,p.cost_amount,p.cost_known,p.currency FROM security_transit_projections p JOIN accounts a ON a.id=p.source_account_id JOIN listings l ON l.id=p.listing_id JOIN instruments i ON i.id=l.instrument_id WHERE a.portfolio_id=? AND p.quantity<>'0' ORDER BY p.source_account_id,l.ticker,p.transfer_event_id").all(selected) as { transfer_event_id: string; source_account_id: string; target_account_id: string; listing_id: string; ticker: string; name: string; quantity: string; cost_amount: string; cost_known: number; currency: string }[] : [],
    plan, funding_summary: fundingSummary(db, selected ?? null, plan),
    events: selected ? db.prepare("SELECT id,event_type,account_id,effective_at,time_precision,recorded_at,ledger_revision,payload_json FROM ledger_events WHERE portfolio_id=? ORDER BY ledger_revision DESC LIMIT 100").all(selected) as { id: string; event_type: string; account_id: string; effective_at: string; time_precision: string; recorded_at: string; ledger_revision: number; payload_json: string }[] : [],
    imports: selected ? db.prepare("SELECT id,status,row_count,error_count,created_at FROM import_batches WHERE portfolio_id=? ORDER BY created_at DESC LIMIT 25").all(selected) as { id: string; status: string; row_count: number; error_count: number; created_at: string }[] : [],
    listings: db.prepare("SELECT l.id,l.market,l.exchange,l.ticker,l.currency,l.status,l.quantity_step,l.price_step,i.name,i.asset_class FROM listings l JOIN instruments i ON i.id=l.instrument_id ORDER BY l.market,l.ticker,l.id LIMIT 1000").all() as { id: string; market: string; exchange: string; ticker: string; currency: string; status: string; quantity_step: string | null; price_step: string | null; name: string; asset_class: string }[],
    attachments: selected ? db.prepare("SELECT DISTINCT a.id,a.content_hash,a.byte_size,a.created_at,json_extract(e.payload_json,'$.account_id') account_id FROM attachments a JOIN audit_events e ON e.object_id=a.id AND e.object_type='attachment' AND e.action='store_attachment' WHERE e.portfolio_id=? ORDER BY a.created_at DESC LIMIT 50").all(selected) as { id: string; content_hash: string; byte_size: number; created_at: string; account_id: string }[] : [],
    reconciliations: selected ? db.prepare("SELECT id,account_id,status,ledger_revision,result_json,created_at FROM reconciliation_runs WHERE portfolio_id=? ORDER BY created_at DESC,id DESC LIMIT 25").all(selected) as { id: string; account_id: string; status: string; ledger_revision: number; result_json: string; created_at: string }[] : [],
    reconciliation_issues: selected ? db.prepare("SELECT i.id,r.account_id,i.issue_type,i.details_json FROM reconciliation_issues i JOIN reconciliation_runs r ON r.id=i.run_id WHERE r.portfolio_id=? AND i.status='open' ORDER BY r.created_at DESC,i.id LIMIT 1000").all(selected) as { id: string; account_id: string; issue_type: string; details_json: string }[] : [],
    tasks: selected ? db.prepare("SELECT c.id,c.command_type,c.created_at,j.id job_id,COALESCE(j.status,'queued') status,j.attempt_count,j.result_json,j.updated_at FROM command_requests c LEFT JOIN job_runs j ON j.command_request_id=c.id WHERE c.portfolio_id=? ORDER BY c.created_at DESC,c.id DESC LIMIT 25").all(selected) as { id: string; command_type: string; created_at: string; job_id: string | null; status: string; attempt_count: number | null; result_json: string | null; updated_at: string | null }[] : [],
    valuations,
    performance: selected ? (db.prepare("SELECT id,ledger_revision,market_manifest,method_version,period_start,period_end,quality,method,result_json,created_at FROM performance_runs WHERE portfolio_id=? ORDER BY created_at DESC,id DESC LIMIT 10").all(selected) as { id: string; ledger_revision: number; market_manifest: string; method_version: string; period_start: string; period_end: string; quality: string; method: string; result_json: string; created_at: string }[])
      .map(row => { const { market_manifest: _, ...result } = row; return { ...result, stale_reasons: performanceFreshness(db, row, currentRevision) }; }) : [],
    valuation_status: !latestValuation ? "not_ready" : latestValuation.stale_reasons.length ? "stale" : latestValuation.quality,
    advice_status: "blocked" as const,
  };
}
export type WorkbenchState = ReturnType<typeof workbenchState>;
