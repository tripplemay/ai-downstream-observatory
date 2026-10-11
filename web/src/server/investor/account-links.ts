import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { investorInstant, investorCommandSchema } from "./schemas";
import { accountInstantMicros, portfolioLinkSchema, portfolioLinkDocumentSchema, type InvestorPortfolioLink } from "./account-schemas";

type Workspace = { id: string; owner_id: string; revision: number };
type Audit = { id: string; actor_id: string; action: string; object_type: string; object_id: string; portfolio_id: string | null;
  ledger_revision: number | null; payload_json: string; created_at: string };
type LinkRow = { id: string; workspace_id: string; version: number; portfolio_id: string | null; creation_audit_id: string | null;
  ledger_revision_at_link: number | null; document_json: string; content_hash: string; actor_id: string; created_at: string; audit_id: string };
function invalid(): never { throw new Error("INVESTOR_ACCOUNT_EVIDENCE_INVALID"); }
function instant(value: string, now: string) { if (!investorInstant.safeParse(value).success || value > now) invalid(); }
function verifyWorkspace(db: Database.Database, ws: Workspace) {
  const row = db.prepare("SELECT id,owner_id,revision FROM investor_workspaces WHERE id=? AND owner_id=?").get(ws.id, ws.owner_id);
  if (!row || canonical(row) !== canonical(ws)) invalid();
}

// Legacy portfolios have no owner column. Only their immutable creation audit proves scope.
export function ownedInvestorBook(db: Database.Database, owner: string, portfolioId: string, now: string) {
  const audits = db.prepare("SELECT * FROM audit_events WHERE action='create_portfolio' AND object_type='portfolio' AND object_id=? LIMIT 2").all(portfolioId) as Audit[];
  if (audits.length !== 1 || audits[0].actor_id !== owner) throw new Error("INVESTOR_ACCOUNT_OUT_OF_SCOPE");
  const audit = audits[0], book = db.prepare(`SELECT p.id,p.name,p.base_currency,p.created_at,h.revision ledger_revision,h.updated_at
    FROM portfolios p JOIN ledger_heads h ON h.portfolio_id=p.id WHERE p.id=?`).get(portfolioId) as
    { id: string; name: string; base_currency: string; created_at: string; ledger_revision: number; updated_at: string } | undefined;
  if (!book || audit.portfolio_id !== book.id || audit.ledger_revision !== 0 || audit.created_at !== book.created_at || book.base_currency !== "CNY"
    || !Number.isSafeInteger(book.ledger_revision) || book.ledger_revision < 0) invalid();
  const created = accountInstantMicros(book.created_at), updated = accountInstantMicros(book.updated_at), checked = accountInstantMicros(now);
  if (created === null || updated === null || checked === null || created > checked || updated > checked || updated < created) invalid();
  let payload: unknown;
  try { payload = parseStrictJson(audit.payload_json); } catch { invalid(); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 1 || !("name" in payload)
    || typeof payload.name !== "string" || payload.name.trim() !== book.name) invalid();
  return { id: book.id, name: book.name, ledger_revision: book.ledger_revision, created_at: book.created_at, creation_audit_id: audit.id };
}

