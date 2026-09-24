import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession, requireMutationSession } from "@/server/auth/session";
import { assertRequestSessionBinding } from "@/server/auth/session-binding";
import { openWorkbench } from "@/server/workbench-db";
import { createAccount, createPortfolio, recordFact, type LedgerCommand } from "@/server/ledger/service";
import { workbenchState } from "@/server/ledger/queries";
import { confirmImport, getImportPreview, previewJsonImport } from "@/server/ledger/imports";
import { dividendWorkspace } from "@/server/ledger/dividend-queries";
import { AuthError, tokenHash } from "@/server/auth/core";
import { storeJsonAttachment } from "@/server/ledger/attachments";
import { reconcileAccount, type ReconciliationCommand } from "@/server/ledger/reconciliation";
import { enqueueWorkbenchTask, registerListing } from "@/server/workbench-commands";
import { parseStrictJson } from "@/server/strict-json";
import { correctLedger, type CorrectionCommand } from "@/server/ledger/corrections";
import { executeGovernanceCommand } from "@/server/governance-commands";
import { getGovernanceState, isGovernanceClientError } from "@/server/governance/service";
import { getResearchState } from "@/server/research-queries";
import { getFundingState, isFundingClientError } from "@/server/funding/service";
import { executeFundingCommand } from "@/server/funding-commands";
import { isCsvRecoveryClientError, saveCsvConfirmationAttempt } from "@/server/ledger/csv-confirmation-recovery";
import { isReferenceClientError } from "@/server/market-references/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const text = z.string().min(1).max(2000);
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const queryInteger = z.string().regex(/^(0|[1-9]\d*)$/).transform(Number).refine(Number.isSafeInteger);
const query = z.object({ portfolio: text.optional(), batch: text.optional(), view: z.enum(["governance", "research", "funding", "dividends"]).optional(), account: text.optional(), revision: queryInteger.optional(), before: queryInteger.optional() }).strict();
const clientErrors = new Set([
  "INVALID_JSON_VALUE", "INVALID_EFFECTIVE_TIME", "INVALID_SOURCE_TIMEZONE", "INVALID_PORTFOLIO_NAME",
  "INVALID_ACCOUNT", "INVALID_LISTING_CURRENCY", "RELATED_EVENT_NOT_FOUND", "INVALID_COMMAND",
  "CHRONOLOGY_REVIEW_REQUIRED", "INVALID_DECIMAL", "DECIMAL_RANGE", "AMOUNT_MUST_BE_POSITIVE",
  "AMOUNT_MUST_BE_NONNEGATIVE", "INVALID_JSON_IMPORT", "INVALID_IMPORT_ROW_COUNT", "INVALID_IMPORT_ROW",
  "IMPORT_HAS_ERRORS", "INVALID_ACCOUNT_OR_CURRENCY", "LISTING_REQUIRED", "INVALID_RELATED_EVENT",
  "RELATED_ACCOUNT_MISMATCH", "EXCEEDS_OUTSTANDING", "POSITION_HISTORY_REQUIRED", "SETTLEMENT_DIRECTION_REQUIRED",
  "TAX_EXCEEDS_DIVIDEND", "INVALID_FX_CURRENCY", "TRANSFER_TARGET_REQUIRED", "TRANSFER_TARGET_MISMATCH",
  "INVALID_DIVIDEND_QUERY", "DIRECT_DIVIDEND_TAX_REQUIRED", "INVALID_DIVIDEND_TAX_STATUS", "INVALID_DIVIDEND_NET_STATUS",
  "DIVIDEND_LISTING_MISMATCH", "DIVIDEND_BREAKDOWN_REQUIRED", "DIVIDEND_EVIDENCE_REQUIRED", "DIVIDEND_BREAKDOWN_ALREADY_RECORDED",
  "DIVIDEND_BREAKDOWN_MISMATCH", "EXCEEDS_DIVIDEND_GROSS", "INVALID_CORPORATE_ACTION_NOTICE", "INVALID_CORPORATE_ACTION_RESOLUTION",
  "CORPORATE_ACTION_ALREADY_RESOLVED", "INVALID_CORPORATE_ACTION_SUPPORT", "CORPORATE_ACTION_TIME_AMBIGUOUS",
  "CORPORATE_ACTION_RESOLUTION_TOO_EARLY", "CORPORATE_ACTION_LISTING_SUPPORT_REQUIRED",
  "SECURITY_VALUE_EVIDENCE_REQUIRED", "INVALID_SECURITY_VALUE_EVIDENCE", "SECURITY_VALUE_TIME_MISMATCH", "INVALID_SECURITY_TRANSFER", "INVALID_SECURITY_TRANSIT_BALANCE",
  "UNSUPPORTED_EVENT_TYPE", "VALIDATION_FAILED", "OPENING_ALREADY_RECORDED", "OPENING_DATE_MISMATCH", "OPENING_PERIOD_CLOSED",
  "FUTURE_FACT_NOT_ALLOWED", "INVALID_CLOCK",
  "INVALID_VALUATION_RULES", "INVALID_MARKET_BATCH", "INVALID_MARKET_COLLECT", "INVALID_MARKET_PRICE_COLLECT", "RESERVED_MARKET_SOURCE", "FUTURE_VALUATION_NOT_ALLOWED", "LISTING_ALREADY_EXISTS",
  "INVALID_ATTACHMENT_TEXT", "INVALID_ATTACHMENT_UTF8", "INVALID_ACCOUNT_STATEMENT", "INVALID_STATEMENT_JSON",
  "INVALID_RECONCILIATION_COMMAND", "INVALID_RECONCILIATION_RESOLUTION", "HISTORICAL_RECONCILIATION_UNSUPPORTED",
  "FUTURE_STATEMENT_NOT_ALLOWED", "RESOLUTION_REQUIRES_MATCHED_STATEMENT", "RESOLUTION_CUTOFF_TOO_EARLY",
  "INVALID_PERFORMANCE_COMMAND", "INVALID_EVALUATION_TIMEZONE",
  "INVALID_RESEARCH_COMMAND",
  "INVALID_CORRECTION_COMMAND", "CORRECTION_DUPLICATE_TARGET", "CORRECTION_EVENT_NOT_ACTIVE",
  "CORRECTION_IDENTITY_CHANGE_UNSUPPORTED", "CORRECTION_MIXED_TIME_PRECISION_UNSUPPORTED",
  "CORRECTION_CROSS_TIMEZONE_DATE_UNSUPPORTED", "CORRECTION_INVALID_ORDER_ANCHOR", "CORRECTION_ORDER_ANCHOR_REQUIRED",
  "CORRECTION_REPLAY_LIMIT", "CORRECTION_DEPENDENCY_MISSING_OR_LATER", "CORRECTION_SOURCE_ALREADY_RECORDED",
  "INVALID_LEDGER_REVISION", "REVISION_NOT_PUBLISHED", "INVALID_RECORD_CONTEXT",
]);

