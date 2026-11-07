import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { aiSourceFiles } from "../../scripts/ai-explanation-source.mjs";
import { checkAiRuntimeHealth } from "../scripts/ai-runtime-health.mjs";
import { aiExplanationImplementationHash } from "../src/server/investor/ai-explanation-process";
import { investorActor, investorFixture, saveSyntheticProfile, seedSyntheticCandidate } from "./investor-fixture";
import { hash } from "../src/server/ledger/service";
import { aiLimitations, aiMonitorContextSchema } from "../src/server/investor/ai-explanation-schemas";
import { claimDurableAiRequest, finishDurableAiRequest, type AiRequestBinding } from "../src/server/investor/ai-explanation-store";

test("built configuration preflight verifies explicit dispatch and private current consent without a database or transport", () => {
  const directory=mkdtempSync(path.join(os.tmpdir(),"etf-ai-config-only-")),configFile=path.join(directory,"gateway.json"),consentFile=path.join(directory,"consent.json");
  const database=path.join(directory,"must-not-create.db"),attempts=path.join(directory,"network-attempts"),guard=path.join(directory,"deny-network.cjs");
  const now=Date.now(),config={schema_version:"readonly-ai-gateway-v1",base_url:"https://no-network.example.test/v1",api_key:"FICTIONAL_LOCAL_ONLY",model:"fictional-release-model",max_output_tokens:512};
  const consent={schema_version:"investor-ai-sharing-consent-v1",principal_id:"owner",gateway_audience_hash:hash({base_url:config.base_url,model:config.model,request_profile:null}),
    decision:"allow",allowed_categories:["model_ratios","target_deviation","strategy_trigger_codes"],source:"explicit_user_confirmation",
    valid_from:new Date(now-60000).toISOString(),valid_until:new Date(now+3600000).toISOString()};
  const writeConsent=(change:Record<string,unknown>={})=>writeFileSync(consentFile,JSON.stringify({...consent,...change}),{mode:0o600});
  try {
    writeFileSync(configFile,JSON.stringify(config),{mode:0o600});writeConsent();
    writeFileSync(guard,`const fs=require('node:fs');const deny=()=>{fs.appendFileSync(${JSON.stringify(attempts)},'DENIED\\n');throw Error('FICTIONAL_NO_TRANSPORT')};
for(const name of ['node:http','node:https']){require(name).request=deny;require(name).get=deny;}
require('node:net').connect=deny;require('node:net').createConnection=deny;require('node:tls').connect=deny;globalThis.fetch=deny;`,{mode:0o600});
    const run=(flag:string|undefined,args=["--config-check"],missing=false)=>spawnSync(process.execPath,["--require",guard,"scripts/run-ai-explanation.mjs",...args],{
      encoding:"utf8",timeout:20000,env:{PATH:process.env.PATH,NODE_ENV:"test",WORKBENCH_DB_PATH:database,
        ...(flag===undefined?{}:{WORKBENCH_AI_ENABLE_DISPATCH:flag}),WORKBENCH_AI_CONFIG_FILE:missing?"/must-not-read":configFile,
        WORKBENCH_AI_CONSENT_FILE:missing?"/must-not-read":consentFile}});
    for(const flag of [undefined,"0","1"]) {
      const result=run(flag,undefined,flag!=="1");assert.equal(result.status,0,result.stderr);
      assert.deepEqual(JSON.parse(result.stdout),{status:"ai_configuration_checked",dispatch_enabled:flag==="1",settings_checked:flag==="1",database_opened:false,transport_called:false});
    }
    for(const flag of ["true","2",""])assert.equal(run(flag).status,1);
    for(const change of [{valid_until:new Date(now-1).toISOString()},{principal_id:"foreign"},{gateway_audience_hash:"a".repeat(64)}]) {
      writeConsent(change);const failed=run("1");assert.equal(failed.status,1);assert.equal(failed.stdout,"");assert.equal(failed.stderr,"AI_RUNTIME_UNAVAILABLE\n");
    }
    writeConsent();chmodSync(configFile,0o644);assert.equal(run("1").status,1);chmodSync(configFile,0o600);
    assert.equal(run("0",["--config-check","--once"]).status,1);
    assert.equal(existsSync(database),false);assert.equal(existsSync(attempts),false);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test("built launcher verifies the complete source map and rejects tampered bundle, source or arbitrary CLI input", () => {
  const root = path.resolve(".."), directory = mkdtempSync(path.join(os.tmpdir(), "etf-ai-runtime-proof-"));
  try {
    const sources = aiSourceFiles(root);
    for (const name of [...Object.keys(sources), "web/dist/ai-explanation.mjs", "web/dist/ai-explanation.manifest.json"]) {
      const file = path.join(directory, name); mkdirSync(path.dirname(file), { recursive: true }); cpSync(path.join(root, name), file);
    }
    const command = (args: string[]) => spawnSync(process.execPath, [path.join(directory, "web/scripts/run-ai-explanation.mjs"), ...args], { encoding: "utf8", timeout: 20000 });
    assert.equal(command(["--check"]).status, 0);
    const previousDirectory = process.cwd();
    for (const relative of ["web/scripts/ai-runtime-health.mjs", "web/src/server/market-date.ts"]) {
      const helperSource = path.join(directory, relative), helperOriginal = readFileSync(helperSource);
      try {
        process.chdir(directory);
        const before = aiExplanationImplementationHash();
        writeFileSync(helperSource, Buffer.concat([helperOriginal, Buffer.from("\n")]));
        assert.notEqual(aiExplanationImplementationHash(), before, "shared helper sources must participate in the explanation implementation binding");
      } finally { writeFileSync(helperSource, helperOriginal); process.chdir(previousDirectory); }
    }
    const bundle = path.join(directory, "web/dist/ai-explanation.mjs"), original = readFileSync(bundle);
    writeFileSync(bundle, Buffer.concat([original, Buffer.from("\n")]));
    const changed = command(["--check"]); assert.equal(changed.status, 1); assert.equal(changed.stderr, "AI_RUNTIME_UNAVAILABLE\n");
    writeFileSync(bundle, original);
    const source = path.join(directory, "worker/ai_explanation/context.py"); writeFileSync(source, "# Fictional source tampering\n");
    assert.equal(command(["--check"]).status, 1);
    cpSync(path.join(root, "worker/ai_explanation/context.py"), source);
    // Bad CLI input is refused before it can open a database or execute a caller-selected command.
    const actual = spawnSync(process.execPath, ["scripts/run-ai-explanation.mjs", "--db", "/arbitrary"], { encoding: "utf8", timeout: 20000 });
    assert.equal(actual.status, 1); assert.equal(actual.stderr, "AI_RUNTIME_UNAVAILABLE\n");
    const manifestFile = path.join(directory, "web/dist/ai-explanation.manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const unusableBundle = Buffer.from('throw new Error("HEALTH_MUST_NOT_IMPORT_APPLICATION");\n');
    writeFileSync(bundle, unusableBundle);
    manifest.bundle_sha256 = createHash("sha256").update(unusableBundle).digest("hex");
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const guard = path.join(directory, "health-only.cjs");
    writeFileSync(guard, `const fs=require('node:fs'),original=fs.readFileSync;
fs.readFileSync=function(file,...args){if(file==='/tmp/etf-ai-runtime-health.json')return JSON.stringify({status:process.env.FICTIONAL_HEALTH_STATUS,at:Date.now()-Number(process.env.FICTIONAL_HEALTH_AGE)});return original.call(this,file,...args)};
require('node:module').syncBuiltinESMExports();`);
    const health = (flag = "0", args = ["--health"], age = 0, status = "ready") => spawnSync(process.execPath, ["--require", guard, path.join(directory, "web/scripts/run-ai-explanation.mjs"), ...args],
      { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, NODE_ENV: "test", WORKBENCH_AI_ENABLE_DISPATCH: flag,
        FICTIONAL_HEALTH_AGE: String(age), FICTIONAL_HEALTH_STATUS: status } });
    assert.equal(health().status, 0, "health must verify integrity and heartbeat without importing the application bundle");
    assert.equal(health("true").status, 1);
    assert.equal(health("0", ["--health", "--once"]).status, 1);
    assert.equal(health("0", ["--health"], 120001).status, 1);
    assert.equal(health("0", ["--health"], -60000).status, 1);
    assert.equal(health("0", ["--health"], 0, "unavailable").status, 1);
    const helper = path.join(directory, "web/scripts/ai-runtime-health.mjs"), helperOriginal = readFileSync(helper);
    writeFileSync(helper, Buffer.concat([helperOriginal, Buffer.from("\n")]));
    assert.equal(health().status, 1, "health must still reject an altered source file");
    writeFileSync(helper, helperOriginal);
    assert.equal(health().status, 0);
    writeFileSync(bundle, Buffer.concat([unusableBundle, Buffer.from("\n")]));
    assert.equal(health().status, 1, "health must still reject an altered application bundle");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("lightweight AI health preserves ready, expiry, future-clock and malformed heartbeat rejection", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "etf-ai-heartbeat-")), file = path.join(directory, "heartbeat.json");
  const now = 1794027600000;
  const write = (value: unknown) => writeFileSync(file, JSON.stringify(value));
  try {
    for (const at of [now, now - 120000]) { write({ status: "ready", at }); assert.doesNotThrow(() => checkAiRuntimeHealth(file, now)); }
    for (const value of [{ status: "ready", at: now - 120001 }, { status: "ready", at: now + 1 },
      { status: "unavailable", at: now }, { status: "ready", at: String(now) }, { status: "ready", at: null }, null, []]) {
      write(value); assert.throws(() => checkAiRuntimeHealth(file, now));
    }
    writeFileSync(file, "{"); assert.throws(() => checkAiRuntimeHealth(file, now));
    rmSync(file); assert.throws(() => checkAiRuntimeHealth(file, now));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the real fixed-owner executable clears an expired stored payload at startup with dispatch disabled", () => {
  const f = investorFixture(), actor = { id: "owner" }, now = "2026-01-03T12:00:00.000Z";
  try {
    assert.notEqual(actor.id, investorActor.id); saveSyntheticProfile(f, actor); const seed = seedSyntheticCandidate(f, "observe", actor);
    const workspace = (f.db.prepare("SELECT id FROM investor_workspaces WHERE owner_id=?").get(actor.id) as { id: string }).id;
    const context = aiMonitorContextSchema.parse({ schema_version: "ai-monitor-context-v1", deterministic_outcome: "observe", evaluated_at: now,
      evidence: [{ evidence_id: "derived:max_abs_target_gap", metric: "model.max_abs_target_gap", value: "0", as_of: now },
        { evidence_id: "derived:target_change_count", metric: "model.target_change_count", value: "0", as_of: now }],
      trigger_codes: ["FIXED_POLICY_WITHIN_CLASS_BANDS"], limitations: aiLimitations, strategy_gates: { investment_gate_passed: false, live_advice_eligible: false } });
    const b: AiRequestBinding = { workspace_id: workspace, actor_id: actor.id, observation_id: seed.observationId, source_binding_hash: hash("fictional-source"),
      context_hash: hash(context), config_hash: hash("fictional-config"), consent_hash: hash("fictional-consent"), implementation_hash: hash("fictional-implementation"),
      binding_hash: "", valid_until: "2026-01-04T12:00:00.000Z" };
    b.binding_hash = hash({ binding: b.source_binding_hash, context: b.context_hash, config: b.config_hash, consent: b.consent_hash,
      implementation: b.implementation_hash, valid_until: b.valid_until });
    const claim = claimDurableAiRequest(f.db, b, now)!;
    const review = { schema_version: "ai-research-review-v1" as const, facts: context.evidence, inferences: [], supporting_evidence: [], counter_evidence: [], risks: [],
      recommendation: "maintain_research" as const, reason: "Fictional executable retention component, not qualified research", unknowns: [], invalidation_conditions: [] };
    finishDurableAiRequest(f.db, b, claim, context, now, review, null);
    const rows = () => (f.db.prepare("SELECT count(*) n FROM investor_ai_payloads").get() as { n: number }).n;
    assert.equal(rows(), 1);
    const child = spawnSync(process.execPath, ["scripts/run-ai-explanation.mjs", "--once"], { encoding: "utf8", timeout: 60000,
      env: { ...process.env, WORKBENCH_DB_PATH: f.filename, WORKBENCH_DATA_DIR: f.directory, WORKBENCH_MODE: "ledger",
        WORKBENCH_AI_ENABLE_DISPATCH: "0", WORKBENCH_AI_CONFIG_FILE: "", WORKBENCH_AI_CONSENT_FILE: "", WORKBENCH_AI_PYTHON: "/no-ai-transport" } });
    assert.equal(child.status, 0, child.stderr); assert.equal(rows(), 0);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_dispatches").get() as { n: number }).n, 1);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_outcomes").get() as { n: number }).n, 1);
  } finally { f.close(); }
});
