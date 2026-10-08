// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changedPaths, runOriginalWorkerContinuation, originalWorkerContinuationPrompt } from "../../../scripts/automation/course-support-worker-continuation.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const threadId = "11111111-2222-7333-8444-555555555555";
const oldTurn = "aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const newTurn = "bbbbbbbb-cccc-7ddd-8eee-ffffffffffff";

function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "course-original-continuation-")); roots.push(root);
  const output = join(root, "private"); mkdirSync(output);
  const worker = join(root, "worker"); mkdirSync(worker);
  const selected = join(root, "selected"); mkdirSync(selected);
  const item = { assignmentRef: "course-assignment-11111111-2222-7333-8444-555555555555", threadId,
    claimToken: "cccccccc-dddd-7eee-8fff-aaaaaaaaaaaa", claimRevision: 7, plannedPaths: ["src/lib/simulators/example.ts"] };
  const validated = { output, selected, worker, head: "a".repeat(40), item,
    original: { status: "STOPPED", turnId: oldTurn, launcherPid: 101, serverPid: 102 }, originalStatusDigest: createHash("sha256").digest("hex"),
    runtime: { status: "available", nodePath: process.execPath }, approved: { cliPath: process.execPath },
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
