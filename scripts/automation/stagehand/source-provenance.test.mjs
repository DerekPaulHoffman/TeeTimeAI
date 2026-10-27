import test from'node:test';import assert from'node:assert/strict';
import{observedBookingSourceCandidates,nativeGestureNavigations,nativeLinkSource,corroboratedNativeLink,rootWidgetRoutingWitness}from'./source-provenance.mjs';

function gestureReport(){
 const startedAt='2030-01-01T12:00:00.000Z',completedAt='2030-01-01T12:00:01.000Z',href=official+'#',target='https://public-provider.example/services?kind=public';
 return{startedAt,finishedAt:completedAt,visitedUrls:[official,target],initialNavigation:{requestedUrl:official,finalUrl:official,status:200},
  officialLinkLedger:[{kind:'NATIVE_VISIBLE_DOM',pageUrl:official,observedAt:startedAt,documentHash:'a'.repeat(64),links:[{href,visible:true,text:'Book Bay',label:''}]}],
  actions:[{sourceUrl:official,action:{method:'click'},observedTarget:{tag:'A',href,text:'Book Bay',label:''},afterUrl:target,openedNewPage:false}],
  nativeGestureNavigations:[{kind:'NATIVE_GESTURE_SOURCE_OPEN',pageUrl:official,href,text:'Book Bay',label:'',observedAt:startedAt,documentHash:'a'.repeat(64),targetUrl:target,finalUrl:target,finalStatus:200,completedAt,finalDocumentHash:'b'.repeat(64),redirects:[]}]};
}
test('only closed completed native JS witness exposes actual landing, never placeholder or a fabricated HTTP redirect',()=>{
 const r=gestureReport(),w=r.nativeGestureNavigations[0];assert.deepEqual(candidate(r),[w.finalUrl]);
 assert.deepEqual(candidate({...r,nativeGestureNavigations:[]}),[]);
 assert.equal(observedBookingSourceCandidates(r,official).includes(w.finalUrl),false);
 const redirected='https://public-provider.example/canonical';r.visitedUrls.push(redirected);r.actions[0].afterUrl=redirected;
 w.finalUrl=redirected;w.redirects=[{fromUrl:w.targetUrl,toUrl:redirected,status:302,completed:true}];assert.deepEqual(candidate(r),[redirected]);
 w.redirects.unshift({fromUrl:official,toUrl:w.targetUrl,status:302,completed:true});assert.deepEqual(candidate(r),[]);
});
for(const mode of['old clock','future clock','wrong source','wrong hash','no ledger','hidden ledger','wrong ledger descriptor','wrong action descriptor','no action','failed action','popup','wrong after','wrong target','wrong status','unknown key','copied duplicate','no visited']){
 test('JS routing witness rejects '+mode,()=>{const r=gestureReport(),w=r.nativeGestureNavigations[0];
  if(mode==='old clock')w.observedAt='2020-01-01T00:00:00.000Z';if(mode==='future clock')w.completedAt='2040-01-01T00:00:00.000Z';
  if(mode==='wrong source')w.pageUrl='https://foreign.example/';if(mode==='wrong hash')w.documentHash='c'.repeat(64);if(mode==='no ledger')r.officialLinkLedger=[];if(mode==='hidden ledger')r.officialLinkLedger[0].links[0].visible=false;
  if(mode==='wrong ledger descriptor')r.officialLinkLedger[0].links[0].text='Book Bay 2';if(mode==='wrong action descriptor')r.actions[0].observedTarget.text='Book Bay 2';
  if(mode==='no action')r.actions=[];if(mode==='failed action')r.actions[0].error=true;if(mode==='popup')r.actions[0].openedNewPage=true;if(mode==='wrong after')r.actions[0].afterUrl=official;
  if(mode==='wrong target')w.targetUrl='https://other.example/';if(mode==='wrong status')w.finalStatus=503;if(mode==='unknown key')w.loaderId='forged';
  if(mode==='copied duplicate'){r.nativeGestureNavigations.push(structuredClone(w));assert.equal(nativeGestureNavigations(r).length,1);return;}
  if(mode==='no visited')r.visitedUrls=[official];assert.deepEqual(nativeGestureNavigations(r),[]);assert.deepEqual(candidate(r),[]);
 });
}
const official='https://course.example/',source='https://provider.example/start?tenant=public',landing='https://provider.example/loading';
const candidate=r=>observedBookingSourceCandidates(r,official,undefined,{sourceDiscoveryOnly:true});
test('root widget routing keeps startup exclusions and only the initial native document scope',()=>{
 const at='2030-01-01T12:00:00.000Z',root={startedAt:at,finishedAt:at,visitedUrls:[official+'#calendar'],
  initialNavigation:{requestedUrl:official,finalUrl:official,status:200},rootWidgetWitness:{kind:'NATIVE_ROOT_PUBLIC_WIDGET',pageUrl:official+'#calendar',observedAt:at,documentHash:'a'.repeat(64),widgetKind:'CALENDAR'}};
 assert.equal(rootWidgetRoutingWitness(root,official).pageUrl,official+'#calendar');assert.deepEqual(candidate(root),[]);
 assert.equal(rootWidgetRoutingWitness({...root,rootWidgetWitness:{...root.rootWidgetWitness,widgetKind:'SERVICE_CATALOG'}},official).widgetKind,'SERVICE_CATALOG');
 assert.equal(rootWidgetRoutingWitness({...root,rootWidgetWitness:{...root.rootWidgetWitness,widgetKind:'SERVICE_CATALOG',serviceId:'FORGED'}},official),null);
 for(const url of[official+'other/',official+'?private=1','https://operator.example/'])assert.equal(rootWidgetRoutingWitness({...root,visitedUrls:[url],rootWidgetWitness:{...root.rootWidgetWitness,pageUrl:url}},official),null);
 for(const change of[{status:302},{requestedUrl:'https://foreign.example/'},{finalUrl:official+'other/'}])assert.equal(rootWidgetRoutingWitness({...root,initialNavigation:{...root.initialNavigation,...change}},official),null);
 assert.equal(rootWidgetRoutingWitness({...root,rootWidgetWitness:{...root.rootWidgetWitness,caption:'MODEL'}},official),null);
 const alias='https://www.course.example/';assert.equal(rootWidgetRoutingWitness({...root,visitedUrls:[alias],initialNavigation:{requestedUrl:official,finalUrl:alias,status:200},rootWidgetWitness:{...root.rootWidgetWitness,pageUrl:alias}},official).pageUrl,alias);
});
function report(){return{visitedUrls:[official,landing],initialNavigation:{requestedUrl:official,finalUrl:official,status:200},officialLinkLedger:[{pageUrl:official,links:[{href:source}]}],actions:[{sourceUrl:official,action:{method:'click'},observedTarget:{tag:'A',href:source},afterUrl:landing,openedNewPage:true}]};}
test('exact clicked officially linked ancestor survives public redirect, without query rewrite or currentURL substitution',()=>{assert.deepEqual(candidate(report()),[source]);const r=report();r.actions[0].observedTarget.href=source.replace('public','other');assert.deepEqual(candidate(r),[]);});
test('model-only/informational/unobserved/failed clicks never acquire native provenance',()=>{
 for(const mutate of[r=>r.actions=[],r=>r.actions[0].actionError='failed',r=>r.officialLinkLedger=[],r=>r.visitedUrls=[official],r=>r.actions[0].observedTarget.tag='DIV']){const r=report();mutate(r);assert.deepEqual(candidate(r),[]);}
 const r=report();r.actions[0].observedTarget.href=official;assert.deepEqual(candidate(r),[]);
});
test('native source aliases conflict failclosed and native-linked href requires actual matching action',()=>{
 const row={kind:'NATIVE_DOM_LINK_OBSERVED',sourceUrl:official,url:'https://other.example/',exactObservedHrefs:[source]};assert.equal(nativeLinkSource(row),null);assert.equal(corroboratedNativeLink(row,source,report()),false);
 delete row.url;assert.equal(nativeLinkSource(row),official);assert.equal(corroboratedNativeLink(row,source,report()),true);assert.equal(corroboratedNativeLink(row,source,{actions:[]}),false);
});
test('only actually visible embedded frame source may be proposed',()=>{
 const r={visitedUrls:[official],frameLedger:[{pageUrl:official,frames:[{src:source,visible:false}]}]};assert.deepEqual(candidate(r),[]);r.frameLedger[0].frames[0].visible=true;assert.deepEqual(candidate(r),[source]);
});

