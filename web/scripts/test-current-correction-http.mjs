import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,scryptSync,createHash} from 'node:crypto';
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
assert.ok(process.argv.length===2||process.argv.length===3&&process.argv[2]==='--serve','Only --serve is accepted; no database, URL, source or clock overrides.');
const serve=process.argv[2]==='--serve',output=path.join(root,'artifacts/verification/current-correction-http',new Date().toISOString().replace(/[:.]/g,'-'));
mkdirSync(output,{recursive:true});
const report={status:'RUNNING',started_at:new Date().toISOString(),actual_application_clock:true,fictional_sources:true,
  build_performed:false,build_id:readFileSync(path.join(web,'.next/BUILD_ID'),'utf8').trim(),cases:[],
  limitations:['Historical fixture construction uses explicitly sampled past stamps for source/model setup; HTTP and default core then use the real unmodified wall clock.',
    'All prices, calendars, permissions, issuer/EODHD responses and explicit tax/cost answers are fictional, not real provider or investment evidence.',
    'Correction consent registers a frozen pending baseline, not approved current sources, a new epoch/checkpoint, restored monitoring or a trade.',
    'Reuses an existing production build and a locally generated exactly pinned TLS certificate, not production or native-browser acceptance.']};
function inventory(){const names=['web/scripts/test-current-correction-http.mjs','web/scripts/http-fixture-process.mjs','scripts/migrate-workbench.mjs','web/package.json','web/package-lock.json'];
  function scan(relative){for(const entry of readdirSync(path.join(root,relative),{withFileTypes:true})){const name=relative+'/'+entry.name;
    if(entry.isDirectory()&&entry.name!=='__pycache__')scan(name);else if(entry.isFile()&&/\.(?:py|ts|tsx|json|sql)$/.test(name))names.push(name);}}
  for(const name of ['worker','tests/investor','web/src','migrations','contracts'])scan(name);
  return Object.fromEntries(names.sort().map(name=>[name,createHash('sha256').update(readFileSync(path.join(root,name))).digest('hex')]));}
