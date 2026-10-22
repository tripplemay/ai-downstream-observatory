import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import DecimalJs from "decimal.js";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {basename,resolve} from "node:path";
import buySchema from "../../../../contracts/v1/bounded-cash-buy.schema.json";
import journalSchema from "../../../../contracts/v1/bounded-cash-journal.schema.json";
import schema from "../../../../contracts/v1/bounded-cash-projection.schema.json";
import {buyDigest,planBuys,type BuyInput} from "./bounded-cash";
import {appendJournalCommand,journalImplementationHash,newJournal,replayJournal,type CashJournal,type CashState,type JournalCommand,type JournalEvent,type StudyDeclaration} from "./journal";

const ENGINE = "bounded-cash-projection-sandbox-v1";
const D = DecimalJs.clone({precision:160,rounding:DecimalJs.ROUND_HALF_EVEN,toExpNeg:-200,toExpPos:200});
const ajv = new Ajv2020({strict:true,strictRequired:false});addFormats(ajv);
ajv.addSchema(buySchema);ajv.addSchema(journalSchema);ajv.addSchema(schema);
const sources = ["contracts/v1/bounded-cash-projection.schema.json","worker/execution_sandbox/projection.py","web/src/server/execution-sandbox/projection.ts"];

export type Target = {listing_id:string;weight_bps:number;quantity_step:string};
export type Funding = {contribution_id:string;at:string;amount_cny:string};
export type CashProgram = {schema_version:"bounded-cash-program-v1";engine_version:typeof ENGINE;qualification:"synthetic_test_only";
  journal_declaration_hash:string;registered_at:string;targets:Target[];cash_target_bps:number;drift_threshold_bps:number;
  funding_schedule:Funding[];implementation_hash:string;parameters_independently_preregistered:false;live_advice_eligible:false;program_hash:string};
export type Mark = {listing_id:string;quote:BuyInput["orders"][number]["decision_quote"];corporate_action_unaccounted:false};
export type CashDecisionInput = {schema_version:"bounded-cash-decision-input-v1";qualification:"synthetic_test_only";
  program:CashProgram;journal:CashJournal;decision_id:string;at:string;execute_at:string;expires_at:string;marks:Mark[]};
type Allocation = {listing_id:string;market_value_cny:string;target_value_cny:string;underweight_cny:string;allocated_budget_cny:string};
export type CashDecision = {schema_version:"bounded-cash-decision-v1";qualification:"synthetic_test_only";implementation_hash:string;
  program_hash:string;input_hash:string;state_hash:string;at:string;status:"cash_only_underweight_plan"|"waiting_for_pending_batches"|"no_deployable_cash"|"no_eligible_underweight";
  nav_cny:string;cash_floor_cny:string;deployable_cny:string;allocations:Allocation[];command:JournalCommand|null;live_advice_eligible:false;decision_hash:string};
export type ValuationFrame = {at:string;marks:Mark[]};
export type CashValuationInput = {schema_version:"bounded-cash-valuation-input-v1";qualification:"synthetic_test_only";
  program:CashProgram;journal:CashJournal;event_frames:ValuationFrame[];final_frame:ValuationFrame};
type Sample = {revision:number;at:string;state_hash:string;marks_hash:string;pre_flow_nav_cny:string;external_flow_cny:string;nav_cny:string;
  settled_cash_cny:string;reserved_cny:string;position_value_cny:string;units:string;unit_nav:string|null;total_return:string|null;drawdown:string|null};
export type CashValuationReport = {schema_version:"bounded-cash-valuation-report-v1";qualification:"synthetic_test_only";implementation_hash:string;
  program_hash:string;input_hash:string;journal_head_hash:string;valuation_basis:"terminal_processing_not_execution_settlement";samples:Sample[];
  allocation_policy_compliance_verified:false;
  total_contributions_cny:string;end_nav_cny:string;net_profit_cny:string;return_status:"calculated"|"no_contributed_capital";
  cash_flow_adjusted_return:string|null;sampled_max_drawdown:string|null;
  cash_reference:{kind:"same_flow_cash_zero_interest_zero_cost";nav_cny:string;total_return:"0"|null;difference_cny:string;investable_market_benchmark:false};
  execution_failure_count:number;open_batch_count:number;live_advice_eligible:false;report_hash:string};

