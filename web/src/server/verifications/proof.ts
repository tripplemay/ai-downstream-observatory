import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { evidenceInvalid, readVerificationRequest, verificationInstant } from "./binding";
import { checkVerificationArtifact, object, strictEvidenceJson } from "./checker";
import type { VerificationExecutionView } from "./types";

interface ExecutionRow {
  id: string; request_id: string; job_id: string; attempt_id: string; attempt: number; fencing_token: number; context_hash: string;
  artifact_id: string; artifact_sha256: string; result_json: string; result_hash: string; status: string;
  execution_authority: string; data_provenance: string; acceptance_scope: string; started_at: string; finished_at: string; recorded_at: string;
}
interface ArtifactRow { id: string; request_id: string; job_id: string; attempt: number; fencing_token: number; kind: string; body: Buffer; body_sha256: string; created_at: string }
interface JobRow {
  id: string; command_request_id: string; job_type: string; scope: string; period: string; input_version: string; max_attempts: number;
  status: string; result_json: string; attempt_count: number; fencing_token: number; lease_owner: string | null; lease_until: string | null; created_at: string; updated_at: string;
}
interface AttemptRow { id: string; job_id: string; attempt: number; fencing_token: number; status: string; started_at: string; finished_at: string | null; error_json: string | null }

export function verifiedExecution(db: Database.Database, portfolio: string, executionId: string, now: string, currentSourceHash: string | null): { view: VerificationExecutionView; body: Buffer } {
  try {
    const row = db.prepare("SELECT e.* FROM verification_executions e JOIN verification_requests r ON r.id=e.request_id WHERE e.id=? AND r.portfolio_id=?").get(executionId, portfolio) as ExecutionRow | undefined;
    if (!row) throw evidenceInvalid();
    const { row: request, context } = readVerificationRequest(db, portfolio, row.request_id);
    if (row.context_hash !== request.context_hash || !Number.isSafeInteger(row.attempt) || row.attempt < 1 || !Number.isSafeInteger(row.fencing_token) || row.fencing_token < 1
      || row.execution_authority !== "controlled_runner" || row.data_provenance !== "synthetic" || row.acceptance_scope !== "engineering_subcheck") throw evidenceInvalid();
    const job = db.prepare("SELECT * FROM job_runs WHERE id=?").get(row.job_id) as JobRow | undefined;
    const command = db.prepare("SELECT payload_hash FROM command_requests WHERE id=?").get(request.id) as { payload_hash: string };
    const attempt = db.prepare("SELECT * FROM job_attempts WHERE id=?").get(row.attempt_id) as AttemptRow | undefined;
    const artifact = db.prepare("SELECT * FROM verification_artifacts WHERE id=?").get(row.artifact_id) as ArtifactRow | undefined;
    if (!job || !attempt || !artifact || job.command_request_id !== request.id || job.job_type !== "governance_verification_v2" || job.scope !== portfolio
      || job.period !== request.requested_at.slice(0, 10) || job.input_version !== `${request.id}:${command.payload_hash}` || job.max_attempts !== 3
      || job.attempt_count !== row.attempt || job.fencing_token !== row.fencing_token || job.lease_owner !== null || job.lease_until !== null
      || attempt.job_id !== job.id || attempt.attempt !== row.attempt || attempt.fencing_token !== row.fencing_token || !attempt.finished_at || attempt.error_json !== null
      || artifact.request_id !== request.id || artifact.job_id !== job.id || artifact.attempt !== row.attempt || artifact.fencing_token !== row.fencing_token
      || artifact.kind !== "execution" || artifact.body_sha256 !== row.artifact_sha256 || artifact.created_at !== row.recorded_at) throw evidenceInvalid();
    const timestamps = [request.requested_at, job.created_at, attempt.started_at, row.started_at, row.finished_at, row.recorded_at, attempt.finished_at, job.updated_at];
    const normalized = timestamps.map(verificationInstant);
    if (timestamps.some((at, index) => at !== normalized[index]) || normalized.some((at, index) => index > 0 && at < normalized[index - 1])
      || attempt.finished_at !== job.updated_at || job.updated_at > verificationInstant(now)) throw evidenceInvalid();
    const checked = checkVerificationArtifact(artifact.body, row.artifact_sha256), envelope = checked.artifact;
    const binding = { request_id: request.id, job_id: job.id, attempt_id: attempt.id, attempt: row.attempt, fencing_token: row.fencing_token, context_hash: request.context_hash };
    if (canonical(envelope.binding) !== canonical(binding) || envelope.started_at !== row.started_at || envelope.finished_at !== row.finished_at
      || object(envelope.fixture).portfolio_id === portfolio || artifact.body.toString("utf8") !== canonical(envelope)) throw evidenceInvalid();
    const result = checked.result, expectedJobStatus = { pass: "succeeded", fail: "failed", blocked: "skipped" }[result.status];
    if (row.status !== result.status || job.status !== expectedJobStatus || attempt.status !== expectedJobStatus
      || row.result_json !== canonical(result) || row.result_hash !== hash(result)) throw evidenceInvalid();
    const jobResult = { schema_version: "verification-job-result-v2", request_id: request.id, execution_id: row.id, context_hash: request.context_hash, result_hash: row.result_hash, status: result.status };
    if (canonical(strictEvidenceJson(job.result_json)) !== canonical(jobResult)) throw evidenceInvalid();
    const notification = db.prepare("SELECT topic,payload_json,created_at FROM outbox WHERE dedup_key=?").get(`verification:${row.id}`) as { topic: string; payload_json: string; created_at: string } | undefined;
    if (!notification || notification.topic !== "governance_verification.completed" || notification.created_at !== row.recorded_at
      || canonical(strictEvidenceJson(notification.payload_json)) !== canonical(jobResult)) throw evidenceInvalid();
    return { body: artifact.body, view: { id: row.id, status: result.status, artifact_id: row.artifact_id, artifact_sha256: row.artifact_sha256, result_hash: row.result_hash, result,
      started_at: row.started_at, finished_at: row.finished_at, attempt: row.attempt, execution_authority: "controlled_runner", data_provenance: "synthetic", acceptance_scope: "engineering_subcheck",
      current_runtime_match: currentSourceHash === null ? null : currentSourceHash === context.source_manifest_hash } };
  } catch { throw evidenceInvalid(); }
}