report.source_files=inventory();
let directory,server,proxy,password,timer,working=false,work=Promise.resolve(),logs='';
const abort=new AbortController();
try{
  directory=mkdtempSync(path.join(tmpdir(),'etf-correction-http-'));const filename=path.join(directory,'workbench.db');migrateWorkbench(filename);
  async function fixture(stage){const value=await runHttpFixture(process.env.WORKBENCH_TEST_PYTHON??process.env.WORKBENCH_PYTHON??'python3',
    ['-m','tests.investor.current_correction_fixture','--db',filename,'--stage',stage],
    {cwd:root,encoding:'utf8',timeout:120000,maxBuffer:65536,signal:abort.signal,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:process.env.HOME}});
    assert.equal(value.status,0,`Fixture ${stage} failed: ${value.signal??''} ${value.error?.message??''} ${value.stderr}`);return JSON.parse(value.stdout);}
  const timeline=await fixture('prepare');report.timeline=timeline;const baseline=await fixture('inspect');
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
  assert.ok(ready,'Server readiness timeout.');assert.equal((await request('/workbench')).headers.get('location'),'/login');
  let cookie,binding;
  const json=async(url,init={})=>{const response=await request(url,init);return{status:response.status,headers:response.headers,json:await response.json()};};
  const login=await request('/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password}).toString()});
  assert.equal(login.status,303);cookie=login.headers.get('set-cookie').split(';')[0];binding=(await json('/api/auth/session',{headers:{Cookie:cookie}})).json.session_binding;
  const headers={Cookie:cookie,'X-Workbench-Session-Binding':binding},get=url=>json(url,{headers}),post=(url,body)=>json(url,{method:'POST',headers:{...headers,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const state=await get('/api/workbench/investor');assert.equal(state.status,200);assert.equal(state.json.model_watch.id,timeline.model_id);
  if(serve){
    const info=path.join(directory,'browser.json');writeFileSync(info,JSON.stringify({address,origin,password,db:filename,pid:process.pid,timeline}),{mode:0o600});
    console.log('PRIVATE_BROWSER_FIXTURE: '+info);
    timer=setInterval(()=>{if(working)return;working=true;work=fixture('tick').catch(error=>{report.background_error=error.message;}).finally(()=>{working=false;});},3000);
    await new Promise(resolve=>{const timeout=setTimeout(resolve,25*60*1000),stop=()=>{clearTimeout(timeout);resolve();};process.once('SIGTERM',stop);process.once('SIGINT',stop);});
    clearInterval(timer);await work;assert.equal(report.background_error,undefined);report.status='SERVED_NOT_NATIVE_ACCEPTED';
  }else{
    async function check(name,action){const evidence=await action();report.cases.push({name,status:'PASS',evidence:evidence??null});console.log('PASS '+name);}
    const reviewRoute='/api/workbench/investor/action-review',impactRoute='/api/workbench/investor/correction-impact',consentRoute='/api/workbench/investor/correction-consent';
    let view,impact,intent,confirmed;
    await check('ordinary_actual_clock_hypothesis_comparison',async()=>{
      const current=await get(reviewRoute);assert.equal(current.status,200);
      const preview=await post(reviewRoute,{kind:'preview',symbol:'VT.US',expected_revision:current.json.workspace_revision,idempotency_key:'fictional-current-correction-preview'});
      assert.equal(preview.status,202,JSON.stringify(preview.json));await fixture('tick');
      const visible=await get(reviewRoute+'?request='+encodeURIComponent(preview.json.request.id));assert.equal(visible.status,200);view=visible.json.view;
      assert.equal(view.status,'historical_correction_required',JSON.stringify(visible.json));assert.equal(view.confirmation_supported,false);
      const body={schema_version:'investor-action-correction-impact-request-v1',model_id:timeline.model_id,preview_id:view.preview.preview_id,
        expected_revision:view.preview.workspace_revision,idempotency_key:'fictional-current-correction-impact',
        acknowledgements:Object.fromEntries(['hypothetical_only','source_differences_seen','explicit_time_and_tax','original_reported_coverage_only','unchanged_tax_assumption'].map(key=>[key,true])),
        decisions:[{date:timeline.event_date,choice:'replace',reason:'Explicit fictional issuer correction; original independent nominal report remains visible',
          events:[{type:'dividend',at:timeline.effective_at,pay_at:timeline.payment_at,tax_per_unit:'0.432109'}]}]};
      const queued=await post(impactRoute,body);assert.equal(queued.status,202,JSON.stringify(queued.json));await fixture('tick');
      impact=(await get(impactRoute+'?request='+encodeURIComponent(queued.json.request.id))).json;
      assert.equal(impact.request.status,'preview_ready',JSON.stringify(impact));assert.ok(impact.summary);assert.notEqual(impact.summary.difference_cny,'0');
      assert.equal(impact.economic_correction_approved,false);assert.equal(impact.summary.monitoring_resumed,false);
      return{actual_clock:true,nonzero_original_price_difference:true,comparison_is_not_consent:true,provider_calls:0};
    });
    await check('separate_explicit_consent_to_default_core_receipt_and_reload',async()=>{
      const candidate=(await get(consentRoute+'?impact='+encodeURIComponent(impact.request.id))).json;
      assert.equal(candidate.candidate.summary_hash,impact.summary_hash);assert.equal(candidate.candidate.all_differences_resolved,true);
      intent={schema_version:'investor-correction-consent-submit-v1',impact_request_id:impact.request.id,expected_result_hash:candidate.candidate.impact_result_hash,
        expected_revision:candidate.workspace_revision,idempotency_key:'fictional-current-formal-correction',acknowledgements:Object.fromEntries([
          'exact_stored_impact_seen','explicit_historical_restatement','selected_report_differences_accepted','tax_and_instants_are_research_assumptions',
          'preserve_original_history_and_strategy','new_epoch_not_current_nav','separate_current_readmission_no_trading'].map(key=>[key,true]))};
      const queued=await post(consentRoute,intent);assert.equal(queued.status,202,JSON.stringify(queued.json));
      assert.equal((await post(consentRoute,intent)).json.request.id,queued.json.request.id);await fixture('tick');
      confirmed=(await get(consentRoute+'?nonce='+intent.idempotency_key)).json;
      assert.equal(confirmed.request.status,'confirmed',JSON.stringify(confirmed));assert.ok(confirmed.receipt);assert.equal(confirmed.candidate,null);
      const reloaded=(await get(consentRoute+'?model='+encodeURIComponent(timeline.model_id))).json;assert.deepEqual(reloaded.receipt,confirmed.receipt);
      const old=(await get(impactRoute+'?request='+encodeURIComponent(impact.request.id))).json;assert.equal(old.summary,null);assert.equal(old.request.status,'outdated');
      assert.doesNotMatch(JSON.stringify(confirmed),/"(?:baseline|approved_facts|tax_per_unit|quantities|cash_by_currency|capture_refs)":/);
      const after=await fixture('inspect');assert.equal(after.old_chain_hash,baseline.old_chain_hash);assert.deepEqual(after.financial,baseline.financial);
      assert.equal(after.counts.investor_correction_consents,1);assert.equal(after.counts.investor_correction_consent_results,1);
      return{separate_owner_intent:true,one_confirmation:true,original_chain_unchanged:true,no_new_checkpoint:true,metadata_only:true,monitoring_resumed:false};
    });
    await check('withdrawal_preserves_history_not_current_economics_or_monitoring',async()=>{
      await fixture('withdraw');const value=(await get(consentRoute+'?request='+confirmed.request.id)).json;
      assert.deepEqual(value.receipt,confirmed.receipt);assert.equal(value.receipt.source_values_included,false);assert.equal(value.receipt.monitoring_resumed,false);
      const missing=(await get(consentRoute+'?nonce=fictional-unknown-nonce')).json;assert.equal(missing.request,null);assert.equal(missing.receipt,null);
      const after=await fixture('inspect');assert.equal(after.old_chain_hash,baseline.old_chain_hash);assert.deepEqual(after.financial,baseline.financial);
      assert.equal((await request('/api/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:origin}})).status,303);
      assert.equal((await get(consentRoute+'?request='+confirmed.request.id)).status,401);
      return{historical_receipt_preserved:true,nonce_miss_not_latest:true,logout_private:true,monitoring_resumed:false,financial_writes:false};
    });
    report.status='PASS';
  }
}catch(error){report.status='FAIL';report.error=error.message;process.exitCode=1;console.error(error.message);}
finally{
  if(timer)clearInterval(timer);abort.abort();await work;
  if(server&&server.exitCode===null&&server.signalCode===null)await new Promise(resolve=>{server.once('exit',resolve);server.kill('SIGTERM');});
  if(proxy)await new Promise(resolve=>{proxy.close(resolve);proxy.closeAllConnections();});
  if(directory){writeFileSync(path.join(output,'server.log'),logs.replaceAll(directory,'[temporary-fixture]').replaceAll(password??'unlikely-empty-marker','[redacted]'));rmSync(directory,{recursive:true,force:true});}
  report.source_end_files=inventory();report.source_changed=Object.keys({...report.source_files,...report.source_end_files}).filter(name=>report.source_files[name]!==report.source_end_files[name]);
  report.build_end_id=readFileSync(path.join(web,'.next/BUILD_ID'),'utf8').trim();if(report.source_changed.length||report.build_id!==report.build_end_id){report.status='STALE';process.exitCode=1;}
  report.completed_at=new Date().toISOString();writeFileSync(path.join(output,'manifest.json'),JSON.stringify(report,null,2)+'\n');console.log('Evidence: '+path.relative(root,output));
}
