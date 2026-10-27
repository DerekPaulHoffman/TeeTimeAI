import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFrameWitnessFailure, sourceDiscover as sourceDiscoverWithRealClock } from './source-discovery.mjs';
import { projectSourceDiagnostic, sourceFailureDiagnostic } from './source-diagnostic.mjs';
import { isSourceRoutingUrl, sourceRoutingFrameWitness, openStagehandSession } from './driver.mjs';

const pageUrl='https://public-course.example/';
const frameUrl='https://public-provider.example/start';
const stamp=Date.now();
const sourceDiscover=options=>{let clock=Date.now();return sourceDiscoverWithRealClock({...options,
 sourceEvidenceWait:{now:()=>clock,sleep:async ms=>{clock+=ms;},...options.sourceEvidenceWait}});};
const witness=()=>({kind:'NATIVE_VISIBLE_FRAME',pageUrl,observedAt:new Date(stamp).toISOString(),documentHash:'a'.repeat(64),frames:[{src:frameUrl,visible:true}]});
const context={pageUrl,visitedUrls:[pageUrl],startedAt:stamp,workDeadline:stamp+120000,now:stamp};
test('closed frame witness predicates preserve exact validation, including source URL normalization',()=>{
  assert.equal(nativeFrameWitnessFailure(witness(),context),null);
  const cases=[
    ['SHAPE',w=>{w.secret='PRIVATE';}],['KIND',w=>{w.kind='OTHER';}],['PAGE_BINDING',w=>{w.pageUrl=frameUrl;}],
    ['TIMESTAMP',w=>{w.observedAt='not-a-date';}],['STALE',w=>{w.observedAt=new Date(stamp-1).toISOString();}],
    ['DEADLINE',w=>{w.observedAt=new Date(stamp+5001).toISOString();}],['DOCUMENT_HASH',w=>{w.documentHash='SECRET';}],
    ['FRAME_ARRAY',w=>{w.frames=null;}],['DUPLICATE_FRAME',w=>{w.frames.push({...w.frames[0]});}],
    ['FRAME_SHAPE',w=>{w.frames[0].text='PRIVATE';}],['FRAME_HIDDEN',w=>{w.frames[0].visible=false;}],
    ['FRAME_URL',w=>{w.frames[0].src=frameUrl+'?session=PRIVATE';}],
    ['FRAME_URL',w=>{w.frames[0].src='https://public-provider.example';}],['FRAME_SELF',w=>{w.frames[0].src=pageUrl;}],
  ];
  for(const [expected,mutate]of cases){const w=witness();mutate(w);assert.equal(nativeFrameWitnessFailure(w,context),expected);}
  assert.equal(nativeFrameWitnessFailure(witness(),{...context,visitedUrls:[]}), 'PAGE_NOT_VISITED');
  assert.equal(nativeFrameWitnessFailure(witness(),{...context,selected:pageUrl}), 'SELECTION');
  const w=witness();w.pageUrl='https://public-course.example';
  assert.equal(nativeFrameWitnessFailure(w,{...context,pageUrl:w.pageUrl}),'PAGE_URL');
});
test('frame predicate diagnostics contain no raw witness or private exception fields',()=>{
  const d=sourceFailureDiagnostic({phase:'EVIDENCE',error:Object.assign(Error('PRIVATE'),{stagehandFrameWitnessFailure:'FRAME_URL'}),report:{},modelAttempts:0});
  assert.equal(d.frameWitnessFailure,'FRAME_URL');assert.doesNotMatch(JSON.stringify(d),/PRIVATE|https:|selector|message/);
  assert.equal(projectSourceDiagnostic({...d,frameWitnessFailure:'SECRET'}),undefined);
  assert.equal(sourceFailureDiagnostic({error:{stagehandFrameWitnessFailure:'SECRET'}}).frameWitnessFailure,undefined);
});
test('actual source rejects native-frame URL before extraction and keeps precise diagnostic with cleanup',async()=>{
  const now=Date.now();let extracts=0,closed=0;
  const job={id:'owned-frame-diagnostic',firstPickedUpAt:new Date(now).toISOString(),deadlineAt:new Date(now+900000).toISOString(),request:{
    identity:{name:'Public Course',officialUrl:pageUrl,timeZone:'America/New_York'},target:{courseId:'owned-course',kind:'OUTDOOR'},
    input:{date:'2026-11-01',timeZone:'America/New_York',players:2,startTime:'08:00',endTime:'18:00'}}};
  let evals=0;
  const report=await sourceDiscover({job,sessionFactory:async()=>({startupMs:0,localCodexCalls:[],browser:{context:{addInitScript:async()=>{}}},
    page:{url:async()=>pageUrl,evaluate:async()=>++evals%2?{url:pageUrl,observedAt:new Date().toISOString(),links:[],frames:[],dom:[]}:[]},
    goto:async()=>({status:()=>200}),observeFrameSources:async()=>({...witness(),observedAt:new Date().toISOString(),frames:[{src:frameUrl+'?token=PRIVATE',visible:true}]}),
    extract:async()=>{extracts++;throw Error('MODEL_FORBIDDEN');},close:async()=>{closed++;return{browserClosed:true,modelClosed:true};}})});
  assert.equal(report.frameworkFailureCode,'STAGEHAND_SOURCE_OUTPUT_INVALID');assert.equal(report.sourceDiagnostic.phase,'EVIDENCE');
  assert.equal(report.sourceDiagnostic.frameWitnessFailure,'FRAME_URL');assert.equal(extracts,0);assert.equal(closed,1);
  assert.equal(report.browserClosed,true);assert.equal(report.modelClosed,true);
});

