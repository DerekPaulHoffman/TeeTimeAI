import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const sourcePath=join(dirname(fileURLToPath(import.meta.url)),'run-course-discovery-supervisor.ps1');
const isolated=`$tokens=$null;$errors=$null;
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:PROJECTOR_SOURCE,[ref]$tokens,[ref]$errors);
if($errors.Count){throw 'SCRIPT_PARSE_FAILED'};
foreach($name in @('ConvertTo-SafeDiscoveryToolTrace','ConvertTo-SafeGenericFallbackUsage','ConvertTo-SafeDiscoveryLogLine')) {
 $definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true);
 if(-not $definition){throw 'PROJECTOR_NOT_FOUND'};
 . ([scriptblock]::Create($definition.Extent.Text));
}
$raw=[Console]::In.ReadToEnd();
if($env:PROJECTOR_MODE -eq 'line'){$result=ConvertTo-SafeDiscoveryLogLine -Line $raw | ConvertFrom-Json}
else{$payload=$raw | ConvertFrom-Json;$result=ConvertTo-SafeGenericFallbackUsage -Worker $payload.genericFallback.worker};
if($null -eq $result){[Console]::WriteLine('null')}else{[Console]::WriteLine(($result | ConvertTo-Json -Compress -Depth 8))}`;
function project(value,shell='pwsh',mode='generic'){
  const run=spawnSync(shell,['-NoProfile','-NonInteractive','-Command',isolated],{
    cwd:dirname(sourcePath),input:JSON.stringify(value),encoding:'utf8',timeout:15_000,
    env:{...process.env,PROJECTOR_SOURCE:sourcePath,PROJECTOR_MODE:mode},maxBuffer:100_000});
  assert.equal(run.status,0,run.stderr);return JSON.parse(run.stdout.trim());
}

test('generic worker usage records separate turns and exactly five bounded token fields',()=>{
  const canary='PRIVATE_PROMPT_URL_HEADER_TOKEN',value={source:{modelCalls:5,tokenUsage:{totalTokens:123}},
    genericFallback:{worker:{attemptedModelTurns:7,completedModelTurns:0,tokenUsage:{
      totalTokens:448093,inputTokens:420000,cachedInputTokens:369792,outputTokens:28093,reasoningOutputTokens:12500,
      uncachedInputTokens:50208,rawSecret:canary},summary:canary,url:canary,modelReason:canary}}};
  const projected=project(value);
  assert.deepEqual(projected,{attemptedModelTurns:7,completedModelTurns:0,tokenUsage:{
    totalTokens:448093,inputTokens:420000,cachedInputTokens:369792,outputTokens:28093,reasoningOutputTokens:12500},usageLowerBound:true});
  assert.equal(JSON.stringify(projected).includes(canary),false);
  const source=readFileSync(sourcePath,'utf8');
  assert.match(source,/\$metrics\.tokenUsage = \$tokens/u);
  assert.match(source,/\$metrics\.sourceUsageRecordedLowerBound = \$record\.metrics\.sourceUsageRecordedLowerBound/u);
  assert.doesNotMatch(JSON.stringify(projected),/modelCalls/u);
});

test('unknown and malformed numbers cannot enter the supervisor diagnostic',()=>{
  assert.equal(project({genericFallback:{worker:{attemptedModelTurns:-1,completedModelTurns:'Infinity',
    tokenUsage:{totalTokens:'1e20',inputTokens:'PRIVATE',cachedInputTokens:null}}}}),null);
  assert.deepEqual(project({genericFallback:{worker:{attemptedModelTurns:2,completedModelTurns:1,
    tokenUsage:{totalTokens:12,extraPrivate:'PRIVATE'}}}}),{
      attemptedModelTurns:2,completedModelTurns:1,tokenUsage:{totalTokens:12},usageLowerBound:true});
  assert.deepEqual(project({genericFallback:{worker:{attemptedModelTurns:1}}}),{
    attemptedModelTurns:1,usageLowerBound:false});
});

test('generic budget logs bounded counters and closed stop codes without private diagnostics',()=>{
  const canary='PRIVATE_NATIVE_URL_HEADER';
  assert.deepEqual(project({genericFallback:{worker:{tokenUsage:{totalTokens:128001},genericBudget:{
    toolOperations:3,usageMayIncludeInFlightResponse:true,limits:{private:canary},
    stop:{code:'DISCOVERY_GENERIC_BUDGET_EXHAUSTED',limit:'totalTokens',nativeFirstFatal:{url:canary},message:canary}}}}}),{
    tokenUsage:{totalTokens:128001},genericBudget:{toolOperations:3,usageMayIncludeInFlightResponse:true,
      stop:{code:'DISCOVERY_GENERIC_BUDGET_EXHAUSTED',limit:'totalTokens'}},usageLowerBound:true});
  const native=project({genericFallback:{worker:{genericBudget:{toolOperations:1,
    stop:{code:'DISCOVERY_NATIVE_TRANSPORT_FATAL',limit:'not-an-authority',nativeFirstFatal:{url:canary}}}}}});
  assert.deepEqual(native,{genericBudget:{toolOperations:1,stop:{code:'DISCOVERY_NATIVE_TRANSPORT_FATAL'}},usageLowerBound:false});
  assert.equal(JSON.stringify(native).includes(canary),false);
  assert.equal(project({genericFallback:{worker:{genericBudget:{toolOperations:-1,
    usageMayIncludeInFlightResponse:canary,stop:{code:canary,limit:'totalTokens'}}}}}),null);
});

