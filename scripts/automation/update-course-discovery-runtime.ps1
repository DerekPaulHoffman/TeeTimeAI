[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$RuntimeVersion,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9-]{36}$')][string]$OwnerThreadId,
  [ValidateRange(1,16)][int]$DrainMinutes = 15,
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$changed = $false; $stoppedByUs = $false; $drainOwned = $false; $lockStream = $null
$nonce = [Guid]::NewGuid().ToString()
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$ps5 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$manager = Join-Path $PSScriptRoot 'manage-course-discovery-task.ps1'
function NativeText([string]$Program,[string[]]$Arguments) {
  $priorPreference=$ErrorActionPreference
  try { $ErrorActionPreference='Continue'; $value=& $Program @Arguments 2>$null; $code=$LASTEXITCODE }
  finally { $ErrorActionPreference=$priorPreference }
  if($code -ne 0){throw 'RUNTIME_PROOF_COMMAND_FAILED'}
  return ($value -join [Environment]::NewLine).Trim()
}
function GitText([string]$Workspace,[string[]]$Arguments) { NativeText 'git.exe' (@('-C',$Workspace)+$Arguments) }
function InspectRuntime { (NativeText $ps5 @('-NoProfile','-NonInteractive','-File',$manager,'-Action','Inspect')) | ConvertFrom-Json }
function TaskDigest { $xml=Export-ScheduledTask -TaskName 'Tee Time Spot Course Discovery' -TaskPath '\TeeTimeSpot\';
  $sha=[Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($xml)))).Replace('-','') } finally {$sha.Dispose()} }
