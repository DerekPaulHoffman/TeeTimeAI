import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimPreparedDesktopWorker, dispatchCourseSupportWorker, readSupervisorArguments, superviseCourseSupportWorker, validateSupervisorInput, workerInstructions } from "../../../scripts/automation/course-support-worker-supervisor.mjs";

const SHA = "a".repeat(40);
const PARENT = "11111111-2222-4333-8444-555555555555";
const CHILD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const REF = "course-assignment-12345678-1234-4234-8234-123456789abc";

function fixture(mode?: "SIMULATOR") {
  const root = mkdtempSync(join(tmpdir(), "course-supervisor-"));
  const selected = join(root, "selected"), worker = join(root, "worker"), output = join(root, "private");
  for (const dir of [selected, worker, output]) mkdirSync(dir);
  mkdirSync(join(selected, ".vercel"));
  writeFileSync(join(selected, ".vercel", "project.json"), JSON.stringify({ projectId: "project", orgId: "org" }));
  mkdirSync(join(selected, "node_modules", "vercel", "dist"), { recursive: true });
  writeFileSync(join(selected, "node_modules", "vercel", "package.json"), JSON.stringify({ name: "vercel", version: "62.2.0", bin: { vercel: "dist/vc.js" } }));
  writeFileSync(join(selected, "node_modules", "vercel", "dist", "vc.js"), "fixture");
  writeFileSync(join(selected, "node_modules", "vercel", "dist", "index.js"), "fixture");
  writeFileSync(join(selected, "node_modules", "vercel", "dist", "version.mjs"), "fixture");
  const cli = join(selected, "codex.exe"), node = join(root, "node.exe"), npm = join(root, "npm-cli.js");
  for (const file of [cli, node, npm]) writeFileSync(file, "fixture");
  const context = { kind: "course_support_preflight_context", selectedCheckout: selected, exactHead: true,
    workerCli: { status: "current", cliPath: cli, cliVersion: "codex-cli 0.160.1" } };
  const assignment = { state: "RESERVED", assignmentRef: REF, ...(mode ? { mode } : {}) };
  const input = { context, assignment, workerCheckout: worker, outputDir: output, parentThreadId: PARENT };
  const calls: string[] = [];
  let workerBranch = "automation/course-support-fixture";
  const deps = {
    environment: { CODEX_THREAD_ID: PARENT, CODEX_HOME: "normal-auth-home", DATABASE_URL: "private-db", RESEND_API_KEY: "private-email" },
    approvedCheckouts: [selected],
    inspectCli: vi.fn(() => context.workerCli),
    inspectPreparedCli: vi.fn(() => context.workerCli.cliVersion),
    inspectWorker: vi.fn(() => ({ cwd: worker, branch: workerBranch, baseSha: SHA })),
    prepareWorkerBranch: vi.fn(() => { calls.push("branch"); workerBranch = `automation/course-support-${REF.slice("course-assignment-".length)}`;
      return { cwd: worker, branch: workerBranch, baseSha: SHA }; }),
    git: vi.fn((_cwd: string, args: string[]) => args[0] === "status" ? "" : SHA),
    resolveRuntime: vi.fn(() => ({ status: "available", nodePath: node, npmCliPath: npm })),
    readFile: vi.fn((file: string) => {
      calls.push(`template:${file.includes("simulator") ? "simulator" : "outdoor"}`);
      return "Bound assignment <assignment-ref> from <selected-checkout>.";
    }),
    spawn: vi.fn((_command: string, args: string[]) => {
      const stage = args.includes("bind") ? "bind" : "start";
      calls.push(stage);
      return { status: 0, stdout: JSON.stringify({ acquired: true, value: {
        assignmentRef: REF, state: stage === "start" ? "STARTING" : "BOUND", baseSha: SHA } }), stderr: "" };
    }),
    prepare: vi.fn(async ({ receiptPath, historyMode = "legacy" }: { receiptPath: string; historyMode?: string }) => {
      calls.push("prepare");
      writeFileSync(receiptPath, JSON.stringify({ schemaVersion: 1, status: "PREPARED", threadId: CHILD, approvalPolicy: "never",
        model: "gpt-6.1-sol", authentication: "ChatGPT", historyMode, nativeIdentityVerified: false, approvalRequests: 0,
        branch: workerBranch, baseSha: SHA, cliPath: context.workerCli.cliPath, cliVersion: context.workerCli.cliVersion,
        sandbox: { type: "dangerFullAccess" }, activePermissionProfile: { id: ":danger-full-access" }, cwd: worker }));
      return { outcome: "prepared", threadId: CHILD, receiptPath };
    }),
    run: vi.fn(async () => { calls.push("run"); return { outcome: "completed", nativeIdentityVerified: true, approvalRequests: 0 }; }),
  };
  return { input, deps, calls, output, selected, worker };
}

