// @vitest-environment node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeCourseSupportNativeCompletion, readNativeObserverArguments } from "../../../scripts/automation/course-support-native-observer.mjs";
import { courseSupportWorkerAppServerEnvironment } from "../../../scripts/automation/course-support-worker-launcher.mjs";

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
  it("prepares a new scheduled recovery report folder and preserves its exclusive observation", async () => {
    const value = fixture();
    const reportFolder = join(value.options.expectedCheckout, ".codex-artifacts", "new-recovery-cycle");
    const options = { ...value.options, observationPath: join(reportFolder, "native-observation.private.json") };
    expect(existsSync(reportFolder)).toBe(false);
    await expect(observeCourseSupportNativeCompletion(options))
      .resolves.toMatchObject({ phase: "READ_ONLY_OBSERVATION_COMPLETE" });
    const observationBytes = readFileSync(options.observationPath);
    expect(value.request.mock.calls.map(([method]) => method))
      .toEqual(["initialize", "permissionProfile/list", "thread/read", "thread/turns/list"]);
    expect(readFileSync(value.options.receiptPath)).toEqual(value.before);
    await expect(observeCourseSupportNativeCompletion(options)).rejects.toThrow("NEW_PRIVATE_OBSERVATION_PATH_REQUIRED");
    expect(readFileSync(options.observationPath)).toEqual(observationBytes);
    expect(value.options.clientFactory).toHaveBeenCalledOnce();
  });

  it("does not prepare a recovery report folder before the original process and environment guards pass", async () => {
    for (const rejection of ["process", "environment"]) {
      const value = fixture();
      const reportFolder = join(value.options.expectedCheckout, ".codex-artifacts", "denied-recovery-cycle");
      if (rejection === "process") value.options.inspectProcess.mockReturnValue("present");
      else value.options.environmentFactory.mockReturnValue({ DATABASE_URL: "test-value" });
      await expect(observeCourseSupportNativeCompletion({ ...value.options,
        observationPath: join(reportFolder, "native-observation.private.json") })).rejects.toThrow(
        rejection === "process" ? "ORIGINAL_LAUNCHER_OR_SERVER_NOT_ENDED" : "PRODUCT_OR_NATIVE_IDENTITY_ENV_PRESENT"
      );
      expect(existsSync(reportFolder)).toBe(false);
      expect(value.options.clientFactory).not.toHaveBeenCalled();
      expect(readFileSync(value.options.receiptPath)).toEqual(value.before);
    }
  });

  it("accepts the real app-server environment without a CLI setting or product/native identity keys", async () => {
    const value = fixture();
    const runtime = { status: "available", nodePath: "C:\\Program Files\\nodejs\\node.exe", npmCliPath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" };
    await expect(observeCourseSupportNativeCompletion({ ...value.options,
      environmentFactory: cwd => courseSupportWorkerAppServerEnvironment(cwd, {
        PATH: "inert-path", CODEX_HOME: "normal-auth-home", CODEX_THREAD_ID: "private-native", DATABASE_URL: "private-db", VERCEL_TOKEN: "private-token", VERCEL_CLI_USE_NATIVE_BINARY: "1"
      }, runtime) })).resolves.toMatchObject({ phase: "READ_ONLY_OBSERVATION_COMPLETE" });
    const settings = value.options.clientFactory.mock.calls[0][0] as unknown as { environment: Record<string, string> };
    expect(settings.environment.CODEX_HOME).toBe("normal-auth-home");
    for (const key of ["DATABASE_URL", "VERCEL_TOKEN", "CODEX_THREAD_ID", "VERCEL_CLI_USE_NATIVE_BINARY"]) expect(settings.environment[key]).toBeUndefined();
    expect(value.request.mock.calls.map(([method]) => method)).toEqual(["initialize", "permissionProfile/list", "thread/read", "thread/turns/list"]);
    expect(readFileSync(value.options.receiptPath)).toEqual(value.before);
  });

  it.skipIf(process.platform !== "win32")("uses the actual default Windows environment factory without opening a real native server", async () => {
    const value = fixture();
    await expect(observeCourseSupportNativeCompletion({ ...value.options, environmentFactory: undefined }))
      .resolves.toMatchObject({ phase: "READ_ONLY_OBSERVATION_COMPLETE" });
    const settings = value.options.clientFactory.mock.calls[0][0] as unknown as { environment: Record<string, string> };
    expect(Object.keys(settings.environment).some(key => /DATABASE_URL|RESEND|CLERK|GOOGLE|VERCEL|AUTOMATION_API_KEY|CRON_SECRET|EMAIL_ACTION_SECRET/iu.test(key))).toBe(false);
    expect(settings.environment.CODEX_THREAD_ID).toBeUndefined();
    expect(value.request.mock.calls).toHaveLength(4);
  });

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
    const cliFlag = fixture(); cliFlag.options.environmentFactory.mockReturnValue({ VERCEL_CLI_USE_NATIVE_BINARY: "0" });
    await expect(observeCourseSupportNativeCompletion(cliFlag.options)).rejects.toThrow("PRODUCT_OR_NATIVE_IDENTITY_ENV_PRESENT");
    expect(cliFlag.options.clientFactory).not.toHaveBeenCalled();
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
  it.each(["failed", "interrupted"])("records a real %s terminal first turn for a stopped original launcher", async (status) => {
    const value = fixture({ "thread/turns/list": { data: [{ id: "11111111-2222-7333-8444-555555555555", status,
      error: status === "failed" ? { message: "private native failure" } : null, itemsView: "notLoaded", items: [] }] } });
    writeFileSync(value.options.receiptPath, JSON.stringify({ ...value.original, status: "STOPPED", turnStatus: undefined,
      turnId: "11111111-2222-7333-8444-555555555555" }));
    const result = await observeCourseSupportNativeCompletion({ ...value.options, terminalFailure: true });
    expect(result).toMatchObject({ phase: "READ_ONLY_OBSERVATION_COMPLETE", terminalFailure: true });
    expect(value.request.mock.calls.map(([method]) => method)).toEqual(["initialize", "permissionProfile/list", "thread/read", "thread/turns/list"]);
    const mismatch = fixture({ "thread/turns/list": { data: [{ id: "different-turn", status, error: null, itemsView: "notLoaded", items: [] }] } });
    writeFileSync(mismatch.options.receiptPath, JSON.stringify({ ...mismatch.original, status: "STOPPED", turnStatus: undefined,
      turnId: "11111111-2222-7333-8444-555555555555" }));
    await expect(observeCourseSupportNativeCompletion({ ...mismatch.options, terminalFailure: true })).rejects.toThrow("LATEST_DURABLE_TURN_NOT_TERMINAL");
  });
  it("observes a completed original turn as terminal owned-stage evidence without equating it to job completion", async () => {
    const turnId = "11111111-2222-7333-8444-555555555555";
    const value = fixture({ "thread/turns/list": { data: [{ id: turnId, status: "completed", error: null,
      itemsView: "notLoaded", items: [] }] } });
    writeFileSync(value.options.receiptPath, JSON.stringify({ ...value.original, turnId }));
    await expect(observeCourseSupportNativeCompletion({ ...value.options, terminalFailure: true }))
      .resolves.toMatchObject({ phase: "READ_ONLY_OBSERVATION_COMPLETE", terminalFailure: true });
    const invalid = fixture({ "thread/turns/list": { data: [{ id: turnId, status: "completed", error: null,
      itemsView: "notLoaded", items: [] }] } });
    writeFileSync(invalid.options.receiptPath, JSON.stringify({ ...invalid.original, status: "STOPPED", turnId }));
    await expect(observeCourseSupportNativeCompletion({ ...invalid.options, terminalFailure: true }))
      .resolves.toMatchObject({ phase: "READ_ONLY_OBSERVATION_COMPLETE" });
    const errorTurn = fixture({ "thread/turns/list": { data: [{ id: turnId, status: "completed",
      error: { message: "native error" }, itemsView: "notLoaded", items: [] }] } });
    writeFileSync(errorTurn.options.receiptPath, JSON.stringify({ ...errorTurn.original, status: "STOPPED", turnId }));
    await expect(observeCourseSupportNativeCompletion({ ...errorTurn.options, terminalFailure: true }))
      .rejects.toThrow("LATEST_DURABLE_TURN_NOT_TERMINAL");
  });
  it("brackets a later accepted original-thread turn with its immutable prior receipt and absent processes", async () => {
    const laterTurn = "bbbbbbbb-cccc-7ddd-8eee-ffffffffffff", originalTurn = "aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
    const value = fixture({ "thread/turns/list": { data: [{ id: laterTurn, status: "interrupted", error: null,
      itemsView: "notLoaded", items: [] }] } });
    writeFileSync(value.options.receiptPath, JSON.stringify({ ...value.original, status: "STOPPED", turnId: originalTurn }));
    const priorContinuationReceiptPath = join(value.options.expectedCheckout, "prior.private.json");
    const expectedContinuationKey = "f".repeat(64);
    const prior = { schemaVersion: 1, status: "STOPPED", threadId, originalTurnId: originalTurn,
      turnId: laterTurn, continuationKey: expectedContinuationKey, runnerPid: 200, serverPid: 201,
      nativeIdentityVerified: true, approvalRequests: 0 };
    writeFileSync(priorContinuationReceiptPath, JSON.stringify(prior));
    const input = { ...value.options, terminalFailure: true, priorContinuationReceiptPath,
      expectedTerminalTurnId: laterTurn, expectedContinuationKey };
    const result = await observeCourseSupportNativeCompletion(input);
    expect(result).toMatchObject({ priorContinuationTurnId: laterTurn, priorContinuationKey: expectedContinuationKey,
      processObservationBefore: { processes: [{ pid: 100, state: "absent" }, { pid: 101, state: "absent" },
        { pid: 200, state: "absent" }, { pid: 201, state: "absent" }] } });
    const changed = fixture({ "thread/turns/list": { data: [{ id: laterTurn, status: "interrupted", error: null,
      itemsView: "notLoaded", items: [] }] } });
    writeFileSync(changed.options.receiptPath, JSON.stringify({ ...changed.original, status: "STOPPED", turnId: originalTurn }));
    const changedPath = join(changed.options.expectedCheckout, "prior.private.json");
    writeFileSync(changedPath, JSON.stringify({ ...prior, runnerPid: 202 }));
    changed.options.inspectProcess.mockImplementation((pid: number) => pid === 202 ? "present" : "absent");
    await expect(observeCourseSupportNativeCompletion({ ...changed.options, terminalFailure: true,
      priorContinuationReceiptPath: changedPath, expectedTerminalTurnId: laterTurn, expectedContinuationKey }))
      .rejects.toThrow("ORIGINAL_LAUNCHER_OR_SERVER_NOT_ENDED");
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
