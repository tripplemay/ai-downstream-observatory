import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { z } from "zod";
import common from "../../../contracts/v1/common.schema.json";
import observation from "../../../contracts/v1/market-observation.schema.json";
import batch from "../../../contracts/v1/market-batch.schema.json";
import valuationRules from "../../../contracts/v1/valuation-rules.schema.json";
import performanceCommand from "../../../contracts/v1/performance-command.schema.json";
import flowFxRules from "../../../contracts/v1/flow-fx-rules.schema.json";
import researchCommand from "../../../contracts/v1/research-command.schema.json";
import researchPlan from "../../../contracts/v1/research-plan.schema.json";
import researchDataset from "../../../contracts/v1/research-dataset.schema.json";
import researchParameters from "../../../contracts/v1/research-parameters.schema.json";
import researchRotation from "../../../contracts/v1/research-rotation-parameters.schema.json";
import researchFixedRebalance from "../../../contracts/v1/research-fixed-rebalance-parameters.schema.json";
import { assertWritableDatabase } from "./workbench-db";
import { audit, canonical, hash, revision, type Actor } from "./ledger/service";
import { amount, exact } from "./ledger/decimal";

const id = z.string().trim().min(1).max(200);
const decimal = z.string().max(80).refine(value => {
  try { return amount(value).greaterThan(0); } catch { return false; }
}, "POSITIVE_DECIMAL_REQUIRED");
const envelope = z.object({ portfolio_id: id, expected_revision: z.number().int().nonnegative().safe(), idempotency_key: id });
export const listingCommandSchema = envelope.extend({
  name: z.string().trim().min(1).max(200), market: z.enum(["CN", "HK", "US"]),
  exchange: z.string().trim().min(1).max(40), ticker: z.string().trim().min(1).max(40),
  currency: z.string().regex(/^[A-Z]{3}$/), asset_class: z.string().trim().min(1).max(80),
  quantity_step: decimal.optional(), price_step: decimal.optional(),
  source_evidence: z.string().trim().min(1).max(2000),
}).strict();
export const taskCommandSchema = envelope.extend({
  command_type: z.enum(["valuation", "market_ingest", "performance", "research_register", "research_register_trial", "research_trial", "research_freeze", "research_unseal", "research_ai_context", "research_ai_review"]), payload: z.unknown(),
}).strict();
const valuationPayload = z.object({ cutoff_at: z.string().datetime(), rules: z.unknown(), mode: z.enum(["as_known", "restated"]).optional() }).strict();
const marketPayload = z.object({ document: z.unknown(), publish: z.boolean() }).strict();
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(common);
ajv.addSchema(observation);
const checkBatch = ajv.compile(batch), checkRules = ajv.compile(valuationRules);
ajv.addSchema(flowFxRules);
const checkPerformance = ajv.compile(performanceCommand);
ajv.addSchema(researchParameters);
ajv.addSchema(researchRotation);
ajv.addSchema(researchFixedRebalance);
ajv.addSchema(researchPlan);
ajv.addSchema(researchDataset);
const checkResearch = ajv.compile(researchCommand);

function transact<T>(db: Database.Database, actor: Actor, action: string, input: z.infer<typeof envelope>, body: unknown, now: string, effect: () => T): T {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  assertWritableDatabase(db);
  if (!Number.isFinite(Date.parse(now))) throw new Error("INVALID_CLOCK");
  return db.transaction(() => {
    assertWritableDatabase(db);
    if (!db.prepare("SELECT id FROM portfolios WHERE id=?").get(input.portfolio_id)) throw new Error("PORTFOLIO_NOT_FOUND");
    const scope = `${action}:${input.portfolio_id}`, fingerprint = hash(body);
    const previous = db.prepare("SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?").get(scope, input.idempotency_key) as { payload_hash: string; result_json: string } | undefined;
    if (previous) {
      if (previous.payload_hash !== fingerprint) throw new Error("DUPLICATE_CONFLICT");
      return JSON.parse(previous.result_json) as T;
    }
    if (revision(db, input.portfolio_id) !== input.expected_revision) throw new Error("VERSION_CONFLICT");
    const result = effect();
    db.prepare("INSERT INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)")
      .run(scope, input.idempotency_key, fingerprint, canonical(result), now);
    audit(db, actor, action, "workbench_command", input.idempotency_key, input.portfolio_id, input.expected_revision, { input: body, result }, now);
    assertWritableDatabase(db);
    return result;
  }).immediate();
}

