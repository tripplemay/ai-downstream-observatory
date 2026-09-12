import DecimalJs from "decimal.js";
import { parseStrictJson } from "@/server/strict-json";

const Decimal = DecimalJs.clone({ precision: 60, toExpNeg: -100, toExpPos: 100 });
export function parseHoldingsDraft(raw: string): { items: { security_id: string; weight: string }[]; coverage: string } {
  const input = parseStrictJson(raw);
  if (!Array.isArray(input) || input.length > 10000) throw new Error("持仓须为最多 10000 行的 JSON 数组");
  const ids = new Set<string>();
  let coverage = new Decimal(0);
  const items = input.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join(",") !== "security_id,weight"
      || typeof row.security_id !== "string" || !/^[A-Z][A-Z0-9_]{0,31}:[A-Za-z0-9._:/-]{1,160}$/.test(row.security_id)
      || typeof row.weight !== "string" || !/^(?:0|1)(?:\.\d{1,18})?$/.test(row.weight)) throw new Error("每行只填写带命名空间的 security_id 和十进制字符串 weight");
    if (ids.has(row.security_id)) throw new Error("证券标识重复；不会按名称或发行人自动合并");
    ids.add(row.security_id);
    const weight = new Decimal(row.weight);
    if (weight.gt(1)) throw new Error("单行权重不能大于 1");
    coverage = coverage.plus(weight);
    return { security_id: row.security_id, weight: row.weight };
  });
  if (coverage.gt(1)) throw new Error("已披露权重合计超过 1；不会自动归一化");
  return { items, coverage: coverage.toFixed() };
}

export function percentRatio(value: string | null | undefined) {
  if (value === null || value === undefined) return "未知";
  try { return `${new Decimal(value).times(100).toFixed()}%`; } catch { return "无效资料"; }
}

export function profileFromForm(form: FormData) {
  const value = (key: string) => String(form.get(key) ?? "").trim();
  const nullable = (key: string) => value(key) || null;
  const tags = (key: string) => value(key).split(",").map(value => value.trim()).filter(Boolean);
  return {
    issuer: nullable("issuer"), index_id: nullable("index_id"), domicile: nullable("domicile"),
    underlying_asset_class: value("underlying_asset_class"), economic_regions: tags("economic_regions"), sectors: tags("sectors"),
    annual_expense_ratio: nullable("annual_expense_ratio"), distribution: value("distribution"), replication: value("replication"),
  };
}
