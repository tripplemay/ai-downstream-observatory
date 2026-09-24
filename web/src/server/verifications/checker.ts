import { canonical, hash } from "../ledger/service";
import { Decimal } from "../ledger/decimal";
import { parseStrictJson } from "../strict-json";
import { evidenceInvalid, verificationInstant } from "./binding";
import { bytesHash } from "./source";
import { VERIFICATION_CHECK_ID, VERIFICATION_SUITE_VERSION, type VerificationCheckResult } from "./types";

type Row = Record<string, unknown>;
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
export function object(value: unknown, keys?: string[]): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw evidenceInvalid();
  if (keys && !same(Object.keys(value).sort(), [...keys].sort())) throw evidenceInvalid();
  return value as Row;
}
function rows(value: unknown, count?: number): Row[] {
  if (!Array.isArray(value) || count !== undefined && value.length !== count) throw evidenceInvalid();
  return value.map(row => object(row));
}
function text(value: unknown): string { if (typeof value !== "string") throw evidenceInvalid(); return value; }
function identities(row: Row, ...keys: string[]): void {
  for (const key of keys) { const value = text(row[key]); if (!value || [...value].length > 160) throw evidenceInvalid(); }
}
function decimal(value: unknown): Decimal {
  if (typeof value !== "string" || value.length > 100 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) throw evidenceInvalid();
  return new Decimal(value);
}
export function strictEvidenceJson(raw: string): unknown {
  if (Buffer.byteLength(raw, "utf8") > 1048576) throw evidenceInvalid();
  const value = parseStrictJson(raw);
  // Reject lexical floats too: Python must not interpret 1e0 differently from 1.
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|(-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/gu;
  for (const token of raw.matchAll(tokens)) if (token[1] && /[.eE]/u.test(token[1])) throw evidenceInvalid();
  const visit = (item: unknown): void => {
    if (typeof item === "number" && !Number.isSafeInteger(item)) throw evidenceInvalid();
    if (typeof item === "string" && /[\uD800-\uDFFF]/u.test(item)) throw evidenceInvalid();
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) { visit(key); visit(child); }
  };
  visit(value); return value;
}
function json(value: unknown): Row { return object(strictEvidenceJson(text(value))); }
const left = "2026-01-01T12:00:00.000000Z", right = "2026-01-03T12:00:00.000000Z", known = "2026-01-04T00:00:00.000000Z";
function quality(value: unknown, portfolio: string, cutoff: string, start: string | null = null): boolean {
  const expected = { schema_version: "ledger-fact-quality-v1", portfolio_id: portfolio, ledger_revision: 2, cutoff_at: cutoff, knowledge_at: known, mode: "restated",
    period_start: start, nav_quality: "complete", performance_quality: "complete", attribution_quality: "complete", dividends: [], corporate_actions: [], event_hashes: {}, issues: [] };
  return same(value, { ...expected, binding_id: hash(expected) });
}

