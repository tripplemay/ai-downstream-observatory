import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const deploy=readFileSync(join(root,'scripts/deploy-workbench.sh'),'utf8');
function fixture(t) {const directory=mkdtempSync(join(tmpdir(),'ai-release-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));return directory;}
function definition(name) {const value=deploy.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`,'m'))?.[0];assert.ok(value,name);return value;}

test('AI release flags come only from protected configuration and paths are private, independent and outside stored business artifacts',t=>{
  const directory=fixture(t),config=join(directory,'release.env'),sha='a'.repeat(40);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(WORKBENCH_|COMPOSE_)/.test(key)));
  const run=(extra='',ambient={})=>{
    writeFileSync(config,`WORKBENCH_DEPLOY_ROOT=${directory}\nWORKBENCH_RUNTIME_ENV_FILE=${directory}/runtime.env\nWORKBENCH_BACKUP_KEY_FILE=${directory}/backup.passphrase\n${extra}`,{mode:0o600});
    return spawnSync('bash',[join(root,'scripts/deploy-workbench.sh'),'--release',sha,'--release-dir',`${directory}/releases/${sha}`,'--config',config],{encoding:'utf8',env:{...env,...ambient}});
  };
  const disabled=run('',{WORKBENCH_AI_ENABLED:'1',WORKBENCH_AI_ENABLE_DISPATCH:'1',WORKBENCH_AI_CONFIG_FILE_HOST:'/ambient/never-read'});
  assert.equal(disabled.status,0,disabled.stderr);assert.match(disabled.stdout,/Optional AI explanation enabled: 0/);assert.match(disabled.stdout,/AI explicit-request dispatch enabled: 0/);
  const paths=`WORKBENCH_AI_CONFIG_FILE_HOST=${directory}/gateway.json\nWORKBENCH_AI_CONSENT_FILE_HOST=${directory}/consent.json\n`;
  for(const flag of ['true','2','-1'])assert.notEqual(run(`WORKBENCH_AI_ENABLED=${flag}\n${paths}`).status,0);
  for(const flag of ['true','2','-1'])assert.notEqual(run(`WORKBENCH_AI_ENABLED=1\nWORKBENCH_AI_ENABLE_DISPATCH=${flag}\n${paths}`).status,0);
  assert.notEqual(run('WORKBENCH_AI_ENABLE_DISPATCH=1\n').status,0);
  assert.notEqual(run('WORKBENCH_AI_ENABLED=1\n').status,0);
  for(const file of [`${directory}/runtime.env`,`${directory}/backup.passphrase`,config,`${directory}/consent.json`,'relative.json','/tmp/../alias.json',
    ...['data-workbench','backups-workbench','restores-workbench','releases','incoming'].map(name=>`${directory}/${name}/gateway.json`)]) {
    assert.notEqual(run(`WORKBENCH_AI_ENABLED=1\nWORKBENCH_AI_CONFIG_FILE_HOST=${file}\nWORKBENCH_AI_CONSENT_FILE_HOST=${directory}/consent.json\n`).status,0,file);
  }
  const enabled=run(`WORKBENCH_AI_ENABLED=1\n${paths}`);assert.equal(enabled.status,0,enabled.stderr);
  assert.match(enabled.stdout,/Optional AI explanation enabled: 1/);assert.match(enabled.stdout,/AI explicit-request dispatch enabled: 0/);
  assert.doesNotMatch(enabled.stdout,/gateway\.json|consent\.json|API_KEY|api_key/);
  assert.equal(run(`WORKBENCH_AI_ENABLED=1\nWORKBENCH_AI_ENABLE_DISPATCH=1\n${paths}`).status,0);
});

test('all provider and AI combinations retain exact explicit image, build and start inventories',t=>{
  const directory=fixture(t);
  for(const name of ['docker-compose.market-provider.yml','docker-compose.ai-explanation.yml'])writeFileSync(join(directory,name),'services: {}\n');
  const configure=deploy.slice(deploy.indexOf('compose_options=('),deploy.indexOf('compose() {'));
  for(const provider of ['0','1'])for(const ai of ['0','1']) {
    const result=spawnSync('bash',['-c',configure+'\nprintf \'%s\\n\' "${build_services[*]}" "${start_services[*]}" "${release_images[*]}" "${compose_options[*]}"'],{
      encoding:'utf8',env:{...process.env,WORKBENCH_MARKET_PROVIDER_ENABLED:provider,WORKBENCH_AI_ENABLED:ai,WORKBENCH_EODHD_ENABLED:'0',
        WORKBENCH_PROJECT:'synthetic',release_dir:directory,config:'/synthetic/release.env',release_sha:'synthetic-sha'}});
    assert.equal(result.status,0,result.stderr);const lines=result.stdout.trim().split('\n'),suffix=(provider==='1'?' market-provider':'')+(ai==='1'?' ai-explanation':'');
    assert.equal(lines[0],'web worker'+suffix);assert.equal(lines[1],'web worker verifier'+suffix);
    assert.equal(lines[2].includes('etf-workbench-ai-explanation:synthetic-sha'),ai==='1');
    assert.equal(lines[3].includes('docker-compose.ai-explanation.yml'),ai==='1');
  }
});

test('old AI writers are freshly enumerated by exact project and service even when the new release disables AI',t=>{
  const directory=fixture(t),functions=['ai_explanation_ids','stop_ai_explanation_writers','assert_ai_explanation_stopped'].map(definition).join('\n');
  const script=`${functions}
docker() { printf '%s\\n' "$*" >> "$TRACE"; case "$1" in ps) printf '%s\\n' "$IDS"; return "\${LIST_STATUS:-0}";; stop) return "\${STOP_STATUS:-0}";; inspect) printf '%s\\n' "\${RUNNING:-false}";; *) return 91;; esac; }
timeout() { shift; "$@"; }
stop_ai_explanation_writers || exit 10
assert_ai_explanation_stopped || exit 11
`;
  for(const ids of ['', 'a'.repeat(12),`${'b'.repeat(64)}\n${'c'.repeat(12)}`]) {
    const trace=join(directory,`trace-${ids.length}`),result=spawnSync('bash',['-c',script],{encoding:'utf8',env:{...process.env,WORKBENCH_AI_ENABLED:'0',WORKBENCH_PROJECT:'synthetic-ai',IDS:ids,TRACE:trace}});
    assert.equal(result.status,0,result.stderr);const calls=readFileSync(trace,'utf8').trim().split('\n');
    for(const line of calls.filter(line=>line.startsWith('ps '))) {
      assert.ok(line.includes('--filter label=com.docker.compose.project=synthetic-ai'));assert.ok(line.includes('--filter label=com.docker.compose.service=ai-explanation'));
    }
    assert.equal(calls.filter(line=>line.startsWith('stop ')).length,ids?ids.split('\n').length:0);
  }
  for(const extra of [{IDS:'unrelated-name'},{LIST_STATUS:'1'},{STOP_STATUS:'1'},{RUNNING:'true'}]) {
    const result=spawnSync('bash',['-c',script],{encoding:'utf8',env:{...process.env,WORKBENCH_PROJECT:'synthetic-ai',IDS:'a'.repeat(12),TRACE:join(directory,'invalid'),...extra}});
    assert.equal(result.status,10,JSON.stringify(extra));
  }
  const restarted=`${functions}
