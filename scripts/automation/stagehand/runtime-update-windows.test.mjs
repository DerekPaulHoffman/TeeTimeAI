import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { courseSupportWorkerRuntimeEnvironment } from '../course-support-worker-runtime.mjs';

test('actual Windows startup reconciliation retries only one conclusively stopped owned start, without repeating the update', { skip: process.platform !== 'win32' }, () => {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  for (const scenario of ['recover', 'first-success', 'active', 'running', 'stale', 'config', 'task', 'source', 'foreign-drain', 'second-failure', 'unknown-failure']) {
    const source = `
      $ErrorActionPreference='Stop';$scenario=${quote(scenario)};$tokens=$null;$errors=$null
      $ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(resolve('scripts/automation/update-course-discovery-runtime.ps1'))},[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'FIXTURE_PARSE_FAILED'}
      $definition=$ast.Find({param($item)$item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'WaitUpdatedRuntimeStartup'},$true)
      Invoke-Expression $definition.Extent.Text
      $RuntimeVersion='${'a'.repeat(40)}';$runtimeRoot='fixture-runtime';$config='fixture-config';$configHash='config-hash';$taskHash='task-hash'
      $ps5='fixture-powershell';$manager='fixture-manager';$lockStream=New-Object IO.MemoryStream
      $taskStartRequests=1;$startupRequestedAt=[DateTimeOffset]::UtcNow.AddSeconds(-3);$firstStoppedTaskResult=$null
      $waitCalls=0;$startCalls=0;$refreshCalls=0
      function WaitIdle { param($Expected,$Since,$Seconds)
        $script:waitCalls++
        if($scenario -eq 'unknown-failure'){throw 'UNKNOWN_STARTUP_FAILURE'}
        if(($script:waitCalls -eq 1 -and $scenario -ne 'first-success') -or $scenario -eq 'second-failure'){throw 'RUNTIME_DRAIN_OR_STARTUP_NOT_PROVED'}
        return @{runtimeVersion=$Expected;ready=$true;drained=$true}
      }
      function Get-ScheduledTask {param($TaskName,$TaskPath) return @{State=$(if($scenario -eq 'running'){'Running'}else{'Ready'})}}
      function Get-ScheduledTaskInfo {param($InputObject) return @{LastTaskResult=1;LastRunTime=$(if($scenario -eq 'stale'){[DateTimeOffset]::UtcNow.AddMinutes(-5).LocalDateTime}else{[DateTimeOffset]::UtcNow.AddSeconds(-2).LocalDateTime})}}
      function Supervisors {if($scenario -eq 'active'){return @{ProcessId=99}}}
      function GitText {param($Workspace,$Arguments) if($Arguments[0] -eq 'status'){return ''};if($scenario -eq 'source'){return '${'b'.repeat(40)}'};return $RuntimeVersion}
      function Get-FileHash {param($LiteralPath,$Algorithm) return @{Hash=$(if($scenario -eq 'config'){'changed'}else{$configHash})}}
      function TaskDigest {if($scenario -eq 'task'){return 'changed'};return $taskHash}
      function RefreshDrain {$script:refreshCalls++;if($scenario -eq 'foreign-drain'){throw 'DRAIN_CONTROL_CHANGED'}}
      function NativeText {param($Program,$Arguments)
        if(($Arguments -join ',') -cne '-NoProfile,-NonInteractive,-File,fixture-manager,-Action,Start,-Apply'){throw 'UNEXPECTED_MUTATION'}
        $script:startCalls++
      }
      try {$result=WaitUpdatedRuntimeStartup ([DateTimeOffset]::UtcNow);$outcome='ready';$reason=$null}
      catch {$outcome='blocked';$reason=$_.Exception.Message}
      finally {$lockStream.Dispose()}
      @{outcome=$outcome;reason=$reason;waitCalls=$waitCalls;startCalls=$startCalls;taskStartRequests=$taskStartRequests;firstStoppedTaskResult=$firstStoppedTaskResult}|ConvertTo-Json -Compress
    `;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, scenario);
    const observation = JSON.parse(result.stdout);
    assert.equal(observation.outcome, ['recover', 'first-success'].includes(scenario) ? 'ready' : 'blocked', scenario);
    assert.equal(observation.startCalls, ['recover', 'second-failure'].includes(scenario) ? 1 : 0, scenario);
    assert.equal(observation.taskStartRequests, ['recover', 'second-failure'].includes(scenario) ? 2 : 1, scenario);
    assert.equal(observation.waitCalls, ['recover', 'second-failure'].includes(scenario) ? 2 : 1, scenario);
  }
});

