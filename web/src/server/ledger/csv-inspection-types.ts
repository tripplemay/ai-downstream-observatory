import type { CsvDialect, CsvIssue, CsvLocation } from "./csv";

export interface CsvInspectionValuesRequest { column: string; trim: boolean; offset: number; limit: number }
export interface CsvInspectionRequest {
  portfolio_id: string; account_id: string; expected_revision: number;
  dialect: "auto" | CsvDialect;
  values?: CsvInspectionValuesRequest;
}
export interface CsvInspectionSample {
  value: string; byte_length: number; truncated: boolean; formula_like: boolean;
}
export interface CsvInspectionCandidate {
  dialect: CsvDialect; valid: boolean; column_count: number; row_count: number;
  document_errors: (CsvIssue & Partial<CsvLocation>)[]; row_error_count: number;
}
export interface CsvInspectionSelected extends CsvInspectionCandidate {
  headers: string[]; header_location: CsvLocation | null;
  sample_rows: (CsvLocation & { cells: CsvInspectionSample[]; errors: CsvIssue[] })[];
  columns: {
    index: number; header: string; empty_count: number; distinct_count: number;
    samples: (CsvInspectionSample & { record_number: number })[];
  }[];
  row_errors: (CsvLocation & { errors: CsvIssue[] })[];
  row_errors_truncated: boolean;
}
export interface CsvInspectionValues {
  column: string; trim: boolean; offset: number; limit: number; total: number;
  items: { value: string; count: number; first_record_number: number; lookup_compatible: boolean; formula_like: boolean }[];
  next_offset: number | null;
}
export interface CsvInspectionList<T> { items: T[]; total: number; limit: number; truncated: boolean }
export interface CsvInspectionContext {
  accounts: CsvInspectionList<{ id: string; portfolio_id: string; name: string; base_currency: string }>;
  listings: CsvInspectionList<{ id: string; ticker: string; name: string; currency: string; market: string; exchange: string }>;
}
export interface CsvInspectionResponse {
  schema_version: "csv-inspection-v1";
  portfolio_id: string; account_id: string; ledger_revision: number;
  original_filename: string; content_hash: string; byte_length: number; bom: boolean; parser_version: string;
  candidates: CsvInspectionCandidate[]; selected: CsvInspectionSelected | null; values: CsvInspectionValues | null;
  context: CsvInspectionContext;
  limits: { file_bytes: number; data_rows: number; columns: number; sample_rows: number; sample_cell_bytes: number;
    column_samples: number; row_errors: number; values_page: number; values_page_bytes: number;
    context_items: number; context_list_bytes: number; response_bytes: number };
  state_written: false; broker_format_verified: false;
}
