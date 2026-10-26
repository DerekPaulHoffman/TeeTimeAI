import test from'node:test';import assert from'node:assert/strict';import{JSDOM}from'jsdom';
import{readNativeActionTarget,prepareReadOnlyAction,assertPublicUrl,observedTargetSummary}from'./driver.mjs';
function read(html,selector){const dom=new JSDOM(html,{url:'https://public.example/',runScripts:'outside-only'}),w=dom.window;
 w.Element.prototype.getClientRects=function(){return[{width:50,height:20}];};
 const original=w.getComputedStyle.bind(w);w.getComputedStyle=element=>new Proxy(original(element),{get(target,key){return key==='opacity'&&target.opacity===''?'1':Reflect.get(target,key);}});
 const result=w.eval('('+readNativeActionTarget.toString()+')')(selector);dom.window.close();return JSON.parse(JSON.stringify(result));}
test('actual DOM leaf span/image binds actual visible enclosing anchor and preserves leaf tag',()=>{
 for(const leaf of['span','img']){const e=read('<a href="https://provider.example/start?tenant=public">Book tee times<'+leaf+' id="leaf"></'+leaf+'></a>','#leaf');
  assert.equal(e.tag,'A');assert.equal(e.leafTag,leaf.toUpperCase());assert.equal(e.href,'https://provider.example/start?tenant=public');assert.equal(e.visible,true);
  assert.equal(prepareReadOnlyAction({method:'click',arguments:[]},e).method,'click');assert.equal(observedTargetSummary(e).leafTag,leaf.toUpperCase());}
});
test('hidden or opacity-hidden ancestors never become visible anchor proof',()=>{
 for(const attrs of['hidden','inert','aria-hidden="true"','style="display:none"','style="opacity:0"','style="visibility:hidden"','style="visibility:collapse"']){const e=read('<div '+attrs+'><a href="https://provider.example/start"><span id="leaf">Book tee times</span></a></div>','#leaf');
  assert.equal(e.visible,false);assert.throws(()=>prepareReadOnlyAction({method:'click',arguments:[]},e),/ACTION_TARGET_REJECTED/);}
});
test('enclosing slot-time text and appointment href still reject nested icon click',()=>{
 const timed=read('<a href="https://provider.example/start">Book 9:30 AM<span id="leaf"></span></a>','#leaf');assert.throws(()=>prepareReadOnlyAction({method:'click',arguments:[]},timed),/ACTION_TARGET_REJECTED/);
 const appointment=read('<a href="/ASP/appt_req.asp"><span id="leaf">Continue</span></a>','#leaf');assert.equal(appointment.tag,'A');assert.throws(()=>assertPublicUrl(appointment.href),/PUBLIC_NAVIGATION_REJECTED/);
});

test('actual native Reserve root anchor qualifies only outside a form and without hidden or slot context',()=>{
 const click={method:'click',arguments:[]},options={sourceRoutingOnly:true};
 const e=read('<a href="https://provider.example/"><span id="leaf">Reserve tee times</span></a>','#leaf');
 assert.equal(e.inForm,false);assert.equal(prepareReadOnlyAction(click,e,options),click);
 for(const html of['<form><a id="leaf" href="https://provider.example/">Reserve</a></form>',
  '<div hidden><a id="leaf" href="https://provider.example/">Reserve</a></div>',
  '<article>10:30 AM<a id="leaf" href="https://provider.example/">Reserve</a></article>',
  '<a id="leaf" href="https://provider.example/">Reserve checkout</a>',
  '<a id="leaf" href="https://provider.example/?date=2026-11-01">Reserve</a>'])
  assert.throws(()=>prepareReadOnlyAction(click,read(html,'#leaf'),options),/ACTION_TARGET_REJECTED/);
});
