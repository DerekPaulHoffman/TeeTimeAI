import test from 'node:test';import assert from 'node:assert/strict';
import {sourceDiscover as sourceDiscoverWithRealClock,sourceRoutingContext,buildSourceDiscoveryInstruction} from './source-discovery.mjs';
import {openStagehandSession} from './driver.mjs';
import {createStagehandSourceCheckpoint,validateStagehandSourceReport} from '../course-discovery-stagehand-source.mjs';
import {observedInspectionPath} from '../course-discovery-stagehand-inspection.mjs';
const root='https://official.example/',entry=root+'tee-times',provider='https://public-course.book.teeitup.com/';
const sourceDiscover=options=>{let clock=Date.now();return sourceDiscoverWithRealClock({...options,
 sourceEvidenceWait:{now:()=>clock,sleep:async ms=>{clock+=ms;},...options.sourceEvidenceWait}});};
const hash='b'.repeat(64),witness=()=>({kind:'NATIVE_PUBLIC_BOOKING_INTERMEDIARY',pageUrl:root,documentHash:hash,observedAt:new Date().toISOString(),links:[{href:entry,visible:false}]});
const completion=w=>({kind:'NATIVE_PUBLIC_BOOKING_INTERMEDIARY_OPEN',pageUrl:root,url:entry,documentHash:hash,observedAt:w.observedAt,completedAt:new Date().toISOString(),finalUrl:entry,finalDocumentHash:'c'.repeat(64),redirects:[]});
const job=()=>{const t=Date.now();return{id:'native-intermediary-job',attempts:1,sourceFingerprint:'a'.repeat(64),firstPickedUpAt:new Date(t).toISOString(),deadlineAt:new Date(t+900000).toISOString(),request:{identity:{name:'Public Course',officialUrl:root,timeZone:'America/New_York',address:'10 Public Road, Town, NY 10001, USA'},target:{courseId:'course',kind:'OUTDOOR'},input:{date:'2026-11-01',timeZone:'America/New_York',players:2,startTime:'08:00',endTime:'18:00'}}};};
function fixture(options,change){let current=root,evaluations=0,models=0;return{get models(){return models;},session:{startupMs:1,browser:{context:{addInitScript:async()=>{}}},page:{url:async()=>current,evaluate:async()=>++evaluations%2===0?[]:({url:current,observedAt:new Date().toISOString(),links:[],frames:[],dom:[]})},goto:async()=>({status:()=>200}),
 observeUniqueSource:async()=>current===entry?{kind:'NATIVE_UNIQUE_SUPPORTED_SOURCE',pageUrl:entry,url:provider,observedAt:new Date().toISOString(),documentHash:'d'.repeat(64),family:'TEEITUP',via:'LINK'}:null,
 openPublicBookingIntermediary:async()=>{if(current!==root)return null;const w=witness();change?.(w);options.onNativeIntermediaryWitness(w);current=entry;return completion(w);},
 extract:async(_instruction,schema)=>{models++;return{data:schema.parse({decision:'UNRESOLVED',reason:'No current source',nextActionInstruction:'',bookingUrl:null})};},modelCallCounts:{attempted:0},localCodexCalls:[],close:async()=>({browserClosed:true,modelClosed:true})}};}
