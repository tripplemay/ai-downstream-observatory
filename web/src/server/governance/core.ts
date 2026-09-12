import type Database from "better-sqlite3";
import type { z } from "zod";
import { assertWritableDatabase } from "../workbench-db";
import { audit, canonical, hash, revision } from "../ledger/service";
import { readJsonAttachment, type AttachmentOptions } from "../ledger/attachments";
import { parseStrictJson } from "../strict-json";
import { amount } from "../ledger/decimal";
import { verifyRegisteredEvidence } from "./verification";
import { commandEnvelope, evidenceSchema, policySchema, strategySchema, type Policy, type Strategy } from "./schemas";

export interface GovernanceActor { id: string; kind: "human" | "strategy" | "ai" }
export type GovernanceOptions = AttachmentOptions & { releaseHash?: string };
export type Envelope = z.infer<typeof commandEnvelope>;
export function requireActor(actor: GovernanceActor, human = false): void {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  if (actor.kind === "ai" || !["human", "strategy"].includes(actor.kind) || (human && actor.kind !== "human")) throw new Error("GOVERNANCE_PERMISSION_DENIED");
}
export function clock(options: GovernanceOptions): string {
  const value = new Date(options.now ?? Date.now());
  if (!Number.isFinite(value.getTime())) throw new Error("INVALID_CLOCK");
  return value.toISOString();
}
export function transaction<T>(db: Database.Database, actor: GovernanceActor, action: string, input: Envelope, body: unknown, options: GovernanceOptions, effect: (now: string) => T, human = true): T {
  requireActor(actor, human); assertWritableDatabase(db);
  const now = clock(options);
  const semantic = { ...(body as Record<string, unknown>) }; delete semantic.expected_revision; delete semantic.idempotency_key;
  const digest = hash(semantic), scope = `governance:${action}:${input.portfolio_id}`;
  return db.transaction(() => {
    assertWritableDatabase(db);
    const current = revision(db, input.portfolio_id);
    const previous = db.prepare("SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?").get(scope, input.idempotency_key) as { payload_hash: string; result_json: string } | undefined;
    if (previous) { if (previous.payload_hash !== digest) throw new Error("DUPLICATE_CONFLICT"); assertWritableDatabase(db); return JSON.parse(previous.result_json) as T; }
    if (current !== input.expected_revision) throw new Error("VERSION_CONFLICT");
    const result = effect(now);
    audit(db, actor, action, "governance", input.idempotency_key, input.portfolio_id, revision(db, input.portfolio_id), { input: body, result }, now);
    db.prepare("INSERT INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(scope, input.idempotency_key, digest, canonical(result), now);
    assertWritableDatabase(db);
    return result;
  }).immediate();
}
export interface Version<T> { id: string; portfolio_id: string; content_hash: string; value: T }
export function versions(db: Database.Database, portfolio: string, policyId: string, strategyId: string): { policy: Version<Policy>; strategy: Version<Strategy> } {
  const policy = db.prepare("SELECT * FROM policy_versions WHERE id=? AND portfolio_id=?").get(policyId, portfolio) as { id: string; portfolio_id: string; content_hash: string; policy_json: string } | undefined;
  const strategy = db.prepare("SELECT * FROM strategy_versions WHERE id=? AND portfolio_id=?").get(strategyId, portfolio) as { id: string; portfolio_id: string; content_hash: string; parameters_json: string } | undefined;
  if (!policy || !strategy) throw new Error("GOVERNANCE_VERSION_OUT_OF_SCOPE");
  const policyValue = policySchema.parse(JSON.parse(policy.policy_json)), strategyValue = strategySchema.parse(JSON.parse(strategy.parameters_json));
  if (hash(policyValue) !== policy.content_hash || hash(strategyValue) !== strategy.content_hash) throw new Error("GOVERNANCE_VERSION_HASH_MISMATCH");
  return { policy: { ...policy, value: policyValue }, strategy: { ...strategy, value: strategyValue } };
}
export interface ActivationRow { id: string; portfolio_id: string; policy_version_id: string; strategy_version_id: string; valid_from: string; valid_to: string | null; evidence_json: string }
export function activation(db: Database.Database, portfolio: string, id: string, now: string) {
  const row = db.prepare("SELECT * FROM activations WHERE id=? AND portfolio_id=? AND mode='live_advice'").get(id, portfolio) as ActivationRow | undefined;
  if (!row || row.valid_from > now || (row.valid_to !== null && row.valid_to <= now)) throw new Error("NO_ACTIVE_GOVERNANCE");
  const current = db.prepare("SELECT id FROM activations WHERE portfolio_id=? AND mode='live_advice' AND valid_from<=? AND (valid_to IS NULL OR valid_to>?) ORDER BY valid_from DESC LIMIT 1").get(portfolio, now, now) as { id: string } | undefined;
  if (current?.id !== row.id) throw new Error("GOVERNANCE_VERSION_CHANGED");
  const value = versions(db, portfolio, row.policy_version_id, row.strategy_version_id);
  if (value.policy.value.review_after <= now) throw new Error("POLICY_REVIEW_OVERDUE");
  return { row, ...value };
}
export function verifyGateEvidence(db: Database.Database, actor: GovernanceActor, portfolio: string, references: Record<"G-01" | "G-03" | "G-04", string>, policy: Version<Policy>, strategy: Version<Strategy>, options: GovernanceOptions, now: string): void {
  const checks = { "G-01": ["D-01", "D-02", "D-03", "D-05"], "G-03": Array.from({ length: 32 }, (_, index) => `E-${String(index + 1).padStart(2, "0")}`), "G-04": Array.from({ length: 10 }, (_, index) => `S-${String(index + 1).padStart(2, "0")}`) };
  for (const gate of ["G-01", "G-03", "G-04"] as const) {
    const original = readJsonAttachment(db, actor, portfolio, references[gate], options);
    const parsed = evidenceSchema.safeParse(parseStrictJson(original.bytes.toString("utf8")));
    if (!parsed.success) throw new Error("INVALID_GATE_EVIDENCE");
    const evidence = parsed.data;
    if (evidence.gate !== gate || evidence.portfolio_id !== portfolio || evidence.policy_hash !== policy.content_hash || evidence.strategy_hash !== strategy.content_hash) throw new Error("GATE_EVIDENCE_OUT_OF_SCOPE");
    if (evidence.reviewed_at > now || evidence.valid_until <= now || evidence.valid_until <= evidence.reviewed_at) throw new Error("GATE_EVIDENCE_EXPIRED");
    if (new Set(evidence.checks.map(check => check.id)).size !== evidence.checks.length || checks[gate].some(required => !evidence.checks.some(check => check.id === required))) throw new Error("GATE_CHECKS_INCOMPLETE");
    const verifiedMetrics = gate === "G-01" ? [] : verifyRegisteredEvidence(db, portfolio, gate, evidence.verification_ids ?? [], policy.content_hash, strategy.content_hash, checks[gate], options.releaseHash ?? process.env.WORKBENCH_RELEASE_SHA256, now);
    if (gate === "G-04") {
      const run = db.prepare("SELECT id FROM research_runs WHERE id=? AND portfolio_id=? AND strategy_version_id=? AND policy_version_id=? AND environment='simulation' AND status='succeeded' AND completed_at<=?").get(evidence.research_run_id ?? "", portfolio, strategy.id, policy.id, now);
      if (!run || !evidence.metrics) throw new Error("STRATEGY_EVIDENCE_NOT_READY");
      const limits = strategy.value.admission_thresholds;
      if (!verifiedMetrics.length || canonical(evidence.metrics) !== canonical(verifiedMetrics[0])) throw new Error("STRATEGY_EVIDENCE_METRICS_MISMATCH");
      for (const metrics of verifiedMetrics) if (metrics.out_of_sample_observations < limits.min_out_of_sample_observations || metrics.forward_observations < limits.min_forward_observations || metrics.trades < limits.min_trades || amount(metrics.max_drawdown).gt(limits.max_drawdown) || amount(metrics.net_excess_return).lt(limits.min_net_excess_return)) throw new Error("STRATEGY_ADMISSION_THRESHOLDS_FAILED");
    }
  }
}
