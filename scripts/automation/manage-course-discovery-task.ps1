[CmdletBinding()]
param(
  [ValidateSet('Inspect', 'Register', 'Start', 'Stop', 'Disable', 'Uninstall')][string]$Action = 'Inspect',
  [switch]$Apply,
  [string]$WorkspacePath,
  [string]$ConfigPath,
  [string]$NodePath,
  [string]$LogDirectory,
  [ValidatePattern('^Tee Time Spot Course Discovery(?: [A-Za-z0-9_-]{1,40})?$')][string]$TaskName = 'Tee Time Spot Course Discovery'
)

$ErrorActionPreference = 'Stop'
# PowerShell 7 keeps its own modules outside Windows PowerShell's inbox
# ScheduledTasks module. Keep both trusted roots, never inherited user paths.
$windowsPowerShellModules = [IO.Path]::Combine([Environment]::GetFolderPath('Windows'), 'System32\WindowsPowerShell\v1.0\Modules')
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $windowsPowerShellModules
$taskPath = '\TeeTimeSpot\'
$marker = 'Tee Time Spot course discovery supervisor; managed lifecycle v1'

function ConvertTo-CourseDiscoveryHeartbeatInstant {
  param($Value)
  # Windows PowerShell keeps JSON timestamps as strings, while PowerShell 7
  # may return DateTime. Never stringify a typed date: that loses its offset
  # and fractional seconds before a culture/local-time parse.
  if ($Value -is [DateTimeOffset]) { return $Value.ToUniversalTime() }
  if ($Value -is [DateTime]) {
    if ($Value.Kind -eq [DateTimeKind]::Unspecified) { return $null }
    return ([DateTimeOffset]$Value).ToUniversalTime()
  }
  if ($Value -isnot [string] -or $Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$') { return $null }
  $parsed = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$parsed)) { return $null }
  return $parsed.ToUniversalTime()
}

