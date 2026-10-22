import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import DecimalJs from "decimal.js";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {basename,resolve} from "node:path";
import buySchema from "../../../../contracts/v1/bounded-cash-buy.schema.json";
import journalSchema from "../../../../contracts/v1/bounded-cash-journal.schema.json";
import projectionSchema from "../../../../contracts/v1/bounded-cash-projection.schema.json";
import schema from "../../../../contracts/v1/bounded-cash-run.schema.json";
import {buyDigest,executeBuys,type BuyOutcome} from "./bounded-cash";
import {appendJournalCommand,newJournal,replayJournal,type CashJournal,type CashState,type JournalCommand,type StudyDeclaration} from "./journal";
import {decideCash,fundingCommands,projectionImplementationHash,valueJournal,type CashDecision,type CashProgram,type CashValuationReport,type Mark,type ValuationFrame} from "./projection";

const ENGINE="bounded-cash-run-sandbox-v1";
const D=DecimalJs.clone({precision:160,rounding:DecimalJs.ROUND_HALF_EVEN,toExpNeg:-200,toExpPos:200});
const ajv=new Ajv2020({strict:true,strictRequired:false});addFormats(ajv);
for(const value of [buySchema,journalSchema,projectionSchema,schema])ajv.addSchema(value);
const sources=["contracts/v1/bounded-cash-run.schema.json","worker/execution_sandbox/study_run.py","web/src/server/execution-sandbox/study-run.ts"];
type DecisionPoint={decision_id:string;at:string;execute_at:string;expires_at:string};
type ExecutionObservation=Omit<BuyOutcome["observations"][number],"order_id">&{listing_id:string};
export type RunFrame={at:string;marks:Mark[];execution_observations:ExecutionObservation[]};
export type ProgramSide={declaration:StudyDeclaration;program:CashProgram};
export type ProgramRunInput=ProgramSide&{schema_version:"bounded-cash-run-input-v1";qualification:"synthetic_test_only";frames:RunFrame[];decision_points:DecisionPoint[]};
type DecisionRecord={decision_id:string;before_head_hash:string;after_head_hash:string;decision:CashDecision};
type CurvePoint={at:string;revision:number;state_hash:string;nav_cny:string;settled_cash_cny:string;reserved_cny:string;position_value_cny:string;
  total_contributions_cny:string;units:string;unit_nav:string|null;total_return:string|null;drawdown:string|null};
export type ProgramRunResult={schema_version:"bounded-cash-run-result-v1";qualification:"synthetic_test_only";implementation_hash:string;input_hash:string;program_hash:string;
  decision_policy_compliance_verified:true;valuation_basis:"terminal_processing_not_execution_settlement";journal:CashJournal;decisions:DecisionRecord[];curve:CurvePoint[];
  event_valuation:CashValuationReport;sampled_max_drawdown:string|null;fees_cny:string;rounding_cny:string;total_debited_cny:string;execution_failure_count:number;
  all_planned_batches_terminal:true;live_advice_eligible:false;result_hash:string};
export type ProgramComparisonInput={schema_version:"bounded-cash-comparison-input-v1";qualification:"synthetic_test_only";candidate:ProgramSide;benchmark:ProgramSide;frames:RunFrame[];decision_points:DecisionPoint[]};
export type ProgramComparison={schema_version:"bounded-cash-comparison-v1";qualification:"synthetic_test_only";implementation_hash:string;input_hash:string;
  candidate:ProgramRunResult;benchmark:ProgramRunResult;same_recorded_cash_flows:true;same_execution_policy:true;
  benchmark_kind:"simulated_cash_only_market_portfolio_not_index_or_actual_execution";end_nav_difference_cny:string;excess_cash_flow_adjusted_return:string|null;
  parameters_independently_preregistered:false;live_advice_eligible:false;comparison_hash:string};

