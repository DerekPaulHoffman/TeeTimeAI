// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changedPaths, runOriginalWorkerContinuation, originalWorkerContinuationPrompt,
  validateOriginalWorkerContinuation } from "../../../scripts/automation/course-support-worker-continuation.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const threadId = "11111111-2222-7333-8444-555555555555";
const oldTurn = "aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const newTurn = "bbbbbbbb-cccc-7ddd-8eee-ffffffffffff";
const qualifiedDigest = "9e7c59c05cc1ce5677b1f94e835b2ac038ca3be14504e78d558eacdb0ea3f55d";

function validationFixture() {
  const root = mkdtempSync(join(tmpdir(), "course-original-validation-")); roots.push(root);
  const selected = join(root, "selected"), worker = join(root, "worker"), outputDir = join(root, "private"),
    common = join(root, "shared.git"), cliPath = join(root, "codex.exe");
  const path = "src/lib/simulators/providers/new-reader.ts";
  for (const directory of [selected, worker, outputDir, common, join(worker, "src", "lib", "simulators", "providers")]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(join(worker, path), "export const originalOwnedWork = true;\n");
  writeFileSync(cliPath, "inert executable fixture");
  mkdirSync(join(selected, "node_modules", "vercel", "dist"), { recursive: true });
  writeFileSync(join(selected, "node_modules", "vercel", "package.json"), JSON.stringify({ name: "vercel", version: "62.2.0", bin: { vercel: "./dist/vc.js" } }));
  writeFileSync(join(selected, "node_modules", "vercel", "dist", "vc.js"), "fixture");
  writeFileSync(join(selected, "node_modules", "vercel", "dist", "index.js"), "fixture");
  writeFileSync(join(selected, "node_modules", "vercel", "dist", "version.mjs"), "fixture");
  const launcherReceiptPath = join(outputDir, "launcher.receipt.private.json");
  const branch = "automation/course-support-original", baseSha = "a".repeat(40), mainSha = "b".repeat(40),
    workerHead = "c".repeat(40), sourceFingerprint = "d".repeat(64), parentThreadId = "aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  const original = { schemaVersion: 1, status: "STOPPED", threadId, turnId: oldTurn,
    nativeIdentityVerified: true, approvalRequests: 0, approvalPolicy: "never", cwd: worker, branch, baseSha,
    cliVersion: "codex-cli 0.160.1", cliPath, sandbox: { type: "dangerFullAccess" },
    activePermissionProfile: { id: ":danger-full-access" }, launcherPid: 101, serverPid: 102 };
  writeFileSync(launcherReceiptPath, JSON.stringify(original));
  const context = { kind: "course_support_preflight_context", exactHead: true, selectedCheckout: selected,
    workerCli: { status: "current", cliPath, cliVersion: original.cliVersion } };
  const item = { mode: "SIMULATOR", assignmentRef: "course-assignment-11111111-2222-7333-8444-555555555555",
    threadId, claimToken: "cccccccc-dddd-7eee-8fff-aaaaaaaaaaaa", claimRevision: 7,
    sourceFingerprint, baseSha, branch, launcherReceiptPath, plannedPaths: [path], releaseSha: null,
    checkpoint: { kind: "EXPIRED_OWNED_STAGE", claimLeaseExpired: true,
      ownedStage: { sourceFingerprint, branch, plannedPaths: [path], releaseSha: null } },
    expectedNativeContinuation: null };
  const reservation = { acquired: true, value: { reserved: true, mode: "SIMULATOR",
    assignmentRef: item.assignmentRef, threadId, scope: "RESUME_ORIGINAL_OWNED_STAGE", continuationKey: "e".repeat(64) } };
  const input = { context, item, reservation, launcherReceiptPath, outputDir, parentThreadId };
  const git = vi.fn((cwd: string, args: string[]) => {
    const command = args.join(" ");
    if (cwd === selected) {
      if (command === "rev-parse HEAD" || command === "rev-parse origin/main") return mainSha;
      if (command === "status --porcelain -z --untracked-files=all") return "";
      if (command === "rev-parse --git-common-dir") return common;
    }
    if (cwd === worker) {
      if (command === "rev-parse HEAD") return workerHead;
      if (command === "rev-parse --show-toplevel") return worker;
      if (command === "branch --show-current") return branch;
      if (command === "rev-parse --git-common-dir") return common;
      if (command === `merge-base ${baseSha} ${mainSha}`) return baseSha;
      if (command === "status --porcelain -z --untracked-files=all") return ` M ${path}\0`;
    }
    throw new Error(`Unexpected injected Git read: ${command}`);
  });
  const dependencies = { environment: { CODEX_THREAD_ID: parentThreadId }, approvedCheckouts: [selected],
    inspectCli: vi.fn(() => ({ status: "current", cliPath, cliVersion: original.cliVersion })), git,
    observeProcess: vi.fn(() => "absent"), runtime: vi.fn(() => ({ status: "available", nodePath: process.execPath })),
    readCliVersion: vi.fn(() => original.cliVersion), readCliDigest: vi.fn(() => qualifiedDigest) };
  return { root, selected, worker, outputDir, common, cliPath, path, original, input, dependencies, workerHead, mainSha };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "course-original-continuation-")); roots.push(root);
  const output = join(root, "private"); mkdirSync(output);
  const worker = join(root, "worker"); mkdirSync(worker);
  const selected = join(root, "selected"); mkdirSync(selected);
  mkdirSync(join(selected, "node_modules", "vercel", "dist"), { recursive: true });
  writeFileSync(join(selected, "node_modules", "vercel", "package.json"), JSON.stringify({ name: "vercel", version: "62.2.0", bin: { vercel: "./dist/vc.js" } }));
  writeFileSync(join(selected, "node_modules", "vercel", "dist", "vc.js"), "fixture");
  writeFileSync(join(selected, "node_modules", "vercel", "dist", "index.js"), "fixture");
  writeFileSync(join(selected, "node_modules", "vercel", "dist", "version.mjs"), "fixture");
  const item = { assignmentRef: "course-assignment-11111111-2222-7333-8444-555555555555", threadId,
    claimToken: "cccccccc-dddd-7eee-8fff-aaaaaaaaaaaa", claimRevision: 7, plannedPaths: ["src/lib/simulators/example.ts"] };
  const validated = { output, selected, worker, head: "a".repeat(40), item,
    original: { status: "STOPPED", turnId: oldTurn, launcherPid: 101, serverPid: 102 }, originalStatusDigest: createHash("sha256").digest("hex"),
    runtime: { status: "available", nodePath: process.execPath, npmCliPath: join(root, "npm-cli.js") }, approved: { cliPath: process.execPath },
    reservation: { scope: "RESUME_ORIGINAL_OWNED_STAGE", continuationKey: "e".repeat(64) } };
  const calls: string[] = [];
  let onMessage: (message: unknown) => void = () => {};
  const request = vi.fn(async (method: string) => {
    calls.push(method);
    if (method in overrides) return overrides[method];
    if (method === "initialize") return {};
    if (method === "permissionProfile/list") return { data: [{ id: ":danger-full-access", allowed: true }] };
    if (method === "thread/read") return { thread: { id: threadId, cwd: worker, status: { type: "idle" } } };
    if (method === "thread/turns/list") return { data: [{ id: oldTurn, status: "failed", error: { message: "private" } }] };
    if (method === "thread/resume") return { thread: { id: threadId, status: { type: "idle" } }, cwd: worker,
      approvalPolicy: "never", sandbox: { type: "dangerFullAccess" }, activePermissionProfile: { id: ":danger-full-access" } };
    if (method === "turn/start") {
      queueMicrotask(() => {
        onMessage({ method: "turn/started", params: { threadId, turn: { id: newTurn } } });
        onMessage({ method: "item/completed", params: { threadId, turnId: newTurn,
          item: { type: "commandExecution", exitCode: 0, aggregatedOutput: JSON.stringify({ courseWorkerNativeIdentity: { present: true, matchesExpected: true } }) } } });
        onMessage({ method: "turn/completed", params: { threadId, turn: { id: newTurn, status: "completed" } } });
      });
      return { turn: { id: newTurn } };
    }
    throw new Error(`unexpected ${method}`);
  });
  const clientFactory = vi.fn((options: { onMessage: (message: unknown) => void }) => {
    onMessage = options.onMessage;
    return { pid: 500, request, notify: vi.fn(), close: vi.fn(async () => {}) };
  });
  const acknowledge = vi.fn();
  const dependencies = { validate: vi.fn(() => validated), readFile: vi.fn(() =>
    "<assignment-ref> <native-thread-id> <selected-checkout> <continuation-scope> <tooling-sha>"),
    clientFactory, acknowledge, observeProcess: vi.fn(() => "absent"),
    git: vi.fn(() => "") };
  return { input: {}, validated, dependencies, calls, request, clientFactory, acknowledge, output };
}

