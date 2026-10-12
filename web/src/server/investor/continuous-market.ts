import { Decimal } from "../ledger/decimal";

export type Asset = { listing_id: string; market: string; currency: string; quantity_step: string; tradable_from: string; tradable_until?: string };
export type Session = { market: string; session_date: string; close_at: string; available_at: string; trade_allowed: boolean };
export type Observation = { id: string; listing_id?: string; source_id: string; series_key: string; metric: string; value: string; unit: string;
  observed_at: string; published_at?: string; assumed_available_at?: string; ingested_at: string; price_basis: string; revision_id: string;
  time_precision: string; provenance: string };
export type Action = { id: string; listing_id: string; type: "split" | "dividend"; at: string; published_at: string; ingested_at?: string;
  ratio?: string; gross_per_unit?: string; tax_per_unit?: string; pay_at?: string; source_evidence: string };
export type Settlement = { market: string; session_date: string; settled_at: string; published_at: string; ingested_at?: string; source_evidence: string };
export type ContinuousDataset = { schema_version: string; mode: string; historical_archive_verified: boolean; corporate_actions_complete: boolean;
  assets: Asset[]; observations: Observation[]; sessions: Session[]; settlements: Settlement[]; actions: Action[] };

export function requireEconomic(value: unknown, code = "INVESTOR_CONTINUOUS_INPUT_INVALID"): asserts value {
  if (!value) throw new Error(code);
}
export function economicInstant(text: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(text);
  requireEconomic(match && !text.startsWith("0000"));
  const ms = Date.parse(match[1] + "Z");
  requireEconomic(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === match[1]);
  return BigInt(ms) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
export function economicStamp(at: bigint) {
  const seconds = at >= 0n ? at / 1000000n : (at - 999999n) / 1000000n, fraction = at - seconds * 1000000n;
  return new Date(Number(seconds * 1000n)).toISOString().slice(0, 19) + `.${String(fraction).padStart(6, "0")}Z`;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
export function economicLocal(at: bigint, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    if (formatters.size >= 8) formatters.clear();
    formatters.set(zone, formatter);
  }
  const ms = at >= 0n ? at / 1000n : (at - 999n) / 1000n;
  return Object.fromEntries(formatter.formatToParts(Number(ms)).filter(row => row.type !== "literal").map(row => [row.type, Number(row.value)]));
}
export function economicDate(at: bigint, zone: string) {
  const p = economicLocal(at, zone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
export function economicMidnight(date: string, zone: string): bigint {
  const utc = Date.parse(date + "T00:00:00Z");
  requireEconomic(Number.isFinite(utc) && new Date(utc).toISOString().slice(0, 10) === date);
  const offsets = new Set<number>();
  for (const hour of [-48, -24, 0, 24, 48]) {
    const ms = utc + hour * 3600000, p = economicLocal(BigInt(ms) * 1000n, zone);
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms);
  }
  const candidates = [...offsets].map(offset => BigInt(utc - offset) * 1000n).filter(at => {
    const p = economicLocal(at, zone); return economicDate(at, zone) === date && p.hour === 0 && p.minute === 0 && p.second === 0;
  });
  requireEconomic(candidates.length === 1); return candidates[0];
}
export const economicText = (value: Decimal) => value.isZero() ? "0" : value.toFixed();
export function economicFact(text: string) {
  requireEconomic(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)
    && text.replace(/[-.]/g, "").replace(/^0+/, "").length <= 38 && (text.split(".")[1]?.length ?? 0) <= 18);
  return new Decimal(text);
}
const maximum = (values: bigint[]) => values.reduce((a, b) => a > b ? a : b);
const marketZones: Record<string, string> = { CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" };
const sessionKey = (market: string, at: bigint) => `${market}:${at}`;
type Index<T> = { times: bigint[]; values: T[] };
type Selection = { row: Observation; observed: bigint; available: bigint; ambiguous: boolean };
function lookup<T>(index: Index<T> | undefined, cutoff: bigint): T | null {
  if (!index) return null;
  let low = 0, high = index.times.length;
  while (low < high) { const middle = (low + high) >> 1; if (index.times[middle] <= cutoff) low = middle + 1; else high = middle; }
  return low === 0 ? null : index.values[low - 1];
}
function visibleIndex<T>(entries: { at: bigint; rank: bigint[]; value: T }[]): Index<T> {
  const index: Index<T> = { times: [], values: [] }; let best: bigint[] | null = null;
  for (const entry of entries.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0)) {
    const firstDifferent = best === null ? -1 : entry.rank.findIndex((value, offset) => value !== best![offset]);
    if (best !== null && (firstDifferent === -1 || entry.rank[firstDifferent] < best[firstDifferent])) continue;
    best = entry.rank;
    if (index.times.at(-1) === entry.at) index.values[index.values.length - 1] = entry.value;
    else { index.times.push(entry.at); index.values.push(entry.value); }
  }
  return index;
}

/** Independent selection from frozen rows; no Python, SDK, mutable latest lookup or database. */
export class ContinuousMarket {
  readonly assets: Map<string, Asset>;
  readonly observations: Map<string, Observation>;
  readonly sessions: Map<string, Session>;
  readonly settlements: Map<string, Settlement>;
  private readonly prices = new Map<string, Observation[]>();
  private readonly currencies = new Map<string, Observation[]>();
  private readonly calendars = new Map<string, Session[]>();
  private readonly visible = new Map<string, bigint>();
  private readonly observed = new Map<string, bigint>();
  private readonly priceIndexes = new Map<string, { historical: Index<Selection>; known: Index<Selection>; exact: Map<bigint, Index<Selection>> }>();
  private readonly fxIndexes = new Map<string, Index<Selection>>();
  private readonly calendarIndexes = new Map<string, { historical: Index<bigint>; known: Index<bigint>; trades: bigint[] }>();

  constructor(readonly data: ContinuousDataset, readonly maxFxAge: number) {
    requireEconomic(data.schema_version === "research-dataset-v2" && data.corporate_actions_complete
      && (data.mode !== "historical_point_in_time" || data.historical_archive_verified));
    this.assets = new Map(data.assets.map(row => [row.listing_id, row]));
    this.observations = new Map(data.observations.map(row => [row.id, row]));
    requireEconomic(this.assets.size === data.assets.length && this.observations.size === data.observations.length);
    this.sessions = new Map(); this.settlements = new Map();
    const dates = new Set<string>(), identities = new Set<string>(), byDate = new Map<string, Session>();
    for (const row of data.assets) {
      requireEconomic(economicFact(row.quantity_step).gt(0));
      requireEconomic(!row.tradable_until || economicInstant(row.tradable_from) < economicInstant(row.tradable_until));
    }
    for (const row of data.sessions) {
      const at = economicInstant(row.close_at), key = sessionKey(row.market, at), date = `${row.market}:${row.session_date}`;
      requireEconomic(marketZones[row.market] && economicDate(at, marketZones[row.market]) === row.session_date
        && economicInstant(row.available_at) >= at && !this.sessions.has(key) && !dates.has(date));
      dates.add(date); byDate.set(date, row); this.sessions.set(key, row);
      const calendar = this.calendars.get(row.market) ?? []; calendar.push(row); this.calendars.set(row.market, calendar);
    }
    for (const [market, rows] of this.calendars) {
      rows.sort((a, b) => economicInstant(a.close_at) < economicInstant(b.close_at) ? -1 : 1);
      const closes = rows.map(row => economicInstant(row.close_at));
      this.calendarIndexes.set(market, { historical: { times: closes, values: closes },
        known: visibleIndex(rows.map((row, offset) => ({ at: economicInstant(row.available_at), rank: [closes[offset]], value: closes[offset] }))),
        trades: rows.filter(row => row.trade_allowed).map(row => economicInstant(row.close_at)) });
    }
    for (const row of data.settlements) {
      const key = `${row.market}:${row.session_date}`, session = byDate.get(key);
      requireEconomic(session && !this.settlements.has(key) && economicInstant(row.settled_at) >= economicInstant(session.close_at)
        && economicInstant(row.published_at) <= economicInstant(session.close_at)
        && (data.mode !== "actual_replay" || row.ingested_at && economicInstant(row.ingested_at) <= economicInstant(session.close_at)));
      this.settlements.set(key, row);
    }
    requireEconomic(this.settlements.size === dates.size);
    for (const row of data.observations) {
      const at = economicInstant(row.observed_at), ingested = economicInstant(row.ingested_at), published = row.published_at ? economicInstant(row.published_at) : null;
      const identity = JSON.stringify([row.source_id, row.series_key, row.metric, row.observed_at, row.price_basis, row.revision_id]);
      requireEconomic(row.time_precision === "second" && ingested >= at && (published === null || published >= at) && !identities.has(identity));
      identities.add(identity);
      requireEconomic(data.mode !== "synthetic" || row.provenance === "reconstructed");
      requireEconomic(!["actual_replay", "historical_point_in_time"].includes(data.mode) || row.provenance !== "reconstructed");
      requireEconomic(data.mode !== "historical_point_in_time" || published !== null);
      if (row.assumed_available_at) requireEconomic(["reconstructed", "synthetic"].includes(data.mode) && row.provenance === "reconstructed"
        && published === null && at <= economicInstant(row.assumed_available_at) && economicInstant(row.assumed_available_at) <= ingested);
      const known = [at]; if (published !== null) known.push(published);
      if (row.assumed_available_at) known.push(economicInstant(row.assumed_available_at));
      if (data.mode === "actual_replay") known.push(ingested);
      this.visible.set(row.id, maximum(known));
      this.observed.set(row.id, at);
      requireEconomic(economicFact(row.value).gt(0));
      if (row.metric === "close") {
        const asset = this.assets.get(row.listing_id!);
        requireEconomic(asset && row.unit === asset.currency && row.price_basis === "unadjusted"
          && this.sessions.has(sessionKey(asset.market, at)) && at >= economicInstant(asset.tradable_from)
          && (!asset.tradable_until || at < economicInstant(asset.tradable_until)));
        const rows = this.prices.get(asset.listing_id) ?? []; rows.push(row); this.prices.set(asset.listing_id, rows);
      } else {
        requireEconomic(row.metric === "fx_cny_per_unit" && row.price_basis === "not_applicable" && row.unit === "CNY_per_unit_currency");
        const rows = this.currencies.get(row.series_key) ?? []; rows.push(row); this.currencies.set(row.series_key, rows);
      }
    }
    for (const [isPrice, key, rows] of [...[...this.prices].map(([key, rows]) => [true, key, rows] as const),
      ...[...this.currencies].map(([key, rows]) => [false, key, rows] as const)]) {
      const groups = new Map<bigint, Map<bigint, Observation[]>>();
      for (const row of rows) {
        const observed = this.observed.get(row.id)!, available = this.available(row), revisions = groups.get(observed) ?? new Map<bigint, Observation[]>();
        const same = revisions.get(available) ?? []; same.push(row); revisions.set(available, same); groups.set(observed, revisions);
      }
      const exact = new Map<bigint, Index<Selection>>(), historical: Index<Selection> = { times: [], values: [] };
      const entries: { at: bigint; rank: bigint[]; value: Selection }[] = [];
      const asset = isPrice ? this.assets.get(key) : undefined;
      for (const [observed, revisions] of [...groups].sort(([a], [b]) => a < b ? -1 : 1)) {
        const revisionIndex: Index<Selection> = { times: [], values: [] };
        const sessionAvailable = asset ? economicInstant(this.session(asset.market, observed)!.available_at) : null;
        for (const [available, same] of [...revisions].sort(([a], [b]) => a < b ? -1 : 1)) {
          const value = { row: same[0], observed, available, ambiguous: new Set(same.map(row => JSON.stringify([row.value, row.revision_id]))).size > 1 };
          revisionIndex.times.push(available); revisionIndex.values.push(value);
          entries.push({ at: sessionAvailable !== null && sessionAvailable > available ? sessionAvailable : available, rank: [observed, available], value });
        }
        exact.set(observed, revisionIndex);
        if (sessionAvailable !== null) {
          const selected = lookup(revisionIndex, sessionAvailable);
          if (selected) { historical.times.push(observed); historical.values.push(selected); }
        }
      }
      if (asset) this.priceIndexes.set(key, { historical, known: visibleIndex(entries), exact });
      else this.fxIndexes.set(key, visibleIndex(entries));
    }
    const actionIds = new Set<string>();
    for (const row of data.actions) {
      const at = economicInstant(row.at);
      requireEconomic(!actionIds.has(row.id) && this.assets.has(row.listing_id) && economicInstant(row.published_at) <= at
        && (data.mode !== "actual_replay" || row.ingested_at && economicInstant(row.ingested_at) <= at));
      actionIds.add(row.id);
      if (row.type === "split") requireEconomic(new Decimal(row.ratio!).gt(0));
      else requireEconomic(row.pay_at && economicInstant(row.pay_at) >= at && new Decimal(row.gross_per_unit!).gte(0)
        && new Decimal(row.tax_per_unit!).gte(0) && new Decimal(row.tax_per_unit!).lte(row.gross_per_unit!));
    }
  }
  available(row: Observation) { return this.visible.get(row.id)!; }
  session(market: string, at: bigint) { return this.sessions.get(sessionKey(market, at)); }
  price(listing: string, at: bigint, decision = false, exactAt?: bigint): [Decimal, string] {
    const asset = this.assets.get(listing)!, indexes = this.priceIndexes.get(listing); let selected: Selection | null = null;
    if (exactAt !== undefined && exactAt <= at) {
      const available = economicInstant(this.session(asset.market, exactAt)!.available_at);
      if (!decision || available <= at) selected = lookup(indexes?.exact.get(exactAt), decision ? at : available);
    } else if (exactAt === undefined) selected = lookup(decision ? indexes?.known : indexes?.historical, at);
    requireEconomic(selected, "RESEARCH_PRICE_UNAVAILABLE:" + listing);
    const calendar = this.calendarIndexes.get(asset.market), latest = lookup(decision ? calendar?.known : calendar?.historical, at);
    requireEconomic(latest === null || latest === selected.observed, "MISSING_REQUIRED_RESEARCH_SESSION:" + listing);
    requireEconomic(!selected.ambiguous, "AMBIGUOUS_RESEARCH_PRICE_REVISION");
    return [new Decimal(selected.row.value), selected.row.id];
  }
  fx(currency: string, at: bigint): [Decimal, string | null] {
    if (currency === "CNY") return [new Decimal(1), null];
    const selected = lookup(this.fxIndexes.get("FX:" + currency), at);
    requireEconomic(selected, "RESEARCH_FX_UNAVAILABLE:" + currency);
    requireEconomic(!selected.ambiguous, "AMBIGUOUS_RESEARCH_FX_REVISION");
    requireEconomic(at - selected.observed <= BigInt(this.maxFxAge) * 1000000n, "STALE_RESEARCH_FX:" + currency);
    return [new Decimal(selected.row.value), selected.row.id];
  }
  nextClose(listing: string, after: bigint, end: bigint) {
    const asset = this.assets.get(listing)!, times = this.calendarIndexes.get(asset.market)?.trades ?? [];
    let low = 0, high = times.length;
    while (low < high) { const middle = (low + high) >> 1; if (times[middle] <= after) low = middle + 1; else high = middle; }
    if (low === times.length || times[low] > end) return null;
    const at = times[low];
    requireEconomic(at >= economicInstant(asset.tradable_from) && (!asset.tradable_until || at < economicInstant(asset.tradable_until)), "ASSET_NOT_HISTORICALLY_TRADABLE:" + listing);
    return at;
  }
}