try {
  if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
  Import-Module -Name (Join-Path $windowsPowerShellModules 'ScheduledTasks\ScheduledTasks.psd1') -ErrorAction Stop
  # Inspect the exact name before any mutation. Other tasks are never replaced.
  $existing = Get-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -ErrorAction SilentlyContinue
  if ($existing -and $existing.Description -ne $marker) { throw 'UNRECOGNIZED_EXISTING_TASK' }
  $summary = [ordered]@{ action = $Action; apply = [bool]$Apply; taskName = $TaskName; taskPath = $taskPath; exists = [bool]$existing }
  if ($existing) {
    $info = Get-ScheduledTaskInfo -InputObject $existing
    $summary.state = [string]$existing.State
    $summary.lastTaskResult = $info.LastTaskResult
    $summary.lastRunTime = $info.LastRunTime.ToString('o')
    $summary.existingExecutable = [string]$existing.Actions[0].Execute
    if (-not $LogDirectory -and $existing.Actions[0].Arguments -match '-LogDirectory "([^"]+)"') { $LogDirectory = $Matches[1] }
  }
  $plannedAction = $null
  if ($Action -eq 'Register') {
    if (-not $WorkspacePath -or -not $ConfigPath) { throw 'EXPLICIT_RUNTIME_PATHS_REQUIRED' }
    if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
    $root = (Resolve-Path -LiteralPath $WorkspacePath).Path.TrimEnd('\')
    $wrapper = Join-Path $root 'scripts\automation\run-course-discovery-supervisor.ps1'
    $config = (Resolve-Path -LiteralPath $ConfigPath).Path
    $node = (Resolve-Path -LiteralPath $NodePath).Path
    if (-not $LogDirectory) { $LogDirectory = Join-Path ([IO.Path]::GetDirectoryName($config)) 'logs' }
    $LogDirectory = [IO.Path]::GetFullPath($LogDirectory)
    if ($LogDirectory.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'LOGS_MUST_BE_EXTERNAL' }
    foreach ($value in @($root, $wrapper, $config, $node, $LogDirectory)) {
      if ($value -match '["\r\n]') { throw 'INVALID_RUNTIME_PATH' }
    }
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    # Validation reads the protected external file, but returns paths only.
    & $powershell -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $wrapper -WorkspacePath $root -ConfigPath $config -NodePath $node -ValidateOnly | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'RUNTIME_VALIDATION_FAILED' }
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "{0}" -WorkspacePath "{1}" -ConfigPath "{2}" -NodePath "{3}" -LogDirectory "{4}"' -f $wrapper, $root, $config, $node, $LogDirectory
    $plannedAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $root
    $summary.workspace = $root
    $summary.config = $config
    $summary.node = $node
    $summary.trigger = 'Current user logon; explicit Start is also available'
    $summary.restartCount = 3
    $summary.restartIntervalSeconds = 60
    $summary.hiddenWindow = $true
    $summary.credentialsInArguments = $false
    $summary.replacesManagedTask = [bool]$existing
  }
  if ($LogDirectory) {
    $summary.logDirectory = [IO.Path]::GetFullPath($LogDirectory)
    $summary.heartbeatStatus = 'unknown'
    if (Test-Path -LiteralPath $LogDirectory -PathType Container) {
      $latest = Get-ChildItem -LiteralPath $LogDirectory -File -Filter '*.jsonl' | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}\.jsonl$' } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
      if ($latest) {
        $records = @(Get-Content -LiteralPath $latest.FullName -Tail 200 | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } })
        $heartbeat = $records | Where-Object { $_.event -in @('supervisor_started', 'poll_completed') } | Select-Object -Last 1
        $pollFailed = $false
        foreach ($record in $records) {
          if ($record.event -eq 'poll_failed') { $pollFailed = $true }
          elseif ($record.event -eq 'poll_completed') { $summary.pollStatus = if ($pollFailed) { 'failed' } else { 'completed' }; $pollFailed = $false }
        }
        if ($heartbeat) {
          $at = ConvertTo-CourseDiscoveryHeartbeatInstant $heartbeat.observedAt
          if ($null -eq $at) {
            $summary.heartbeatStatus = 'invalid'
          } else {
            $summary.lastHeartbeatAt = $at.ToString('o')
            $summary.heartbeatAgeSeconds = [Math]::Floor(([DateTimeOffset]::UtcNow - $at).TotalSeconds)
            $summary.heartbeatStatus = if ($summary.heartbeatAgeSeconds -lt 0) { 'future' } elseif ($summary.heartbeatAgeSeconds -le 60) { 'fresh' } else { 'stale' }
          }
        }
      }
    }
    $summary.ready = [bool]($existing -and $existing.State -eq 'Running' -and $summary.heartbeatStatus -eq 'fresh' -and $summary.pollStatus -eq 'completed')
  }
  $summary | ConvertTo-Json -Compress
  if (-not $Apply -or $Action -eq 'Inspect') { exit 0 }
  if ($Action -eq 'Register') {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    $scheduler = New-Object -ComObject Schedule.Service
    $scheduler.Connect()
    try { $null = $scheduler.GetFolder($taskPath) }
    catch { $null = $scheduler.GetFolder('\').CreateFolder('TeeTimeSpot') }
    Register-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -Action $plannedAction -Trigger $trigger -Principal $principal -Settings $settings -Description $marker -Force | Out-Null
  } else {
    if (-not $existing) { throw 'MANAGED_TASK_NOT_FOUND' }
    switch ($Action) {
      'Start' { Start-ScheduledTask -InputObject $existing }
      'Stop' { Stop-ScheduledTask -InputObject $existing }
      'Disable' { Stop-ScheduledTask -InputObject $existing; Disable-ScheduledTask -InputObject $existing | Out-Null }
      'Uninstall' { Stop-ScheduledTask -InputObject $existing; Unregister-ScheduledTask -InputObject $existing -Confirm:$false }
    }
  }
  [pscustomobject]@{ completed = $true; action = $Action; taskName = $TaskName } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine('COURSE_DISCOVERY_TASK_ACTION_FAILED')
  exit 1
}
