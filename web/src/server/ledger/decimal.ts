import DecimalJs from "decimal.js";

export const Decimal = DecimalJs.clone({ precision: 60, rounding: DecimalJs.ROUND_HALF_EVEN, toExpNeg: -100, toExpPos: 100 });
export type Decimal = DecimalJs;
export type Amount = DecimalJs;

export function amount(value: unknown): Amount {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error("INVALID_DECIMAL: expected a canonical decimal string");
  }
  const digits = value.replace(/[-.]/g, "").replace(/^0+/, "");
  if (digits.length > 38 || (value.split(".")[1]?.length ?? 0) > 18) throw new Error("DECIMAL_RANGE");
  return new Decimal(value);
}

export function positive(value: unknown): Amount {
  const result = amount(value);
  if (!result.gt(0)) throw new Error("AMOUNT_MUST_BE_POSITIVE");
  return result;
}

export function nonnegative(value: unknown): Amount {
  const result = amount(value);
  if (result.lt(0)) throw new Error("AMOUNT_MUST_BE_NONNEGATIVE");
  return result;
}

export function exact(value: Amount): string {
  const result = value.isZero() ? "0" : value.toFixed();
  amount(result);
  return result;
}

// Only derived inventory cost allocations are rounded here, never source cash.
export function allocatedCost(value: Amount): Amount {
  return value.toDecimalPlaces(18, Decimal.ROUND_HALF_EVEN);
}
