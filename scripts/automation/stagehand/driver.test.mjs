import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { prepareReadOnlyAction, readNativeActionTarget, assertNativeSelectReadback, isPublicFilterSelect, assertPublicUrl, settleNativeLinkNavigation, loadStagehandRuntime, validateOwnedBrowserConnection, openStagehandSession } from './driver.mjs';
import { createStagehandCodexModel } from './codex-model.mjs';

const select = { tag: 'SELECT', type: '', visible: true, disabled: false, multiple: false, name: 'optStartTime', id: '', label: '',
  fieldLabel: 'Start time', href: '', formAction: '', text: '5:00 am 10:00 am 8:00 pm', rowText: '',
  options: [{ value: '5:00:00 AM', label: '5:00\u00a0am', disabled: false }, { value: '10:00:00 AM', label: '10:00\u00a0am', disabled: false }, { value: '8:00:00 PM', label: '8:00\u00a0pm', disabled: false }] };
const action = { method: 'selectOptionFromDropdown', selector: 'select', arguments: ['10:00 am'] };

test('installed SDK resolves as exact4.3.0 ESM without launching browser/model',async()=>{const sdk=await loadStagehandRuntime();assert.equal(typeof sdk.Stagehand.create,'function');assert.equal(typeof sdk.localBrowser.launch,'function');});
test('unguarded or remote endpoint cannot create a browser/model or fall back to SDK launch',async()=>{
 await assert.rejects(openStagehandSession({model:'gpt-6.1-sol',deadline:Date.now()+1000}),/GUARDED_BROWSER_REQUIRED/);
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:'owned-target',assertGuardedTargets:async()=>true,beforeAction:async()=>{},prepareNavigation:async()=>{},close:async()=>({browserClosed:true})};
 assert.equal(validateOwnedBrowserConnection(owned),owned);
 for(const cdpUrl of['https://remote.example/','http://user:secret@127.0.0.1:12345/','http://127.0.0.1:12345/?token=secret'])assert.throws(()=>validateOwnedBrowserConnection({...owned,cdpUrl}),/GUARDED_BROWSER_REQUIRED/);
});
for(const sourceRoutingOnly of [false,true])test(`all SDK operations bind the exact guarded page; source body scope=${sourceRoutingOnly}`,async()=>{
 const calls=[], initialUrl='https://owned.example/', destination='https://owned.example/public';
 const bodyLocator={selector:'body',pageId:'exact-target'};
 const page={pageId:'exact-target',locator:selector=>{assert.equal(selector,'body');return bodyLocator;},url:async()=>initialUrl,goto:async value=>{calls.push(['goto',value]);},snapshot:async()=>({url:initialUrl}),evaluate:async()=>({})};
 const other={pageId:'other-guarded-page',url:async()=>'https://other.example/'};
 const browser={closed:false,context:{pages:async()=>[page,other],activePage:async()=>{throw Error('ACTIVE_FALLBACK');},setActivePage:async()=>{throw Error('UI_ACTIVATION');}},close:async()=>{browser.closed=true;}};
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:page.pageId,
  assertGuardedTargets:async ids=>ids.length===2&&ids.includes(page.pageId)&&ids.includes(other.pageId),
  prepareNavigation:async value=>{calls.push(['prepare',value]);},beforeAction:async(id,href)=>{calls.push(['before',id,href]);},close:async()=>({browserClosed:true})};
 const operation=(name)=>(...args)=>{assert.equal(args.at(-1).page,page);assert.equal(args.at(-1).locator,sourceRoutingOnly&&name!=='act'?bodyLocator:undefined);calls.push([name]);return {data:{success:true}};};
 const stagehand={extract:operation('extract'),observe:operation('observe'),act:operation('act'),metrics:async()=>({}),close:async()=>{}};
 const session=await openStagehandSession({deadline:Date.now()+10000,modelDisabled:true,sourceRoutingOnly,ownedBrowser:owned},{loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>stagehand}})});
 assert.equal(session.page,page);await session.goto(destination);await session.snapshot();await session.extract('Read',{});await session.observe('Read');
 page.goto=async()=>{throw Error('net::ERR_NAME_NOT_RESOLVED https://private.example/?token=SECRET');};
 await assert.rejects(session.goto(destination),error=>error.stagehandPhase==='OPEN'&&error.stagehandNavigation?.navigationCode==='ERR_NAME_NOT_RESOLVED'&&!JSON.stringify(error.stagehandNavigation).includes('SECRET'));
 await session.act({method:'hover',selector:'a',arguments:[]});assert.equal(session.page,page);
 stagehand.extract=async()=>{throw Error('PRIVATE_SDK_RPC_ERROR');};
 await assert.rejects(session.extract('Read',{}),error=>error.stagehandPhase==='EXTRACT');
 assert.deepEqual(calls.filter(row=>row[0]==='before'),[['before','exact-target',undefined]]);
 assert.deepEqual(await session.close(),{browserClosed:true,modelClosed:true});
 await assert.rejects(openStagehandSession({deadline:Date.now()+10000,modelDisabled:true,ownedBrowser:{...owned,targetId:'absent'}},
  {loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>stagehand}})}),/GUARDED_TARGET_MISSING/);
});
test('permitted link completion observes actual delayed popup, excludes preexisting tabs, and invents no navigation',async()=>{
 let time=1000,samples=0;const original={pageId:'original',url:async()=>'https://public.example/'},existing={pageId:'old-other',url:async()=>'https://unrelated.example/'},popup={pageId:'new',url:async()=>samples<3?'about:blank':'https://booking.example/landing'};
 const browser={context:{pages:async()=>{samples++;return samples===1?[original,existing]:[original,existing,popup];}}};
 const r=await settleNativeLinkNavigation({browser,page:original,initialPageIds:['original','old-other'],initialUrl:'https://public.example/',deadline:4000,now:()=>time,sleep:async ms=>{time+=ms;}});
 assert.equal(r.page,popup);assert.equal(r.changed,true);assert.ok(r.samples>=3);assert.ok(r.waitedMs>0);
});

