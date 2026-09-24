import { createHash } from "node:crypto";
import type { VerificationState } from "../src/server/verifications/types";

export const verificationBinding = "a".repeat(64), verificationOtherBinding = "b".repeat(64);
export const verificationAt = "2026-09-01T00:00:00.000000Z";
export const verificationArtifactBody = '{"synthetic":true,"scope":"engineering_subcheck","not_script":"<script>"}\n';
export const verificationArtifactSha256 = createHash("sha256").update(verificationArtifactBody).digest("hex");
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object"
  ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
export const verificationHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function verificationState(portfolio = "p", withExecution = false): VerificationState {
  const result = { schema_version: "verification-check-result-v2" as const, check_id: "E-02.cash-contribution-neutrality.v1" as const,
    status: "pass" as const, issues: [], assertions: [{ id: "synthetic-assertion", status: "pass" as const }], gate_eligible: false as const, completed_requirements: [] as [] };
  return {
    portfolios: [{ id: "p", name: "SYNTHETIC SCOPE A", base_currency: "CNY" }, { id: "p2", name: "SYNTHETIC SCOPE B", base_currency: "CNY" }], selected_portfolio_id: portfolio, read_only: false,
    check: { id: "E-02.cash-contribution-neutrality.v1", suite_version: "cash-contribution-neutrality-v1", acceptance_scope: "engineering_subcheck", data_provenance: "synthetic",
      gate_eligible: false, available: true, context_hash: portfolio === "p" ? "c".repeat(64) : "d".repeat(64), issues: [] },
    requests: withExecution ? [{ id: "synthetic-request", check_id: "E-02.cash-contribution-neutrality.v1", requested_at: verificationAt, requested_by: "synthetic-owner", context_hash: "c".repeat(64), job_status: "succeeded", evidence_issues: [],
      execution: { id: "synthetic-execution", status: "pass", artifact_id: "synthetic-artifact", artifact_sha256: verificationArtifactSha256, result_hash: verificationHash(result), result,
        started_at: verificationAt, finished_at: verificationAt, attempt: 1, execution_authority: "controlled_runner", data_provenance: "synthetic", acceptance_scope: "engineering_subcheck", current_runtime_match: true } }] : [], next_cursor: null,
  };
}
export function verificationReceipt(body: string, binding = verificationBinding) {
  const command = JSON.parse(body).command;
  return { request_id: "synthetic-request", check_id: command.check_id, context_hash: command.expected_context_hash, status: "queued", session_binding: binding };
}
