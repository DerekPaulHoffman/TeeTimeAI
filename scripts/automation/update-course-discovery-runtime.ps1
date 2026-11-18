[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$RuntimeVersion,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9-]{36}$')][string]$OwnerThreadId,
  [ValidateRange(1,16)][int]$DrainMinutes = 15,
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$changed = $false; $stoppedByUs = $false; $drainOwned = $false; $lockStream = $null
$phase='VALIDATE_NATIVE_OWNER';$mutationAttempted=$false;$drainAttempted=$false
$taskStopAttempted=$false;$runtimeUpdateAttempted=$false;$taskStartAttempted=$false;$activationWriteAttempted=$false
$nonce = [Guid]::NewGuid().ToString()
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$ps5 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$manager = Join-Path $PSScriptRoot 'manage-course-discovery-task.ps1'
function NativeText([string]$Program,[string[]]$Arguments,[switch]$ReleaseProof) {
  $priorPreference=$ErrorActionPreference
  try { $ErrorActionPreference='Continue'; $value=& $Program @Arguments 2>$null; $code=$LASTEXITCODE }
  finally { $ErrorActionPreference=$priorPreference }
  if($code -ne 0){
    $releaseCode=$null
    if($ReleaseProof){
      try {
        $outputText=($value -join [Environment]::NewLine).Trim()
        if($outputText.Length -le 4096){
          $child=$outputText|ConvertFrom-Json
          $names=@($child.PSObject.Properties.Name|Sort-Object)
          if(($names -join ',') -ceq 'outcome,reasonCode,schemaVersion' -and $child.schemaVersion -eq 1 -and $child.outcome -ceq 'blocked' -and
            $child.reasonCode -cin @('INVALID_RUNTIME_VERSION','RUNTIME_CI_REQUIRED','RUNTIME_CI_PENDING_TIMEOUT',
              'RUNTIME_GIT_DEPLOYMENT_REQUIRED','RUNTIME_CANONICAL_ALIASES_REQUIRED','INVALID_RUNTIME_PROOF_ARGUMENT','RUNTIME_RELEASE_PROOF_UNAVAILABLE')){
            $releaseCode=$child.reasonCode
          }
        }
      }catch{ }
    }
    if($releaseCode){throw $releaseCode}
    throw 'RUNTIME_PROOF_COMMAND_FAILED'
  }
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
  $script:phase='VALIDATE_DRAIN_CONTROL'
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
  $script:phase='WRITE_DRAIN_CONTROL';$script:mutationAttempted=$true;$script:drainAttempted=$true
  AtomicJson $drainPath @{schemaVersion=1;purpose='UPGRADE_READER_RUNTIME';nonce=$nonce;fromRuntimeVersion=$oldHead;
    targetRuntimeVersion=$RuntimeVersion;issuedAt=$at.ToString('o');expiresAt=$at.AddMinutes(3).ToString('o')}
  $script:drainOwned=$true
}
function WaitIdle([string]$Expected,[DateTimeOffset]$Since,[int]$Seconds) {
  $until=[DateTimeOffset]::UtcNow.AddSeconds($Seconds); $seen=[Collections.Generic.HashSet[string]]::new()
  do {
    RefreshDrain
    $script:phase='WAIT_DRAIN_ACKNOWLEDGEMENT'
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
  $phase='VALIDATE_MANAGED_TASK'
  $systemModules=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
  # The native worker can inherit PowerShell 7 paths. Load inbox modules from
  # this Windows PowerShell host, matching the existing managed-task wrapper.
  $env:PSModulePath=(Join-Path $PSHOME 'Modules')+[IO.Path]::PathSeparator+$systemModules
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
  $phase='VALIDATE_ACTIVATION'
  if($activation.enabled -ne $true -or $activation.workspacePath -ine $runtimeRoot -or $activation.model -cne 'gpt-6.1-sol' -or
     $activation.authentication -notlike '*ChatGPT*' -or $activation.runtimeMode -cne 'STAGEHAND_SOL'){throw 'ACTIVE_SOL_READER_SCOPE_REQUIRED'}
  $phase='VALIDATE_SOURCE'
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
  $phase='QUALIFY_RELEASE'
  $proof=(NativeText $node @((Join-Path $PSScriptRoot 'course-discovery-runtime-release.mjs'),'--runtime-sha',$RuntimeVersion) -ReleaseProof)|ConvertFrom-Json
  if($proof.runtimeVersion -cne $RuntimeVersion -or $proof.ciConclusion -cne 'success'){throw 'EXACT_RELEASE_PROOF_REQUIRED'}
  $phase='VALIDATE_READER'
  $validation=(NativeText $ps5 @('-NoProfile','-NonInteractive','-File',$wrapper,'-WorkspacePath',$runtimeRoot,'-ConfigPath',$config,'-NodePath',$node,'-ValidateOnly'))|ConvertFrom-Json
  if($validation.valid -ne $true){throw 'RUNTIME_VALIDATION_FAILED'}
  if(-not $validation.runtimeVersion){throw 'NATIVE_DRAIN_PROTOCOL_BOOTSTRAP_REQUIRED'}
  if($validation.runtimeVersion -cne $oldHead){throw 'RUNTIME_VALIDATION_FAILED'}
  $state=InspectRuntime
  if(-not $state.ready -or $state.runtimeVersion -cne $oldHead){throw 'NATIVE_DRAIN_PROTOCOL_BOOTSTRAP_REQUIRED'}
  if($state.workerMode -cne 'STAGEHAND_SOL'){throw 'CURRENT_STAGEHAND_MODE_REQUIRED'}
  if($oldHead -ceq $RuntimeVersion){@{outcome='already_current';runtimeVersion=$RuntimeVersion;acceptanceRestartProof=$false}|ConvertTo-Json -Compress;exit 0}
  if(-not $Apply){@{outcome='ready_to_update';fromRuntimeVersion=$oldHead;runtimeVersion=$RuntimeVersion;apply=$false;acceptanceRestartProof=$false}|ConvertTo-Json -Compress;exit 0}
  $phase='ACQUIRE_UPDATE_LOCK';$mutationAttempted=$true
  $lockStream=[IO.File]::Open((Join-Path $private 'runtime-update.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $phase='CAPTURE_CONFIGURATION'
  $configHash=(Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash;$taskHash=TaskDigest
  $phase='VALIDATE_SINGLETON'
  $oldProcesses=@(Supervisors);if($oldProcesses.Count -ne 1){throw 'SINGLE_MANAGED_SUPERVISOR_REQUIRED'}
  $requestedAt=[DateTimeOffset]::UtcNow
  [void](WaitIdle $oldHead $requestedAt ($DrainMinutes*60))
  RefreshDrain
  $phase='REVALIDATE_DRAINED_RUNTIME'
  if((GitText $runtimeRoot @('rev-parse','HEAD')) -cne $oldHead -or (GitText $runtimeRoot @('status','--porcelain'))){throw 'MANAGED_RUNTIME_CHANGED_DURING_DRAIN'}
  $phase='STOP_MANAGED_TASK';$taskStopAttempted=$true
  [void](NativeText $ps5 @('-NoProfile','-NonInteractive','-File',$manager,'-Action','Stop','-Apply'));$stoppedByUs=$true
  try {
    $phase='WAIT_SUPERVISOR_STOP'
    $until=[DateTimeOffset]::UtcNow.AddSeconds(30)
    while(@(Supervisors).Count -and [DateTimeOffset]::UtcNow -lt $until){Start-Sleep -Milliseconds 500}
    if(@(Supervisors).Count){throw 'OLD_SUPERVISOR_STILL_RUNNING'}
    $phase='UPDATE_RUNTIME';$runtimeUpdateAttempted=$true
    [void](GitText $runtimeRoot @('merge','--ff-only',$RuntimeVersion));$changed=$true
    if((GitText $runtimeRoot @('rev-parse','HEAD')) -cne $RuntimeVersion -or (GitText $runtimeRoot @('status','--porcelain'))){throw 'EXACT_RUNTIME_UPDATE_FAILED'}
    $phase='VALIDATE_UPDATED_RUNTIME'
    [void](NativeText $ps5 @('-NoProfile','-NonInteractive','-File',$wrapper,'-WorkspacePath',$runtimeRoot,'-ConfigPath',$config,'-NodePath',$node,'-ValidateOnly'))
  } finally {
    if((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -cne $configHash -or (TaskDigest) -cne $taskHash){throw 'RUNTIME_CONFIGURATION_CHANGED'}
    if($stoppedByUs){RefreshDrain;$phase='START_MANAGED_TASK';$taskStartAttempted=$true;[void](NativeText $ps5 @('-NoProfile','-NonInteractive','-File',$manager,'-Action','Start','-Apply'));$stoppedByUs=$false}
  }
  $restartedAt=[DateTimeOffset]::UtcNow
  $healthy=WaitIdle $RuntimeVersion $restartedAt 90
  $phase='VERIFY_UPDATED_SINGLETON'
  $newProcesses=@(Supervisors)
  if($newProcesses.Count -ne 1 -or $newProcesses[0].ProcessId -eq $oldProcesses[0].ProcessId){throw 'NEW_SINGLETON_RUNTIME_NOT_PROVED'}
  if((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -cne $configHash -or (TaskDigest) -cne $taskHash){throw 'RUNTIME_CONFIGURATION_CHANGED'}
  foreach($item in @{headSha=$RuntimeVersion;deploymentId=$proof.deployment.deploymentId;preparedAt=[DateTimeOffset]::UtcNow.ToString('o');
    startupVerified=$true;firstHealthyPollAt=$healthy.lastHeartbeatAt;acceptanceComplete=$false;
    releaseEvidence=@{sha=$RuntimeVersion;ciRunId=$proof.ciRunId;ciConclusion='success';deploymentProof=$proof.deployment};
    currentRecoveryEvidence=@{processId=$newProcesses[0].ProcessId;freshHeartbeatAt=$healthy.lastHeartbeatAt;acceptanceRestartProof=$false;liveAcceptance='PENDING'}}.GetEnumerator()){
    $activation|Add-Member -NotePropertyName $item.Key -NotePropertyValue $item.Value -Force
  }
  $phase='WRITE_ACTIVATION_RECEIPT';$activationWriteAttempted=$true
  AtomicJson $activationPath $activation
  @{outcome='runtime_updated';fromRuntimeVersion=$oldHead;runtimeVersion=$RuntimeVersion;processId=$newProcesses[0].ProcessId;
    freshHeartbeatAt=$healthy.lastHeartbeatAt;configurationChanged=$false;acceptanceRestartProof=$false}|ConvertTo-Json -Compress
} catch {
  # Closed codes only: exception text, stderr, paths, config and task XML never
  # cross the diagnostic boundary. Attempt flags precede potentially mutating
  # calls; stateChanged=false alone is not proof that no mutation occurred.
  $codes=@('ORIGINAL_NATIVE_OWNER_REQUIRED','EXPECTED_RUNNING_MANAGED_TASK_REQUIRED','MANAGED_TASK_ACTION_CHANGED',
    'MANAGED_TASK_PATHS_CHANGED','ACTIVE_SOL_READER_SCOPE_REQUIRED','CLEAN_COMMITTED_SOURCE_REQUIRED','OWNED_SOURCE_BRANCH_REQUIRED',
    'CURRENT_PUBLISHED_RUNTIME_REQUIRED','RUNTIME_REPOSITORY_CHANGED','DIRTY_MANAGED_RUNTIME',
    'DEPENDENCY_SCHEMA_OR_INSTALLED_READER_ROLLOUT_REQUIRED','EXACT_RELEASE_PROOF_REQUIRED','RUNTIME_VALIDATION_FAILED',
    'NATIVE_DRAIN_PROTOCOL_BOOTSTRAP_REQUIRED','CURRENT_STAGEHAND_MODE_REQUIRED','SINGLE_MANAGED_SUPERVISOR_REQUIRED',
    'INVALID_DRAIN_CONTROL','DRAIN_CONTROL_CHANGED','RUNTIME_DRAIN_OR_STARTUP_NOT_PROVED','MANAGED_RUNTIME_CHANGED_DURING_DRAIN',
    'OLD_SUPERVISOR_STILL_RUNNING','EXACT_RUNTIME_UPDATE_FAILED','RUNTIME_CONFIGURATION_CHANGED','NEW_SINGLETON_RUNTIME_NOT_PROVED',
    'RUNTIME_PROOF_COMMAND_FAILED','RUNTIME_UPDATE_FAILED','INVALID_RUNTIME_VERSION','RUNTIME_CI_REQUIRED','RUNTIME_CI_PENDING_TIMEOUT',
    'RUNTIME_GIT_DEPLOYMENT_REQUIRED','RUNTIME_CANONICAL_ALIASES_REQUIRED','INVALID_RUNTIME_PROOF_ARGUMENT','RUNTIME_RELEASE_PROOF_UNAVAILABLE')
  $reason=if($codes -ccontains $_.Exception.Message){$_.Exception.Message}else{'RUNTIME_UPDATE_FAILED'}
  @{schemaVersion=1;outcome='blocked';reasonCode=$reason;phase=$phase;apply=[bool]$Apply;stateChanged=[bool]$changed;
    mutationAttempted=[bool]$mutationAttempted;drainAttempted=[bool]$drainAttempted;taskStopAttempted=[bool]$taskStopAttempted;
    runtimeUpdateAttempted=[bool]$runtimeUpdateAttempted;taskStartAttempted=[bool]$taskStartAttempted;
    activationWriteAttempted=[bool]$activationWriteAttempted;acceptanceRestartProof=$false}|ConvertTo-Json -Compress
  exit 1
} finally {
  if($drainOwned -and (Test-Path -LiteralPath $drainPath)){
    try {$current=Get-Content -LiteralPath $drainPath -Raw|ConvertFrom-Json;if($current.nonce -ceq $nonce){Remove-Item -LiteralPath $drainPath}}catch{}
  }
  if($lockStream){$lockStream.Dispose()}
}
