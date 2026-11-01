import Decimal from "decimal.js";
import { hash } from "../ledger/service";
import { priceInstant } from "../market-price-source";
import { validateInvestorActionReviewDocument, validateInvestorSourceDocument } from "./kernel-contracts";
import { amount as factAmount } from "../ledger/decimal";
import { actionAddDays, actionCheck as check, actionNyParts, actionText } from "./action-source-parsers";
import type { ActionDraft, ActionObject as Obj } from "./action-source-parsers";

export type ActionSnapshot={issuer:ActionDraft;dividends:ActionDraft;splits:ActionDraft};
const Exact=Decimal.clone({precision:128,rounding:Decimal.ROUND_HALF_EVEN});
const amount=(value:unknown)=>new Exact(actionText(value));
export const ACTION_TARGETS:Record<string,string>={"VT.US":"3141","BND.US":"0928"};
const minimum=(values:unknown[])=>values.map(actionText).sort()[0];
const maximum=(values:unknown[])=>values.map(actionText).sort().at(-1)!;
function snapshot(value:ActionSnapshot,symbol:string) {
  check(Object.keys(value).sort().join() === "dividends,issuer,splits");
  for(const draft of Object.values(value))check(draft.owner_reviewed === false && draft.corporate_actions_complete === false
    && draft.research_admitted === false && Array.isArray(draft.records) && draft.records.length <= 2048);
  check(value.issuer.source.provider === "vanguard_issuer" && value.issuer.source.requested_fund_id === ACTION_TARGETS[symbol]);
  for(const [key,kind] of [["dividends","div"],["splits","splits"]] as const)check(value[key].source.provider === "eodhd"
    && value[key].source.requested_symbol === symbol && value[key].source.kind === kind);
  const days=new Set(Object.values(value).map(draft=>actionNyParts(draft.source.retrieved_at).day));check(days.size === 1);return [...days][0];
}
function groups(records:Obj[],dateKey:string,keyFields:string[],start:string,end:string) {
  const values:Record<string,Obj>={};
  for(const row of records)if(start <= actionText(row[dateKey]) && actionText(row[dateKey]) <= end) {
    const key=JSON.stringify(keyFields.map(field=>row[field]));check(!Object.hasOwn(values,key));
    Object.defineProperty(values,key,{value:row,enumerable:true});
  }
  return values;
}
function byDay(records:Obj[],field:string,start:string,end:string) {
  const values=new Map<string,Obj[]>();
  for(const row of records) {
    const day=actionText(row[field]);if(day < start || day > end)continue;
    values.set(day,[...(values.get(day) ?? []),row]);
  }
  return values;
}
function sameKeys(a:Map<string,unknown>,b:Map<string,unknown>) {check(hash([...a.keys()].sort()) === hash([...b.keys()].sort()));}
function anchorNominalDifferences(anchor:ActionSnapshot) {
  const start=maximum(Object.values(anchor).map(value=>value.source.range_start)),end=minimum(Object.values(anchor).map(value=>value.source.range_end));
  check(start <= end);
  const issuer=byDay(anchor.issuer.records,"ex_date",start,end),provider=byDay(anchor.dividends.records,"date",start,end);
  sameKeys(issuer,provider);let differences=0;
  for(const [day,rows] of issuer) {
    const other=provider.get(day)!;check(other.length === 1);
    const components=new Set(rows.map(row=>row.issuer_type_code));
    check(components.size === rows.length && [...components].every(kind=>["INC","CGLT","CGST"].includes(kind as string))
      && new Set(rows.map(row=>JSON.stringify([row.record_date,row.pay_date]))).size === 1
      && other[0].reported_currency === "USD" && other[0].record_date !== null && other[0].payment_date !== null
      && rows[0].record_date === other[0].record_date && rows[0].pay_date === other[0].payment_date);
    const total=rows.reduce((sum,row)=>sum.plus(amount(row.distribution_amount)),new Exact(0));
    if(!total.eq(amount(other[0].unadjusted_value)))differences++;
  }
  return differences;
}
function reviewedOverlap(base:Obj,anchor:ActionSnapshot,start:string,end:string) {
  const dividends=new Map<string,Obj[]>(),splits=new Map<string,Obj>();
  check(Array.isArray(base.events));
  for(const event of base.events as Obj[]) {
    const day=actionNyParts(event.at).day;if(day < start || day > end)continue;
    if(event.type === "dividend")dividends.set(day,[...(dividends.get(day) ?? []),event]);
    else {check(!splits.has(day));splits.set(day,event);}
  }
  const issued=byDay(anchor.issuer.records,"ex_date",start,end);sameKeys(dividends,issued);
  for(const [day,events] of dividends) {
    const rows=issued.get(day)!,pays=new Set(events.map(event=>actionNyParts(event.pay_at).day)),issuerPays=new Set(rows.map(row=>row.pay_date));
    check(pays.size === 1 && hash([...pays].sort()) === hash([...issuerPays].sort()));
    const gross=events.reduce((sum,event)=>sum.plus(amount(event.gross_per_unit)),new Exact(0));
    check(gross.eq(rows.reduce((sum,row)=>sum.plus(amount(row.distribution_amount)),new Exact(0))));
  }
  const reported=byDay(anchor.splits.records,"date",start,end);sameKeys(splits,reported);
  for(const [day,rows] of reported)check(rows.length === 1 && amount(splits.get(day)!.ratio).times(amount(rows[0].denominator)).eq(amount(rows[0].numerator)));
  return {distributionDates:issued.size,splitDates:reported.size};
}

