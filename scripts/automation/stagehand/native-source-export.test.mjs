import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {sourceDiscover} from './source-discovery.mjs';
import {sourceRoutingUniqueWitness,openStagehandSession} from './driver.mjs';
import {validateStagehandSourceReport,createStagehandSourceCheckpoint} from '../course-discovery-stagehand-source.mjs';
const official='https://official.example/',booking='https://public-course.book.teeitup.com/';
const job=()=>{const t=Date.now();return{id:'native-source-job',attempts:1,sourceFingerprint:'a'.repeat(64),firstPickedUpAt:new Date(t).toISOString(),deadlineAt:new Date(t+900000).toISOString(),request:{identity:{name:'Public Course',officialUrl:official,timeZone:'America/New_York',address:'10 Public Road, Town, NY 10001, USA'},target:{courseId:'public-course',kind:'OUTDOOR'},input:{date:'2026-11-01',timeZone:'America/New_York',players:2,startTime:'08:00',endTime:'18:00'}}};};
function fixture(witness){let calls=0,evaluations=0;const current=official,completed=[];return{get calls(){return calls;},session:{startupMs:1,browser:{context:{addInitScript:async()=>{}}},page:{url:async()=>current,evaluate:async()=>++evaluations%2===0?[]:({url:current,observedAt:new Date().toISOString(),links:[],frames:[],dom:[]})},goto:async()=>({status:()=>200}),observeUniqueSource:async()=>typeof witness==='function'?witness():witness,extract:async(_instruction,schema)=>{calls++;completed.push({model:'gpt-6.1-sol',effort:'medium',usage:{totalTokens:1}});return{data:schema.parse({decision:'UNRESOLVED',reason:'No source',nextActionInstruction:'',bookingUrl:null})};},get localCodexCalls(){return completed;},get modelCallCounts(){return{attempted:calls};},close:async()=>({browserClosed:true,modelClosed:true})}};}
const witness=(patch={})=>({kind:'NATIVE_UNIQUE_SUPPORTED_SOURCE',pageUrl:official,url:booking,family:'TEEITUP',via:'FRAME',documentHash:'b'.repeat(64),observedAt:new Date().toISOString(),...patch});
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
