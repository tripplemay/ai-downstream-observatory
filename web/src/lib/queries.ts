/** 只读数据访问（Server Components 用）。除 snapshots 全局共享外，均按 theme_id 过滤。 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db";
import { LAYERS } from "./seed";

export interface Theme {
  id: string;
  name: string;
  description: string;
  enabled: number;
  created_at: string;
}

export interface Signal {
  id: string;
  layer: string;
  name: string;
  watch: string;
  source: string;
  trigger_cond: string;
  current_value: string;
  status: string;
  updated_at: string;
  note: string;
}

export interface Overview {
  theme_id: string;
  layer1_status: string;
  layer1_evidence: string;
  layer2_status: string;
  layer2_evidence: string;
  layer3_status: string;
  layer3_evidence: string;
  sentiment: string;
  sentiment_evidence: string;
  light: string;
  conclusion: string;
}

export interface Observation {
  id: number;
  date: string;
  light: string;
  snapshot: string;
  note: string;
  created_at: string;
}

export interface PoolItem {
  id: number;
  name: string;
  code: string;
  channel: string;
  position: string;
  note: string;
}

export interface AiReport {
  id: number;
  run_date: string;
  run_type: string;
  light: string;
  narrative: string;
  created_at: string;
}

export interface SnapshotRow {
  metric_key: string;
  label: string;
  period_date: string;
  value: number;
  unit: string;
  source: string;
  fetched_at: string;
}

export interface MetricGroup {
  key: string;
  label: string;
  unit: string;
  source: string;
  points: Array<{ d: string; v: number }>;
  rows: Array<{ d: string; v: number; ts: string }>;
}

export function getThemes(): Theme[] {
  return getDb()
    .prepare("SELECT * FROM themes WHERE enabled = 1 ORDER BY rowid")
    .all() as Theme[];
}

export function getTheme(slug: string): Theme | null {
  return (getDb().prepare("SELECT * FROM themes WHERE id = ?").get(slug) as Theme) ?? null;
}

export function getSignals(themeId: string): Signal[] {
  return getDb()
    .prepare("SELECT * FROM signals WHERE theme_id = ? ORDER BY rowid")
    .all(themeId) as Signal[];
}

export function getSignalGroups(themeId: string) {
  const rows = getSignals(themeId);
  return LAYERS.map(([key, label]) => ({
    key,
    label,
    signals: rows.filter((r) => r.layer === key),
  }));
}

export function getOverview(themeId: string): Overview | null {
  return (
    (getDb().prepare("SELECT * FROM overview WHERE theme_id = ?").get(themeId) as Overview) ??
    null
  );
}

export function getObservations(themeId: string): Observation[] {
  return getDb()
    .prepare("SELECT * FROM observations WHERE theme_id = ? ORDER BY date DESC, id DESC")
    .all(themeId) as Observation[];
}

export function getLastObservation(themeId: string): Observation | null {
  return (
    (getDb()
      .prepare("SELECT * FROM observations WHERE theme_id = ? ORDER BY date DESC, id DESC LIMIT 1")
      .get(themeId) as Observation) ?? null
  );
}

export function getStatusCounts(themeId: string): Record<string, number> {
  const rows = getDb()
    .prepare("SELECT status, COUNT(*) AS c FROM signals WHERE theme_id = ? GROUP BY status")
    .all(themeId) as Array<{ status: string; c: number }>;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = r.c;
  return counts;
}

export function getPool(themeId: string): PoolItem[] {
  return getDb()
    .prepare("SELECT * FROM pool WHERE theme_id = ? ORDER BY id")
    .all(themeId) as PoolItem[];
}

export function getPages(themeId: string): Record<string, string> {
  const rows = getDb().prepare("SELECT * FROM pages WHERE theme_id = ?").all(themeId) as Array<{
    key: string;
    content: string;
  }>;
  const pages: Record<string, string> = {};
  for (const r of rows) pages[r.key] = r.content;
  return pages;
}

export function getReports(themeId: string): AiReport[] {
  return getDb()
    .prepare("SELECT * FROM ai_reports WHERE theme_id = ? ORDER BY id DESC")
    .all(themeId) as AiReport[];
}

export function getReport(themeId: string, id: number): AiReport | null {
  return (
    (getDb()
      .prepare("SELECT * FROM ai_reports WHERE theme_id = ? AND id = ?")
      .get(themeId, id) as AiReport) ?? null
  );
}

export function getLastReport(themeId: string): AiReport | null {
  return (
    (getDb()
      .prepare("SELECT * FROM ai_reports WHERE theme_id = ? ORDER BY id DESC LIMIT 1")
      .get(themeId) as AiReport) ?? null
  );
}

/** 该主题订阅的指标快照（snapshots 全局共享，经 theme_metrics 关联过滤） */
function getSnapshots(themeId: string): SnapshotRow[] {
  return getDb()
    .prepare(
      "SELECT s.* FROM snapshots s" +
        " JOIN theme_metrics tm ON tm.metric_key = s.metric_key" +
        " WHERE tm.theme_id = ? ORDER BY s.metric_key, s.period_date"
    )
    .all(themeId) as SnapshotRow[];
}

