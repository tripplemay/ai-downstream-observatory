import type Database from "better-sqlite3";
import Decimal from "decimal.js";
import { canonical, hash } from "../ledger/service";
import { amount } from "../ledger/decimal";
import { priceInstant as time } from "../market-price-source";
import { actionDeadline, actionNyParts } from "./action-source-parsers";
import { readActionReviewPreview } from "./action-review-lineage";
import { readManagedActionComparisonBasis, readManagedActionCurrentCaptures } from "./managed-action-source";
import { readRetainedMonitorHistory } from "./retained-monitor-history";
import { compareActionRestatement } from "./action-restatement-kernel";
import { validateActionCorrectionImpact } from "./kernel-contracts";

type Obj = Record<string, unknown>;
const Exact = Decimal.clone({ precision: 128, rounding: Decimal.ROUND_HALF_EVEN });
const kinds = ["issuer", "dividends", "splits"] as const;
function check(value: unknown, code: string): asserts value { if (!value) throw new Error("ACTION_CORRECTION_" + code); }
function object(value: unknown): Obj { check(value !== null && typeof value === "object" && !Array.isArray(value), "OBJECT"); return value as Obj; }
function rows(value: unknown): Obj[] { check(Array.isArray(value), "ROWS"); return value.map(object); }
function text(value: unknown): string { check(typeof value === "string", "TEXT"); return value; }
const day = (value: unknown) => actionNyParts(value).day;
const compareText = (a: unknown, b: unknown) => text(a) < text(b) ? -1 : text(a) > text(b) ? 1 : 0;
const number = (value: Decimal) => value.isZero() ? "0" : value.toFixed();
const clock = (value: unknown) => {
  const exact = time(value); check(exact % 1000n === 0n, "CLOCK_PRECISION"); return new Date(Number(exact / 1000n)).toISOString();
};

function ledger(facts: Obj, cutoff: unknown, knownAt: string) {
  const result: Obj[] = [];
  for (const event of rows(facts.events)) {
    const common = { listing_id: facts.listing_id, known_at: knownAt };
    if (time(event.at) <= time(cutoff)) {
      if (event.type === "split") result.push({ ...common, id: "split:" + event.id, kind: "split", effective_at: clock(event.at), ratio: event.ratio });
      else result.push({ ...common, id: "ex:" + event.id, kind: "dividend_ex", effective_at: clock(event.at), currency: "USD",
        net_per_unit: number(new Exact(text(event.gross_per_unit)).minus(text(event.tax_per_unit))), entitlement_id: "entitlement:" + event.id,
        tax_assumption_hash: hash({ tax_assumption: facts.tax_assumption, tax_per_unit: event.tax_per_unit }) });
    }
    if (event.type === "dividend" && time(event.pay_at) <= time(cutoff)) result.push({ ...common, id: "pay:" + event.id, kind: "dividend_payment",
      effective_at: clock(event.pay_at), currency: "USD", entitlement_id: "entitlement:" + event.id, ex_at: clock(event.at) });
  }
  return result;
}

