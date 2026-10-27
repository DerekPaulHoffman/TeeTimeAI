import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceDiscover, publicSourceJob, sourceRoutingContext, prepareSourceDiscovery, pageEvidence, sourceDecisionFor, buildSourceDiscoveryInstruction, routingOnlyFrameEntry } from './source-discovery.mjs';
import { JSDOM } from 'jsdom';
import { observedBookingSourceCandidates } from './source-provenance.mjs';
import { publicEvidenceUrl } from './public-evidence.mjs';
import { createStagehandGuardedBrowserHost } from '../course-discovery-stagehand-host.mjs';
import { createStagehandCodexModel } from './codex-model.mjs';
import { prepareReadOnlyAction } from './driver.mjs';
import { createCourseDiscoverySupervisor } from '../course-discovery-supervisor.mjs';
import { validateStagehandSourceReport } from '../course-discovery-stagehand-source.mjs';
const official='https://public-course.example/', booking='https://public-provider.example/start?venue=public&kind=day', landing='https://public-provider.example/loading';
const playEntry='https://public-course.play.teeitup.com/', bookEntry='https://public-course.book.teeitup.com/';
function routingFrameFixture(mode='valid',{entry=playEntry,final=bookEntry}={}) {
 let current=official,evaluations=0,callback,opens=0,extracts=0;
 const witness=(page=current,src=entry)=>({kind:'NATIVE_VISIBLE_FRAME',pageUrl:page,observedAt:new Date().toISOString(),documentHash:'a'.repeat(64),frames:[{src,visible:true}]});
 const session={localCodexCalls:[],browser:{context:{addInitScript:async()=>{}}},page:{url:async()=>current,evaluate:async()=>++evaluations%2?
  {url:current,observedAt:new Date().toISOString(),links:[],frames:[],dom:[]}:[]},goto:async()=>({status:()=>200}),
  observeFrameSources:async()=>{const w=witness();if(mode==='ambiguous')w.frames.push({src:'https://other.play.teeitup.com/',visible:true});return w;},
  extract:async(_instruction,schema)=>{extracts++;return{data:schema.parse({decision:'SOURCE_FOUND',reason:'Observed public source',nextActionInstruction:'',bookingUrl:current===official?entry:final})};},
  openObservedFrameSource:async url=>{opens++;assert.equal(url,entry);const w=witness();
   if(mode==='foreign')w.pageUrl='https://foreign.example/';if(mode==='stale')w.observedAt='2000-01-01T00:00:00.000Z';
   if(mode==='hidden')w.frames[0].visible=false;if(mode==='ambiguous')w.frames.push({src:'https://other.play.teeitup.com/',visible:true});
   if(mode==='wrong')w.frames[0].src='https://app.acuityscheduling.com/schedule.php?owner=87654321';
   if(mode!=='missing-callback')callback(w);current=final;
   return{kind:'NATIVE_FRAME_SOURCE_OPEN',pageUrl:w.pageUrl,frameUrl:url,observedAt:w.observedAt,documentHash:w.documentHash,
    finalUrl:final,completedAt:new Date().toISOString(),finalDocumentHash:'b'.repeat(64),
    redirects:mode==='absent-redirect'||url===final?[]:[{fromUrl:mode==='redirect-gap'?'https://unobserved.example/':url,toUrl:final,status:302,completed:true}]};},
  close:async()=>({browserClosed:true,modelClosed:true})};
 return{session,bind:o=>{callback=o.onNativeFrameSourceWitness;},get opens(){return opens;},get extracts(){return extracts;}};
}
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

