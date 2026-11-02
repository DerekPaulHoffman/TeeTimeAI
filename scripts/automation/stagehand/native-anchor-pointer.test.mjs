import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createServer as createPortProbe} from 'node:net';
import {chromium} from '@playwright/test';
import {createNativeAnchorPointer} from './native-anchor-pointer.mjs';
const cdpUrl='ws://127.0.0.1:12345/devtools/browser/12345678-abcd-abcd-abcd-123456789012';
function fixture({wrongTarget=false,changedUrl=false,changedDom=false,guarded=true}={}) {
 let clicks=0,detached=0,closed=0;
 const sourceUrl='https://public.example/',evidence={tag:'A',href:'https://provider.example/',visible:true};
 const page={url:()=>changedUrl?sourceUrl+'changed':sourceUrl,context:()=>context,evaluate:async()=>changedDom?{...evidence,visible:false}:evidence,
  locator:()=>({click:async options=>{assert.equal(options.noWaitAfter,true);assert.ok(options.timeout>0&&options.timeout<=4000);clicks++;}})};
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

test('one real anchor click returns while its navigation is pending, leaving completion to the controller',{timeout:20000},async()=>{
 const portProbe=createPortProbe();await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));
 const debugPort=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
 let requested;const slowRequested=new Promise(resolve=>{requested=resolve;});
 const server=createServer((request,response)=>{
  if(request.url==='/slow'){requested();return;}
  response.writeHead(200,{'content-type':'text/html'});response.end('<a href="/slow">Public calendar</a>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const sourceUrl=`http://127.0.0.1:${server.address().port}/`;
 let browser,pointer;
 try{
  browser=await chromium.launch({headless:true,args:[`--remote-debugging-port=${debugPort}`]});
  const context=await browser.newContext(),page=await context.newPage();await page.goto(sourceUrl);
  const session=await context.newCDPSession(page),target=await session.send('Target.getTargetInfo');await session.detach();
  const targetId=target.targetInfo.targetId,readTarget=()=>({tag:'A',href:document.querySelector('a').href,visible:true});
  const evidence=await page.evaluate(readTarget),endpoint=await fetch(`http://127.0.0.1:${debugPort}/json/version`,{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
  pointer=await createNativeAnchorPointer({cdpUrl:endpoint.webSocketDebuggerUrl,deadline:Date.now()+10000,
   assertGuardedTargets:async ids=>ids.length===1&&ids[0]===targetId});
  await pointer.click({targetId,selector:'a',sourceUrl,evidence,readTarget});
  let timer;try{await Promise.race([slowRequested,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('ANCHOR_NOT_DISPATCHED')),3000);})]);}finally{clearTimeout(timer);}
  // The target server has not sent headers. Returning from the input transport
  // must not be confused with a completed navigation or availability evidence.
  assert.equal(page.url(),sourceUrl);
 }finally{
  await pointer?.close();await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 }
});
