import type { CsvBackgroundCandidateKind, CsvBackgroundRowItem } from "@/server/csv-background/query-types";
import type { CsvRowResolution } from "@/server/ledger/csv-review";

export interface CsvBackgroundReviewDraft {
  reviewHash: string; row: number; linkOnly: boolean;
  action: "" | CsvRowResolution["action"]; reason: string;
  picked: { kind: CsvBackgroundCandidateKind; value: string | number } | null;
}
export function backgroundReviewDraft(row: CsvBackgroundRowItem, reviewHash: string): CsvBackgroundReviewDraft {
  return { reviewHash, row: row.row, linkOnly: row.outcome.kind === "link_only", action: "", reason: "", picked: null };
}
export function backgroundReviewResolution(draft: CsvBackgroundReviewDraft, reviewHash: string): CsvRowResolution | null {
  if (draft.reviewHash !== reviewHash || !draft.reason.trim() || draft.reason.length > 2000) return null;
  if (draft.action === "record_distinct" && !draft.linkOnly) return { row: draft.row, action: draft.action, reason: draft.reason };
  if (draft.action === "link_existing" && draft.picked?.kind === "exact_event_ids" && typeof draft.picked.value === "string")
    return { row: draft.row, action: draft.action, event_id: draft.picked.value, reason: draft.reason };
  if (draft.action === "link_prior_row" && draft.picked?.kind === "exact_prior_rows" && typeof draft.picked.value === "number"
    && Number.isSafeInteger(draft.picked.value) && draft.picked.value > 0 && draft.picked.value < draft.row)
    return { row: draft.row, action: draft.action, prior_row: draft.picked.value, reason: draft.reason };
  return null;
}
