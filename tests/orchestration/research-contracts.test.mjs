import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";

const require = createRequire(new URL("../../web/package.json", import.meta.url));
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const directory = new URL("../../contracts/v1/", import.meta.url);
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats(ajv);
for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".schema.json"))) {
  ajv.addSchema(JSON.parse(fs.readFileSync(new URL(name, directory), "utf8")));
}

test("seven authenticated research command shapes reject actor, prepared result and authority injection", () => {
  const script = "import json; from tests.research.fixtures import dataset,plan,parameters; print(json.dumps({'dataset':dataset(),'plan':plan(),'parameters':parameters()}))";
  const fixtureProcess = spawnSync(process.env.WORKBENCH_PYTHON || "python3", ["-c", script],
    { cwd: new URL("../../", import.meta.url), encoding: "utf8" });
  assert.equal(fixtureProcess.status, 0, fixtureProcess.stderr);
  const fixture = JSON.parse(fixtureProcess.stdout);
  const validate = ajv.getSchema("https://etf-workbench.invalid/contracts/v1/research-command.schema.json");
  const payloads = {
    research_register: { experiment_id: "exp", plan: fixture.plan, dataset: fixture.dataset },
    research_register_trial: { experiment_id: "exp", phase: "train", parameters: fixture.parameters },
    research_trial: { trial_id: "trial:1" },
    research_freeze: { experiment_id: "exp", validation_trial_id: "trial:1", reason: "Human choice" },
    research_unseal: { experiment_id: "exp", reason: "Human exposure" },
    research_ai_context: { run_id: "run:1" },
    research_ai_review: { run_id: "run:1", model: "mock", raw_output: "Untrusted model text; validated separately" },
  };
  for (const [command_type, payload] of Object.entries(payloads)) {
    assert.equal(validate({ command_type, payload }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ command_type, payload: { ...payload, actor_id: "ai" } }), false);
    assert.equal(validate({ command_type, payload, actor_id: "ai" }), false);
    assert.equal(validate({ command_type, payload: { ...payload, portfolio_id: "other" } }), false);
    assert.equal(validate({ command_type, payload: { ...payload, prepared: {} } }), false);
  }
  assert.equal(validate({ command_type: "research_activate", payload: {} }), false);
  assert.equal(validate({ command_type: "research_trial", payload: { trial_id: "trial:1", result_json: "{}" } }), false);
  assert.equal(validate({ command_type: "research_register_trial", payload: { ...payloads.research_register_trial, parameters: { ...fixture.parameters, weights: { "CN:TEST": 1 } } } }), false);
});