describe("course worker launch supervisor", () => {
  it("names a clean detached Desktop checkout before production start and preserves exact branch proof", async () => {
    const f = fixture();
    f.deps.inspectWorker.mockReturnValueOnce({ cwd: f.worker, branch: "", baseSha: SHA });
    const result = await superviseCourseSupportWorker({ ...f.input, executionMode: "DESKTOP" }, f.deps);
    expect(f.calls).toEqual(["template:outdoor", "branch", "start", "prepare", "bind"]);
    expect(f.deps.prepareWorkerBranch).toHaveBeenCalledWith(f.worker, f.selected, REF);
    expect(claimPreparedDesktopWorker({ receiptPath: result.receiptPath, parentThreadId: PARENT,
      expectedChildThreadId: CHILD, expectedAssignmentRef: REF }, f.deps)).toMatchObject({ outcome: "desktop_message_required" });
  });

  it("retains branch preparation failure without any production start or native creation", async () => {
    const f = fixture();
    f.deps.inspectWorker.mockReturnValueOnce({ cwd: f.worker, branch: "", baseSha: SHA });
    f.deps.prepareWorkerBranch.mockImplementationOnce(() => { throw Object.assign(new Error("branch exists"), { code: "BRANCH_EXISTS" }); });
    await expect(superviseCourseSupportWorker({ ...f.input, executionMode: "DESKTOP" }, f.deps)).rejects.toMatchObject({ code: "BRANCH_EXISTS" });
    expect(f.deps.spawn).not.toHaveBeenCalled();
    expect(f.deps.prepare).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(f.output, "supervisor.receipt.private.json"), "utf8")))
      .toMatchObject({ status: "ATTENTION", failedAt: "BRANCH_PREPARING", failureCode: "BRANCH_EXISTS" });
  });

  it("does not admit detached native legacy workers or another named task branch", () => {
    const f = fixture();
    for (const branch of ["", "fix/restore-course-monitoring-2991615-a"]) {
      f.deps.inspectWorker.mockReturnValueOnce({ cwd: f.worker, branch, baseSha: SHA });
      expect(() => validateSupervisorInput(f.input, f.deps)).toThrow("WORKER_BASE_CHANGED");
    }
    expect(f.deps.prepareWorkerBranch).not.toHaveBeenCalled();
  });
  it("prepares and binds a desktop worker without starting a standalone inference turn", async () => {
    const f = fixture();
    const result = await superviseCourseSupportWorker({ ...f.input, executionMode: "DESKTOP" }, f.deps);
    expect(result).toMatchObject({ outcome: "desktop_turn_required", childThreadId: CHILD });
    expect(f.calls).toEqual(["template:outdoor", "start", "prepare", "bind"]);
    expect(f.deps.run).not.toHaveBeenCalled();
    expect(f.deps.prepare).toHaveBeenCalledWith(expect.objectContaining({ historyMode: "legacy", enableResearchBridge: false }));
    const input = { receiptPath: result.receiptPath, parentThreadId: PARENT, expectedChildThreadId: CHILD, expectedAssignmentRef: REF };
    const prepared = claimPreparedDesktopWorker(input, f.deps);
    expect(prepared).toMatchObject({ outcome: "desktop_message_required", threadId: CHILD, model: "gpt-6.1-sol",
      thinking: "high", monitoringVerified: false, messageAcceptance: "PENDING" });
    expect(prepared.prompt).toContain("courseWorkerNativeIdentity");
    expect(prepared.prompt).toContain(REF);
    expect(prepared.prompt).not.toMatch(/private-db|private-email|fixture-pipe|fixture-identity/);
    expect(existsSync(join(f.output, "launcher.receipt.private.json.first-turn-started"))).toBe(true);
    expect(JSON.parse(readFileSync(join(f.output, "launcher.receipt.private.json"), "utf8")))
      .toMatchObject({ executionMode: "DESKTOP", status: "DESKTOP_REQUESTED", nativeIdentityVerified: false });
    expect(() => claimPreparedDesktopWorker(input, f.deps))
      .toThrow("PREPARED_DESKTOP_WORKER_REQUIRED");
  });

  it("does not consume a desktop dispatch on changed parent, source branch or prompt", async () => {
    const f = fixture();
    const result = await superviseCourseSupportWorker({ ...f.input, executionMode: "DESKTOP" }, f.deps);
    const input = { receiptPath: result.receiptPath, parentThreadId: PARENT, expectedChildThreadId: CHILD, expectedAssignmentRef: REF };
    expect(() => claimPreparedDesktopWorker({ ...input, parentThreadId: CHILD }, f.deps))
      .toThrow("NATIVE_PARENT_ID_MISMATCH");
    expect(() => claimPreparedDesktopWorker({ ...input, expectedChildThreadId: PARENT }, f.deps)).toThrow("DESKTOP_ASSIGNMENT_CHANGED");
    f.deps.inspectWorker.mockReturnValueOnce({ cwd: f.worker, branch: "automation/course-support-fixture", baseSha: "b".repeat(40) });
    expect(() => claimPreparedDesktopWorker(input, f.deps))
      .toThrow("WORKER_BASE_CHANGED");
    writeFileSync(join(f.output, "worker.prompt.private.md"), "changed instructions");
    expect(() => claimPreparedDesktopWorker(input, f.deps))
      .toThrow("WORKER_PROMPT_CHANGED");
    expect(existsSync(join(f.output, "launcher.receipt.private.json.first-turn-started"))).toBe(false);
  });

  it.each([
    { schemaVersion: 2 }, { nativeIdentityVerified: true }, { turnId: CHILD },
    { approvalRequests: 1 }, { authentication: "apiKey" }, { model: "unexpected-model" },
    { branch: "automation/course-support-other" }, { baseSha: "b".repeat(40) }, { historyMode: "paginated" },
  ])("refuses changed prepared native proof before reserving Desktop execution: %j", async (change) => {
    const f = fixture();
    const result = await superviseCourseSupportWorker({ ...f.input, executionMode: "DESKTOP" }, f.deps);
    const launcherPath = join(f.output, "launcher.receipt.private.json");
    const launcher = JSON.parse(readFileSync(launcherPath, "utf8"));
    writeFileSync(launcherPath, JSON.stringify({ ...launcher, ...change }));
    expect(() => claimPreparedDesktopWorker({ receiptPath: result.receiptPath, parentThreadId: PARENT,
      expectedChildThreadId: CHILD, expectedAssignmentRef: REF }, f.deps)).toThrow("DESKTOP_NATIVE_PROOF_CHANGED");
    expect(existsSync(`${launcherPath}.first-turn-started`)).toBe(false);
  });

  it("refuses a changed prepared CLI or an already reserved native first turn", async () => {
    const f = fixture();
    const result = await superviseCourseSupportWorker({ ...f.input, executionMode: "DESKTOP" }, f.deps);
    const input = { receiptPath: result.receiptPath, parentThreadId: PARENT, expectedChildThreadId: CHILD, expectedAssignmentRef: REF };
    f.deps.inspectPreparedCli.mockReturnValueOnce("changed-cli-version");
    expect(() => claimPreparedDesktopWorker(input, f.deps)).toThrow("WORKER_RECEIPT_RUNTIME_CHANGED");
    const marker = join(f.output, "launcher.receipt.private.json.first-turn-started");
    expect(existsSync(marker)).toBe(false);
    writeFileSync(marker, "");
    expect(() => claimPreparedDesktopWorker(input, f.deps)).toThrow(/EEXIST/);
    expect(JSON.parse(readFileSync(result.receiptPath, "utf8")).status).toBe("DESKTOP_READY");
  });
  it("refuses missing selected CLI readiness before durable start or native creation", async () => {
    const f = fixture();
    unlinkSync(join(f.selected, "node_modules", "vercel", "dist", "vc.js"));
    await expect(superviseCourseSupportWorker(f.input, f.deps)).rejects.toMatchObject({ code: "PARENT_VERCEL_NOT_READY" });
    expect(f.deps.spawn).not.toHaveBeenCalled();
    expect(f.deps.prepare).not.toHaveBeenCalled();
    expect(f.deps.run).not.toHaveBeenCalled();
  });

  it("dispatches through the selected checkout's prepared CLI without package acquisition", async () => {
    const f = fixture();
    await superviseCourseSupportWorker(f.input, f.deps);
    expect(f.deps.spawn).toHaveBeenCalledTimes(2);
    for (const [command, args, settings] of f.deps.spawn.mock.calls as unknown as [string, string[], { cwd: string; env: Record<string, string> }][]) {
      expect(command).toBe(f.deps.resolveRuntime().nodePath);
      expect(args[0]).toBe(join(f.selected, "node_modules", "vercel", "dist", "vc.js"));
      expect(args).not.toContain("exec");
      expect(settings.cwd).toBe(f.selected);
      expect(settings.env.DATABASE_URL).toBeUndefined();
      expect(settings.env.RESEND_API_KEY).toBeUndefined();
    }
  });

  it("detaches the same foreground command with private logs and no product credentials", async () => {
    const f = fixture();
    const contextFile = join(f.output, "context.private.json"), assignmentFile = join(f.output, "assignment.private.json");
    writeFileSync(contextFile, JSON.stringify(f.input.context));
    writeFileSync(assignmentFile, JSON.stringify(f.input.assignment));
    const child = Object.assign(new EventEmitter(), { pid: 4182, unref: vi.fn() });
    const spawnDetached = vi.fn(() => { setImmediate(() => child.emit("spawn")); return child; });
    const result = await dispatchCourseSupportWorker(f.input, { contextFile, assignmentFile }, { ...f.deps, spawnDetached });
    expect(result).toMatchObject({ outcome: "dispatched", pid: 4182 });
    expect(child.unref).toHaveBeenCalledOnce();
    const [node, argv, options] = spawnDetached.mock.calls[0];
    expect(node).toBe(process.execPath);
    expect(argv).toEqual([expect.stringContaining("course-support-worker-supervisor.mjs"),
      "--context-file", contextFile, "--assignment-file", assignmentFile,
      "--worker-checkout", f.worker, "--output-dir", f.output]);
    expect(options).toMatchObject({ cwd: f.selected, detached: true, windowsHide: true, shell: false });
    expect(options.stdio[0]).toBe("ignore");
    expect(options.env.CODEX_THREAD_ID).toBe(PARENT);
    expect(options.env.CODEX_HOME).toBe("normal-auth-home");
    expect(options.env.DATABASE_URL).toBeUndefined();
    expect(options.env.RESEND_API_KEY).toBeUndefined();
    expect(readSupervisorArguments(["--detach", "--context-file", contextFile, "--assignment-file", assignmentFile,
      "--worker-checkout", f.worker, "--output-dir", f.output]).detach).toBe(true);
    await expect(dispatchCourseSupportWorker(f.input, { contextFile, assignmentFile }, { ...f.deps, spawnDetached }))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    expect(f.deps.prepare).not.toHaveBeenCalled();
  });

  it("keeps the dispatch marker when validation fails before any spawn", async () => {
    const f = fixture();
    const spawnDetached = vi.fn();
    await expect(dispatchCourseSupportWorker({ ...f.input, parentThreadId: CHILD },
      { contextFile: join(f.output, "context.json"), assignmentFile: join(f.output, "assignment.json") },
      { ...f.deps, spawnDetached })).rejects.toThrow("NATIVE_PARENT_ID_MISMATCH");
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(readFileSync(join(f.output, "supervisor.dispatch.private.json"), "utf8")).toContain('"status": "ATTENTION"');
  });

  it("records a bounded asynchronous spawn error without inventing a PID", async () => {
    const f = fixture();
    const child = Object.assign(new EventEmitter(), { pid: undefined, unref: vi.fn() });
    const spawnDetached = vi.fn(() => { setImmediate(() => child.emit("error", Object.assign(new Error("denied"), { code: "EACCES" }))); return child; });
    await expect(dispatchCourseSupportWorker(f.input,
      { contextFile: join(f.output, "context.json"), assignmentFile: join(f.output, "assignment.json") },
      { ...f.deps, spawnDetached })).rejects.toThrow("denied");
    expect(readFileSync(join(f.output, "supervisor.dispatch.private.json"), "utf8")).toContain('"failureCode": "EACCES"');
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("retries a transient Windows supervisor receipt rename and completes the same launch", async () => {
    const f = fixture();
    let held = false;
    const sleep = vi.fn();
    const receiptIo = { platform: "win32", sleep, rename(from: string, to: string) {
      if (!held) { held = true; throw Object.assign(new Error("reader lock"), { code: "EPERM" }); }
      renameSync(from, to);
    } };
    await expect(superviseCourseSupportWorker(f.input, { ...f.deps, receiptIo })).resolves.toMatchObject({ outcome: "completed" });
    expect(sleep).toHaveBeenCalledOnce();
    expect(readFileSync(join(f.output, "supervisor.receipt.private.json"), "utf8")).toContain('"status": "COMPLETED"');
    expect(f.deps.prepare).toHaveBeenCalledOnce();
  });

  it("keeps the start refusal when writing ATTENTION also fails", async () => {
    const f = fixture();
    f.deps.spawn.mockReturnValueOnce({ status: 2, stdout: "", stderr: "refused" });
    const receiptIo = { platform: "win32", sleep: () => {}, rename(from: string, to: string) {
      if (JSON.parse(readFileSync(from, "utf8")).status === "ATTENTION") {
        throw Object.assign(new Error("reader lock"), { code: "EPERM" });
      }
      renameSync(from, to);
    } };
    await expect(superviseCourseSupportWorker(f.input, { ...f.deps, receiptIo })).rejects.toMatchObject({
      code: "DISPATCH_START_FAILED", diagnosticWriteFailureCode: "EPERM",
    });
    expect(f.deps.prepare).not.toHaveBeenCalled();
    expect(readFileSync(join(f.output, "supervisor.receipt.private.json"), "utf8")).toContain('"status": "START_REQUESTED"');
  });

  it("keeps the parent guard error when dispatch ATTENTION cannot be written", async () => {
    const f = fixture();
    const receiptIo = { platform: "win32", sleep: () => {}, rename() {
      throw Object.assign(new Error("reader lock"), { code: "EPERM" });
    } };
    await expect(dispatchCourseSupportWorker({ ...f.input, parentThreadId: CHILD },
      { contextFile: join(f.output, "context.json"), assignmentFile: join(f.output, "assignment.json") },
      { ...f.deps, receiptIo })).rejects.toMatchObject({ code: "NATIVE_PARENT_ID_MISMATCH", diagnosticWriteFailureCode: "EPERM" });
    expect(readFileSync(join(f.output, "supervisor.dispatch.private.json"), "utf8")).toContain('"status": "DISPATCHING"');
  });
  it("requires actual parent, exact preflight context, reserved assignment and current base before start", () => {
    const f = fixture();
    expect(() => validateSupervisorInput({ ...f.input, parentThreadId: "" }, f.deps)).toThrow("NATIVE_PARENT_ID_REQUIRED");
    expect(() => validateSupervisorInput({ ...f.input, parentThreadId: CHILD }, f.deps)).toThrow("NATIVE_PARENT_ID_MISMATCH");
    expect(() => validateSupervisorInput({ ...f.input, assignment: { ...f.input.assignment, state: "STARTING" } }, f.deps)).toThrow("RESERVED_ASSIGNMENT_REQUIRED");
    expect(() => validateSupervisorInput({ ...f.input, context: { ...f.input.context, exactHead: false } }, f.deps)).toThrow("INVALID_PREFLIGHT_CONTEXT");
    f.deps.git.mockImplementationOnce(() => "b".repeat(40));
    expect(() => validateSupervisorInput(f.input, f.deps)).toThrow("SELECTED_CHECKOUT_CHANGED");
    expect(f.deps.spawn).not.toHaveBeenCalled();
    expect(f.deps.prepare).not.toHaveBeenCalled();
  });

  it("starts, prepares one native chat, binds its proven identity and runs the mode prompt once", async () => {
    const f = fixture("SIMULATOR");
    const result = await superviseCourseSupportWorker(f.input, f.deps);
    expect(result).toMatchObject({ outcome: "completed", childThreadId: CHILD });
    expect(f.calls).toEqual(["template:simulator", "start", "prepare", "bind", "run"]);
    const prompt = readFileSync(join(f.output, "worker.prompt.private.md"), "utf8");
    expect(prompt).toContain(REF);
    expect(prompt).toContain(f.selected);
    expect(prompt).not.toContain("<assignment-ref>");
    expect(readFileSync(join(f.output, "supervisor.receipt.private.json"), "utf8")).toContain('"status": "COMPLETED"');
    await expect(superviseCourseSupportWorker(f.input, f.deps)).rejects.toMatchObject({ code: "EEXIST" });
    expect(f.deps.prepare).toHaveBeenCalledTimes(1);
  });

  it("leaves ambiguous native preparation as attention and never binds or runs", async () => {
    const f = fixture();
    f.deps.prepare.mockRejectedValueOnce(new Error("transport lost after creation"));
    await expect(superviseCourseSupportWorker(f.input, f.deps)).rejects.toThrow("transport lost");
    expect(f.calls).toEqual(["template:outdoor", "start"]);
    expect(readFileSync(join(f.output, "supervisor.receipt.private.json"), "utf8")).toContain('"failedAt": "PREPARE_REQUESTED"');
    expect(f.deps.run).not.toHaveBeenCalled();
  });

  it("does not create a native child when the durable start is refused", async () => {
    const f = fixture();
    f.deps.spawn.mockReturnValueOnce({ status: 2, stdout: "", stderr: "refused" });
    await expect(superviseCourseSupportWorker(f.input, f.deps)).rejects.toThrow("DISPATCH_START_FAILED");
    expect(f.deps.prepare).not.toHaveBeenCalled();
    expect(f.deps.run).not.toHaveBeenCalled();
    expect(readFileSync(join(f.output, "supervisor.receipt.private.json"), "utf8")).toContain('"failedAt": "START_REQUESTED"');
  });

  it.each([
    ["lease refused", JSON.stringify({ acquired: false })],
    ["missing envelope", JSON.stringify({ assignmentRef: REF, state: "STARTING" })],
    ["wrong state", JSON.stringify({ acquired: true, value: { assignmentRef: REF, state: "RESERVED" } })],
    ["stale plan base", JSON.stringify({ acquired: true, value: { assignmentRef: REF, state: "STARTING", baseSha: "b".repeat(40) } })],
    ["missing base", JSON.stringify({ acquired: true, value: { assignmentRef: REF, state: "STARTING" } })],
    ["malformed response", "not JSON"],
  ])("does not create a child when start proof is %s", async (_label, stdout) => {
    const f = fixture();
    f.deps.spawn.mockReturnValueOnce({ status: 0, stdout, stderr: "" });
    await expect(superviseCourseSupportWorker(f.input, f.deps)).rejects.toThrow(/DISPATCH_START_PROOF_/);
    expect(f.deps.prepare).not.toHaveBeenCalled();
    expect(f.deps.run).not.toHaveBeenCalled();
  });

  it("refuses to start a turn when durable bind refuses the child", async () => {
    const f = fixture();
    f.deps.spawn.mockImplementationOnce(() => ({ status: 0, stdout: JSON.stringify({ acquired: true, value: {
      assignmentRef: REF, state: "STARTING", baseSha: SHA } }), stderr: "" }))
      .mockImplementationOnce(() => ({ status: 2, stdout: "", stderr: "denied" }));
    await expect(superviseCourseSupportWorker(f.input, f.deps)).rejects.toThrow("DISPATCH_BIND_FAILED");
    expect(f.deps.prepare).toHaveBeenCalledOnce();
    expect(f.deps.run).not.toHaveBeenCalled();
  });

  it("refuses to start a turn when bind acknowledges another base", async () => {
    const f = fixture();
    f.deps.spawn.mockImplementationOnce(() => ({ status: 0, stdout: JSON.stringify({ acquired: true, value: {
      assignmentRef: REF, state: "STARTING", baseSha: SHA } }), stderr: "" }))
      .mockImplementationOnce(() => ({ status: 0, stdout: JSON.stringify({ acquired: true, value: {
        assignmentRef: REF, state: "BOUND", baseSha: "b".repeat(40) } }), stderr: "" }));
    await expect(superviseCourseSupportWorker(f.input, f.deps)).rejects.toThrow("DISPATCH_BIND_PROOF_MISMATCH");
    expect(f.deps.prepare).toHaveBeenCalledOnce();
    expect(f.deps.run).not.toHaveBeenCalled();
  });

  it("uses the outdoor template for an outdoor assignment", () => {
    const f = fixture();
    expect(workerInstructions("OUTDOOR", f.selected, REF, f.deps)).toContain(REF);
    expect(f.calls).toEqual(["template:outdoor"]);
  });
  it.each(["OUTDOOR", "SIMULATOR"])("keeps the %s coding worker on Sol and includes terminal-learning recovery gates", mode => {
    const f = fixture();
    const prompt = workerInstructions(mode, f.selected, REF, f.deps);
    expect(prompt).toContain("Use only gpt-6.1-sol through the existing ChatGPT/Codex sign-in");
    expect(prompt).toContain("await cua.getState()");
    expect(prompt).toContain("already has an active request");
    expect(prompt).toContain("times out during service_info");
    expect(prompt).toContain("one last inventory attempt");
    expect(prompt).toContain("a disconnect, an access denial, or failure after those attempts as a setup stop");
    expect(prompt).toContain("not evidence that First user is unavailable");
    expect(prompt).toContain("discoveryEngineeringFailure");
    expect(prompt).toContain("INVESTIGATE_PUBLIC_SOURCE");
    expect(prompt).toContain("First user Chrome");
    expect(prompt).toContain("repair_required");
    expect(prompt).toContain("When the action plan authorizes only VERIFY_CURRENT_RUNTIME, run the owner-bound verifier");
    expect(prompt).toContain("only when the owned action and exclusive path authority authorize implementation");
    expect(prompt).toContain("Keep the original failed discovery job terminal and its clock unchanged");
    expect(prompt).toContain("Never manually send email or change customer alert inputs");
    expect(prompt).toContain("a verifier with terminal exit code 0");
    expect(prompt).toContain("Unknown failure cause is not proof of uncertain operation effects");
    expect(prompt).toContain("only when that current context explicitly permits tooling repair");
    expect(prompt).toContain("Nonzero or unfinished protected commands");
  });
  it("rejects an old template that directs a worker to another model", () => {
    const f = fixture();
    f.deps.readFile = () => "<assignment-ref> <selected-checkout> may use Astra Medium";
    expect(() => workerInstructions("OUTDOOR", f.selected, REF, f.deps)).toThrow("SOL_ONLY_WORKER_TEMPLATE_REQUIRED");
  });
  it.each(["OUTDOOR", "SIMULATOR"])("keeps bounded native identity corroboration separate from %s provider authority", mode => {
    const f = fixture(), prompt = workerInstructions(mode, f.selected, REF, f.deps);
    expect(prompt.indexOf("Separate native identity research")).toBeGreaterThan(prompt.indexOf("Nonzero or unfinished protected commands"));
    expect(prompt).toContain("same live, validated outdoor full repair with both INVESTIGATE_PUBLIC_SOURCE and IMPLEMENT_REUSABLE_SUPPORT");
    expect(prompt).toContain("current source-bound learningPhysicalBindingEvidence street conflict");
    expect(prompt).toContain("at most one exact venue/locality search and two sequential signed-out public identity/contact pages");
    expect(prompt).toContain("observations remain untrusted evidence, never monitoring or source/configuration authority");
    expect(prompt).toContain("Do not accept either street by assumption or weaken identity checks");
    expect(prompt).toContain("separately required SEARCH_FOR_OFFICIAL_SOURCE action");
    expect(prompt).toContain("fetch a denied resource through another URL");
    expect(prompt).toContain("LOCAL_READER_ONLY remains fenced");
    expect(prompt).toContain("does not add any read to a simulator's research guide");
    expect(prompt).toContain("Independent identity pages exclude provider directory/API probing");
  });
});
