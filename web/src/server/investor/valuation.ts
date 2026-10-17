import type Database from "better-sqlite3";
import { canonical, hash, type Actor } from "../ledger/service";
import type { AttachmentOptions } from "../ledger/attachments";
import { parseStrictJson } from "../strict-json";
import { enqueueWorkbenchTask } from "../workbench-commands";
import { assertWritableDatabase } from "../workbench-db";
import { verifiedMarketSource } from "../market-source";
import { getInvestorAccountWorkspace } from "./accounts";
import { readInvestorReconciliation, reconciliationReadOrderSql } from "./reconciliation-evidence";
import { holdingsInstantMicros } from "./holdings-schemas";
import { valuationContextSchema, valuationGapCodes, valuationIntentSchema, type ValuationContext, type ValuationIntent } from "./valuation-schemas";

function capacity(): never { throw new Error("INVESTOR_VALUATION_CAPACITY_REQUIRES_REVIEW"); }
function latestTask(db: Database.Database, actor: Actor, portfolio: string, workspace: string): ValuationContext["task"] {
  const rows = db.prepare(`SELECT c.*,j.status FROM command_requests c JOIN audit_events a ON json_extract(a.payload_json,'$.result.request_id')=c.id
    LEFT JOIN job_runs j ON j.command_request_id=c.id WHERE c.actor_id=? AND c.portfolio_id=? AND c.command_type='valuation'
    AND a.actor_id=? AND a.action='investor_request_linked_valuation' AND a.object_type='investor_workspace' AND a.object_id=?
    ORDER BY json_extract(a.payload_json,'$.input.expected_revision') DESC LIMIT 1`).all(actor.id, portfolio, actor.id, workspace) as { id: string; payload_hash: string; payload_json: string; status: string | null }[];
  const row = rows[0]; if (!row) return null;
  const audits = db.prepare(`SELECT payload_json FROM audit_events WHERE actor_id=? AND action='investor_request_linked_valuation'
    AND object_type='investor_workspace' AND object_id=? AND json_extract(payload_json,'$.result.request_id')=? LIMIT 2`).all(actor.id, workspace, row.id) as { payload_json: string }[];
  if (audits.length !== 1) throw new Error("INVESTOR_VALUATION_EVIDENCE_INVALID");
  const audit = parseStrictJson(audits[0].payload_json) as { result: { payload_hash: string } };
  if (hash(parseStrictJson(row.payload_json)) !== row.payload_hash || audit.result.payload_hash !== row.payload_hash) throw new Error("INVESTOR_VALUATION_EVIDENCE_INVALID");
  return { id: row.id, status: (row.status ?? "queued") as NonNullable<ValuationContext["task"]>["status"] };
}
function sources(db: Database.Database, actor: Actor, portfolio: string, now: string): ValuationContext["sources"] {
  const rows = db.prepare(`SELECT p.*,b.batch_type FROM market_publications p JOIN market_batches b ON b.id=p.batch_id
    WHERE b.batch_type IN ('prices','fx') AND EXISTS (SELECT 1 FROM command_requests c WHERE c.actor_id=? AND c.portfolio_id=? AND
      ((c.command_type='market_ingest' AND json_extract(c.payload_json,'$.document.batch.id')=b.id)
       OR EXISTS (SELECT 1 FROM market_provider_captures x WHERE x.batch_id=b.id AND x.command_request_id=c.id)
       OR EXISTS (SELECT 1 FROM market_sdk_captures x WHERE x.batch_id=b.id AND x.command_request_id=c.id)))
    ORDER BY p.scope LIMIT 101`).all(actor.id, portfolio) as { scope: string; batch_id: string; revision: number; manifest_hash: string; published_at: string; batch_type: "prices" | "fx" }[];
  if (rows.length > 100) capacity();
  const result: ValuationContext["sources"] = [];
  let bytes = 0;
  for (const row of rows) {
    const requests = db.prepare(`SELECT c.* FROM command_requests c WHERE c.actor_id=? AND c.portfolio_id=? AND
      ((c.command_type='market_ingest' AND json_extract(c.payload_json,'$.document.batch.id')=?)
       OR EXISTS (SELECT 1 FROM market_provider_captures x WHERE x.batch_id=? AND x.command_request_id=c.id)
       OR EXISTS (SELECT 1 FROM market_sdk_captures x WHERE x.batch_id=? AND x.command_request_id=c.id)) LIMIT 2`)
      .all(actor.id, portfolio, row.batch_id, row.batch_id, row.batch_id) as { id: string; payload_json: string; payload_hash: string; idempotency_key: string }[];
    if (requests.length !== 1) continue;
    const request = requests[0]; bytes += Buffer.byteLength(request.payload_json); if (bytes > 32 * 1024 * 1024) capacity();
    try {
      const payload = parseStrictJson(request.payload_json);
      if (hash(payload) !== request.payload_hash || holdingsInstantMicros(row.published_at) === null
        || holdingsInstantMicros(row.published_at)! > holdingsInstantMicros(now)!) continue;
      const audits = db.prepare(`SELECT payload_json FROM audit_events WHERE actor_id=? AND portfolio_id=? AND action='enqueue_task'
        AND object_type='workbench_command' AND object_id=? LIMIT 2`).all(actor.id, portfolio, request.idempotency_key) as { payload_json: string }[];
      if (audits.length !== 1) continue;
      const audit = parseStrictJson(audits[0].payload_json) as { input?: { payload?: unknown }; result?: { request_id?: string; payload_hash?: string } };
      if (audit.result?.request_id !== request.id || audit.result.payload_hash !== request.payload_hash || hash(audit.input?.payload) !== request.payload_hash) continue;
      const source = verifiedMarketSource(db, row.batch_id, now);
      if (source.mode === "manual_verified") {
        const document = payload as { publish?: boolean; document?: { batch?: unknown } };
        const batch = db.prepare("SELECT validation_json,manifest_hash,scope FROM market_batches WHERE id=?").get(row.batch_id) as { validation_json: string; manifest_hash: string; scope: string };
        const validation = parseStrictJson(batch.validation_json) as { plan?: unknown };
        const jobs = db.prepare("SELECT status,result_json FROM job_runs WHERE command_request_id=? LIMIT 2").all(request.id) as { status: string; result_json: string }[];
        if (document.publish !== true || canonical(document.document?.batch) !== canonical(validation.plan) || batch.scope !== row.scope
          || batch.manifest_hash !== row.manifest_hash || jobs.length !== 1 || jobs[0].status !== "succeeded") continue;
        const result = parseStrictJson(jobs[0].result_json) as { batch_id?: string; batch_status?: string; manifest_hash?: string };
        if (result.batch_id !== row.batch_id || result.batch_status !== "published" || result.manifest_hash !== row.manifest_hash) continue;
      }
      const markets = db.prepare(`SELECT DISTINCT l.market FROM market_batch_members m JOIN market_observations o ON o.id=m.observation_id
        JOIN listings l ON l.id=o.listing_id WHERE m.batch_id=? ORDER BY l.market LIMIT 4`).all(row.batch_id) as { market: "CN" | "HK" | "US" }[];
      if (markets.length > 3) continue;
      result.push({ scope: row.scope, revision: row.revision, manifest_hash: row.manifest_hash, batch_type: row.batch_type,
        mode: source.mode, markets: markets.map(item => item.market) });
    } catch { /* An unreadable source is never promoted to an available choice. */ }
  }
  return result;
}