for(const sourceRoutingOnly of[false,true])test(`private native witness is emitted before SDK act only in source mode=${sourceRoutingOnly}`,async()=>{
 const order=[];let current='https://owned.example/';const destination='https://public-provider.example/start';
 const witness={kind:'NATIVE_VISIBLE_DOM',pageUrl:current,observedAt:new Date().toISOString(),documentHash:'a'.repeat(64),links:[{href:destination,visible:true}]};
 const page={pageId:'exact-owned',url:async()=>current,evaluate:async()=>({tag:'A',visible:true,inForm:false,text:'Public availability',label:'',href:destination,formAction:'',rowText:''})};
 const browser={context:{pages:async()=>[page]},close:async()=>{}};
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:page.pageId,assertGuardedTargets:async()=>true,
  prepareNavigation:async()=>{},beforeAction:async(id,href)=>{assert.equal(id,page.pageId);assert.equal(href,destination);order.push('native');return witness;},close:async()=>({browserClosed:true})};
 const session=await openStagehandSession({deadline:Date.now()+5000,modelDisabled:true,sourceRoutingOnly,ownedBrowser:owned,
  onNativeSourceWitness:value=>{assert.deepEqual(value,witness);order.push('witness');}},
  {loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>({act:async()=>{order.push('SDK');current=destination;return{data:{success:true}};},close:async()=>{}})}})});
 await session.act({method:'click',selector:'a',arguments:[]});
 assert.deepEqual(order,sourceRoutingOnly?['native','witness','SDK']:['native','SDK']);await session.close();
});

