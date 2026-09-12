import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(new URL("../../web/package.json", import.meta.url));
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const directory = new URL("../../contracts/v1/", import.meta.url);
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats(ajv);
for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".schema.json"))) {
  ajv.addSchema(JSON.parse(fs.readFileSync(new URL(name, directory), "utf8")));
}
const schema = name => ajv.getSchema(`https://etf-workbench.invalid/contracts/v1/${name}.schema.json`);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);

test("Python per-event FX manifest validates in shared Ajv contracts without rounding derived amounts", () => {
  const run = spawnSync(process.env.WORKBENCH_PYTHON || "python3", ["-c",
    "import json; from tests.performance.test_flow_fx import contract_fixture; print(json.dumps(contract_fixture()))"],
  { cwd: new URL("../../", import.meta.url), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const fixture = JSON.parse(run.stdout);
  for (const [name, value] of [["performance-input-v5", fixture.manifest], ["flow-fx-rules", fixture.rules]]) {
    const validate = schema(name);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
  const evidence = fixture.manifest.external_flow_evidence[0];
  assert.deepEqual(fixture.result.external_flow_evidence, fixture.manifest.external_flow_evidence);
  assert.equal(evidence.amount_cny, "700.000000000000000107000000000000000001");
  const { binding_id, ...bound } = evidence;
  assert.equal(createHash("sha256").update(canonical(bound)).digest("hex"), binding_id);
  const validate = schema("flow-fx-evidence-v2");
  assert.equal(validate({ ...evidence, amount_cny: 700 }), false);
  assert.equal(validate({ ...evidence, execute_trade: true }), false);
  const command = { valuation_ids: ["start", "end"], evaluation_timezone: "Asia/Shanghai", flow_fx_rules: fixture.rules };
  assert.equal(schema("performance-command")(command), true);
  assert.equal(schema("performance-command")({ ...command, fx_rate: "7" }), false);
  assert.equal(schema("flow-fx-rules")({ ...fixture.rules, live_advice_eligible: true }), false);
  const missing = { ...fixture.rules };
  delete missing.approval_evidence;
  assert.equal(schema("flow-fx-rules")(missing), false);
});

test("real TypeScript security ledger produces Python v4 valuation and v5 performance with shared hashes", () => {
  const run = spawnSync(process.env.WORKBENCH_PYTHON || "python3", ["-c",
    "import json; from tests.performance.test_security_flows import security_contract_fixture; print(json.dumps(security_contract_fixture()))"],
  { cwd: new URL("../../", import.meta.url), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const fixture = JSON.parse(run.stdout);
  assert.equal(schema("performance-input-v5")(fixture.manifest), true, JSON.stringify(schema("performance-input-v5").errors));
  assert.equal(fixture.saved.method_version, "snapshot-performance-cny-v5");
  assert.equal(fixture.result.net_profit_cny, "0");
  assert.equal(fixture.result.external_flow_cny, "100");
  assert.deepEqual(fixture.result.external_flow_evidence, fixture.manifest.external_flow_evidence);
  for (const valuation of fixture.valuations) {
    assert.equal(valuation.method, "decimal-nav-cny-v4:restated");
    assert.equal(schema("valuation-input-v3")(valuation.manifest), true, JSON.stringify(schema("valuation-input-v3").errors));
  }
  const flow = fixture.manifest.external_flow_evidence[0], { binding_id, ...bound } = flow;
  assert.equal(flow.flow_kind, "security");
  assert.equal(schema("flow-fx-evidence-v2")(flow), true);
  assert.equal(createHash("sha256").update(canonical(bound)).digest("hex"), binding_id);
  assert.equal(schema("security-transfer-value")(flow.security.value_evidence), true);
  assert.equal(schema("flow-fx-evidence-v2")({ ...flow, flow_kind: "cash" }), false);
  assert.equal(schema("flow-fx-evidence-v2")({ ...flow, security: null }), false);
  assert.equal(schema("security-transfer-value")({ ...flow.security.value_evidence, approve_trade: true }), false);
});