/** Reconstruct cash and flows independently; never use a stored PASS or production profit as the oracle. */
export function checkVerificationArtifact(body: Buffer, expectedHash?: string): { artifact: Row; result: VerificationCheckResult } {
  if (!Buffer.isBuffer(body) || !body.length || body.length > 1048576 || expectedHash !== undefined && bytesHash(body) !== expectedHash) throw evidenceInvalid();
  const artifact = object(strictEvidenceJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body)));
  const allowed = ["schema_version", "check_id", "fixture_version", "data_provenance", "fixture", "ledger", "valuations", "performance", "runtime", "process"];
  const keys = Object.keys(artifact).sort();
  if (!same(keys, [...allowed].sort()) && !same(keys, [...allowed, "binding", "started_at", "finished_at"].sort())) throw evidenceInvalid();
  const runtime = object(artifact.runtime, ["python_version", "node_version"]);
  if (artifact.schema_version !== "verification-execution-artifact-v2" || artifact.check_id !== VERIFICATION_CHECK_ID || artifact.fixture_version !== VERIFICATION_SUITE_VERSION
    || artifact.data_provenance !== "synthetic" || !same(artifact.process, { exit_code: 0 })
    || !Object.values(runtime).every(value => typeof value === "string" && value.length >= 1 && value.length <= 64)) throw evidenceInvalid();
  const fixture = object(artifact.fixture, ["portfolio_id", "account_id", "timeline"]), portfolio = text(fixture.portfolio_id), account = text(fixture.account_id);
  if (![portfolio, account].every(id => /^[a-f0-9-]{36}$/u.test(id)) || !same(fixture.timeline, { left, right, now: known })) throw evidenceInvalid();
  const ledger = object(artifact.ledger, ["events", "postings", "head", "audits"]), head = object(ledger.head);
  const events = rows(ledger.events, 2), postings = rows(ledger.postings, 4), audits = rows(ledger.audits, 4), snapshots = rows(artifact.valuations, 2);
  const performance = object(object(artifact.performance, ["run"]).run);
  for (const event of events) { identities(event, "id", "portfolio_id", "account_id", "idempotency_key"); text(event.reason); }
  for (const posting of postings) identities(posting, "id", "event_id", "account_id");
  for (const audit of audits) identities(audit, "id", "portfolio_id", "actor_id", "object_id");
  identities(performance, "id", "portfolio_id");
  const assertions: VerificationCheckResult["assertions"] = [];
  const record = (id: string, passed: boolean) => assertions.push({ id, status: passed ? "pass" : "fail" });
  let eventsOk = head.portfolio_id === portfolio && head.revision === 2 && new Set(events.map(e => e.id)).size === 2;
  const kinds = ["opening_cash", "deposit"], values = ["100.25", "50.125"], times = ["2026-01-01T00:00:00.000Z", "2026-01-02T12:00:00.000Z"];
  events.forEach((event, index) => {
    const payload = json(event.payload_json), semantic = Object.fromEntries(Object.entries(payload).filter(([key]) => !["expected_revision", "idempotency_key"].includes(key)));
    identities(payload, "portfolio_id", "idempotency_key"); text(payload.reason);
    eventsOk = eventsOk && event.portfolio_id === portfolio && event.account_id === account && event.event_type === kinds[index] && event.ledger_revision === index + 1
      && event.effective_at === times[index] && event.recorded_at === times[index] && event.time_precision === "second" && event.source_timezone === "UTC"
      && event.actor_id === "SYNTHETIC-VERIFICATION-FIXTURE" && event.reversal_of === null && event.source_id === "synthetic-cash-neutrality-v1"
      && event.source_event_id === kinds[index] && event.payload_hash === hash(semantic)
      && same(payload.fact, { type: kinds[index], account_id: account, currency: "CNY", amount: values[index] })
      && payload.portfolio_id === portfolio && payload.expected_revision === index
      && ["effective_at", "time_precision", "source_timezone", "source_id", "source_event_id", "idempotency_key", "reason"].every(key => payload[key] === event[key]);
  });
  record("fixed_synthetic_ledger", eventsOk);
  let postingsOk = new Set(postings.map(p => p.id)).size === 4;
  events.forEach((event, index) => {
    const entries = postings.filter(p => p.event_id === event.id), positive = decimal(values[index]);
    const amounts = Object.fromEntries(entries.map(p => [text(p.ledger_account), decimal(p.amount).toFixed()]));
    const expected = { cash_settled: positive.toFixed(), [index ? "external_capital" : "opening_equity"]: positive.negated().toFixed() };
    postingsOk = postingsOk && entries.length === 2 && entries.every(p => p.account_id === account && p.currency === "CNY")
      && same(amounts, expected) && entries.reduce((sum, p) => sum.plus(decimal(p.amount)), new Decimal(0)).isZero();
  });
  record("balanced_postings", postingsOk);
  let auditsOk = new Set(audits.map(a => a.id)).size === 4 && audits.every(a => a.portfolio_id === portfolio && a.actor_id === "SYNTHETIC-VERIFICATION-FIXTURE")
    && audits.some(a => a.action === "create_portfolio" && a.object_id === portfolio) && audits.some(a => a.action === "create_account" && a.object_id === account);
  for (const event of events) {
    const matches = audits.filter(a => a.action === "record_fact" && a.object_id === event.id), audit = matches[0];
    auditsOk = auditsOk && matches.length === 1 && audit.object_type === "ledger_event" && audit.ledger_revision === event.ledger_revision
      && audit.created_at === event.recorded_at && json(audit.payload_json).digest === event.payload_hash;
  }
  record("normal_service_audit", auditsOk);
  const navs: Decimal[] = [], runs: Row[] = [];
  let valuationOk = true;
  snapshots.forEach((snapshot, index) => {
    object(snapshot, ["run", "items"]);
    const run = object(snapshot.run), item = rows(snapshot.items, 1)[0], at = index ? right : left, manifest = json(run.market_manifest);
    identities(run, "id", "portfolio_id"); identities(item, "id", "run_id", "account_id");
    const nav = postings.filter(p => p.ledger_account === "cash_settled" && events.some(e => e.id === p.event_id && verificationInstant(text(e.effective_at)) <= at))
      .reduce((sum, p) => sum.plus(decimal(p.amount)), new Decimal(0));
    navs.push(nav); runs.push(run);
    const rules = { schema_version: "valuation-rules-v1", approved: true, approval_evidence: "SYNTHETIC fixed verification fixture; not investment approval",
      price_scope_by_market: {}, expected_sessions: {}, corporate_actions_complete: {}, max_fx_age_seconds: 0 };
    valuationOk = valuationOk && run.portfolio_id === portfolio && run.ledger_revision === 2 && run.quality === "complete" && run.cutoff_at === at && run.created_at === known
      && run.method_version === "decimal-nav-cny-v4:restated" && decimal(run.nav_cny).eq(nav) && manifest.mode === "restated" && manifest.rules_hash === hash(manifest.rules)
      && same(manifest.rules, rules) && same(manifest.publications, {}) && quality(manifest.ledger_fact_quality, portfolio, at)
      && item.run_id === run.id && item.account_id === account && item.currency === "CNY" && item.item_type === "cash_settled" && item.quality === "complete"
      && item.listing_id === null && decimal(item.amount).eq(nav) && decimal(item.value_cny).eq(nav) && item.fx_rate === "1"
      && same(json(item.evidence_json), { fx_observation_id: null, ledger_revision: 2 });
  });
  record("real_valuation_binding", valuationOk && new Set(runs.map(r => r.id)).size === 2);
  const manifest = json(performance.market_manifest), output = json(performance.result_json), returned = object(output.return);
  for (const reference of rows(manifest.valuations)) identities(reference, "id");
  const external = postings.find(p => p.ledger_account === "external_capital"); if (!external) throw evidenceInvalid();
  const flow = decimal(external.amount).negated(), profit = navs[1].minus(navs[0]).minus(flow), evidence = rows(manifest.external_flow_evidence), fx = evidence[0];
  for (const proof of evidence) identities(proof, "event_id", "posting_id", "portfolio_id");
  const references = runs.map(run => ({ id: run.id, content_hash: hash(run) }));
  const neutral = performance.portfolio_id === portfolio && performance.ledger_revision === 2 && performance.period_start === left && performance.period_end === right
    && performance.created_at === known && same(manifest.valuations, references) && manifest.mode === "restated" && manifest.ledger_revision === 2 && manifest.evaluation_timezone === "UTC"
    && same(manifest.market_heads, {}) && manifest.flow_fx_rules === null && manifest.flow_fx_rules_hash === null
    && same(manifest.ledger_fact_quality, output.ledger_fact_quality) && rows(manifest.ledger_fact_quality).length === 2
    && rows(manifest.ledger_fact_quality).every((proof, index) => quality(proof, portfolio, index ? right : left))
    && same(manifest.period_fact_quality, output.period_fact_quality) && quality(manifest.period_fact_quality, portfolio, right, left)
    && evidence.length === 1 && same(evidence, output.external_flow_evidence) && fx.event_id === events[1].id && fx.event_hash === hash(events[1])
    && fx.posting_id === external.id && fx.posting_hash === hash(external) && fx.binding_id === hash(Object.fromEntries(Object.entries(fx).filter(([key]) => key !== "binding_id")))
    && fx.portfolio_id === portfolio && fx.event_ledger_revision === 2 && fx.event_payload_hash === events[1].payload_hash && fx.quality === "complete"
    && fx.currency === "CNY" && fx.source_timezone === "UTC" && fx.time_precision === "second" && fx.effective_at === events[1].effective_at
    && fx.flow_time === "2026-01-02T12:00:00.000000Z" && fx.evaluation_date === "2026-01-02" && fx.mode === "restated" && fx.fx_rate === "1"
    && fx.observation === null && fx.publication === null && same(fx.issues, []) && decimal(fx.amount_cny).eq(flow) && decimal(fx.amount_native).eq(flow)
    && profit.isZero() && decimal(output.net_profit_cny).eq(profit) && decimal(output.external_flow_cny).eq(flow) && decimal(returned.value).isZero();
  record("cash_contribution_neutrality", neutral);
  if (!Array.isArray(output.assumptions)) throw evidenceInvalid();
  record("honest_estimate_quality", performance.quality === "provisional" && performance.method === "modified_dietz_estimate" && returned.method === "linked_return_estimate"
    && returned.status === "ok" && same(output.issues, []) && same([...new Set(output.assumptions)].sort(), ["drawdown_measured_at_supplied_snapshots_only", "interval_flow_valuation_unavailable_modified_dietz"]));
  const issues = assertions.filter(a => a.status !== "pass").map(a => `ASSERTION_FAILED:${a.id}`);
  return { artifact, result: { schema_version: "verification-check-result-v2", check_id: VERIFICATION_CHECK_ID, status: issues.length ? "fail" : "pass", issues, assertions, gate_eligible: false, completed_requirements: [] } };
}
