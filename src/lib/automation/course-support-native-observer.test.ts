// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeCourseSupportNativeCompletion, readNativeObserverArguments } from "../../../scripts/automation/course-support-native-observer.mjs";

const threadId = "11111111-2222-7333-8444-555555555555";
const executableDigest = "9e7c59c05cc1ce5677b1f94e835b2ac038ca3be14504e78d558eacdb0ea3f55d";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "course-native-observer-")); roots.push(root);
  const cwd = join(root, ".codex", "worktrees", "original-worker", "TeeTimeAI"); mkdirSync(cwd, { recursive: true });
  const receiptPath = join(root, "original.private.json"); const observationPath = join(root, "observation.private.json");
  const original = { schemaVersion: 1, status: "COMPLETED", turnStatus: "completed", threadId, cwd,
    approvalPolicy: "never", sandbox: { type: "dangerFullAccess" }, activePermissionProfile: { id: ":danger-full-access" },
    nativeIdentityVerified: true, approvalRequests: 0, launcherPid: 100, serverPid: 101,
    cliVersion: "codex-cli 0.160.1", cliPath: join(root, "codex.exe") };
  writeFileSync(receiptPath, JSON.stringify(original));
  let hooks: { onMessage: (message: unknown) => void };
  const request = vi.fn(async (method: string) => {
    const override = overrides[method];
    if (typeof override === "function") return override(hooks);
    if (override !== undefined) return override;
    if (method === "permissionProfile/list") return { data: [{ id: ":danger-full-access", allowed: true }] };
    if (method === "thread/read") return { thread: { id: threadId, cwd, status: { type: "notLoaded" }, preview: "untrusted private transcript", source: "vscode", canAcceptDirectInput: null } };
    if (method === "thread/turns/list") return { data: [{ id: "latest-durable-turn", status: "completed", error: null, itemsView: "notLoaded", items: [] }], nextCursor: "actual-older-history" };
    if (method === "initialize") return {};
    throw new Error("Unexpected native method");
  });
  const client = { request, notify: vi.fn(), close: vi.fn(async () => {}) };
  const clientFactory = vi.fn((options: typeof hooks) => { hooks = options; return client; });
  const options = { receiptPath, observationPath, expectedThreadId: threadId, expectedCheckout: cwd, clientFactory,
    inspectCli: vi.fn(() => "codex-cli 0.160.1"), inspectExecutableDigest: vi.fn(() => executableDigest),
    inspectProcess: vi.fn(() => "absent"), environmentFactory: vi.fn(() => ({})), clock: () => new Date("2026-10-07T08:01:00.000Z") };
  return { options, client, original, request, before: readFileSync(receiptPath) };
}
describe("original worker read-only native observer", () => {
  it("issues exactly four read-only RPCs, preserves the original receipt and records opaque paging results", async () => {
    const value = fixture(); const result = await observeCourseSupportNativeCompletion(value.options);
    expect(value.request.mock.calls.map(([method]) => method)).toEqual(["initialize", "permissionProfile/list", "thread/read", "thread/turns/list"]);
    expect(value.client.notify).toHaveBeenCalledExactlyOnceWith("initialized", {});
    expect(value.request).toHaveBeenCalledWith("thread/read", { threadId, includeTurns: false });
    expect(value.request).toHaveBeenCalledWith("thread/turns/list", { threadId, limit: 1, itemsView: "notLoaded", sortDirection: "desc" });
    expect(result).toMatchObject({ phase: "READ_ONLY_OBSERVATION_COMPLETE", observerApprovalRequestCount: 0 });
    const observation = JSON.parse(readFileSync(value.options.observationPath, "utf8"));
    expect(observation.rpcCalls[3].result.nextCursor).toBe("actual-older-history");
    expect(observation.launcherReceiptDigestBefore).toBe(observation.launcherReceiptDigestAfter);
    expect(observation.rpcCalls[2].result.thread).not.toHaveProperty("preview");
    expect(observation.rpcCalls[2].result.thread).not.toHaveProperty("source");
    expect(observation.rpcCalls[2].result.thread).not.toHaveProperty("canAcceptDirectInput");
    expect(observation.rpcCalls[2].result.thread).not.toHaveProperty("updatedAt");
    expect(JSON.stringify(observation)).not.toContain("untrusted private transcript");
    expect(readFileSync(value.options.receiptPath)).toEqual(value.before);
    expect(value.client.close).toHaveBeenCalledOnce();
  });
  it("preserves observed attention fields and refuses unexpectedly loaded native transcript items", async () => {
    const value = fixture(); const originalRequest = value.request.getMockImplementation()!;
    value.request.mockImplementation(async (method: string) => method === "thread/read" ? { thread: {
      id: threadId, cwd: value.original.cwd, status: { type: "notLoaded", activeFlags: ["waitingOnApproval"] },
      pendingApproval: { id: "actual-pending-approval" } } } : originalRequest(method));
    await observeCourseSupportNativeCompletion(value.options);
    const observation = JSON.parse(readFileSync(value.options.observationPath, "utf8"));
    expect(observation.rpcCalls[2].result.thread.status.activeFlags).toEqual(["waitingOnApproval"]);
    expect(observation.rpcCalls[2].result.thread.pendingApproval).toEqual({ id: "actual-pending-approval" });
    const loaded = fixture({ "thread/turns/list": { data: [{ id: "latest", status: "completed", error: null,
      itemsView: "loaded", items: [{ type: "assistantMessage", text: "private transcript item" }] }] } });
    await expect(observeCourseSupportNativeCompletion(loaded.options)).rejects.toThrow("UNEXPECTED_LOADED_NATIVE_TURN_ITEMS");
    expect(readFileSync(loaded.options.observationPath, "utf8")).not.toContain("private transcript item");
  });
  it("fails before opening an observer for changed original identity/profile/process/CLI or product environment", async () => {
    for (const update of [
      { threadId: "aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee" }, { approvalPolicy: "on-request" },
      { nativeIdentityVerified: false }, { approvalRequests: 1 }, { cliVersion: "codex-cli 0.160.0" },
    ]) {
      const value = fixture(); writeFileSync(value.options.receiptPath, JSON.stringify({ ...value.original, ...update }));
      await expect(observeCourseSupportNativeCompletion(value.options)).rejects.toThrow();
      expect(value.options.clientFactory).not.toHaveBeenCalled();
    }
    const present = fixture(); present.options.inspectProcess.mockReturnValue("present");
    await expect(observeCourseSupportNativeCompletion(present.options)).rejects.toThrow("ORIGINAL_LAUNCHER_OR_SERVER_NOT_ENDED");
    expect(present.options.clientFactory).not.toHaveBeenCalled();
    const changed = fixture(); changed.options.inspectExecutableDigest.mockReturnValue("f".repeat(64));
    await expect(observeCourseSupportNativeCompletion(changed.options)).rejects.toThrow("ORIGINAL_PINNED_CLI_CHANGED");
    const keyed = fixture(); keyed.options.environmentFactory.mockReturnValue({ DATABASE_URL: "test-value" });
    await expect(observeCourseSupportNativeCompletion(keyed.options)).rejects.toThrow("PRODUCT_OR_NATIVE_IDENTITY_ENV_PRESENT");
  });
  it("stops on approval, denied profile or live/error-bearing latest turn without a wake RPC", async () => {
    for (const overrides of [
      { initialize: (hooks: { onMessage: (message: unknown) => void }) => { hooks.onMessage({ method: "item/commandExecution/requestApproval" }); return {}; } },
      { "permissionProfile/list": { data: [{ id: ":danger-full-access", allowed: false }] } },
      { "thread/turns/list": { data: [{ id: "live", status: "inProgress", error: null }] } },
      { "thread/turns/list": { data: [{ id: "failed", status: "completed", error: { code: "failed" } }] } },
    ]) {
      const value = fixture(overrides); await expect(observeCourseSupportNativeCompletion(value.options)).rejects.toThrow();
      expect(value.request.mock.calls.every(([method]) => ["initialize", "permissionProfile/list", "thread/read", "thread/turns/list"].includes(method))).toBe(true);
      expect(readFileSync(value.options.receiptPath)).toEqual(value.before);
      expect(JSON.parse(readFileSync(value.options.observationPath, "utf8")).phase).toBe("STOPPED");
      expect(value.client.close).toHaveBeenCalledOnce();
    }
  });
  it("detects original receipt/process drift and never overwrites historical observation files", async () => {
    const drift = fixture(); let receiptReads = 0;
    await expect(observeCourseSupportNativeCompletion({ ...drift.options, readBytes: (path: string) => path === drift.options.receiptPath && ++receiptReads > 1 ?
      Buffer.from(JSON.stringify({ ...drift.original, approvalRequests: 1 })) : readFileSync(path) }))
      .rejects.toThrow("ORIGINAL_RECEIPT_OR_EXECUTABLE_CHANGED");
    expect(readFileSync(drift.options.receiptPath)).toEqual(drift.before);
    const processDrift = fixture(); processDrift.options.inspectProcess.mockReturnValueOnce("absent").mockReturnValueOnce("absent").mockReturnValueOnce("absent").mockReturnValueOnce("present");
    await expect(observeCourseSupportNativeCompletion(processDrift.options)).rejects.toThrow("ORIGINAL_LAUNCHER_OR_SERVER_NOT_ENDED");
    const existing = fixture(); writeFileSync(existing.options.observationPath, "historical proof");
    await expect(observeCourseSupportNativeCompletion(existing.options)).rejects.toThrow();
    expect(existing.options.clientFactory).not.toHaveBeenCalled();
    expect(readFileSync(existing.options.observationPath, "utf8")).toBe("historical proof");
  });
  it("accepts only the exact original observation command arguments", () => {
    expect(readNativeObserverArguments(["--receipt", "receipt", "--observation", "observation", "--thread-id", threadId, "--checkout", "checkout"]))
      .toMatchObject({ receiptPath: "receipt", observationPath: "observation", expectedThreadId: threadId, expectedCheckout: "checkout" });
    for (const args of [["--resume", threadId], ["--receipt", "one", "--receipt", "two"], ["--receipt", "one"]]) {
      expect(() => readNativeObserverArguments(args)).toThrow();
    }
  });
});
