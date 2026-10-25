import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReadOnlyAction, assertNativeSelectReadback, isPublicFilterSelect, assertPublicUrl, settleNativeLinkNavigation, loadStagehandRuntime, validateOwnedBrowserConnection, openStagehandSession } from './driver.mjs';

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
test('all SDK operations bind the exact guarded page without Chrome UI activation or active/default fallback',async()=>{
 const calls=[], initialUrl='https://owned.example/', destination='https://owned.example/public';
 const page={pageId:'exact-target',url:async()=>initialUrl,goto:async value=>{calls.push(['goto',value]);},snapshot:async()=>({url:initialUrl}),evaluate:async()=>({})};
 const other={pageId:'other-guarded-page',url:async()=>'https://other.example/'};
 const browser={closed:false,context:{pages:async()=>[page,other],activePage:async()=>{throw Error('ACTIVE_FALLBACK');},setActivePage:async()=>{throw Error('UI_ACTIVATION');}},close:async()=>{browser.closed=true;}};
 const owned={kind:'OWNED_GUARDED_STAGEHAND_CONTEXT',cdpUrl:'http://127.0.0.1:12345',targetId:page.pageId,
  assertGuardedTargets:async ids=>ids.length===2&&ids.includes(page.pageId)&&ids.includes(other.pageId),
  prepareNavigation:async value=>{calls.push(['prepare',value]);},beforeAction:async(id,href)=>{calls.push(['before',id,href]);},close:async()=>({browserClosed:true})};
 const operation=(name)=>(...args)=>{assert.equal(args.at(-1).page,page);calls.push([name]);return {data:{success:true}};};
 const stagehand={extract:operation('extract'),observe:operation('observe'),act:operation('act'),metrics:async()=>({}),close:async()=>{}};
 const session=await openStagehandSession({deadline:Date.now()+10000,modelDisabled:true,ownedBrowser:owned},{loadRuntime:async()=>({localBrowser:{connect:async()=>browser},Stagehand:{create:async()=>stagehand}})});
 assert.equal(session.page,page);await session.goto(destination);await session.snapshot();await session.extract('Read',{});await session.observe('Read');
 await session.act({method:'hover',selector:'a',arguments:[]});assert.equal(session.page,page);
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
