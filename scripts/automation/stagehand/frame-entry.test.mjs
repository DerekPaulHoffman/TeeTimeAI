import test from 'node:test';
import assert from 'node:assert/strict';
import { openStagehandSession } from './driver.mjs';
import { sourceDiscover, sourceDecisionFor, sourceRoutingContext, pageEvidence } from './source-discovery.mjs';
import { nativeFrameNavigations, observedBookingSourceCandidates } from './source-provenance.mjs';
import { publicEvidenceUrl } from './public-evidence.mjs';
import { JSDOM } from 'jsdom';

const root='https://frame-course.example/', frame='https://wrapper.example/public?exact=one', inner='https://inner.example/public', final='https://provider.example/public';
const hash='a'.repeat(64);
const witness=(pageUrl=root,src=frame)=>({kind:'NATIVE_VISIBLE_FRAME',pageUrl,observedAt:new Date().toISOString(),documentHash:hash,frames:[{src,visible:true}]});
const completed=w=>({kind:'NATIVE_FRAME_SOURCE_OPEN',pageUrl:w.pageUrl,frameUrl:w.frames[0].src,observedAt:w.observedAt,documentHash:w.documentHash,
  finalUrl:w.frames[0].src,completedAt:new Date().toISOString(),finalDocumentHash:'b'.repeat(64),redirects:[]});
const decision=(url)=>({decision:'OPEN_FRAME',reason:'Investigate visible embedded public source',nextActionInstruction:'',bookingUrl:url});
function job(){const t=Date.now();return{id:'own-frame-job',firstPickedUpAt:new Date(t).toISOString(),deadlineAt:new Date(t+900000).toISOString(),
 request:{identity:{name:'Public Course',officialUrl:root,timeZone:'UTC'},target:{courseId:'own-course',kind:'OUTDOOR'},input:{date:'2030-01-01',timeZone:'UTC',players:2,startTime:'08:00',endTime:'18:00'}}};}

test('serialized fixed DOM evidence excludes any srcdoc override, including an empty attribute',async()=>{
 const dom=new JSDOM(`<iframe src="${frame}"></iframe><iframe src="${inner}" srcdoc=""></iframe><iframe src="${final}" srcdoc="<p>Inline</p>"></iframe>`,{url:root,runScripts:'outside-only'}),w=dom.window;
 w.Element.prototype.getClientRects=function(){return[{width:100,height:50}];};
 const computed=w.getComputedStyle.bind(w);w.getComputedStyle=e=>new Proxy(computed(e),{get(t,k){return k==='opacity'&&t.opacity===''?'1':Reflect.get(t,k);}});
 w.__ttsSafePublicEvidenceUrl=publicEvidenceUrl;
 try{const value=await pageEvidence({page:{evaluate:async fn=>JSON.parse(JSON.stringify(w.eval('('+fn.toString()+')')()))}});
  assert.deepEqual(value.frames.map(row=>row.src),[frame]);
 }finally{w.close();}
});

test('frame selection is an exact fresh enum, including multiple choices, never automatic or arbitrary',()=>{
 const schema=sourceDecisionFor([frame,inner,final],[frame,inner]);
 assert.equal(schema.parse(decision(inner)).bookingUrl,inner);
 for(const url of[final,'https://invented.example/',null])assert.throws(()=>schema.parse(decision(url)));
 assert.throws(()=>sourceDecisionFor([frame],[]).parse(decision(frame)));
 assert.throws(()=>sourceDecisionFor([frame],[inner]));
});
test('next stateless extraction receives only the closed no-progress rejection feedback',()=>{
 assert.equal(sourceRoutingContext({actionAttempts:[{status:'REJECTED',guardReason:'PRIVATE_MESSAGE'}]},[]).lastNavigationFeedback,null);
 const context=sourceRoutingContext({actionAttempts:[{status:'REJECTED',guardReason:'REPEATED_UNCHANGED_NAVIGATION',reason:'PRIVATE_MESSAGE'}]},[]);
 assert.equal(context.lastNavigationFeedback,'REPEATED_UNCHANGED_NAVIGATION');assert.doesNotMatch(JSON.stringify(context),/PRIVATE_MESSAGE/);
});