function Supervisors { @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and
  $_.CommandLine.Replace('/','\').IndexOf((Join-Path $runtimeRoot 'scripts\automation\course-discovery-supervisor.mjs'),[StringComparison]::OrdinalIgnoreCase) -ge 0 }) }
function AtomicJson([string]$Path,$Value) {
  $temp=Join-Path ([IO.Path]::GetDirectoryName($Path)) ([Guid]::NewGuid().ToString()+'.tmp')
  try { [IO.File]::WriteAllText($temp,($Value|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
    if(Test-Path -LiteralPath $Path){[IO.File]::Replace($temp,$Path,[NullString]::Value)}else{[IO.File]::Move($temp,$Path)}
  } finally {if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp}}
}
function RefreshDrain {
  if(Test-Path -LiteralPath $drainPath){
    $priorFile=Get-Item -LiteralPath $drainPath
    if(($priorFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $priorFile.Length -gt 4096){throw 'INVALID_DRAIN_CONTROL'}
    $prior=Get-Content -LiteralPath $drainPath -Raw|ConvertFrom-Json
    if($prior.purpose -cne 'UPGRADE_READER_RUNTIME'){throw 'DRAIN_CONTROL_CHANGED'}
    if($prior.nonce -cne $nonce){
      $issued=[DateTimeOffset]::Parse($prior.issuedAt);$expires=[DateTimeOffset]::Parse($prior.expiresAt)
      if($drainOwned -or $expires -gt [DateTimeOffset]::UtcNow -or $expires -le $issued -or
         ($expires-$issued).TotalSeconds -gt 180){throw 'DRAIN_CONTROL_CHANGED'}
    }
  }
  $at=[DateTimeOffset]::UtcNow
  AtomicJson $drainPath @{schemaVersion=1;purpose='UPGRADE_READER_RUNTIME';nonce=$nonce;fromRuntimeVersion=$oldHead;
    targetRuntimeVersion=$RuntimeVersion;issuedAt=$at.ToString('o');expiresAt=$at.AddMinutes(3).ToString('o')}
  $script:drainOwned=$true
}
function WaitIdle([string]$Expected,[DateTimeOffset]$Since,[int]$Seconds) {
  $until=[DateTimeOffset]::UtcNow.AddSeconds($Seconds); $seen=[Collections.Generic.HashSet[string]]::new()
  do {
    RefreshDrain
    $state=InspectRuntime
    if($state.ready -and $state.runtimeVersion -ceq $Expected -and $state.drainNonce -ceq $nonce -and
       $state.drained -eq $true -and $state.activeOperations -eq 0 -and $state.lastHeartbeatAt -and
       [DateTimeOffset]$state.lastHeartbeatAt -ge $Since){[void]$seen.Add([string]$state.lastHeartbeatAt)}
    if($seen.Count -ge 2){return $state}
    Start-Sleep -Seconds 2
  }while([DateTimeOffset]::UtcNow -lt $until)
  throw 'RUNTIME_DRAIN_OR_STARTUP_NOT_PROVED'
}
try {
  if($env:OS -ne 'Windows_NT' -or $env:CODEX_THREAD_ID -cne $OwnerThreadId){throw 'ORIGINAL_NATIVE_OWNER_REQUIRED'}
  $systemModules=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
  Import-Module (Join-Path $systemModules 'ScheduledTasks\ScheduledTasks.psd1') -ErrorAction Stop
  $task=Get-ScheduledTask -TaskName 'Tee Time Spot Course Discovery' -TaskPath '\TeeTimeSpot\'
  if($task.Description -cne 'Tee Time Spot course discovery supervisor; managed lifecycle v1' -or @($task.Actions).Count -ne 1 -or
     $task.Actions[0].Execute -ine $ps5 -or $task.State -ne 'Running'){throw 'EXPECTED_RUNNING_MANAGED_TASK_REQUIRED'}
  $argsPattern='^-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "([^"]+)" -WorkspacePath "([^"]+)" -ConfigPath "([^"]+)" -NodePath "([^"]+)" -LogDirectory "([^"]+)"$'
  if($task.Actions[0].Arguments -cnotmatch $argsPattern){throw 'MANAGED_TASK_ACTION_CHANGED'}
  $wrapper=$Matches[1];$runtimeRoot=$Matches[2];$config=$Matches[3];$node=$Matches[4];$logs=$Matches[5]
  if($wrapper -ine (Join-Path $runtimeRoot 'scripts\automation\run-course-discovery-supervisor.ps1') -or
     $task.Actions[0].WorkingDirectory -ine $runtimeRoot){throw 'MANAGED_TASK_PATHS_CHANGED'}
  $private=[IO.Path]::GetDirectoryName($config);$activationPath=Join-Path $private 'activation-receipt.json';$drainPath=Join-Path $private 'drain-request.json'
  $activation=Get-Content -LiteralPath $activationPath -Raw|ConvertFrom-Json
  if($activation.enabled -ne $true -or $activation.workspacePath -ine $runtimeRoot -or $activation.model -cne 'gpt-6.1-sol' -or
     $activation.authentication -notlike '*ChatGPT*' -or $activation.runtimeMode -cne 'STAGEHAND_SOL'){throw 'ACTIVE_SOL_READER_SCOPE_REQUIRED'}
  if((GitText $sourceRoot @('rev-parse','HEAD')) -cne $RuntimeVersion -or (GitText $sourceRoot @('status','--porcelain'))){throw 'CLEAN_COMMITTED_SOURCE_REQUIRED'}
  if((GitText $sourceRoot @('branch','--show-current')) -in @('main','')){throw 'OWNED_SOURCE_BRANCH_REQUIRED'}
  [void](GitText $sourceRoot @('fetch','origin','main'))
  if((GitText $sourceRoot @('rev-parse','origin/main')) -cne $RuntimeVersion){throw 'CURRENT_PUBLISHED_RUNTIME_REQUIRED'}
  if((GitText $sourceRoot @('remote','get-url','origin')) -cne (GitText $runtimeRoot @('remote','get-url','origin'))){throw 'RUNTIME_REPOSITORY_CHANGED'}
  if((GitText $runtimeRoot @('status','--porcelain'))){throw 'DIRTY_MANAGED_RUNTIME'}
  $oldHead=GitText $runtimeRoot @('rev-parse','HEAD')
  [void](GitText $runtimeRoot @('fetch','origin','main'))
  [void](GitText $runtimeRoot @('merge-base','--is-ancestor',$oldHead,$RuntimeVersion))
  $differences=GitText $runtimeRoot @('diff','--name-only',$oldHead,$RuntimeVersion)
  if(@($differences -split '\r?\n'|Where-Object{$_ -match '^(?:package(?:-lock)?\.json|prisma/|tools/local-chrome-reader/)'}).Count){throw 'DEPENDENCY_SCHEMA_OR_INSTALLED_READER_ROLLOUT_REQUIRED'}
  $proof=(NativeText $node @((Join-Path $PSScriptRoot 'course-discovery-runtime-release.mjs'),'--runtime-sha',$RuntimeVersion))|ConvertFrom-Json
  if($proof.runtimeVersion -cne $RuntimeVersion -or $proof.ciConclusion -cne 'success'){throw 'EXACT_RELEASE_PROOF_REQUIRED'}
  $validation=(NativeText $ps5 @('-NoProfile','-NonInteractive','-File',$wrapper,'-WorkspacePath',$runtimeRoot,'-ConfigPath',$config,'-NodePath',$node,'-ValidateOnly'))|ConvertFrom-Json
  if($validation.valid -ne $true){throw 'RUNTIME_VALIDATION_FAILED'}
  if(-not $validation.runtimeVersion){throw 'NATIVE_DRAIN_PROTOCOL_BOOTSTRAP_REQUIRED'}
  if($validation.runtimeVersion -cne $oldHead){throw 'RUNTIME_VALIDATION_FAILED'}
  $state=InspectRuntime
  if(-not $state.ready -or $state.runtimeVersion -cne $oldHead){throw 'NATIVE_DRAIN_PROTOCOL_BOOTSTRAP_REQUIRED'}
  if($state.workerMode -cne 'STAGEHAND_SOL'){throw 'CURRENT_STAGEHAND_MODE_REQUIRED'}
  if($oldHead -ceq $RuntimeVersion){@{outcome='already_current';runtimeVersion=$RuntimeVersion;acceptanceRestartProof=$false}|ConvertTo-Json -Compress;exit 0}
  if(-not $Apply){@{outcome='ready_to_update';fromRuntimeVersion=$oldHead;runtimeVersion=$RuntimeVersion;apply=$false;acceptanceRestartProof=$false}|ConvertTo-Json -Compress;exit 0}
  $lockStream=[IO.File]::Open((Join-Path $private 'runtime-update.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $configHash=(Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash;$taskHash=TaskDigest
  $oldProcesses=@(Supervisors);if($oldProcesses.Count -ne 1){throw 'SINGLE_MANAGED_SUPERVISOR_REQUIRED'}
  $requestedAt=[DateTimeOffset]::UtcNow
  [void](WaitIdle $oldHead $requestedAt ($DrainMinutes*60))
  RefreshDrain
  if((GitText $runtimeRoot @('rev-parse','HEAD')) -cne $oldHead -or (GitText $runtimeRoot @('status','--porcelain'))){throw 'MANAGED_RUNTIME_CHANGED_DURING_DRAIN'}
  [void](NativeText $ps5 @('-NoProfile','-NonInteractive','-File',$manager,'-Action','Stop','-Apply'));$stoppedByUs=$true
  try {
    $until=[DateTimeOffset]::UtcNow.AddSeconds(30)
    while(@(Supervisors).Count -and [DateTimeOffset]::UtcNow -lt $until){Start-Sleep -Milliseconds 500}
    if(@(Supervisors).Count){throw 'OLD_SUPERVISOR_STILL_RUNNING'}
    [void](GitText $runtimeRoot @('merge','--ff-only',$RuntimeVersion));$changed=$true
    if((GitText $runtimeRoot @('rev-parse','HEAD')) -cne $RuntimeVersion -or (GitText $runtimeRoot @('status','--porcelain'))){throw 'EXACT_RUNTIME_UPDATE_FAILED'}
    [void](NativeText $ps5 @('-NoProfile','-NonInteractive','-File',$wrapper,'-WorkspacePath',$runtimeRoot,'-ConfigPath',$config,'-NodePath',$node,'-ValidateOnly'))
  } finally {
    if((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -cne $configHash -or (TaskDigest) -cne $taskHash){throw 'RUNTIME_CONFIGURATION_CHANGED'}
    if($stoppedByUs){RefreshDrain;[void](NativeText $ps5 @('-NoProfile','-NonInteractive','-File',$manager,'-Action','Start','-Apply'));$stoppedByUs=$false}
  }
  $restartedAt=[DateTimeOffset]::UtcNow
  $healthy=WaitIdle $RuntimeVersion $restartedAt 90
  $newProcesses=@(Supervisors)
  if($newProcesses.Count -ne 1 -or $newProcesses[0].ProcessId -eq $oldProcesses[0].ProcessId){throw 'NEW_SINGLETON_RUNTIME_NOT_PROVED'}
  if((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -cne $configHash -or (TaskDigest) -cne $taskHash){throw 'RUNTIME_CONFIGURATION_CHANGED'}
  foreach($item in @{headSha=$RuntimeVersion;deploymentId=$proof.deployment.deploymentId;preparedAt=[DateTimeOffset]::UtcNow.ToString('o');
    startupVerified=$true;firstHealthyPollAt=$healthy.lastHeartbeatAt;acceptanceComplete=$false;
    releaseEvidence=@{sha=$RuntimeVersion;ciRunId=$proof.ciRunId;ciConclusion='success';deploymentProof=$proof.deployment};
    currentRecoveryEvidence=@{processId=$newProcesses[0].ProcessId;freshHeartbeatAt=$healthy.lastHeartbeatAt;acceptanceRestartProof=$false;liveAcceptance='PENDING'}}.GetEnumerator()){
    $activation|Add-Member -NotePropertyName $item.Key -NotePropertyValue $item.Value -Force
  }
  AtomicJson $activationPath $activation
  @{outcome='runtime_updated';fromRuntimeVersion=$oldHead;runtimeVersion=$RuntimeVersion;processId=$newProcesses[0].ProcessId;
    freshHeartbeatAt=$healthy.lastHeartbeatAt;configurationChanged=$false;acceptanceRestartProof=$false}|ConvertTo-Json -Compress
} catch {
  $reason=if($_.Exception.Message -cmatch '^[A-Z_]{1,100}$'){$_.Exception.Message}else{'RUNTIME_UPDATE_FAILED'}
  @{outcome='blocked';reasonCode=$reason;stateChanged=$changed;acceptanceRestartProof=$false}|ConvertTo-Json -Compress
  exit 1
} finally {
  if($drainOwned -and (Test-Path -LiteralPath $drainPath)){
    try {$current=Get-Content -LiteralPath $drainPath -Raw|ConvertFrom-Json;if($current.nonce -ceq $nonce){Remove-Item -LiteralPath $drainPath}}catch{}
  }
  if($lockStream){$lockStream.Dispose()}
}
