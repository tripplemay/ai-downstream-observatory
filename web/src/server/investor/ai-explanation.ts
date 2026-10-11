import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { assertWritableDatabase, openWorkbench } from "../workbench-db";
import { hash } from "../ledger/service";
import { prepareInvestorAiExplanation } from "./ai-explanation-context";
import { aiExplanationImplementationHash, readAiExplanationSettings, requestAiMonitorReview, aiTransportResultSchema } from "./ai-explanation-process";
import { aiExplanationStatusSchema, validateAiMonitorReview, type AiExplanationStatus } from "./ai-explanation-schemas";
import { AiExplanationMemory } from "./ai-explanation-memory";
import { registerDurableAiRequest, claimDurableAiRequest, finishDurableAiRequest, readDurableAiStatus, purgeDurableAiScope, type AiRequestBinding } from "./ai-explanation-store";
import { startAiRetention } from "./ai-explanation-retention";

type Transport = typeof requestAiMonitorReview;
export type AiExplanationOptions = { config_file?: string; consent_file?: string; clock?: () => string; signal?: AbortSignal; transport?: Transport;
  assert_session?: () => Promise<void>; assert_runtime?: () => void };
type Options = AiExplanationOptions;
type CacheEntry = { status: AiExplanationStatus; workspace: string; abort: AbortController };
type Runtime = { cache: AiExplanationMemory<CacheEntry>; active: Map<string, CacheEntry> };
const runtime = globalThis as typeof globalThis & { __etfAiExplanationRuntime?: Runtime };
// Memory cancels local work; SQLite, not this map, decides de-duplication and publication.
const { cache, active } = runtime.__etfAiExplanationRuntime ??= {
  cache: new AiExplanationMemory<CacheEntry>(entry => { entry.status.review = null; entry.abort.abort(); }),
  active: new Map<string, CacheEntry>(),
};
const safeErrors = new Set(["INVESTOR_AI_NO_CURRENT_OBSERVATION", "INVESTOR_AI_NO_QUALIFIED_MONITOR", "INVESTOR_AI_SOURCE_SHARING_NOT_APPROVED",
  "INVESTOR_AI_CONFIG_UNAVAILABLE", "INVESTOR_AI_CONSENT_NOT_CURRENT", "INVESTOR_AI_IMPLEMENTATION_UNAVAILABLE", "INVESTOR_AI_EVIDENCE_INVALID",
  "INVESTOR_AI_ABORTED", "INVESTOR_AI_TIMEOUT", "INVESTOR_AI_RUNTIME_UNAVAILABLE", "INVESTOR_AI_OUTPUT_INVALID", "INVESTOR_AI_FAILED", "INVESTOR_AI_BINDING_CHANGED",
  "AI_GATEWAY_AUTHENTICATION_FAILED", "AI_GATEWAY_PERMISSION_DENIED", "AI_GATEWAY_RATE_LIMITED", "AI_GATEWAY_TIMEOUT", "AI_GATEWAY_CALL_TIMEOUT", "AI_GATEWAY_HTTP_FAILED",
  "AI_GATEWAY_RESPONSE_TRUNCATED", "AI_GATEWAY_RESPONSE_TOOL_REQUESTED", "AI_GATEWAY_RESPONSE_REFUSED", "AI_GATEWAY_OUTPUT_INVALID", "AI_GATEWAY_CONFIG_INVALID", "AI_GATEWAY_REQUEST_INVALID"]);