const completeDocument={readyState:'interactive',bodyPresent:true,mainDocumentCurrent:true,mainDocumentComplete:true,mainReadPending:false,pendingReads:1,mainDocumentStatus:200};
test('source settles the current main parser before collecting evidence or invoking a model',async()=>{
 const f=fixture(),order=[];const evaluate=f.session.page.evaluate,extract=f.session.extract;
 f.session.settleSourceDocument=async()=>{order.push('settled');return completeDocument;};
 f.session.page.evaluate=async(...args)=>{order.push('evidence');return evaluate(...args);};
 f.session.extract=async(...args)=>{order.push('model');return extract(...args);};
 const r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});
 assert.equal(r.outcome,'SOURCE_PROPOSED_UNVERIFIED');assert.equal(order[0],'settled');
 assert.equal(order.filter(value=>value==='settled').length,2);
 for(let i=0;i<order.length;i++)if(order[i]==='model')assert.ok(order.lastIndexOf('settled',i)<order.lastIndexOf('evidence',i));
});
test('unsettled main document expires without model evidence and retains closed last readiness',async()=>{
 const f=fixture();let evaluations=0;const readiness={...completeDocument,readyState:'loading',mainReadPending:true,mainDocumentComplete:false};
 f.session.settleSourceDocument=async()=>{throw Object.assign(Error('STAGEHAND_SOURCE_LOADING_INCOMPLETE'),{stagehandDocumentReadiness:readiness});};
 f.session.page.evaluate=async()=>{evaluations++;throw Error('UNSETTLED_EVIDENCE');};
 const r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});
 assert.equal(r.frameworkFailureCode,'STAGEHAND_SOURCE_LOADING_INCOMPLETE');assert.equal(evaluations,0);assert.equal(r.metrics.completedLocalCodexCalls,0);
 assert.equal(r.sourceDiagnostic.phase,'EVIDENCE');assert.deepEqual(r.sourceDiagnostic.sourceDocumentReadiness,readiness);assert.equal(r.browserClosed,true);
});
test('explicit unresolved must revalidate current settled document before stopping',async()=>{
 const f=fixture();let settled=0,extracts=0,reads=0;
 f.session.settleSourceDocument=async()=>{settled++;return completeDocument;};
 f.session.readSourceDocumentReadiness=async()=>{reads++;return reads===1?{...completeDocument,readyState:'loading',mainReadPending:true}:completeDocument;};
 f.session.extract=async(_instruction,schema)=>{extracts++;return{data:schema.parse({decision:'UNRESOLVED',reason:'No routing source',nextActionInstruction:'',bookingUrl:null})};};
 const r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});
 assert.equal(extracts,2);assert.equal(settled,2);assert.equal(reads,2);assert.equal(r.sourceDiagnostic.sourceStop.condition,'EXPLICIT_UNRESOLVED');
});
test('explicit unresolved from an old page is recaptured after an actual URL change',async()=>{
 const f=fixture();let current=official,extracts=0,evaluations=0;
 f.session.page.url=async()=>current;
 f.session.settleSourceDocument=async()=>completeDocument;f.session.readSourceDocumentReadiness=async()=>completeDocument;
 f.session.page.evaluate=async()=>++evaluations%2===0?[]:({url:current,links:[],frames:[],dom:[],network:{requests:[]}});
 f.session.extract=async(_instruction,schema)=>{extracts++;if(extracts===1)current=landing;return{data:schema.parse({decision:'UNRESOLVED',reason:'No source',nextActionInstruction:'',bookingUrl:null})};};
 const r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});
 assert.equal(extracts,2);assert.equal(r.sourceDiagnostic.sourceStop.condition,'EXPLICIT_UNRESOLVED');
});
test('ordinary job projection strips private/currentmethod hints and binds original clock/sourcecap',()=>{
 const raw=job(),p=publicSourceJob(raw);assert.deepEqual(Object.keys(p.identity),['name','officialUrl','timeZone','address']);
 assert.equal(JSON.stringify(p).includes('PRIVATE'),false);assert.equal(p.jobId,raw.id);assert.equal(Date.parse(p.deadlineAt)-Date.parse(p.firstPickedUpAt),900000);
 assert.equal(Date.parse(p.workDeadlineAt)-Date.parse(p.firstPickedUpAt),240000);
 const withoutAddress=job();delete withoutAddress.request.identity.address;assert.equal(publicSourceJob(withoutAddress).identity.address,undefined);
 assert.throws(()=>publicSourceJob({...raw,deadlineAt:new Date(Date.parse(raw.deadlineAt)+1).toISOString()}),/SOURCE_JOB_INVALID/);
 assert.throws(()=>publicSourceJob(raw,new Date(Date.parse(raw.deadlineAt)+1).toISOString()),/SOURCE_JOB_INVALID/);
 const old=Date.now()-241000;assert.throws(()=>publicSourceJob({...raw,firstPickedUpAt:new Date(old).toISOString(),deadlineAt:new Date(old+900000).toISOString()}),/BUDGET_EXHAUSTED/);
});

test('the shared source clock keeps only its remainder after prior work/cooldown and honors a narrower caller deadline',()=>{
 const raw=job(),first=Date.now()-103000;raw.firstPickedUpAt=new Date(first).toISOString();raw.deadlineAt=new Date(first+900000).toISOString();
 const projected=publicSourceJob(raw);assert.equal(Date.parse(projected.workDeadlineAt),first+240000);
 assert.ok(Date.parse(projected.workDeadlineAt)-Date.now()<=137000);assert.ok(Date.parse(projected.workDeadlineAt)-Date.now()>136000);
 assert.equal(publicSourceJob(raw,new Date(first+110000).toISOString()).workDeadlineAt,new Date(first+110000).toISOString());
 assert.equal(projected.firstPickedUpAt,raw.firstPickedUpAt);assert.equal(projected.deadlineAt,raw.deadlineAt);
});
test('ordinary explicit unresolved persists closed decision/stop/action facts',async()=>{
 const f=fixture();f.session.extract=async(_instruction,schema)=>({data:schema.parse({decision:'UNRESOLVED',reason:'PRIVATE_MODEL_REASON',nextActionInstruction:'',bookingUrl:null})});
 const r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});
 assert.equal(r.outcome,'UNRESOLVED');assert.equal(r.frameworkFailureCode,undefined);
 assert.deepEqual(r.sourceDiagnostic.sourceStop,{finalDecision:'UNRESOLVED',condition:'EXPLICIT_UNRESOLVED',lastActionKind:'INITIAL_NAVIGATION'});
 assert.equal(r.sourceDiagnostic.errorClass,'NONE');assert.doesNotMatch(JSON.stringify(r.sourceDiagnostic),/PRIVATE_MODEL_REASON|https:/u);
});
test('empty continue is distinguishable from explicit unresolved and an early guarded failure',async()=>{
 const f=fixture();f.session.extract=async(_instruction,schema)=>({data:schema.parse({decision:'CONTINUE',reason:'',nextActionInstruction:'',bookingUrl:null})});
 const r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});assert.equal(r.sourceDiagnostic.sourceStop.condition,'EMPTY_CONTINUE');
 const fail=fixture();fail.session.goto=async()=>{throw Error('STAGEHAND_GUARDED_SOURCE_REJECTED');};
 const rejected=await sourceDiscover({job:job(),sessionFactory:async()=>fail.session});
 assert.deepEqual(rejected.sourceDiagnostic.sourceStop,{finalDecision:null,condition:'ERROR',lastActionKind:'INITIAL_NAVIGATION'});
});
test('actual SDK-shaped extract/observe/act routes exact ancestor then exports only strict source with completed usage',async()=>{
 const f=fixture(),updates=[];const r=await sourceDiscover({job:job(),sessionFactory:async options=>{assert.equal(options.model,'gpt-6.1-sol');assert.equal(options.sourceRoutingOnly,true);return f.session;},onMetrics:m=>updates.push(m)});
 assert.equal(r.outcome,'SOURCE_PROPOSED_UNVERIFIED',JSON.stringify({failure:r.frameworkFailureCode,actions:r.actions,eligible:r.eligibleBookingSourceUrls}));assert.deepEqual(r.adapterSourceProposal,{schemaVersion:1,kind:'EXISTING_ADAPTER_SOURCE',bookingUrl:booking});
 assert.equal(r.recipe,null);assert.deepEqual(r.matchingSlots,[]);assert.equal(r.frameworkExtractedTimes,false);assert.equal(r.browserClosed,true);assert.equal(f.closes,1);
 assert.equal(r.metrics.completedLocalCodexCalls,5);assert.equal(r.metrics.calls,3);assert.ok(updates.length>0);
 assert.ok(f.instructions[1].includes(booking));assert.ok(f.instructions[1].includes('completedAnchorClicks'));assert.ok(f.instructions[1].includes('"eligibleBookingSource":true'));
 assert.equal(JSON.stringify(f.instructions).includes('PRIVATE'),false);assert.deepEqual(observedBookingSourceCandidates(r,official,publicEvidenceUrl,{sourceDiscoveryOnly:true}),[booking]);
});

