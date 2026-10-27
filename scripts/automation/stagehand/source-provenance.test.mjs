import test from'node:test';import assert from'node:assert/strict';
import{observedBookingSourceCandidates,nativeLinkSource,corroboratedNativeLink}from'./source-provenance.mjs';
const official='https://course.example/',source='https://provider.example/start?tenant=public',landing='https://provider.example/loading';
const candidate=r=>observedBookingSourceCandidates(r,official,undefined,{sourceDiscoveryOnly:true});
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
