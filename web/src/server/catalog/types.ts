export type EtfProfile = {
  issuer: string | null;
  index_id: string | null;
  domicile: string | null;
  underlying_asset_class: "equity" | "fixed_income" | "commodity" | "multi_asset" | "cash" | "other" | "unknown";
  economic_regions: string[];
  sectors: string[];
  annual_expense_ratio: string | null;
  distribution: "accumulating" | "distributing" | "mixed" | "unknown";
  replication: "physical" | "synthetic" | "mixed" | "unknown";
};

export type ProfileVersion = {
  id: string; portfolio_id: string; listing_id: string; version: number; source_id: string;
  as_of: string; known_at: string; profile: EtfProfile; content_hash: string; created_by: string;
};

export type HoldingsSnapshot = {
  schema_version: "holdings-disclosure-v1";
  snapshot_id: string; portfolio_id: string; listing_id: string; version: number;
  as_of: string; known_at: string; weight_basis: "net_assets_long_only";
  complete: boolean; coverage: string;
  items: { security_id: string; weight: string }[];
  content_hash: string;
};

export type HoldingsReference = Pick<HoldingsSnapshot,
  "snapshot_id" | "portfolio_id" | "listing_id" | "version" | "as_of" | "known_at" | "content_hash" | "complete">;

export type HoldingsOverlap = {
  schema_version: "holdings-overlap-v1"; method_version: "holdings-overlap-v1";
  portfolio_id: string; comparison_at: string; weight_basis: "net_assets_long_only";
  snapshot_a: HoldingsReference; snapshot_b: HoldingsReference;
  known_overlap: string; coverage_a: string; coverage_b: string;
  uncovered_a: string; uncovered_b: string; conservative_upper_bound: string;
  quality: "different_dates" | "exact" | "lower_bound"; same_date: boolean;
  bound_scope: "the_two_disclosed_date_vectors";
  common_holdings: { security_id: string; weight_a: string; weight_b: string; overlap_weight: string }[];
  issues: string[]; binding_id: string;
};