test('routing-only play frame is entered through native callback and actual redirect before terminal source export',async()=>{
 const raw={...job(),attempts:1,sourceFingerprint:'a'.repeat(64)},f=routingFrameFixture();const r=await sourceDiscover({job:raw,sessionFactory:async o=>{f.bind(o);return f.session;}});
 assert.equal(r.outcome,'SOURCE_PROPOSED_UNVERIFIED',r.frameworkFailureCode);assert.equal(r.adapterSourceProposal.bookingUrl,bookEntry);
 assert.equal(f.opens,1);assert.equal(f.extracts,2);assert.equal(r.nativeFrameNavigations.length,1);
 assert.equal(r.nativeFrameNavigations[0].frameUrl,playEntry);assert.equal(r.nativeFrameNavigations[0].finalUrl,bookEntry);
 assert.equal(r.actions[0].action.method,'openObservedFrameSource');assert.equal(r.actions[0].observedTarget.href,playEntry);
 assert.equal(r.firstPickedUpAt,raw.firstPickedUpAt);assert.equal(r.deadlineAt,raw.deadlineAt);
 assert.equal(Date.parse(r.workDeadlineAt),Date.parse(raw.firstPickedUpAt)+240000);assert.equal(r.recipe,null);assert.deepEqual(r.matchingSlots,[]);
 assert.equal(validateStagehandSourceReport(r,raw).bookingUrl,bookEntry);
});

for(const mode of ['ambiguous','foreign','stale','hidden','missing-callback','redirect-gap'])test(`routing-only frame cannot export through ${mode} native evidence`,async()=>{
 const f=routingFrameFixture(mode),r=await sourceDiscover({job:job(),sessionFactory:async o=>{f.bind(o);return f.session;}});
 assert.equal(r.outcome,'UNRESOLVED');assert.equal(r.adapterSourceProposal,null);assert.equal(r.frameworkFailureCode,'STAGEHAND_SOURCE_OUTPUT_INVALID');
 assert.equal(r.browserClosed,true);assert.equal(r.modelClosed,true);
});