test('source controller records private native frame edge before main entry and reaches nested main evidence without act',async()=>{
 let current=root,evaluations=0,extracts=0,callback,acts=0,opens=0;
 const session={localCodexCalls:[],browser:{context:{addInitScript:async()=>{}}},page:{url:async()=>current,evaluate:async()=>++evaluations%2?
  {url:current,observedAt:new Date().toISOString(),links:current===inner?[{href:final,visible:true}]:[],frames:[],dom:[]}:[]},
  goto:async()=>({status:()=>200}),observeFrameSources:async()=>witness(current,current===root?frame:current===frame?inner:final),
  openObservedFrameSource:async url=>{opens++;const w=witness(current,url);callback(w);current=url;return completed(w);},
  extract:async(_i,schema)=>({data:schema.parse(++extracts===1?decision(frame):extracts===2?decision(inner):{decision:'SOURCE_FOUND',reason:'Native observed public source',nextActionInstruction:'',bookingUrl:final})}),
  act:async()=>{acts++;throw Error('MUST_NOT_ACT');},close:async()=>({browserClosed:true,modelClosed:true})};
 const report=await sourceDiscover({job:job(),sessionFactory:async options=>{callback=options.onNativeFrameSourceWitness;return session;}});
 assert.equal(report.outcome,'SOURCE_PROPOSED_UNVERIFIED',report.frameworkFailureCode);assert.equal(report.adapterSourceProposal.bookingUrl,final);
 assert.equal(opens,2);assert.equal(acts,0);assert.equal(nativeFrameNavigations(report).length,2);
 assert.ok(observedBookingSourceCandidates(report,root,undefined,{sourceDiscoveryOnly:true}).includes(final));
 assert.equal(report.recipe,null);assert.deepEqual(report.matchingSlots,[]);
});

for(const bad of['foreign','stale','hidden','hash','duplicate','modelOnly'])test(`source rejects ${bad} private frame witness before accepting routing`,async()=>{
 let evaluations=0,callback;
 const session={localCodexCalls:[],browser:{context:{addInitScript:async()=>{}}},page:{url:async()=>root,evaluate:async()=>++evaluations%2?{url:root,links:[],frames:[],dom:[]}:[]},goto:async()=>({status:()=>200}),
  observeFrameSources:async()=>witness(),extract:async(_i,s)=>({data:s.parse(decision(frame))}),
  openObservedFrameSource:async()=>{const w=witness();if(bad==='foreign')w.pageUrl=inner;if(bad==='stale')w.observedAt='2000-01-01T00:00:00.000Z';if(bad==='hidden')w.frames[0].visible=false;if(bad==='hash')w.documentHash='bad';
   if(bad!=='modelOnly')callback(w);if(bad==='duplicate')callback(w);return completed(w);},close:async()=>({browserClosed:true,modelClosed:true})};
 const r=await sourceDiscover({job:job(),sessionFactory:async o=>{callback=o.onNativeFrameSourceWitness;return session;}});
 assert.equal(r.outcome,'UNRESOLVED');assert.equal(r.adapterSourceProposal,null);assert.equal(r.frameworkFailureCode,'STAGEHAND_SOURCE_OUTPUT_INVALID');
});

