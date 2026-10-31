import test from 'node:test';

for(const mode of ['valid','label-only','missing','changed-current'])test('placeholder JS driver requires completed private native source: '+mode,async()=>{
 const initial='https://official.example/',destination='https://provider.example/services';let current=initial;const order=[];
  const placeholderText=mode==='label-only'?'':'Book Bay',placeholderLabel=mode==='label-only'?'Book Bay':'';
  const prepared={kind:'NATIVE_VISIBLE_DOM',pageUrl:initial,observedAt:new Date().toISOString(),documentHash:'a'.repeat(64),links:[{href:initial+'#',visible:true,text:placeholderText,label:placeholderLabel}]};
 const completed={kind:'NATIVE_GESTURE_SOURCE_OPEN',pageUrl:initial,href:initial+'#',observedAt:prepared.observedAt,documentHash:prepared.documentHash,targetUrl:destination,finalUrl:destination,finalStatus:200,completedAt:new Date().toISOString(),finalDocumentHash:'b'.repeat(64),redirects:[]};
   const page={pageId:'owned',url:async()=>current,evaluate:async()=>({tag:'A',visible:true,inForm:false,text:placeholderText,label:placeholderLabel,href:initial+'#',formAction:'',rowText:'',navigation:{pageUrl:initial,rawHref:'#',captionComplete:true,inlineHandler:false,download:false,role:'',target:'',ariaDisabled:false}}),
   locator:selector=>{assert.equal(selector,'a');return{click:async options=>{assert.ok(options.timeout>0&&options.timeout<=4000);order.push('DIRECT_CLICK');current=destination;}};}};
 const browser={context:{pages:async()=>[page]},close:async()=>{}};
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:'owned',assertGuardedTargets:async()=>true,prepareNavigation:async()=>{},
   beforeAction:async()=>{order.push('BEFORE');return prepared;},
  observeSourceReadiness:async()=>{order.push('CURRENT_200');return{readyState:'complete',bodyPresent:true,mainDocumentCurrent:true,mainDocumentComplete:true,mainReadPending:false,pendingReads:0,mainDocumentStatus:200};},
  completeGestureNavigation:async()=>{order.push('COMPLETED');if(mode==='changed-current')current=destination+'/changed';return mode==='missing'?null:completed;},close:async()=>({browserClosed:true,providerRequestsDrained:true})};
 const session=await openStagehandSession({deadline:Date.now()+5000,modelDisabled:true,sourceRoutingOnly:true,ownedBrowser:owned,onNativeSourceWitness:()=>order.push('PREPARED_WITNESS')},
   {createNativePointer:async()=>({click:async({selector})=>page.locator(selector).click({timeout:4000}),close:async()=>{}}),loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>({act:async()=>{throw Error('SECOND_ACTION_MODEL_CALL');},close:async()=>{}})}})});
 try{const result=session.act({method:'click',selector:'a',arguments:[]});if(mode==='valid'||mode==='label-only'){assert.deepEqual((await result).nativeGestureNavigation,completed);}else await assert.rejects(result,/STAGEHAND_SOURCE_OUTPUT_INVALID/u);
  assert.deepEqual(order,['BEFORE','PREPARED_WITNESS','DIRECT_CLICK','CURRENT_200','COMPLETED']);assert.equal(session.disabledModelCalls,0);}finally{await session.close();}
});
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { prepareReadOnlyAction, readNativeActionTarget, assertNativeSelectReadback, isPublicFilterSelect, assertPublicUrl, settleNativeLinkNavigation, loadStagehandRuntime, validateOwnedBrowserConnection, openStagehandSession } from './driver.mjs';
import { createStagehandCodexModel } from './codex-model.mjs';

const cleanupDeferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const flushCleanup=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
async function cleanupSession({deadline,signal,finish,launcher,receipt={browserClosed:true,providerRequestsDrained:true}}){
 let hostCalls=0,browserCalls=0;
 const page={pageId:'owned'},browser={closed:false,context:{pages:async()=>[page]},close:async()=>{browserCalls++;browser.closed=true;}};
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:'owned',assertGuardedTargets:async()=>true,beforeAction:async()=>{},prepareNavigation:async()=>{},
  close:async()=>{hostCalls++;await finish.promise;await launcher.promise;return receipt;}};
 const session=await openStagehandSession({deadline,signal,modelDisabled:true,sourceRoutingOnly:true,ownedBrowser:owned},{loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>({close:async()=>{}})}})});
 return{session,hostCalls:()=>hostCalls,browserCalls:()=>browserCalls};
}
test('cleanup awaits one native finish and launcher drain beyond four seconds without replacing either acknowledgement',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_900_000_000_000});
 const finish=cleanupDeferred(),launcher=cleanupDeferred(),f=await cleanupSession({deadline:Date.now()+60000,finish,launcher});
 let settled=false;const first=f.session.close(),pending=first.then(value=>{settled=true;return value;});const same=f.session.close();assert.equal(same,first);await flushCleanup();
 t.mock.timers.tick(5000);await flushCleanup();assert.equal(settled,false);assert.equal(f.hostCalls(),1);assert.equal(f.browserCalls(),1);
 finish.resolve();await flushCleanup();t.mock.timers.tick(5000);await flushCleanup();assert.equal(settled,false);launcher.resolve();assert.deepEqual(await pending,{browserClosed:true,modelClosed:true});assert.deepEqual(await same,{browserClosed:true,modelClosed:true});
});
test('cleanup rejects closure claims without the native receipt or successful launcher drain',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_900_000_000_000});
 for(const mode of ['finish-rejected','launcher-rejected','native-false']){
  const finish=cleanupDeferred(),launcher=cleanupDeferred(),f=await cleanupSession({deadline:Date.now()+60000,finish,launcher,receipt:{browserClosed:mode!=='native-false',providerRequestsDrained:mode!=='native-false'}});
  const pending=f.session.close();await flushCleanup();if(mode==='finish-rejected')finish.reject(Error('native finish failed'));else finish.resolve();await flushCleanup();if(mode==='launcher-rejected')launcher.reject(Error('launcher drain failed'));else launcher.resolve();
  assert.deepEqual(await pending,{browserClosed:false,modelClosed:true});
 }
});
test('cleanup timeout remains within its fixed host bound and cannot promote a late native receipt',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_900_000_000_000});
 const finish=cleanupDeferred(),launcher=cleanupDeferred(),f=await cleanupSession({deadline:Date.now()+60000,finish,launcher});let settled=false;
 const pending=f.session.close().then(value=>{settled=true;return value;});await flushCleanup();t.mock.timers.tick(35001);await flushCleanup();assert.equal(settled,true);assert.deepEqual(await pending,{browserClosed:false,modelClosed:true});
 finish.resolve();launcher.resolve();await flushCleanup();assert.deepEqual(await f.session.close(),{browserClosed:false,modelClosed:true});assert.equal(f.hostCalls(),1);
});
test('cleanup cannot extend the original source deadline or gain success from an aborted wait',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_900_000_000_000});
 for(const mode of ['deadline','abort','expired-before-close']){
  const controller=new AbortController(),finish=cleanupDeferred(),launcher=cleanupDeferred(),deadline=Date.now()+3000,f=await cleanupSession({deadline,signal:controller.signal,finish,launcher});
  if(mode==='expired-before-close')t.mock.timers.tick(3001);
  const pending=f.session.close();await flushCleanup();if(mode==='abort')controller.abort();t.mock.timers.tick(3001);await flushCleanup();assert.deepEqual(await pending,{browserClosed:false,modelClosed:true});assert.equal(f.hostCalls(),1);assert.equal(f.browserCalls(),1);
  finish.resolve();launcher.resolve();await flushCleanup();assert.deepEqual(await f.session.close(),{browserClosed:false,modelClosed:true});
 }
});

test('404 completed current native document is an immediate distinct negative, never settled200',async()=>{
 const {settleSourceDocument,sourceDocumentSettled}=await import('./driver.mjs');
 const complete={bodyPresent:true,mainDocumentCurrent:true,mainDocumentComplete:true,mainReadPending:false,readyState:'complete',mainDocumentStatus:404,pendingReads:0};let reads=0;
 assert.equal(sourceDocumentSettled(complete),false);
 await assert.rejects(settleSourceDocument(async()=>{reads++;return complete;},{deadline:100,now:()=>0,sleep:async()=>{throw Error('404_MUST_NOT_WAIT');}}),error=>error.message==='STAGEHAND_SOURCE_NOT_FOUND'&&error.stagehandDocumentReadiness.mainDocumentStatus===404);
 assert.equal(reads,1);
});