/** Whole-book metadata only. No NAV, scheduling, provider calls or rule approval on reads. */
export function getInvestorValuationContext(db: Database.Database, actor: Actor, now = new Date().toISOString(), options: AttachmentOptions = {}): ValuationContext {
  return db.transaction(() => {
    const scope = getInvestorAccountWorkspace(db, actor, now), link = scope.link;
    const book = scope.books.find(row => row.id === link?.document.portfolio_id);
    if (!link || !book) throw new Error("INVESTOR_ACCOUNT_OUT_OF_SCOPE");
    const events = db.prepare("SELECT count(*) n FROM ledger_events WHERE portfolio_id=?").get(book.id) as { n: number };
    const attachments = db.prepare(`SELECT COALESCE(sum(a.byte_size),0) bytes FROM reconciliation_runs r JOIN attachments a ON a.id=r.attachment_id
      WHERE r.portfolio_id=? AND r.id IN (SELECT r2.id FROM reconciliation_runs r2 WHERE r2.portfolio_id=? AND r2.account_id=r.account_id
      ORDER BY ${reconciliationReadOrderSql} LIMIT 1)`).get(book.id, book.id) as { bytes: number };
    if (events.n > 10000 || attachments.bytes > 16 * 1024 * 1024) capacity();
    const gaps: ValuationContext["gaps"] = [], accounts: ValuationContext["accounts"] = [];
    for (const account of scope.accounts) {
      let reconciliation: ValuationContext["accounts"][number]["reconciliation"] = null, gap: ValuationContext["gaps"][number] | null = null;
      try { const { account_id: _, ...proof } = readInvestorReconciliation(db, actor, book.id, account.id, book.ledger_revision, now, options); reconciliation = proof; }
      catch (error) { gap = error instanceof Error && (valuationGapCodes as readonly string[]).includes(error.message)
        ? error.message as NonNullable<typeof gap> : "RECONCILIATION_EVIDENCE_INVALID"; if (!gaps.includes(gap)) gaps.push(gap); }
      accounts.push({ id: account.id, row_version: account.row_version, status: account.status, reconciliation, gap });
    }
    if (!accounts.length) gaps.push("ACCOUNT_BOOK_EMPTY");
    // Include historical movements: the common reconciled cutoff can precede the latest positions.
    const listings = db.prepare(`SELECT DISTINCT l.id,l.ticker,l.market,l.currency FROM listings l WHERE l.id IN (
      SELECT p.listing_id FROM position_movements p JOIN ledger_events e ON e.id=p.event_id WHERE e.portfolio_id=? UNION
      SELECT p.listing_id FROM security_transit_movements p JOIN ledger_events e ON e.id=p.event_id WHERE e.portfolio_id=?) ORDER BY l.id LIMIT 201`)
      .all(book.id, book.id) as ValuationContext["listings"];
    const currencies = db.prepare(`SELECT DISTINCT p.currency FROM postings p JOIN ledger_events e ON e.id=p.event_id
      WHERE e.portfolio_id=? ORDER BY p.currency LIMIT 21`).all(book.id) as { currency: string }[];
    if (listings.length > 200 || currencies.length > 20) capacity();
    const cutoffs = accounts.flatMap(row => row.reconciliation ? [row.reconciliation.cutoff_at] : [])
      .sort((a, b) => holdingsInstantMicros(a)! < holdingsInstantMicros(b)! ? -1 : 1);
    const identity = { schema_version: "investor-valuation-v1" as const, workspace_id: scope.workspace_id!, workspace_revision: scope.workspace_revision,
      portfolio_id: book.id, ledger_revision: book.ledger_revision, link_id: link.id, link_version: link.version,
      cutoff_at: gaps.length ? null : cutoffs[0] ?? null, accounts, listings, currencies: currencies.map(row => row.currency),
      sources: sources(db, actor, book.id, now), gaps, basis: "metadata_only_whole_book_historical_requirements" as const, execution_authorized: false as const };
    return valuationContextSchema.parse({ ...identity, context_hash: hash(identity), checked_at: now, read_only: scope.read_only,
      task: latestTask(db, actor, book.id, scope.workspace_id!) });
  }).deferred();
}

