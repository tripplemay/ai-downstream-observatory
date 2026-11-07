import { hash } from "../src/server/ledger/service";
import { correctionImpactResponseSchema, type CorrectionImpactResponse } from "../src/server/investor/correction-impact-schemas";
import { reviewAt, reviewView, reviewBinding } from "./action-review-client-fixture";
import { blankCorrectionDrafts, buildCorrectionAttempt } from "../src/components/workbench/investor-correction-impact-client";

export function correctionView(){const view=reviewView();view.status="historical_correction_required";view.confirmation_supported=false;view.previous_coverage_end="2026-11-02";
  view.changes[0].disposition="historical_correction";view.changes[0].previous.issuer=[{...view.changes[0].current.issuer[0],distribution_amount:"3.32109",record_hash:"9".repeat(64)}];return view;}
export function filledCorrectionDrafts(){const rows=blankCorrectionDrafts(correctionView());return rows.map(row=>({...row,choice:"replace" as const,reason:"Fictional issuer amount correction, not approval",
  dividend_at:"2026-11-02T14:30",pay_at:"2026-11-09T21:00",tax:"0.432109"}));}
export function correctionResponse(overrides:Partial<CorrectionImpactResponse>={}){const view=correctionView(),intent=buildCorrectionAttempt(view,"fictional-model",filledCorrectionDrafts(),true,"fictional-impact",Date.parse(reviewAt)).intent;
  return correctionImpactResponseSchema.parse({schema_version:"investor-correction-impact-response-v1",workspace_id:"w",workspace_revision:1,checked_at:reviewAt,refresh_after:"2026-11-03T06:00:18.001Z",
    session_binding:reviewBinding,lookup_nonce:null,read_only:false,request:{id:"fictional-impact-job",model_id:"fictional-model",preview_id:view.preview.preview_id,intent_hash:hash(intent),
      created_at:reviewAt,valid_until:"2026-11-03T06:05:03.001Z",status:"queued",code:null},summary:null,summary_hash:null,visibility:"private_owner_only_not_ai",provider_calls:0,
    economic_correction_approved:false,trading_permission:false,...overrides});}
export function readyCorrectionResponse(overrides:Partial<CorrectionImpactResponse>={}){const base=correctionResponse(),summary={checked_at:reviewAt,valid_until:"2026-11-03T06:15:03.001Z",original_checkpoint_at:"2026-11-02T20:01:00.000Z",
  original_valuation_cny:"10000",hypothetical_valuation_cny:"10002.5",difference_cny:"2.5",original_quantities:{fictional:"10"},hypothetical_quantities:{fictional:"10"},cash_delta:{CNY:"0",HKD:"0",USD:"0"},
  receivable_delta:{CNY:"0",HKD:"0",USD:"2"},ignored_new_report_dates:[],basis:"stored_hypothetical_result_at_original_prices_not_current_nav" as const,economic_correction_approved:false as const,monitoring_resumed:false as const,trading_permission:false as const};
  return correctionResponse({...base,request:{...base.request!,status:"preview_ready",code:"CORRECTION_IMPACT_READY"},summary,summary_hash:hash(summary),...overrides});}
