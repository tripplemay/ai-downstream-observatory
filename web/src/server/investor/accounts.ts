import type Database from "better-sqlite3";
import type { Actor } from "../ledger/service";
import { assertWritableDatabase } from "../workbench-db";
import { investorInstant } from "./schemas";
import { ownedInvestorBook, readInvestorPortfolioLink } from "./account-links";
import { investorAccountsSchema, type InvestorAccountWorkspace } from "./account-schemas";

export function getInvestorAccountWorkspace(db: Database.Database, actor: Actor, now = new Date().toISOString()): InvestorAccountWorkspace {
  if (!actor || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(actor.id)) throw new Error("UNAUTHENTICATED");
  if (!investorInstant.safeParse(now).success) throw new Error("INVESTOR_INVALID_CLOCK");
  return db.transaction(() => {
    const ws = db.prepare("SELECT id,owner_id,revision FROM investor_workspaces WHERE owner_id=?").get(actor.id) as
      { id: string; owner_id: string; revision: number } | undefined;
    let readOnly = false;
    try { assertWritableDatabase(db); } catch (error) { if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") readOnly = true; else throw error; }
    const base: InvestorAccountWorkspace = { schema_version: "investor-accounts-v1", workspace_id: ws?.id ?? null, workspace_revision: ws?.revision ?? 0,
      checked_at: now, read_only: readOnly, link: null, books: [], accounts: [], scope: "account_records_not_valued", live_advice_eligible: false, execution_authorized: false };
    if (!ws) return base;
    const candidates = db.prepare(`SELECT DISTINCT p.id FROM portfolios p JOIN audit_events a ON a.object_id=p.id
      WHERE a.actor_id=? AND a.action='create_portfolio' AND a.object_type='portfolio' ORDER BY p.created_at,p.id LIMIT 101`).all(actor.id) as { id: string }[];
    if (candidates.length > 100) throw new Error("INVESTOR_ACCOUNT_CAPACITY_REQUIRES_REVIEW");
    const books = candidates.map(row => { const { creation_audit_id: _, ...book } = ownedInvestorBook(db, actor.id, row.id, now); return book; });
    const link = readInvestorPortfolioLink(db, ws, now);
    const accounts = link?.document.portfolio_id ? db.prepare(`SELECT id,name,broker,base_currency,status,row_version,created_at FROM accounts
      WHERE portfolio_id=? ORDER BY created_at,id LIMIT 201`).all(link.document.portfolio_id) as InvestorAccountWorkspace["accounts"] : [];
    if (accounts.length > 200) throw new Error("INVESTOR_ACCOUNT_CAPACITY_REQUIRES_REVIEW");
    try { return investorAccountsSchema.parse({ ...base, books, link, accounts }); }
    catch { throw new Error("INVESTOR_ACCOUNT_EVIDENCE_INVALID"); }
  })();
}
