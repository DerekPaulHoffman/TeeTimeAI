import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSourceDiagnostic, projectActionGuardDiagnostic, sourceFailureDiagnostic, captureModelFailure, classifyNavigationError, SOURCE_DIAGNOSTIC_MAX_BYTES, stagehandRedirectRejections } from './source-diagnostic.mjs';
test('redirect rejection is one closed scoped enum and arbitrary/foreign/private fields cannot enter diagnostics',()=>{
 for(const redirectRejection of stagehandRedirectRejections){
  const native={code:'NATIVE_REDIRECT_PROVENANCE_REJECTED',phase:'REDIRECT_PROVENANCE',redirectRejection,method:'GET',resourceType:'xhr'};
  const d=sourceFailureDiagnostic({phase:'EXTRACT',nativeRouterFailure:native});assert.deepEqual(d.nativeRouterFailure,native);assert.deepEqual(projectSourceDiagnostic(d),d);
 }
 for(const delta of[{redirectRejection:'https://private.example/?token=SECRET'},{redirectRejection:7},{redirectRejection:null},{redirectRejection:'PRIVATE'},
  {redirectRejection:'CROSS_HOST',code:'NATIVE_REDIRECT_CANCELLED'},{redirectRejection:'CROSS_HOST',phase:'RESPONSE_WAIT'},{redirectRejection:'CROSS_HOST',headers:{cookie:'SECRET'}}]){
  const d=sourceFailureDiagnostic({nativeRouterFailure:{code:'NATIVE_REDIRECT_PROVENANCE_REJECTED',phase:'REDIRECT_PROVENANCE',...delta}});assert.equal(d.nativeRouterFailure,undefined);assert.doesNotMatch(JSON.stringify(d),/PRIVATE|SECRET|https:/u);
 }
 assert.deepEqual(sourceFailureDiagnostic({nativeRouterFailure:{code:'NATIVE_REDIRECT_PROVENANCE_REJECTED',phase:'REDIRECT_PROVENANCE'}}).nativeRouterFailure,{code:'NATIVE_REDIRECT_PROVENANCE_REJECTED',phase:'REDIRECT_PROVENANCE'});
});
const report=()=>({metrics:{completedSteps:2,localCodexCalls:[{},{},{}]},actions:[],actionAttempts:[{status:'REJECTED',guardReason:'HIDDEN',selector:'SECRET_SELECTOR',reason:'PRIVATE_MESSAGE'}],
 officialLinkLedger:[{pageUrl:'https://public.example/',links:[{href:'https://provider.example/start?tenant=one',visible:true}]}],frameLedger:[],eligibleBookingSourceUrls:[]});
