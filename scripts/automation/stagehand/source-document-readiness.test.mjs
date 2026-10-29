import test from 'node:test';
import assert from 'node:assert/strict';
import {settleSourceDocument,sourceDocumentSettled,openStagehandSession} from './driver.mjs';
import {projectSourceDocumentReadiness,projectSourceDiagnostic,sourceFailureDiagnostic} from './source-diagnostic.mjs';
const settled={readyState:'interactive',bodyPresent:true,mainDocumentCurrent:true,mainDocumentComplete:true,mainReadPending:false,pendingReads:0,mainDocumentStatus:200};

test('initial source navigation allows queued assets but never extends its original deadline',async()=>{
 for(const [sourceRoutingOnly,budget,ceiling] of [[true,120000,60000],[false,120000,30000],[true,500,500]]){
  let options;const page={pageId:'owned',url:async()=>'https://owned.example/',goto:async(_url,value)=>{options=value;}};
  const browser={context:{pages:async()=>[page]},close:async()=>{}};
  const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:'owned',assertGuardedTargets:async()=>true,prepareNavigation:async()=>{},beforeAction:async()=>{},close:async()=>({browserClosed:true})};
  const deadline=Date.now()+budget;
  const session=await openStagehandSession({deadline,modelDisabled:true,sourceRoutingOnly,ownedBrowser:owned},{loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>({close:async()=>{}})}})});
  await session.goto('https://owned.example/');
  assert.equal(options.waitUntil,'domcontentloaded');assert.ok(options.timeout>0&&options.timeout<=ceiling);
  assert.ok(options.timeout>=ceiling-250);assert.ok(Date.now()<deadline);
  await session.close();
 }
});

test('parser completion waits for the exact current main read; ancillary activity need not become idle',async()=>{
 let time=1000,reads=0;const observations=[];
 const result=await settleSourceDocument(async()=>{reads++;return reads===1?{...settled,readyState:'loading',bodyPresent:false,mainReadPending:true,mainDocumentComplete:false}:{...settled,pendingReads:9};},
  {deadline:2000,now:()=>time,sleep:async ms=>{time+=ms;},onObservation:value=>observations.push(value)});
 assert.equal(reads,2);assert.equal(time,1050);assert.equal(result.pendingReads,9);assert.equal(observations[0].readyState,'loading');assert.equal(sourceDocumentSettled(result),true);
});
test('readiness cannot be granted by an old document, pending ACK, non-200 or missing body',()=>{
 for(const delta of[{mainDocumentCurrent:false},{mainDocumentComplete:false},{mainReadPending:true},{mainDocumentStatus:null},{mainDocumentStatus:302},{bodyPresent:false},{readyState:'loading'},{readyState:'UNKNOWN'}])assert.equal(sourceDocumentSettled({...settled,...delta}),false);
 assert.equal(sourceDocumentSettled({...settled,readyState:'complete',pendingReads:12}),true);
});
test('already settled main document adds no wait or extra read',async()=>{
 let reads=0;const r=await settleSourceDocument(async()=>{reads++;return settled;},{deadline:2000,now:()=>1000,sleep:async()=>{throw Error('UNNECESSARY_WAIT');}});
 assert.deepEqual(r,settled);assert.equal(reads,1);
});
test('fatal native error remains the original error instead of retrying or manufacturing readiness',async()=>{
 const fatal=Error('OWNED_STAGEHAND_CDP_UNAVAILABLE');let reads=0;
 await assert.rejects(settleSourceDocument(async()=>{reads++;throw fatal;},{deadline:Date.now()+1000}),error=>error===fatal);assert.equal(reads,1);
});
test('readiness never falls back to a foreign/default target and full mode cannot use the seam',async()=>{
 for(const sourceRoutingOnly of[false,true]){
  let live=true,reads=0;const page={pageId:'owned',url:async()=>'https://owned.example/'};
  const browser={context:{pages:async()=>live?[page]:[{pageId:'foreign'}]},close:async()=>{}};
  const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:'owned',assertGuardedTargets:async()=>true,prepareNavigation:async()=>{},beforeAction:async()=>{},observeSourceReadiness:async id=>{assert.equal(id,'owned');reads++;return settled;},close:async()=>({browserClosed:true})};
  const session=await openStagehandSession({deadline:Date.now()+1000,modelDisabled:true,sourceRoutingOnly,ownedBrowser:owned},{loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>({close:async()=>{}})}})});
  if(sourceRoutingOnly){await session.settleSourceDocument();assert.equal(reads,1);live=false;await assert.rejects(session.settleSourceDocument(),/STAGEHAND_UNGUARDED_CONTEXT/);assert.equal(reads,1);}
  else{await assert.rejects(session.settleSourceDocument(),/STAGEHAND_SOURCE_OUTPUT_INVALID/);assert.equal(reads,0);}
  await session.close();
 }
});
test('original deadline expires with last closed readiness and no extra read',async()=>{
 let time=1000,reads=0;const loading={...settled,readyState:'loading'};
 await assert.rejects(settleSourceDocument(async()=>{reads++;return loading;},{deadline:1100,now:()=>time,sleep:async ms=>{time+=ms;}}),error=>error.message==='STAGEHAND_SOURCE_LOADING_INCOMPLETE'&&error.stagehandDocumentReadiness.readyState==='loading');
 assert.equal(time,1100);assert.equal(reads,2);
});
test('hanging native read is bounded by the same deadline and abort releases its waiter',async()=>{
 await assert.rejects(settleSourceDocument(()=>new Promise(()=>{}),{deadline:Date.now()+20}),/STAGEHAND_SOURCE_LOADING_INCOMPLETE/);
 const abort=new AbortController();const pending=settleSourceDocument(()=>new Promise(()=>{}),{deadline:Date.now()+10000,signal:abort.signal});
 abort.abort(Error('SOURCE_DISCOVERY_ABORTED'));await assert.rejects(pending,/SOURCE_DISCOVERY_ABORTED/);
});
test('strict closed readiness copies fields and rejects private/unknown or malformed data',async()=>{
 const copy=projectSourceDocumentReadiness(settled);assert.deepEqual(copy,settled);assert.notEqual(copy,settled);
 for(const delta of[{url:'https://private.example/'},{pendingReads:-1},{pendingReads:2049},{readyState:'SECRET'},{mainDocumentStatus:999},{bodyPresent:null}]){
  const value={...settled,...delta};assert.equal(projectSourceDocumentReadiness(value),undefined);
  await assert.rejects(settleSourceDocument(async()=>value,{deadline:Date.now()+1000}),/STAGEHAND_NATIVE_HOST_INVALID/);
 }
 const d=sourceFailureDiagnostic({phase:'EVIDENCE',documentReadiness:settled});assert.deepEqual(d.sourceDocumentReadiness,settled);
 assert.equal(projectSourceDiagnostic({...d,sourceDocumentReadiness:{...settled,raw:'PRIVATE'}}),undefined);
 assert.equal(sourceFailureDiagnostic({documentReadiness:{...settled,raw:'PRIVATE'}}).sourceDocumentReadiness,undefined);
});