async function readBody(request: Request): Promise<{ raw: string; exact: string }> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) {
    throw new AuthError("REQUEST_TOO_LARGE", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError("INVALID_JSON", 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new AuthError("REQUEST_TOO_LARGE", 413);
    }
    chunks.push(value);
  }
  try {
    const bytes = Buffer.concat(chunks);
    return { raw: new TextDecoder("utf-8", { fatal: true }).decode(bytes), exact: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  }
  catch { throw new AuthError("INVALID_UTF8", 400); }
}
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_portfolio"), name: z.string().min(1).max(120) }).strict(),
  z.object({ action: z.literal("create_account"), portfolio_id: text, name: z.string().min(1).max(120), broker: z.string().min(1).max(120), currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
  z.object({ action: z.literal("record_fact"), command: z.unknown() }).strict(),
  z.object({ action: z.literal("preview_import"), portfolio_id: text, account_id: text, raw: z.string().min(1).max(4 * 1024 * 1024) }).strict(),
  z.object({ action: z.literal("confirm_import"), portfolio_id: text, batch_id: text, preview_hash: text, expected_revision: z.number().int().nonnegative(), csv_review: z.unknown().optional() }).strict(),
  z.object({ action: z.literal("store_attachment"), portfolio_id: text, account_id: text, raw: z.string().min(1).max(4 * 1024 * 1024) }).strict(),
  z.object({ action: z.literal("reconcile_account"), command: z.object({
    portfolio_id: text, account_id: text, attachment_id: text, expected_revision: z.number().int().nonnegative().safe(),
    resolves_issue_ids: z.array(text).max(1000).optional(), resolution_reason: text.optional(),
  }).strict() }).strict(),
  z.object({ action: z.literal("register_listing"), command: z.unknown() }).strict(),
  z.object({ action: z.literal("enqueue_task"), command: z.unknown() }).strict(),
  z.object({ action: z.literal("correct_ledger"), command: z.unknown() }).strict(),
  z.object({ action: z.literal("governance"), command: z.unknown() }).strict(),
  z.object({ action: z.literal("funding"), command: z.unknown() }).strict(),
]);

function failure(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "REQUEST_FAILED";
  if (error instanceof AuthError) return NextResponse.json({ error: error.code }, {
    status: error.status, headers: error.status === 413 ? { Connection: "close" } : undefined,
  });
  if (["VERSION_CONFLICT", "DUPLICATE_CONFLICT", "SOURCE_DUPLICATE_CONFLICT", "PREVIEW_HASH_MISMATCH", "CSV_MAPPING_VERSION_CONFLICT", "CSV_FILE_ALREADY_CONFIRMED", "CSV_BACKGROUND_CONFIRM_REQUIRED", "CSV_IMPORT_METHOD_CHANGED", "CSV_IMPORT_CONTEXT_CHANGED", "CSV_REVIEW_HASH_MISMATCH", "CSV_REVIEW_CONFLICT", "CSV_SOURCE_LINK_CONFLICT"].includes(message)) return NextResponse.json({ error: message }, { status: 409 });
  if (["CSV_REVIEW_INVALID", "CSV_REVIEW_ROWS_MISMATCH", "CSV_REVIEW_ROW_INVALID", "CSV_REVIEW_LINK_NOT_EXACT", "CSV_REVIEW_CANDIDATE_LIMIT", "CSV_REVIEW_NOT_APPLICABLE", "CSV_ROW_REQUIRES_LINK"].includes(message)) return NextResponse.json({ error: message }, { status: 400 });
  if (message === "CSV_REVIEW_SCOPE_MISMATCH") return NextResponse.json({ error: message }, { status: 403 });
  if (["ACCOUNT_OUT_OF_SCOPE", "IMPORT_BATCH_OUT_OF_SCOPE", "ATTACHMENT_OUT_OF_SCOPE", "VALUATION_OUT_OF_SCOPE", "STATEMENT_OUT_OF_SCOPE", "RECONCILIATION_ISSUE_OUT_OF_SCOPE", "RESEARCH_OUT_OF_SCOPE", "UNAUTHENTICATED"].includes(message)) return NextResponse.json({ error: message }, { status: message === "UNAUTHENTICATED" ? 401 : 403 });
  if (["PORTFOLIO_NOT_FOUND", "IMPORT_NOT_FOUND", "ATTACHMENT_NOT_FOUND"].includes(message)) return NextResponse.json({ error: message }, { status: 404 });
  if (message === "WORKBENCH_READ_ONLY") return NextResponse.json({ error: message }, { status: 423 });
  if (isReferenceClientError(message)) return NextResponse.json({ error: message }, {
    status: message.endsWith("_CONFLICT") ? 409 : message.endsWith("_OUT_OF_SCOPE") || message.endsWith("_PERMISSION_DENIED") ? 403 : message.endsWith("_NOT_FOUND") ? 404 : message.endsWith("_TOO_LARGE") ? 413 : 400,
  });
  if (["IMPORT_TOO_LARGE", "ATTACHMENT_TOO_LARGE"].includes(message)) return NextResponse.json({ error: message }, { status: 413 });
  if (isCsvRecoveryClientError(message)) return NextResponse.json({ error: message }, {
    status: message === "CSV_RECOVERY_NOT_FOUND" ? 404 : message.endsWith("_TOO_LARGE") || message === "CSV_RECOVERY_BUDGET_EXCEEDED" ? 413 : 400,
  });
  if (isFundingClientError(message)) return NextResponse.json({ error: message }, {
    status: message === "FUNDING_PERMISSION_DENIED" || message.endsWith("_OUT_OF_SCOPE") ? 403 : message.endsWith("_CONFLICT") ? 409 : 400,
  });
  if (isGovernanceClientError(message)) return NextResponse.json({ error: message }, {
    status: message === "GOVERNANCE_PERMISSION_DENIED" || message.endsWith("_OUT_OF_SCOPE") ? 403 : 400,
  });
  if (error instanceof z.ZodError) return NextResponse.json({ error: "VALIDATION_FAILED", fields: error.issues.map(i => i.path.join(".")) }, { status: 400 });
  const code = message.split(":", 1)[0];
  if (clientErrors.has(code)) return NextResponse.json({ error: code }, { status: 400 });
  // Native storage errors can include paths or source SQL; keep those server-side.
  console.error("Workbench request failed", error instanceof Error ? error.name : "UnknownError");
  return NextResponse.json({ error: "WORKBENCH_UNAVAILABLE" }, { status: 503 });
}

export async function GET(request: Request) {
  try {
    const session = await requireApiSession(), actor = { id: session.userId };
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) return NextResponse.json({ error: "INVALID_QUERY" }, { status: 400 });
    const { portfolio, batch, view, account, revision: expectedRevision, before } = query.parse(Object.fromEntries(url.searchParams));
    if ((batch || view) && !portfolio) return NextResponse.json({ error: "PORTFOLIO_REQUIRED" }, { status: 400 });
    if (batch && view) return NextResponse.json({ error: "INVALID_QUERY" }, { status: 400 });
    if (view === "dividends" ? !account || expectedRevision === undefined || (before !== undefined && before < 1) : account !== undefined || expectedRevision !== undefined || before !== undefined) return NextResponse.json({ error: "INVALID_QUERY" }, { status: 400 });
    const db = openWorkbench();
    try {
      const result = view === "governance" && portfolio
        ? getGovernanceState(db, { ...actor, kind: "human" }, portfolio)
        : view === "research" && portfolio ? getResearchState(db, actor, portfolio)
        : view === "funding" && portfolio ? getFundingState(db, { ...actor, kind: "human" }, portfolio)
        : view === "dividends" && portfolio ? dividendWorkspace(db, actor, portfolio, account!, expectedRevision!, before)
        : batch && portfolio ? getImportPreview(db, actor, portfolio, batch) : workbenchState(db, actor, portfolio);
      return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requireMutationSession(), actor = { id: session.userId };
    assertRequestSessionBinding(request, session.sessionId);
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return NextResponse.json({ error: "JSON_REQUIRED" }, { status: 415 });
    const { raw, exact } = await readBody(request);
    let parsed: unknown;
    try { parsed = parseStrictJson(raw); } catch { return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 }); }
    const input = command.parse(parsed), db = openWorkbench();
    try {
      let result: unknown;
      switch (input.action) {
        case "create_portfolio": result = { id: createPortfolio(db, actor, input.name) }; break;
        case "create_account": result = { id: createAccount(db, actor, input.portfolio_id, input.name, input.broker, input.currency) }; break;
        case "record_fact": result = recordFact(db, actor, input.command as LedgerCommand); break;
        case "preview_import": result = previewJsonImport(db, actor, input.portfolio_id, input.account_id, input.raw); break;
        case "confirm_import": {
          const batch = db.prepare("SELECT parser_version FROM import_batches WHERE id=? AND portfolio_id=?").get(input.batch_id, input.portfolio_id) as { parser_version: string } | undefined;
          if (batch?.parser_version === "csv-v1") {
            const before = await requireMutationSession();
            if (before.sessionId !== session.sessionId) throw new AuthError("UNAUTHENTICATED", 401);
            saveCsvConfirmationAttempt(db, { actorId: session.userId, sessionHash: tokenHash(session.sessionId) }, exact);
            const after = await requireMutationSession();
            if (after.sessionId !== session.sessionId) throw new AuthError("UNAUTHENTICATED", 401);
          }
          result = confirmImport(db, actor, input.portfolio_id, input.batch_id, input.preview_hash, input.expected_revision, undefined, {}, input.csv_review); break;
        }
        case "store_attachment": result = storeJsonAttachment(db, actor, input); break;
        case "reconcile_account": result = reconcileAccount(db, actor, input.command as ReconciliationCommand); break;
        case "register_listing": result = registerListing(db, actor, input.command); break;
        case "enqueue_task": result = enqueueWorkbenchTask(db, actor, input.command); break;
        case "correct_ledger": result = correctLedger(db, actor, input.command as CorrectionCommand); break;
        case "governance": result = executeGovernanceCommand(db, { ...actor, kind: "human" }, input.command); break;
        case "funding": result = executeFundingCommand(db, { ...actor, kind: "human" }, input.command); break;
      }
      return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } finally { db.close(); }
  } catch (error) { return failure(error); }
}