test('rejected private witness aborts before SDK action without using model-supplied evidence',async()=>{
 let sdkCalls=0;const page={pageId:'owned',url:async()=>'https://owned.example/',evaluate:async()=>({tag:'A',visible:true,inForm:false,text:'Public availability',href:'https://public-provider.example/start',rowText:''})};
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:page.pageId,assertGuardedTargets:async()=>true,prepareNavigation:async()=>{},beforeAction:async()=>({forged:true}),close:async()=>({browserClosed:true})};
 const session=await openStagehandSession({deadline:Date.now()+5000,modelDisabled:true,sourceRoutingOnly:true,ownedBrowser:owned,onNativeSourceWitness:()=>{throw Error('STAGEHAND_SOURCE_OUTPUT_INVALID');}},
  {loadRuntime:async()=>({localBrowser:{connect:async()=>({context:{pages:async()=>[page]},close:async()=>{}})},Stagehand:{create:async()=>({act:async()=>{sdkCalls++;},close:async()=>{}})}})});
 await assert.rejects(session.act({method:'click',selector:'a',arguments:[],nativeWitness:{forged:true}}),/STAGEHAND_SOURCE_OUTPUT_INVALID/);
 assert.equal(sdkCalls,0);await session.close();
});
test('appointment actions and private navigation fail closed before native SDK action',()=>{
 for(const value of['https://public.example/ASP/appt_req.asp','https://public.example/ASP/%61ppt_req.asp','https://public.example/ASP/x/../appt_req.asp','https://public.example/account/login','https://public.example/?token=private'])assert.throws(()=>assertPublicUrl(value));
 assert.equal(assertPublicUrl('https://public.example/public-booking?venue=public'),'https://public.example/public-booking?venue=public');
});
test('native public filter maps exact normalized whitespace/case label to actual observed value', () => {
  for (const input of ['10:00 am', ' 10:00\u00a0AM ', '10:00:00 am']) {
    const prepared = prepareReadOnlyAction({ ...action, arguments: [input] }, select);
    assert.equal(prepared.arguments[0], '10:00:00 AM');
    assertNativeSelectReadback(prepared, { value: '10:00:00 AM' });
    assert.throws(() => assertNativeSelectReadback(prepared, { value: '5:00:00 AM' }), /POSTCONDITION_FAILED/u);
  }
});
test('ambiguous, disabled, missing and fuzzy options fail closed', () => {
  for (const options of [[...select.options, { value: 'duplicate', label: '10:00 AM' }],
    select.options.map(option => ({ ...option, disabled: true })), [{ value: '/checkout', label: '10:00 am' }],
    [{ value: 'same', label: '9:00 am' }, { value: 'same', label: '10:00 am' }], []])
    assert.throws(() => prepareReadOnlyAction(action, { ...select, options }), /POSTCONDITION_FAILED/u);
  assert.throws(() => prepareReadOnlyAction({ ...action, arguments: ['10 am'] }, select), /POSTCONDITION_FAILED/u);
});
test('keyboard recovery only exempts the actual nontransaction public filter SELECT', () => {
  const press = { method: 'press', arguments: ['Home'] };
  assert.equal(prepareReadOnlyAction(press, select), press);
  for (const delta of [{ tag: 'BUTTON' }, { name: 'choice', fieldLabel: '' }, { formAction: '/checkout' },
    { name: 'accountTime' }, { rowText: '10:00 AM Tee time Book' }, { disabled: true }, { visible: false }]) {
    assert.equal(isPublicFilterSelect({ ...select, ...delta }), false);
    assert.throws(() => prepareReadOnlyAction(press, { ...select, ...delta }), /ACTION_TARGET_REJECTED/u);
  }
});
test('ordinary booking/slot click and credential guards remain active', () => {
  for (const evidence of [{ ...select, tag: 'BUTTON', text: '10:30 AM' }, { ...select, tag: 'A', text: 'Book', rowText: '10:30 AM' },
    { ...select, tag: 'INPUT', type: 'password' }, { ...select, text: 'Reserve now' }])
    assert.throws(() => prepareReadOnlyAction({ method: 'click', arguments: [] }, evidence), /ACTION_TARGET_REJECTED/u);
});

test('source-only Reserve exception requires the actual visible root anchor and leaves full mode unchanged',()=>{
 const click={method:'click',arguments:[]};
 const root={tag:'A',visible:true,inForm:false,text:'Reserve tee times',label:'Reserve',href:'https://public-provider.example/',formAction:'',rowText:'',type:'',name:'',id:''};
 assert.equal(prepareReadOnlyAction(click,root,{sourceRoutingOnly:true}),click);
 assert.throws(()=>prepareReadOnlyAction(click,root),/ACTION_TARGET_REJECTED/);
 for(const delta of[{tag:'BUTTON'},{visible:false},{inForm:true},{inForm:undefined},{formAction:'/public'},
  {href:'https://public-provider.example/?date=2026-11-01'},{href:'https://public-provider.example/#calendar'},
  {href:'https://public-provider.example/availability'},{href:'https://user:secret@public-provider.example/'},
  {href:'https://reserve.example/'},{href:'javascript:void(0)'},{text:'Reserve checkout'},{label:'Sign in'},
  {text:'Reserve payment'},{label:'Contact us'},{text:'Reserve 10:30 AM'},{rowText:'10:30 AM public round'},
  {type:'password'},{name:'username'},{text:'Reserve hold'}])
  assert.throws(()=>prepareReadOnlyAction(click,{...root,...delta},{sourceRoutingOnly:true}),/ACTION_TARGET_REJECTED/,JSON.stringify(delta));
 assert.throws(()=>prepareReadOnlyAction({...click,method:'press'},root,{sourceRoutingOnly:true}),/ACTION_TARGET_REJECTED/);
});