const legacyAcuity='https://app.acuityscheduling.com/schedule.php?owner=12345678&ref=embedded_csp',canonicalAcuity='https://app.acuityscheduling.com/schedule/AbCd1234?ref=embedded_csp';
test('routing-only Acuity recognition is exact owner/ref syntax and grants no canonical URL mapping',()=>{
 for(const value of [legacyAcuity,legacyAcuity.replace('&ref=embedded_csp',''),legacyAcuity.replace('owner=12345678&ref=embedded_csp','ref=embedded_csp&owner=12345678')])assert.equal(routingOnlyFrameEntry(value),true);
 for(const value of [canonicalAcuity,legacyAcuity.replace('12345678','0'),legacyAcuity.replace('12345678','001234'),legacyAcuity.replace('12345678','12345678901'),
  legacyAcuity.replace('owner=','%6fwner='),legacyAcuity.replace('embedded_csp','embedded%5fcsp'),legacyAcuity+'&owner=87654321',legacyAcuity+'&ref=embedded_csp',
  legacyAcuity+'&date=2030-01-01',legacyAcuity+'&appointmentType=123',legacyAcuity+'&token=private',legacyAcuity+'#slot',legacyAcuity.replace('https:','http:'),
  legacyAcuity.replace('.com/','.com:8443/'),legacyAcuity.replace('https://','https://user:secret@'),legacyAcuity.replace('.com/','.com.evil.example/'),
  legacyAcuity.replace('/schedule.php','/schedule.php/'),legacyAcuity.replace('/schedule.php','/checkout'),legacyAcuity.replace('?owner=12345678&ref=embedded_csp','')])assert.equal(routingOnlyFrameEntry(value),false);
});
test('legacy Acuity frame requires actual native redirect to the opaque canonical key before export',async()=>{
 for(const entry of [legacyAcuity,legacyAcuity.replace('&ref=embedded_csp','')]){
  const raw={...job(),attempts:1,sourceFingerprint:'a'.repeat(64)},f=routingFrameFixture('valid',{entry,final:canonicalAcuity});
  const r=await sourceDiscover({job:raw,sessionFactory:async o=>{f.bind(o);return f.session;}});
  assert.equal(r.outcome,'SOURCE_PROPOSED_UNVERIFIED',r.frameworkFailureCode);assert.equal(r.adapterSourceProposal.bookingUrl,canonicalAcuity);
  assert.equal(f.opens,1);assert.equal(f.extracts,2);assert.equal(r.nativeFrameNavigations[0].frameUrl,entry);assert.equal(r.nativeFrameNavigations[0].finalUrl,canonicalAcuity);
  assert.deepEqual(r.nativeFrameNavigations[0].redirects,[{fromUrl:entry,toUrl:canonicalAcuity,status:302,completed:true}]);
  assert.equal(validateStagehandSourceReport(r,raw).bookingUrl,canonicalAcuity);assert.equal(r.firstPickedUpAt,raw.firstPickedUpAt);assert.equal(r.deadlineAt,raw.deadlineAt);
  assert.equal(Date.parse(r.workDeadlineAt),Date.parse(raw.firstPickedUpAt)+240000);assert.equal(r.browserClosed,true);assert.equal(r.modelClosed,true);
 }
});
for(const mode of ['wrong','stale','hidden','missing-callback','redirect-gap','absent-redirect'])test(`legacy Acuity cannot fabricate a canonical key through ${mode} native evidence`,async()=>{
 const f=routingFrameFixture(mode,{entry:legacyAcuity,final:canonicalAcuity}),r=await sourceDiscover({job:job(),sessionFactory:async o=>{f.bind(o);return f.session;}});
 assert.equal(r.outcome,'UNRESOLVED');assert.equal(r.adapterSourceProposal,null);assert.equal(r.frameworkFailureCode,'STAGEHAND_SOURCE_OUTPUT_INVALID');assert.equal(r.browserClosed,true);assert.equal(r.modelClosed,true);
});
test('unchanged legacy Acuity entry cannot invent a canonical URL or exceed two frame operations',async()=>{
 const f=routingFrameFixture('valid',{entry:legacyAcuity,final:legacyAcuity}),r=await sourceDiscover({job:job(),sessionFactory:async o=>{f.bind(o);return f.session;}});
 assert.equal(f.opens,1);assert.equal(r.outcome,'UNRESOLVED');assert.equal(r.adapterSourceProposal,null);assert.equal(r.frameworkFailureCode,'STAGEHAND_SOURCE_OUTPUT_INVALID');
});

test('routing-only entries cannot exceed the original two native frame operations',async()=>{
 let current=official,next=playEntry,callback,evaluations=0,opens=0;
 const second='https://second-public-course.play.teeitup.com/';
 const witness=()=>({kind:'NATIVE_VISIBLE_FRAME',pageUrl:current,observedAt:new Date().toISOString(),documentHash:'a'.repeat(64),frames:[{src:next,visible:true}]});
 const session={localCodexCalls:[],browser:{context:{addInitScript:async()=>{}}},page:{url:async()=>current,evaluate:async()=>++evaluations%2?{url:current,observedAt:new Date().toISOString(),links:[],frames:[],dom:[]}:[]},
  goto:async()=>({status:()=>200}),observeFrameSources:async()=>witness(),
  extract:async(_i,schema)=>({data:schema.parse({decision:'SOURCE_FOUND',reason:'Public frame entry',nextActionInstruction:'',bookingUrl:next})}),
  openObservedFrameSource:async url=>{opens++;const w=witness();callback(w);current=url;next=second;return{kind:'NATIVE_FRAME_SOURCE_OPEN',pageUrl:w.pageUrl,frameUrl:url,observedAt:w.observedAt,
   documentHash:w.documentHash,finalUrl:url,completedAt:new Date().toISOString(),finalDocumentHash:'b'.repeat(64),redirects:[]};},close:async()=>({browserClosed:true,modelClosed:true})};
 const r=await sourceDiscover({job:job(),sessionFactory:async o=>{callback=o.onNativeFrameSourceWitness;return session;}});
 assert.equal(opens,2);assert.equal(r.nativeFrameNavigations.length,2);assert.equal(r.outcome,'UNRESOLVED');assert.equal(r.adapterSourceProposal,null);
 assert.equal(r.frameworkFailureCode,'STAGEHAND_SOURCE_OUTPUT_INVALID');
});
test('core and stateless-history prompt distinguish terminal availability from an intermediate operator labelled Book',()=>{
 const history={completedAnchorClicks:[{href:booking,afterUrl:landing,eligibleBookingSource:true,landingChanged:true}]};
 const text=buildSourceDiscoveryInstruction({identity:{name:'Public Course'},input:{players:2}},[booking],null,history);
 assert.match(text,/terminal public availability provider or a self-hosted availability widget/);
 assert.match(text,/link labelled Book can lead to an intermediate operator site: choose CONTINUE/);
 assert.match(text,/completed click alone does not establish a terminal source/);
 assert.match(text,/If that destination is an informational operator homepage, choose CONTINUE/);
 assert.match(text,/do not click merely to qualify/);assert.match(text,/both independent server challenges/);
 assert.ok(text.includes(JSON.stringify(history)));assert.ok(text.includes(`eligibleBookingSourceUrls=${JSON.stringify([booking])}`));
});
test('actual source OPEN failure retains closed navigation diagnosis before any model invocation',async()=>{
 const f=fixture();f.session.goto=async()=>{throw Error('Page.navigate: net::ERR_BLOCKED_BY_CLIENT https://private.example/?secret=SECRET');};
 const r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});
 assert.equal(r.sourceDiagnostic.phase,'OPEN');assert.equal(r.sourceDiagnostic.navigationCode,'ERR_BLOCKED_BY_CLIENT');assert.equal(r.sourceDiagnostic.counts.completedModelCalls,0);
 assert.equal(r.sourceDiagnostic.cleanup.browserClosed,true);assert.doesNotMatch(JSON.stringify(r.sourceDiagnostic),/private|SECRET|https:|Page.navigate/);
});

