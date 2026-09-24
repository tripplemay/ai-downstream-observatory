import type { CsvIssue } from "../ledger/csv";
import type { CsvMappedRow } from "../ledger/csv-mapping";
import type { CsvDryRun } from "../ledger/csv-import-evidence";
import type { CsvRowResolution } from "../ledger/csv-review";
import type { LedgerCommand, Receipt } from "../ledger/service";
import type { CsvBackgroundOperation, CsvBackgroundResult } from "./types";

export type CsvBackgroundCandidateKind = "exact_event_ids" | "possible_event_ids" | "exact_prior_rows" | "possible_prior_rows";
export type CsvBackgroundCandidateCounts = Record<CsvBackgroundCandidateKind, number>;
export interface CsvBackgroundSummary {
  request_id: string; portfolio_id: string; account_id: string; operation: CsvBackgroundOperation; input_hash: string;
  expected_revision: number; created_at: string; expires_at: string; status: string;
  job: { id: string; status: string; attempt_count: number; max_attempts: number; updated_at: string } | null;
  attempts: { attempt: number; status: string; started_at: string; finished_at: string | null; error_code: string | null }[];
  cancelled_at: string | null; result_hash: string | null; result: CsvBackgroundResult | null;
}
export interface CsvBackgroundPageCommon {
  schema_version: "csv-background-page-v1"; portfolio_id: string; server_now: string; read_only: boolean;
}
export interface CsvBackgroundPageIdentity {
  request_id: string; result_hash: string; batch_id: string; preview_hash: string; review_hash: string;
}
export interface CsvBackgroundPreviewMetadata {
  account_id: string; expected_revision: number; current_revision: number;
  batch_status: "preview" | "invalid" | "confirmed"; confirmed_revision: number | null;
  original_filename: string; attachment_id: string; content_hash: string;
  mapping_version_id: string; mapping_id: string; mapping_version: number; mapping_hash: string;
  mapping_attachment_id: string; mapping_attachment_hash: string;
  parser_version: string; mapper_version: string; headers: string[]; document_errors: CsvIssue[]; warnings: string[];
  broker_format_verified: false; row_count: number; error_count: number; required_review_count: number;
}
export interface CsvBackgroundRowItem {
  row: number; source: CsvMappedRow; outcome: CsvDryRun; command: LedgerCommand | null; errors: string[];
  requires_review: boolean; candidate_counts: CsvBackgroundCandidateCounts; missing_source_id: boolean;
}
export interface CsvBackgroundReceiptItem { row: number; receipt: Receipt; resolution: CsvRowResolution | null }
export interface CsvBackgroundListPage extends CsvBackgroundPageCommon { view: "list"; items: CsvBackgroundSummary[]; next_cursor: string | null }
export interface CsvBackgroundStatusPage extends CsvBackgroundPageCommon { view: "status"; item: CsvBackgroundSummary }
export interface CsvBackgroundPreviewPage extends CsvBackgroundPageCommon, CsvBackgroundPageIdentity { view: "preview"; preview: CsvBackgroundPreviewMetadata }
export interface CsvBackgroundRowsPage extends CsvBackgroundPageCommon, CsvBackgroundPageIdentity {
  view: "rows"; review_only: boolean; total: number; receipts_hash: null; items: CsvBackgroundRowItem[]; next_cursor: string | null;
}
export interface CsvBackgroundCandidatesPage extends CsvBackgroundPageCommon, CsvBackgroundPageIdentity {
  view: "candidates"; row: number; kind: CsvBackgroundCandidateKind; total: number; items: (string | number)[]; next_cursor: string | null;
}
export interface CsvBackgroundReceiptsPage extends CsvBackgroundPageCommon, CsvBackgroundPageIdentity {
  view: "receipts"; total: number; receipts_hash: string; items: CsvBackgroundReceiptItem[]; next_cursor: string | null;
}
export type CsvBackgroundPage = CsvBackgroundListPage | CsvBackgroundStatusPage | CsvBackgroundPreviewPage | CsvBackgroundRowsPage | CsvBackgroundCandidatesPage | CsvBackgroundReceiptsPage;
export type CsvBackgroundQueryResponse = CsvBackgroundPage & { session_binding: string };