test('source-only public availability entry requires same-current native anchor proof for a nonroot document',()=>{
 const click={method:'click',arguments:[]},currentPageUrl='https://official.example/';
 const entry={tag:'A',visible:true,inForm:false,text:'Reserve Your Bay',label:'',href:'https://official.example/public-entry',formAction:'',rowText:'',type:'',name:'',id:'',
  navigation:{pageUrl:currentPageUrl,rawHref:'/public-entry',captionComplete:true,inlineHandler:false,download:false,role:'',ariaDisabled:false}};
 assert.equal(prepareReadOnlyAction(click,entry,{sourceRoutingOnly:true,currentPageUrl}),click);
 assert.throws(()=>prepareReadOnlyAction(click,entry),/ACTION_TARGET_REJECTED/);
 assert.throws(()=>prepareReadOnlyAction(click,entry,{sourceRoutingOnly:true}),/ACTION_TARGET_REJECTED/);
 for(const text of ['Reserve Your Simulator','Reserve a Bay','Reserve tee times'])assert.equal(prepareReadOnlyAction(click,{...entry,text},{sourceRoutingOnly:true,currentPageUrl}),click);
 for(const delta of [{tag:'BUTTON'},{visible:false},{inForm:true},{formAction:'/public-search'},{type:'password'},{name:'account'},
  {text:'Reserve ReservationConfirm'},{text:'Reserve now'},{text:'Reserve Your Bay and Pay'},{label:'Confirm reservation'},
  {rowText:'10:30 AM public bay'},{rowText:'10 AM public bay'},{rowText:'Selected reservation'},
  {href:'https://foreign.example/public-entry'},{href:'https://official.example/public-entry?date=2026-11-01'},
  {href:'https://official.example/public-entry#calendar'},{href:'https://user:secret@official.example/public-entry'},
  {href:'https://127.0.0.1/public-entry'},{href:'javascript:void(0)'},{href:'https://official.example/slot/123'},
  {href:'https://official.example/reservationConfirm'},{href:'https://official.example/reservationconfirm'},
  {href:'https://official.example/checkout'},{href:'https://official.example/ASP/appt_req.asp'},
  {href:'https://official.example/%70ublic-entry'}])
  {const native={...entry.navigation};if(delta.href?.startsWith('https://')){const url=new URL(delta.href);native.rawHref=url.pathname+url.search+url.hash;}
   assert.throws(()=>prepareReadOnlyAction(click,{...entry,...delta,navigation:native},{sourceRoutingOnly:true,currentPageUrl}),/ACTION_TARGET_REJECTED/,JSON.stringify(delta));}
 for(const delta of [{pageUrl:'https://official.example/old-document'},{rawHref:'/different'},{rawHref:'/public-entry?token=private'},
  {captionComplete:false},{inlineHandler:true},{download:true},{ariaDisabled:true},{role:'button'},{pageUrl:undefined}])
  assert.throws(()=>prepareReadOnlyAction(click,{...entry,navigation:{...entry.navigation,...delta}},{sourceRoutingOnly:true,currentPageUrl}),/ACTION_TARGET_REJECTED/,JSON.stringify(delta));
 assert.throws(()=>prepareReadOnlyAction({...click,currentPageUrl},entry,{sourceRoutingOnly:true}),/ACTION_TARGET_REJECTED/);
});

