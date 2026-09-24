export const VERIFICATION_CHECK_ID = "E-02.cash-contribution-neutrality.v1" as const;
export const VERIFICATION_SUITE_VERSION = "cash-contribution-neutrality-v1" as const;
export interface VerificationActor { id: string; kind: "human" | "system" }
export interface VerificationOptions { now?: string; sourceRoot?: string }
export interface VerificationSourceManifest { schema_version: "verification-source-v2"; files: Record<string, string> }
export interface VerificationContext {
  schema_version: "verification-context-v2";
  portfolio_id: string;
  check_id: typeof VERIFICATION_CHECK_ID;
  suite_version: typeof VERIFICATION_SUITE_VERSION;
  source_manifest: VerificationSourceManifest;
  source_manifest_hash: string;
}
export interface VerificationCommand {
  portfolio_id: string;
  check_id: typeof VERIFICATION_CHECK_ID;
  expected_context_hash: string;
  reason: string;
  idempotency_key: string;
}
export interface VerificationReceipt {
  request_id: string;
  check_id: typeof VERIFICATION_CHECK_ID;
  context_hash: string;
  status: "queued";
}
export interface VerificationCheckResult {
  schema_version: "verification-check-result-v2";
  check_id: typeof VERIFICATION_CHECK_ID;
  status: "pass" | "fail" | "blocked";
  issues: string[];
  assertions: { id: string; status: "pass" | "fail" | "blocked" }[];
  gate_eligible: false;
  completed_requirements: [];
}
export interface VerificationExecutionView {
  id: string;
  status: VerificationCheckResult["status"];
  artifact_id: string;
  artifact_sha256: string;
  result_hash: string;
  result: VerificationCheckResult;
  started_at: string;
  finished_at: string;
  attempt: number;
  execution_authority: "controlled_runner";
  data_provenance: "synthetic";
  acceptance_scope: "engineering_subcheck";
  current_runtime_match: boolean | null;
}
export interface VerificationRequestView {
  id: string;
  check_id: typeof VERIFICATION_CHECK_ID;
  requested_at: string;
  requested_by: string;
  context_hash: string;
  job_status: string;
  execution: VerificationExecutionView | null;
  evidence_issues: string[];
}
export interface VerificationState {
  portfolios: { id: string; name: string; base_currency: string }[];
  selected_portfolio_id: string | null;
  read_only: boolean;
  check: {
    id: typeof VERIFICATION_CHECK_ID;
    suite_version: typeof VERIFICATION_SUITE_VERSION;
    acceptance_scope: "engineering_subcheck";
    data_provenance: "synthetic";
    gate_eligible: false;
    available: boolean;
    context_hash: string | null;
    issues: string[];
  };
  requests: VerificationRequestView[];
  next_cursor: string | null;
}
export interface VerificationQuery { portfolio?: string; request?: string; cursor?: string; limit?: number }