docker() { case "$1" in ps) printf 'aaaaaaaaaaaa\\n';; stop) return 0;; inspect) if [[ -e "$MARKER" ]]; then printf 'true\\n'; else touch "$MARKER"; printf 'false\\n'; fi;; esac; }
timeout() { shift; "$@"; }
stop_ai_explanation_writers || exit 10
assert_ai_explanation_stopped || exit 11`;
  const result=spawnSync('bash',['-c',restarted],{encoding:'utf8',env:{...process.env,WORKBENCH_PROJECT:'synthetic-ai',MARKER:join(directory,'restarted')}});
  assert.equal(result.status,11,result.stderr);
});

test('AI credential metadata checks reject ownership, permission, link, size and inode aliases without reading their content',t=>{
  const directory=realpathSync(fixture(t)),gateway=join(directory,'gateway.json'),consent=join(directory,'consent.json'),runtime=join(directory,'runtime.env');
  for(const file of [gateway,consent,runtime])writeFileSync(file,'FICTIONAL DO NOT READ',{mode:0o600});
  const script=`${definition('assert_ai_credentials')}
stat() { if [[ "$2" == '%s' ]]; then printf '%s\\n' "\${BYTES:-20}"; else printf '%s\\n' "\${META:-10001:600:1}"; fi; }
assert_ai_credentials`;
  const env={...process.env,WORKBENCH_AI_ENABLED:'1',WORKBENCH_AI_CONFIG_FILE_HOST:gateway,WORKBENCH_AI_CONSENT_FILE_HOST:consent,
    WORKBENCH_RUNTIME_ENV_FILE:runtime,WORKBENCH_BACKUP_KEY_FILE:join(directory,'backup.passphrase'),config:join(directory,'release.env')};
  const run=extra=>spawnSync('bash',['-c',script],{encoding:'utf8',env:{...env,...extra}});
  const accepted=run({});assert.equal(accepted.status,0,accepted.stderr);
  for(const extra of [{META:'0:600:1'},{META:'10001:644:1'},{META:'10001:600:2'},{BYTES:'0'},{BYTES:'16385'}])assert.notEqual(run(extra).status,0);
  const alias=join(directory,'alias.json');linkSync(runtime,alias);
  assert.notEqual(run({WORKBENCH_AI_CONFIG_FILE_HOST:alias}).status,0);
});

test('AI configuration preflight has no network, data volume, inherited env file or broker secrets',t=>{
  const directory=fixture(t),trace=join(directory,'arguments'),script=`${definition('ai_configuration_preflight')}
