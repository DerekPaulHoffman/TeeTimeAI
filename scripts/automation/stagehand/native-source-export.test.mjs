import test from 'node:test';

test('private JS completion becomes an exact routing source and survives only its own bounded checkpoint',async()=>{
 const input=job(),destination='https://public-provider.example/services?kind=public',href=official+'#';
 let current=official,evaluations=0,extracts=0,callback,prepared;
 const done={bodyPresent:true,mainDocumentCurrent:true,mainDocumentComplete:true,mainReadPending:false,readyState:'complete',mainDocumentStatus:200,pendingReads:0};
 const session={localCodexCalls:[],browser:{context:{addInitScript:async()=>{}}},page:{url:async()=>current,evaluate:async()=>++evaluations%2?{url:current,observedAt:new Date().toISOString(),links:current===official?[{href,text:'Book Bay',visible:true}]:[],frames:[],dom:[]}:[]},
  goto:async()=>({status:()=>200}),settleSourceDocument:async()=>done,
  extract:async(_instruction,schema)=>({data:schema.parse(++extracts===1?{decision:'CONTINUE',reason:'Follow actual visible public navigation',nextActionInstruction:'Open Book Bay',bookingUrl:null}:{decision:'SOURCE_FOUND',reason:'Actual completed public service document',nextActionInstruction:'',bookingUrl:destination})}),
  observe:async()=>({data:[{method:'click',selector:'a',description:'Open public Book Bay',arguments:[]}]}),
  act:async()=>{prepared={kind:'NATIVE_VISIBLE_DOM',pageUrl:official,observedAt:new Date().toISOString(),documentHash:'a'.repeat(64),links:[{href,visible:true,text:'Book Bay',label:''}]};callback(prepared);current=destination;
   return{before:{tag:'A',href,text:'\n\t  Book Bay \n\t',label:''},afterUrl:destination,openedNewPage:false,nativeGestureNavigation:{kind:'NATIVE_GESTURE_SOURCE_OPEN',pageUrl:official,href,text:'Book Bay',label:'',observedAt:prepared.observedAt,documentHash:prepared.documentHash,targetUrl:destination,finalUrl:destination,finalStatus:200,completedAt:new Date().toISOString(),finalDocumentHash:'b'.repeat(64),redirects:[]}};},
  close:async()=>({browserClosed:true,modelClosed:true})};
 const report=await sourceDiscover({job:input,sessionFactory:async options=>{callback=options.onNativeSourceWitness;return session;}});
 assert.equal(report.outcome,'SOURCE_PROPOSED_UNVERIFIED');assert.equal(report.adapterSourceProposal.bookingUrl,destination);assert.equal(report.nativeGestureNavigations.length,1);validateStagehandSourceReport(report,input);
 const saved=createStagehandSourceCheckpoint(input,report),resumed=readStagehandSourceCheckpoint({...input,attempts:2,checkpoint:{stagehandSource:saved}},undefined,Date.now());
 assert.equal(saved.report.actions[0].observedTarget.text,'Book Bay');
 assert.deepEqual(resumed.report.nativeGestureNavigations,report.nativeGestureNavigations);assert.equal(resumed.report.actions[0].openedNewPage,false);
 assert.equal(resumed.report.adapterSourceProposal.bookingUrl,destination);assert.equal(resumed.firstPickedUpAt,input.firstPickedUpAt);assert.equal(resumed.deadlineAt,input.deadlineAt);
 assert.throws(()=>readStagehandSourceCheckpoint({...input,id:'copied-job',attempts:2,checkpoint:{stagehandSource:saved}},undefined,Date.now()));
 for(const change of[{text:'Other Bay'},{text:''},{text:'Book Bay '.repeat(24)},{label:'forged'}]){
  const mismatched=structuredClone(saved.report);Object.assign(mismatched.actions[0].observedTarget,change);
  assert.throws(()=>validateStagehandSourceReport(mismatched,input),/STAGEHAND_SOURCE_GRAPH_LIMIT/);
 }
 const wrongRaw=structuredClone(report);wrongRaw.actions[0].observedTarget.text='\n\tOther Bay\n';
 assert.throws(()=>validateStagehandSourceReport(wrongRaw,input),/STAGEHAND_SOURCE_GRAPH_LIMIT/);
 const overlongRaw=structuredClone(report);overlongRaw.actions[0].observedTarget.text=' '.repeat(513)+'Book Bay';
 validateStagehandSourceReport(overlongRaw,input);
 assert.throws(()=>createStagehandSourceCheckpoint(input,overlongRaw),/STAGEHAND_SOURCE_GRAPH_LIMIT/);
 for(const change of[{finalStatus:503},{targetUrl:'https://foreign.example/'},{href:official+'/other'},{loaderId:'forged'}]){
  const forged=structuredClone(report);Object.assign(forged.nativeGestureNavigations[0],change);assert.throws(()=>validateStagehandSourceReport(forged,input));
 }
 const duplicated=structuredClone(report);duplicated.nativeGestureNavigations.push(structuredClone(duplicated.nativeGestureNavigations[0]));assert.throws(()=>validateStagehandSourceReport(duplicated,input));
});
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {sourceDiscover} from './source-discovery.mjs';
import {sourceRoutingUniqueWitness,openStagehandSession} from './driver.mjs';
import {validateStagehandSourceReport,createStagehandSourceCheckpoint,readStagehandSourceCheckpoint} from '../course-discovery-stagehand-source.mjs';
const official='https://official.example/',booking='https://public-course.book.teeitup.com/';
const job=()=>{const t=Date.now();return{id:'native-source-job',attempts:1,sourceFingerprint:'a'.repeat(64),firstPickedUpAt:new Date(t).toISOString(),deadlineAt:new Date(t+900000).toISOString(),request:{identity:{name:'Public Course',officialUrl:official,timeZone:'America/New_York',address:'10 Public Road, Town, NY 10001, USA'},target:{courseId:'public-course',kind:'OUTDOOR'},input:{date:'2026-11-01',timeZone:'America/New_York',players:2,startTime:'08:00',endTime:'18:00'}}};};
function fixture(witness){let calls=0,evaluations=0;const current=official,completed=[];return{get calls(){return calls;},session:{startupMs:1,browser:{context:{addInitScript:async()=>{}}},page:{url:async()=>current,evaluate:async()=>++evaluations%2===0?[]:({url:current,observedAt:new Date().toISOString(),links:[],frames:[],dom:[]})},goto:async()=>({status:()=>200}),observeUniqueSource:async()=>typeof witness==='function'?witness():witness,extract:async(_instruction,schema)=>{calls++;completed.push({model:'gpt-6.1-sol',effort:'medium',usage:{totalTokens:1}});return{data:schema.parse({decision:'UNRESOLVED',reason:'No source',nextActionInstruction:'',bookingUrl:null})};},get localCodexCalls(){return completed;},get modelCallCounts(){return{attempted:calls};},close:async()=>({browserClosed:true,modelClosed:true})}};}
const witness=(patch={})=>({kind:'NATIVE_UNIQUE_SUPPORTED_SOURCE',pageUrl:official,url:booking,family:'TEEITUP',via:'FRAME',documentHash:'b'.repeat(64),observedAt:new Date().toISOString(),...patch});
const widgetWitness=(patch={})=>({kind:'NATIVE_ROOT_PUBLIC_WIDGET',pageUrl:official,observedAt:new Date().toISOString(),documentHash:'c'.repeat(64),widgetKind:'CALENDAR',...patch});

