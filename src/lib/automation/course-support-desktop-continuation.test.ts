import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareOwnedDesktopContinuation } from "../../../scripts/automation/course-support-desktop-continuation.mjs";

const PARENT = "11111111-2222-4333-8444-555555555555";
const CHILD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TURN = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const REF = "course-assignment-12345678-1234-4234-8234-123456789abc";
const BEFORE = "a".repeat(40), CURRENT = "b".repeat(40);
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(join(tmpdir(), "course-desktop-continuation-"))) throw new Error("Unexpected test cleanup target");
  rmSync(root, { recursive: true, force: true });
} });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "course-desktop-continuation-")); roots.push(root);
  const selected = join(root, "selected"), worker = join(root, "worker"), common = join(root, "common");
  for (const dir of [selected, worker, common, join(selected, ".codex-artifacts"), join(selected, "docs")]) mkdirSync(dir);
  writeFileSync(join(selected, "docs", "course-support-full-repair-continuation.md"), "Trusted original-owner continuation guide.");
  const launcherPath = join(root, "launcher.receipt.private.json");
  const launcher = { schemaVersion: 1, status: "DESKTOP_REQUESTED", executionMode: "DESKTOP", threadId: CHILD,
    cwd: worker, baseSha: BEFORE, branch: "automation/course-support-test", model: "gpt-6.1-sol", authentication: "ChatGPT",
    approvalPolicy: "never", sandbox: { type: "dangerFullAccess" }, activePermissionProfile: { id: ":danger-full-access" } };
  writeFileSync(launcherPath, JSON.stringify(launcher));
  const context = { kind: "course_support_preflight_context", exactHead: true, selectedCheckout: selected };
  const item = { kind: "OWNED_OUTDOOR_FULL_REPAIR", assignmentRef: REF, threadId: CHILD,
    launcherReceiptPath: launcherPath, batchReference: "owned-batch-reference", baseSha: BEFORE, releaseSha: BEFORE };
  const request = vi.fn(async (method: string) => {
    if (method === "initialize") return {};
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "thread/read") return { thread: { id: CHILD, cwd: worker, status: { type: "idle" } } };
    if (method === "thread/turns/list") return { data: [{ id: TURN, status: "completed", error: null, itemsView: "notLoaded", items: [], completedAt: 1700000000 }] };
    throw new Error("Unexpected native operation");
  });
  const client = { request, notify: vi.fn(), close: vi.fn(async () => {}) };
  const deps = { environment: { CODEX_THREAD_ID: PARENT }, approvedCheckouts: [selected],
    inspectCli: vi.fn(() => ({ status: "current", cliPath: join(selected, "codex.exe") })),
    resolveRuntime: vi.fn(() => ({ status: "available", nodePath: process.execPath })), clientFactory: vi.fn(() => client),
    git: vi.fn((cwd: string, args: string[]) => {
      if (args[0] === "merge-base") return "";
      if (args[0] === "status") return "";
      if (args[0] === "branch") return launcher.branch;
      if (args[1] === "--git-common-dir") return common;
      if (args[1] === "--absolute-git-dir") return worker;
      return cwd === worker ? BEFORE : CURRENT;
    }),
  };
  return { root, selected, worker, launcherPath, launcher, context, item, deps, client };
}

