import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createStagehandGuardedBrowserHost } from '../course-discovery-stagehand-host.mjs';
import { createDiscoveryProcess } from '../course-discovery-worker.mjs';
import { guardedHostStartupStages } from './guarded-host-startup.mjs';
import { sourceFailureDiagnostic, projectSourceDiagnostic } from './source-diagnostic.mjs';

test('failed guarded host startup preserves a closed stage and process timeout without retaining private pipe content', async () => {
  let closed = false;
  const failure = Object.assign(new Error('DISCOVERY_PROCESS_TIMEOUT'), {code:'DISCOVERY_PROCESS_TIMEOUT'});
  await assert.rejects(createStagehandGuardedBrowserHost({ cwd:process.cwd(), initialUrl:'https://example.com/', timeZone:'UTC',
    deadlineAt:new Date(Date.now()+120000).toISOString(),
    helperEnvironment:{COURSE_DISCOVERY_BROWSER_TRANSPORT:'NATIVE_CHROME',COURSE_DISCOVERY_JOB_KIND:'discovery',COURSE_DISCOVERY_JOB_ID:'local-test',COURSE_DISCOVERY_LEASE_TOKEN:'PRIVATE-SECRET'},
    processFactory: options => ({ request:async value => {
      if(value.action==='finish')return {browserClosed:false,providerRequestsDrained:false};
      options.onMessage({method:'host/startup',params:{stage:'TARGET_READY',token:'PRIVATE-SECRET'}});
      options.onMessage({method:'host/startup-failure',params:{reason:'OTHER',ownedCdpFailure:{layer:'TIMEOUT',method:'Extensions.loadUnpacked',pendingRequests:1}}});
      options.onMessage({method:'host/startup',params:{stage:'https://private.invalid/?secret=PRIVATE-SECRET'}});
      options.onMessage({method:'other',params:{stage:'READY'}});
      throw failure;
    },close:async()=>{closed=true;} }) }), error => {
      const diagnostic=sourceFailureDiagnostic({error,phase:'GUARDED_HOST'});
      assert.equal(diagnostic.guardedHostStartupStage,'TARGET_READY');
      assert.equal(diagnostic.transportCode,'DISCOVERY_PROCESS_TIMEOUT');
      assert.equal(diagnostic.guardedHostStartupFailure,'OTHER');
      assert.equal(diagnostic.ownedCdpFailure.method,'Extensions.loadUnpacked');
      assert.deepEqual(projectSourceDiagnostic(diagnostic),diagnostic);
      assert.doesNotMatch(JSON.stringify(diagnostic),/PRIVATE|https:|token/u);
      return true;
    });
  assert.equal(closed,true);
});

test('startup diagnostics accept only closed stages and cannot turn unknown text into evidence',()=>{
  for(const stage of guardedHostStartupStages)assert.equal(sourceFailureDiagnostic({error:{guardedHostStartupStage:stage}}).guardedHostStartupStage,stage);
  assert.equal(sourceFailureDiagnostic({error:{guardedHostStartupStage:'PRIVATE'}}).guardedHostStartupStage,undefined);
  assert.equal(sourceFailureDiagnostic({error:{guardedHostStartupFailure:'PRIVATE'}}).guardedHostStartupFailure,undefined);
  assert.equal(sourceFailureDiagnostic({error:{guardedHostOwnedCdpFailure:{layer:'TIMEOUT',method:'https://private.invalid',pendingRequests:1}}}).ownedCdpFailure,undefined);
});

test('a progressing startup can finish after 30 seconds while later RPCs still time out at 30 seconds',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const child=new EventEmitter();
  Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>child.emit('close',0)});
  const channel=createDiscoveryProcess({executable:'unused',args:[],cwd:process.cwd(),environment:{},timeoutMs:30000,startupTimeoutMs:60000,spawnProcess:()=>child});
  let settled=false;
  const started=channel.request({action:'start'}).then(value=>{settled=true;return value;});
  t.mock.timers.tick(32300);await Promise.resolve();
  assert.equal(settled,false);
  child.stdout.write(JSON.stringify({id:1,ok:true,result:{ready:true}})+'\n');
  assert.deepEqual(await started,{ready:true});
  const later=channel.request({action:'assert'});
  const rejected=assert.rejects(later,{code:'DISCOVERY_PROCESS_TIMEOUT'});
  t.mock.timers.tick(30000);await rejected;
  await channel.close();
});
