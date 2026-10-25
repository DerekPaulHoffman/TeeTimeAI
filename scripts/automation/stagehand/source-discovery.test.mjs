import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { sourceDiscover, publicSourceJob, sourceRoutingContext, prepareSourceDiscovery } from './source-discovery.mjs';
import { observedBookingSourceCandidates } from './source-provenance.mjs';
import { publicEvidenceUrl } from './public-evidence.mjs';
import { createStagehandGuardedBrowserHost } from '../course-discovery-stagehand-host.mjs';
const official='https://public-course.example/', booking='https://public-provider.example/start?venue=public&kind=day', landing='https://public-provider.example/loading';
function job(){const t=Date.now();return{id:'assigned-job',firstPickedUpAt:new Date(t).toISOString(),deadlineAt:new Date(t+900000).toISOString(),
 request:{identity:{name:'Public Course',officialUrl:official,timeZone:'America/New_York',address:'1 Public Road, Public Town, NY 10001, USA',canonicalCoursePhone:'PRIVATE_PHONE',bookingUrl:'PRIVATE_ROUTE'},
 target:{courseId:'assigned-course',kind:'OUTDOOR'},input:{date:'2026-11-01',timeZone:'America/New_York',players:2,startTime:'08:00',endTime:'18:00'},trustedContext:{canonicalCoursePhone:'PRIVATE_PHONE'}},leaseToken:'PRIVATE_LEASE'};}