test('only contiguous completed native redirects extend frame provenance; copied/stale/malformed/foreign rows do not',()=>{
 const w=witness(),row=completed(w);row.finalUrl=inner;row.redirects=[{fromUrl:frame,toUrl:inner,status:302,completed:true}];
 const report={startedAt:new Date(Date.now()-1000).toISOString(),finishedAt:new Date(Date.now()+1000).toISOString(),frameLedger:[w],nativeFrameNavigations:[row],visitedUrls:[root,inner],
  officialLinkLedger:[{kind:'NATIVE_VISIBLE_DOM',pageUrl:inner,observedAt:row.completedAt,links:[{href:final,visible:true}]}]};
 assert.equal(nativeFrameNavigations(report).length,1);assert.ok(observedBookingSourceCandidates(report,root,undefined,{sourceDiscoveryOnly:true}).includes(final));
 assert.ok(!observedBookingSourceCandidates(report,root).includes(final));
 for(const change of[r=>r.frameLedger=[],r=>r.frameLedger[0].frames[0].visible=false,r=>r.nativeFrameNavigations[0].observedAt='2000-01-01T00:00:00.000Z',
  r=>r.nativeFrameNavigations[0].redirects[0].fromUrl=final,r=>r.nativeFrameNavigations[0].redirects[0].status=200,r=>r.nativeFrameNavigations[0].extra='model',r=>r.nativeFrameNavigations[0].finalDocumentHash='bad']){
  const copy=structuredClone(report);change(copy);assert.deepEqual(nativeFrameNavigations(copy),[]);
 }
});

async function driverFixture({sourceRoutingOnly=true,deadline=Date.now()+3000}={}){
 let current=root;const order=[],page={pageId:'exact',url:async()=>current,goto:async url=>{order.push('goto');current=url;},
  evaluate:async()=>({tag:'A',visible:true,inForm:false,text:'Public availability',label:'',href:root,formAction:'',rowText:''})};
 let sdkActs=0,prepared=0,latest;
 const host={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:'exact',assertGuardedTargets:async()=>true,prepareNavigation:async()=>{},beforeAction:async()=>{prepared++;},
  observeFrameSources:async()=>witness(),prepareFrameNavigation:async(_id,url)=>{order.push('native');latest=witness(current,url);return latest;},completeFrameNavigation:async()=>{order.push('complete');return completed(latest);},close:async()=>({browserClosed:true})};
 const session=await openStagehandSession({deadline,modelDisabled:true,sourceRoutingOnly,ownedBrowser:host,onNativeFrameSourceWitness:()=>order.push('callback')},
  {loadRuntime:async()=>({localBrowser:{connect:async()=>({context:{pages:async()=>[page]},close:async()=>{}})},Stagehand:{create:async()=>({act:async()=>{sdkActs++;return{data:{success:true}};},close:async()=>{}})}})});
 return{session,order,get sdkActs(){return sdkActs;},get prepared(){return prepared;}};
}
test('driver emits native callback before main goto and verifies same current target',async()=>{
 const f=await driverFixture();await f.session.openObservedFrameSource(frame);assert.deepEqual(f.order,['native','callback','goto','complete']);assert.equal(f.session.page.pageId,'exact');await f.session.close();
});
test('default/full mode cannot enumerate or enter source frames',async()=>{
 const f=await driverFixture({sourceRoutingOnly:false});await assert.rejects(f.session.observeFrameSources(),/OUTPUT_INVALID/);await assert.rejects(f.session.openObservedFrameSource(frame),/OUTPUT_INVALID/);assert.deepEqual(f.order,[]);await f.session.close();
});
test('expired source deadline cannot enter a frame or mint callback',async()=>{
 const f=await driverFixture({deadline:Date.now()+30});await new Promise(r=>setTimeout(r,35));await assert.rejects(f.session.openObservedFrameSource(frame));assert.deepEqual(f.order,[]);await f.session.close();
});
test('second exact no-op anchor action rejects mechanically before native admission or SDK act',async()=>{
 const f=await driverFixture();const action={method:'click',selector:'a',arguments:[]};await f.session.act(action);
 await assert.rejects(f.session.act(action),e=>e.stagehandGuardReason==='REPEATED_UNCHANGED_NAVIGATION');assert.equal(f.sdkActs,1);assert.equal(f.prepared,1);await f.session.close();
});