test('three actual pre-action guard rejections preserve the closed matched taxonomy in source failure',async()=>{
 const f=fixture();let executions=0;
 f.session.extract=async(_instruction,schema)=>({data:schema.parse({decision:'CONTINUE',reason:'Inspect public navigation',nextActionInstruction:'Open observed link',bookingUrl:null})});
 f.session.act=async action=>{prepareReadOnlyAction(action,{tag:'A',visible:true,inForm:false,text:'Reserve checkout',label:'',href:booking,formAction:'',rowText:''},{sourceRoutingOnly:true});executions++;};
 const r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});
 assert.equal(r.frameworkFailureCode,'STAGEHAND_SOURCE_ACTION_REJECTED');assert.equal(executions,0);assert.equal(r.actionAttempts.length,3);
 assert.equal(r.sourceDiagnostic.guardReason,'TRANSACTION_TEXT');assert.equal(r.sourceDiagnostic.guardTerm,'RESERVE');assert.equal(r.sourceDiagnostic.guardField,'TEXT');
 assert.equal(r.sourceDiagnostic.guardTag,'A');assert.equal(r.sourceDiagnostic.guardHasHref,true);assert.equal(r.browserClosed,true);
 assert.doesNotMatch(JSON.stringify(r.sourceDiagnostic),/https:|Reserve checkout|selector|PRIVATE/);
});
test('actual fixed DOM collector excludes hidden ancestors and directly exports an exact visible href without click',async()=>{
 const html=`<a href="${booking}">Public tee times</a>`+['hidden','inert','aria-hidden="true"','style="opacity:0"','style="display:none"','style="visibility:collapse"'].map((attr,i)=>`<div ${attr}><a href="https://provider.example/hidden${i}">Hidden</a></div>`).join('');
 const dom=new JSDOM(html,{url:official,runScripts:'outside-only'}),w=dom.window;
 w.Element.prototype.getClientRects=function(){return[{width:50,height:20}];};
 const computed=w.getComputedStyle.bind(w);w.getComputedStyle=e=>new Proxy(computed(e),{get(t,k){return k==='opacity'&&t.opacity===''?'1':Reflect.get(t,k);}});
 w.__ttsSafePublicEvidenceUrl=publicEvidenceUrl;
 const f=fixture();f.session.page.evaluate=async fn=>JSON.parse(JSON.stringify(w.eval('('+fn.toString()+')')()));
 f.session.extract=async(_instruction,schema)=>({data:schema.parse({decision:'SOURCE_FOUND',reason:'Exact visible native link',nextActionInstruction:'',bookingUrl:booking})});
 f.session.observe=async()=>{throw Error('UNNECESSARY_OBSERVE');};f.session.act=async()=>{throw Error('UNNECESSARY_CLICK');};
 try{
  const evidence=await pageEvidence(f.session);assert.deepEqual(evidence.links.map(item=>({href:item.href,visible:item.visible})),[{href:booking,visible:true}]);
  const r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});assert.equal(r.outcome,'SOURCE_PROPOSED_UNVERIFIED');assert.equal(r.adapterSourceProposal.bookingUrl,booking);assert.deepEqual(r.actions,[]);
  assert.equal(r.officialLinkLedger[0].kind,'NATIVE_VISIBLE_DOM');assert.ok(r.officialLinkLedger[0].observedAt);
  assert.throws(()=>sourceDecisionFor([booking]).parse({decision:'SOURCE_FOUND',reason:'Changed query',nextActionInstruction:'',bookingUrl:booking+'&invented=1'}));
  for(const href of['https://provider.example/ASP/appt_req.asp','https://provider.example/checkout','https://provider.example/login'])assert.throws(()=>sourceDecisionFor([href]),/CANDIDATES_INVALID/);
 }finally{dom.window.close();}
});
test('unobserved/model-invented proposal cannot become source or method',async()=>{
 const f=fixture({invalid:true}),r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});assert.equal(r.outcome,'UNRESOLVED');
 assert.equal(r.adapterSourceProposal,null);assert.equal(r.frameworkFailureCode,'STAGEHAND_SOURCE_OUTPUT_INVALID');assert.equal(r.recipe,null);assert.equal(r.browserClosed,true);
});

