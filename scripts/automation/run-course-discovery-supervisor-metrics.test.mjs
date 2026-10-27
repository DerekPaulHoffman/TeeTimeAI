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
$definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ConvertTo-SafeGenericFallbackUsage'},$true);
if(-not $definition){throw 'PROJECTOR_NOT_FOUND'};
. ([scriptblock]::Create($definition.Extent.Text));
$payload=[Console]::In.ReadToEnd() | ConvertFrom-Json;
$result=ConvertTo-SafeGenericFallbackUsage -Worker $payload.genericFallback.worker;
if($null -eq $result){[Console]::WriteLine('null')}else{[Console]::WriteLine(($result | ConvertTo-Json -Compress -Depth 8))}`;
function project(value){
  const run=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',isolated],{
    cwd:dirname(sourcePath),input:JSON.stringify(value),encoding:'utf8',timeout:15_000,
    env:{...process.env,PROJECTOR_SOURCE:sourcePath},maxBuffer:100_000});
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
