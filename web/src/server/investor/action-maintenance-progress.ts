import type Database from "better-sqlite3";
import { actionCheck as check, actionNyParts } from "./action-source-parsers";
import { actionMillis } from "./action-source-proof";
import { readManagedActionProgressRecord } from "./managed-action-source";
import { actionMaintenanceProgressSchema, type ActionMaintenanceProgress, type ActionMaintenanceEntry } from "./action-maintenance-progress-schemas";

export function unavailableActionMaintenanceProgress(now:string):ActionMaintenanceProgress {
  actionMillis(now);
  return actionMaintenanceProgressSchema.parse({schema_version:"investor-action-maintenance-progress-v1",checked_at:now,
    refresh_after:new Date(Date.parse(now)+60000).toISOString(),status:"unavailable",entries:[],scope:"workspace_registered_fixed_rules",
    coverage_basis:"selected_two_source_reports_not_objective_absence",evidence_scope:"standing_rule_metadata_not_payload_verification",
    provider_online_verified:false,raw_evidence_replayed_by_this_view:false,research_admitted_by_this_view:false,human_review_performed_today:false,trading_permission:false});
}

export function readActionMaintenanceProgress(db:Database.Database,workspace:string,owner:string,now:string):ActionMaintenanceProgress {
  actionMillis(now);
  return db.transaction(()=>{
    check((db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as {owner_id:string}|undefined)?.owner_id === owner);
    // SQL only shortlists heads. Every selected header, control and dependency is authenticated below.
    const heads=db.prepare(`WITH rules AS (
      SELECT a.id,a.created_at,a.rowid, json_extract(a.document_json,'$.provider_symbol') symbol,
        CASE WHEN c.enabled=1 AND json_extract(a.document_json,'$.valid_from')<=? AND json_extract(a.document_json,'$.valid_until')>? THEN 1 ELSE 0 END effective
      FROM investor_action_authorities a JOIN investor_action_controls c ON c.authority_id=a.id
      WHERE a.workspace_id=? AND c.version=(SELECT max(version) FROM investor_action_controls WHERE authority_id=a.id)
    ), ranked AS (SELECT *,sum(effective) OVER(PARTITION BY symbol) active_count,
      row_number() OVER(PARTITION BY symbol ORDER BY effective DESC,created_at DESC,rowid DESC) rank FROM rules)
      SELECT id,symbol,active_count FROM ranked WHERE rank=1 ORDER BY symbol LIMIT 3`).all(now,now,workspace) as {id:string;symbol:string;active_count:number}[];
    check(heads.length <= 2);
    const result=unavailableActionMaintenanceProgress(now),local=actionNyParts(now),limits=[Date.parse(result.refresh_after)];
    for(const head of heads) {
      check(head.active_count <= 1);
      const {grant,intent,latest,coverage,quarantine,dependencyReason,limits:deadlines}=readManagedActionProgressRecord(db,workspace,head.id,now);
      check(grant.doc.provider_symbol === head.symbol && ["VT.US","BND.US"].includes(head.symbol));
      for(const deadline of deadlines)if(Date.parse(deadline as string)>Date.parse(now))limits.push(Date.parse(deadline as string));
      const entry:ActionMaintenanceEntry={symbol:head.symbol as ActionMaintenanceEntry["symbol"],enabled:grant.current.enabled === 1,
        state:"waiting_sources",valid_from:grant.doc.valid_from as string,valid_until:grant.doc.valid_until as string,
        last_source_day:(intent?.row.source_day ?? latest?.row.source_day ?? null) as string|null,last_result_at:(latest?.row.created_at ?? null) as string|null,
        coverage_source_day:(coverage?.row.source_day ?? null) as string|null,coverage_end:(coverage?.row.coverage_end ?? null) as string|null,
        coverage_recorded_at:(coverage?.row.created_at ?? null) as string|null,reason_code:null};
      if(quarantine) {entry.state="needs_review";entry.reason_code=quarantine.doc.failure_code as ActionMaintenanceEntry["reason_code"];}
      else if(Date.parse(now)<Date.parse(entry.valid_from))entry.state="future";
      else if(Date.parse(now)>=Date.parse(entry.valid_until))entry.state="expired";
      else if(!entry.enabled)entry.state="disabled";
      else if(intent && (!latest || latest.row.request_id !== intent.row.id) && Date.parse(now)>=Date.parse(intent.row.valid_until as string)) {
        entry.state="needs_review";entry.reason_code="MAINTENANCE_WINDOW_MISSED";
      } else if(dependencyReason) {entry.state="source_unavailable";entry.reason_code=dependencyReason as ActionMaintenanceEntry["reason_code"];}
      else if(coverage && coverage.doc.control_id !== grant.current.id) {entry.state="source_unavailable";entry.reason_code="RULE_CONTROL_CHANGED";}
      else if(local.hour < 1 || intent?.row.source_day === local.day && intent.original.id !== grant.current.id || latest?.row.source_day === local.day && latest.row.status === "superseded")entry.state="waiting_next_window";
      else if(intent && (!latest || latest.row.request_id !== intent.row.id) || entry.last_source_day !== local.day)entry.state="waiting_sources";
      else if(latest?.row.status === "published")entry.state="coverage_recorded";
      else if(latest?.row.status === "unchanged")entry.state="coverage_unchanged";
      result.entries.push(entry);
    }
    result.status=heads.length ? "visible":"not_configured";result.refresh_after=new Date(Math.min(...limits)).toISOString();
    return actionMaintenanceProgressSchema.parse(result);
  }).deferred();
}
