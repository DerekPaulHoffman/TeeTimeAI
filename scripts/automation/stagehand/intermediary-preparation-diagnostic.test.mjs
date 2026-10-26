import test from 'node:test';import assert from 'node:assert/strict';
import {projectNativeIntermediaryPreparation,sourceFailureDiagnostic,projectSourceDiagnostic,intermediaryPreparationStages,intermediaryPreparationReasons} from './source-diagnostic.mjs';
import{readFileSync}from'node:fs';
import {openStagehandSession}from'./driver.mjs';
import {createStagehandFailureCheckpoint,readStagehandFailure}from'../course-discovery-stagehand-failure.mjs';
import {readStagehandSourceCheckpoint}from'../course-discovery-stagehand-source.mjs';
const facts=(patch={})=>({attempt:1,stage:'SELECT',reason:'DOM_CHANGED',firstRows:118,secondRows:118,firstOverflow:false,secondOverflow:false,firstSettled:true,secondSettled:true,firstCandidatePresent:true,secondCandidatePresent:true,samePage:true,sameNativeDocument:true,sameDocumentHash:false,sameReadinessState:false,sameRoutingInventory:true,...patch});
test('exact current native producer fields/stage/reason enums match the closed failure projector',()=>{
 const type=readFileSync(new URL('../../../src/lib/course-discovery/public-booking-intermediary.ts',import.meta.url),'utf8').split('export type NativeIntermediaryPreparationDiagnostic = {')[1].split('\n};')[0];
 for(const [key,expected]of[['stage',intermediaryPreparationStages],['reason',intermediaryPreparationReasons]])assert.deepEqual([...type.match(new RegExp(key+':([^;]+);'))[1].matchAll(/"([A-Z_]+)"/gu)].map(m=>m[1]).sort(),[...expected].sort());
 assert.deepEqual([...type.matchAll(/\b([A-Za-z]\w*):/gu)].map(m=>m[1]).sort(),Object.keys(facts()).sort());
});
test('strict closed preparation facts are copied and unknown/private/malformed data never projects',()=>{
 const input=facts(),copy=projectNativeIntermediaryPreparation(input);assert.deepEqual(copy,input);copy.reason='READY';assert.equal(input.reason,'DOM_CHANGED');
 for(const patch of[{url:'https://private.example/?token=SECRET'},{firstRows:161},{secondRows:-1},{attempt:0},{attempt:NaN},{samePage:'true'},{sameRoutingInventory:{}},{reason:'PRIVATE_ERROR'},{stage:'https://private.example'}])assert.equal(projectNativeIntermediaryPreparation(facts(patch)),undefined);
 assert.ok(projectNativeIntermediaryPreparation(facts({stage:'BEGIN',reason:'ENTRY_LIMIT',firstRows:null,secondRows:null,firstSettled:null})));
});
test('original model failure and durable same-job/clock checkpoint keep the actual preparation cause without source authority',()=>{
 const now=Date.now(),first=now-1000,job={id:'closed-intermediary-job',attempts:1,sourceFingerprint:'a'.repeat(64),firstPickedUpAt:new Date(first).toISOString(),deadlineAt:new Date(first+900000).toISOString(),request:{target:{courseId:'course',kind:'OUTDOOR'},identity:{officialUrl:'https://public.example/'},input:{players:2}}};
 const error=Object.assign(Error('LOCAL_MODEL_TURN_FAILED'),{diagnostics:{phase:'turn/completed',httpStatusCode:429}}),report={metrics:{localCodexCalls:[{},{}]},browserClosed:true,modelClosed:true};
 report.sourceDiagnostic=sourceFailureDiagnostic({error,phase:'OBSERVE',report,modelAttempts:3,intermediaryPreparation:facts()});
 assert.equal(report.sourceDiagnostic.transportCode,'LOCAL_MODEL_TURN_FAILED');assert.equal(report.sourceDiagnostic.httpStatus,429);assert.equal(report.sourceDiagnostic.nativeIntermediaryPreparation.reason,'DOM_CHANGED');
 const saved=createStagehandFailureCheckpoint({job,report,error,phase:'SOURCE_VALIDATION',metrics:{modelCalls:2},now,startedAt:first});
 assert.equal(readStagehandFailure({...job,checkpoint:saved},now).entries[0].diagnostic.nativeIntermediaryPreparation.sameReadinessState,false);
 assert.equal(readStagehandSourceCheckpoint({...job,checkpoint:saved},undefined,now),undefined);
 const forged=structuredClone(saved);forged.stagehandFailure.entries[0].diagnostic.nativeIntermediaryPreparation.url='PRIVATE';assert.equal(readStagehandFailure({...job,checkpoint:forged},now),undefined);
 const bad=sourceFailureDiagnostic({error,report,intermediaryPreparation:{...facts(),private:'SECRET'}});assert.equal(bad.nativeIntermediaryPreparation,undefined);assert.ok(projectSourceDiagnostic(bad));
 assert.doesNotMatch(JSON.stringify(saved),/PRIVATE|SECRET|https:/u);
});
async function sessionFixture({sourceRoutingOnly=true,prepare=async()=>null,snapshot=async()=>({nativeIntermediaryPreparation:facts()}),onWitness}={}){
 let gotos=0;const root='https://public.example/',page={pageId:'owned',url:async()=>root,goto:async()=>{gotos++;}},browser={context:{pages:async()=>[page]},close:async()=>{}};
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:'owned',assertGuardedTargets:async()=>true,beforeAction:async()=>{},prepareNavigation:async()=>{},close:async()=>({browserClosed:true}),preparePublicBookingIntermediary:prepare,completePublicBookingIntermediary:async()=>{},snapshotFailures:snapshot};
 const session=await openStagehandSession({deadline:Date.now()+5000,modelDisabled:true,sourceRoutingOnly,ownedBrowser:owned,onNativeIntermediaryWitness:onWitness},{loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>({close:async()=>{}})}})});
 return{session,get gotos(){return gotos;}};
}
test('real driver captures null fallback diagnostics before model use and exposes a copy only after its own prepare',async()=>{
 const f=await sessionFixture();assert.equal(f.session.nativeIntermediaryPreparation,undefined);assert.equal(await f.session.openPublicBookingIntermediary(),null);
 assert.equal(f.session.nativeIntermediaryPreparation.reason,'DOM_CHANGED');const copied=f.session.nativeIntermediaryPreparation;copied.reason='READY';assert.equal(f.session.nativeIntermediaryPreparation.reason,'DOM_CHANGED');assert.equal(f.gotos,0);assert.equal(f.session.modelCallCounts.attempted,0);await f.session.close();
});
test('normal readers do not invoke/adopt a source-only preparation observation',async()=>{
 let attempted=0;const f=await sessionFixture({sourceRoutingOnly:false,prepare:async()=>{attempted++;return null;}});assert.equal(await f.session.openPublicBookingIntermediary(),null);assert.equal(attempted,0);await f.session.close();assert.equal(f.session.nativeIntermediaryPreparation,undefined);
});
test('private diagnostic failure cannot replace the exact original prepare exception',async()=>{
 const primary=Error('STAGEHAND_GUARDED_SOURCE_REJECTED'),f=await sessionFixture({prepare:async()=>{throw primary;},snapshot:async()=>{throw Error('PRIVATE_SECONDARY');}});
 await assert.rejects(f.session.openPublicBookingIntermediary(),error=>error===primary);assert.equal(f.session.nativeIntermediaryPreparation,undefined);assert.equal(f.gotos,0);await f.session.close();
});
test('root-only READY capture callback stops the actual driver before main GET without changing the witness or inventing authority',async()=>{
 const stop=Error('ENGINEERING_CAPTURE_STOP_BEFORE_GET'),f=await sessionFixture({prepare:async()=>({kind:'NATIVE_PUBLIC_BOOKING_INTERMEDIARY',pageUrl:'https://public.example/',documentHash:'b'.repeat(64),observedAt:new Date().toISOString(),links:[{href:'https://public.example/tee-times',visible:false}]}),snapshot:async()=>({nativeIntermediaryPreparation:facts({stage:'GRANT',reason:'READY',sameReadinessState:true,sameDocumentHash:true})}),onWitness:w=>{assert.equal(w.links[0].visible,false);throw stop;}});
 await assert.rejects(f.session.openPublicBookingIntermediary(),error=>error===stop);assert.equal(f.session.nativeIntermediaryPreparation.reason,'READY');assert.equal(f.gotos,0);assert.equal(f.session.modelCallCounts.attempted,0);await f.session.close();
});
