import type Database from "better-sqlite3";
import { fixedPolicyMonitorGap, fixedPolicyUnsupported, modelDefinitionHash } from "./fixed-policy";
import { hash } from "../ledger/service";
import { Decimal, amount } from "../ledger/decimal";
import { priceInstant } from "../market-price-source";
import { validateInvestorModelDocument, validateInvestorMonitorDataDocument } from "./kernel-contracts";
import { readInvestorDataSnapshot, readInvestorMonitorPriceSnapshot, type VerifiedSourceReview } from "./source-inputs";
import { parseStrictJson } from "../strict-json";
import { readEvidenceReference } from "./reference-evidence";

type Obj = Record<string, unknown>;
const zones: Record<string, string> = { CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" };
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_EVIDENCE_INVALID"); }
function obj(value: unknown): Obj { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function rows(value: unknown): Obj[] { check(Array.isArray(value)); return value.map(obj); }
function text(value: unknown): string { check(typeof value === "string"); return value; }
const time = (value: unknown) => priceInstant(text(value));
const min = (values: bigint[]) => values.reduce((a,b) => a < b ? a : b);
function milliseconds(value: bigint) { check(value % 1000n === 0n); return new Date(Number(value / 1000n)).toISOString(); }
function localParts(value: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const get = (key: string) => parts.find(part => part.type === key)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`;
}
function calendarHorizon(day: string, zone: string) {
  const desired = Date.parse(day + "T00:00:00Z") + 86400000;
  let candidate = desired;
  for (let count = 0; count < 3; count++) candidate += desired - Date.parse(localParts(candidate, zone));
  check(localParts(candidate, zone) === new Date(desired).toISOString().replace(".000Z", "Z"));
  return BigInt(candidate) * 1000n;
}
function segmentExpiry(db: Database.Database, workspace: string, snapshot: Obj) {
  const deadlines = [
    ...rows(snapshot.review_refs).map(ref => db.prepare("SELECT valid_until FROM investor_data_reviews WHERE id=? AND workspace_id=?").get(ref.review_id, workspace) as { valid_until: string } | undefined),
    ...rows(snapshot.capture_refs).map(ref => { const table = snapshot.schema_version === "investor-monitor-price-snapshot-v1" && ref.kind === "confirmed_sdk" ? "investor_confirmed_captures" : "investor_price_captures";
      const row = db.prepare(`SELECT retain_until FROM ${table} WHERE id=? AND workspace_id=?`).get(ref.capture_id, workspace) as { retain_until: string } | undefined; return row ? { valid_until: row.retain_until } : undefined; })
  ];
  check(deadlines.length > 0 && deadlines.every(Boolean));
  return milliseconds(min(deadlines.map(row => time(row!.valid_until))));
}

export function readInvestorMonitorEvidenceSource(db: Database.Database, workspace: string, modelId: string, inputId: string, now: string, evaluatedAt = now) {
  return db.transaction(() => {
    try {
      const model = db.prepare("SELECT * FROM investor_models WHERE id=? AND workspace_id=?").get(modelId, workspace) as Obj | undefined;
      const input = db.prepare("SELECT * FROM investor_monitor_evidence_inputs WHERE id=? AND workspace_id=? AND model_id=?").get(inputId, workspace, modelId) as Obj | undefined;
      check(model && input && input.source_qualification === "owner_reviewed_reconstructed" && time(input.created_at) <= time(now));
      const definition = obj(parseStrictJson(text(model.document_json))), document = obj(parseStrictJson(text(input.document_json)));
      validateInvestorModelDocument("definition", definition); validateInvestorMonitorDataDocument("input", document);
      check(hash(definition) === model.content_hash && hash(document) === input.content_hash
        && definition.model_id === modelId && definition.profile_id === model.profile_id && definition.plan_id === model.plan_id
        && definition.created_at === model.created_at && document.created_at === input.created_at && document.valid_until === input.valid_until);
      const owner = db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as Obj | undefined;
      const audit = db.prepare("SELECT * FROM audit_events WHERE id=?").get(input.audit_id) as Obj | undefined;
      check(owner && audit && owner.owner_id === input.actor_id && audit.actor_id === input.actor_id && audit.action === "investor_admit_monitor_source"
        && audit.object_type === "investor_monitor_evidence_input" && audit.object_id === input.id && audit.created_at === input.created_at
        && hash(parseStrictJson(text(audit.payload_json))) === hash({ content_hash: input.content_hash }));
      const profile = db.prepare("SELECT * FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 1").get(workspace) as Obj | undefined;
      const selected = db.prepare("SELECT plan_id FROM investor_plan_selections WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(workspace) as Obj | undefined;
      check(profile && profile.id === model.profile_id && profile.content_hash === definition.profile_hash && profile.version === definition.profile_version
        && hash(parseStrictJson(text(profile.document_json))) === profile.content_hash && time(profile.created_at) <= time(now)
        && selected?.plan_id === model.plan_id);
      const reference = readEvidenceReference(db, workspace, text(model.plan_id), now);
      check(reference && reference.row.content_hash === definition.plan_hash && reference.document.data_mode === "reconstructed"
        && reference.document.profile_id === definition.profile_id && reference.document.valid_until === definition.valid_until
        && hash(reference.document.targets.map(({ listing_id, market, currency, weight }) => ({ listing_id, market, currency, weight }))) === hash(definition.targets));
      if (reference.unavailable_reason) return { row: input, document, projection: null, catalog: null, unavailable_reason: reference.unavailable_reason };
      check((definition.schema_version === "investor-model-definition-v2") === (reference.document.schema_version === "investor-reference-plan-v2")
        && (reference.document.schema_version !== "investor-reference-plan-v2" || hash(definition.fixed_policy) === hash(reference.document.fixed_policy)));
      if (fixedPolicyUnsupported(reference.document)) return { row: input, document, projection: null, catalog: null, unavailable_reason: fixedPolicyMonitorGap };
      const rebuilt = replayInvestorMonitorData(db, workspace, definition, reference.document.targets, document, now, evaluatedAt);
      return { row: input, document, ...rebuilt };
    } catch { throw new Error("INVESTOR_EVIDENCE_INVALID"); }
  }).deferred();
}

/** Independent receipt and arithmetic replay; no worker invocation or writes. */
export function replayInvestorMonitorData(db: Database.Database, workspace: string, rawDefinition: unknown,
  referenceTargets: Obj[], rawDocument: unknown, now: string, evaluatedAt = now) {
  return db.transaction(() => replay(db, workspace, rawDefinition, referenceTargets, rawDocument, now, evaluatedAt)).deferred();
}

function replay(db: Database.Database, workspace: string, rawDefinition: unknown, referenceTargets: Obj[], rawDocument: unknown, now: string, evaluatedAt: string) {
  try {
    validateInvestorModelDocument("definition", rawDefinition); validateInvestorMonitorDataDocument("input", rawDocument);
    const definition = obj(rawDefinition), document = obj(rawDocument), created = text(document.created_at), at = time(created);
    check(document.workspace_id === workspace && document.model_id === definition.model_id && document.target_definition_hash === definition.target_definition_hash
      && definition.data_mode === "reconstructed" && time(definition.created_at) <= at && at < time(definition.valid_until) && at <= time(evaluatedAt) && time(evaluatedAt) <= time(now)
      && definition.target_definition_hash === modelDefinitionHash(definition as Parameters<typeof modelDefinitionHash>[0]));
    const targets = rows(definition.targets), settings = obj(document.settings), policy = obj(settings.policy);
    check(targets.length === new Set(targets.map(row => row.listing_id)).size
      && targets.every(row => amount(text(row.weight)).gt(0)) && targets.reduce((sum,row) => sum.add(text(row.weight)), new Decimal(0)).eq(1)
      && amount(text(policy.weight_band)).gte(0) && amount(text(policy.weight_band)).lte(1) && amount(text(policy.absolute_band_cny)).gte(0));
    if (settings.funding_intent !== null) check(amount(text(obj(settings.funding_intent).amount_cny)).gt(0));
    if (policy.costs !== null) {
      const costs = obj(policy.costs);
      check(["commission_bps", "minimum_fee_cny", "fx_bps", "slippage_bps", "maximum_cost_fraction"].every(key => amount(text(costs[key])).gte(0))
        && ["commission_bps", "fx_bps", "slippage_bps"].every(key => amount(text(costs[key])).lt(10000)) && amount(text(costs.maximum_cost_fraction)).lte(1));
    }
    const segments = rows(document.segments), reviews = new Map<string, VerifiedSourceReview>(), catalog: Record<string, Obj> = {};
    const observations = new Map<string, Obj>(), sessions: Obj[] = [], markets = new Set<string>(), expiries: string[] = [];
    check(segments.every((row, index) => index === 0 || text(rows(obj(segments[index - 1].snapshot).capture_refs)[0].capture_id) < text(rows(obj(row.snapshot).capture_refs)[0].capture_id)));
    for (const segment of segments) {
      const snapshot = obj(segment.snapshot);
      check(snapshot.created_at === created);
      const expiry = segmentExpiry(db, workspace, snapshot);
      const rebuilt = (snapshot.schema_version === "investor-monitor-price-snapshot-v1" ? readInvestorMonitorPriceSnapshot : readInvestorDataSnapshot)(db, workspace, { ...segment, created_at: created, valid_until: expiry }, now);
      if (!rebuilt.dataset) return { projection: null, catalog: null, unavailable_reason: rebuilt.unavailable_reason };
      const sourceMarkets = new Set(Object.values(rebuilt.catalog).map(row => text(row.market)));
      check(sourceMarkets.size === 1 && [...sourceMarkets].every(market => !markets.has(market)));
      sourceMarkets.forEach(market => markets.add(market));
      for (const [id,facts] of Object.entries(rebuilt.catalog)) { check(!catalog[id]); catalog[id] = facts; }
      for (const review of rebuilt.reviews) reviews.set(review.row.id, review);
      for (const row of rebuilt.dataset.observations) {
        const id = text(row.id), prior = observations.get(id); check(!prior || hash(prior) === hash(row)); observations.set(id, row);
      }
      sessions.push(...rebuilt.dataset.sessions); expiries.push(expiry);
    }
    check([...expiries].sort()[0] === document.valid_until && targets.length === Object.keys(catalog).length
      && referenceTargets.length === targets.length && new Set(referenceTargets.map(row => row.listing_id)).size === targets.length);
    for (const target of targets) {
      const spec = catalog[text(target.listing_id)], reference = referenceTargets.find(row => row.listing_id === target.listing_id);
      check(spec && reference && target.market === spec.market && target.currency === spec.currency
        && reference.symbol === spec.provider_symbol && reference.market === spec.market && reference.currency === spec.currency);
      if (definition.schema_version === "investor-model-definition-v2")
        check(obj(obj(definition.fixed_policy).parameters).roles && obj(obj(obj(definition.fixed_policy).parameters).roles)[text(target.listing_id)] === spec.role);
    }
    const baseExpiry = min([time(document.valid_until), time(definition.valid_until)]), deadlines = [baseExpiry];
    const quotes: Obj[] = [], fx: Obj[] = [], coverage: Record<string, Obj> = {}, events: Obj[] = [], gaps: string[] = [];
    for (const market of [...markets].sort()) {
      const reviewed = [...reviews.values()].find(row => row.source.kind === "calendar" && row.facts.market === market); check(reviewed);
      const calendar = reviewed.facts, localDay = localParts(Number(at / 1000n), zones[market]).slice(0, 10);
      if (localDay < text(calendar.range_start) || text(calendar.range_end) < localDay) gaps.push("MONITOR_CALENDAR_NOT_CURRENT_" + market);
      const days = rows(calendar.days).filter(row => row.kind !== "closed"), complete = days.filter(row => time(row.close_at) <= at);
      if (!complete.length) { gaps.push("MONITOR_EXPECTED_CLOSE_MISSING_" + market); continue; }
      const expected = complete.sort((a,b) => time(a.close_at) < time(b.close_at) ? -1 : 1).at(-1)!;
      const expiry = min([baseExpiry, calendarHorizon(text(calendar.range_end), zones[market]), ...days.filter(row => time(row.close_at) > at).map(row => time(row.close_at))]);
      deadlines.push(expiry);
      for (const target of targets.filter(row => row.market === market).sort((a,b) => cmp(text(a.listing_id),text(b.listing_id)))) {
        const prices = [...observations.values()].filter(row => row.listing_id === target.listing_id && row.metric === "close"); check(prices.length);
        const quote = prices.sort((a,b) => time(a.observed_at) < time(b.observed_at) ? -1 : 1).at(-1)!;
        const observed = time(quote.observed_at), known = time(quote.ingested_at); check(observed <= known && known <= at);
        const quoteExpiry = min([expiry, observed + BigInt(settings.max_quote_age_seconds as number) * 1000000n]);
        if (quote.observed_at !== expected.close_at) gaps.push("MONITOR_PRICE_NOT_CURRENT_" + market);
        if (quoteExpiry <= at || quoteExpiry <= known) { gaps.push("MONITOR_PRICE_EXPIRED_" + market); continue; }
        quotes.push({ listing_id: target.listing_id, market, currency: target.currency, close: quote.value, price_basis: "unadjusted",
          observed_at: milliseconds(observed), known_at: quote.ingested_at, valid_until: milliseconds(quoteExpiry), expected_close_at: milliseconds(time(expected.close_at)),
          calendar_hash: reviewed.row.content_hash, observation_hash: hash(quote) }); deadlines.push(quoteExpiry);
      }
      const current = quotes.filter(row => row.market === market);
      if (current.length) {
        check(new Set(current.map(row => row.observed_at)).size === 1);
        const from = sessions.filter(row => row.market === market).map(row => time(row.close_at)); check(from.length);
        coverage[market] = { from: milliseconds(min(from)), to: current[0].observed_at, complete: true };
      }
    }
    const fxReviews = [...reviews.values()].filter(row => row.source.kind === "fx");
    check(new Set(fxReviews.map(row => row.facts.currency)).size === fxReviews.length);
    for (const currency of [...new Set(targets.map(row => text(row.currency)))].filter(currency => currency !== "CNY").sort()) {
      const reviewed = fxReviews.find(row => row.facts.currency === currency); check(reviewed);
      const rates = rows(reviewed.facts.rows); check(rates.length);
      const rate = rates.sort((a,b) => time(a.observed_at) < time(b.observed_at) ? -1 : 1).at(-1)!;
      const observed = time(rate.observed_at), known = time(reviewed.row.created_at); check(observed <= known && known <= at);
      const expiry = min([baseExpiry, observed + BigInt(policy.max_fx_age_seconds as number) * 1000000n]);
      if (expiry <= at || expiry <= known) { gaps.push("MONITOR_FX_EXPIRED_" + currency); continue; }
      fx.push({ currency, value: rate.value, unit: "CNY_per_unit_currency", observed_at: milliseconds(observed), known_at: reviewed.row.created_at,
        valid_until: milliseconds(expiry), observation_hash: hash({ review_id: reviewed.row.id, review_hash: reviewed.row.content_hash, rate }) }); deadlines.push(expiry);
    }
    for (const reviewed of [...reviews.values()].filter(row => row.source.kind === "actions").sort((a,b) => cmp(text(a.facts.listing_id),text(b.facts.listing_id)))) {
      const target = targets.find(row => row.listing_id === reviewed.facts.listing_id); check(target);
      const window = coverage[text(target.market)]; if (!window) continue;
      const cutoff = time(window.to);
      for (const event of rows(reviewed.facts.events)) {
        const common = { listing_id: target.listing_id, known_at: reviewed.row.created_at }, id = text(event.id);
        if (time(event.at) <= cutoff) {
          if (event.type === "split") events.push({ ...common, id: "split:" + id, kind: "split", effective_at: milliseconds(time(event.at)), ratio: event.ratio });
          else events.push({ ...common, id: "ex:" + id, kind: "dividend_ex", effective_at: milliseconds(time(event.at)), currency: target.currency,
            net_per_unit: amount(text(event.gross_per_unit)).sub(text(event.tax_per_unit)).toFixed(), entitlement_id: "entitlement:" + id,
            tax_assumption_hash: hash({ tax_assumption: reviewed.facts.tax_assumption, tax_per_unit: event.tax_per_unit }) });
        }
        if (event.type === "dividend" && time(event.pay_at) <= cutoff) events.push({ ...common, id: "pay:" + id, kind: "dividend_payment",
          effective_at: milliseconds(time(event.pay_at)), currency: target.currency, entitlement_id: "entitlement:" + id, ex_at: milliseconds(time(event.at)) });
      }
    }
    check(events.length <= 500 && new Set(events.map(row => row.id)).size === events.length);
    const projection = { schema_version: "investor-monitor-data-projection-v1", model_id: definition.model_id, source_qualification: "owner_reviewed_reconstructed",
      quotes: quotes.sort((a,b) => cmp(text(a.listing_id),text(b.listing_id))), fx, corporate_action_coverage: coverage,
      corporate_actions: events.sort((a,b) => cmp(text(a.effective_at),text(b.effective_at)) || cmp(text(a.kind),text(b.kind)) || cmp(text(a.id),text(b.id))),
      funding_intent: settings.funding_intent, policy, quality_gaps: [...new Set(gaps)].sort(), created_at: created, valid_until: milliseconds(min(deadlines)), live_advice_eligible: false };
    validateInvestorMonitorDataDocument("projection", projection); check(hash(projection) === document.projection_hash);
    if (time(projection.valid_until) <= time(evaluatedAt)) return { projection: null, catalog: null, unavailable_reason: "MONITOR_DATA_PROJECTION_EXPIRED" };
    return { projection, catalog, unavailable_reason: null };
  } catch { throw new Error("INVESTOR_EVIDENCE_INVALID"); }
}
