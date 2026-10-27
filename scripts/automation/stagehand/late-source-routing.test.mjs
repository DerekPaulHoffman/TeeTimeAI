import test from 'node:test';
import assert from 'node:assert/strict';
import {lateSourceRoutingKeys,waitForLateSourceRoutingEvidence,sourceDiscover} from './source-discovery.mjs';

const official='https://public-course.example/',frame='https://public-provider.example/start?venue=public';
const complete={readyState:'complete',bodyPresent:true,mainDocumentCurrent:true,mainDocumentComplete:true,mainReadPending:false,pendingReads:0,mainDocumentStatus:200};
const baseline=()=>({url:official,documentTimeOrigin:1234,links:[{href:official+'golf',text:'GOLF COURSE',visible:true}],frames:[],dom:[],publicControls:[]});
const fixture=({iframeAt=5000,documentChangeAt=Infinity,readinessChangeAt=Infinity,staleWitness=false,modelOutcome='UNRESOLVED'}={})=>{
 let clock=Date.now(),evaluations=0,extracts=0,witnesses=0,current=official;const start=clock;
 const session={localCodexCalls:[],browser:{context:{addInitScript:async()=>{}}},page:{url:async()=>current,evaluate:async()=>++evaluations%2?{
  ...baseline(),url:current,documentTimeOrigin:clock-start>=documentChangeAt?5678:1234,
  frames:clock-start>=iframeAt?[{src:frame,visible:true,title:'Public tee times'}]:[]}:[]},
  goto:async()=>({status:()=>200}),settleSourceDocument:async()=>complete,
  readSourceDocumentReadiness:async()=>clock-start>=readinessChangeAt?{...complete,mainDocumentCurrent:false}:complete,
  observeFrameSources:async()=>{witnesses++;return {kind:'NATIVE_VISIBLE_FRAME',pageUrl:current,observedAt:new Date(staleWitness&&witnesses>1?0:Date.now()).toISOString(),documentHash:'a'.repeat(64),frames:clock-start>=iframeAt?[{src:frame,visible:true}]:[]};},
  extract:async(_instruction,schema)=>{extracts++;return {data:schema.parse({decision:extracts===1?'UNRESOLVED':modelOutcome,reason:'Current public evidence',nextActionInstruction:'',bookingUrl:extracts===1||modelOutcome!=='SOURCE_FOUND'?null:frame})};},
  close:async()=>({browserClosed:true,modelClosed:true})};
 const sleep=async ms=>{clock+=ms;if(clock-start>=documentChangeAt&&documentChangeAt!==Infinity)current=official;};
 return {session,wait:{now:()=>clock,sleep},get clock(){return clock;},get extracts(){return extracts;},get witnesses(){return witnesses;}};
};
const job=()=>{const first=Date.now();return{id:'late-routing-job',firstPickedUpAt:new Date(first).toISOString(),deadlineAt:new Date(first+900000).toISOString(),request:{identity:{name:'Public Course',officialUrl:official,timeZone:'America/New_York',address:'1 Public Road, NY 10001'},target:{courseId:'course',kind:'OUTDOOR'},input:{date:'2026-11-01',timeZone:'America/New_York',players:2,startTime:'08:00',endTime:'18:00'}}};};

test('late visible iframe adds routing evidence after an initial ordinary navigation link',async()=>{
 const f=fixture();const before=f.clock,result=await waitForLateSourceRoutingEvidence(f.session,baseline(),{deadline:before+20000,...f.wait});
 assert.equal(result,'NEW_ROUTING_EVIDENCE');assert.equal(f.clock-before,5000);
 assert.deepEqual([...lateSourceRoutingKeys(baseline())],[]);
});
test('unchanged routing evidence stops once at eight seconds without any model call',async()=>{
 const f=fixture({iframeAt:Infinity}),before=f.clock;
 assert.equal(await waitForLateSourceRoutingEvidence(f.session,baseline(),{deadline:before+20000,...f.wait}),'UNCHANGED');
 assert.equal(f.clock-before,8000);assert.equal(f.extracts,0);
});
test('the original deadline shortens the late check and never resets its clock',async()=>{
 const f=fixture({iframeAt:5000}),before=f.clock;
 assert.equal(await waitForLateSourceRoutingEvidence(f.session,baseline(),{deadline:before+3500,...f.wait}),'UNCHANGED');
 assert.equal(f.clock-before,2500);
});
test('changed document identity and unsettled native document cannot promote an old iframe snapshot',async()=>{
 for(const option of [{documentChangeAt:1500},{readinessChangeAt:1500}]){
  const f=fixture({...option,iframeAt:2000}),before=f.clock;
  assert.equal(await waitForLateSourceRoutingEvidence(f.session,baseline(),{deadline:before+20000,...f.wait}),'DOCUMENT_CHANGED');
  assert.ok(f.clock-before<2000);
 }
});
test('late iframe re-enters fresh native witness and model choice, without route seeding',async()=>{
 const f=fixture({modelOutcome:'SOURCE_FOUND'}),r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session,sourceEvidenceWait:f.wait});
 assert.equal(r.outcome,'SOURCE_PROPOSED_UNVERIFIED');assert.equal(r.adapterSourceProposal.bookingUrl,frame);
 assert.equal(f.extracts,2);assert.equal(f.witnesses,2);assert.equal(r.decisionOrigin,undefined);
});
test('late iframe with stale native witness fails closed before a second model decision',async()=>{
 const f=fixture({staleWitness:true,modelOutcome:'SOURCE_FOUND'}),r=await sourceDiscover({job:job(),sessionFactory:async()=>f.session,sourceEvidenceWait:f.wait});
 assert.equal(r.outcome,'UNRESOLVED');assert.equal(r.adapterSourceProposal,null);assert.equal(r.frameworkFailureCode,'STAGEHAND_SOURCE_OUTPUT_INVALID');assert.equal(f.extracts,1);
});
