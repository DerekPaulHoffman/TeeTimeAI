import test from 'node:test';import assert from 'node:assert/strict';
import{observedBookingSourceCandidates,nativeLegacyGatewayLandings}from'./source-provenance.mjs';
import{createStagehandSourceCheckpoint,readStagehandSourceCheckpoint}from'../course-discovery-stagehand-source.mjs';
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
test('a visible legacy shared-host Acuity bookmark earns only its actual observed calendar landing',()=>{
 const entry='https://app.acuityscheduling.com/schedule.php?owner=12345678',calendar='https://app.acuityscheduling.com/schedule/publiccalendar';
 const make=()=>{const r=fixture();r.visitedUrls=[root,calendar];r.officialLinkLedger[0].links[0].href=entry;r.officialLinkLedger[1].pageUrl=calendar;r.actions[0].observedTarget.href=entry;r.actions[0].afterUrl=calendar;return r;};
 const r=make();r.actions[0].observedTarget.text='Book now ↗';assert.equal(nativeLegacyGatewayLandings(r).length,1);assert.ok(observedBookingSourceCandidates(r,root,undefined,{sourceDiscoveryOnly:true}).includes(calendar));assert.ok(!observedBookingSourceCandidates(r,root).includes(calendar));
 for(const change of[r=>r.officialLinkLedger.pop(),r=>r.officialLinkLedger[0].links[0].visible=false,r=>r.actions[0].error=true,r=>r.actions[0].afterUrl=calendar+'?appointment=1',r=>r.actions[0].afterUrl=calendar.replace('app.acuityscheduling.com','foreign.example'),r=>r.actions[0].observedTarget.href=entry+'&owner=87654321',r=>r.actions[0].observedTarget.text='Reserve and pay',r=>r.officialLinkLedger[1].observedAt='2020-01-01T00:00:00.000Z']){const bad=make();change(bad);assert.equal(nativeLegacyGatewayLandings(bad).length,0);assert.ok(!observedBookingSourceCandidates(bad,root,undefined,{sourceDiscoveryOnly:true}).includes(calendar));}
});
test('an actual new-tab legacy calendar route survives checkpoint projection and its own retry without losing its public caption',()=>{
 const stamp=Date.now(),entry='https://app.acuityscheduling.com/schedule.php?owner=12345678',calendar='https://app.acuityscheduling.com/schedule/publiccalendar';
 const r=fixture();Object.assign(r,{jobId:'legacy-calendar-job',firstPickedUpAt:new Date(stamp-1000).toISOString(),deadlineAt:new Date(stamp+899000).toISOString(),
  startedAt:new Date(stamp-900).toISOString(),finishedAt:new Date(stamp).toISOString(),workDeadlineAt:new Date(stamp+100000).toISOString(),framework:{name:'Stagehand',version:'4.3.0'},
  frameworkMode:'HYBRID_SOURCE_DISCOVERY',frameworkRole:'SOURCE_DISCOVERY_ONLY',frameworkExtractedTimes:false,outcome:'SOURCE_PROPOSED_UNVERIFIED',browserClosed:true,modelClosed:true,
  recipe:null,matchingSlots:[],adapterSourceProposal:{schemaVersion:1,kind:'EXISTING_ADAPTER_SOURCE',bookingUrl:calendar},metrics:{model:'gpt-6.1-sol',reasoningEffort:'medium'}});
 r.visitedUrls=[root,calendar];r.officialLinkLedger[0].links[0].href=entry;r.officialLinkLedger[1].pageUrl=calendar;
 r.officialLinkLedger.forEach((row,i)=>row.observedAt=new Date(stamp-800+i*100).toISOString());
 Object.assign(r.actions[0],{afterUrl:calendar,openedNewPage:true});Object.assign(r.actions[0].observedTarget,{href:entry,text:'Book now ↗'});
 const job={id:r.jobId,attempts:1,sourceFingerprint:'a'.repeat(64),firstPickedUpAt:r.firstPickedUpAt,deadlineAt:r.deadlineAt,request:{identity:{officialUrl:root}}};
 const saved=createStagehandSourceCheckpoint(job,r),resumed=readStagehandSourceCheckpoint({...job,attempts:2,checkpoint:{stagehandSource:saved}},undefined,stamp+1);
 assert.equal(saved.report.actions[0].observedTarget.text,'Book now ↗');assert.equal(saved.report.actions[0].observedTarget.label,'');
 assert.equal(resumed.report.adapterSourceProposal.bookingUrl,calendar);assert.equal(saved.firstPickedUpAt,r.firstPickedUpAt);
 for(const change of [row=>row.actions[0].observedTarget.text='Reserve and pay',row=>row.officialLinkLedger[0].links[0].visible=false,row=>row.officialLinkLedger.pop()]){
  const bad=structuredClone(r);change(bad);assert.throws(()=>createStagehandSourceCheckpoint(job,bad));
 }
});