test('distinct hidden public-document edge survives compact checkpoint and exact fresh inspection path without invented actions/model calls',async()=>{
 let f;const j=job(),report=await sourceDiscover({job:j,sessionFactory:async options=>(f=fixture(options)).session});
 assert.equal(report.outcome,'SOURCE_PROPOSED_UNVERIFIED');assert.equal(report.decisionOrigin,'NATIVE_UNIQUE_SUPPORTED_SOURCE');assert.equal(report.metrics.completedSteps,0);assert.equal(report.metrics.calls,0);assert.equal(f.models,0);assert.deepEqual(report.actions,[]);
 const row=report.officialLinkLedger.find(r=>r.kind==='NATIVE_PUBLIC_BOOKING_INTERMEDIARY');assert.deepEqual(row.links,[{href:entry,visible:false}]);assert.equal(report.nativeIntermediaryNavigations.length,1);
 const saved=createStagehandSourceCheckpoint(j,report).report;assert.deepEqual(saved.officialLinkLedger.find(r=>r.kind===row.kind).links,row.links);assert.equal(saved.nativeIntermediaryNavigations.length,1);
 assert.equal(validateStagehandSourceReport(saved,j).bookingUrl,provider);assert.deepEqual(observedInspectionPath(saved,root,provider),[root,entry,provider]);
 for(const mutate of[r=>r.officialLinkLedger.find(x=>x.kind===row.kind).links[0].visible=true,r=>delete r.officialLinkLedger.find(x=>x.kind===row.kind).documentHash,r=>r.nativeIntermediaryNavigations[0].url='https://foreign.example/tee-times']){
  const changed=structuredClone(saved);mutate(changed);assert.throws(()=>validateStagehandSourceReport(changed,j),/STAGEHAND_SOURCE_GRAPH_LIMIT/);
 }
});
test('missing, foreign, stale, private or model-supplied callback data cannot add a raw-document routing edge',async()=>{
 for(const change of[w=>w.observedAt='bad',w=>w.observedAt=new Date(0).toISOString(),w=>w.links[0].href='https://foreign.example/tee-times',w=>w.links[0].visible=true,w=>w.modelSaysPublic=true]){
  const r=await sourceDiscover({job:job(),sessionFactory:async options=>fixture(options,change).session});assert.equal(r.outcome,'UNRESOLVED');assert.equal(r.frameworkFailureCode,'STAGEHAND_SOURCE_OUTPUT_INVALID');
 }
});
test('absent unique intermediary falls back to ordinary extraction',async()=>{
 let f;const r=await sourceDiscover({job:job(),sessionFactory:async options=>{f=fixture(options);f.session.openPublicBookingIntermediary=async()=>null;return f.session;}});assert.equal(r.outcome,'UNRESOLVED');assert.equal(f.models,1);assert.deepEqual(r.nativeIntermediaryNavigations,[]);
});
for(const sourceRoutingOnly of[false,true])test(`real driver private no-URL operation is source-only=${sourceRoutingOnly} and witnesses before one main GET`,async()=>{
 let current=root,prepared=0,opened=0,recorded=false,selected;
 const page={pageId:'owned',url:async()=>current,goto:async url=>{assert.equal(recorded,true);assert.equal(url,entry);current=url;opened++;}},browser={context:{pages:async()=>[page]},close:async()=>{}};
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:'owned',assertGuardedTargets:async()=>true,beforeAction:async()=>{},prepareNavigation:async()=>{},close:async()=>({browserClosed:true}),
 preparePublicBookingIntermediary:async id=>{assert.equal(id,'owned');prepared++;return selected=witness();},completePublicBookingIntermediary:async id=>{assert.equal(id,'owned');return completion(selected);}};
 const session=await openStagehandSession({deadline:Date.now()+5000,modelDisabled:true,sourceRoutingOnly,ownedBrowser:owned,onNativeIntermediaryWitness:w=>{assert.equal(w.links[0].visible,false);recorded=true;}},{loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>({close:async()=>{}})}})});
 const result=await session.openPublicBookingIntermediary();assert.equal(result?.finalUrl??null,sourceRoutingOnly?entry:null);assert.equal(opened,sourceRoutingOnly?1:0);assert.equal(prepared,opened);await session.close();
});
test('closed HIDDEN feedback reaches next stateless model instruction without treating rejection as an executed click',()=>{
 const c=sourceRoutingContext({actionAttempts:[{status:'REJECTED',guardReason:'HIDDEN'}],actions:[]},[]);assert.equal(c.lastNavigationFeedback,'HIDDEN');assert.deepEqual(c.completedAnchorClicks,[]);assert.match(buildSourceDiscoveryInstruction({},[],null,c),/do not repeat it/);
  assert.equal(sourceRoutingContext({actionAttempts:[{status:'REJECTED',guardReason:'HIDDEN'},{status:'EXECUTED'}]},[]).lastNavigationFeedback,null);
});