export function registerListing(db: Database.Database, actor: Actor, raw: unknown, now = new Date().toISOString()) {
  const input = listingCommandSchema.parse(raw);
  return transact(db, actor, "register_listing", input, input, now, () => {
    if (db.prepare("SELECT id FROM listings WHERE market=? AND exchange=? AND ticker=?").get(input.market, input.exchange, input.ticker)) throw new Error("LISTING_ALREADY_EXISTS");
    const instrumentId = randomUUID(), listingId = randomUUID();
    db.prepare("INSERT INTO instruments(id,name,asset_class,created_at) VALUES(?,?,?,?)").run(instrumentId, input.name, input.asset_class, now);
    db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,quantity_step,price_step,status,created_at) VALUES(?,?,?,?,?,?,?,?,'unverified',?)")
      .run(listingId, instrumentId, input.market, input.exchange, input.ticker, input.currency, input.quantity_step ? exact(amount(input.quantity_step)) : null, input.price_step ? exact(amount(input.price_step)) : null, now);
    return { instrument_id: instrumentId, listing_id: listingId, status: "unverified" as const };
  });
}

export function enqueueWorkbenchTask(db: Database.Database, actor: Actor, raw: unknown, now = new Date().toISOString()) {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  const input = taskCommandSchema.parse(raw);
  let payload: unknown;
  if (input.command_type === "valuation") {
    const parsed = valuationPayload.parse(input.payload);
    if (!checkRules(parsed.rules)) throw new Error("INVALID_VALUATION_RULES");
    if (Date.parse(parsed.cutoff_at) > Date.parse(now)) throw new Error("FUTURE_VALUATION_NOT_ALLOWED");
    payload = parsed;
  } else if (input.command_type === "performance") {
    if (!checkPerformance(input.payload)) throw new Error("INVALID_PERFORMANCE_COMMAND");
    const parsed = input.payload as { valuation_ids: string[]; evaluation_timezone: string };
    try { new Intl.DateTimeFormat("en-US", { timeZone: parsed.evaluation_timezone }); }
    catch { throw new Error("INVALID_EVALUATION_TIMEZONE"); }
    for (const valuationId of parsed.valuation_ids) {
      if (!db.prepare("SELECT id FROM valuation_runs WHERE id=? AND portfolio_id=?").get(valuationId, input.portfolio_id)) throw new Error("VALUATION_OUT_OF_SCOPE");
    }
    payload = parsed;
  } else if (input.command_type.startsWith("research_")) {
    if (!checkResearch({ command_type: input.command_type, payload: input.payload })) throw new Error("INVALID_RESEARCH_COMMAND");
    const parsed = input.payload as Record<string, unknown>;
    if (input.command_type !== "research_register" && parsed.experiment_id && !db.prepare("SELECT id FROM research_experiments WHERE id=? AND portfolio_id=?").get(parsed.experiment_id, input.portfolio_id)) throw new Error("RESEARCH_OUT_OF_SCOPE");
    if (parsed.trial_id && !db.prepare("SELECT t.id FROM research_trials t JOIN research_experiments e ON e.id=t.experiment_id WHERE t.id=? AND e.portfolio_id=?").get(parsed.trial_id, input.portfolio_id)) throw new Error("RESEARCH_OUT_OF_SCOPE");
    if (parsed.validation_trial_id && !db.prepare("SELECT t.id FROM research_trials t JOIN research_experiments e ON e.id=t.experiment_id WHERE t.id=? AND t.experiment_id=? AND e.portfolio_id=?").get(parsed.validation_trial_id, parsed.experiment_id, input.portfolio_id)) throw new Error("RESEARCH_OUT_OF_SCOPE");
    if (parsed.run_id && !db.prepare("SELECT id FROM research_runs WHERE id=? AND portfolio_id=?").get(parsed.run_id, input.portfolio_id)) throw new Error("RESEARCH_OUT_OF_SCOPE");
    payload = parsed;
  } else {
    const parsed = marketPayload.parse(input.payload);
    if (!checkBatch(parsed.document)) throw new Error("INVALID_MARKET_BATCH");
    payload = parsed;
  }
  return transact(db, actor, "enqueue_task", input, { ...input, payload }, now, () => {
    const requestId = randomUUID(), payloadHash = hash(payload);
    db.prepare("INSERT INTO command_requests(id,portfolio_id,command_type,idempotency_key,payload_hash,payload_json,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(requestId, input.portfolio_id, input.command_type, input.idempotency_key, payloadHash, canonical(payload), actor.id, now);
    return { request_id: requestId, command_type: input.command_type, payload_hash: payloadHash, status: "queued" as const };
  });
}
