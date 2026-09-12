import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { canonical, hash } from "../ledger/service";
import { assertWritableDatabase } from "../workbench-db";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(200);
const sourceSchema = z.object({ format_version: z.literal(1), application_ref: id, files: z.record(id, sha) }).strict();
const metricsSchema = z.object({ out_of_sample_observations: z.number().int().nonnegative(), forward_observations: z.number().int().nonnegative(), trades: z.number().int().nonnegative(), max_drawdown: z.string(), net_excess_return: z.string() }).strict();
export const executionManifestSchema = z.object({
  format_version: z.literal(1), gate: z.enum(["G-03", "G-04"]), portfolio_id: id,
  policy_hash: sha, strategy_hash: sha, suite_version: id, tool_version: id, source_manifest_hash: sha,
  environment: z.enum(["actual", "research", "simulation"]), provenance: z.enum(["authoritative", "synthetic", "reconstructed"]),
  started_at: z.string().datetime(), finished_at: z.string().datetime(),
  checks: z.array(z.object({ id, status: z.enum(["pass", "fail", "not_run", "blocked"]), artifact_hash: sha }).strict()).min(1).max(100),
  research_run_id: id.optional(), metrics: metricsSchema.optional(),
}).strict();

interface VerificationRow {
  id: string; portfolio_id: string; job_id: string; gate: string; policy_hash: string; strategy_hash: string;
  source_manifest_hash: string; source_manifest_json: string; execution_manifest_json: string; manifest_hash: string;
  status: string; provenance: string; executed_at: string;
}

function completedJob(db: Database.Database, jobId: string) {
  const row = db.prepare("SELECT j.result_json,c.payload_json,c.portfolio_id FROM job_runs j JOIN command_requests c ON c.id=j.command_request_id WHERE j.id=? AND j.job_type='governance_verification' AND j.status='succeeded' AND c.command_type='governance_verification' AND c.actor_id='system:governance-verifier'").get(jobId) as { result_json: string; payload_json: string; portfolio_id: string } | undefined;
  if (!row) throw new Error("TRUSTED_VERIFICATION_JOB_REQUIRED");
  const result = JSON.parse(row.result_json) as { manifest_hash: string; manifest: unknown; source_manifest: unknown };
  const manifest = executionManifestSchema.parse(result.manifest), source = sourceSchema.parse(result.source_manifest);
  const requested = JSON.parse(row.payload_json) as { gate: string; policy_hash: string; strategy_hash: string; source_manifest_hash: string };
  if (hash(manifest) !== result.manifest_hash || hash(source) !== manifest.source_manifest_hash || manifest.portfolio_id !== row.portfolio_id
    || requested.gate !== manifest.gate || requested.policy_hash !== manifest.policy_hash || requested.strategy_hash !== manifest.strategy_hash || requested.source_manifest_hash !== manifest.source_manifest_hash) throw new Error("VERIFICATION_MANIFEST_MISMATCH");
  if (new Set(manifest.checks.map(check => check.id)).size !== manifest.checks.length || manifest.finished_at < manifest.started_at) throw new Error("INVALID_VERIFICATION_MANIFEST");
  for (const file of ["web/src/server/governance/risk.ts", "web/src/server/ledger/engine.ts", "worker/market/valuation.py"]) if (!source.files[file]) throw new Error("VERIFICATION_SOURCE_MANIFEST_INCOMPLETE");
  return { manifest, source, manifestHash: result.manifest_hash };
}

/** Offline verifier only. No API/Server Action exports this function; input is a completed trusted job ID, never user PASS claims. */
export function registerCompletedVerification(db: Database.Database, jobId: string, now = new Date().toISOString()): string {
  assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db);
    const completed = completedJob(db, jobId), { manifest, source, manifestHash } = completed;
    if (!Number.isFinite(Date.parse(now)) || manifest.finished_at > now) throw new Error("VERIFICATION_TIME_INVALID");
    const previous = db.prepare("SELECT id FROM governance_verification_runs WHERE job_id=?").get(jobId) as { id: string } | undefined;
    if (previous) return previous.id;
    const id = randomUUID();
    db.prepare("INSERT INTO governance_verification_runs(id,portfolio_id,job_id,gate,policy_hash,strategy_hash,suite_version,tool_version,source_manifest_json,source_manifest_hash,execution_manifest_json,manifest_hash,checks_json,metrics_json,research_run_id,provenance,status,executed_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, manifest.portfolio_id, jobId, manifest.gate, manifest.policy_hash, manifest.strategy_hash, manifest.suite_version, manifest.tool_version, canonical(source), manifest.source_manifest_hash, canonical(manifest), manifestHash, canonical(manifest.checks), manifest.metrics ? canonical(manifest.metrics) : null, manifest.research_run_id ?? null, manifest.provenance, manifest.checks.every(check => check.status === "pass") ? "pass" : "blocked", manifest.finished_at, now);
    assertWritableDatabase(db);
    return id;
  }).immediate();
}

export function verifyRegisteredEvidence(db: Database.Database, portfolio: string, gate: "G-03" | "G-04", ids: string[], policyHash: string, strategyHash: string, requiredChecks: string[], releaseHash: string | undefined, now: string) {
  if (!releaseHash || !/^[a-f0-9]{64}$/.test(releaseHash)) throw new Error("RUNTIME_RELEASE_MANIFEST_REQUIRED");
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("TRUSTED_VERIFICATION_REQUIRED");
  const seen = new Set<string>(), metrics: z.infer<typeof metricsSchema>[] = [];
  for (const id of ids) {
    const row = db.prepare("SELECT * FROM governance_verification_runs WHERE id=? AND portfolio_id=? AND gate=?").get(id, portfolio, gate) as VerificationRow | undefined;
    if (!row || row.policy_hash !== policyHash || row.strategy_hash !== strategyHash || row.source_manifest_hash !== releaseHash) throw new Error("VERIFICATION_VERSION_MISMATCH");
    const result = completedJob(db, row.job_id), manifest = result.manifest;
    if (row.manifest_hash !== result.manifestHash || canonical(manifest) !== row.execution_manifest_json || canonical(result.source) !== row.source_manifest_json) throw new Error("VERIFICATION_MANIFEST_MISMATCH");
    if (row.status !== "pass" || row.provenance !== "authoritative" || manifest.provenance !== "authoritative" || manifest.environment !== "actual" || manifest.finished_at > now || manifest.checks.some(check => check.status !== "pass")) throw new Error("VERIFICATION_NOT_ACTUAL_PASS");
    manifest.checks.forEach(check => seen.add(check.id));
    if (gate === "G-04") {
      const research = db.prepare("SELECT r.result_json FROM research_runs r JOIN policy_versions p ON p.id=r.policy_version_id JOIN strategy_versions s ON s.id=r.strategy_version_id WHERE r.id=? AND r.portfolio_id=? AND r.environment='simulation' AND r.status='succeeded' AND r.completed_at<=? AND p.content_hash=? AND s.content_hash=?").get(manifest.research_run_id ?? "", portfolio, now, policyHash, strategyHash) as { result_json: string } | undefined;
      const result = research ? JSON.parse(research.result_json) : undefined;
      if (!manifest.metrics || !result || result.admission_grade !== "formal_verified" || canonical(result.admission_metrics) !== canonical(manifest.metrics)) throw new Error("FORMAL_STRATEGY_EVIDENCE_REQUIRED");
      metrics.push(manifest.metrics);
    }
  }
  if (requiredChecks.some(check => !seen.has(check))) throw new Error("TRUSTED_VERIFICATION_INCOMPLETE");
  return metrics;
}