function candidate(prior: Obj, changes: Obj[], current: ReturnType<typeof readManagedActionComparisonBasis>["previous"], decisions: Obj[], digest: string, at: string) {
  const historical = new Map(changes.filter(row => row.disposition === "historical_correction").map(row => [text(row.date), row]));
  check(historical.size > 0 && decisions.length === historical.size && new Set(decisions.map(row => row.date)).size === decisions.length
    && decisions.every(row => historical.has(text(row.date))), "DECISIONS_DIFFER");
  const facts = structuredClone(prior), changedDays = new Set<string>();
  for (const decision of decisions) {
    const date = text(decision.date), change = historical.get(date)!;
    check(text(decision.reason).trim(), "REASON_REQUIRED");
    check(!change.outside_common_coverage && kinds.every(kind => text(current[kind].source.range_start) <= date && date <= text(current[kind].source.range_end)), "SOURCE_COVERAGE_GAP");
    if (decision.choice === "retain") continue;
    changedDays.add(date); facts.events = rows(facts.events).filter(row => day(row.at) !== date);
    const issuer = current.issuer.records.filter(row => row.ex_date === date), dividends = current.dividends.records.filter(row => row.date === date),
      splits = current.splits.records.filter(row => row.date === date);
    if (decision.choice === "cancel") { check(!issuer.length && !dividends.length && !splits.length, "CANCELLATION_NOT_REPORTED"); continue; }
    const codes = issuer.map(row => row.issuer_type_code);
    check(new Set(codes).size === codes.length && codes.every(code => ["INC", "CGLT", "CGST"].includes(text(code)))
      && splits.length <= 1 && dividends.every(row => row.reported_currency === "USD"), "SOURCE_REQUIRES_REVIEW");
    const expected = [...(issuer.length ? ["dividend"] : []), ...(splits.length ? ["split"] : [])], answers = rows(decision.events);
    check(expected.length > 0 && answers.length === expected.length && new Set(answers.map(row => row.type)).size === answers.length
      && answers.every(row => expected.includes(text(row.type))), "EVENT_ANSWERS_DIFFER");
    for (const answer of answers) {
      check(day(answer.at) === date, "EVENT_DATE_DIFFERS");
      const identity = "correction-hypothesis:" + hash({ request_hash: digest, date, type: answer.type });
      const event: Obj = { id: identity, listing_id: facts.listing_id, type: answer.type, at: answer.at, published_at: at,
        source_evidence: "unapproved-correction-hypothesis:" + digest };
      if (answer.type === "dividend") {
        const gross = issuer.reduce((sum, row) => sum.plus(text(row.distribution_amount)), new Exact(0));
        amount(answer.tax_per_unit); amount(number(gross));
        check(new Set(issuer.map(row => row.pay_date)).size === 1 && day(answer.pay_at) === issuer[0].pay_date, "PAYMENT_DATE_DIFFERS");
        Object.assign(event, { gross_per_unit: number(gross), tax_per_unit: answer.tax_per_unit, pay_at: answer.pay_at });
      } else {
        const ratio = new Exact(text(splits[0].numerator)).div(text(splits[0].denominator));
        check(ratio.mul(text(splits[0].denominator)).eq(text(splits[0].numerator)), "SPLIT_RATIO_NOT_EXACT"); event.ratio = number(ratio); amount(event.ratio);
      }
      (facts.events as Obj[]).push(event);
    }
  }
  (facts.events as Obj[]).sort((a, b) => time(a.at) < time(b.at) ? -1 : time(a.at) > time(b.at) ? 1
    : compareText(a.type, b.type) || compareText(a.id, b.id));
  for (const event of rows(facts.events)) {
    check(text(facts.range_start) <= day(event.at) && day(event.at) <= text(facts.range_end), "FACT_EVENT_OUTSIDE_REVIEW_RANGE");
    if (event.type === "dividend") check(time(event.pay_at) >= time(event.at) && amount(event.tax_per_unit).gte(0)
      && amount(event.tax_per_unit).lte(text(event.gross_per_unit)), "TAX_OR_PAYMENT_INVALID");
    else check(amount(event.ratio).gt(0), "SPLIT_RATIO_INVALID");
  }
  return { facts, changedDays };
}