function requireValue(value:unknown,code:string):asserts value {if(!value)throw new Error("CASH_PROJECTION_"+code);}
function contract(value:unknown,kind:string) {requireValue(ajv.getSchema(schema.$id+"#/$defs/"+kind)!(value),"CONTRACT_INVALID");}
function text(value:DecimalJs) {return value.isZero()?"0":value.toFixed();}
function ratio(value:DecimalJs) {return text(value.toDecimalPlaces(12));}
function time(value:string) {
  const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/.exec(value);
  requireValue(match&&!value.startsWith("0000"),"INSTANT_INVALID");
  const ms=Date.parse(match[1]+"Z");requireValue(Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,19)===match[1],"INSTANT_INVALID");
  return BigInt(ms)*1000n+BigInt(match[2]);
}
export function projectionImplementationHash() {
  const root=resolve(basename(process.cwd())==="web"?"..":".");
  return buyDigest({engine_version:ENGINE,journal_implementation_hash:journalImplementationHash(),sources:Object.fromEntries(sources.map(path=>
    [path,createHash("sha256").update(readFileSync(resolve(root,path))).digest("hex")]))});
}
function validateProgram(value:CashProgram) {
  contract(value,"program");const {program_hash,...body}=value;
  requireValue(buyDigest(body)===program_hash,"PROGRAM_HASH_MISMATCH");
  requireValue(value.implementation_hash===projectionImplementationHash(),"IMPLEMENTATION_CHANGED");
  const ids=value.targets.map(row=>row.listing_id);
  requireValue(buyDigest(ids)===buyDigest([...new Set(ids)].sort()),"TARGET_ORDER_OR_DUPLICATE");
  requireValue(value.targets.reduce((sum,row)=>sum+row.weight_bps,value.cash_target_bps)===10000,"WEIGHT_SUM_INVALID");
  requireValue(value.targets.every(row=>new D(row.quantity_step).gt(0)),"STEP_INVALID");
  requireValue(new Set(value.funding_schedule.map(row=>row.contribution_id)).size===value.funding_schedule.length,"FUNDING_DUPLICATE");
  const sorted=[...value.funding_schedule].sort((a,b)=>a.at<b.at?-1:a.at>b.at?1:a.contribution_id<b.contribution_id?-1:a.contribution_id>b.contribution_id?1:0);
  requireValue(buyDigest(sorted)===buyDigest(value.funding_schedule),"FUNDING_ORDER_INVALID");
  requireValue(value.funding_schedule.every(row=>time(row.at)>=time(value.registered_at)&&new D(row.amount_cny).gt(0)),"FUNDING_INVALID");
}
export function declareProgram(declaration:StudyDeclaration,targets:Target[],cashTargetBps:number,driftThresholdBps:number,fundingSchedule:Funding[]):CashProgram {
  newJournal(declaration);
  const body={schema_version:"bounded-cash-program-v1" as const,engine_version:ENGINE as typeof ENGINE,qualification:"synthetic_test_only" as const,
    journal_declaration_hash:buyDigest(declaration),registered_at:declaration.registered_at,targets:structuredClone(targets),cash_target_bps:cashTargetBps,
    drift_threshold_bps:driftThresholdBps,funding_schedule:structuredClone(fundingSchedule),implementation_hash:projectionImplementationHash(),
    parameters_independently_preregistered:false as const,live_advice_eligible:false as const};
  const result:CashProgram={...body,program_hash:buyDigest(body)};validateProgram(result);return result;
}
export function fundingCommands(program:CashProgram):JournalCommand[] {
  validateProgram(program);
  return program.funding_schedule.map(row=>({command_id:"fund:"+buyDigest({program_hash:program.program_hash,contribution_id:row.contribution_id}),
    at:row.at,kind:"cash_contribution",payload:{contribution_id:row.contribution_id,amount_cny:row.amount_cny}}));
}
function context(program:CashProgram,journal:CashJournal) {
  validateProgram(program);const state=replayJournal(journal);
  requireValue(program.journal_declaration_hash===journal.declaration_hash&&program.registered_at===journal.declaration.registered_at,"JOURNAL_BINDING_MISMATCH");
  const targets=Object.fromEntries(program.targets.map(row=>[row.listing_id,row]));
  requireValue(Object.entries(state.quantity_steps).every(([id,step])=>Object.hasOwn(targets,id)&&new D(step).eq(targets[id].quantity_step)),"UNIVERSE_OR_STEP_CHANGED");
  const flows=journal.events.filter(row=>row.kind==="cash_contribution").map(row=>({at:row.at,...row.payload}));
  requireValue(buyDigest(flows)===buyDigest(program.funding_schedule.slice(0,flows.length)),"FUNDING_SCHEDULE_MISMATCH");
  return state;
}
function prices(program:CashProgram,journal:CashJournal,marks:Mark[],at:string) {
  const instant=time(at);
  requireValue(buyDigest(marks.map(row=>row.listing_id))===buyDigest(program.targets.map(row=>row.listing_id)),"MARK_UNIVERSE_OR_ORDER_INVALID");
  requireValue(new Set(marks.map(row=>row.quote.id)).size===marks.length,"DUPLICATE_QUOTE_ID");
  return Object.fromEntries(marks.map(row=>{
    const quote=row.quote,observed=time(quote.observed_at),known=time(quote.known_at),valid=time(quote.valid_until);
    requireValue(observed<=known&&known<=instant&&instant<valid&&instant-observed<=BigInt(journal.declaration.policy.max_quote_age_seconds)*1000000n,"MARK_UNAVAILABLE");
    requireValue(new D(quote.close).gt(0),"PRICE_NOT_POSITIVE");return [row.listing_id,new D(quote.close)];
  }));
}
function nav(state:CashState,marks:Record<string,DecimalJs>) {
  const positions=Object.entries(state.positions).reduce((sum,[id,quantity])=>sum.add(new D(quantity).mul(marks[id])),new D(0));
  return {total:new D(state.settled_cash_cny).add(positions),positions};
}
export function decideCash(value:CashDecisionInput):CashDecision {
  contract(value,"decisionInput");const {program,journal}=value,state=context(program,journal);
  requireValue(time(value.at)>=time(state.last_event_at),"TIME_REVERSED");
  requireValue(time(value.at)<time(value.execute_at)&&time(value.execute_at)<=time(value.expires_at),"WINDOW_INVALID");
  const marks=prices(program,journal,value.marks,value.at),total=nav(state,marks).total;
  const floor=total.mul(program.cash_target_bps).div(10000).toDecimalPlaces(2,D.ROUND_CEIL),deployable=D.max(0,new D(state.free_cash_cny).sub(floor));
  const deficits:DecimalJs[]=[],rows:Allocation[]=program.targets.map(target=>{
    const held=Object.hasOwn(state.positions,target.listing_id)?state.positions[target.listing_id]:"0";
    const marketValue=new D(held).mul(marks[target.listing_id]),desired=total.mul(target.weight_bps).div(10000),underweight=D.max(0,desired.sub(marketValue));
    deficits.push(!total.isZero()&&underweight.mul(10000).gte(total.mul(program.drift_threshold_bps))?underweight:new D(0));
    return {listing_id:target.listing_id,market_value_cny:text(marketValue),target_value_cny:text(desired),underweight_cny:text(underweight),allocated_budget_cny:"0"};
  });
  const deficitTotal=deficits.reduce((sum,row)=>sum.add(row),new D(0));let status:CashDecision["status"]="no_eligible_underweight",command:JournalCommand|null=null;
  if(Object.keys(state.open_batches).length)status="waiting_for_pending_batches";
  else if(deployable.isZero())status="no_deployable_cash";
  else if(!deficitTotal.isZero()) {
    const identity=buyDigest({program_hash:program.program_hash,decision_id:value.decision_id}),orders:BuyInput["orders"]=[];
    program.targets.forEach((target,index)=>{
      const deficit=deficits[index],budget=(deployable.gte(deficitTotal)?deficit:deficit.mul(deployable).div(deficitTotal)).toDecimalPlaces(2,D.ROUND_DOWN);
      rows[index].allocated_budget_cny=text(budget);
      if(!budget.isZero())orders.push({order_id:"o:"+buyDigest({decision:identity,listing_id:target.listing_id}),listing_id:target.listing_id,market:"CN",currency:"CNY",
        allocated_budget_cny:text(budget),quantity_step:target.quantity_step,decision_quote:structuredClone(value.marks[index].quote),execute_at:value.execute_at,expires_at:value.expires_at});
    });
    if(orders.length) {
      const input:BuyInput={schema_version:"bounded-cash-buy-input-v1",qualification:"synthetic_test_only",batch_id:"b:"+identity,decision_at:value.at,
        policy:structuredClone(journal.declaration.policy),settled_cash_cny:state.settled_cash_cny,unsettled_receivable_cny:"0",existing_reservations:[],orders};
      command={command_id:"cmd:"+identity,at:value.at,kind:"buy_plan",payload:{input,plan:planBuys(input)}};
      appendJournalCommand(journal,command);status="cash_only_underweight_plan";
    }
  }
  const body={schema_version:"bounded-cash-decision-v1" as const,qualification:"synthetic_test_only" as const,implementation_hash:projectionImplementationHash(),
    program_hash:program.program_hash,input_hash:buyDigest(value),state_hash:state.state_hash,at:value.at,status,nav_cny:text(total),cash_floor_cny:text(floor),
    deployable_cny:text(deployable),allocations:rows,command,live_advice_eligible:false as const};
  const result={...body,decision_hash:buyDigest(body)};contract(result,"decision");return result;
}
export function valueJournal(value:CashValuationInput):CashValuationReport {
  contract(value,"valuationInput");const {program,journal}=value,finalState=context(program,journal);
  requireValue(value.event_frames.length===journal.events.length,"EVENT_FRAME_COUNT_MISMATCH");
  let prefix=newJournal(journal.declaration),state=replayJournal(prefix),units=new D(0),peak=new D(1),maximum=new D(0);
  const samples:Sample[]=[];
  const quoteIdentities=new Map<string,string>();
  function sample(frame:ValuationFrame,event?:JournalEvent) {
    requireValue(time(frame.at)>=time(state.last_event_at),"TIME_REVERSED");
    const marks=prices(program,journal,frame.marks,frame.at),before=nav(state,marks).total,unitBefore=units.isZero()?new D(1):before.div(units);
    for(const mark of frame.marks) {
      const identity=mark.quote.id,content=buyDigest(mark);
      requireValue(!quoteIdentities.has(identity)||quoteIdentities.get(identity)===content,"QUOTE_ID_REBOUND");quoteIdentities.set(identity,content);
    }
    requireValue(unitBefore.gt(0),"ZERO_CAPITAL_WITH_UNITS");peak=D.max(peak,unitBefore);maximum=D.max(maximum,new D(1).sub(unitBefore.div(peak)));
    let flow=new D(0);
    if(event) {
      requireValue(frame.at===event.at,"EVENT_FRAME_TIME_MISMATCH");
      if(event.kind==="cash_contribution") {flow=new D(event.payload.amount_cny);units=units.add(flow.div(unitBefore));}
      const command={command_id:event.command_id,at:event.at,kind:event.kind,payload:event.payload} as JournalCommand;
      prefix=appendJournalCommand(prefix,command);state=replayJournal(prefix);
      requireValue(state.state_hash===event.after_state_hash,"EVENT_STATE_MISMATCH");
    }
    const after=nav(state,marks),unitAfter=units.isZero()?new D(1):after.total.div(units);peak=D.max(peak,unitAfter);
    const drawdown=new D(1).sub(unitAfter.div(peak));maximum=D.max(maximum,drawdown);
    samples.push({revision:state.revision,at:frame.at,state_hash:state.state_hash,marks_hash:buyDigest(frame.marks),pre_flow_nav_cny:text(before),external_flow_cny:text(flow),
      nav_cny:text(after.total),settled_cash_cny:state.settled_cash_cny,reserved_cny:state.reserved_cny,position_value_cny:text(after.positions),units:ratio(units),
      unit_nav:units.isZero()?null:ratio(unitAfter),total_return:units.isZero()?null:ratio(unitAfter.sub(1)),drawdown:units.isZero()?null:ratio(drawdown)});
  }
  journal.events.forEach((event,index)=>sample(value.event_frames[index],event));sample(value.final_frame);
  requireValue(buyDigest(state)===buyDigest(finalState),"FINAL_STATE_MISMATCH");
  const last=samples.at(-1)!,contributed=state.total_contributions_cny,profit=text(new D(last.nav_cny).sub(contributed));
  const body={schema_version:"bounded-cash-valuation-report-v1" as const,qualification:"synthetic_test_only" as const,implementation_hash:projectionImplementationHash(),
    program_hash:program.program_hash,input_hash:buyDigest(value),journal_head_hash:journal.head_hash,valuation_basis:"terminal_processing_not_execution_settlement" as const,
    allocation_policy_compliance_verified:false as const,
    samples,total_contributions_cny:contributed,end_nav_cny:last.nav_cny,net_profit_cny:profit,return_status:units.isZero()?"no_contributed_capital" as const:"calculated" as const,
    cash_flow_adjusted_return:last.total_return,sampled_max_drawdown:units.isZero()?null:ratio(maximum),
    cash_reference:{kind:"same_flow_cash_zero_interest_zero_cost" as const,nav_cny:contributed,total_return:units.isZero()?null:"0" as const,difference_cny:profit,investable_market_benchmark:false as const},
    execution_failure_count:state.execution_failure_count,open_batch_count:Object.keys(state.open_batches).length,live_advice_eligible:false as const};
  const result={...body,report_hash:buyDigest(body)};contract(result,"report");return result;
}
export function verifyCashDecision(value:CashDecisionInput,result:CashDecision) {
  contract(result,"decision");requireValue(buyDigest(result)===buyDigest(decideCash(value)),"DECISION_REPLAY_MISMATCH");
}
export function verifyValuationReport(value:CashValuationInput,result:CashValuationReport) {
  contract(result,"report");requireValue(buyDigest(result)===buyDigest(valueJournal(value)),"REPORT_REPLAY_MISMATCH");
}
