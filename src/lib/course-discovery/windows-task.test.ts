// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe.runIf(process.platform === "win32")("Windows supervisor lifecycle dry runs", () => {
  const interpreters = ["powershell.exe", "pwsh.exe"].filter(name => process.platform === "win32" &&
    spawnSync(name, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { windowsHide: true }).status === 0);
  it.each(interpreters)("keeps real Node stderr nonfatal, preserves its exit code, and keeps log failures fatal with %s", interpreter => {
    const temporary = mkdtempSync(join(tmpdir(), "course-discovery-task-"));
    const source = readFileSync(resolve("scripts/automation/run-course-discovery-supervisor.ps1"), "utf8");
    const start = source.indexOf("  $supervisorResult = @{ ExitCode = 1 }"), end = source.indexOf("  exit $supervisorResult.ExitCode", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    // Execute the actual wrapper's complete native invocation and logger,
    // replacing only its validated runtime paths with test-owned paths.
    const pipeline = source.slice(start, end);
    const quote = (value: string) => `'${value.replace(/'/gu, "''")}'`;
    const entrypoint = join(temporary, "scripts", "automation", "course-discovery-supervisor.mjs");
    mkdirSync(dirname(entrypoint), { recursive: true });
    const harness = join(temporary, "pipeline.ps1");
    try {
      for (const exitCode of [0, 7]) {
        const logs = join(temporary, `logs-${exitCode}`); mkdirSync(logs);
        const sdkUrl = pathToFileURL(resolve("node_modules/@browserbasehq/stagehand/dist/index.mjs")).href;
        writeFileSync(entrypoint, `console.log(JSON.stringify({event:'supervisor_started'}));const sdk=await import(${JSON.stringify(sdkUrl)});if(typeof sdk.Stagehand.create!=='function')process.exit(93);process.emitWarning('private-fixture-warning',{type:'DeprecationWarning',code:'DEP_FIXTURE'});setTimeout(()=>{console.log(JSON.stringify({event:'poll_completed',observedAt:'2030-01-01T00:00:00.000Z'}));process.exit(${exitCode});},30);`);
        writeFileSync(harness, `$ErrorActionPreference='Stop'\n$runtime=@{NodePath=${quote(process.execPath)};WorkspacePath=${quote(temporary)}}\n$logs=${quote(logs)}\ntry {\n${pipeline}\nexit $supervisorResult.ExitCode\n} catch { [Console]::Error.WriteLine('TEST_LOG_WRITE_FAILED');exit 91 }`);
        const result = spawnSync(interpreter, ["-NoProfile", "-NonInteractive", "-File", harness], { encoding: "utf8", windowsHide: true });
        expect(result.status).toBe(exitCode);
        const log = readFileSync(join(logs, `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8").replace(/^\uFEFF/u, "");
        const events = log.trim().split(/\r?\n/u).map(line => JSON.parse(line).event);
        expect(events).toContain("supervisor_started"); expect(events).toContain("poll_completed");
        expect(events).toContain("supervisor_diagnostic_redacted");
        expect(log + result.stdout + result.stderr).not.toContain("private-fixture-warning");
      }
      const blockedLogs = join(temporary, "blocked-logs"); mkdirSync(blockedLogs);
      // An exclusively held logfile makes the actual Add-Content fail. The
      // logger must still stop, independently of the child's stderr policy.
      writeFileSync(harness, `$ErrorActionPreference='Stop'\n$runtime=@{NodePath=${quote(process.execPath)};WorkspacePath=${quote(temporary)}}\n$logs=${quote(blockedLogs)}\n$path=Join-Path $logs ((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')+'.jsonl')\n$locked=[IO.File]::Open($path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)\ntry {\n${pipeline}\nexit $supervisorResult.ExitCode\n} catch { [Console]::Error.WriteLine('TEST_LOG_WRITE_FAILED');exit 91 } finally {$locked.Dispose()}`);
      const blocked = spawnSync(interpreter, ["-NoProfile", "-NonInteractive", "-File", harness], { encoding: "utf8", windowsHide: true });
      expect(blocked.status).toBe(91); expect(blocked.stderr).toContain("TEST_LOG_WRITE_FAILED");
      expect(blocked.stderr).not.toContain("private-fixture-warning");
    } finally {
      if (dirname(temporary) !== resolve(tmpdir()) || !temporary.startsWith(join(resolve(tmpdir()), "course-discovery-task-"))) throw new Error("Unsafe test cleanup path");
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 30_000);
  it.each(interpreters)("preserves acknowledged cleanup evidence and redacts unknown warning data with %s", interpreter => {
    const temporary = mkdtempSync(join(tmpdir(), "course-discovery-task-"));
    const config = join(temporary, "runtime.json"), fakeNode = join(temporary, "fixture-output.ps1"), logs = join(temporary, "logs");
    const activationAcknowledgedAt = "2026-10-21T20:00:00.000Z";
    const browserTimes = { browserStartedAt: "2026-10-21T19:59:15.123Z", firstOpenStartedAt: "2026-10-21T15:59:16.456-04:00",
      firstOpenCompletedAt: "2026-10-21T19:59:47.789Z" };
    writeFileSync(config, JSON.stringify({ COURSE_DISCOVERY_API_ORIGIN: "https://example.org", LOCAL_READER_DEVICE_TOKEN: "fake-test-device-secret-never-print",
      COURSE_DISCOVERY_BROWSER_TRANSPORT: "NATIVE_CHROME" }));
    const events = [
      { event: "activated", activationAcknowledgedAt, firstPickedUpAt: activationAcknowledgedAt, deadlineAt: "2026-10-21T20:15:00.000Z", private: "private-provider-data", metrics: {
        model: "gpt-6.1-sol", framework: "Stagehand", frameworkRole: "SOURCE_DISCOVERY_ONLY", reasoningEffort: "medium",
        modelCalls: 5, sourceElapsedMs: 33000, sourceResumed: false, sourceUsageRecordedLowerBound: true, fixedInspectionModelCalls: 0, replayModelCalls: 0,
        ...browserTimes, metricsFinal: false, cleanupWarning: "POST_ACTIVATION_CLEANUP_PENDING", private: "private-provider-data" } },
      { event: "activated", metrics: { metricsFinal: "private-provider-data", cleanupWarning: "private-provider-data" } },
    ];
    // This fixture replaces the node executable only for this invocation. The
    // real supervisor entrypoint is passed as an ignored argument, never run.
    writeFileSync(fakeNode, `param($IgnoredEntrypoint)\n${events.map(event => `Write-Output '${JSON.stringify(event)}'`).join("\n")}\n`);
    try {
      const quote = (value: string) => `'${value.replace(/'/gu, "''")}'`;
      const protect = "$env:PSModulePath=Join-Path $PSHOME 'Modules'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.FileSecurity; " +
        "$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); " +
        "$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow'))); ";
      execFileSync(interpreter, ["-NoProfile", "-NonInteractive", "-Command", `${protect}Set-Acl -LiteralPath ${quote(config)} -AclObject $acl`], { windowsHide: true });
      execFileSync(interpreter, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File",
        resolve("scripts/automation/run-course-discovery-supervisor.ps1"), "-WorkspacePath", process.cwd(), "-ConfigPath", config,
        "-NodePath", fakeNode, "-LogDirectory", logs], { windowsHide: true });
      const log = readFileSync(join(logs, `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8").replace(/^\uFEFF/u, "");
      const rows = log.trim().split(/\r?\n/u).map(line => JSON.parse(line));
      const { activationAcknowledgedAt: retainedAck, firstPickedUpAt, deadlineAt, ...first } = rows[0];
      expect(new Date(retainedAck).toISOString()).toBe(activationAcknowledgedAt);
      expect(new Date(firstPickedUpAt).toISOString()).toBe(activationAcknowledgedAt);
      expect(new Date(deadlineAt).toISOString()).toBe("2026-10-21T20:15:00.000Z");
      expect(first.metrics).toMatchObject({ browserStartedAt: expect.any(String), firstOpenStartedAt: expect.any(String), firstOpenCompletedAt: expect.any(String) });
      const { browserStartedAt, firstOpenStartedAt, firstOpenCompletedAt, ...metrics } = first.metrics;
      expect(new Date(browserStartedAt).toISOString()).toBe(browserTimes.browserStartedAt);
      expect(new Date(firstOpenStartedAt).toISOString()).toBe("2026-10-21T19:59:16.456Z");
      expect(new Date(firstOpenCompletedAt).toISOString()).toBe(browserTimes.firstOpenCompletedAt);
      expect([{ ...first, metrics }, rows[1]]).toEqual([{ event: "activated", metrics: { model: "gpt-6.1-sol",
        framework: "Stagehand", frameworkRole: "SOURCE_DISCOVERY_ONLY", reasoningEffort: "medium", modelCalls: 5,
        sourceElapsedMs: 33000, sourceResumed: false, sourceUsageRecordedLowerBound: true, fixedInspectionModelCalls: 0, replayModelCalls: 0,
        metricsFinal: false, cleanupWarning: "POST_ACTIVATION_CLEANUP_PENDING" } }, { event: "activated", metrics: {} }]);
      expect(log).not.toContain("private-provider-data"); expect(log).not.toContain("fake-test-device-secret-never-print");
    } finally {
      if (dirname(temporary) !== resolve(tmpdir()) || !temporary.startsWith(join(resolve(tmpdir()), "course-discovery-task-"))) throw new Error("Unsafe test cleanup path");
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 30_000);
  it.each(interpreters)("inspects read-only with %s using inbox modules rather than inherited user modules", interpreter => {
    const temporary = mkdtempSync(join(tmpdir(), "course-discovery-task-"));
    const fakeModule = join(temporary, "ScheduledTasks");
    mkdirSync(fakeModule);
    writeFileSync(join(fakeModule, "ScheduledTasks.psm1"), 'throw "UNTRUSTED_MODULE_LOADED"');
    try {
      const taskName = `Tee Time Spot Course Discovery test-${randomUUID().slice(0, 20)}`;
      const result = execFileSync(interpreter, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File",
        resolve("scripts/automation/manage-course-discovery-task.ps1"), "-Action", "Inspect", "-TaskName", taskName], {
        encoding: "utf8", windowsHide: true, env: { ...process.env, PSModulePath: temporary },
      });
      expect(JSON.parse(result.trim())).toMatchObject({ action: "Inspect", apply: false, exists: false });
      expect(result).not.toContain("UNTRUSTED_MODULE_LOADED");
    } finally {
      if (dirname(temporary) !== resolve(tmpdir()) || !temporary.startsWith(join(resolve(tmpdir()), "course-discovery-task-"))) throw new Error("Unsafe test cleanup path");
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 30_000);
  it.each(interpreters)("preserves heartbeat instants and rejects invalid/future health with %s", interpreter => {
    const temporary = mkdtempSync(join(tmpdir(), "course-discovery-task-"));
    const logs = join(temporary, "logs"); mkdirSync(logs);
    const log = join(logs, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const taskName = `Tee Time Spot Course Discovery test-${randomUUID().slice(0, 20)}`;
    const script = resolve("scripts/automation/manage-course-discovery-task.ps1");
    const quote = (value: string) => `'${value.replace(/'/gu, "''")}'`;
    const inspect = () => JSON.parse(execFileSync(interpreter, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-Command",
      `[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo('fr-FR'); & ${quote(script)} -Action Inspect -TaskName ${quote(taskName)} -LogDirectory ${quote(logs)}`],
    { encoding: "utf8", windowsHide: true }).trim());
    try {
      for (const [ageMs, status] of [[10_000, "fresh"], [300_000, "stale"], [-300_000, "future"]] as const) {
        const at = new Date(Date.now() - ageMs).toISOString();
        writeFileSync(log, `${JSON.stringify({ event: "poll_completed", observedAt: at })}\n`);
        const result = inspect();
        expect(new Date(result.lastHeartbeatAt).toISOString()).toBe(at);
        expect(result).toMatchObject({ exists: false, ready: false, heartbeatStatus: status });
        if (status === "future") expect(result.heartbeatAgeSeconds).toBeLessThan(0);
        else expect(result.heartbeatAgeSeconds).toBeGreaterThanOrEqual(ageMs / 1_000);
      }
      const instant = new Date(Date.now() - 300_000);
      const offsetTimestamp = `${new Date(instant.getTime() - 4 * 3_600_000).toISOString().slice(0, -1)}-04:00`;
      writeFileSync(log, `${JSON.stringify({ event: "poll_completed", observedAt: offsetTimestamp })}\n`);
      expect(new Date(inspect().lastHeartbeatAt).toISOString()).toBe(instant.toISOString());
      for (const observedAt of ["not-a-timestamp", "2026-10-20T20:28:22.489", null]) {
        // A malformed latest heartbeat must not inherit an earlier fresh row.
        writeFileSync(log, `${JSON.stringify({ event: "poll_completed", observedAt: new Date().toISOString() })}\n${JSON.stringify({ event: "poll_completed", observedAt })}\n`);
        expect(inspect()).toMatchObject({ exists: false, ready: false, heartbeatStatus: "invalid" });
      }
    } finally {
      if (dirname(temporary) !== resolve(tmpdir()) || !temporary.startsWith(join(resolve(tmpdir()), "course-discovery-task-"))) throw new Error("Unsafe test cleanup path");
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 60_000);
  it("validates protected external config and plans registration without exposing credentials or applying", () => {
    const temporary = mkdtempSync(join(tmpdir(), "course-discovery-task-"));
    const config = join(temporary, "runtime.json");
    const secret = "fake-test-device-secret-never-print";
    writeFileSync(config, JSON.stringify({ COURSE_DISCOVERY_API_ORIGIN: "https://example.org", LOCAL_READER_DEVICE_TOKEN: secret,
      COURSE_DISCOVERY_BROWSER_TRANSPORT: "NATIVE_CHROME" }));
    try {
      const acl = '$env:PSModulePath=Join-Path $PSHOME "Modules"; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.FileSecurity; ' +
        '$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); ' +
        '$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,"FullControl","Allow"))); ' +
        'Set-Acl -LiteralPath $args[0] -AclObject $acl';
      // Pass the generated filename as an argument, never interpolate file content.
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `& {param($p) ${acl.replace("$args[0]", "$p")} } '${config.replace(/'/gu, "''")}'`], { windowsHide: true });
      const taskName = `Tee Time Spot Course Discovery test-${randomUUID().slice(0, 20)}`;
      const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File",
        resolve("scripts/automation/manage-course-discovery-task.ps1"), "-Action", "Register", "-WorkspacePath", process.cwd(),
        "-ConfigPath", config, "-NodePath", process.execPath, "-TaskName", taskName], { encoding: "utf8", windowsHide: true });
      const plan = JSON.parse(result.trim());
      expect(plan).toMatchObject({ action: "Register", apply: false, exists: false, restartCount: 3, hiddenWindow: true, credentialsInArguments: false });
      expect(result).not.toContain(secret);
      const inspect = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File",
        resolve("scripts/automation/manage-course-discovery-task.ps1"), "-TaskName", taskName], { encoding: "utf8", windowsHide: true });
      expect(JSON.parse(inspect.trim()).exists).toBe(false);
      const logs = join(temporary, "logs"); mkdirSync(logs);
      writeFileSync(join(logs, `${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ event: "poll_completed", observedAt: new Date().toISOString(), secret }) + "\n");
      const healthy = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File",
        resolve("scripts/automation/manage-course-discovery-task.ps1"), "-TaskName", taskName, "-LogDirectory", logs], { encoding: "utf8", windowsHide: true });
      expect(JSON.parse(healthy.trim())).toMatchObject({ exists: false, heartbeatStatus: "fresh" });
      expect(healthy).not.toContain(secret);
      writeFileSync(config, "malformed secret material");
      const invalid = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File",
        resolve("scripts/automation/run-course-discovery-supervisor.ps1"), "-ValidateOnly", "-WorkspacePath", process.cwd(),
        "-ConfigPath", config, "-NodePath", process.execPath], { encoding: "utf8", windowsHide: true });
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain("COURSE_DISCOVERY_RUNTIME_START_FAILED");
      expect(invalid.stderr).not.toContain("malformed secret material");
    } finally {
      // Test-owned absolute path was generated by mkdtemp under the system temp directory.
      if (dirname(temporary) !== resolve(tmpdir()) || !temporary.startsWith(join(resolve(tmpdir()), "course-discovery-task-"))) throw new Error("Unsafe test cleanup path");
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 30_000);
});
