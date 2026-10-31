import test from 'node:test';import assert from 'node:assert/strict';
import{observedBookingSourceCandidates,nativeLegacyGatewayLandings}from'./source-provenance.mjs';
const root='https://official.example/',href='https://public-bays.as.me/',after=href+'schedule/owner123';
function fixture(){return{startedAt:'2026-10-30T12:00:00.000Z',finishedAt:'2026-10-30T12:01:00.000Z',visitedUrls:[root,after],initialNavigation:{requestedUrl:root,finalUrl:root,status:200},officialLinkLedger:[
 {kind:'NATIVE_VISIBLE_DOM',pageUrl:root,observedAt:'2026-10-30T12:00:01.000Z',documentHash:'a'.repeat(64),links:[{href,visible:true}]},
 {kind:'NATIVE_VISIBLE_DOM',pageUrl:after,observedAt:'2026-10-30T12:00:03.000Z',documentHash:'b'.repeat(64),links:[]}],
 actions:[{action:{method:'click'},sourceUrl:root,observedTarget:{tag:'A',href,text:'Book Now',label:''},afterUrl:after,openedNewPage:true}]};}
test('an observed same-tenant Acuity landing becomes routing evidence only',()=>{
 const r=fixture();assert.equal(nativeLegacyGatewayLandings(r).length,1);
 assert.ok(observedBookingSourceCandidates(r,root,undefined,{sourceDiscoveryOnly:true}).includes(after));
 assert.ok(!observedBookingSourceCandidates(r,root).includes(after));
});
test('Acuity landing needs fresh native documents, the exact click and same tenant',()=>{
 for(const change of[r=>r.officialLinkLedger.pop(),r=>r.officialLinkLedger[1].documentHash='',r=>r.officialLinkLedger[1].observedAt='2026-10-30T11:59:00.000Z',r=>r.officialLinkLedger[0].links[0].visible=false,r=>r.actions[0].error=true,r=>r.actions[0].observedTarget.label='Member reservations',r=>r.actions[0].observedTarget.text='Reserve and pay',r=>r.actions[0].observedTarget.href=href+'?appointment=1',r=>r.actions[0].afterUrl=after+'?appointment=1',r=>r.actions[0].afterUrl=after.replace('public-bays','other-bays')]){
  const r=fixture();change(r);assert.equal(nativeLegacyGatewayLandings(r).length,0);assert.ok(!observedBookingSourceCandidates(r,root,undefined,{sourceDiscoveryOnly:true}).includes(after));
 }
});