describe("deterministic original-worker continuation", () => {
  it("rejects missing selected CLI readiness before any native continuation", () => {
    const f = validationFixture();
    unlinkSync(join(f.selected, "node_modules", "vercel", "dist", "vc.js"));
    expect(() => validateOriginalWorkerContinuation(f.input, f.dependencies)).toThrow("CONTINUATION_VERCEL_NOT_READY");
  });

  it("acknowledges through the selected private CLI with no package installation or product keys", async () => {
    const f = fixture();
    const spawnSync = vi.fn(() => ({ status: 0, stdout: JSON.stringify({ acquired: true, value: {
      assignmentRef: f.validated.item.assignmentRef, threadId, outcome: "same_worker_message_recorded" } }), stderr: "" }));
    await runOriginalWorkerContinuation(f.input, { ...f.dependencies, acknowledge: undefined, spawnSync });
    expect(spawnSync).toHaveBeenCalledOnce();
    const [command, args, settings] = spawnSync.mock.calls[0] as unknown as [string, string[], { cwd: string; env: Record<string, string> }];
    expect(command).toBe(f.validated.runtime.nodePath);
    expect(args[0]).toBe(join(f.validated.selected, "node_modules", "vercel", "dist", "vc.js"));
    expect(args).not.toContain("exec");
    expect(args.slice(1, 7)).toEqual(["env", "run", "-e", "production", "--", f.validated.runtime.nodePath]);
    expect(settings.cwd).toBe(f.validated.selected);
    expect(settings.env.DATABASE_URL).toBeUndefined(); expect(settings.env.RESEND_API_KEY).toBeUndefined();
  });

  it("validates the real original receipt and shared linked-checkout identity with registered dirty bytes", () => {
    const f = validationFixture();
    expect(f.dependencies.git(f.worker, ["rev-parse", "HEAD"])).toBe(f.workerHead);
    expect(f.workerHead).not.toBe(f.mainSha);
    const result = validateOriginalWorkerContinuation(f.input, f.dependencies);
    expect(result).toMatchObject({ selected: f.selected, worker: f.worker, output: f.outputDir,
      head: f.mainSha, expectedTerminalTurnId: oldTurn, original: { branch: f.input.item.branch, baseSha: f.input.item.baseSha } });
    expect(result.originalStatusDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.dependencies.git).toHaveBeenCalledWith(f.worker, ["merge-base", f.input.item.baseSha, f.mainSha]);
    expect(f.dependencies.git).not.toHaveBeenCalledWith(f.worker, ["status", "--porcelain"]);
    expect(f.dependencies.observeProcess).toHaveBeenCalledWith(101);
    expect(f.dependencies.observeProcess).toHaveBeenCalledWith(102);
  });
  it("rejects unknown bytes, source/receipt drift and active original or prior processes before native creation", () => {
    const unknown = validationFixture();
    const git = unknown.dependencies.git.getMockImplementation()!;
    unknown.dependencies.git.mockImplementation((cwd: string, args: string[]) =>
      cwd === unknown.worker && args[0] === "status" ? " M src/lib/simulators/providers/unregistered.ts\0" : git(cwd, args));
    expect(() => validateOriginalWorkerContinuation(unknown.input, unknown.dependencies)).toThrow("UNKNOWN_OWNED_CHECKOUT_CHANGE");

    const changedSource = validationFixture();
    changedSource.input.item.sourceFingerprint = "f".repeat(64);
    expect(() => validateOriginalWorkerContinuation(changedSource.input, changedSource.dependencies)).toThrow("ORIGINAL_OWNED_ITEM_REQUIRED");

    const changedReceipt = validationFixture();
    writeFileSync(changedReceipt.input.launcherReceiptPath, JSON.stringify({ ...changedReceipt.original, branch: "automation/course-support-other" }));
    expect(() => validateOriginalWorkerContinuation(changedReceipt.input, changedReceipt.dependencies)).toThrow("ORIGINAL_STOPPED_RECEIPT_CHANGED");

    const active = validationFixture();
    active.dependencies.observeProcess.mockImplementation((pid: number) => pid === 102 ? "present" : "absent");
    expect(() => validateOriginalWorkerContinuation(active.input, active.dependencies)).toThrow("ORIGINAL_LAUNCHER_OR_SERVER_NOT_ENDED");

    const prior = validationFixture();
    const priorReceiptPath = join(prior.outputDir, "continuation.receipt.private.json");
    const priorKey = "f".repeat(64);
    Object.assign(prior.input.item, { expectedNativeContinuation: { turnId: newTurn, key: priorKey, receiptPath: priorReceiptPath } });
    writeFileSync(priorReceiptPath, JSON.stringify({ schemaVersion: 1, status: "STOPPED", threadId,
      originalTurnId: oldTurn, turnId: newTurn, continuationKey: priorKey,
      nativeIdentityVerified: true, approvalRequests: 0, runnerPid: 201, serverPid: 202 }));
    const validatedPrior = validateOriginalWorkerContinuation(prior.input, prior.dependencies);
    expect(validatedPrior).toMatchObject({ expectedTerminalTurnId: newTurn, priorPids: [201, 202] });
    prior.dependencies.observeProcess.mockImplementation((pid: number) => pid === 202 ? "present" : "absent");
    expect(() => validateOriginalWorkerContinuation(prior.input, prior.dependencies)).toThrow("PRIOR_CONTINUATION_UNPROVED");
  });
  it("keeps the leading porcelain status blank for a real unstaged owned edit", () => {
    expect(changedPaths("C:/original", () => " M src/lib/simulators/providers/public-rental.ts\0"))
      .toEqual(["src/lib/simulators/providers/public-rental.ts"]);
    expect(changedPaths("C:/original", () => "?? src/lib/simulators/providers/new-reader.ts\0"))
      .toEqual(["src/lib/simulators/providers/new-reader.ts"]);
  });
  it("starts only the exact original thread and records native acceptance once", async () => {
    const f = fixture();
    expect(originalWorkerContinuationPrompt(f.validated, f.dependencies.readFile)).toContain(f.validated.item.claimToken);
    const result = await runOriginalWorkerContinuation(f.input, f.dependencies);
    expect(result).toMatchObject({ outcome: "completed", threadId });
    expect(f.calls).toEqual(["initialize", "permissionProfile/list", "thread/read", "thread/turns/list", "thread/resume", "turn/start"]);
    expect(f.calls).not.toContain("thread/start");
    expect(f.acknowledge).toHaveBeenCalledOnce();
    const send = JSON.parse(readFileSync(join(f.output, "continuation.sent.private.json"), "utf8"));
    expect(send.toolReceipt).toEqual({ source: "codex_native.turn_start", threadId, turnId: newTurn,
      receiptPath: join(f.output, "continuation.receipt.private.json"), accepted: true });
    await expect(runOriginalWorkerContinuation(f.input, f.dependencies)).rejects.toThrow();
    expect(f.clientFactory).toHaveBeenCalledOnce();
  });
  it("continues an ended normal native turn only from its completed error-free receipt", async () => {
    const f = fixture({ "thread/turns/list": { data: [{ id: oldTurn, status: "completed", error: null }] } });
    Object.assign(f.validated.original, { status: "COMPLETED", turnStatus: "completed" });
    await expect(runOriginalWorkerContinuation(f.input, f.dependencies)).resolves.toMatchObject({ outcome: "completed" });
    expect(f.calls).toContain("turn/start");
    const bad = fixture({ "thread/turns/list": { data: [{ id: oldTurn, status: "completed", error: { message: "failure" } }] } });
    Object.assign(bad.validated.original, { status: "COMPLETED", turnStatus: "completed" });
    await expect(runOriginalWorkerContinuation(bad.input, bad.dependencies)).rejects.toThrow("ORIGINAL_NATIVE_TERMINAL_TURN_CHANGED");
    expect(bad.calls).not.toContain("turn/start");
  });
  it("refuses a still-active or mismatched original before turn/start", async () => {
    for (const altered of [
      { thread: { id: threadId, cwd: "another-checkout", status: { type: "idle" } } },
      { thread: { id: threadId, cwd: "ignored", status: { type: "active" } } },
      { thread: { id: threadId, cwd: "ignored", status: { type: "idle", pendingApproval: { id: "approval" } } } },
    ]) {
      const f = fixture({ "thread/read": altered });
      await expect(runOriginalWorkerContinuation(f.input, f.dependencies)).rejects.toThrow();
      expect(f.calls).not.toContain("turn/start");
      expect(f.acknowledge).not.toHaveBeenCalled();
    }
  });
  it("rechecks the prior continuation runner and server before another native turn", async () => {
    const f = fixture();
    Object.assign(f.validated, { priorPids: [600, 601] });
    f.dependencies.observeProcess.mockImplementation((pid: number) => pid === 600 ? "present" : "absent");
    await expect(runOriginalWorkerContinuation(f.input, f.dependencies)).rejects.toThrow("ORIGINAL_LAUNCHER_OR_SERVER_NOT_ENDED");
    expect(f.calls).not.toContain("turn/start");
  });
});