test('serialized native anchor collector derives document and navigation safety facts from the actual DOM',()=>{
 class Element {
  constructor(attrs={}){this.attrs=attrs;this.tagName='A';this.id='public-link';this.textContent='Reserve Your Bay';this.isConnected=true;this.parentElement=null;}
  getAttribute(name){return Object.hasOwn(this.attrs,name)?this.attrs[name]:null;}
  hasAttribute(name){return Object.hasOwn(this.attrs,name);}
  getClientRects(){return [{}];}
  closest(selector){return selector==='a[href]'?this:null;}
 }
 class Anchor extends Element {}
 const link=new Anchor({href:'/public-entry'});link.href='https://native.example/public-entry';
 const collect=()=>runInNewContext(`(${readNativeActionTarget.toString()})('a')`,{document:{querySelector:()=>link},location:{href:'https://native.example/'},Element,HTMLAnchorElement:Anchor,HTMLSelectElement:class{},HTMLInputElement:class{},HTMLOptGroupElement:class{},getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})});
 const got=collect();assert.equal(got.navigation.pageUrl,'https://native.example/');assert.equal(got.navigation.rawHref,'/public-entry');assert.equal(got.navigation.captionComplete,true);assert.equal(got.navigation.inlineHandler,false);assert.equal(got.navigation.download,false);assert.equal(got.navigation.ariaDisabled,false);
 link.attrs.onclick='submitReservation()';assert.equal(collect().navigation.inlineHandler,true);delete link.attrs.onclick;
 link.attrs.download='';assert.equal(collect().navigation.download,true);delete link.attrs.download;
 link.textContent='Reserve Your Bay'+' '.repeat(161);assert.equal(collect().navigation.captionComplete,false);
});

test('SDK availability navigation uses private native URL reads and still passes through the owned witness before act',async()=>{
 for(const scenario of ['current','changed-during-read','forged-action-url']){
  let current='https://owned.example/',reads=0,sdkCalls=0,nativeCalls=0;const destination='https://owned.example/public-entry';
  const page={pageId:'owned',url:async()=>{reads++;return scenario==='changed-during-read'&&reads>=2?'https://owned.example/changed':current;},evaluate:async()=>({tag:'A',visible:true,inForm:false,text:'Reserve Your Bay',label:'',href:destination,formAction:'',rowText:'',type:'',name:'',id:'',navigation:{pageUrl:scenario==='forged-action-url'?'https://forged.example/':current,rawHref:'/public-entry',captionComplete:true,inlineHandler:false,download:false,role:'',ariaDisabled:false}})};
  const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:page.pageId,assertGuardedTargets:async()=>true,prepareNavigation:async()=>{},beforeAction:async(id,href)=>{nativeCalls++;assert.equal(id,page.pageId);assert.equal(href,destination);return{kind:'NATIVE_VISIBLE_DOM',pageUrl:current,observedAt:new Date().toISOString(),documentHash:'a'.repeat(64),links:[{href:destination,visible:true}]};},close:async()=>({browserClosed:true})};
  const browser={closed:false,context:{pages:async()=>[page]},close:async()=>{browser.closed=true;}};
  const session=await openStagehandSession({deadline:Date.now()+5000,modelDisabled:true,sourceRoutingOnly:true,ownedBrowser:owned,onNativeSourceWitness:w=>{assert.equal(w.pageUrl,current);}},
   {loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>({act:async()=>{sdkCalls++;assert.equal(nativeCalls,1);current=destination;return{data:{success:true}};},close:async()=>{}})}})});
  const click={method:'click',selector:'a',arguments:[],currentPageUrl:'https://owned.example/'};
  if(scenario==='current'){const result=await session.act(click);assert.equal(result.afterUrl,destination);assert.equal(sdkCalls,1);assert.equal(nativeCalls,1);}
  else {await assert.rejects(session.act(click),/ACTION_TARGET_REJECTED/);assert.equal(sdkCalls,0);assert.equal(nativeCalls,0);}
  assert.deepEqual(await session.close(),{browserClosed:true,modelClosed:true});
 }
});

test('action rejection diagnostics retain only closed matched term, field, tag and href presence',()=>{
 const base={tag:'A',visible:true,inForm:false,text:'Public tee times',label:'',href:'https://public-provider.example/',formAction:'',rowText:'',type:'',name:'',id:''};
 for(const [delta,term,field,tag]of[[{text:'Reserve public tee times'},'RESERVE','TEXT','A'],
  [{href:'https://public-provider.example/checkout?secret=PRIVATE'},'CHECKOUT','HREF','A'],
  [{formAction:'/payment'},'PAYMENT','FORM_ACTION','A'],[{tag:'CUSTOM',label:'Sign in'},'SIGN_IN','LABEL','OTHER']]){
  assert.throws(()=>prepareReadOnlyAction({method:'click',arguments:[]},{...base,...delta}),error=>{
   assert.deepEqual(error.stagehandActionDiagnostic,{guardReason:'TRANSACTION_TEXT',guardTerm:term,guardField:field,guardTag:tag,guardHasHref:true});
   assert.doesNotMatch(JSON.stringify(error.stagehandActionDiagnostic),/PRIVATE|https:|secret|public-provider/);return true;
  });
 }
});

