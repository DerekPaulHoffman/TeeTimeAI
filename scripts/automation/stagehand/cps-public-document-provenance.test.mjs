import test from 'node:test';import assert from 'node:assert/strict';
import{observedBookingSourceCandidates,nativeLegacyGatewayLandings}from'./source-provenance.mjs';
const root='https://official.example/',href='https://secure.east.prophetservices.com/PublicCourse',after='https://public-course.cps.golf/';
function fixture(){return{startedAt:'2026-10-30T12:00:00.000Z',finishedAt:'2026-10-30T12:01:00.000Z',visitedUrls:[root,after],initialNavigation:{requestedUrl:root,finalUrl:root,status:200},officialLinkLedger:[
 {kind:'NATIVE_VISIBLE_DOM',pageUrl:root,observedAt:'2026-10-30T12:00:01.000Z',documentHash:'a'.repeat(64),links:[{href,visible:true}]},
 {kind:'NATIVE_VISIBLE_DOM',pageUrl:after,observedAt:'2026-10-30T12:00:03.000Z',documentHash:'b'.repeat(64),links:[]}],
 actions:[{action:{method:'click'},sourceUrl:root,observedTarget:{tag:'A',href,text:'Book a Tee Time',label:''},afterUrl:after,openedNewPage:true}]};}
test('a current CPS document after the exact observed public legacy click is routing only',()=>{
 const r=fixture();assert.equal(nativeLegacyGatewayLandings(r).length,1);
 assert.ok(observedBookingSourceCandidates(r,root,undefined,{sourceDiscoveryOnly:true}).includes(after));
 assert.ok(!observedBookingSourceCandidates(r,root).includes(after));
 assert.equal(r.nativeFrameNavigations,undefined);assert.equal(r.nativeGestureNavigations,undefined);assert.equal(r.nativeHistoryNavigations,undefined);
});
test('an SDK afterUrl without fresh native source and landing documents grants no CPS edge',()=>{
 for(const change of[r=>r.officialLinkLedger.pop(),r=>r.officialLinkLedger[1].documentHash='',r=>r.officialLinkLedger[1].observedAt='2026-10-30T11:59:00.000Z',r=>r.officialLinkLedger[0].links[0].visible=false,r=>r.actions[0].error=true,r=>r.actions[0].observedTarget.label='Member reservations',r=>r.actions[0].observedTarget.href=href+'?slot=1',r=>r.actions[0].afterUrl=after+'checkout']){
  const r=fixture();change(r);assert.equal(nativeLegacyGatewayLandings(r).length,0);assert.ok(!observedBookingSourceCandidates(r,root,undefined,{sourceDiscoveryOnly:true}).includes(after));
 }
});
