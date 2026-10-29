import test from 'node:test';
import assert from 'node:assert/strict';
import { isWhooshClubGateway } from './public-source-gateway.mjs';
import { validateStagehandSourceProposal } from '../course-discovery-stagehand-source.mjs';
import { prepareReadOnlyAction } from './driver.mjs';

const gateway = "https://app.whoosh.io/patron/club/golfer's-lounge";
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
