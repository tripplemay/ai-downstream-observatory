import type { Receipt } from "./service";

export interface CsvRecoveryPrincipal { actorId: string; sessionHash: string }
export interface CsvConfirmationAttemptSummary {
  id: string; portfolio_id: string; account_id: string; batch_id: string;
  preview_hash: string; expected_revision: number; payload_hash: string; payload_bytes: number;
  created_at: string; batch_status: "preview" | "invalid" | "confirmed" | "cancelled";
  current_revision: number; confirmed_revision: number | null;
}
export interface CsvConfirmationRecoveryList {
  schema_version: "csv-confirmation-recovery-v1";
  attempts: CsvConfirmationAttemptSummary[]; next_cursor: string | null; read_only: boolean;
}
export interface CsvConfirmationRecoveryDetail {
  schema_version: "csv-confirmation-recovery-v1";
  attempt: CsvConfirmationAttemptSummary; payload_text: string; read_only: boolean;
  batch: { id: string; portfolio_id: string; account_id: string; status: CsvConfirmationAttemptSummary["batch_status"];
    parser_version: "csv-v1"; preview_hash: string; expected_revision: number; confirmed_revision: number | null; row_count: number };
  confirmation: { status: "unconfirmed"; attempt_matches: null } | {
    status: "confirmed"; attempt_matches: boolean; revision: number; receipts: Receipt[]; duplicate: true;
  };
  review_error: string | null;
}
export type CsvConfirmationRecoveryListResponse = CsvConfirmationRecoveryList & { session_binding: string };
export type CsvConfirmationRecoveryDetailResponse = CsvConfirmationRecoveryDetail & { session_binding: string };
export type CsvConfirmationRecoverySelector = { id: string } | { batch_id: string; payload_hash: string };