test('installed Windows PowerShell retains the same safe budget receipt',{skip:process.platform!=='win32'},()=>{
  const value={genericFallback:{worker:{attemptedModelTurns:1,completedModelTurns:0,
    tokenUsage:{totalTokens:128001,inputTokens:127999,cachedInputTokens:100000,outputTokens:2},
    genericBudget:{toolOperations:4,usageMayIncludeInFlightResponse:true,
      stop:{code:'DISCOVERY_GENERIC_BUDGET_EXHAUSTED',limit:'totalTokens'}}}}};
  assert.deepEqual(project(value,'powershell.exe'),project(value));
});

const traceFixture=()=>({entries:[
  {action:'BROWSER_OPEN',status:'SUCCESS',modelPreviewBytes:7999,previewOmitted:true,url:'PRIVATE_URL',label:'PRIVATE_LABEL'},
  {action:'BROWSER_INSPECT_ADAPTER',status:'ERROR',errorCode:'UNOBSERVED_NAVIGATION',modelPreviewBytes:997,previewOmitted:false,message:'PRIVATE_ERROR'},
  {action:'SCHEMA',status:'SUCCESS',schemaEngine:'HTTP_JSON',modelPreviewBytes:9679,previewOmitted:false,body:'PRIVATE_BODY'},
],lostEntries:0});
test('actual managed line projection retains closed trace for direct and generic workers plus original job clocks',()=>{
  const value={event:'discovery_job_failed',jobId:'synthetic-job',firstPickedUpAt:'2030-01-01T12:00:00.000Z',deadlineAt:'2030-01-01T12:15:00.000Z',
    metrics:{genericToolTrace:traceFixture(),genericFallback:{worker:{genericToolTrace:traceFixture(),completedModelTurns:0}}}};
  const projected=project(value,'pwsh','line');
  assert.equal(projected.jobId,value.jobId);assert.equal(Date.parse(projected.firstPickedUpAt),Date.parse(value.firstPickedUpAt));
  assert.equal(Date.parse(projected.deadlineAt),Date.parse(value.deadlineAt));
  assert.deepEqual(projected.metrics.genericToolTrace,projected.metrics.genericFallback.genericToolTrace);
  assert.equal(projected.metrics.genericToolTrace.entries.length,3);
  assert.deepEqual(projected.metrics.genericToolTrace.entries[1],{action:'BROWSER_INSPECT_ADAPTER',status:'ERROR',modelPreviewBytes:997,previewOmitted:false,errorCode:'UNOBSERVED_NAVIGATION'});
  assert.equal(projected.metrics.genericToolTrace.entries[2].schemaEngine,'HTTP_JSON');
  assert.equal(JSON.stringify(projected).includes('PRIVATE'),false);
  if(process.platform==='win32'){
    const windows=project(value,'powershell.exe','line');
    for(const key of ['firstPickedUpAt','deadlineAt']){assert.equal(Date.parse(windows[key]),Date.parse(projected[key]));windows[key]=projected[key];}
    assert.deepEqual(windows,projected);
  }
});
test('trace projection closes enums, bounds eight entries, counts omissions and never turns missing bytes into zero',()=>{
  const entry={action:'PRIVATE_ACTION',status:'ERROR',errorCode:'PRIVATE_ERROR',schemaEngine:'PRIVATE_ENGINE',modelPreviewBytes:123,previewOmitted:false};
  const value={genericFallback:{worker:{genericToolTrace:{entries:[{...entry,modelPreviewBytes:null},...Array.from({length:10},()=>entry)],lostEntries:2}}}};
  const trace=project(value).genericToolTrace;
  assert.equal(trace.entries.length,8);assert.equal(trace.lostEntries,5);
  assert.deepEqual(trace.entries[0],{action:'UNKNOWN_TOOL',status:'ERROR',modelPreviewBytes:123,previewOmitted:false,errorCode:'OTHER_TOOL_ERROR'});
  assert.equal(JSON.stringify(trace).includes('PRIVATE'),false);
  assert.equal(project({genericFallback:{worker:{genericToolTrace:{entries:'PRIVATE',lostEntries:0}}}}),null);
  assert.equal(project({genericFallback:{worker:{genericToolTrace:{entries:[entry],lostEntries:null}}}}),null);
});
test('managed line guard remains 16384 characters and maximum closed traces fit without evicting provenance',()=>{
  const entries=Array.from({length:8},()=>({action:'BROWSER_INSPECT_ADAPTER',status:'ERROR',errorCode:'DISCOVERY_GENERIC_BUDGET_EXHAUSTED',modelPreviewBytes:99999999,previewOmitted:true}));
  const value={event:'discovery_job_failed',jobId:'synthetic-job',firstPickedUpAt:'2030-01-01T12:00:00Z',deadlineAt:'2030-01-01T12:15:00Z',
    metrics:{genericToolTrace:{entries,lostEntries:999999},genericFallback:{worker:{genericToolTrace:{entries,lostEntries:999999}}}}};
  assert.ok(JSON.stringify(value).length<16384);
  const projected=project(value,'pwsh','line');assert.equal(projected.jobId,value.jobId);
  assert.equal(projected.metrics.genericToolTrace.entries.length,8);assert.equal(projected.metrics.genericFallback.genericToolTrace.entries.length,8);
  assert.ok(Buffer.byteLength(JSON.stringify(projected))<16384);
  assert.deepEqual(project({...value,unsafe:'PRIVATE'.repeat(3000)},'pwsh','line'),{event:'supervisor_diagnostic_redacted'});
});
