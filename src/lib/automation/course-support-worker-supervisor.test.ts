import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchCourseSupportWorker, readSupervisorArguments, superviseCourseSupportWorker, validateSupervisorInput, workerInstructions } from "../../../scripts/automation/course-support-worker-supervisor.mjs";

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
  const cli = join(selected, "codex.exe"), node = join(root, "node.exe"), npm = join(root, "npm-cli.js");
  for (const file of [cli, node, npm]) writeFileSync(file, "fixture");
  const context = { kind: "course_support_preflight_context", selectedCheckout: selected, exactHead: true,
    workerCli: { status: "current", cliPath: cli, cliVersion: "codex-cli 0.160.1" } };
  const assignment = { state: "RESERVED", assignmentRef: REF, ...(mode ? { mode } : {}) };
  const input = { context, assignment, workerCheckout: worker, outputDir: output, parentThreadId: PARENT };
  const calls: string[] = [];
  const deps = {
    environment: { CODEX_THREAD_ID: PARENT, CODEX_HOME: "normal-auth-home", DATABASE_URL: "private-db", RESEND_API_KEY: "private-email" },
    approvedCheckouts: [selected],
    inspectCli: vi.fn(() => context.workerCli),
    inspectWorker: vi.fn(() => ({ cwd: worker, branch: "automation/course-support-fixture", baseSha: SHA })),
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
    prepare: vi.fn(async ({ receiptPath }: { receiptPath: string }) => {
      calls.push("prepare");
      writeFileSync(receiptPath, JSON.stringify({ status: "PREPARED", threadId: CHILD, approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" }, activePermissionProfile: { id: ":danger-full-access" }, cwd: worker }));
      return { outcome: "prepared", threadId: CHILD, receiptPath };
    }),
    run: vi.fn(async () => { calls.push("run"); return { outcome: "completed", nativeIdentityVerified: true, approvalRequests: 0 }; }),
  };
  return { input, deps, calls, output, selected, worker };
}

describe("course worker launch supervisor", () => {
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
});