export function readInvestorPortfolioLink(db: Database.Database, ws: Workspace, now: string): InvestorPortfolioLink | null {
  verifyWorkspace(db, ws);
  const row = db.prepare("SELECT * FROM investor_portfolio_links WHERE workspace_id=? ORDER BY version DESC LIMIT 1").get(ws.id) as LinkRow | undefined;
  if (!row) return null;
  instant(row.created_at, now);
  const history = db.prepare("SELECT count(*) n,min(created_at) first_at,max(created_at) last_at FROM investor_portfolio_links WHERE workspace_id=?").get(ws.id) as { n: number; first_at: string; last_at: string };
  if (history.n !== row.version || history.last_at !== row.created_at) invalid();
  instant(history.first_at, now);
  const audit = db.prepare("SELECT * FROM audit_events WHERE id=?").get(row.audit_id) as Audit | undefined;
  if (!audit || row.actor_id !== ws.owner_id || audit.actor_id !== ws.owner_id || audit.object_type !== "investor_workspace" || audit.object_id !== ws.id
    || audit.portfolio_id !== null || audit.ledger_revision !== null || audit.created_at !== row.created_at
    || !["investor_link_portfolio", "investor_create_account_book"].includes(audit.action)) invalid();
  let link: InvestorPortfolioLink, payload: { input?: unknown; result?: unknown };
  try {
    const document = portfolioLinkDocumentSchema.parse(parseStrictJson(row.document_json));
    link = portfolioLinkSchema.parse({ id: row.id, version: row.version, content_hash: row.content_hash, document });
    if (hash(document) !== row.content_hash || document.portfolio_id !== row.portfolio_id || document.creation_audit_id !== row.creation_audit_id
      || document.ledger_revision_at_link !== row.ledger_revision_at_link || document.linked_at !== row.created_at) invalid();
    payload = parseStrictJson(audit.payload_json) as typeof payload;
    if (!payload || canonical(Object.keys(payload).sort()) !== canonical(["input", "result"])) invalid();
    const command = investorCommandSchema.parse(payload.input);
    if (audit.action !== "investor_" + command.action || command.expected_revision >= ws.revision) invalid();
    if (command.action === "link_portfolio") {
      if (command.portfolio_id !== document.portfolio_id || command.expected_ledger_revision !== document.ledger_revision_at_link) invalid();
      if (canonical(payload.result) !== canonical({ link_id: row.id, portfolio_id: document.portfolio_id, execution_authorized: false })) invalid();
    } else if (command.action === "create_account_book") {
      if (!document.portfolio_id || document.ledger_revision_at_link !== 0 || !payload.result || typeof payload.result !== "object"
        || Array.isArray(payload.result) || !("account_id" in payload.result) || typeof payload.result.account_id !== "string") invalid();
      if (canonical(payload.result) !== canonical({ link_id: row.id, portfolio_id: document.portfolio_id, account_id: payload.result.account_id, execution_authorized: false })) invalid();
      const createdAccount = db.prepare("SELECT portfolio_id,name,broker,base_currency,created_at FROM accounts WHERE id=?").get(payload.result.account_id) as
        { portfolio_id: string; name: string; broker: string; base_currency: string; created_at: string } | undefined;
      if (!createdAccount || createdAccount.portfolio_id !== document.portfolio_id || createdAccount.name !== command.account.name
        || createdAccount.broker !== command.account.broker || createdAccount.base_currency !== command.account.currency || createdAccount.created_at !== row.created_at) invalid();
    } else invalid();
  } catch { invalid(); }
  if (link.document.portfolio_id) {
    const book = ownedInvestorBook(db, ws.owner_id, link.document.portfolio_id, now);
    if (book.creation_audit_id !== link.document.creation_audit_id || book.ledger_revision < link.document.ledger_revision_at_link!) invalid();
    const command = investorCommandSchema.parse(payload!.input);
    if (command.action === "create_account_book" && book.name !== command.book_name) invalid();
  }
  return link;
}

export function appendInvestorPortfolioLink(db: Database.Database, ws: Workspace, portfolioId: string | null, expectedLedgerRevision: number | null,
  id: string, auditId: string, now: string) {
  verifyWorkspace(db, ws);
  if ((portfolioId === null) !== (expectedLedgerRevision === null)) throw new Error("INVESTOR_ACCOUNT_INPUT_INVALID");
  const book = portfolioId ? ownedInvestorBook(db, ws.owner_id, portfolioId, now) : null;
  if (book && book.ledger_revision !== expectedLedgerRevision) throw new Error("INVESTOR_LEDGER_VERSION_CONFLICT");
  const prior = readInvestorPortfolioLink(db, ws, now), version = (prior?.version ?? 0) + 1;
  const document = portfolioLinkDocumentSchema.parse({ schema_version: "investor-portfolio-link-v1", portfolio_id: portfolioId,
    creation_audit_id: book?.creation_audit_id ?? null, ledger_revision_at_link: expectedLedgerRevision, linked_at: now });
  db.prepare(`INSERT INTO investor_portfolio_links(id,workspace_id,version,portfolio_id,creation_audit_id,ledger_revision_at_link,document_json,content_hash,actor_id,created_at,audit_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, ws.id, version, portfolioId, document.creation_audit_id, expectedLedgerRevision,
    canonical(document), hash(document), ws.owner_id, now, auditId);
}
