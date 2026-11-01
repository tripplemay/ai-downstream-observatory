import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ExactJsonNumber, exactNonnegativeDecimal, parseExactJson } from "../src/server/exact-json";

test("exact JSON keeps original decimal and integer tokens beyond binary precision", () => {
  const values = parseExactJson('[0.123456789123456789,12345678912345678912345678912345678912,1.2300e-2,-0.00]') as ExactJsonNumber[];
  assert.deepEqual(values.map(value => value.lexical), ["0.123456789123456789", "12345678912345678912345678912345678912", "1.2300e-2", "-0.00"]);
  assert.deepEqual(values.map(value => exactNonnegativeDecimal(value)), ["0.123456789123456789", "12345678912345678912345678912345678912", "0.0123", "0"]);
  assert.throws(() => Number(values[0]), /COERCION_FORBIDDEN/);
  assert.throws(() => JSON.stringify(values), /NORMALIZATION_REQUIRED/);
  assert.ok(Object.isFrozen(values[0]));
});

test("exact JSON distinguishes numeric tokens from strings and marker-shaped objects", () => {
  const value = parseExactJson('{"number":1,"text":"1","marker":{"lexical":"1"},"null":null,"flag":false}') as Record<string, unknown>;
  assert.ok(value.number instanceof ExactJsonNumber); assert.equal(value.text, "1"); assert.equal(value.null, null); assert.equal(value.flag, false);
  for (const invalid of [value.text, value.marker, 1, true, null]) assert.throws(() => exactNonnegativeDecimal(invalid), /DECIMAL_REQUIRED/);
});

test("exact JSON handles escaped keys and strings without prototype pollution", () => {
  const raw = '{"__proto__":{"fictionalPolluted":true},"constructor":"value","escaped\\u0061":"quoted \\\" { , : [ ]","text":"\\uD83D\\uDE00"}';
  assert.deepEqual(parseExactJson(raw), JSON.parse(raw));
  assert.equal(({} as Record<string, unknown>).fictionalPolluted, undefined);
  assert.throws(() => parseExactJson('{"a":1,"\\u0061":2}'), /DUPLICATE_JSON_KEY/);
  assert.throws(() => parseExactJson('[{"nested":{"x":1,"x":2}}]'), /DUPLICATE_JSON_KEY/);
});

test("exact JSON rejects invalid syntax, deep input, oversized tokens and byte limits", () => {
  for (const raw of ["", "NaN", "Infinity", "01", "[1,]", '{"x":undefined}', "{} false"])
    assert.throws(() => parseExactJson(raw), /EXACT_JSON/);
  assert.throws(() => parseExactJson("[".repeat(65) + "0" + "]".repeat(65)), /JSON_DEPTH_EXCEEDED/);
  assert.throws(() => parseExactJson("1".repeat(81)), /NUMBER_INVALID/);
  assert.throws(() => parseExactJson('"abc"', 4), /LIMIT/);
  assert.throws(() => parseExactJson("0", 8388609), /LIMIT/);
});

test("fact boundaries reject original excess scale and digits instead of rounding or trimming first", () => {
  for (const raw of ["1.2300000000000000000", "0.0000000000000000001", "1".repeat(39), "1e38", "0e38", "1e9999", "1e-9999"])
    assert.throws(() => exactNonnegativeDecimal(parseExactJson(raw)), /OUT_OF_RANGE/);
  for (const [raw, expected] of [["1e-18", "0.000000000000000001"], ["1e37", "1" + "0".repeat(37)],
    ["100.000", "100"], ["1.230000000000000000", "1.23"], ["1e+0002", "100"], ["0e-18", "0"]])
    assert.equal(exactNonnegativeDecimal(parseExactJson(raw)), expected);
  assert.throws(() => exactNonnegativeDecimal(parseExactJson("-0.01")), /SIGN/);
  assert.throws(() => exactNonnegativeDecimal(parseExactJson("0"), true), /SIGN/);
  assert.equal(exactNonnegativeDecimal(parseExactJson("0.01"), true), "0.01");
});

test("fictional numeric spelling matrix matches the independent Python fact boundary exactly", () => {
  const cases = ["-0", "-0.00", "1.2300000000000000000", "0e000000000000000000000000000000000000000000001"];
  for (const coefficient of ["0", "1", "1200", "0.0012300", "12345678912345678912345678912345678912", "1.230000000000000000"])
    for (const exponent of [-1000, -38, -19, -18, -1, 0, 1, 18, 37, 38, 1000])
      cases.push(coefficient + "e" + exponent);
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c", `
import json,sys
from decimal import Decimal
from worker.accounting.decimal_math import canonical,fact_decimal
def evaluate(raw):
 try:
  value=fact_decimal(json.loads(raw,parse_int=Decimal,parse_float=Decimal))
  if value<0:raise ValueError()
  return canonical(value)
 except Exception:return None
print(json.dumps([evaluate(raw) for raw in json.load(sys.stdin)]))
`], { cwd: new URL("../../", import.meta.url), input: JSON.stringify(cases), encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, NODE_ENV: "test" } });
  assert.equal(child.status, 0, child.stderr);
  const expected = JSON.parse(child.stdout) as (string | null)[];
  cases.forEach((raw, index) => {
    let actual: string | null = null;
    try { actual = exactNonnegativeDecimal(parseExactJson(raw)); } catch { /* Rejected facts remain unavailable. */ }
    assert.equal(actual, expected[index], "Fictional numeric spelling " + index);
  });
});
