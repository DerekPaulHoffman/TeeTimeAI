import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

test('Windows updater requires two fresh idle acknowledgements and preserves a foreign live drain', { skip: process.platform !== 'win32' }, () => {
  const script = resolve('scripts/automation/update-course-discovery-runtime.ps1');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference='Stop'
    $tokens=$null;$errors=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'Syntax errors'}
    foreach($name in @('AtomicJson','RefreshDrain','WaitIdle')){
      $function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
      Invoke-Expression $function.Extent.Text
    }
    $temp=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString()+'.json')
    try {
      $drainPath=$temp;$nonce=[Guid]::NewGuid().ToString();$drainOwned=$false;$oldHead='${'a'.repeat(40)}';$RuntimeVersion='${'b'.repeat(40)}'
      RefreshDrain
      if(-not $drainOwned -or (Get-Content -LiteralPath $temp -Raw|ConvertFrom-Json).nonce -cne $nonce){throw 'Own request absent'}
      $foreign=Get-Content -LiteralPath $temp -Raw|ConvertFrom-Json;$foreign.nonce=[Guid]::NewGuid().ToString();AtomicJson $temp $foreign
      $drainOwned=$false;$denied=$false
      try {RefreshDrain}catch{$denied=$_.Exception.Message -ceq 'DRAIN_CONTROL_CHANGED'}
      if(-not $denied -or (Get-Content -LiteralPath $temp -Raw|ConvertFrom-Json).nonce -cne $foreign.nonce){throw 'Foreign request overwritten'}
      $foreign.issuedAt=[DateTimeOffset]::UtcNow.AddMinutes(-3).ToString('o');$foreign.expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(-1).ToString('o');AtomicJson $temp $foreign
      RefreshDrain
      if((Get-Content -LiteralPath $temp -Raw|ConvertFrom-Json).nonce -cne $nonce){throw 'Expired control not recovered'}
      $script:count=0;$since=[DateTimeOffset]::UtcNow
      function InspectRuntime {
        $script:count++
        # Stale and busy observations cannot contribute an acknowledgement.
        $at=if($script:count -eq 1){$since.AddSeconds(-1)}else{$since.AddSeconds($script:count)}
        @{ready=$true;runtimeVersion=$oldHead;drainNonce=$nonce;drained=($script:count -ne 2);activeOperations=0;lastHeartbeatAt=$at.ToString('o')}
      }
      function Start-Sleep {param($Seconds)}
      [void](WaitIdle $oldHead $since 10)
      if($count -ne 4){throw 'Idle proof accepted stale or busy poll'}
      'WINDOWS_RUNTIME_PROTOCOL_PASSED'
    } finally {if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp}}
  `], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.match(output, /WINDOWS_RUNTIME_PROTOCOL_PASSED/u);
});