test('fresh guarded before-action witness retains a link hydrated after the prior zero-link capture',async()=>{
 const f=fixture();let current=official,evaluations=0,extracts=0,callback;
 f.session.page.url=async()=>current;
 f.session.page.evaluate=async()=>++evaluations%2?{url:current,links:[],frames:[],dom:[],network:{requests:[]}}:[];
 f.session.extract=async(_instruction,schema)=>({data:schema.parse(++extracts===1?
  {decision:'CONTINUE',reason:'Inspect visible navigation',nextActionInstruction:'Open public availability',bookingUrl:null}:
  {decision:'SOURCE_FOUND',reason:'Native observed destination',nextActionInstruction:'',bookingUrl:booking})});
 f.session.act=async()=>{
  callback({kind:'NATIVE_VISIBLE_DOM',pageUrl:official,observedAt:new Date().toISOString(),documentHash:'a'.repeat(64),links:[{href:booking,visible:true}]});
  current=booking;return{before:{tag:'A',href:booking},afterUrl:booking,openedNewPage:false};
 };
 const r=await sourceDiscover({job:job(),sessionFactory:async options=>{callback=options.onNativeSourceWitness;return f.session;}});
 assert.equal(r.officialLinkLedger[0].links.length,0);assert.equal(r.outcome,'SOURCE_PROPOSED_UNVERIFIED');
 const witness=r.officialLinkLedger.find(row=>row.documentHash);assert.equal(witness.pageUrl,official);assert.deepEqual(witness.links,[{href:booking,visible:true}]);
 assert.deepEqual(observedBookingSourceCandidates(r,official,publicEvidenceUrl,{sourceDiscoveryOnly:true}),[booking]);
 assert.equal(r.recipe,null);assert.deepEqual(r.matchingSlots,[]);
 assert.throws(()=>callback({...witness}),/STAGEHAND_SOURCE_OUTPUT_INVALID/);
});

for(const mutation of['foreign','stale','hidden','bad-hash','hash-array','duplicate','model-only'])test(`late DOM witness rejects ${mutation} evidence without promoting SDK/model target`,async()=>{
 const f=fixture();let evaluations=0,extracts=0,callback,current=official;
 f.session.page.url=async()=>current;
 f.session.page.evaluate=async()=>++evaluations%2?{url:current,links:[],frames:[],dom:[],network:{requests:[]}}:[];
 f.session.extract=async(_instruction,schema)=>({data:schema.parse(++extracts===1?
  {decision:'CONTINUE',reason:'Inspect navigation',nextActionInstruction:'Open public availability',bookingUrl:null}:
  {decision:'SOURCE_FOUND',reason:'Model claims destination',nextActionInstruction:'',bookingUrl:booking})});
 f.session.act=async()=>{
  const witness={kind:'NATIVE_VISIBLE_DOM',pageUrl:official,observedAt:new Date().toISOString(),documentHash:'a'.repeat(64),links:[{href:booking,visible:true}]};
  if(mutation==='foreign')witness.pageUrl='https://foreign.example/';
  if(mutation==='stale')witness.observedAt=new Date(Date.now()-10000).toISOString();
  if(mutation==='hidden')witness.links[0].visible=false;
  if(mutation==='bad-hash')witness.documentHash='untrusted';
  if(mutation==='hash-array')witness.documentHash=['a'.repeat(64)];
  if(mutation!=='model-only')callback(witness);
  if(mutation==='duplicate')callback(witness);
  current=booking;return{before:{tag:'A',href:booking},afterUrl:booking,openedNewPage:false,nativeWitness:witness};
 };
 const r=await sourceDiscover({job:job(),sessionFactory:async options=>{callback=options.onNativeSourceWitness;return f.session;}});
 assert.equal(r.outcome,'UNRESOLVED');assert.equal(r.adapterSourceProposal,null);assert.equal(r.recipe,null);assert.deepEqual(r.matchingSlots,[]);
 assert.equal(r.frameworkFailureCode,'STAGEHAND_SOURCE_OUTPUT_INVALID');
});
test('source failure exposes closed phase, attempted but incomplete call and known partial usage after cleanup',async()=>{
 const model=await createStagehandCodexModel({deadline:Date.now()+10000,clientFactory:async()=>({generate:async()=>{throw Object.assign(Error('PRIVATE_PROVIDER_TEXT'),{code:'LOCAL_MODEL_RPC_FAILED',diagnostics:{phase:'turn/start',rpcCode:-32600,httpStatusCode:400,usage:{inputTokens:17,totalTokens:17},message:'SECRET'}});},close:async()=>({})})});
 const f=fixture();Object.defineProperty(f.session,'modelCallCounts',{get:()=>({attempted:model.attemptedCalls,completed:model.calls.length})});
 f.session.extract=async()=>model.model.generate({systemPrompt:'Read only',messages:[{role:'user',content:{type:'text',text:'Public evidence'}}],responseFormat:{type:'json_schema',schema:{type:'object'}}});
 const close=f.session.close;f.session.close=async()=>{await model.close();return close();};
 const r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});
 assert.equal(r.sourceDiagnostic.phase,'EXTRACT');assert.equal(r.sourceDiagnostic.transportCode,'LOCAL_MODEL_RPC_FAILED');assert.equal(r.sourceDiagnostic.rpcCode,-32600);
 assert.equal(r.sourceDiagnostic.counts.attemptedModelCalls,1);assert.equal(r.sourceDiagnostic.counts.completedModelCalls,0);assert.equal(r.sourceDiagnostic.counts.failedModelCalls,1);
 assert.deepEqual(r.sourceDiagnostic.failedCallUsage,{totalTokens:17,inputTokens:17});assert.equal(r.sourceDiagnostic.cleanup.browserClosed,true);assert.equal(r.metrics.completedLocalCodexCalls,0);
 assert.doesNotMatch(JSON.stringify(r.sourceDiagnostic),/SECRET|PRIVATE|PROVIDER_TEXT/);
});