/** Pure exact comparison only; callers must independently authenticate every input. */
export function checkNoNewActionCandidate(base:Obj,anchor:ActionSnapshot,current:ActionSnapshot,symbol:string,listingId:string) {
  check(Object.hasOwn(ACTION_TARGETS,symbol));validateInvestorSourceDocument("facts",{kind:"actions",facts:base});
  check(base.listing_id === listingId && actionText(base.range_start) <= actionText(base.range_end));
  const anchorDay=snapshot(anchor,symbol),currentDay=snapshot(current,symbol);check(currentDay >= anchorDay);
  const baseEnd=actionText(base.range_end),end=minimum(Object.values(current).map(draft=>draft.source.range_end));
  const anchorEnd=minimum(Object.values(anchor).map(draft=>draft.source.range_end));check(end >= anchorEnd && anchorEnd >= baseEnd);
  const start=maximum([base.range_start,...Object.values(anchor).map(draft=>draft.source.range_start)]);check(start <= baseEnd);
  const differences=anchorNominalDifferences(anchor),overlap=reviewedOverlap(base,anchor,start,baseEnd),tail=actionAddDays(baseEnd,1);
  for(const [name,dateField,fields] of [["issuer","ex_date",["ex_date","issuer_type_code"]],["dividends","date",["date"]],["splits","date",["date"]]] as const) {
    const old=anchor[name],next=current[name];
    check(actionText(next.source.range_start) >= actionText(old.source.range_start) && actionText(next.source.range_end) >= actionText(old.source.range_end)
      && priceInstant(next.source.retrieved_at) >= priceInstant(old.source.retrieved_at) && actionText(next.source.range_start) <= tail);
    check(![...old.records,...next.records].some(row=>actionText(row[dateField]) > baseEnd));
    const overlapStart=maximum([old.source.range_start,next.source.range_start]);
    check(hash(groups(old.records,dateField,[...fields],overlapStart,baseEnd)) === hash(groups(next.records,dateField,[...fields],overlapStart,baseEnd)));
  }
  const facts={...base,range_end:end};
  return {status:end > baseEnd ? "eligible_candidate_only":"no_coverage_advance",base_facts_hash:hash(base),candidate_facts_hash:hash(facts),
    range_start:base.range_start,previous_range_end:baseEnd,candidate_range_end:end,anchor_source_day:anchorDay,current_source_day:currentDay,
    overlap_distribution_dates:overlap.distributionDates,overlap_split_dates:overlap.splitDates,registered_nominal_difference_count:differences,
    coverage_basis:"selected_two_source_reports_not_objective_absence",authority_and_publication_not_verified:true,old_events_and_tax_assumption_unchanged:true,
    owner_reviewed_today:false,corporate_actions_complete:false,research_admitted:false,trading_permission:false,source_calls:0,database_writes:0,market_values_output:false};
}