export function requestInvestorValuation(db: Database.Database, actor: Actor, raw: ValuationIntent & { idempotency_key: string; expected_revision?: number }, now: string, options: AttachmentOptions = {}) {
  const { idempotency_key, expected_revision: _, ...intent } = raw, input = valuationIntentSchema.parse(intent);
  assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db);
    const context = getInvestorValuationContext(db, actor, now, options);
    if (context.portfolio_id !== input.portfolio_id) throw new Error("INVESTOR_ACCOUNT_OUT_OF_SCOPE");
    if (context.ledger_revision !== input.expected_ledger_revision || context.link_id !== input.expected_link_id
      || context.link_version !== input.expected_link_version || context.context_hash !== input.expected_context_hash) throw new Error("INVESTOR_VALUATION_CONTEXT_CONFLICT");
    if (context.gaps.length || !context.cutoff_at) throw new Error("INVESTOR_VALUATION_RECONCILIATION_REQUIRED");
    if (input.cutoff_at !== context.cutoff_at) throw new Error("INVESTOR_VALUATION_INPUT_INVALID");
    const markets = [...new Set(context.listings.map(row => row.market))].sort();
    if (canonical(input.prices.map(row => row.market).sort()) !== canonical(markets)
      || (context.currencies.some(currency => currency !== "CNY") !== (input.fx !== null))) throw new Error("INVESTOR_VALUATION_INPUT_INVALID");
    const heads: Record<string, { revision: number; manifest_hash: string }> = {};
    for (const choice of [...input.prices.map(row => ({ ...row, kind: "prices" })), ...(input.fx ? [{ ...input.fx, kind: "fx", market: null }] : [])]) {
      const source = context.sources.find(row => row.scope === choice.scope && row.batch_type === choice.kind && (choice.market === null || row.markets.includes(choice.market)));
      if (!source) throw new Error("INVESTOR_VALUATION_SOURCE_UNAVAILABLE");
      heads[source.scope] = { revision: source.revision, manifest_hash: source.manifest_hash };
    }
    for (const price of input.prices) {
      const zone = { CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" }[price.market];
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(input.cutoff_at));
      const day = ["year", "month", "day"].map(name => parts.find(part => part.type === name)!.value).join("-");
      if (price.expected_session > day) throw new Error("INVESTOR_VALUATION_INPUT_INVALID");
    }
    return enqueueWorkbenchTask(db, actor, { portfolio_id: context.portfolio_id, expected_revision: context.ledger_revision,
      idempotency_key: "investor-valuation:" + hash({ owner: actor.id, idempotency_key }), command_type: "valuation",
      payload: { cutoff_at: input.cutoff_at, mode: "restated", expected_inputs: { ledger_revision: context.ledger_revision, market_heads: heads },
        rules: { schema_version: "valuation-rules-v1", approved: true, approval_evidence: input.source_reference,
          price_scope_by_market: Object.fromEntries(input.prices.map(row => [row.market, row.scope])),
          expected_sessions: Object.fromEntries(input.prices.map(row => [row.market, row.expected_session])),
          corporate_actions_complete: Object.fromEntries(context.listings.map(row => [row.id, true])),
          max_fx_age_seconds: input.fx?.max_age_seconds ?? 0, ...(input.fx ? { fx_scope: input.fx.scope } : {}) } } }, now);
  }).immediate();
}