test('actual Windows qualification adapter preserves only closed proof reasons and discards private child output', { skip: process.platform !== 'win32' }, () => {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const folder = mkdtempSync(join(tmpdir(), 'course-runtime-qualification-'));
  try { for (const scenario of ['known', 'unknown', 'extra', 'generic']) {
    const payload = { schemaVersion: 1, outcome: 'blocked', reasonCode: scenario === 'unknown' ? 'PRIVATE_REASON' : 'RUNTIME_CI_PENDING_TIMEOUT',
      ...(scenario === 'extra' ? { raw: 'fixture-private' } : {}) };
    const program = `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});process.stderr.write('fixture-private');process.exit(1)`;
    const programPath = join(folder, scenario + '.mjs');
    writeFileSync(programPath, program);
    const source = `
      $ErrorActionPreference='Stop';$tokens=$null;$errors=$null
      $ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(resolve('scripts/automation/update-course-discovery-runtime.ps1'))},[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'FIXTURE_PARSE_FAILED'}
      $function=$ast.Find({param($item)$item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'NativeText'},$true)
      Invoke-Expression $function.Extent.Text
      try { NativeText ${quote(process.execPath)} @(${quote(programPath)}) ${scenario === 'generic' ? '' : '-ReleaseProof'};exit 9 }
      catch { $_.Exception.Message }
    `;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], {
      env: courseSupportWorkerRuntimeEnvironment({ status: 'available', nodePath: process.execPath }, process.cwd(), process.env),
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), scenario === 'known' ? 'RUNTIME_CI_PENDING_TIMEOUT' : 'RUNTIME_PROOF_COMMAND_FAILED');
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-private|PRIVATE_REASON/u);
  } } finally {
    if (dirname(resolve(folder)) !== resolve(tmpdir()) || !resolve(folder).startsWith(join(tmpdir(), 'course-runtime-qualification-'))) throw new Error('Unexpected fixture cleanup target');
    rmSync(folder, { recursive: true, force: true });
  }
});

test('worker runtime retains required nonsecret Windows metadata without forwarding credentials', () => {
  const environment = courseSupportWorkerRuntimeEnvironment({ status: 'available', nodePath: process.execPath }, process.cwd(), {
    OS: 'Windows_NT', CODEX_THREAD_ID: 'fixture-native-identity', PATH: 'fixture-path',
    RESEND_API_KEY: 'fixture-private', DATABASE_URL: 'fixture-private', UNKNOWN_SETTING: 'fixture-private',
  });
  assert.equal(environment.OS, 'Windows_NT');
  assert.equal(environment.CODEX_THREAD_ID, 'fixture-native-identity');
  for (const key of ['RESEND_API_KEY', 'DATABASE_URL', 'UNKNOWN_SETTING']) assert.equal(Object.hasOwn(environment, key), false);
});

test('actual Windows native guards work under the production sanitized environment and reject a different owner', { skip: process.platform !== 'win32' }, () => {
  const owner = '12345678-1234-4234-8234-123456789abc';
  const environment = courseSupportWorkerRuntimeEnvironment({ status: 'available', nodePath: process.execPath }, process.cwd(), {
    ...process.env, CODEX_THREAD_ID: owner,
  });
  for (const expected of [owner, '87654321-1234-4234-8234-123456789abc']) {
    const output = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference='Stop';$OwnerThreadId='${expected}'
      try {
        foreach($file in @('update-course-discovery-runtime.ps1','manage-course-discovery-task.ps1')){
          $tokens=$null;$errors=$null
          $ast=[System.Management.Automation.Language.Parser]::ParseFile('${resolve('scripts/automation').replaceAll("'", "''")}\\'+$file,[ref]$tokens,[ref]$errors)
          if($errors.Count){throw 'FIXTURE_PARSE_FAILED'}
          $body=($ast.EndBlock.Statements|Where-Object{$_ -is [System.Management.Automation.Language.TryStatementAst]}|Select-Object -First 1).Body
          $guard=$body.Statements|Where-Object{$_ -is [System.Management.Automation.Language.IfStatementAst]}|Select-Object -First 1
          Invoke-Expression $guard.Extent.Text
        }
        'NATIVE_WINDOWS_GUARDS_PASSED'
      } catch { if($_.Exception.Message -ceq 'ORIGINAL_NATIVE_OWNER_REQUIRED'){'NATIVE_OWNER_REJECTED';exit 3};throw }
    `], { env: environment, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(output.status, expected === owner ? 0 : 3, 'native guard result');
    assert.match(output.stdout, expected === owner ? /NATIVE_WINDOWS_GUARDS_PASSED/u : /NATIVE_OWNER_REJECTED/u);
  }
});

test('actual updater emits only bounded structured pre-mutation failure facts', { skip: process.platform !== 'win32' }, () => {
  const environment = courseSupportWorkerRuntimeEnvironment({ status: 'available', nodePath: process.execPath }, process.cwd(), {
    ...process.env, CODEX_THREAD_ID: '12345678-1234-4234-8234-123456789abc',
  });
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    resolve('scripts/automation/update-course-discovery-runtime.ps1'), '-RuntimeVersion', 'a'.repeat(40),
    '-OwnerThreadId', '87654321-1234-4234-8234-123456789abc'], { env: environment, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, outcome: 'blocked', reasonCode: 'ORIGINAL_NATIVE_OWNER_REQUIRED',
    phase: 'VALIDATE_NATIVE_OWNER', apply: false, stateChanged: false, mutationAttempted: false, drainAttempted: false,
    taskStopAttempted: false, runtimeUpdateAttempted: false, taskStartAttempted: false, activationWriteAttempted: false,
    taskStartRequests: 0, firstStoppedTaskResult: null, acceptanceRestartProof: false });
  assert.equal(result.stderr.trim(), '');
});

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