/** Independent pure append comparison; no owner, raw receipt or consent admission. */
export function checkReviewedActionAppend(before:Obj,after:Obj,previous:ActionSnapshot,current:ActionSnapshot,
  symbol:string,listingId:string,knowledgeFloor:string,reviewedAt:string) {
  check(Object.hasOwn(ACTION_TARGETS,symbol));
  for(const facts of [before,after]) {
    validateInvestorSourceDocument("facts",{kind:"actions",facts});
    check(facts.listing_id === listingId && Array.isArray(facts.events));
    for(const event of facts.events as Obj[]) {
      const day=actionNyParts(event.at).day;priceInstant(event.published_at);
      check(actionText(facts.range_start) <= day && day <= actionText(facts.range_end));
      if(event.type === "dividend")check(priceInstant(event.pay_at) >= priceInstant(event.at)
        && factAmount(event.tax_per_unit).gte(0) && factAmount(event.tax_per_unit).lte(factAmount(event.gross_per_unit)));
      else check(factAmount(event.ratio).gt(0));
    }
  }
  check(snapshot(current,symbol) >= snapshot(previous,symbol));
  for(const value of [previous,current])for(const draft of Object.values(value))priceInstant(draft.source.retrieved_at);
  checkNoNewActionCandidate(before,previous,previous,symbol,listingId);
  const oldEnd=actionText(before.range_end),newEnd=actionText(after.range_end);
  const fixed=(facts:Obj)=>Object.fromEntries(Object.entries(facts).filter(([key])=>!["events","range_end"].includes(key)));
  const oldEvents=before.events as Obj[],allEvents=after.events as Obj[],added=allEvents.slice(oldEvents.length);
  check(newEnd > oldEnd && hash(fixed(before)) === hash(fixed(after)) && added.length > 0
    && hash(allEvents.slice(0,oldEvents.length)) === hash(oldEvents) && new Set(allEvents.map(event=>event.id)).size === allEvents.length);
  const floor=priceInstant(knowledgeFloor),reviewed=priceInstant(reviewedAt);
  check(floor <= reviewed && Object.values(current).every(draft=>floor >= priceInstant(draft.source.retrieved_at)));
  for(const event of added)check(actionNyParts(event.at).day > oldEnd && actionNyParts(event.at).day <= newEnd
    && priceInstant(event.published_at) >= floor && priceInstant(event.published_at) <= reviewed);
  for(const [kind,day,fields] of [["issuer","ex_date",["ex_date","issuer_type_code"]],
    ["dividends","date",["date"]],["splits","date",["date"]]] as const) {
    const old=previous[kind],next=current[kind];
    check(actionText(next.source.range_start) >= actionText(old.source.range_start)
      && actionText(next.source.range_end) >= actionText(old.source.range_end)
      && priceInstant(next.source.retrieved_at) >= priceInstant(old.source.retrieved_at)
      && actionText(next.source.range_start) <= actionAddDays(oldEnd,1));
    const start=maximum([old.source.range_start,next.source.range_start]);
    check(hash(groups(old.records,day,[...fields],start,oldEnd)) === hash(groups(next.records,day,[...fields],start,oldEnd)));
    check(actionText(next.source.range_end) >= newEnd && next.records.every(row=>actionText(row[day]) <= newEnd));
  }
  anchorNominalDifferences(current);
  const start=maximum([after.range_start,...Object.values(current).map(draft=>draft.source.range_start)]);
  check(start <= oldEnd);reviewedOverlap(after,current,start,newEnd);
  const tail=Object.fromEntries(Object.entries(current).map(([kind,draft])=>[kind,{...draft,
    records:draft.records.filter(row=>actionText(row[kind === "issuer" ? "ex_date":"date"]) > oldEnd)}])) as ActionSnapshot;
  const late=added.filter(event=>priceInstant(event.published_at) > priceInstant(event.at)).length;
  const proof={status:"reviewed_append_prepared_only",previous_facts_hash:hash(before),reviewed_facts_hash:hash(after),
    previous_snapshot_hash:hash(previous),current_snapshot_hash:hash(current),previous_coverage_end:oldEnd,new_coverage_end:newEnd,
    added_event_count:added.length,added_dividend_count:added.filter(event=>event.type === "dividend").length,
    added_split_count:added.filter(event=>event.type === "split").length,new_nominal_difference_count:anchorNominalDifferences(tail),
    knowledge_basis:"current_complete_report_receipts_only",late_knowledge_event_count:late,continuation_timing_ready:late === 0,
    requires_separate_knowledge_or_start:late > 0,old_events_and_tax_assumption_unchanged:true,owner_approval_verified:false,
    source_authority_verified:false,handover_registered:false,research_admitted:false,trading_permission:false,
    provider_calls:0,database_writes:0,raw_amounts_or_tax_text_output:false};
  validateInvestorActionReviewDocument("append_proof",proof);return proof;
}