test('404 recovery rechecks original owned target/current read and uses one exact originalroot GET boundary',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const root='https://owned.example/',failed=root+'missing',done={bodyPresent:true,mainDocumentCurrent:true,mainDocumentComplete:true,mainReadPending:false,readyState:'complete',mainDocumentStatus:404,pendingReads:0};
 for(const mode of ['valid','popup','changed','pending','incomplete','noBody','loading','fatal','host','cdp','aborted','expired','status401','status403','status429','status500','foreign-root']){
  let current=root,status=200,fault={},reads=0;const calls=[],controller=new AbortController();
  const page={pageId:'owned',url:async()=>current,goto:async value=>{calls.push(['goto',value]);current=value;status=200;return{status:()=>200};}};
  const browser={context:{pages:async()=>[page]},close:async()=>{}},owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:'owned',assertGuardedTargets:async()=>true,beforeAction:async()=>{},prepareNavigation:async value=>calls.push(['prepare',value]),snapshotFailures:async()=>fault,observeSourceReadiness:async()=>{reads++;if(mode==='changed'&&reads===2)current=root+'changed';return{...done,mainDocumentStatus:mode.startsWith('status')?Number(mode.slice(6)):status,mainReadPending:mode==='pending',mainDocumentComplete:mode!=='incomplete',bodyPresent:mode!=='noBody',readyState:mode==='loading'?'loading':'complete'};},close:async()=>({browserClosed:true})};
  const session=await openStagehandSession({deadline:Date.now()+10000,signal:controller.signal,modelDisabled:true,sourceRoutingOnly:true,ownedBrowser:owned},{loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>({close:async()=>{}})}})});
  await session.goto(root);calls.length=0;current=failed;status=404;if(mode==='popup')page.pageId='popup';if(mode==='fatal')fault={nativeRouterFailure:{code:'NATIVE_REDIRECT_ROUTING_FAILED'}};if(mode==='host')fault={hostGuardFailure:{stage:'SOURCE_DOM',reason:'DOM_URL_CHANGED'}};if(mode==='cdp')fault={ownedCdpFailure:{code:'OWNED_CDP_CLOSED'}};if(mode==='aborted')controller.abort();if(mode==='expired')t.mock.timers.tick(10001);
  if(mode==='valid'){const result=await session.recoverSourceNotFound(root,failed);assert.equal(result.failedUrl,failed);assert.equal(result.status,404);assert.equal(result.recoveredTo,root);assert.deepEqual(calls,[['prepare',root],['goto',root]]);await assert.rejects(session.recoverSourceNotFound(root,failed));}
  else{await assert.rejects(session.recoverSourceNotFound(mode==='foreign-root'?'https://foreign.example/':root,failed));assert.equal(calls.filter(row=>row[0]==='goto').length,0);}
  await session.close();
 }
});

test('404 recovery retains historical RPC facts but still rejects every current failure and other CDP layer',async()=>{
 const root='https://owned.example/',failed=root+'missing',rpc={layer:'RPC',method:'Fetch.failRequest',rpcCode:-32602,lifecycle:'UNKNOWN',pendingRequests:13};
 for(const mode of ['historical','current-read','attestation','native','host','drift','SOCKET_CLOSE','SOCKET_ERROR','PROTOCOL','TIMEOUT','SEND','ABORT']){
  let current=root,status=200,reads=0,attested=true;const calls=[],currentError=Error('OWNED_STAGEHAND_CDP_UNAVAILABLE');
  const fault={ownedCdpFailure:mode===mode.toUpperCase()?{layer:mode,pendingRequests:0}:rpc,
   ...(mode==='native'?{nativeRouterFailure:{code:'NATIVE_REDIRECT_ROUTING_FAILED'}}:{}),
   ...(mode==='host'?{hostGuardFailure:{stage:'SOURCE_DOM',reason:'DOM_URL_CHANGED'}}:{})};
  const page={pageId:'owned',url:async()=>current,goto:async url=>{calls.push(['goto',url]);current=url;status=200;}};
  const browser={context:{pages:async()=>[page]},close:async()=>{}};
  const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:'owned',assertGuardedTargets:async()=>attested,beforeAction:async()=>{},
   prepareNavigation:async url=>calls.push(['prepare',url]),snapshotFailures:async()=>fault,
   observeSourceReadiness:async()=>{reads++;if(mode==='current-read'&&reads===2)throw currentError;if(mode==='drift'&&reads===2)current=root+'different';
    return{bodyPresent:true,mainDocumentCurrent:true,mainDocumentComplete:true,mainReadPending:false,readyState:'complete',mainDocumentStatus:status,pendingReads:57};},
   close:async()=>({browserClosed:true})};
  const session=await openStagehandSession({deadline:Date.now()+10000,modelDisabled:true,sourceRoutingOnly:true,ownedBrowser:owned},
   {loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>({close:async()=>{}})}})});
  await session.goto(root);calls.length=0;current=failed;status=404;if(mode==='attestation')attested=false;
  if(mode==='historical'){
   assert.equal((await session.recoverSourceNotFound(root,failed)).status,404);assert.equal(reads,3);
   assert.deepEqual(calls,[['prepare',root],['goto',root]]);
  }else{
   await assert.rejects(session.recoverSourceNotFound(root,failed),error=>mode!=='current-read'||error===currentError);
   assert.equal(calls.length,0);
  }
  await session.close();assert.deepEqual(session.ownedCdpFailure,fault.ownedCdpFailure);
 }
});

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