function fixture({invalid=false,closeReject=false,afterAct}={}){
 let current=official,extracts=0,closes=0,evaluations=0,acts=0;const calls=[],instructions=[];
 const call=()=>calls.push({elapsedMs:1,usage:{inputTokens:10,outputTokens:2,totalTokens:12,cachedInputTokens:0,reasoningOutputTokens:1},model:'gpt-6.1-sol',effort:'medium'});
 const session={startupMs:1,localCodexCalls:calls,browser:{context:{addInitScript:async()=>{}}},page:{url:async()=>current,evaluate:async()=>{
   evaluations++;if(evaluations%2===0)return[];return{url:current,links:current===official?[{href:booking,text:'Book public availability'}]:[],frames:[],dom:[],network:{requests:[]}};}},
 goto:async()=>({status:()=>200}),extract:async(instruction,schema)=>{instructions.push(instruction);extracts++;call();call();const decision=extracts===1?
 {decision:'CONTINUE',reason:'Follow observed official booking link',nextActionInstruction:'Open Book public availability',bookingUrl:null}:
 {decision:'SOURCE_FOUND',reason:'Observed source only',nextActionInstruction:'',bookingUrl:invalid?'https://unobserved.example/':booking};return{data:schema.parse(decision)};},
 observe:async()=>{call();return{data:[{method:'click',selector:'a',description:'Book public availability',arguments:[]}]};},
 act:async()=>{acts++;current=landing;afterAct?.();return{before:{tag:'A',href:booking,text:'Book public availability'},afterUrl:landing,openedNewPage:false};},
 close:async()=>{closes++;if(closeReject)throw Error('PRIVATE_CLOSE_MESSAGE');return{browserClosed:true,modelClosed:true};}};
 return{session,instructions,get closes(){return closes;},get acts(){return acts;}};
}
test('ordinary job projection strips private/currentmethod hints and binds original clock/sourcecap',()=>{
 const raw=job(),p=publicSourceJob(raw);assert.deepEqual(Object.keys(p.identity),['name','officialUrl','timeZone','address']);
 assert.equal(JSON.stringify(p).includes('PRIVATE'),false);assert.equal(p.jobId,raw.id);assert.equal(Date.parse(p.deadlineAt)-Date.parse(p.firstPickedUpAt),900000);
 assert.equal(Date.parse(p.workDeadlineAt)-Date.parse(p.firstPickedUpAt),120000);
 const withoutAddress=job();delete withoutAddress.request.identity.address;assert.equal(publicSourceJob(withoutAddress).identity.address,undefined);
 assert.throws(()=>publicSourceJob({...raw,deadlineAt:new Date(Date.parse(raw.deadlineAt)+1).toISOString()}),/SOURCE_JOB_INVALID/);
 assert.throws(()=>publicSourceJob(raw,new Date(Date.parse(raw.deadlineAt)+1).toISOString()),/SOURCE_JOB_INVALID/);
 const old=Date.now()-121000;assert.throws(()=>publicSourceJob({...raw,firstPickedUpAt:new Date(old).toISOString(),deadlineAt:new Date(old+900000).toISOString()}),/BUDGET_EXHAUSTED/);
});
test('actual SDK-shaped extract/observe/act routes exact ancestor then exports only strict source with completed usage',async()=>{
 const f=fixture(),updates=[];const r=await sourceDiscover({job:job(),sessionFactory:async options=>{assert.equal(options.model,'gpt-6.1-sol');return f.session;},onMetrics:m=>updates.push(m)});
 assert.equal(r.outcome,'SOURCE_PROPOSED_UNVERIFIED',JSON.stringify({failure:r.frameworkFailureCode,actions:r.actions,eligible:r.eligibleBookingSourceUrls}));assert.deepEqual(r.adapterSourceProposal,{schemaVersion:1,kind:'EXISTING_ADAPTER_SOURCE',bookingUrl:booking});
 assert.equal(r.recipe,null);assert.deepEqual(r.matchingSlots,[]);assert.equal(r.frameworkExtractedTimes,false);assert.equal(r.browserClosed,true);assert.equal(f.closes,1);
 assert.equal(r.metrics.completedLocalCodexCalls,5);assert.equal(r.metrics.calls,3);assert.ok(updates.length>0);
 assert.ok(f.instructions[1].includes(booking));assert.ok(f.instructions[1].includes('completedAnchorClicks'));assert.ok(f.instructions[1].includes('"eligibleBookingSource":true'));
 assert.equal(JSON.stringify(f.instructions).includes('PRIVATE'),false);assert.deepEqual(observedBookingSourceCandidates(r,official,publicEvidenceUrl,{sourceDiscoveryOnly:true}),[booking]);
});
test('unobserved/model-invented proposal cannot become source or method',async()=>{
 const f=fixture({invalid:true}),r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});assert.equal(r.outcome,'UNRESOLVED');
 assert.equal(r.adapterSourceProposal,null);assert.equal(r.frameworkFailureCode,'STAGEHAND_SOURCE_OUTPUT_INVALID');assert.equal(r.recipe,null);assert.equal(r.browserClosed,true);
});
test('abort and cleanup failure preserve completed lower-bound calls and never claim browser closed',async()=>{
 const controller=new AbortController(),f=fixture({closeReject:true,afterAct:()=>controller.abort()});
 const r=await sourceDiscover({job:job(),signal:controller.signal,sessionFactory:async()=>f.session});assert.equal(r.frameworkFailureCode,'SOURCE_DISCOVERY_ABORTED');
 assert.equal(r.metrics.completedLocalCodexCalls,3);assert.equal(r.browserClosed,false);assert.equal(r.browserCleanupErrorCode,'STAGEHAND_BROWSER_CLEANUP_FAILED');
 assert.equal(JSON.stringify(r).includes('PRIVATE_CLOSE_MESSAGE'),false);
});
test('caller deadline bounds a hanging SDK await and cleans up the established session',async()=>{
 const f=fixture();f.session.extract=()=>new Promise(()=>{});
 const r=await sourceDiscover({job:job(),deadlineAt:new Date(Date.now()+30).toISOString(),sessionFactory:async()=>f.session});
 assert.equal(r.frameworkFailureCode,'STAGEHAND_SOURCE_BUDGET_EXHAUSTED');assert.equal(r.browserClosed,true);assert.equal(f.closes,1);
});
test('failed click rows are excluded from completed routing context',()=>{
 const base={initialNavigation:{requestedUrl:official,finalUrl:official,status:200},actions:[{action:{method:'click'},sourceUrl:official,observedTarget:{tag:'A',href:booking},afterUrl:landing,openedNewPage:false,actionError:'failed'}]};
 assert.deepEqual(sourceRoutingContext(base,[booking]).completedAnchorClicks,[]);
});
test('caller-private owned connection never enters model instructions, report, or checkpoint-facing ledgers',async()=>{
 const endpoint='ws://127.0.0.1:12345/devtools/browser/private-owned-endpoint',f=fixture();let created=0;
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:endpoint,targetId:'PRIVATE_TARGET',close:async()=>({browserClosed:true})};
 const r=await sourceDiscover({job:job(),createGuardedBrowser:async()=>{created++;return owned;},sessionFactory:async options=>{assert.equal(options.ownedBrowser,owned);return f.session;}});
 assert.equal(created,1);assert.equal(r.outcome,'SOURCE_PROPOSED_UNVERIFIED');
 for(const text of[JSON.stringify(r),JSON.stringify(f.instructions)]){assert.equal(text.includes(endpoint),false);assert.equal(text.includes('PRIVATE_TARGET'),false);}
});
test('real source-to-host boundary accepts locally clamped work across tolerated server skew without resetting original clocks',async()=>{
 const originalNow=Date.now,local=originalNow();Date.now=()=>local;
 try{
  for(const skew of[-5000,-2000,0,2000,5000]){
   const raw=job(),first=local+skew;raw.firstPickedUpAt=new Date(first).toISOString();raw.deadlineAt=new Date(first+900000).toISOString();
   const sourceDeadline=Math.min(first+120000,local+120000),f=fixture();let constructorCalls=0,closed=0;
   const r=await sourceDiscover({job:raw,cwd:process.cwd(),deadlineAt:new Date(sourceDeadline).toISOString(),
    createGuardedBrowser:({deadlineAt,signal})=>createStagehandGuardedBrowserHost({cwd:process.cwd(),initialUrl:official,timeZone:raw.request.input.timeZone,deadlineAt,signal,
     helperEnvironment:{COURSE_DISCOVERY_BROWSER_TRANSPORT:'NATIVE_CHROME',COURSE_DISCOVERY_JOB_KIND:'discovery',COURSE_DISCOVERY_JOB_ID:raw.id,COURSE_DISCOVERY_LEASE_TOKEN:'offline-fixture-lease'},
     processFactory:options=>{constructorCalls++;assert.equal(options.args[options.args.indexOf('--deadline')+1],new Date(sourceDeadline).toISOString());
      return{request:async value=>value.action==='start'?{kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'ws://127.0.0.1:12345/devtools/browser/12345678-1234-1234-1234-123456789abc',targetId:'fixture-target'}:{browserClosed:true,providerRequestsDrained:true},close:async()=>{closed++;}};}}),
    sessionFactory:async options=>{const close=f.session.close;f.session.close=async()=>{await options.ownedBrowser.close();return close();};return f.session;}});
   assert.equal(r.outcome,'SOURCE_PROPOSED_UNVERIFIED');assert.equal(constructorCalls,1);assert.equal(closed,1);
   assert.equal(r.firstPickedUpAt,raw.firstPickedUpAt);assert.equal(r.deadlineAt,raw.deadlineAt);assert.equal(Date.parse(r.workDeadlineAt),sourceDeadline);
  }
  const future=job();future.firstPickedUpAt=new Date(local+5001).toISOString();future.deadlineAt=new Date(local+905001).toISOString();
  assert.throws(()=>publicSourceJob(future,new Date(local+120000).toISOString()),/SOURCE_JOB_INVALID/);
 }finally{Date.now=originalNow;}
});
test('closed native-host startup failures survive the real source report while unknown payloads remain redacted',async()=>{
 for(const code of['STAGEHAND_NATIVE_HOST_DEADLINE','STAGEHAND_NATIVE_HOST_SCOPE_INVALID','STAGEHAND_NATIVE_HOST_INVALID','STAGEHAND_NATIVE_HOST_FAILED',
  'STAGEHAND_GUARDED_SOURCE_REJECTED','OWNED_STAGEHAND_CDP_UNAVAILABLE','OWNED_PUBLIC_CDP_UNAVAILABLE','PROVIDER_COORDINATION_UNAVAILABLE','PRIVATE_UNKNOWN_PAYLOAD']){
  let sessions=0;const report=await sourceDiscover({job:job(),createGuardedBrowser:async()=>{throw Error(code);},sessionFactory:async()=>{sessions++;throw Error('UNEXPECTED_SESSION');}});
  assert.equal(sessions,0);assert.equal(report.frameworkFailureCode,code==='PRIVATE_UNKNOWN_PAYLOAD'?'STAGEHAND_SOURCE_DISCOVERY_FAILED':code);
  assert.equal(report.outcome,'UNRESOLVED');assert.equal(report.adapterSourceProposal,null);assert.equal(report.metrics.completedLocalCodexCalls,0);
  assert.equal(JSON.stringify(report).includes('PRIVATE_UNKNOWN_PAYLOAD'),false);
 }
});
test('prepare is read-only readiness with no account RPC/model/browser or credential output',async()=>{
 const r=await prepareSourceDiscovery({cwd:process.cwd(),loadRuntime:async()=>{},loadHelpers:async()=>({prepareDiscoveryModelCatalog:()=>{},resolveDiscoveryCli:()=>'/trusted/codex'}),read:()=>JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'PRIVATE_AUTH'}})});
 assert.equal(r.ready,true);assert.equal(r.readinessAccountRpcPerformed,false);assert.equal(JSON.stringify(r).includes('PRIVATE'),false);
 await assert.rejects(prepareSourceDiscovery({loadRuntime:async()=>{},loadHelpers:async()=>({prepareDiscoveryModelCatalog:()=>{},resolveDiscoveryCli:()=>''}),read:()=>JSON.stringify({auth_mode:'apikey'})}),/EXISTING_CHATGPT_LOGIN_REQUIRED/);
});
test('portable directory contains no sealed cohort paths, historical venues, API fallback or raw prompt capture',()=>{
 const text=readdirSync(new URL('.',import.meta.url)).filter(f=>f.endsWith('.mjs')&&!f.endsWith('.test.mjs')).map(f=>readFileSync(new URL(f,import.meta.url),'utf8')).join('\n');
 assert.doesNotMatch(text,/fifteenth-cohort|normal-inputs\.json|course-framework-comparison|Emerald|Walnut|OnPar|TTS_OWNED_FIXTURE_CAPTURE_DIR/);
 assert.doesNotMatch(text,/file:\/\/\/C:|const WORKSPACE|const SOURCE_HOME/);
});