function code(error: unknown) { return error instanceof Error && safeErrors.has(error.message) ? error.message : "INVESTOR_AI_EVIDENCE_INVALID"; }
function empty(reason: string): AiExplanationStatus {
  return { schema_version: "investor-ai-explanation-v1", status: "blocked", reason_code: reason, observation_id: null, binding_hash: null,
    valid_until: null, review: null, narrative_verified: false, live_advice_eligible: false };
}
function clock(options: Options) { return options.clock?.() ?? new Date().toISOString(); }
function scope(db: Database.Database, actor: { id: string }) { return hash({ database: db.name, principal: actor.id }); }
function prepare(db: Database.Database, actor: { id: string }, options: Options) {
  const now = clock(options), input = prepareInvestorAiExplanation(db, actor, now);
  const settings = readAiExplanationSettings(options.config_file ?? process.env.WORKBENCH_AI_CONFIG_FILE ?? "",
    options.consent_file ?? process.env.WORKBENCH_AI_CONSENT_FILE ?? "", actor, now);
  const validUntil = Date.parse(input.valid_until) < Date.parse(settings.valid_until) ? input.valid_until : settings.valid_until;
  const implementation = aiExplanationImplementationHash();
  const key = hash({ binding: input.binding_hash, context: input.context_hash, config: settings.config_hash, consent: settings.consent_hash,
    implementation, valid_until: validUntil });
  const durable: AiRequestBinding = { workspace_id: input.workspace_id, actor_id: actor.id, observation_id: input.observation_id,
    binding_hash: key, source_binding_hash: input.binding_hash, context_hash: input.context_hash, config_hash: settings.config_hash,
    consent_hash: settings.consent_hash, implementation_hash: implementation, valid_until: validUntil };
  return { input, settings, key, validUntil, durable };
}
function available(value: ReturnType<typeof prepare>): AiExplanationStatus {
  return { schema_version: "investor-ai-explanation-v1", status: "available", reason_code: null, observation_id: value.input.observation_id,
    binding_hash: value.key, valid_until: value.validUntil, review: null, narrative_verified: false, live_advice_eligible: false };
}
/** Explicit local maintenance; payload deletion retains request/outcome tombstones. */
export function maintainInvestorAiExplanations(db: Database.Database, actor: { id: string }, options: Options = {}) {
  assertWritableDatabase(db); const localScope = scope(db, actor);
  if (!db.prepare(`SELECT 1 FROM investor_ai_requests r LEFT JOIN investor_ai_purges p ON p.request_id=r.id
    WHERE r.actor_id=? AND p.request_id IS NULL LIMIT 1`).get(actor.id)) {
    cache.clearScope(localScope);
    return 0;
  }
  let currentKey: string | null = null;
  try { currentKey = prepare(db, actor, options).key; } catch { /* No current authorization means no retained explanation text. */ }
  cache.clearScope(localScope, currentKey ?? undefined);
  return purgeDurableAiScope(db, actor, clock(options), currentKey);
}
function maintenance(db: Database.Database, actor: { id: string }, options: Options) {
  if (!(db.prepare("SELECT 1 FROM investor_ai_requests WHERE actor_id=? LIMIT 1").get(actor.id))) return;
  const filename = db.name, principal = actor.id;
  // Never retain request signals, custom transports or derived evidence in a timer closure.
  const localOptions = { config_file: options.config_file, consent_file: options.consent_file, clock: options.clock };
  startAiRetention(scope(db, actor), () => {
    if (!existsSync(filename)) return false;
    const connection = openWorkbench(filename);
    try { maintainInvestorAiExplanations(connection, { id: principal }, localOptions); } finally { connection.close(); }
    return true;
  });
}
/** GET only verifies and reads local state/cache. It never calls an external service. */
export function readInvestorAiExplanation(db: Database.Database, actor: { id: string }, options: Options = {}): AiExplanationStatus {
  const localScope = scope(db, actor);
  try {
    maintenance(db, actor, options);
    return db.transaction(() => {
      const value = prepare(db, actor, options);
      cache.clearScope(localScope, value.key);
      const stored = readDurableAiStatus(db, value.durable, value.input.context, clock(options));
      return aiExplanationStatusSchema.parse(stored ? { ...available(value), ...stored } : available(value));
    }).deferred();
  } catch (error) {
    cache.clearScope(localScope);
    if (error instanceof Error && error.message === "UNAUTHENTICATED") throw error;
    return empty(code(error));
  }
}
/** Authenticated intent survives the HTTP connection; only the fixed worker sends it. */
export async function enqueueInvestorAiExplanation(db: Database.Database, actor: { id: string },
  request: { observation_id: string; binding_hash: string }, options: Options = {}): Promise<AiExplanationStatus> {
  assertWritableDatabase(db);
  await options.assert_session?.();
  if (options.signal?.aborted) throw new Error("INVESTOR_AI_ABORTED");
  db.transaction(() => {
    const value = prepare(db, actor, options);
    if (request.observation_id !== value.input.observation_id || request.binding_hash !== value.key) throw new Error("INVESTOR_AI_BINDING_CHANGED");
    registerDurableAiRequest(db, value.durable, clock(options));
  }).immediate();
  return readInvestorAiExplanation(db, actor, options);
}
/** Explicit, bounded on-demand call. Rebuild consent/source bindings before publication. */
export async function explainInvestorObservation(db: Database.Database, actor: { id: string },
  request: { observation_id: string; binding_hash: string }, options: Options = {}): Promise<AiExplanationStatus> {
  assertWritableDatabase(db);
  if (options.signal?.aborted) throw new Error("INVESTOR_AI_ABORTED");
  const localScope = scope(db, actor);
  let before: ReturnType<typeof prepare>;
  try { before = prepare(db, actor, options); cache.clearScope(localScope, before.key); }
  catch (error) { cache.clearScope(localScope); throw error; }
  if (request.observation_id !== before.input.observation_id || request.binding_hash !== before.key) throw new Error("INVESTOR_AI_BINDING_CHANGED");
  const old = readDurableAiStatus(db, before.durable, before.input.context, clock(options));
  if (old && old.status !== "queued") return readInvestorAiExplanation(db, actor, options);
  if (cache.size >= 64 || active.size >= 2 || [...active.values()].some(row => row.workspace === before.input.workspace_id)) throw new Error("INVESTOR_AI_BUSY");
  const entry: CacheEntry = { status: { ...available(before), status: "running" }, workspace: before.input.workspace_id, abort: new AbortController() };
  const signal = options.signal ? AbortSignal.any([options.signal, entry.abort.signal]) : entry.abort.signal;
  let claim: { id: string; token: string } | null = null;
  try {
    await options.assert_session?.();
    options.assert_runtime?.();
    if (signal.aborted) throw new Error("INVESTOR_AI_BINDING_CHANGED");
    claim = db.transaction(() => {
      if (prepare(db, actor, options).key !== before.key) throw new Error("INVESTOR_AI_BINDING_CHANGED");
      return claimDurableAiRequest(db, before.durable, clock(options));
    }).immediate();
    if (!claim) return readInvestorAiExplanation(db, actor, options);
    cache.set(before.key, entry, localScope, Date.parse(before.validUntil) - Date.parse(clock(options)));
    active.set(before.key, entry); maintenance(db, actor, options);
    const result = aiTransportResultSchema.parse(await (options.transport ?? requestAiMonitorReview)(before.input.context, before.settings, signal));
    await options.assert_session?.();
    options.assert_runtime?.();
    if (signal.aborted || cache.get(before.key) !== entry || prepare(db, actor, options).key !== before.key) throw new Error("INVESTOR_AI_BINDING_CHANGED");
    validateAiMonitorReview(result.review, before.input.context);
    if (result.context_hash !== before.input.context_hash || result.review_hash !== hash(result.review)) throw new Error("INVESTOR_AI_OUTPUT_INVALID");
    const outcome = db.transaction(() => {
      if (signal.aborted || prepare(db, actor, options).key !== before.key) throw new Error("INVESTOR_AI_BINDING_CHANGED");
      return finishDurableAiRequest(db, before.durable, claim!, before.input.context, clock(options), result.review, null);
    }).immediate();
    entry.status = outcome === "complete" ? { ...available(before), status: "complete", review: result.review }
      : { ...available(before), status: "failed", reason_code: "INVESTOR_AI_OUTCOME_UNKNOWN" };
  } catch (error) {
    entry.status = { ...available(before), status: "failed", reason_code: code(error) };
    if (claim) {
      try { finishDurableAiRequest(db, before.durable, claim, before.input.context, clock(options), null, code(error)); }
      catch { /* Lost fence, recovery lock or uncertain commit must never trigger a retry. */ }
    } else throw error;
    // Lost authorization or stale evidence never expose the old model's explanation.
    const current = readInvestorAiExplanation(db, actor, options);
    if (current.binding_hash !== before.key) return current;
    if (cache.get(before.key) !== entry) return current;
  } finally {
    if (active.get(before.key) === entry) active.delete(before.key);
  }
  return readInvestorAiExplanation(db, actor, options);
}
