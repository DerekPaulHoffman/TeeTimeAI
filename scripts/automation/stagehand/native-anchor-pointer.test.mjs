import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeAnchorPointer} from './native-anchor-pointer.mjs';
const cdpUrl='ws://127.0.0.1:12345/devtools/browser/12345678-abcd-abcd-abcd-123456789012';
function fixture({wrongTarget=false,changedUrl=false,changedDom=false,guarded=true}={}) {
 let clicks=0,detached=0,closed=0;
 const sourceUrl='https://public.example/',evidence={tag:'A',href:'https://provider.example/',visible:true};
 const page={url:()=>changedUrl?sourceUrl+'changed':sourceUrl,context:()=>context,evaluate:async()=>changedDom?{...evidence,visible:false}:evidence,
  locator:()=>({click:async()=>{clicks++;}})};
 const context={pages:()=>[page],newCDPSession:async()=>({send:async method=>{assert.equal(method,'Target.getTargetInfo');return{targetInfo:{targetId:wrongTarget?'foreign':'owned'}};},detach:async()=>{detached++;}})};
 const browser={contexts:()=>[context],isConnected:()=>closed===0,close:async()=>{closed++;}};
 return{options:{cdpUrl,deadline:Date.now()+10000,assertGuardedTargets:async ids=>guarded&&ids.length===1&&ids[0]==='owned'},
  connect:async url=>{assert.equal(url,cdpUrl);return browser;},input:{targetId:'owned',selector:'a',sourceUrl,evidence,readTarget:()=>{}},
  counts:()=>({clicks,detached,closed})};
}
test('native pointer matches the owned CDP target and current document before its one click',async()=>{
 const f=fixture(),pointer=await createNativeAnchorPointer(f.options,{connect:f.connect});
 await pointer.click(f.input);assert.deepEqual(f.counts(),{clicks:1,detached:1,closed:0});
 await pointer.close();await pointer.close();assert.equal(f.counts().closed,1);
 await assert.rejects(pointer.click(f.input),/STAGEHAND_NATIVE_POINTER_SCOPE_INVALID/u);
});
test('foreign targets, changed URLs, changed DOM and missing guardian permission never click',async()=>{
 for(const options of[{wrongTarget:true},{changedUrl:true},{changedDom:true},{guarded:false}]){
  const f=fixture(options),pointer=await createNativeAnchorPointer(f.options,{connect:f.connect});
  await assert.rejects(pointer.click(f.input));assert.equal(f.counts().clicks,0);await pointer.close();
 }
});
test('native pointer refuses a remote or unowned CDP endpoint before connecting',async()=>{
 let calls=0;
 for(const cdpUrl of['http://127.0.0.1:12345','ws://remote.example:12345/devtools/browser/12345678-abcd-abcd-abcd-123456789012'])
  await assert.rejects(createNativeAnchorPointer({cdpUrl,deadline:Date.now()+10000,assertGuardedTargets:async()=>true},{connect:async()=>{calls++;}}));
 assert.equal(calls,0);
});