test('a slow public gateway remains bounded by its wait and original deadline',async()=>{
 let time=1000;const page={pageId:'original',url:async()=>'https://public.example/'},popup={pageId:'new',url:async()=>time<4200?'about:blank':'https://public-bays.as.me/schedule/owner123'};
 const browser={context:{pages:async()=>[page,popup]}};
 const result=await settleNativeLinkNavigation({browser,page,initialPageIds:['original'],initialUrl:'https://public.example/',deadline:12000,maximumWaitMs:10000,now:()=>time,sleep:async ms=>{time+=ms;}});
 assert.equal(result.page,popup);assert.equal(result.changed,true);assert.equal(result.waitedMs,3200);
 time=1000;
 await assert.rejects(settleNativeLinkNavigation({browser,page,initialPageIds:['original'],initialUrl:'https://public.example/',deadline:3500,maximumWaitMs:10000,now:()=>time,sleep:async ms=>{time+=ms;}}),/ORIGINAL_DEADLINE_EXPIRED/u);
 await assert.rejects(settleNativeLinkNavigation({browser,page,initialPageIds:['original'],initialUrl:'https://public.example/',deadline:12000,maximumWaitMs:10001,now:()=>1000}),/NAVIGATION_OBSERVATION_OPTIONS_INVALID/u);
});

for(const sourceRoutingOnly of[false,true])test(`private native witness precedes deterministic source navigation only in source mode=${sourceRoutingOnly}`,async()=>{
 const order=[];let current='https://owned.example/';const destination='https://public-provider.example/start';
 const witness={kind:'NATIVE_VISIBLE_DOM',pageUrl:current,observedAt:new Date().toISOString(),documentHash:'a'.repeat(64),links:[{href:destination,visible:true}]};
 const page={pageId:'exact-owned',url:async()=>current,evaluate:async()=>({tag:'A',visible:true,inForm:false,text:'Public availability',label:'',href:destination,formAction:'',rowText:''}),locator:()=>({click:async()=>{order.push('CLICK');current=destination;}})};
 const browser={context:{pages:async()=>[page]},close:async()=>{}};
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:page.pageId,assertGuardedTargets:async()=>true,
  prepareNavigation:async()=>{},beforeAction:async(id,href)=>{assert.equal(id,page.pageId);assert.equal(href,destination);order.push('native');return witness;},close:async()=>({browserClosed:true})};
 const session=await openStagehandSession({deadline:Date.now()+5000,modelDisabled:true,sourceRoutingOnly,ownedBrowser:owned,
  onNativeSourceWitness:value=>{assert.deepEqual(value,witness);order.push('witness');}},
  {createNativePointer:async()=>({click:async()=>page.locator('a').click(),close:async()=>{}}),loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>({act:async()=>{order.push('SDK');current=destination;return{data:{success:true}};},close:async()=>{}})}})});
 await session.act({method:'click',selector:'a',arguments:[]});
 assert.deepEqual(order,sourceRoutingOnly?['native','witness','CLICK']:['native','SDK']);await session.close();
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
  const got=collect();assert.equal(got.navigation.pageUrl,'https://native.example/');assert.equal(got.navigation.rawHref,'/public-entry');assert.equal(got.navigation.target,'');assert.equal(got.navigation.captionComplete,true);assert.equal(got.navigation.inlineHandler,false);assert.equal(got.navigation.download,false);assert.equal(got.navigation.ariaDisabled,false);
  link.attrs.target='_blank';assert.equal(collect().navigation.target,'_blank');delete link.attrs.target;
 link.attrs.onclick='submitReservation()';assert.equal(collect().navigation.inlineHandler,true);delete link.attrs.onclick;
 link.attrs.download='';assert.equal(collect().navigation.download,true);delete link.attrs.download;
 link.textContent='Reserve Your Bay'+' '.repeat(161);assert.equal(collect().navigation.captionComplete,false);
});

