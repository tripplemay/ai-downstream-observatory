import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,scryptSync,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {migrateWorkbench} from '../../scripts/migrate-workbench.mjs';
import {runHttpFixture} from './http-fixture-process.mjs';

const web=fileURLToPath(new URL('../',import.meta.url)),root=path.dirname(web.replace(/\/$/,''));
assert.ok(process.argv.length===2||process.argv.length===3&&process.argv[2]==='--serve','Only --serve is accepted; no database, URL or clock input.');
const serve=process.argv[2]==='--serve',output=path.join(root,'artifacts/verification/current-first-close-http',new Date().toISOString().replace(/[:.]/g,'-'));
mkdirSync(output,{recursive:true});
const report={status:'RUNNING',started_at:new Date().toISOString(),actual_application_clock:true,fictional_calendar_and_sources:true,
  build_performed:false,build_id:readFileSync(path.join(web,'.next/BUILD_ID'),'utf8').trim(),cases:[],
  limitations:['Uses an explicitly fictional current calendar and stubbed transport, never an actual exchange close or provider certification.',
    'Only historical source construction freezes its sampled retrieval stamp; HTTP, core and first callback use the real wall clock.',
    'Funding decision uses an explicitly admitted fictional hypothetical intent, not the ordinary annual-plan midnight release path.',
    'Reuses the existing production build. TLS is locally generated and exactly pinned by this HTTP client, not production or native acceptance.']};
function inventory(){const names=['web/scripts/test-current-first-close-http.mjs','web/scripts/http-fixture-process.mjs','scripts/migrate-workbench.mjs',
  'web/next.config.ts','web/package.json','web/package-lock.json'];
  function scan(relative){for(const entry of readdirSync(path.join(root,relative),{withFileTypes:true})){const name=relative+'/'+entry.name;
    if(entry.isDirectory()&&entry.name!=='__pycache__')scan(name);else if(entry.isFile()&&/\.(?:py|ts|tsx|json|sql)$/.test(name))names.push(name);}}
  for(const name of ['worker','tests/investor','web/src','migrations','contracts'])scan(name);
  return Object.fromEntries(names.sort().map(name=>[name,createHash('sha256').update(readFileSync(path.join(root,name))).digest('hex')]));}
