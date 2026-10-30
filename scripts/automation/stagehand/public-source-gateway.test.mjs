import test from 'node:test';
import assert from 'node:assert/strict';
import { isWhooshClubGateway, isEzLinksLegacyGateway, isPublicSourceGateway, isCpsLegacyGateway, isForeupPublicBookingDocument, isCpsPublicSearchDocument } from './public-source-gateway.mjs';
import { validateStagehandSourceProposal } from '../course-discovery-stagehand-source.mjs';
import { prepareReadOnlyAction, sourceRoutingUniqueWitness } from './driver.mjs';

test('a public CPS legacy bookmark must navigate to an observed current tenant',()=>{
 const entry='https://secure.east.prophetservices.com/PublicCourse';
 assert.equal(isCpsLegacyGateway(entry),true);assert.equal(isPublicSourceGateway(entry),true);
 assert.throws(()=>validateStagehandSourceProposal({schemaVersion:1,kind:'EXISTING_ADAPTER_SOURCE',bookingUrl:entry}),/STAGEHAND_SOURCE_PROPOSAL_INVALID/u);
 for(const url of[entry+'?slot=1',entry+'#selected',entry+'/checkout',entry.replace('https:','http:'),entry.replace('.com/','.com.evil.example/'),entry.replace('PublicCourse','account'),entry.replace('PublicCourse','member-only')])assert.equal(isCpsLegacyGateway(url),false,url);
});
test('Reserve a Tee Time is read-only navigation only for exact public ForeUP bootstraps',()=>{
 const currentPageUrl='https://official.example/',action={method:'click',selector:'a',arguments:[]};
 const href='https://foreupsoftware.com/index.php/booking/index/19339#/';
 const evidence={tag:'A',visible:true,inForm:false,text:'Reserve a Tee Time',label:'',href,formAction:'',rowText:'',type:'',name:'',id:'',navigation:{pageUrl:currentPageUrl,rawHref:href,captionComplete:true,inlineHandler:false,download:false,role:'',ariaDisabled:false}};
 assert.equal(isForeupPublicBookingDocument(href),true);assert.equal(isPublicSourceGateway(href),false);
 assert.equal(prepareReadOnlyAction(action,evidence,{sourceRoutingOnly:true,currentPageUrl}),action);
 const landing={...evidence,href:currentPageUrl+'tee-time-reservations/',navigation:{...evidence.navigation,rawHref:'/tee-time-reservations/'}};
 assert.equal(prepareReadOnlyAction(action,landing,{sourceRoutingOnly:true,currentPageUrl}),action);
 for(const path of['tee-time-reservations/?slot=1','tee-time-reservations/123','reservation/123','members/tee-time-reservations/'])assert.throws(()=>prepareReadOnlyAction(action,{...landing,href:currentPageUrl+path,navigation:{...landing.navigation,rawHref:'/'+path}},{sourceRoutingOnly:true,currentPageUrl}),/ACTION_TARGET_REJECTED/u);
 assert.throws(()=>prepareReadOnlyAction(action,evidence,{currentPageUrl}),/ACTION_TARGET_REJECTED/u);
 for(const delta of[{inForm:true},{visible:false},{rowText:'10:30 AM selected tee time'},{text:'Reserve and pay'},{formAction:href},{navigation:{...evidence.navigation,inlineHandler:true}}])assert.throws(()=>prepareReadOnlyAction(action,{...evidence,...delta},{sourceRoutingOnly:true,currentPageUrl}),/ACTION_TARGET_REJECTED/u);
 for(const url of[href+'?slot=1',href.replace('#/','#/login'),href.replace('/index/19339','/index/19339/123'),href.replace('foreupsoftware.com','foreupsoftware.com.evil.example'),href.replace('19339','2147483648')])assert.equal(isForeupPublicBookingDocument(url),false,url);
});
test('CPS document choices remain exact current-document witnesses',()=>{
 const pageUrl='https://public-course.cps.golf/',now=Date.now(),witness={kind:'NATIVE_UNIQUE_SUPPORTED_SOURCE',family:'CPS',via:'DOCUMENT',url:pageUrl,pageUrl,observedAt:new Date(now).toISOString(),documentHash:'a'.repeat(64)},scope={pageUrl,startedAt:now-1,deadline:now+1000,now};
 assert.equal(isCpsPublicSearchDocument(pageUrl),true);assert.equal(sourceRoutingUniqueWitness(witness,scope),witness);
 for(const patch of[{family:'EZLINKS'},{url:pageUrl+'?date=2026-11-02'},{url:'https://admin.cps.golf/'},{url:pageUrl+'checkout'}])assert.throws(()=>sourceRoutingUniqueWitness({...witness,...patch},scope),/STAGEHAND_NATIVE_HOST_INVALID/u);
 assert.equal(sourceRoutingUniqueWitness(witness,{...scope,pageUrl:'https://other.example/'}),null);
});