test('closed stopping facts distinguish ordinary unresolved without retaining model reason or action target',()=>{
 const stop={finalDecision:'UNRESOLVED',condition:'EXPLICIT_UNRESOLVED',lastActionKind:'click'};
 const d=sourceFailureDiagnostic({phase:'EXTRACT',report:report(),sourceStop:stop});
 assert.deepEqual(d.sourceStop,stop);assert.equal(d.errorClass,'NONE');
 assert.equal(projectSourceDiagnostic({...d,sourceStop:{...stop,reason:'PRIVATE'}}),undefined);
 assert.equal(projectSourceDiagnostic({...d,sourceStop:{...stop,lastActionKind:'https://private.example/'}}),undefined);
 assert.equal(sourceFailureDiagnostic({sourceStop:{...stop,private:'SECRET'}}).sourceStop,undefined);
 assert.deepEqual(sourceFailureDiagnostic({sourceStop:{finalDecision:null,condition:'ERROR',lastActionKind:null}}).sourceStop,{finalDecision:null,condition:'ERROR',lastActionKind:null});
 assert.doesNotMatch(JSON.stringify(d),/SECRET|PRIVATE|https:|selector|url/iu);
});
test('failure diagnostics preserve static transport/phase/numeric partial facts and never raw error payloads',()=>{
 const error=Object.assign(Error('PRIVATE_MESSAGE https://private.example/?token=SECRET'),{code:'LOCAL_MODEL_RPC_FAILED',stagehandFailureStage:'SDK_INITIALIZE',
  diagnostics:{phase:'turn/start',rpcCode:-32600,httpStatusCode:429,usage:{totalTokens:90,inputTokens:80,outputTokens:10,private:'SECRET'},message:'PRIVATE_MESSAGE',body:'SECRET'}});
 const d=sourceFailureDiagnostic({error,phase:'EXTRACT',report:report(),startedAt:Date.now()-10,cleanup:{browserClosed:true,modelClosed:true},modelAttempts:5});
 assert.equal(d.phase,'EXTRACT');assert.equal(d.startupStage,'SDK_INITIALIZE');assert.equal(d.transportCode,'LOCAL_MODEL_RPC_FAILED');assert.equal(d.rpcCode,-32600);assert.equal(d.httpStatus,429);
 assert.deepEqual(d.failedCallUsage,{totalTokens:90,inputTokens:80,outputTokens:10});assert.equal(d.counts.completedModelCalls,3);assert.equal(d.counts.attemptedModelCalls,5);assert.equal(d.counts.failedModelCalls,2);
 assert.equal(d.completedUsageIsLowerBound,true);assert.equal(d.guardReason,'HIDDEN');assert.ok(Buffer.byteLength(JSON.stringify(d))<=SOURCE_DIAGNOSTIC_MAX_BYTES);
 assert.doesNotMatch(JSON.stringify(d),/SECRET|PRIVATE|https:|selector|body|message|stack|prompt|header/iu);
});
test('navigation classification keeps only known browser/protocol markers and closed error names',()=>{
 for(const code of['ERR_ABORTED','ERR_BLOCKED_BY_CLIENT','ERR_CERT_AUTHORITY_INVALID','ERR_TUNNEL_CONNECTION_FAILED','ERR_NAME_NOT_RESOLVED']){
  const e=Error(`Navigation failed net::${code} https://private.example/?token=SECRET port 54321`);
  assert.deepEqual(classifyNavigationError(e),{navigationCode:code,navigationErrorName:'Error'});
 }
 assert.equal(classifyNavigationError(Object.assign(Error('PRIVATE'),{cause:{code:-32602}})).navigationCode,'INVALID_PARAMETERS');
 assert.equal(classifyNavigationError(Object.assign(Error('PRIVATE'),{name:'TimeoutError'})).navigationCode,'TIMEOUT');
 assert.equal(classifyNavigationError(Error('Target closed https://private.example/')).navigationCode,'TARGET_CLOSED');
 assert.deepEqual(classifyNavigationError(Object.assign(Error('SECRET net::ERR_SECRET_TOKEN'),{name:'SECRET'})),{navigationCode:'UNKNOWN',navigationErrorName:'UNKNOWN'});
});
test('OPEN failure is a diagnosed SDK operation without raw error message, stack, URL or debugger port',()=>{
 const error=Object.assign(Error('Navigation net::ERR_CONNECTION_RESET https://private.example/?token=SECRET port 54321'),{stack:'SECRET_STACK'});
 const d=sourceFailureDiagnostic({error,phase:'OPEN',report:report(),modelAttempts:0});
 assert.equal(d.phase,'OPEN');assert.equal(d.errorClass,'SDK_ERROR');assert.equal(d.navigationCode,'ERR_CONNECTION_RESET');assert.equal(d.navigationErrorName,'Error');
 assert.doesNotMatch(JSON.stringify(d),/SECRET|private|54321|https:|stack|message/i);
 assert.equal(projectSourceDiagnostic({...d,navigationCode:'ERR_SECRET_TOKEN'}),undefined);
});
test('unknown error/status/class fields never enter strict projection, and graph hashes contain only safe routing facts',()=>{
 const first=sourceFailureDiagnostic({error:Object.assign(Error('SECRET'),{code:'SECRET',name:'SECRET',diagnostics:{phase:'SECRET',rpcCode:'SECRET',httpStatusCode:9999}}),phase:'ACT',report:report(),modelAttempts:0});
 assert.equal(first.errorClass,'SDK_ERROR');assert.equal(first.transportCode,undefined);assert.equal(first.rpcCode,undefined);assert.equal(first.httpStatus,undefined);
 for(const modified of[{...first,rawMessage:'SECRET'},{...first,phase:'SECRET'},{...first,cleanup:{...first.cleanup,token:'SECRET'}},{...first,counts:{...first.counts,attemptedModelCalls:-1}}])assert.equal(projectSourceDiagnostic(modified),undefined);
 const altered=report();altered.private='SECRET';assert.equal(sourceFailureDiagnostic({report:altered}).graph.sha256,sourceFailureDiagnostic({report:report()}).graph.sha256);
 altered.officialLinkLedger[0].links[0].href='https://provider.example/start?tenant=two';assert.notEqual(sourceFailureDiagnostic({report:altered}).graph.sha256,first.graph.sha256);
});