docker() { printf '%s\\0' "$@" > "$TRACE"; }
timeout() { shift; "$@"; }
ai_configuration_preflight`;
  const result=spawnSync('bash',['-c',script],{encoding:'utf8',env:{...process.env,WORKBENCH_AI_ENABLE_DISPATCH:'0',
    WORKBENCH_AI_CONFIG_FILE_HOST:'/synthetic/gateway.json',WORKBENCH_AI_CONSENT_FILE_HOST:'/synthetic/consent.json',release_sha:'a'.repeat(40),TRACE:trace}});
  assert.equal(result.status,0,result.stderr);const args=readFileSync(trace,'utf8').split('\0').filter(Boolean);
  assert.deepEqual(args.slice(0,5),['run','--rm','--network','none','--read-only']);
  assert.ok(args.includes('10001:10001'));assert.equal(args.at(-1),'--config-check');assert.ok(args.includes('--cap-drop'));
  assert.equal(args.filter(value=>value.startsWith('type=bind,')).length,2);
  for(const value of args)assert.doesNotMatch(value,/--env-file|WORKBENCH_DB_PATH|\/app\/data|LONGPORT_|LONGBRIDGE_|PASSWORD|SESSION_SECRET/);
});

test('AI image selection, config preflight, old writer fences, failure cleanup and health are wired into guarded cutover',()=>{
  const workflow=readFileSync(join(root,'.github/workflows/deploy.yml'),'utf8');
  assert.match(workflow,/ai_explanation:/);assert.match(workflow,/--ai-explanation "\$INCLUDE_AI_EXPLANATION"/);
  assert.match(deploy,/--ai-explanation "\$WORKBENCH_AI_ENABLED"/);
  assert.equal((deploy.match(/stop_market_provider_writers\n  stop_ai_explanation_writers/g)??[]).length,2);
  assert.match(deploy,/assert_ai_explanation_stopped\nassert_market_provider_stopped\nassert_no_recovery\nmutation_started=1/);
  assert.match(deploy,/stop_ai_explanation_writers >\/dev\/null 2>&1 \|\| true[\s\S]*?RESTORE_PENDING_REVIEW/);
  assert.ok(deploy.indexOf('ai-configuration.json')<deploy.indexOf('pre-stop-backup.json'));
  assert.match(deploy,/ai-explanation.*--health > "\$evidence\/ai-readiness\.txt"/);
  assert.match(deploy,/else\n  assert_ai_explanation_stopped\nfi/);
  const compose=readFileSync(join(root,'docker-compose.yml'),'utf8');assert.match(compose,/WORKBENCH_AI_BACKGROUND_ENABLED: "0"/);
});

test('Linux AI smoke owns only its labeled synthetic resources, denies network, checks native health and is required by CI',()=>{
  const smoke=readFileSync(join(root,'tests/deployment/ai-container-smoke.sh'),'utf8');
  for(const value of ['Dockerfile.ai-explanation','--platform linux/amd64','etf.fixture.ai-release=$run_id','trap cleanup EXIT','--network none',
    'WORKBENCH_AI_ENABLE_DISPATCH=0','--config-check','--health','--user 0:0','10001:10001','financial_facts:0','automatic_requests:0','real_gateway_called:false'])assert.ok(smoke.includes(value),value);
  assert.match(smoke,/docker volume inspect "\$volume" --format/);assert.match(smoke,/docker volume rm "\$volume"/);
  assert.equal((smoke.match(/--interactive/g)??[]).length,2);
  assert.ok(smoke.includes('stop_ai_explanation_writers\nassert_ai_explanation_stopped'));
  assert.ok(smoke.indexOf('cleanup_resources\n[[')<smoke.indexOf("NODE_REPORT'"));
  assert.ok(smoke.includes('native_writer_fence_verified:true,owned_resources_removed:true'));
  assert.doesNotMatch(smoke,/prune|docker image rm|docker system|\/opt\/observatory|deploysvr/);
  const ci=readFileSync(join(root,'.github/workflows/ci.yml'),'utf8');assert.match(ci,/run: bash tests\/deployment\/ai-container-smoke\.sh/);
  assert.match(ci,/path: artifacts\/verification\/container-\*\.json/);
});