const gateway = "https://app.whoosh.io/patron/club/golfer's-lounge";
test('legacy public tenant entries require observed navigation to the current provider',()=>{
 const entry='https://public-course.ezlinks.com/';
 assert.equal(isEzLinksLegacyGateway(entry),true);assert.equal(isPublicSourceGateway(entry),true);
 assert.throws(()=>validateStagehandSourceProposal({schemaVersion:1,kind:'EXISTING_ADAPTER_SOURCE',bookingUrl:entry}),/STAGEHAND_SOURCE_PROPOSAL_INVALID/u);
 const current='https://public-course.ezlinksgolf.com/search';assert.equal(isPublicSourceGateway(current),false);
 assert.equal(validateStagehandSourceProposal({schemaVersion:1,kind:'EXISTING_ADAPTER_SOURCE',bookingUrl:current}).bookingUrl,current);
 for(const value of[entry+'search',entry+'?date=2030-01-01',entry+'#date',entry.replace('https:','http:'),entry.replace('.com/','.com.evil.example/'),entry.replace('public-course','admin'),entry.replace('public-course','member-course'),entry.replace('public-course','person@public-course'),entry.replace('.com/','.com:444/'),entry.replace('.com/','.com./'),entry.slice(0,-1)])assert.equal(isEzLinksLegacyGateway(value),false,value);
});
test('a Whoosh club gateway is routing only, including an encoded apostrophe', () => {
  for (const value of [gateway, gateway+'/', gateway.replace("'", '%27')]) {
    assert.equal(isWhooshClubGateway(value), true);
    assert.throws(() => validateStagehandSourceProposal({schemaVersion:1,kind:'EXISTING_ADAPTER_SOURCE',bookingUrl:value}), /STAGEHAND_SOURCE_PROPOSAL_INVALID/u);
  }
  const terminal = gateway+'/agenda/simulators/2030-10-23';
  assert.equal(isWhooshClubGateway(terminal), false);
  assert.equal(validateStagehandSourceProposal({schemaVersion:1,kind:'EXISTING_ADAPTER_SOURCE',bookingUrl:terminal}).bookingUrl, terminal);
});
test('gateway recognition grants no query, credentials, foreign host or decoded path', () => {
  for (const value of [gateway+'?date=2030-10-23',gateway+'#calendar',gateway.replace('https:','http:'),
    gateway.replace('app.whoosh.io','app.whoosh.io.evil.example'),gateway.replace('app.whoosh.io','person@app.whoosh.io'),
    gateway.replace("'",'%2527'),gateway.replace("'",'%2f'),gateway.replace("'",'%0a')]) assert.equal(isWhooshClubGateway(value), false);
});
test('only a fresh visible source-only Reserve anchor may open the provider gateway', () => {
  const currentPageUrl='https://official.example/',action={method:'click',selector:'a',arguments:[]};
  const evidence={tag:'A',visible:true,inForm:false,text:'Reserve a Bay',label:'',href:gateway,formAction:'',rowText:'',type:'',name:'',id:'',
    navigation:{pageUrl:currentPageUrl,rawHref:gateway,captionComplete:true,inlineHandler:false,download:false,role:'',ariaDisabled:false}};
  assert.equal(prepareReadOnlyAction(action,evidence,{sourceRoutingOnly:true,currentPageUrl}),action);
  assert.throws(()=>prepareReadOnlyAction(action,evidence,{currentPageUrl}),/ACTION_TARGET_REJECTED/u);
  for(const delta of [{visible:false},{inForm:true},{rowText:'10:30 AM simulator'},{text:'Reserve and pay'},
    {formAction:gateway},{navigation:{...evidence.navigation,inlineHandler:true}},
    {navigation:{...evidence.navigation,rawHref:gateway+'/checkout'}},
    {href:gateway+'/agenda/simulators/2030-10-23'},{href:gateway+'?slot=1'}])
    assert.throws(()=>prepareReadOnlyAction(action,{...evidence,...delta},{sourceRoutingOnly:true,currentPageUrl}),/ACTION_TARGET_REJECTED/u);
});
