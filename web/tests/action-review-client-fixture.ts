import { hash } from "../src/server/ledger/service";
import { actionReviewResponseSchema, actionReviewViewSchema, type ActionReviewResponse } from "../src/server/investor/action-review-schemas";

export const reviewBinding="a".repeat(64),reviewAt="2026-11-03T06:00:03.001Z",reviewNow=Date.parse(reviewAt);
export const reviewIntent={kind:"preview",symbol:"VT.US",expected_revision:0,idempotency_key:"fictional-preview"};
export function reviewView(symbol:"VT.US"|"BND.US"="VT.US",id="fictional-preview-witness") {
  return actionReviewViewSchema.parse({schema_version:"investor-action-review-view-v1",provider_symbol:symbol,source_day:"2026-11-03",
    preview:{schema_version:"investor-action-review-preview-v1",preview_id:id,workspace_id:"w",workspace_revision:1,request_hash:"b".repeat(64),
      authority_id:"fictional-authority",authority_hash:"c".repeat(64),control_id:"fictional-control",control_hash:"d".repeat(64),draft_basis_hash:"e".repeat(64),
      checked_at:reviewAt,created_at:reviewAt,valid_until:"2026-11-03T06:15:03.001Z",validity_policy:"owner_review_15m",approval_performed:false,
      provider_calls:0,research_admitted:false,trading_permission:false},
    status:"new_reported_actions",previous_coverage_end:"2026-10-31",candidate_coverage_end:"2026-11-02",knowledge_not_before:reviewAt,
    unchanged_tax_assumption:"Fictional unchanged private tax explanation",changes:[{date:"2026-11-02",disposition:"new_report",outside_common_coverage:false,
      previous:{issuer:[],dividends:[],splits:[]},current:{issuer:[{ex_date:"2026-11-02",issuer_type_code:"INC",distribution_amount:"4.32109",record_date:"2026-11-02",pay_date:"2026-11-09",record_hash:"f".repeat(64)}],
        dividends:[{date:"2026-11-02",value:"4.32",unadjusted_value:"4.321",reported_currency:"USD",declaration_date:null,record_date:"2026-11-02",payment_date:"2026-11-09",reported_period:null,record_hash:"1".repeat(64)}],splits:[]},
      effective_at:null,payment_at:null,tax_per_unit:null}],confirmation_supported:true,checked_at:reviewAt,refresh_after:"2026-11-03T06:01:03.001Z",
    visibility:"private_owner_only_not_ai",provider_calls:0,research_admitted:false,trading_permission:false});
}
export function reviewResponse(overrides:Partial<ActionReviewResponse>={}):ActionReviewResponse {
  const view=reviewView();
  return actionReviewResponseSchema.parse({schema_version:"investor-action-review-response-v1",workspace_id:"w",workspace_revision:1,
    checked_at:reviewAt,refresh_after:"2026-11-03T06:00:18.001Z",read_only:false,symbols:["VT.US","BND.US"],lookup_nonce:null,
    research_admitted:false,trading_permission:false,provider_calls:0,request:{id:"fictional-job",kind:"preview",symbol:"VT.US",intent_hash:hash(reviewIntent),created_at:reviewAt,
      valid_until:"2026-11-03T06:05:03.001Z",status:"preview_ready",code:"ACTION_REVIEW_PREVIEW_READY",resource_id:view.preview.preview_id,
      resource_hash:hash(view.preview),resource_valid_until:view.preview.valid_until},view,preview_error:null,session_binding:reviewBinding,...overrides});
}
export const filledReviewDrafts=()=>[{type:"dividend" as const,date:"2026-11-02",at:"2026-11-02T14:30",pay_at:"2026-11-09T21:00:00",tax_per_unit:"0.432109"}];