test('exact driver retains inner wrapped model failure only for the failing operation and clears it on later navigation',async()=>{
 let failModel=true,failNavigation=false;
 const page={pageId:'owned',locator:()=>({selector:'body'}),url:async()=>'https://owned.example/',goto:async()=>{if(failNavigation)throw Error('net::ERR_FAILED');}};
 const browser={closed:false,context:{pages:async()=>[page]},close:async()=>{browser.closed=true;}};
 const cdpFailure={layer:'RPC',method:'Target.closeTarget',rpcCode:-32001,lifecycle:'SESSION_NOT_FOUND',pendingRequests:0};
 const nativeFailure={code:'NATIVE_REDIRECT_RESPONSE_TIMEOUT',phase:'RESPONSE_WAIT',method:'GET',resourceType:'script',rootFrame:true};
 const cleanupOrder=[];
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:'owned',assertGuardedTargets:async()=>true,beforeAction:async()=>{},prepareNavigation:async()=>{},
  snapshotFailure:async()=>{throw Error('LEGACY_SNAPSHOT_MUST_NOT_REPLACE_NATIVE');},
  snapshotFailures:async()=>{cleanupOrder.push('snapshot');return{ownedCdpFailure:cdpFailure,nativeRouterFailure:nativeFailure};},close:async()=>{cleanupOrder.push('host');return{browserClosed:true,ownedCdpFailure:{layer:'SOCKET_CLOSE',pendingRequests:0}};}};
 const session=await openStagehandSession({model:'gpt-6.1-sol',deadline:Date.now()+10000,sourceRoutingOnly:true,ownedBrowser:owned},{
  createModel:options=>createStagehandCodexModel({...options,clientFactory:async()=>({generate:async()=>{
   if(failModel)throw Object.assign(Error('SECRET_INNER'),{code:'LOCAL_MODEL_RPC_FAILED',diagnostics:{phase:'turn/start',rpcCode:-32600}});
   return{value:{ok:true},model:'gpt-6.1-sol',effort:'medium',elapsedMs:1,usage:{totalTokens:3}};
  },close:async()=>{cleanupOrder.push('model');return{processExited:true,cleanup:{credentialsRemoved:true}};}})}),
  loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async options=>({
   extract:async()=>{try{return await options.model.generate({messages:[{role:'user',content:{type:'text',text:'Public'}}],responseFormat:{type:'json_schema',schema:{type:'object'}}});}catch{throw Error('PRIVATE_SDK_WRAPPER');}},
   close:async()=>{cleanupOrder.push('SDK');},metrics:async()=>({})})}}),
 });
 await assert.rejects(session.extract('Read',{}),error=>error.stagehandPhase==='EXTRACT');
 assert.deepEqual(session.lastModelFailure,{attempt:1,completedCalls:0,transportCode:'LOCAL_MODEL_RPC_FAILED',transportPhase:'turn/start',rpcCode:-32600,modelRpcCode:-32600});
 const copy=session.lastModelFailure;copy.transportCode='SECRET';assert.equal(session.lastModelFailure.transportCode,'LOCAL_MODEL_RPC_FAILED');
 failNavigation=true;await assert.rejects(session.goto('https://owned.example/'),error=>error.stagehandPhase==='OPEN');assert.equal(session.lastModelFailure,undefined);
 failModel=false;await session.extract('Read',{});assert.equal(session.lastModelFailure,undefined);assert.deepEqual(session.modelCallCounts,{attempted:2,completed:1});
 assert.equal(session.ownedCdpFailure,undefined);assert.deepEqual(await session.close(),{browserClosed:true,modelClosed:true});
 assert.deepEqual(session.ownedCdpFailure,cdpFailure);const cdpCopy=session.ownedCdpFailure;cdpCopy.method='UNKNOWN';assert.equal(session.ownedCdpFailure.method,'Target.closeTarget');
 assert.deepEqual(session.nativeRouterFailure,nativeFailure);const nativeCopy=session.nativeRouterFailure;nativeCopy.code='UNKNOWN';assert.equal(session.nativeRouterFailure.code,'NATIVE_REDIRECT_RESPONSE_TIMEOUT');
 assert.deepEqual(cleanupOrder,['snapshot','model','SDK','host']);
});