test('SDK-wrapped failed callback retains its private same-attempt model facts through source cleanup',async()=>{
 const model=await createStagehandCodexModel({deadline:Date.now()+10000,clientFactory:async()=>({generate:async()=>{throw Object.assign(Error('PRIVATE_PROVIDER_TEXT'),{code:'LOCAL_MODEL_RPC_FAILED',diagnostics:{phase:'turn/start',rpcCode:-32600,httpStatusCode:400}});},close:async()=>({})})});
 const f=fixture();Object.defineProperty(f.session,'modelCallCounts',{get:()=>({attempted:model.attemptedCalls,completed:model.calls.length})});
 Object.defineProperty(f.session,'lastModelFailure',{get:()=>model.lastFailure});
 f.session.extract=async()=>{try{await model.model.generate({systemPrompt:'Read',messages:[{role:'user',content:{type:'text',text:'Public'}}],responseFormat:{type:'json_schema',schema:{type:'object'}}});}catch{throw Error('WRAPPED_SDK_PRIVATE');}};
 const close=f.session.close;f.session.close=async()=>{await model.close();return close();};
 const r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});
 assert.equal(r.sourceDiagnostic.transportCode,'LOCAL_MODEL_RPC_FAILED');assert.equal(r.sourceDiagnostic.transportPhase,'turn/start');assert.equal(r.sourceDiagnostic.rpcCode,-32600);assert.equal(r.sourceDiagnostic.httpStatus,400);
 assert.equal(r.sourceDiagnostic.counts.attemptedModelCalls,1);assert.equal(r.sourceDiagnostic.counts.completedModelCalls,0);assert.equal(r.sourceDiagnostic.failedCallUsage,undefined);
 assert.doesNotMatch(JSON.stringify(r.sourceDiagnostic),/PRIVATE|WRAPPED|https:|stack|message/);assert.equal(r.browserClosed,true);
});

test('private same-attempt host close facts survive a source failure without exposing the attachment or inferring a model failure',async()=>{
 const f=fixture();let closed=false;
 const failure={layer:'ASYNC_LISTENER',event:'Target.attachedToTarget',pendingRequests:2};
 Object.defineProperty(f.session,'ownedCdpFailure',{get:()=>closed?failure:undefined});
 const native={code:'NATIVE_REDIRECT_LOADER_MISMATCH',phase:'LOADER_OWNER',method:'GET',resourceType:'document',loaderKnown:false};
 Object.defineProperty(f.session,'nativeRouterFailure',{get:()=>closed?native:undefined});
 const close=f.session.close;f.session.close=async()=>{closed=true;return close();};
 f.session.extract=async()=>{throw Error('OWNED_STAGEHAND_CDP_UNAVAILABLE');};
 const r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});
 assert.deepEqual(r.sourceDiagnostic.ownedCdpFailure,failure);assert.equal(r.sourceDiagnostic.counts.attemptedModelCalls,0);
 assert.deepEqual(r.sourceDiagnostic.nativeRouterFailure,native);
 assert.equal(r.sourceDiagnostic.transportCode,'OWNED_STAGEHAND_CDP_UNAVAILABLE');assert.equal(r.browserClosed,true);
 assert.doesNotMatch(JSON.stringify(r.sourceDiagnostic),/https:|PRIVATE|targetId|sessionId|cdpUrl/);
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