test('mixed native frames omit only source-policy-ineligible URLs and retain the exact safe observation',()=>{
  const w=witness();w.frames.push(...[
    'https://public-embed.example/widget?small_header=false',
    'https://public-embed.example/widget?token=PRIVATE',
    'https://public-embed.example/login',
    'https://public-embed.example/captcha',
    'https://public-embed.example/ASP/appt_req.asp',
  ].map(src=>({src,visible:true})));
  const before=structuredClone(w),filtered=sourceRoutingFrameWitness(w);
  assert.deepEqual(filtered,{...w,frames:[{src:frameUrl,visible:true}]});assert.deepEqual(w,before);
  assert.equal(nativeFrameWitnessFailure(filtered,context),null);
  for(const frame of before.frames.slice(1))assert.equal(isSourceRoutingUrl(frame.src),false);
  assert.equal(isSourceRoutingUrl(frameUrl),true);
  assert.equal(sourceRoutingFrameWitness({...w,frames:w.frames.slice(1)}).frames.length,0);
});
test('filtering cannot hide malformed, duplicate, hidden or oversized native witnesses from the strict validator',()=>{
  const cases=[['SHAPE',w=>{w.extra='PRIVATE';}],['KIND',w=>{w.kind='OTHER';}],
    ['FRAME_SHAPE',w=>{w.frames[0].text='PRIVATE';}],['FRAME_HIDDEN',w=>{w.frames[0].visible=false;}],
    ['DUPLICATE_FRAME',w=>{w.frames.push({...w.frames[0]});}],['FRAME_ARRAY',w=>{w.frames=Array.from({length:25},(_,n)=>({src:frameUrl+'?n='+n,visible:true}));}]];
  for(const [reason,mutate]of cases){const w=witness();mutate(w);assert.equal(sourceRoutingFrameWitness(w),w);assert.equal(nativeFrameWitnessFailure(w,context),reason);}
});
test('source driver enumerates a mixed native witness safely and rejects excluded selection before native prepare or goto',async()=>{
  let prepared=0,navigated=0;const unsafe='https://public-embed.example/widget?small_header=false';
  const native={...witness(),frames:[{src:frameUrl,visible:true},{src:unsafe,visible:true}]};
  const page={pageId:'owned',url:async()=>pageUrl,goto:async()=>{navigated++;}};
  const session=await openStagehandSession({deadline:Date.now()+3000,modelDisabled:true,sourceRoutingOnly:true,
    ownedBrowser:{kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:'owned',assertGuardedTargets:async()=>true,
      beforeAction:async()=>{},prepareNavigation:async()=>{},observeFrameSources:async()=>native,prepareFrameNavigation:async()=>{prepared++;},
      completeFrameNavigation:async()=>{},close:async()=>({browserClosed:true})}},
    {loadRuntime:async()=>({localBrowser:{connect:async()=>({context:{pages:async()=>[page]},close:async()=>{}})},Stagehand:{create:async()=>({close:async()=>{}})}})});
  assert.deepEqual((await session.observeFrameSources()).frames,[{src:frameUrl,visible:true}]);
  await assert.rejects(session.openObservedFrameSource(unsafe),/STAGEHAND_SOURCE_OUTPUT_INVALID/);
  assert.equal(prepared,0);assert.equal(navigated,0);await session.close();
});