test('404 compact negative routing history survives own checkpoint and can only exclude, never grant a failed source',async()=>{
 const input=job(),f=fixture(()=>witness()),r=await sourceDiscover({job:input,sessionFactory:async()=>f.session}),failed=official+'missing';
 r.visitedUrls.push(failed);r.actions.push({sourceUrl:official,action:{method:'click'},observedTarget:{tag:'A',href:failed},afterUrl:failed,openedNewPage:false,error:true});
 r.officialLinkLedger.push({kind:'NATIVE_VISIBLE_DOM',pageUrl:official,observedAt:r.startedAt,documentHash:'d'.repeat(64),links:[{href:failed,visible:true}]});
 r.notFoundRecovery={sourceUrl:official,targetUrl:failed,failedUrl:failed,status:404,observedAt:r.startedAt,completedAt:r.finishedAt,recoveredTo:official,recoveredUrl:official};
 const saved=createStagehandSourceCheckpoint(input,r),resumed=readStagehandSourceCheckpoint({...input,attempts:2,checkpoint:{stagehandSource:saved}},undefined,Date.now());
 assert.deepEqual(saved.report.notFoundRecovery,r.notFoundRecovery);assert.deepEqual(resumed.report.notFoundRecovery,r.notFoundRecovery);assert.equal(saved.firstPickedUpAt,input.firstPickedUpAt);assert.equal(saved.deadlineAt,input.deadlineAt);
 assert.throws(()=>validateStagehandSourceReport({...r,adapterSourceProposal:{schemaVersion:1,kind:'EXISTING_ADAPTER_SOURCE',bookingUrl:failed}},input),/STAGEHAND_SOURCE_NOT_OBSERVED/);
 for(const change of [{status:200},{recoveredTo:'https://foreign.example/'},{targetUrl:'https://foreign.example/'},{completedAt:'2000-01-01T00:00:00.000Z'},{authority:true}])
  assert.throws(()=>validateStagehandSourceReport({...r,notFoundRecovery:{...r.notFoundRecovery,...change}},input),/STAGEHAND_SOURCE_REPORT_INVALID/);
 assert.throws(()=>validateStagehandSourceReport({...r,actions:[]},input),/STAGEHAND_SOURCE_REPORT_INVALID/);
});