test('only exact completed native frame redirect final URL becomes a source-only candidate',()=>{
 const at=new Date().toISOString(),frame='https://public-course.play.teeitup.com/',final='https://public-course.book.teeitup.com/';
 const make=()=>({startedAt:at,finishedAt:at,visitedUrls:[official,final],frameLedger:[{kind:'NATIVE_VISIBLE_FRAME',pageUrl:official,observedAt:at,documentHash:'a'.repeat(64),frames:[{src:frame,visible:true}]}],
  nativeFrameNavigations:[{kind:'NATIVE_FRAME_SOURCE_OPEN',pageUrl:official,frameUrl:frame,observedAt:at,documentHash:'a'.repeat(64),finalUrl:final,completedAt:at,finalDocumentHash:'b'.repeat(64),redirects:[{fromUrl:frame,toUrl:final,status:302,completed:true}]}]});
 assert.deepEqual(candidate(make()),[frame,final]);assert.deepEqual(observedBookingSourceCandidates(make(),official),[official]);
 for(const mutate of[r=>r.nativeFrameNavigations[0].redirects[0].fromUrl='https://unobserved.example/',r=>r.nativeFrameNavigations[0].redirects[0].completed=false,
  r=>r.nativeFrameNavigations[0].completedAt='2000-01-01T00:00:00.000Z',r=>r.nativeFrameNavigations[0].finalDocumentHash='bad',
  r=>r.frameLedger[0].frames[0].visible=false,r=>{r.frameLedger[0].pageUrl='https://foreign.example/';r.nativeFrameNavigations[0].pageUrl='https://foreign.example/';}]){
  const r=make();mutate(r);assert.equal(candidate(r).includes(final),false);
 }
});
function visibleReport(links=[source]){const at=new Date().toISOString();return{startedAt:at,finishedAt:at,visitedUrls:[official],actions:[],officialLinkLedger:[{kind:'NATIVE_VISIBLE_DOM',observedAt:at,pageUrl:official,links:links.map(href=>({href,visible:true}))}]};}
test('fresh native visible DOM href is eligible without click or visiting its landing, full/default stays unchanged',()=>{
 const r=visibleReport();assert.deepEqual(candidate(r),[source]);
 assert.deepEqual(observedBookingSourceCandidates(r,official),[official]);
 assert.equal(r.visitedUrls.includes(source),false);assert.deepEqual(r.actions,[]);
});
test('missing/hidden/stale/foreign native DOM records and startup aliases cannot invent a source',()=>{
 for(const mutate of[r=>delete r.officialLinkLedger[0].kind,r=>delete r.officialLinkLedger[0].observedAt,r=>r.officialLinkLedger[0].links[0].visible=false,
  r=>r.officialLinkLedger[0].observedAt='2000-01-01T00:00:00Z',r=>r.officialLinkLedger[0].pageUrl='https://foreign.example/',r=>r.officialLinkLedger[0].links[0].href=official]){
  const r=visibleReport();mutate(r);assert.deepEqual(candidate(r),[]);
 }
 const hiddenPath=visibleReport(['https://foreign.example/']);hiddenPath.officialLinkLedger[0].links[0].visible=false;
 hiddenPath.officialLinkLedger.push({...visibleReport().officialLinkLedger[0],pageUrl:'https://foreign.example/'});hiddenPath.visitedUrls.push('https://foreign.example/');
 assert.deepEqual(candidate(hiddenPath),[]);
 const rootOnly=visibleReport([]);rootOnly.visitedUrls.push(source);assert.deepEqual(candidate(rootOnly),[]);
 assert.deepEqual(candidate(visibleReport([official+'#footer'])),[]);
 const query=official+'?public=booking&tenant=exact';assert.deepEqual(candidate(visibleReport([query])),[query]);
});
test('source-only exact query and 160/64KiB budgets fail explicitly; default full provenance still caps at32',()=>{
 const urls=Array.from({length:160},(_,i)=>`https://provider.example/start?tenant=${i}&exact=keep`);
 assert.deepEqual(candidate(visibleReport(urls)),urls);
 assert.throws(()=>candidate(visibleReport([...urls,'https://provider.example/extra'])),/SOURCE_CANDIDATES_LIMIT/);
 assert.throws(()=>candidate(visibleReport(Array.from({length:50},(_,i)=>`https://provider.example/start?tenant=${i}&data=${'x'.repeat(1500)}`))),/SOURCE_CANDIDATES_LIMIT/);
 const r=report();r.officialLinkLedger=[{pageUrl:official,links:urls.map(href=>({href}))}];r.actions=urls.map(href=>({...report().actions[0],observedTarget:{tag:'A',href},afterUrl:href}));r.visitedUrls=[official,...urls];
 assert.equal(observedBookingSourceCandidates(r,official).length,32);
});