test('closed action taxonomy survives report failure without raw target text or URL',()=>{
 const r=report();Object.assign(r.actionAttempts[0],{guardReason:'TRANSACTION_TEXT',guardTerm:'RESERVE',guardField:'TEXT',guardTag:'A',guardHasHref:true});
 const d=sourceFailureDiagnostic({report:r,phase:'ACT'});
 for(const [key,value]of Object.entries({guardReason:'TRANSACTION_TEXT',guardTerm:'RESERVE',guardField:'TEXT',guardTag:'A',guardHasHref:true}))assert.equal(d[key],value);
 assert.doesNotMatch(JSON.stringify(d),/SECRET|PRIVATE|https:|selector|message/);
 for(const delta of[{guardTerm:'PRIVATE_TEXT'},{guardField:'RAW_HTML'},{guardTag:'PRIVATE_TAG'},{href:'https://private.example/'}])
  assert.equal(projectActionGuardDiagnostic({...r.actionAttempts[0],...delta}),undefined);
 assert.equal(projectSourceDiagnostic({...d,guardTerm:'PRIVATE_TEXT'}),undefined);
});

test('wrapped SDK failure adopts only the same latest failed model invocation, never stale or invented usage',()=>{
 const r=report();r.metrics.localCodexCalls=[];
 const modelFailure=captureModelFailure(Object.assign(Error('SECRET'),{code:'LOCAL_MODEL_RPC_FAILED',diagnostics:{phase:'turn/start',rpcCode:-32600,httpStatusCode:400,usage:{inputTokens:11}}}),1,0);
 const options={error:Error('SDK wrapped private failure'),phase:'EXTRACT',report:r,modelAttempts:1,modelFailure};
 const d=sourceFailureDiagnostic(options);assert.equal(d.transportCode,'LOCAL_MODEL_RPC_FAILED');assert.equal(d.rpcCode,-32600);assert.equal(d.errorClass,'STATIC_TRANSPORT');
 assert.deepEqual(d.failedCallUsage,{inputTokens:11});assert.equal(d.counts.completedModelCalls,0);assert.equal(d.counts.attemptedModelCalls,1);
 for(const delta of[{modelAttempts:2},{modelFailure:{...modelFailure,completedCalls:1}},{error:undefined},{modelFailure:{...modelFailure,message:'SECRET'}}]){
  const rejected=sourceFailureDiagnostic({...options,...delta});assert.equal(rejected.transportCode,undefined);assert.equal(rejected.failedCallUsage,undefined);
 }
 assert.equal(captureModelFailure(Error('SECRET'),0,0),undefined);assert.doesNotMatch(JSON.stringify(d),/SECRET|private|https:|message|stack/);
});

test('same-owned-host failure keeps only finite protocol facts and does not infer target ownership or model cause',()=>{
 const ownedCdpFailure={layer:'RPC',method:'Target.closeTarget',rpcCode:-32001,lifecycle:'SESSION_NOT_FOUND',pendingRequests:0};
 const d=sourceFailureDiagnostic({error:Error('SDK wrapped PRIVATE'),phase:'EXTRACT',report:report(),ownedCdpFailure});
 assert.deepEqual(d.ownedCdpFailure,ownedCdpFailure);assert.equal(d.transportCode,undefined);
 for(const delta of[{method:'PRIVATE_TARGET'},{sessionId:'PRIVATE'},{message:'PRIVATE'},{event:'SECRET_EVENT'},{pendingRequests:257},{rpcCode:'-32001'}]){
  assert.equal(sourceFailureDiagnostic({error:Error('failure'),ownedCdpFailure:{...ownedCdpFailure,...delta}}).ownedCdpFailure,undefined);
 }
 assert.doesNotMatch(JSON.stringify(d),/PRIVATE|https:|sessionId|targetId|message|port/);
});

test('socket categories and observed browser/page facts remain closed and separate from router observations',()=>{
 const socket={layer:'SOCKET_ERROR',pendingRequests:1,socketErrorName:'Error',socketFailureCategory:'DECOMPRESSED_MESSAGE_LIMIT',
  browserConnectedAtFailure:true,ownedPageCrashObserved:false,ownedPageCloseObserved:false,contextClosedObserved:false};
 const d=sourceFailureDiagnostic({error:Error('SDK_WRAP'),ownedCdpFailure:socket});assert.deepEqual(d.ownedCdpFailure,socket);
 assert.equal(d.nativeRouterFailure,undefined);assert.equal(d.transportCode,undefined);
 for(const delta of[{socketErrorName:'PRIVATE'},{socketErrorCode:'SECRET'},{socketCauseCode:'SECRET'},{socketFailureCategory:'PRIVATE'},
  {socketCloseCode:99999},{browserConnectedAtFailure:'true'},{message:'SECRET'},{socketReason:'PRIVATE'}])
  assert.equal(sourceFailureDiagnostic({ownedCdpFailure:{...socket,...delta}}).ownedCdpFailure,undefined);
});
