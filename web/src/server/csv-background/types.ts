export type CsvBackgroundOperation = "preview" | "confirm";
export interface CsvBackgroundPrincipal { actorId: string; sessionHash: string }
export interface CsvBackgroundOptions { now?: string; dataDir?: string }
export interface CsvBackgroundPreviewInput {
  portfolio_id: string; account_id: string; expected_revision: number; idempotency_key: string;
  filename: string; mapping: string; bytes: Uint8Array; acknowledge_background_execution: true;
}
export interface CsvBackgroundConfirmationInput {
  portfolio_id: string; account_id: string; idempotency_key: string; payload_text: string; acknowledge_background_execution: true;
}
export interface CsvBackgroundCancelInput { portfolio_id: string; request_id: string; reason: string }
export interface CsvBackgroundReceipt { request_id: string; operation: CsvBackgroundOperation; input_hash: string; status: "queued" }
export interface CsvBackgroundCancelReceipt { request_id: string; status: "cancelled" }
export interface CsvBackgroundRequestRow {
  id: string; portfolio_id: string; account_id: string; actor_id: string; session_hash: string; operation: CsvBackgroundOperation;
  idempotency_key: string; expected_revision: number; input_json: string; input_hash: string; csv_bytes: Buffer | null;
  confirmation_attempt_id: string | null; batch_id: string | null; command_request_id: string; approval_audit_id: string; created_at: string; expires_at: string;
}
export interface CsvBackgroundCancellationRow { request_id: string; actor_id: string; session_hash: string; reason: string; created_at: string }
export interface CsvBackgroundResult {
  schema_version: "csv-background-result-v1"; request_id: string; operation: CsvBackgroundOperation; input_hash: string;
  batch_id: string; preview_hash: string; expected_revision: number; batch_status: "preview" | "invalid" | "confirmed";
  row_count: number; error_count: number; review_hash: string; required_review_count: number;
  confirmed_revision: number | null; receipts_hash: string | null;
}
export interface CsvBackgroundResultRow { request_id: string; job_id: string; job_attempt_id: string; batch_id: string; result_json: string; result_hash: string; completed_at: string }
export interface CsvBackgroundJobResult { schema_version: "csv-background-job-result-v1"; request_id: string; operation: CsvBackgroundOperation; batch_id: string; result_hash: string }
export interface CsvBackgroundLease { job_id: string; owner: string; fencing_token: number; attempt: number }
export interface CsvTransactionTiming {
  schema_version: "csv-transaction-timing-v1"; outcome: "returned" | "threw"; transaction_call_us: number;
  begin_to_callback_us: number | null; callback_us: number | null; finalize_tail_us: number | null;
}
export interface CsvBackgroundPublishOptions extends CsvBackgroundOptions {
  clock?: () => string; beforeCommit?: () => void; onTransactionTiming?: (timing: CsvTransactionTiming) => void;
}
export interface CsvBackgroundPreviewData { filename: string; mapping: string; csv_sha256: string }
export interface CsvBackgroundConfirmData { payload_hash: string }
export interface CsvBackgroundConfirmationPayload {
  action: "confirm_import"; portfolio_id: string; batch_id: string; preview_hash: string; expected_revision: number; csv_review?: unknown;
}
export interface CsvBackgroundRequestBinding {
  row: CsvBackgroundRequestRow; input: CsvBackgroundPreviewData | CsvBackgroundConfirmData;
  confirmation: { payload_text: string; payload: CsvBackgroundConfirmationPayload } | null;
}
export interface CsvBackgroundJobRow {
  id: string; command_request_id: string; job_type: string; scope: string; period: string; input_version: string;
  status: string; attempt_count: number; max_attempts: number; fencing_token: number;
  lease_owner: string | null; lease_until: string | null; created_at: string; updated_at: string; result_json: string | null;
}