/** Expensive independent replay for an asynchronous review worker, not an HTTP GET. */
export function compareActionCorrectionImpact(db: Database.Database, workspace: string, actor: { id: string }, raw: unknown, now: string) {
  const owner = db.prepare("SELECT owner_id,revision FROM investor_workspaces WHERE id=?").get(workspace) as Obj | undefined;
  check(owner?.owner_id === actor.id, "OUT_OF_SCOPE"); validateActionCorrectionImpact("request", raw);
  const request = structuredClone(object(raw)), at = clock(now), digest = hash(request);
  check(Buffer.byteLength(canonical(request)) <= 524288, "REQUEST_LIMIT");
  return db.transaction(() => {
    check(owner.revision === request.expected_revision && Number.isSafeInteger(request.expected_revision), "VERSION_CHANGED");
    const view = readActionReviewPreview(db, workspace, actor.id, request.preview_id, at);
    check(view.preview.workspace_revision === request.expected_revision, "VERSION_CHANGED");
    check(view.status === "historical_correction_required", "HISTORICAL_CHANGE_REQUIRED");
    const basis = readManagedActionComparisonBasis(db, workspace, view.preview.authority_id, at);
    const history = readRetainedMonitorHistory(db, workspace, actor, text(request.model_id), at), listing = basis.grant.doc.listing_id;
    const targets = rows(history.definition.targets).filter(row => row.listing_id === listing);
    check(targets.length === 1 && targets[0].market === "US" && targets[0].currency === "USD", "MODEL_SCOPE_DIFFERS");
    // The view authenticates current captures. Read them again through the same
    // qualified resolver instead of trusting caller-supplied report fragments.
    const captures = readManagedActionCurrentCaptures(db, workspace, view.preview.authority_id, at);
    for (const row of view.changes) if (row.disposition === "historical_correction") check(kinds.every(kind =>
      text(basis.previous[kind].source.range_start) <= row.date && row.date <= text(basis.previous[kind].source.range_end)), "SOURCE_COVERAGE_GAP");
    const { facts, changedDays } = candidate(basis.prior.facts, view.changes, captures.snapshots, rows(request.decisions), digest, at);
    const cutoff = object(history.head.market_cutoffs).US;
    const affected = (row: Obj) => row.listing_id === listing && changedDays.has(day(row.kind === "dividend_payment" ? row.ex_at : row.effective_at));
    const economics = (values: Obj[]) => values.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "known_at")))
      .sort((a, b) => text(a.id) < text(b.id) ? -1 : text(a.id) > text(b.id) ? 1 : 0);
    check(hash(economics(history.original_actions.filter(affected))) === hash(economics(ledger(basis.prior.facts, cutoff, at).filter(affected))), "ORIGINAL_ACTION_BASIS_DIFFERS");
    const corrected = [...history.original_actions.filter(row => !affected(row)), ...ledger(facts, cutoff, at).filter(affected)]
      .sort((a, b) => text(a.id) < text(b.id) ? -1 : text(a.id) > text(b.id) ? 1 : 0);
    const coverage = structuredClone(object(history.head_projection.corporate_action_coverage));
    for (const [market, row] of Object.entries(coverage)) check(time(object(row).from) <= time(object(history.origin.initialized_at)[market]), "ORIGINAL_COVERAGE_GAP");
    const input = { schema_version: "investor-action-restatement-kernel-input-v1", ...Object.fromEntries(
      ["definition", "origin", "head", "origin_projection", "head_projection", "original_actions"].map(key => [key, history[key as keyof typeof history]])),
      corrected_actions: corrected, corrected_coverage: coverage, checked_at: at };
    const comparison = compareActionRestatement(input);
    const maximum = [...basis.limits, ...basis.historicalLimits, ...captures.limits, basis.grant.doc.valid_until].map(time).reduce((a, b) => a < b ? a : b);
    const until = [time(view.preview.valid_until), time(history.proof.source_valid_until), maximum,
      time(actionDeadline(at, basis.grant.doc.valid_until))].reduce((a, b) => a < b ? a : b);
    check(time(at) < until, "PREVIEW_EXPIRED");
    const result = { schema_version: "investor-action-correction-impact-result-v1", workspace_id: workspace, workspace_revision: request.expected_revision,
      model_id: request.model_id, preview_id: request.preview_id, request_hash: digest, draft_basis_hash: view.preview.draft_basis_hash,
      checked_at: at, valid_until: clock(new Date(Number(until / 1000n)).toISOString()), knowledge_not_before: at, original_history: history.proof,
      source_changes_hash: hash(view.changes), prior_facts_hash: hash(basis.prior.facts), hypothetical_events: facts.events,
      tax_assumption_hash: hash({ tax_assumption: facts.tax_assumption }), kernel_input_hash: hash(input), comparison,
      ignored_new_report_dates: [...new Set(view.changes.filter(row => row.disposition === "new_report").map(row => row.date))].sort(),
      coverage_basis: "original_reported_coverage_plus_explicit_hypotheses_not_new_admission", status: "hypothetical_impact_only_not_correction_consent",
      visibility: "private_owner_only_not_ai", economic_correction_approved: false, source_evidence_verified: false, checkpoint_created: false,
      monitoring_resumed: false, historical_observations_rewritten: false, trading_permission: false, provider_calls: 0, database_writes: 0 };
    validateActionCorrectionImpact("result", result); check(Buffer.byteLength(canonical(result)) <= 4194304, "RESULT_LIMIT"); return result;
  }).deferred();
}