test('observed availability navigation uses native URL, witness and DOM rechecks without another model act',async()=>{
 for(const scenario of ['current','changed-during-read','forged-action-url']){
  let current='https://owned.example/',reads=0,sdkCalls=0,nativeCalls=0,nativeClicks=0;const destination='https://owned.example/public-entry';
  const page={pageId:'owned',url:async()=>{reads++;return scenario==='changed-during-read'&&reads>=2?'https://owned.example/changed':current;},evaluate:async()=>({tag:'A',visible:true,inForm:false,text:'Reserve Your Bay',label:'',href:destination,formAction:'',rowText:'',type:'',name:'',id:'',navigation:{pageUrl:scenario==='forged-action-url'?'https://forged.example/':current,rawHref:'/public-entry',captionComplete:true,inlineHandler:false,download:false,role:'',ariaDisabled:false}}),locator:()=>({click:async()=>{assert.equal(nativeCalls,1);nativeClicks++;current=destination;}})};
  const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:page.pageId,assertGuardedTargets:async()=>true,prepareNavigation:async()=>{},beforeAction:async(id,href)=>{nativeCalls++;assert.equal(id,page.pageId);assert.equal(href,destination);return{kind:'NATIVE_VISIBLE_DOM',pageUrl:current,observedAt:new Date().toISOString(),documentHash:'a'.repeat(64),links:[{href:destination,visible:true}]};},close:async()=>({browserClosed:true})};
  const browser={closed:false,context:{pages:async()=>[page]},close:async()=>{browser.closed=true;}};
  const session=await openStagehandSession({deadline:Date.now()+5000,modelDisabled:true,sourceRoutingOnly:true,ownedBrowser:owned,onNativeSourceWitness:w=>{assert.equal(w.pageUrl,current);}},
   {createNativePointer:async()=>({click:async()=>page.locator('a').click(),close:async()=>{}}),loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>({act:async()=>{sdkCalls++;assert.equal(nativeCalls,1);current=destination;return{data:{success:true}};},close:async()=>{}})}})});
  const click={method:'click',selector:'a',arguments:[],currentPageUrl:'https://owned.example/'};
  if(scenario==='current'){const result=await session.act(click);assert.equal(result.afterUrl,destination);assert.equal(sdkCalls,0);assert.equal(nativeCalls,1);assert.equal(nativeClicks,1);}
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
 const hostFailure={stage:'SOURCE_DOM',reason:'DOM_URL_CHANGED',nativeFrameHasFragment:true,domHasFragment:true};
 const cleanupOrder=[];
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:'owned',assertGuardedTargets:async()=>true,beforeAction:async()=>{},prepareNavigation:async()=>{},
  snapshotFailure:async()=>{throw Error('LEGACY_SNAPSHOT_MUST_NOT_REPLACE_NATIVE');},
  snapshotFailures:async()=>{cleanupOrder.push('snapshot');return{ownedCdpFailure:cdpFailure,nativeRouterFailure:nativeFailure,hostGuardFailure:hostFailure};},close:async()=>{cleanupOrder.push('host');return{browserClosed:true,ownedCdpFailure:{layer:'SOCKET_CLOSE',pendingRequests:0}};}};
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
 assert.deepEqual(session.hostGuardFailure,hostFailure);const hostCopy=session.hostGuardFailure;hostCopy.reason='PRIVATE';assert.equal(session.hostGuardFailure.reason,'DOM_URL_CHANGED');
 assert.deepEqual(cleanupOrder,['snapshot','model','SDK','host']);
});

