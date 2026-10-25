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