function metricRank(key: string): [number, string] {
  if (key.startsWith("edgar:")) return [0, key];
  if (key.startsWith("yf:") || key.startsWith("twse:")) return [1, key];
  return [2, key];
}

export function getMetricGroups(themeId: string): MetricGroup[] {
  const rows = getSnapshots(themeId);
  const map = new Map<string, MetricGroup>();
  for (const r of rows) {
    let m = map.get(r.metric_key);
    if (!m) {
      m = {
        key: r.metric_key,
        label: r.label,
        unit: r.unit,
        source: r.source,
        points: [],
        rows: [],
      };
      map.set(r.metric_key, m);
    }
    m.points.push({ d: r.period_date, v: r.value });
    m.rows.push({ d: r.period_date, v: r.value, ts: r.fetched_at });
  }
  const groups = [...map.values()].sort((a, b) => {
    const ra = metricRank(a.key);
    const rb = metricRank(b.key);
    return ra[0] - rb[0] || (ra[1] < rb[1] ? -1 : 1);
  });
  for (const m of groups) m.rows = m.rows.slice(-10).reverse();
  return groups;
}

export function getSeries(metricKey: string): Array<{ d: string; v: number }> {
  const rows = getDb()
    .prepare("SELECT period_date, value FROM snapshots WHERE metric_key = ? ORDER BY period_date")
    .all(metricKey) as Array<{ period_date: string; value: number }>;
  return rows.map((r) => ({ d: r.period_date, v: r.value }));
}

/** 云厂商剪刀差：最近季 capex/收入 同比增速（需要 5 个季度数据）。主题一专属图表。 */
export function getScissorData(themeId: string) {
  if (themeId !== "ai-downstream") return null;
  const companies: Array<[string, string]> = [
    ["MSFT", "微软"],
    ["GOOGL", "谷歌"],
    ["AMZN", "亚马逊"],
  ];
  const out: Array<{
    ticker: string;
    name: string;
    period: string;
    capexYoY: number | null;
    revenueYoY: number | null;
    capex: Array<{ d: string; v: number }>;
    revenue: Array<{ d: string; v: number }>;
  }> = [];
  for (const [ticker, name] of companies) {
    const capex = getSeries(`edgar:${ticker}:capex`);
    const revenue = getSeries(`edgar:${ticker}:revenue`);
    const yoy = (s: Array<{ d: string; v: number }>) =>
      s.length >= 5 && s[s.length - 5].v !== 0
        ? s[s.length - 1].v / s[s.length - 5].v - 1
        : null;
    out.push({
      ticker,
      name,
      period: capex.length ? capex[capex.length - 1].d : "",
      capexYoY: yoy(capex),
      revenueYoY: yoy(revenue),
      capex: capex.slice(-8),
      revenue: revenue.slice(-8),
    });
  }
  return out;
}

/** 上下游强弱：下游 ETF vs 上游/平台 ETF 近 3 个月涨跌。主题一专属图表。 */
export function getStrengthData(themeId: string) {
  if (themeId !== "ai-downstream") return null;
  const tickers: Array<[string, string, string]> = [
    ["px:159852.SZ", "软件ETF(159852)", "down"],
    ["px:513050.SS", "中概互联网ETF(513050)", "down"],
    ["px:159509.SZ", "纳指科技ETF(159509)", "up"],
    ["px:^SOX", "费城半导体指数", "up"],
  ];
  return tickers.map(([key, label, side]) => {
    const s = getSeries(key);
    const chg =
      s.length >= 2 && s[0].v !== 0 ? s[s.length - 1].v / s[0].v - 1 : null;
    return { key, label, side, chg, period: s.length ? s[s.length - 1].d : "", series: s };
  });
}

/** 读 data/jobs.log 最后一条 [STATUS] 行（移植自 app.py last_job_status） */
export function lastJobStatus(): string | null {
  const logPath = path.resolve(process.cwd(), "..", "data", "jobs.log");
  try {
    const buf = fs.readFileSync(logPath);
    const tail = buf.subarray(Math.max(0, buf.length - 65536)).toString("utf-8");
    const lines = tail.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes("[STATUS]")) return lines[i].trim();
    }
  } catch {
    /* 日志不存在 */
  }
  return null;
}
