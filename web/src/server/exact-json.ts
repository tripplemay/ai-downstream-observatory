import { parseStrictJson } from "./strict-json";

const NUMBER = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;

/** A numeric token is not a string field, a JS number, or a caller-made marker. */
export class ExactJsonNumber {
  constructor(readonly lexical: string) {
    if (lexical.length > 80 || !NUMBER.test(lexical)) throw new Error("EXACT_JSON_NUMBER_INVALID");
    Object.freeze(this);
  }

  valueOf(): never { throw new Error("EXACT_JSON_NUMBER_COERCION_FORBIDDEN"); }
  toJSON(): never { throw new Error("EXACT_JSON_NUMBER_NORMALIZATION_REQUIRED"); }
}

/** Retain every numeric token verbatim; only strings use JSON.parse's values. */
export function parseExactJson(raw: string, maximumBytes = 262144): unknown {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 8388608
    || typeof raw !== "string" || Buffer.byteLength(raw) < 1 || Buffer.byteLength(raw) > maximumBytes)
    throw new Error("EXACT_JSON_LIMIT");
  try { parseStrictJson(raw); }
  catch (error) {
    if (error instanceof Error && ["DUPLICATE_JSON_KEY", "JSON_DEPTH_EXCEEDED"].includes(error.message)) throw error;
    throw new Error("EXACT_JSON_INVALID");
  }
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/g;
  let token = tokens.exec(raw);
  const advance = () => { const previous = token?.[0]; token = tokens.exec(raw); return previous; };
  const take = (expected: string) => { if (advance() !== expected) throw new Error("EXACT_JSON_INVALID"); };
  function value(depth: number): unknown {
    if (depth > 64 || !token) throw new Error("EXACT_JSON_INVALID");
    const current = token[0];
    if (current === "{") {
      take("{"); const result: Record<string, unknown> = {};
      if (token?.[0] !== "}") {
        while (true) {
          const key = advance();
          if (!key?.startsWith('"')) throw new Error("EXACT_JSON_INVALID");
          take(":");
          Object.defineProperty(result, JSON.parse(key) as string, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
          if (token?.[0] !== ",") break;
          take(",");
        }
      }
      take("}"); return result;
    }
    if (current === "[") {
      take("["); const result: unknown[] = [];
      if (token?.[0] !== "]") {
        while (true) {
          result.push(value(depth + 1));
          if (token?.[0] !== ",") break;
          take(",");
        }
      }
      take("]"); return result;
    }
    advance();
    if (current.startsWith('"')) return JSON.parse(current) as string;
    if (current === "true") return true;
    if (current === "false") return false;
    if (current === "null") return null;
    return new ExactJsonNumber(current);
  }
  const result = value(0);
  if (token) throw new Error("EXACT_JSON_INVALID");
  return result;
}

/** Match Python fact_decimal's original 38-digit / 18-scale boundary first. */
export function exactNonnegativeDecimal(value: unknown, positive = false): string {
  if (!(value instanceof ExactJsonNumber) || typeof positive !== "boolean") throw new Error("EXACT_JSON_DECIMAL_REQUIRED");
  const match = NUMBER.exec(value.lexical)!;
  const fraction = match[3] ?? "", coefficient = (match[2] + fraction).replace(/^0+/, "") || "0";
  const exponentText = (match[4] ?? "0").replace(/^([+-]?)0+([0-9])/, "$1$2");
  if (exponentText.replace(/^[+-]/, "").length > 4) throw new Error("EXACT_JSON_DECIMAL_OUT_OF_RANGE");
  const exponent = Number(exponentText) - fraction.length;
  if (coefficient.length + Math.max(0, exponent) > 38 || -exponent > 18)
    throw new Error("EXACT_JSON_DECIMAL_OUT_OF_RANGE");
  if ((match[1] === "-" && coefficient !== "0") || (positive && coefficient === "0"))
    throw new Error("EXACT_JSON_DECIMAL_SIGN");
  if (coefficient === "0") return "0";
  if (exponent >= 0) return coefficient + "0".repeat(exponent);
  const point = coefficient.length + exponent;
  const text = point > 0 ? coefficient.slice(0, point) + "." + coefficient.slice(point)
    : "0." + "0".repeat(-point) + coefficient;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}