for(const mode of ['text','form','hidden','handler'])test('placeholder click rejects a target changed after the private witness: '+mode,async()=>{
 const root='https://official.example/';let reads=0,directClicks=0,sdkCalls=0;
 const initial={tag:'A',visible:true,inForm:false,text:'Book Bay',label:'',href:root+'#',formAction:'',rowText:'',navigation:{pageUrl:root,rawHref:'#',captionComplete:true,inlineHandler:false,download:false,role:'',target:'',ariaDisabled:false}};
 const changed={...initial,...(mode==='text'?{text:'Book Other Bay'}:mode==='form'?{inForm:true}:mode==='hidden'?{visible:false}:{navigation:{inlineHandler:true}})};
 const page={pageId:'owned',url:async()=>root,evaluate:async()=>++reads===1?initial:changed,
  locator:()=>({click:async()=>{directClicks++;}})};
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:'owned',assertGuardedTargets:async()=>true,
  prepareNavigation:async()=>{},beforeAction:async()=>({kind:'NATIVE_VISIBLE_DOM',pageUrl:root,observedAt:new Date().toISOString(),
    documentHash:'a'.repeat(64),links:[{href:root+'#',visible:true,text:'Book Bay',label:''}]}),close:async()=>({browserClosed:true})};
 const session=await openStagehandSession({deadline:Date.now()+5000,modelDisabled:true,sourceRoutingOnly:true,ownedBrowser:owned,
  onNativeSourceWitness:()=>{}},{loadRuntime:async()=>({localBrowser:{connect:async()=>({context:{pages:async()=>[page]},close:async()=>{}})},
  Stagehand:{create:async()=>({act:async()=>{sdkCalls++;throw Error('SECOND_ACTION_MODEL_CALL');},close:async()=>{}})}})});
 try{await assert.rejects(session.act({method:'click',selector:'a',arguments:[]}),/ACTION_TARGET_REJECTED/);
  assert.equal(reads,2);assert.equal(directClicks,0);assert.equal(sdkCalls,0);assert.equal(session.disabledModelCalls,0);}finally{await session.close();}
});

for(const mode of ['button-role','popup-target','inline-handler','download','in-form','blank-caption'])test('unsupported placeholder rejects before native grant: '+mode,async()=>{
 const root='https://official.example/';let nativeCalls=0,directClicks=0,sdkCalls=0;
 const base={tag:'A',visible:true,inForm:mode==='in-form',text:mode==='blank-caption'?'':'Book Bay I',label:'',href:root+'#',formAction:'',rowText:'',
  navigation:{pageUrl:root,rawHref:'#',captionComplete:true,inlineHandler:mode==='inline-handler',download:mode==='download',
   role:mode==='button-role'?'button':'',target:mode==='popup-target'?'_blank':'',ariaDisabled:false}};
 const page={pageId:'owned',url:async()=>root,evaluate:async()=>base,locator:()=>({click:async()=>{directClicks++;}})};
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:'owned',assertGuardedTargets:async()=>true,
  prepareNavigation:async()=>{},beforeAction:async()=>{nativeCalls++;throw Error('NATIVE_GRANT_MUST_NOT_RUN');},close:async()=>({browserClosed:true})};
 const session=await openStagehandSession({deadline:Date.now()+5000,modelDisabled:true,sourceRoutingOnly:true,ownedBrowser:owned,
  onNativeSourceWitness:()=>{}},{loadRuntime:async()=>({localBrowser:{connect:async()=>({context:{pages:async()=>[page]},close:async()=>{}})},
  Stagehand:{create:async()=>({act:async()=>{sdkCalls++;throw Error('SECOND_ACTION_MODEL_CALL');},close:async()=>{}})}})});
 try{await assert.rejects(session.act({method:'click',selector:'a',arguments:[]}),error=>error.message==='ACTION_TARGET_REJECTED'&&
   error.stagehandGuardReason==='UNSUPPORTED_PLACEHOLDER_ACTION');
  assert.equal(nativeCalls,0);assert.equal(directClicks,0);assert.equal(sdkCalls,0);assert.equal(session.disabledModelCalls,0);}finally{await session.close();}
});