report.source_files=inventory();
let directory,server,proxy,password,logs='',timer,working=false,work=Promise.resolve(),phase='waiting_profile';
const workerAbort=new AbortController();
try{
  directory=mkdtempSync(path.join(tmpdir(),'etf-first-close-http-'));
  const filename=path.join(directory,'workbench.db');migrateWorkbench(filename);
  const Database=createRequire(path.join(web,'package.json'))('better-sqlite3');
  const read=fn=>{const db=new Database(filename,{readonly:true});try{return fn(db);}finally{db.close();}};
  const financial=()=>read(db=>Object.fromEntries(['portfolios','accounts','ledger_events','postings','position_movements','approval_events','activations','reservations','execution_reports']
    .map(name=>[name,db.prepare(`SELECT count(*) n FROM ${name}`).get().n])));
  const baseline=financial();
  const modelAssets=()=>read(db=>db.prepare('SELECT payload FROM investor_evidence_checkpoint_payloads ORDER BY rowid DESC LIMIT 1').get()).payload;
  function economicAssets(){const value=JSON.parse(modelAssets().toString());return Object.fromEntries(['quantities','cash_by_currency','receivables','entitlements','processed_actions'].map(name=>[name,value[name]]));}
  async function fixture(stage){const value=await runHttpFixture(process.env.WORKBENCH_TEST_PYTHON??process.env.WORKBENCH_PYTHON??'python3',
    ['-m','tests.investor.current_first_close_fixture','--db',filename,'--stage',stage],
    {cwd:root,encoding:'utf8',timeout:['prepare','provider'].includes(stage)?450000:120000,maxBuffer:65536,signal:workerAbort.signal,
      env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WORKBENCH_DATA_DIR:path.join(directory,'auth')}});
    assert.equal(value.status,0,`Fixture ${stage} failed: ${value.signal??''} ${value.error?.message??''} ${value.stderr}`);return JSON.parse(value.stdout);}
  password=randomBytes(24).toString('base64url');const salt=randomBytes(16),passwordHash=`scrypt$32768$8$1$${salt.toString('base64url')}$${scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024}).toString('base64url')}`;
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const key=path.join(directory,'tls.key'),cert=path.join(directory,'tls.crt');
  const tls=await runHttpFixture('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost'],
    {encoding:'utf8',timeout:30000,maxBuffer:65536});assert.equal(tls.status,0);chmodSync(key,0o600);const certificate=readFileSync(cert);
  proxy=https.createServer({key:readFileSync(key),cert:certificate},(incoming,outgoing)=>{const upstream=http.request({hostname:'127.0.0.1',port,path:incoming.url,method:incoming.method,
    headers:{...incoming.headers,'x-forwarded-proto':'https'}},response=>{outgoing.writeHead(response.statusCode,response.headers);response.pipe(outgoing);});
    upstream.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end();});incoming.pipe(upstream);});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));const address=`https://127.0.0.1:${proxy.address().port}`,origin=address;
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],
    {cwd:web,env:{...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',WORKBENCH_DB_PATH:filename,WORKBENCH_DATA_DIR:path.join(directory,'auth'),
      WORKBENCH_PASSWORD_HASH:passwordHash,WORKBENCH_SESSION_SECRET:randomBytes(48).toString('base64url'),WORKBENCH_ORIGIN:origin},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',chunk=>{logs=(logs+chunk).slice(-16000);});server.stderr.on('data',chunk=>{logs=(logs+chunk).slice(-16000);});
  const request=(url,init={})=>new Promise((resolve,reject)=>{const outgoing=https.request(address+url,{ca:certificate,rejectUnauthorized:true,method:init.method??'GET',headers:init.headers??{}},response=>{
    const chunks=[];let bytes=0;response.on('data',chunk=>{bytes+=chunk.length;if(bytes>4194304)outgoing.destroy(new Error('LOCAL_RESPONSE_LIMIT'));else chunks.push(chunk);});
    response.on('error',reject);response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));});
    outgoing.on('error',reject);outgoing.setTimeout(30000,()=>outgoing.destroy(new Error('LOCAL_TLS_TIMEOUT')));outgoing.end(init.body);});
  let ready=false;for(let index=0;index<200;index++){assert.equal(server.exitCode,null);try{if((await request('/api/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(ready,'Server readiness timeout.');
  const anonymous=await request('/workbench');assert.equal(anonymous.headers.get('location'),'/login');
  assert.equal(anonymous.status,307);report.anonymous_ssr_preflight=true;
  let cookie,binding;
  const json=async(url,init={})=>{const response=await request(url,init);return{status:response.status,headers:response.headers,json:await response.json()};};
  const login=await request('/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password}).toString()});
  assert.equal(login.status,303);cookie=login.headers.get('set-cookie').split(';')[0];binding=(await json('/api/auth/session',{headers:{Cookie:cookie}})).json.session_binding;
  const headers={Cookie:cookie,'X-Workbench-Session-Binding':binding,'X-Workbench-Investor-View':'initial-close-v1'};
  const get=()=>json('/api/workbench/investor',{headers}),post=body=>json('/api/workbench/investor',{method:'POST',headers:{...headers,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const info=path.join(directory,'browser.json');
  function updateInfo(){writeFileSync(info,JSON.stringify({address,origin,password,db:filename,pid:process.pid,phase,timeline:report.timeline??null}),{mode:0o600});}
  async function advance(){
    if(phase==='waiting_profile'&&read(db=>db.prepare('SELECT count(*) n FROM investor_profiles').get().n)===1){
      phase='preparing_sources';updateInfo();report.timeline=await fixture('prepare');await fixture('core');phase='waiting_model';updateInfo();}
    if(phase==='waiting_model'&&read(db=>db.prepare('SELECT count(*) n FROM investor_models').get().n)===1){
      phase='collecting';updateInfo();report.stale_before=await fixture('stale');report.callback=await fixture('provider');
      phase='evaluating';updateInfo();await fixture('core');phase='ready';updateInfo();}
    else if(phase==='ready')await fixture('core');
  }
  if(serve){
    updateInfo();console.log('PRIVATE_BROWSER_FIXTURE: '+info);
    timer=setInterval(()=>{if(working)return;working=true;work=advance().catch(error=>{report.background_error=error.message;}).finally(()=>{working=false;});},1500);
    await new Promise(resolve=>{const timeout=setTimeout(resolve,20*60*1000);const stop=()=>{clearTimeout(timeout);resolve();};process.once('SIGTERM',stop);process.once('SIGINT',stop);});
    clearInterval(timer);if(phase!=='ready')workerAbort.abort();await work;
    assert.equal(report.background_error,undefined);assert.deepEqual(financial(),baseline);report.status='SERVED_NOT_NATIVE_ACCEPTED';report.final_phase=phase;
  }else{
    async function check(name,fn){const evidence=await fn();report.cases.push({name,status:'PASS',evidence:evidence??null});console.log('PASS '+name);}
    await check('ordinary_profile_research_and_model_without_monitor_seed',async()=>{
      const profile={schema_version:'investor-profile-v1',horizon_years:12,loss_tolerance:'0.30',liquidity_need:'none_in_horizon',markets:['CN'],product_scope:'unleveraged_long_only_etfs',
        research_direction:'system_design',exclusions:[],illustrative_budget_cny:null,planned_annual_contribution_cny:null};
      assert.equal((await post({action:'save_profile',expected_revision:0,idempotency_key:'fictional-first-profile',profile})).status,200);
      await advance();let state=(await get()).json;assert.equal(state.research_task.study.status,'reference_ready');assert.ok(state.plan);
      assert.equal((await post({action:'save_plan',plan_id:state.plan.id,expected_revision:state.revision,idempotency_key:'fictional-first-save'})).status,200);
      state=(await get()).json;assert.equal(state.model_watch.checkpoint_sequence,0);assert.equal(state.effective_outcome,'insufficient_evidence');
      const costs=state.monitor_costs;assert.equal((await post({action:'set_monitor_costs',model_id:state.model_watch.id,model_hash:costs.model_hash,expected_cost_version:0,
        expected_revision:state.revision,idempotency_key:'fictional-first-costs',costs:{commission_bps:'1',minimum_fee_cny:'1',fx_bps:'2',slippage_bps:'3',maximum_cost_fraction:'0.01'},validity_days:7,acknowledged_research_only:true})).status,200);
      state=(await get()).json;assert.equal(state.model_watch.status,'awaiting_inputs');assert.equal(state.monitor_costs.input_applied,false);
      assert.deepEqual(financial(),baseline);return{model_created_through_http:true,monitor_inputs:0,financial_writes:false};
    });
    await check('actual_future_close_to_default_core_and_independent_http',async()=>{
      let backgroundError;const pending=advance().catch(error=>{backgroundError=error;});let before;
      try{
        const deadline=Date.now()+30000;
        do{
          if(backgroundError)throw backgroundError;
          before=(await get()).json;
          if(before.model_watch.acquisition?.phase==='initial_close')break;
          await new Promise(resolve=>setTimeout(resolve,100));
        }while(Date.now()<deadline);
        assert.equal(before.model_watch.acquisition?.phase,'initial_close');
        const market=before.model_watch.acquisition.markets[0];
        assert.equal(before.model_watch.acquisition.status,'visible');assert.equal(market.market,'CN');
        assert.equal(market.registered_count,2);assert.equal(market.target_count,2);assert.equal(market.completed_count,0);
        assert.ok(['scheduled','queued','running'].includes(market.status),market.status);
        assert.equal(before.model_watch.checkpoint_sequence,0);assert.equal(before.model_watch.model_nav_cny,null);
        await pending;if(backgroundError)throw backgroundError;
      }finally{if(phase!=='ready')workerAbort.abort();await pending;}
      const state=(await get()).json;assert.equal(state.model_watch.checkpoint_sequence,1);assert.equal(state.model_watch.status,'research_observe');assert.equal(state.effective_outcome,'observe');
      assert.equal(state.latest.document.monitoring,'active');assert.equal(state.model_watch.model_nav_cny,'10000');assert.equal(report.callback.stubbed_callback_calls,1);
      assert.match(await(await request('/workbench',{headers})).text(),/持续观察/);assert.deepEqual(financial(),baseline);
      assert.equal(read(db=>db.prepare('SELECT count(*) n FROM investor_initial_close_runs').get().n),1);
      assert.equal(read(db=>db.prepare('SELECT count(*) n FROM investor_monitor_evidence_inputs').get().n),1);
      return{actual_clock:true,registered_progress:before.model_watch.acquisition.markets[0].status,
        stale_old_prices_rejected:report.stale_before.stale_retained_quotes_rejected,checkpoint:1,financial_writes:false};
    });
    await check('hypothetical_funding_decision_and_ordinary_review_persist_without_execution',async()=>{
      const assets=economicAssets();report.funding=await fixture('funding');await fixture('core');
      let state=(await get()).json;assert.equal(state.effective_outcome,'decision_required');assert.equal(state.model_watch.status,'research_decision');
      assert.equal(state.latest.document.model_change.funding_status,'hypothetical_due');assert.equal(state.model_watch.model_nav_cny,'10000');
      const observation=state.latest.id;assert.match(await(await request('/workbench',{headers})).text(),/变化卡/);
      assert.equal((await post({action:'review',observation_id:observation,decision:'defer',note:'Fictional native/HTTP review; no trade',
        expected_revision:state.revision,idempotency_key:'fictional-first-defer'})).status,200);
      state=(await get()).json;assert.ok(state.decisions.some(row=>row.observation_id===observation&&row.decision==='defer'));
      assert.deepEqual(economicAssets(),assets);assert.deepEqual(financial(),baseline);
      return{decision_from_fictional_admitted_intent:true,ordinary_annual_plan_due_path:false,ordinary_http_review_persisted:true,model_assets_unchanged:true,financial_writes:false};
    });
    await check('source_withdrawal_hides_current_value_without_a_second_callback',async()=>{
      await fixture('withdraw');const state=(await get()).json;assert.equal(state.effective_outcome,'insufficient_evidence');assert.equal(state.model_watch.model_nav_cny,null);
      assert.equal(read(db=>db.prepare("SELECT count(*) n FROM job_attempts a JOIN job_runs j ON j.id=a.job_id WHERE j.job_type='investor_initial_close'").get().n),1);
      assert.deepEqual(financial(),baseline);return{current_advice_hidden:true,second_callback:false,financial_writes:false};
    });
    assert.equal((await request('/api/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:origin}})).status,303);report.status='PASS';
  }
}catch(error){report.status='FAIL';report.error=error.message;process.exitCode=1;console.error(error.message);}
finally{
  if(timer)clearInterval(timer);workerAbort.abort();await work;
  if(server&&server.exitCode===null&&server.signalCode===null)await new Promise(resolve=>{server.once('exit',resolve);server.kill('SIGTERM');});
  if(proxy)await new Promise(resolve=>{proxy.close(resolve);proxy.closeAllConnections();});
  if(directory){writeFileSync(path.join(output,'server.log'),logs.replaceAll(directory,'[temporary-fixture]').replaceAll(password??'unlikely-empty-marker','[redacted]'));rmSync(directory,{recursive:true,force:true});}
  report.source_end_files=inventory();report.source_changed=Object.keys({...report.source_files,...report.source_end_files}).filter(name=>report.source_files[name]!==report.source_end_files[name]);
  report.build_end_id=readFileSync(path.join(web,'.next/BUILD_ID'),'utf8').trim();
  if(report.source_changed.length||report.build_id!==report.build_end_id){report.status='STALE';process.exitCode=1;}
  report.completed_at=new Date().toISOString();writeFileSync(path.join(output,'manifest.json'),JSON.stringify(report,null,2)+'\n');console.log('Evidence: '+path.relative(root,output));
}