for(const widgetKind of ['CALENDAR','SERVICE_CATALOG'])test('native root widget yields a distinct clean routing handoff and checkpoint without inventing a booking source '+widgetKind,async()=>{
 const input=job(),f=fixture(null);f.session.observeRootPublicWidget=async()=>widgetWitness({widgetKind});
 const r=await sourceDiscover({job:input,sessionFactory:async()=>f.session});
 assert.equal(r.outcome,'ROOT_WIDGET_PROPOSED_UNVERIFIED');assert.equal(r.decisionOrigin,'NATIVE_PUBLIC_ROOT_WIDGET');assert.equal(r.adapterSourceProposal,null);
 assert.equal(f.calls,0);assert.deepEqual(r.eligibleBookingSourceUrls,[]);assert.deepEqual(r.matchingSlots,[]);assert.equal(r.recipe,null);assert.equal(r.browserClosed,true);assert.equal(r.modelClosed,true);
 assert.deepEqual(validateStagehandSourceReport(r,input),{schemaVersion:1,kind:'ROOT_PUBLIC_WIDGET'});
 const saved=createStagehandSourceCheckpoint(input,r),resumed=readStagehandSourceCheckpoint({...input,attempts:2,checkpoint:{stagehandSource:saved}},undefined,Date.now());
 assert.equal(resumed.report.rootWidgetWitness.kind,'NATIVE_ROOT_PUBLIC_WIDGET');assert.equal(resumed.report.adapterSourceProposal,null);assert.equal(resumed.firstPickedUpAt,input.firstPickedUpAt);
 assert.equal(resumed.report.rootWidgetWitness.widgetKind,widgetKind);
 for(const change of[{browserClosed:false},{modelClosed:false},{frameworkFailureCode:'STAGEHAND_GUARDED_SOURCE_REJECTED'},
  {adapterSourceProposal:{schemaVersion:1,kind:'EXISTING_ADAPTER_SOURCE',bookingUrl:official}},
  {rootWidgetWitness:{...r.rootWidgetWitness,pageUrl:'https://foreign.example/'}}])assert.throws(()=>validateStagehandSourceReport({...r,...change},input));
});
test('missing or forged root witness and failed closure never become a root handoff',async()=>{
 for(const value of[()=>widgetWitness({widgetKind:'MODEL_SAYS_WIDGET'}),()=>widgetWitness({modelCaption:'calendar'}),()=>widgetWitness({observedAt:'2000-01-01T00:00:00.000Z'}),()=>widgetWitness({pageUrl:'https://foreign.example/'})]){
  const f=fixture(null);f.session.observeRootPublicWidget=async()=>value();const r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});
  assert.equal(r.outcome,'UNRESOLVED');assert.equal(r.adapterSourceProposal,null);assert.equal(f.calls,0);
 }
 const f=fixture(null);f.session.observeRootPublicWidget=async()=>widgetWitness();f.session.close=async()=>({browserClosed:false,modelClosed:true});
 const r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});assert.equal(r.outcome,'UNRESOLVED');assert.equal(r.rootWidgetWitness,undefined);
});
test('fresh private native edge produces only unverified routing with zero fabricated model decisions and real checkpoint roundtrip',async()=>{
  const input=job(),f=fixture(()=>witness()),directory=mkdtempSync(join(tmpdir(),'tts-native-source-'));
  try{const r=await sourceDiscover({job:input,sessionFactory:async()=>f.session,outputDirectory:directory});
    assert.equal(r.outcome,'SOURCE_PROPOSED_UNVERIFIED');assert.equal(r.decisionOrigin,'NATIVE_UNIQUE_SUPPORTED_SOURCE');assert.equal(r.metrics.calls,0);assert.equal(r.metrics.completedSteps,0);assert.equal(r.metrics.attemptedLocalCodexCalls,0);assert.equal(r.metrics.completedLocalCodexCalls,0);assert.equal(f.calls,0);
    assert.deepEqual(r.actions,[]);assert.deepEqual(r.matchingSlots,[]);assert.equal(r.recipe,null);assert.equal(r.frameLedger.at(-1).kind,'NATIVE_VISIBLE_FRAME');assert.equal(r.frameLedger.at(-1).documentHash,'b'.repeat(64));
    assert.deepEqual(validateStagehandSourceReport(r,input),{schemaVersion:1,kind:'EXISTING_ADAPTER_SOURCE',bookingUrl:booking});
    const checkpoint=createStagehandSourceCheckpoint(input,r);assert.equal(checkpoint.report.decisionOrigin,'NATIVE_UNIQUE_SUPPORTED_SOURCE');assert.deepEqual(validateStagehandSourceReport(checkpoint.report,input),r.adapterSourceProposal);
    const stop=JSON.parse(readFileSync(join(directory,'source-stop.json')));assert.equal(stop.finalDecision,null);assert.equal(stop.stopCondition,'SOURCE_FOUND');
  }finally{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+'/tts-native-source-')||resolve(directory).startsWith(resolve(tmpdir())+'\\tts-native-source-'));rmSync(directory,{recursive:true,force:true});}
});
test('native link and duplicate link/frame sources retain exact observed URL and both native ledger edges',async()=>{
  const exact='https://foreupsoftware.com/index.php/booking/123/456#/teetimes',f=fixture(()=>witness({url:exact,family:'FOREUP',via:'LINK_AND_FRAME'}));
  const r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});assert.equal(r.adapterSourceProposal.bookingUrl,exact);assert.equal(r.officialLinkLedger.at(-1).links[0].href,exact);assert.equal(r.frameLedger.at(-1).frames[0].src,exact);assert.equal(f.calls,0);
});
test('native stopping choice clears an earlier CONTINUE decision while preserving actual earlier model usage',async()=>{
  const landing='https://official.example/public-booking';let current=official,evaluations=0;
  const f=fixture(()=>current===official?null:witness({pageUrl:landing})),directory=mkdtempSync(join(tmpdir(),'tts-native-source-'));
  const extract=f.session.extract;f.session.extract=async(instruction,schema)=>{await extract(instruction,schema);return{data:schema.parse({decision:'CONTINUE',reason:'Follow public link',nextActionInstruction:'Open public booking',bookingUrl:null})};};
  f.session.page.url=async()=>current;f.session.page.evaluate=async()=>++evaluations%2===0?[]:{url:current,observedAt:new Date().toISOString(),links:current===official?[{href:landing,visible:true,text:'Public booking'}]:[],frames:[],dom:[]};
  f.session.observe=async()=>({data:[{method:'click',selector:'a',arguments:[]}]});
  f.session.act=async()=>{current=landing;return{before:{tag:'A',href:landing},afterUrl:landing,openedNewPage:false};};
  try{const input=job(),r=await sourceDiscover({job:input,sessionFactory:async()=>f.session,outputDirectory:directory});
    assert.equal(r.outcome,'SOURCE_PROPOSED_UNVERIFIED');assert.equal(r.decisionOrigin,'NATIVE_UNIQUE_SUPPORTED_SOURCE');assert.equal(f.calls,1);assert.equal(r.metrics.completedLocalCodexCalls,1);assert.equal(r.metrics.completedSteps,1);assert.equal(r.actions.length,1);
    assert.equal(JSON.parse(readFileSync(join(directory,'source-stop.json'))).finalDecision,null);validateStagehandSourceReport(r,input);
  }finally{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+'/tts-native-source-')||resolve(directory).startsWith(resolve(tmpdir())+'\\tts-native-source-'));rmSync(directory,{recursive:true,force:true});}
});
test('unknown/ambiguous or nonfresh native result falls back to the unchanged Sol extraction',async()=>{
  for(const value of[()=>null,()=>witness({observedAt:new Date(Date.now()-10000).toISOString()}),()=>witness({pageUrl:'https://foreign.example/'})]){
    const f=fixture(value),r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});assert.equal(f.calls,1);assert.equal(r.outcome,'UNRESOLVED');assert.equal(r.decisionOrigin,undefined);assert.equal(r.metrics.completedSteps,1);
  }
});
test('malformed/private/model-only native output cannot be promoted',async()=>{
  for(const patch of[{modelSaysUnique:true},{url:'https://public-course.book.teeitup.com/?token=private'},{documentHash:'forged'}]){
    const f=fixture(()=>witness(patch)),r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session});assert.equal(r.outcome,'UNRESOLVED');assert.equal(r.decisionOrigin,undefined);assert.equal(f.calls,0);assert.equal(r.frameworkFailureCode,'STAGEHAND_NATIVE_HOST_INVALID');
  }
  assert.equal(sourceRoutingUniqueWitness(null,{pageUrl:official,startedAt:0,deadline:Date.now()+1000}),null);
});
for(const sourceRoutingOnly of[false,true])test(`real driver uses the exact owned private target only in source mode=${sourceRoutingOnly}`,async()=>{
  let observed=0;const page={pageId:'owned-target',url:async()=>official},browser={context:{pages:async()=>[page]},close:async()=>{}};
  const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:page.pageId,assertGuardedTargets:async()=>true,
    beforeAction:async()=>{},prepareNavigation:async()=>{},close:async()=>({browserClosed:true}),observeUniqueSource:async id=>{assert.equal(id,page.pageId);observed++;return witness();}};
  const session=await openStagehandSession({deadline:Date.now()+5000,modelDisabled:true,sourceRoutingOnly,ownedBrowser:owned},
    {loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>({close:async()=>{}})}})});
  const result=await session.observeUniqueSource();assert.equal(observed,sourceRoutingOnly?1:0);assert.equal(result?.url??null,sourceRoutingOnly?booking:null);await session.close();
});
test('native choice cannot escape original deadline or a changed current page',()=>{
  const stamp=Date.now(),w=witness();assert.equal(sourceRoutingUniqueWitness(w,{pageUrl:official,startedAt:stamp-1,deadline:stamp,now:stamp}),null);
  assert.equal(sourceRoutingUniqueWitness(w,{pageUrl:'https://changed.example/',startedAt:stamp-1,deadline:stamp+1000,now:stamp}),null);
});
for(const sourceRoutingOnly of[false,true])test(`root widget uses only the current private owned target in source mode=${sourceRoutingOnly}`,async()=>{
 let calls=0;const page={pageId:'owned-root',url:async()=>official},browser={context:{pages:async()=>[page]},close:async()=>{}};
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:page.pageId,assertGuardedTargets:async()=>true,
  beforeAction:async()=>{},prepareNavigation:async()=>{},close:async()=>({browserClosed:true}),observeRootPublicWidget:async id=>{assert.equal(id,page.pageId);calls++;return widgetWitness();}};
 const session=await openStagehandSession({deadline:Date.now()+5000,modelDisabled:true,sourceRoutingOnly,ownedBrowser:owned},
  {loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>({close:async()=>{}})}})});
 try{const result=await session.observeRootPublicWidget();assert.equal(calls,sourceRoutingOnly?1:0);assert.equal(result?.kind??null,sourceRoutingOnly?'NATIVE_ROOT_PUBLIC_WIDGET':null);assert.equal(result?.url,undefined);}finally{await session.close();}
});