test('exact final decision and stop enum are private artifacts only; source-report stays the exact returned report',async()=>{
 const path=mkdtempSync(join(tmpdir(),'stagehand-stop-test-'));
 try{
  const f=fixture();f.session.extract=async(_instruction,schema)=>({data:schema.parse({decision:'UNRESOLVED',reason:'Private model reason not for stop metadata',nextActionInstruction:'',bookingUrl:null})});
  const report=await sourceDiscover({job:job(),sessionFactory:async()=>f.session,outputDirectory:path});
  assert.equal(report.outcome,'UNRESOLVED');assert.equal(report.frameworkFailureCode,undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(path,'source-report.json'),'utf8')),JSON.parse(JSON.stringify(report)));
  const stop=JSON.parse(readFileSync(join(path,'source-stop.json'),'utf8'));
  assert.equal(stop.finalDecision,'UNRESOLVED');assert.equal(stop.stopCondition,'EXPLICIT_UNRESOLVED');assert.equal(stop.jobId,report.jobId);
  assert.equal(stop.deadlineAt,report.deadlineAt);assert.equal(report.finalDecision,undefined);assert.equal(report.stopCondition,undefined);
  assert.doesNotMatch(JSON.stringify(stop),/reason|text|Private model/);
 }finally{rmSync(path,{recursive:true,force:true});}
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
   const sourceDeadline=Math.min(first+240000,local+240000),f=fixture();let constructorCalls=0,closed=0;
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
const generatedClientExports=()=>({PrismaClient:class{constructor(){throw Error('CLIENT_MUST_NOT_BE_CONSTRUCTED');}},Prisma:{ModelName:{CourseDiscoveryJob:'CourseDiscoveryJob',CourseAccessRecipe:'CourseAccessRecipe',LocalReaderJob:'LocalReaderJob'}}});
function generatedClientWorkspace(generated=false){
 const root=mkdtempSync(join(tmpdir(),'tts-source-client-readiness-'));
 const pkg=join(root,'node_modules','@prisma','client');mkdirSync(pkg,{recursive:true});
 writeFileSync(join(root,'package.json'),'{}');writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'@prisma/client',main:'default.js'}));
 writeFileSync(join(pkg,'default.js'),'module.exports={...require(".prisma/client/default")};');
 if(generated){const directory=join(root,'node_modules','.prisma','client');mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,'default.js'),`module.exports={PrismaClient:class{constructor(){throw Error('MUST_NOT_CONSTRUCT');}},Prisma:{ModelName:{CourseDiscoveryJob:'CourseDiscoveryJob',CourseAccessRecipe:'CourseAccessRecipe',LocalReaderJob:'LocalReaderJob'}}};`);}
 return root;
}
const readinessMocks=()=>({loadRuntime:async()=>{},loadHelpers:async()=>({prepareDiscoveryModelCatalog:()=>{},resolveDiscoveryCli:()=>'/trusted/codex'}),read:()=>JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'PRIVATE_AUTH'}})});
test('prepare is read-only readiness with no account RPC/model/browser or credential output',async()=>{
 const r=await prepareSourceDiscovery({cwd:process.cwd(),...readinessMocks(),loadGeneratedClient:generatedClientExports});
 assert.equal(r.ready,true);assert.equal(r.generatedClientReady,true);assert.equal(r.readinessAccountRpcPerformed,false);assert.equal(JSON.stringify(r).includes('PRIVATE'),false);
 await assert.rejects(prepareSourceDiscovery({...readinessMocks(),loadGeneratedClient:generatedClientExports,read:()=>JSON.stringify({auth_mode:'apikey'})}),/EXISTING_CHATGPT_LOGIN_REQUIRED/);
});
test('actual checkout-scoped package import rejects its missing generated Prisma client before any other preparation',async()=>{
 const cwd=generatedClientWorkspace();let later=0;
 try{await assert.rejects(prepareSourceDiscovery({cwd,loadRuntime:async()=>{later++;},loadHelpers:async()=>{later++;},read:()=>{later++;}}),
  error=>error.code==='LOCAL_GENERATED_PRISMA_CLIENT_UNAVAILABLE'&&error.message===error.code&&!error.cause);
  assert.equal(later,0);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
test('actual generated export import stays local and never constructs PrismaClient',async()=>{
 const cwd=generatedClientWorkspace(true);try{const r=await prepareSourceDiscovery({cwd,...readinessMocks()});assert.equal(r.generatedClientReady,true);}
 finally{rmSync(cwd,{recursive:true,force:true});}
});
test('package stubs and malformed generated exports fail with only the closed readiness code',async()=>{
 for(const value of[{}, {PrismaClient:function(){}}, {PrismaClient:function(){},Prisma:{ModelName:{}}}])
  await assert.rejects(prepareSourceDiscovery({...readinessMocks(),loadGeneratedClient:()=>value}),{code:'LOCAL_GENERATED_PRISMA_CLIENT_UNAVAILABLE'});
 await assert.rejects(prepareSourceDiscovery({...readinessMocks(),loadGeneratedClient:()=>{throw Error('PRIVATE_CLIENT_PATH');}}),
  error=>error.message==='LOCAL_GENERATED_PRISMA_CLIENT_UNAVAILABLE'&&!JSON.stringify(error).includes('PRIVATE'));
});
test('normal supervisor does not claim cold work when the actual generated client import is unavailable',async()=>{
 const cwd=generatedClientWorkspace(),events=[];let cold=0,workers=0,failed=0;
 const supervisor=createCourseDiscoverySupervisor({client:{nextExecution:async()=>({job:null}),next:async()=>{cold++;return{job:null};},fail:async()=>{failed++;}},
  prepareWorker:()=>prepareSourceDiscovery({cwd,...readinessMocks()}),startWorker:async()=>{workers++;},executeRecipe:async()=>{throw Error('NO_EXECUTION');},
  timers:{setInterval:()=>1,clearInterval:()=>{}},onEvent:event=>events.push(event)});
 try{await supervisor.start();assert.equal(cold,0);assert.equal(workers,0);assert.equal(failed,0);
  assert.ok(events.some(e=>e.event==='poll_failed'&&e.code==='LOCAL_GENERATED_PRISMA_CLIENT_UNAVAILABLE'));
 }finally{await supervisor.stop();rmSync(cwd,{recursive:true,force:true});}
});
test('portable directory contains no sealed cohort paths, historical venues, API fallback or raw prompt capture',()=>{
 const text=readdirSync(new URL('.',import.meta.url)).filter(f=>f.endsWith('.mjs')&&!f.endsWith('.test.mjs')).map(f=>readFileSync(new URL(f,import.meta.url),'utf8')).join('\n');
 assert.doesNotMatch(text,/fifteenth-cohort|normal-inputs\.json|course-framework-comparison|Emerald|Walnut|OnPar|TTS_OWNED_FIXTURE_CAPTURE_DIR/);
 assert.doesNotMatch(text,/file:\/\/\/C:|const WORKSPACE|const SOURCE_HOME/);
});