describe("original Desktop full-repair continuation", () => {
  it("continues only the same clean published implementation owner after proving its registered release is on main", async () => {
    const f = fixture(), published = "c".repeat(40);
    const item = { ...f.item, continuationMode: "PUBLISHED_IMPLEMENTATION", releaseSha: published };
    const priorGit = f.deps.git.getMockImplementation()!;
    f.deps.git.mockImplementation((cwd, args) => cwd === f.worker && args[0] === "rev-parse" && args[1] === "HEAD"
      ? published : priorGit(cwd, args));
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps))
      .toMatchObject({ outcome: "desktop_continuation_message_required", threadId: CHILD,
        prompt: expect.stringContaining("Continuation mode: PUBLISHED_IMPLEMENTATION") });
    expect(f.deps.git).toHaveBeenCalledWith(f.selected, ["merge-base", "--is-ancestor", BEFORE, published]);
    expect(f.deps.git).toHaveBeenCalledWith(f.selected, ["merge-base", "--is-ancestor", published, CURRENT]);
    expect(f.deps.git.mock.calls.some(([, args]) => ["merge", "checkout", "reset", "commit"].includes(args[0]))).toBe(false);
    expect(JSON.parse(readFileSync(f.launcherPath, "utf8"))).toEqual(f.launcher);
  });

  it.each(["unpublished", "unregistered-head", "unchanged-release", "unknown-mode"])("rejects a %s implementation continuation", async scenario => {
    const f = fixture(), published = "c".repeat(40);
    const item = { ...f.item, continuationMode: scenario === "unknown-mode" ? "ANY_IMPLEMENTATION" : "PUBLISHED_IMPLEMENTATION",
      releaseSha: scenario === "unchanged-release" ? BEFORE : published };
    const priorGit = f.deps.git.getMockImplementation()!;
    f.deps.git.mockImplementation((cwd, args) => {
      if (scenario === "unpublished" && args[0] === "merge-base" && args[2] === published) throw Error("Release is not on main");
      return cwd === f.worker && args[0] === "rev-parse" && args[1] === "HEAD"
        ? scenario === "unregistered-head" ? "d".repeat(40) : published : priorGit(cwd, args);
    });
    await expect(prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps)).rejects.toThrow();
    expect(f.deps.clientFactory).not.toHaveBeenCalled();
  });

  it("preserves its same owner's previously advanced clean runtime across a later release", async () => {
    // CI reproduced two valid observations within the same millisecond.
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    const f = fixture();
    await prepareOwnedDesktopContinuation({ context: f.context, item: f.item }, f.deps);
    const priorGit = f.deps.git.getMockImplementation()!;
    const later = "c".repeat(40);
    f.deps.git.mockImplementation((cwd, args) => args[0] === "rev-parse" && ["HEAD", "origin/main"].includes(args[1])
      ? cwd === f.worker ? CURRENT : later : priorGit(cwd, args));
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item: f.item }, f.deps))
      .toMatchObject({ outcome: "desktop_continuation_message_required", threadId: CHILD });
    const marker = join(f.selected, ".codex-artifacts", `desktop-repair-continuation-${REF}-${CURRENT}.private.json`);
    writeFileSync(marker, JSON.stringify({ childThreadId: PARENT }));
    await expect(prepareOwnedDesktopContinuation({ context: f.context, item: f.item }, f.deps))
      .rejects.toMatchObject({ code: "ORIGINAL_CONTINUATION_PROVENANCE_CHANGED" });
  });
  it("observes terminal native metadata and requests one same-owner message without starting inference or altering the old receipt", async () => {
    const f = fixture();
    const result = await prepareOwnedDesktopContinuation({ context: f.context, item: f.item }, f.deps);
    expect(result).toMatchObject({ outcome: "desktop_continuation_message_required", threadId: CHILD,
      model: "gpt-6.1-sol", monitoringVerified: false });
    expect(result.prompt).toContain("courseWorkerNativeIdentity");
    expect(result.prompt).toContain("SAME owned full repair");
    expect(result.prompt).toContain(CURRENT);
    expect(f.client.request.mock.calls.map(([method]) => method)).toEqual(["initialize", "account/read", "thread/read", "thread/turns/list"]);
    expect(JSON.parse(readFileSync(f.launcherPath, "utf8"))).toEqual(f.launcher);
    expect(existsSync(result.receiptPath)).toBe(true);
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item: f.item }, f.deps))
      .toMatchObject({ outcome: "already_requested", messageRequired: false });
    expect(f.deps.clientFactory).toHaveBeenCalledTimes(1);
  });

  it("leaves an active original worker alone without consuming continuation authority", async () => {
    const f = fixture();
    f.client.request.mockImplementation(async method => method === "thread/read"
      ? { thread: { id: CHILD, cwd: f.worker, status: { type: "active" } } }
      : method === "account/read" ? { account: { type: "chatgpt" } } : {});
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item: f.item }, f.deps))
      .toMatchObject({ outcome: "original_worker_active", messageRequired: false });
    expect(f.client.request.mock.calls.some(([method]) => method === "thread/turns/list")).toBe(false);
  });

  it.each(["failed", "interrupted"])("does not infer successful completion from a %s turn", async status => {
    const f = fixture();
    f.client.request.mockImplementation(async method => method === "thread/read"
      ? { thread: { id: CHILD, cwd: f.worker, status: { type: "idle" } } }
      : method === "account/read" ? { account: { type: "chatgpt" } }
      : method === "thread/turns/list" ? { data: [{ id: TURN, status, error: null, itemsView: "notLoaded", items: [], completedAt: 1700000000 }] } : {});
    await expect(prepareOwnedDesktopContinuation({ context: f.context, item: f.item }, f.deps)).rejects.toMatchObject({ code: "ORIGINAL_TERMINAL_TURN_REQUIRED" });
  });

  it("rejects another native identity and never replaces it or sends a message", async () => {
    const f = fixture();
    f.client.request.mockImplementation(async method => method === "thread/read"
      ? { thread: { id: PARENT, cwd: f.worker, status: { type: "idle" } } }
      : method === "account/read" ? { account: { type: "chatgpt" } } : {});
    await expect(prepareOwnedDesktopContinuation({ context: f.context, item: f.item }, f.deps)).rejects.toMatchObject({ code: "ORIGINAL_NATIVE_IDENTITY_CHANGED" });
    expect(JSON.parse(readFileSync(f.launcherPath, "utf8"))).toEqual(f.launcher);
  });

  it("does not repeat the same runtime or consume a model call for it", async () => {
    const f = fixture();
    const original = f.deps.git.getMockImplementation()!;
    f.deps.git.mockImplementation((cwd, args) => args[0] === "rev-parse" && ["HEAD", "origin/main"].includes(args[1])
      ? BEFORE : original(cwd, args));
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item: f.item }, f.deps))
      .toMatchObject({ outcome: "unchanged_runtime", messageRequired: false });
    expect(f.deps.clientFactory).not.toHaveBeenCalled();
  });

  it("offers exactly one unchanged-runtime diagnostic continuation for an explicitly projected unfinished mission", async () => {
    const f = fixture();
    const original = f.deps.git.getMockImplementation()!;
    f.deps.git.mockImplementation((cwd, args) => args[0] === "rev-parse" && ["HEAD", "origin/main"].includes(args[1])
      ? BEFORE : original(cwd, args));
    const item = { ...f.item, continuationTrigger: "UNFINISHED_FULL_REPAIR" };
    const result = await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps);
    expect(result).toMatchObject({ outcome: "desktop_continuation_message_required", monitoringVerified: false,
      model: "gpt-6.1-sol", prompt: expect.stringContaining("Do not rerun unchanged verification or an exhausted read") });
    expect(JSON.parse(readFileSync(result.receiptPath, "utf8"))).toMatchObject({ unchangedRuntime: true,
      continuationTrigger: "UNFINISHED_FULL_REPAIR", priorTurnId: TURN, runtimeSha: BEFORE, monitoringVerified: false });
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps))
      .toMatchObject({ outcome: "already_requested", messageRequired: false });
    expect(f.deps.clientFactory).toHaveBeenCalledTimes(1);
    expect(f.client.request.mock.calls.some(([method]) => /start|resume|send|steer/u.test(method))).toBe(false);
    expect(JSON.parse(readFileSync(f.launcherPath, "utf8"))).toEqual(f.launcher);
  });

  it.each(["active", "failed", "apiKey", "unknown-trigger"])("does not continue unchanged-runtime work on %s evidence", async scenario => {
    const f = fixture();
    const original = f.deps.git.getMockImplementation()!;
    f.deps.git.mockImplementation((cwd, args) => args[0] === "rev-parse" && ["HEAD", "origin/main"].includes(args[1])
      ? BEFORE : original(cwd, args));
    const request = f.client.request.getMockImplementation()!;
    f.client.request.mockImplementation(async method => {
      if (scenario === "active" && method === "thread/read") return { thread: { id: CHILD, cwd: f.worker, status: { type: "active" } } };
      if (scenario === "apiKey" && method === "account/read") return { account: { type: "apiKey" } };
      if (scenario === "failed" && method === "thread/turns/list") return { data: [{ id: TURN, status: "failed", error: null,
        itemsView: "notLoaded", items: [], completedAt: 1700000000 }] };
      return request(method);
    });
    const operation = prepareOwnedDesktopContinuation({ context: f.context,
      item: { ...f.item, continuationTrigger: scenario === "unknown-trigger" ? "RETRY_PROVIDER" : "UNFINISHED_FULL_REPAIR" } }, f.deps);
    if (scenario === "active") await expect(operation).resolves.toMatchObject({ outcome: "original_worker_active", messageRequired: false });
    else await expect(operation).rejects.toThrow();
    expect(existsSync(join(f.selected, ".codex-artifacts", `desktop-repair-continuation-${REF}-${BEFORE}.private.json`))).toBe(false);
  });

  it("preserves dirty original work and refuses API-key model authentication", async () => {
    const f = fixture();
    const original = f.deps.git.getMockImplementation()!;
    f.deps.git.mockImplementationOnce(original);
    f.deps.git.mockImplementation((cwd, args) => cwd === f.worker && args[0] === "status" ? " M customer-work" : original(cwd, args));
    await expect(prepareOwnedDesktopContinuation({ context: f.context, item: f.item }, f.deps)).rejects.toMatchObject({ code: "ORIGINAL_WORKER_CHANGED" });
    f.deps.git.mockImplementation(original);
    f.client.request.mockImplementation(async method => method === "account/read" ? { account: { type: "apiKey" } } : {});
    await expect(prepareOwnedDesktopContinuation({ context: f.context, item: f.item }, f.deps)).rejects.toMatchObject({ code: "EXISTING_CHATGPT_SIGN_IN_REQUIRED" });
    expect(JSON.parse(readFileSync(f.launcherPath, "utf8"))).toEqual(f.launcher);
  });
});
