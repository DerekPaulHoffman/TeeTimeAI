[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$WorkspacePath,
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$NodePath,
  [string]$LogDirectory,
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
# The launching shell may be PowerShell 7. Load this Windows PowerShell
# process's own system modules, not incompatible inherited module paths.
$env:PSModulePath = Join-Path $PSHOME 'Modules'

function Get-CourseDiscoveryRuntimeConfig {
  param([string]$Workspace, [string]$Configuration, [string]$Node)
  $root = (Resolve-Path -LiteralPath $Workspace).Path.TrimEnd('\')
  $configFile = Get-Item -LiteralPath $Configuration
  $nodeFile = Get-Item -LiteralPath $Node
  if ($configFile.PSIsContainer -or $nodeFile.PSIsContainer -or
      ($configFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      $configFile.Length -gt 16384 -or $configFile.Extension -ne '.json' -or
      $configFile.FullName.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath (Join-Path $root 'scripts\automation\course-discovery-supervisor.mjs') -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $root 'node_modules\@openai\codex\package.json') -PathType Leaf)) {
    throw 'INVALID_RUNTIME_PATHS'
  }
  $gitRoot = & git -C $root rev-parse --show-toplevel 2>$null
  if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath([string]$gitRoot).TrimEnd('\') -ne $root) { throw 'STABLE_GIT_WORKSPACE_REQUIRED' }
  $ancestor = $configFile.Directory
  while ($ancestor) {
    if (Test-Path -LiteralPath (Join-Path $ancestor.FullName '.git')) { throw 'CONFIG_MUST_BE_OUTSIDE_REPOSITORIES' }
    $ancestor = $ancestor.Parent
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $allowed = @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')
  $acl = Get-Acl -LiteralPath $configFile.FullName
  if (-not $acl.AreAccessRulesProtected) { throw 'CONFIG_ACL_MUST_BE_PROTECTED' }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) { throw 'CONFIG_ACL_TOO_BROAD' }
  }
  $data = Get-Content -LiteralPath $configFile.FullName -Raw | ConvertFrom-Json
  $keys = @($data.PSObject.Properties.Name)
  if ($keys.Count -ne 3 -or @($keys | Where-Object { $_ -notin @('COURSE_DISCOVERY_API_ORIGIN', 'LOCAL_READER_DEVICE_TOKEN', 'COURSE_DISCOVERY_BROWSER_TRANSPORT') }).Count) { throw 'INVALID_RUNTIME_CONFIG' }
  $origin = [Uri]$data.COURSE_DISCOVERY_API_ORIGIN
  if (-not $origin.IsAbsoluteUri -or $origin.Scheme -ne 'https' -or $origin.UserInfo -or
      $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment -or
      [string]$data.LOCAL_READER_DEVICE_TOKEN -notmatch '^\S{16,4096}$' -or
      $data.COURSE_DISCOVERY_BROWSER_TRANSPORT -notin @('PINNED_HTTP', 'NATIVE_CHROME')) { throw 'INVALID_RUNTIME_CONFIG' }
  return @{ WorkspacePath = $root; ConfigPath = $configFile.FullName; NodePath = $nodeFile.FullName; Environment = $data }
}

try {
  $runtime = Get-CourseDiscoveryRuntimeConfig -Workspace $WorkspacePath -Configuration $ConfigPath -Node $NodePath
  if ($ValidateOnly) {
    [pscustomobject]@{ valid = $true; workspace = $runtime.WorkspacePath; config = $runtime.ConfigPath; node = $runtime.NodePath; credentialsPrinted = $false } | ConvertTo-Json -Compress
    exit 0
  }
  # Credentials are inherited only by the supervisor process. The existing
  # worker strips them before starting the model subprocess.
  foreach ($property in $runtime.Environment.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
  }
  Set-Location -LiteralPath $runtime.WorkspacePath
  if (-not $LogDirectory) { $LogDirectory = Join-Path ([IO.Path]::GetDirectoryName($runtime.ConfigPath)) 'logs' }
  $logs = [IO.Path]::GetFullPath($LogDirectory)
  if ($logs.StartsWith($runtime.WorkspacePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'LOGS_MUST_BE_EXTERNAL' }
  $null = New-Item -Path $logs -ItemType Directory -Force
  & $runtime.NodePath (Join-Path $runtime.WorkspacePath 'scripts\automation\course-discovery-supervisor.mjs') 2>&1 | ForEach-Object {
    $line = [string]$_
    # Only the supervisor's bounded structured event stream is retained.
    try {
      $record = $line | ConvertFrom-Json
      if (-not $record.event -or $line.Length -gt 16384) { throw 'INVALID_LOG_RECORD' }
      $safe = [ordered]@{}
      foreach ($key in @('event', 'active', 'kind', 'code', 'diagnosticCode', 'diagnosticReason', 'jobId', 'firstPickedUpAt', 'startedAt', 'deadlineAt', 'completedAt', 'observedAt', 'activationAcknowledgedAt')) {
        $value = $record.$key
        if ($key -in @('firstPickedUpAt', 'startedAt', 'deadlineAt', 'completedAt', 'observedAt', 'activationAcknowledgedAt')) {
          # PowerShell 7 materializes JSON instants as DateTime. Preserve the
          # actual instant rather than culture-formatting and dropping it.
          if ($value -is [DateTimeOffset]) { $value = $value.ToUniversalTime().ToString('o') }
          elseif ($value -is [DateTime] -and $value.Kind -ne [DateTimeKind]::Unspecified) { $value = $value.ToUniversalTime().ToString('o') }
        }
        if ($null -ne $value -and ([string]$value) -match '^[A-Za-z0-9_.:+-]{1,200}$') { $safe[$key] = $value }
      }
      if ($record.metrics) {
        $metrics = [ordered]@{}
        foreach ($key in @('model', 'framework', 'frameworkRole', 'reasoningEffort', 'modelCalls', 'sourceElapsedMs', 'fixedInspectionModelCalls', 'replayModelCalls', 'browserActions', 'browserStartedAt', 'firstBrowserStartupMs', 'firstOpenStartedAt', 'firstOpenCompletedAt', 'firstOpenElapsedMs', 'providerRequestsObserved', 'responseBytesObserved')) {
          $value = $record.metrics.$key
          if ($key -in @('browserStartedAt', 'firstOpenStartedAt', 'firstOpenCompletedAt')) {
            if ($value -is [DateTimeOffset]) { $value = $value.ToUniversalTime().ToString('o') }
            elseif ($value -is [DateTime] -and $value.Kind -ne [DateTimeKind]::Unspecified) { $value = $value.ToUniversalTime().ToString('o') }
          }
          if ($null -ne $value -and ([string]$value) -match '^[A-Za-z0-9_.:+-]{1,120}$') { $metrics[$key] = $value }
        }
        if ($record.metrics.tokenUsage) {
          $tokens = [ordered]@{}
          foreach ($property in $record.metrics.tokenUsage.PSObject.Properties) {
            if ($property.Name -match '^[a-zA-Z_]{1,40}$' -and ([string]$property.Value) -match '^\d{1,15}$') { $tokens[$property.Name] = $property.Value }
          }
          $metrics.tokenUsage = $tokens
        }
        if ($record.metrics.replayDurationsMs -is [array] -and $record.metrics.replayDurationsMs.Count -le 32) {
          $durations = @($record.metrics.replayDurationsMs | Where-Object { ([string]$_) -match '^\d{1,6}$' -and [int]$_ -le 180000 })
          if ($durations.Count -eq $record.metrics.replayDurationsMs.Count) { $metrics.replayDurationsMs = $durations }
        }
        if ($record.metrics.metricsFinal -is [bool]) { $metrics.metricsFinal = $record.metrics.metricsFinal }
        if ($record.metrics.sourceResumed -is [bool]) { $metrics.sourceResumed = $record.metrics.sourceResumed }
        if ($record.metrics.sourceUsageRecordedLowerBound -is [bool]) { $metrics.sourceUsageRecordedLowerBound = $record.metrics.sourceUsageRecordedLowerBound }
        if ($record.metrics.cleanupWarning -in @('TEMP_DIRECTORY_RETAINED_WITHOUT_AUTH', 'TEMP_CREDENTIAL_CLEANUP_FAILED', 'POST_ACTIVATION_CLEANUP_PENDING')) {
          $metrics.cleanupWarning = $record.metrics.cleanupWarning
        }
        $safe.metrics = $metrics
      }
      $line = $safe | ConvertTo-Json -Compress -Depth 6
    } catch { $line = '{"event":"supervisor_diagnostic_redacted"}' }
    $log = Join-Path $logs ((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd') + '.jsonl')
    if (-not (Test-Path -LiteralPath $log) -or (Get-Item -LiteralPath $log).Length -lt 8388608) {
      Add-Content -LiteralPath $log -Value $line -Encoding UTF8
    }
  }
  exit $LASTEXITCODE
} catch {
  # Do not echo exception messages: JSON/parser/path errors can contain secrets.
  [Console]::Error.WriteLine('COURSE_DISCOVERY_RUNTIME_START_FAILED')
  exit 1
}