function requireValue(value:unknown,code:string):asserts value {if(!value)throw new Error("CASH_RUN_"+code);}
function contract(value:unknown,kind:string) {requireValue(ajv.getSchema(schema.$id+"#/$defs/"+kind)!(value),"CONTRACT_INVALID");}
function text(value:DecimalJs) {return value.isZero()?"0":value.toFixed();}
function ratio(value:DecimalJs) {return text(value.toDecimalPlaces(12));}
function time(value:string) {
  const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/.exec(value);requireValue(match&&!value.startsWith("0000"),"INSTANT_INVALID");
  const ms=Date.parse(match[1]+"Z");requireValue(Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,19)===match[1],"INSTANT_INVALID");return BigInt(ms)*1000n+BigInt(match[2]);
}
export function runImplementationHash() {
  const root=resolve(basename(process.cwd())==="web"?"..":".");
  return buyDigest({engine_version:ENGINE,projection_implementation_hash:projectionImplementationHash(),sources:Object.fromEntries(sources.map(path=>
    [path,createHash("sha256").update(readFileSync(resolve(root,path))).digest("hex")]))});
}
function framePrices(program:CashProgram,declaration:StudyDeclaration,frame:RunFrame) {
  requireValue(buyDigest(frame.marks.map(row=>row.listing_id))===buyDigest(program.targets.map(row=>row.listing_id)),"MARK_UNIVERSE_OR_ORDER_INVALID");
  requireValue(new Set(frame.marks.map(row=>row.quote.id)).size===frame.marks.length,"DUPLICATE_QUOTE_ID");const at=time(frame.at);
  return Object.fromEntries(frame.marks.map(row=>{
    const quote=row.quote,observed=time(quote.observed_at),known=time(quote.known_at),valid=time(quote.valid_until);
    requireValue(observed<=known&&known<=at&&at<valid&&at-observed<=BigInt(declaration.policy.max_quote_age_seconds)*1000000n,"MARK_UNAVAILABLE");
    requireValue(new D(quote.close).gt(0),"PRICE_NOT_POSITIVE");return [row.listing_id,new D(quote.close)];
  }));
}
function nav(state:CashState,prices:Record<string,DecimalJs>) {
  const positions=Object.entries(state.positions).reduce((sum,[id,quantity])=>sum.add(new D(quantity).mul(prices[id])),new D(0));
  return {total:new D(state.settled_cash_cny).add(positions),positions};
}
export function runProgram(value:ProgramRunInput):ProgramRunResult {
  contract(value,"input");const {program,declaration,frames,decision_points:points}=value;
  let journal=newJournal(declaration),state=replayJournal(journal);const funds=fundingCommands(program);
  requireValue(program.journal_declaration_hash===journal.declaration_hash&&program.registered_at===declaration.registered_at,"JOURNAL_BINDING_MISMATCH");
  const frameTimes=frames.map(row=>row.at),pointTimes=points.map(row=>row.at),timeSet=new Set(frameTimes);
  requireValue(buyDigest(frameTimes)===buyDigest([...timeSet].sort())&&frameTimes.every(at=>time(at)>=time(program.registered_at)),"FRAME_ORDER_INVALID");
  requireValue(buyDigest(pointTimes)===buyDigest([...new Set(pointTimes)].sort())&&new Set(points.map(row=>row.decision_id)).size===points.length,"DECISION_ORDER_OR_ID_INVALID");
  requireValue(points.every(row=>timeSet.has(row.at)&&timeSet.has(row.expires_at)&&time(row.at)<time(row.execute_at)&&time(row.execute_at)<=time(row.expires_at)),"DECISION_WINDOW_UNCOVERED");
  requireValue(funds.filter(row=>row.at<=frames.at(-1)!.at).every(row=>timeSet.has(row.at)),"FUNDING_FRAME_MISSING");
  const decisionsByTime=new Map(points.map(row=>[row.at,row]));let units=new D(0),peak=new D(1),maximum=new D(0),fees=new D(0),rounding=new D(0),debited=new D(0);
  const eventFrames:ValuationFrame[]=[],curve:CurvePoint[]=[],records:DecisionRecord[]=[],markIds=new Map<string,string>(),executionIds=new Map<string,string>();
  for(const frame of frames) {
    const at=frame.at,prices=framePrices(program,declaration,frame);
    for(const mark of frame.marks) {
      const identity=mark.quote.id,content=buyDigest(mark);requireValue(!markIds.has(identity)||markIds.get(identity)===content,"QUOTE_ID_REBOUND");markIds.set(identity,content);
    }
    const observations=new Map(frame.execution_observations.map(row=>[row.listing_id,row]));
    requireValue(observations.size===frame.execution_observations.length,"DUPLICATE_EXECUTION_LISTING");
    requireValue([...observations.keys()].every(id=>Object.hasOwn(prices,id)),"EXECUTION_UNIVERSE_INVALID");
    for(const row of observations.values()) {
      requireValue(time(row.observed_at)<=time(row.known_at)&&time(row.known_at)<=time(at)&&new D(row.close).gt(0),"EXECUTION_EVIDENCE_UNAVAILABLE");
      const identity=row.quote_id,content=buyDigest(row);requireValue(!executionIds.has(identity)||executionIds.get(identity)===content,"EXECUTION_QUOTE_ID_REBOUND");executionIds.set(identity,content);
    }
    function markUnit() {
      const marked=nav(state,prices),unit=units.isZero()?new D(1):marked.total.div(units);requireValue(unit.gt(0),"ZERO_CAPITAL_WITH_UNITS");
      if(!units.isZero()) {peak=D.max(peak,unit);maximum=D.max(maximum,new D(1).sub(unit.div(peak)));}
      return {...marked,unit};
    }
    function apply(command:JournalCommand) {
      const unit=markUnit().unit;
      if(command.kind==="cash_contribution")units=units.add(new D(command.payload.amount_cny).div(unit));
      journal=appendJournalCommand(journal,command);state=replayJournal(journal);eventFrames.push({at,marks:structuredClone(frame.marks)});markUnit();
    }
    markUnit();
    const pending=Object.entries(state.open_batches).map(([identity,batch])=>({identity,batch,terminal:batch.plan.orders.map(row=>row.expires_at).sort().at(-1)!}))
      .sort((a,b)=>a.terminal<b.terminal?-1:a.terminal>b.terminal?1:a.identity<b.identity?-1:a.identity>b.identity?1:0);
    for(const {identity,batch,terminal} of pending) {
      requireValue(terminal>=at,"MISSED_BATCH_TERMINAL");if(terminal!==at)continue;
      const actual:BuyOutcome["observations"]=[];
      for(const order of batch.plan.orders) {
        if(order.status!=="planned")continue;
        const observed=observations.get(order.listing_id);if(observed) {const {listing_id:ignored,...rest}=observed;void ignored;actual.push({order_id:order.order_id,...rest});}
      }
      const outcome:BuyOutcome={schema_version:"bounded-cash-buy-outcome-input-v1",qualification:"synthetic_test_only",evaluated_at:at,observations:actual};
      const result=executeBuys(batch.input,batch.plan,outcome);
      fees=fees.add(result.orders.reduce((sum,row)=>sum.add(row.fee_cny),new D(0)));rounding=rounding.add(result.orders.reduce((sum,row)=>sum.add(row.rounding_cny),new D(0)));
      debited=debited.add(result.total_debited_cny);
      apply({command_id:"resolve:"+buyDigest(identity),at,kind:"buy_resolution",payload:{batch_id:identity,outcome,result}});
    }
    for(const funding of funds)if(funding.at===at)apply(funding);
    const point=decisionsByTime.get(at);
    if(point) {
      const before=journal.head_hash,decision=decideCash({schema_version:"bounded-cash-decision-input-v1",qualification:"synthetic_test_only",program,journal,...point,marks:structuredClone(frame.marks)});
      if(decision.command)apply(decision.command);
      records.push({decision_id:point.decision_id,before_head_hash:before,after_head_hash:journal.head_hash,decision});
    }
    const marked=markUnit();curve.push({at,revision:state.revision,state_hash:state.state_hash,nav_cny:text(marked.total),settled_cash_cny:state.settled_cash_cny,
      reserved_cny:state.reserved_cny,position_value_cny:text(marked.positions),total_contributions_cny:state.total_contributions_cny,units:ratio(units),
      unit_nav:units.isZero()?null:ratio(marked.unit),total_return:units.isZero()?null:ratio(marked.unit.sub(1)),drawdown:units.isZero()?null:ratio(new D(1).sub(marked.unit.div(peak)))});
  }
  requireValue(Object.keys(state.open_batches).length===0,"NONTERMINAL_BATCHES");
  const last=frames.at(-1)!,valuation=valueJournal({schema_version:"bounded-cash-valuation-input-v1",qualification:"synthetic_test_only",program,journal,event_frames:eventFrames,final_frame:{at:last.at,marks:last.marks}});
  requireValue(valuation.end_nav_cny===curve.at(-1)!.nav_cny&&valuation.cash_flow_adjusted_return===curve.at(-1)!.total_return,"VALUATION_REPLAY_MISMATCH");
  const body={schema_version:"bounded-cash-run-result-v1" as const,qualification:"synthetic_test_only" as const,implementation_hash:runImplementationHash(),input_hash:buyDigest(value),program_hash:program.program_hash,
    decision_policy_compliance_verified:true as const,valuation_basis:"terminal_processing_not_execution_settlement" as const,journal,decisions:records,curve,event_valuation:valuation,
    sampled_max_drawdown:units.isZero()?null:ratio(maximum),fees_cny:text(fees),rounding_cny:text(rounding),total_debited_cny:text(debited),execution_failure_count:state.execution_failure_count,
    all_planned_batches_terminal:true as const,live_advice_eligible:false as const};
  const result={...body,result_hash:buyDigest(body)};contract(result,"result");return result;
}
export function comparePrograms(value:ProgramComparisonInput):ProgramComparison {
  contract(value,"comparisonInput");const left=value.candidate,right=value.benchmark;
  requireValue(left.declaration.registered_at===right.declaration.registered_at,"COMPARISON_START_MISMATCH");
  requireValue(buyDigest(left.declaration.policy)===buyDigest(right.declaration.policy),"COMPARISON_EXECUTION_POLICY_MISMATCH");
  requireValue(buyDigest(left.program.funding_schedule)===buyDigest(right.program.funding_schedule),"COMPARISON_CASH_FLOW_MISMATCH");
  requireValue(left.program.targets.length===right.program.targets.length&&left.program.targets.every((row,index)=>row.listing_id===right.program.targets[index].listing_id&&new D(row.quantity_step).eq(right.program.targets[index].quantity_step)),"COMPARISON_UNIVERSE_OR_STEP_MISMATCH");
  const sides=[left,right].map(side=>runProgram({schema_version:"bounded-cash-run-input-v1",qualification:"synthetic_test_only",...side,frames:value.frames,decision_points:value.decision_points}));
  const [candidate,benchmark]=sides,a=candidate.event_valuation,b=benchmark.event_valuation;
  const body={schema_version:"bounded-cash-comparison-v1" as const,qualification:"synthetic_test_only" as const,implementation_hash:runImplementationHash(),input_hash:buyDigest(value),candidate,benchmark,
    same_recorded_cash_flows:true as const,same_execution_policy:true as const,benchmark_kind:"simulated_cash_only_market_portfolio_not_index_or_actual_execution" as const,
    end_nav_difference_cny:text(new D(a.end_nav_cny).sub(b.end_nav_cny)),excess_cash_flow_adjusted_return:a.cash_flow_adjusted_return!==null&&b.cash_flow_adjusted_return!==null?ratio(new D(a.cash_flow_adjusted_return).sub(b.cash_flow_adjusted_return)):null,
    parameters_independently_preregistered:false as const,live_advice_eligible:false as const};
  const result={...body,comparison_hash:buyDigest(body)};contract(result,"comparison");return result;
}
export function verifyProgramRun(value:ProgramRunInput,result:ProgramRunResult) {
  contract(result,"result");requireValue(buyDigest(result)===buyDigest(runProgram(value)),"FULL_RUN_REPLAY_MISMATCH");
}
export function verifyProgramComparison(value:ProgramComparisonInput,result:ProgramComparison) {
  contract(result,"comparison");requireValue(buyDigest(result)===buyDigest(comparePrograms(value)),"COMPARISON_REPLAY_MISMATCH");
}
