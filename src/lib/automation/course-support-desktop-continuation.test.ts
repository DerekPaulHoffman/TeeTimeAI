import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { prepareOwnedDesktopContinuation, readDesktopContinuationProduction } from "../../../scripts/automation/course-support-desktop-continuation.mjs";

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
  writeFileSync(join(selected, "docs", "simulator-support-continuation-worker.md"), "Trusted original simulator continuation guide.");
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
  const deps = { environment: { CODEX_THREAD_ID: PARENT }, approvedCheckouts: [selected], now: () => Date.parse("2030-01-01T00:00:00.000Z"),
    inspectCli: vi.fn(() => ({ status: "current", cliPath: join(selected, "codex.exe") })),
    resolveRuntime: vi.fn(() => ({ status: "available", nodePath: process.execPath })), clientFactory: vi.fn(() => client),
    readProductionProof: vi.fn(() => ({ source: "git", state: "READY", branch: "main", commitSha: CURRENT,
      deploymentId: "dpl_qualified", aliases: ["teetimespot.com", "www.teetimespot.com"] })),
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

describe("source reconciliation observes current canonical deployments", () => {
  const deployment = () => ({ id: "dpl_current", url: "current.example.vercel.app", source: "git", readyState: "READY",
    projectId: "prj_dI6LhLrDCSq06xgvtNvaKtF6Uz7Y", gitSource: { type: "github", repoId: 978781158, ref: "main", sha: CURRENT },
    env: { ignoredPrivateValue: "never-return-this" } });
  const read = (responses: ReturnType<typeof deployment>[]) => {
    const execute = vi.fn(() => JSON.stringify(responses.shift()));
    const proof = readDesktopContinuationProduction({ selected: "/approved", nodePath: process.execPath, currentSha: CURRENT },
      execute as unknown as typeof import("node:child_process").execFileSync);
    return { proof, execute };
  };
  it("checks both real alias targets and returns only bounded Git evidence", () => {
    const { proof, execute } = read([deployment(), deployment()]);
    expect(proof).toMatchObject({ commitSha: CURRENT, state: "READY", aliases: ["teetimespot.com", "www.teetimespot.com"] });
    expect(JSON.stringify(proof)).not.toContain("never-return-this");
    expect(execute.mock.calls.map(call => (call as unknown as [string, string[]])[1].slice(1)))
      .toEqual(["teetimespot.com", "www.teetimespot.com"].map(alias => ["api", `/v13/deployments/${alias}`, "--method", "GET", "--scope", "derekpaulhoffmans-projects"]));
  });
  it.each(["project", "repo", "branch", "sha", "source", "building", "split-id", "split-url"])("rejects %s deployment drift", scenario => {
    const first = deployment(), second = deployment();
    if (scenario === "project") first.projectId = "another-project";
    if (scenario === "repo") first.gitSource.repoId++;
    if (scenario === "branch") first.gitSource.ref = "feature/other";
    if (scenario === "sha") first.gitSource.sha = BEFORE;
    if (scenario === "source") first.source = "cli";
    if (scenario === "building") first.readyState = "BUILDING";
    if (scenario === "split-id") second.id = "dpl_other";
    if (scenario === "split-url") second.url = "another.example.vercel.app";
    expect(read([first, second]).proof).toBeNull();
  });
});

describe("original Desktop full-repair continuation", () => {
  it("returns an unpublished simulator repair to its original clean worker for release only", async () => {
    const f = fixture(), candidate = "c".repeat(40), fingerprint = "a".repeat(64);
    const path = "src/lib/course-discovery/owned-reader.ts";
    const item = { mode: "SIMULATOR", simulatorRegisteredRelease: true, assignmentRef: REF, threadId: CHILD, branch: f.launcher.branch,
      baseSha: BEFORE, launcherReceiptPath: f.launcherPath, sourceFingerprint: fingerprint, claimToken: TURN,
      claimRevision: 9, plannedPaths: [path], releaseSha: candidate, expectedNativeContinuation: null,
      checkpoint: { kind: "EXPIRED_OWNED_STAGE", claimLeaseExpired: true, providerReadInFlight: false, ownedStage: {
        phase: "VERIFYING", sourceFingerprint: fingerprint, branch: f.launcher.branch, leaseExpiresAt: "2029-12-31T23:59:00.000Z",
        releaseSha: candidate, deployment: null, recheckQueuedAt: null, verificationCycle: 0,
        fullRepair: { kind: "FAILED_LEARNER_FULL_REPAIR", offeringSourceFingerprint: fingerprint },
      } } };
    const previousGit = f.deps.git.getMockImplementation()!;
    f.deps.git.mockImplementation((cwd, args) => {
      if (cwd === f.worker && args[0] === "rev-parse" && args[1] === "HEAD") return candidate;
      if (args[0] === "merge-base" && args[1] === "--all") return BEFORE;
      if (args[0] === "diff") return `${path}\0`;
      return previousGit(cwd, args);
    });
    const result = await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps);
    expect(result).toMatchObject({ threadId: CHILD, model: "gpt-6.1-sol", messageRequired: true,
      prompt: expect.stringContaining("Continue its release using the existing exact-head CI run") });
    expect(result.receiptPath).toContain("desktop-simulator-registered-");
    expect(result.prompt).toContain("Do not replay any failed source read");
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps))
      .toMatchObject({ outcome: "already_requested", messageRequired: false });
    expect(f.client.request.mock.calls.some(([method]) => /start|resume|send|steer/u.test(method))).toBe(false);
  });

  it("wakes the original waiting simulator Desktop chat with actual native completion proof", async () => {
    const f = fixture();
    const fingerprint = "a".repeat(64), expired = "2029-12-31T23:59:00.000Z";
    const item = { mode: "SIMULATOR", assignmentRef: REF, threadId: CHILD, branch: f.launcher.branch, baseSha: BEFORE,
      launcherReceiptPath: f.launcherPath, sourceFingerprint: fingerprint, claimToken: TURN, claimRevision: 5,
      plannedPaths: [], releaseSha: null, expectedNativeContinuation: null, checkpoint: {
        kind: "EXPIRED_OWNED_STAGE", claimLeaseExpired: true, providerReadInFlight: false, ownedStage: {
          phase: "WAITING_IMPLEMENTATION", sourceFingerprint: fingerprint, branch: f.launcher.branch, leaseExpiresAt: expired,
        },
      },
    };
    const result = await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps);
    expect(result).toMatchObject({ threadId: CHILD, model: "gpt-6.1-sol", messageRequired: true,
      prompt: expect.stringContaining("WAITING_IMPLEMENTATION revision 5") });
    expect(result.prompt).toContain("First user Chrome");
    expect(result.prompt).not.toContain("REGISTERED_RELEASE_RECONCILIATION");
    expect(result.receiptPath).toContain("desktop-simulator-wait-");
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps))
      .toMatchObject({ outcome: "already_requested", messageRequired: false });
    await expect(prepareOwnedDesktopContinuation({ context: f.context,
      item: { ...item, checkpoint: { ...item.checkpoint, providerReadInFlight: true } } }, f.deps))
      .rejects.toThrow("DESKTOP_SIMULATOR_WAIT_REQUIRED");
    expect(f.client.request.mock.calls.some(([method]) => /start|resume|send|steer/u.test(method))).toBe(false);
  });

  it("uses a separate closeout-only intent for expired demand and published code", async () => {
    const f = fixture();
    const registered = "c".repeat(40);
    const item = { ...f.item, releaseSha: registered, continuationMode: "REGISTERED_IMPLEMENTATION",
      continuationTrigger: "UNFINISHED_FULL_REPAIR", plannedPaths: ["src/lib/course-discovery/public-calendar.ts"],
      expiredDemandRecoveryOnly: true };
    const originalGit = f.deps.git.getMockImplementation()!;
    f.deps.git.mockImplementation((cwd, args) => {
      if (args[0] === "merge-base" && args[1] === "--all") return registered;
      if (args[0] === "rev-parse" && args[1] === "HEAD" && cwd === f.worker) return registered;
      return originalGit(cwd, args);
    });
    const result = await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps);
    expect(result).toMatchObject({ threadId: CHILD, messageRequired: true,
      prompt: expect.stringContaining("EXPIRED_DEMAND_CLOSEOUT_ONLY") });
    expect(result.prompt).toContain("--close-expired-demand");
    expect(result.prompt).not.toContain("REGISTERED_RELEASE_RECONCILIATION");
    expect(result.receiptPath).toContain("desktop-repair-expired-demand-");
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps))
      .toMatchObject({ outcome: "already_requested", messageRequired: false });
    f.deps.git.mockImplementation((cwd, args) => {
      if (args[0] === "merge-base" && args[1] === "--all") return BEFORE;
      if (args[0] === "rev-parse" && args[1] === "HEAD" && cwd === f.worker) return registered;
      return originalGit(cwd, args);
    });
    await expect(prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps))
      .rejects.toThrow("EXPIRED_COURSE_RELEASE_NOT_PUBLISHED");
  });

  it("wakes a deployed simulator repair once with its original Desktop owner and no new read authority", async () => {
    const f = fixture(), fingerprint = "a".repeat(64), releaseSha = "c".repeat(40);
    const item = { mode: "SIMULATOR", simulatorLearningRecovery: true, assignmentRef: REF, threadId: CHILD,
      branch: f.launcher.branch, baseSha: BEFORE, launcherReceiptPath: f.launcherPath,
      sourceFingerprint: fingerprint, claimToken: TURN, claimRevision: 8,
      plannedPaths: ["src/lib/course-discovery/test-reader.ts"], releaseSha, expectedNativeContinuation: null,
      checkpoint: { kind: "EXPIRED_OWNED_STAGE", claimLeaseExpired: true, providerReadInFlight: false, ownedStage: {
        phase: "VERIFYING", sourceFingerprint: fingerprint, branch: f.launcher.branch, leaseExpiresAt: "2029-12-31T23:59:00.000Z",
        releaseSha, deployment: { commitSha: releaseSha },
        fullRepair: { kind: "FAILED_LEARNER_FULL_REPAIR", offeringSourceFingerprint: fingerprint },
      } } };
    const git = f.deps.git.getMockImplementation()!;
    f.deps.git.mockImplementation((cwd, args) => cwd === f.worker && args[0] === "rev-parse" && args[1] === "HEAD"
      ? releaseSha : git(cwd, args));
    const result = await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps);
    expect(result).toMatchObject({ threadId: CHILD, model: "gpt-6.1-sol", messageRequired: true,
      prompt: expect.stringContaining("recover-learning --recipe for independent verification before considering generic discovery") });
    expect(result.prompt).toContain("First user Chrome");
    expect(result.prompt).toContain("source-read settlement receipt rules");
    expect(result.prompt).toContain("complete one unspent source-read only if a fresh inspection of your recovered claim explicitly lists it in researchGuide.suggestedReads");
    expect(result.prompt).toContain("Keep the existing read count, source, access and provider limits");
    expect(result.prompt).toContain("A reporting-only repair does not qualify an unchanged learner");
    expect(result.receiptPath).toContain("desktop-simulator-learning-");
    expect(f.deps.git).toHaveBeenCalledWith(f.selected, ["merge-base", "--is-ancestor", releaseSha, CURRENT]);
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps))
      .toMatchObject({ outcome: "already_requested", messageRequired: false });
    await expect(prepareOwnedDesktopContinuation({ context: f.context,
      item: { ...item, checkpoint: { ...item.checkpoint, ownedStage: { ...item.checkpoint.ownedStage, deployment: null } } } }, f.deps))
      .rejects.toThrow();

    const nextRuntime = "d".repeat(40), completedAt = "2030-01-01T00:02:00.000Z", jobId = "failed-simulator-child";
    f.deps.now = () => Date.parse("2030-01-01T00:03:00.000Z");
    f.deps.git.mockImplementation((cwd, args) => args[0] === "rev-parse" && !args[1].startsWith("--")
      ? cwd === f.worker ? CURRENT : nextRuntime : git(cwd, args));
    f.deps.readProductionProof.mockReturnValue({ source: "git", state: "READY", branch: "main", commitSha: nextRuntime,
      deploymentId: "dpl_qualified", aliases: ["teetimespot.com", "www.teetimespot.com"] });
    const request = f.client.request.getMockImplementation()!;
    f.client.request.mockImplementation(method => method === "thread/turns/list" ? Promise.resolve({ data: [{
      id: "cccccccc-dddd-4eee-8fff-000000000000", status: "completed", error: null, itemsView: "notLoaded", items: [],
      completedAt: 1893456180,
    }] }) : request(method));
    const followthrough = { ...item, claimRevision: 9, failedLearningProgress: { version: 1, jobId, completedAt,
      simulatorExecutionRuntime: CURRENT, simulatorRequestedAt: "2030-01-01T00:01:00.000Z",
      fingerprint: createHash("sha256").update([jobId, completedAt, REF, releaseSha].join("\0")).digest("hex") } };
    const follow = await prepareOwnedDesktopContinuation({ context: f.context, item: followthrough }, f.deps);
    expect(follow).toMatchObject({ threadId: CHILD, messageRequired: true,
      prompt: expect.stringContaining("A linked late learner just failed") });
    expect(follow.prompt).toContain(jobId);
    expect(follow.prompt).toContain("recover-learning --recipe for independent verification before considering generic discovery");
    expect(follow.prompt).toContain("This wake grants no provider reads");
    expect(follow.prompt).not.toContain("complete one unspent source-read");
    expect(follow.prompt).not.toContain("use recover-learning without a recipe");
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item: followthrough }, f.deps))
      .toMatchObject({ outcome: "already_requested", messageRequired: false });

    // A worker can publish another repair and admit its own late read within
    // the same turn. There was no fresh scheduler send for that release.
    f.deps.git.mockImplementation((cwd, args) => args[0] === "rev-parse" && !args[1].startsWith("--")
      ? nextRuntime : git(cwd, args));
    const nextRepair = { ...followthrough, releaseSha: nextRuntime, checkpoint: { ...followthrough.checkpoint,
      ownedStage: { ...followthrough.checkpoint.ownedStage, releaseSha: nextRuntime, deployment: { commitSha: nextRuntime } } },
      failedLearningProgress: { ...followthrough.failedLearningProgress,
        jobId: "failed-owner-admitted-simulator", simulatorExecutionRuntime: nextRuntime,
        fingerprint: createHash("sha256").update(["failed-owner-admitted-simulator", completedAt, REF, nextRuntime].join("\0")).digest("hex"),
      } };
    const currentNative = f.client.request.getMockImplementation()!;
    f.client.request.mockImplementation(async method => {
      const result = await currentNative(method);
      if ("data" in result && result.data) result.data[0].completedAt = 1893456060;
      return result;
    });
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item: nextRepair }, f.deps))
      .toMatchObject({ outcome: "original_admission_turn_not_observed", messageRequired: false });
    f.client.request.mockImplementation(currentNative);
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item: nextRepair }, f.deps))
      .toMatchObject({ threadId: CHILD, messageRequired: true, prompt: expect.stringContaining("failed-owner-admitted-simulator") });
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item: nextRepair }, f.deps))
      .toMatchObject({ outcome: "already_requested", messageRequired: false });
    await expect(prepareOwnedDesktopContinuation({ context: f.context, item: { ...nextRepair, failedLearningProgress: {
      ...nextRepair.failedLearningProgress, simulatorExecutionRuntime: releaseSha,
    } } }, f.deps)).rejects.toThrow("ORIGINAL_CONTINUATION_PROVENANCE_REQUIRED");
    expect(f.client.request.mock.calls.some(([method]) => /start|resume|send|steer/u.test(method))).toBe(false);
  });

  it("defers a stopped registered release until current main is Ready and asks its original owner only once", async () => {
    const f = fixture();
    const registered = "c".repeat(40), path = "src/lib/course-discovery/public-calendar.ts";
    const item = { ...f.item, releaseSha: registered, continuationMode: "REGISTERED_IMPLEMENTATION",
      continuationTrigger: "UNFINISHED_FULL_REPAIR", plannedPaths: [path] };
    const priorGit = f.deps.git.getMockImplementation()!;
    f.deps.git.mockImplementation((cwd, args) => {
      if (args[0] === "merge-base" && args[1] === "--all") return BEFORE;
      if (args[0] === "diff") return `${path}\0`;
      if (args[0] === "rev-parse" && args[1] === "HEAD" && cwd === f.worker) return registered;
      return priorGit(cwd, args);
    });
    const ready = f.deps.readProductionProof();
    f.deps.readProductionProof.mockReturnValue({ ...ready, state: "BUILDING" });
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps))
      .toMatchObject({ outcome: "production_not_ready", messageRequired: false });
    expect(f.deps.clientFactory).not.toHaveBeenCalled();
    f.deps.readProductionProof.mockReturnValue(ready);
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps))
      .toMatchObject({ outcome: "desktop_continuation_message_required", threadId: CHILD,
        monitoringVerified: false, prompt: expect.stringContaining("REGISTERED_RELEASE_RECONCILIATION") });
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps))
      .toMatchObject({ outcome: "already_requested", messageRequired: false });
    expect(f.client.request.mock.calls.some(([method]) => /start|resume|send|steer/u.test(method))).toBe(false);
    f.deps.git.mockImplementation((cwd, args) => args[0] === "rev-parse" && args[1] === "HEAD" && cwd === f.worker
      ? "d".repeat(40) : priorGit(cwd, args));
    await expect(prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps)).rejects.toThrow("ORIGINAL_REGISTERED_CANDIDATE_CHANGED");
  });

  it.each(["building", "wrong-sha", "missing-alias", "cli-source", "unavailable"])("defers source reconciliation before consuming its intent when production is %s", async scenario => {
    const f = fixture();
    const item = { ...f.item, continuationMode: "DATA_ONLY", continuationTrigger: "UNFINISHED_FULL_REPAIR", sourceReconciliationOnly: true };
    const ready = f.deps.readProductionProof();
    if (scenario === "building") f.deps.readProductionProof.mockReturnValue({ ...ready, state: "BUILDING" });
    if (scenario === "wrong-sha") f.deps.readProductionProof.mockReturnValue({ ...ready, commitSha: BEFORE });
    if (scenario === "missing-alias") f.deps.readProductionProof.mockReturnValue({ ...ready, aliases: ["teetimespot.com"] });
    if (scenario === "cli-source") f.deps.readProductionProof.mockReturnValue({ ...ready, source: "cli" });
    if (scenario === "unavailable") f.deps.readProductionProof.mockImplementation(() => { throw Error("Do not expose private deployment diagnostics"); });
    const result = await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps);
    expect(result).toMatchObject({ messageRequired: false, monitoringVerified: false });
    expect(result.outcome).toMatch(/^production_/u);
    expect(JSON.stringify(result)).not.toContain("private deployment diagnostics");
    expect(f.deps.clientFactory).not.toHaveBeenCalled();
    f.deps.readProductionProof.mockReturnValue(ready);
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps))
      .toMatchObject({ outcome: "desktop_continuation_message_required", messageRequired: true });
  });

  it("wakes the same clean data-only owner solely to reconcile a changed source", async () => {
    const f = fixture();
    const item = { ...f.item, continuationMode: "DATA_ONLY", continuationTrigger: "UNFINISHED_FULL_REPAIR", sourceReconciliationOnly: true };
    const result = await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps);
    expect(result).toMatchObject({ outcome: "desktop_continuation_message_required", threadId: CHILD,
      monitoringVerified: false, prompt: expect.stringContaining("SOURCE_RECONCILIATION_ONLY") });
    expect(result.prompt).toContain("Do not investigate or implement against the changed snapshot");
    expect(result.prompt).not.toContain("Obtain and validate fresh research context");
    expect(result.prompt).not.toContain("standing full-repair release authorization");
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps))
      .toMatchObject({ outcome: "already_requested", messageRequired: false });
    expect(f.client.request.mock.calls.some(([method]) => /start|resume|send|steer/u.test(method))).toBe(false);
    expect(JSON.parse(readFileSync(f.launcherPath, "utf8"))).toEqual(f.launcher);
  });

  it.each(["CLAIMED_IMPLEMENTATION", "PUBLISHED_IMPLEMENTATION", "missing-mode", "wrong-trigger", "false-flag"])("rejects invalid source-reconciliation purpose %s", async scenario => {
    const f = fixture();
    const item = { ...f.item, continuationMode: "DATA_ONLY", continuationTrigger: "UNFINISHED_FULL_REPAIR", sourceReconciliationOnly: true };
    if (scenario === "missing-mode") delete (item as Partial<typeof item>).continuationMode;
    else if (scenario === "wrong-trigger") item.continuationTrigger = "RETRY_PROVIDER";
    else if (scenario === "false-flag") item.sourceReconciliationOnly = false;
    else item.continuationMode = scenario;
    await expect(prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps)).rejects.toThrow();
    expect(f.deps.clientFactory).not.toHaveBeenCalled();
  });

  it("continues the original clean owner between claiming a tooling path and publishing its implementation", async () => {
    const f = fixture();
    const item = { ...f.item, continuationMode: "CLAIMED_IMPLEMENTATION", continuationTrigger: "UNFINISHED_FULL_REPAIR",
      plannedPaths: ["src/lib/course-discovery/public-source.ts"] };
    const result = await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps);
    expect(result).toMatchObject({ outcome: "desktop_continuation_message_required", threadId: CHILD,
      monitoringVerified: false, prompt: expect.stringContaining("Continuation mode: CLAIMED_IMPLEMENTATION") });
    expect(result.prompt).toContain("Finish the already claimed tooling repair");
    expect(result.prompt).toContain("standing full-repair release authorization includes normal promotion");
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps))
      .toMatchObject({ outcome: "already_requested", messageRequired: false });
    expect(f.deps.clientFactory).toHaveBeenCalledTimes(1);
    expect(f.client.request.mock.calls.some(([method]) => /start|resume|send|steer/u.test(method))).toBe(false);
    expect(JSON.parse(readFileSync(f.launcherPath, "utf8"))).toEqual(f.launcher);
  });

  it.each(["no-paths", "parent-traversal", "unregistered-head", "dirty", "release", "trigger"])("preserves claimed work and rejects %s continuation drift", async scenario => {
    const f = fixture();
    const item = { ...f.item, continuationMode: "CLAIMED_IMPLEMENTATION", continuationTrigger: "UNFINISHED_FULL_REPAIR",
      plannedPaths: ["src/lib/course-discovery/public-source.ts"] };
    if (scenario === "no-paths") item.plannedPaths = [];
    if (scenario === "parent-traversal") item.plannedPaths = ["../other-repository/file.ts"];
    if (scenario === "release") item.releaseSha = "c".repeat(40);
    if (scenario === "trigger") item.continuationTrigger = "RETRY_PROVIDER";
    const previous = f.deps.git.getMockImplementation()!;
    f.deps.git.mockImplementation((cwd, args) => {
      if (cwd === f.worker && scenario === "unregistered-head" && args[0] === "rev-parse" && args[1] === "HEAD") return "c".repeat(40);
      if (cwd === f.worker && scenario === "dirty" && args[0] === "status") return " M owned-but-unpublished.ts";
      return previous(cwd, args);
    });
    await expect(prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps)).rejects.toThrow();
    expect(f.deps.clientFactory).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(f.launcherPath, "utf8"))).toEqual(f.launcher);
  });

  function progressFixture() {
    const f = fixture(), published = "c".repeat(40);
    const item = { ...f.item, continuationMode: "PUBLISHED_IMPLEMENTATION", releaseSha: published,
      continuationTrigger: "UNFINISHED_FULL_REPAIR" };
    const originalGit = f.deps.git.getMockImplementation()!;
    f.deps.git.mockImplementation((cwd, args) => cwd === f.worker && args[0] === "rev-parse" && args[1] === "HEAD"
      ? published : originalGit(cwd, args));
    const completedAt = "2030-01-01T00:01:00.000Z", jobId = "new-failed-child";
    const progress = { version: 1, jobId, completedAt, fingerprint: createHash("sha256")
      .update([jobId, completedAt, item.batchReference, item.releaseSha].join("\0")).digest("hex") };
    const advance = () => {
      f.deps.now = () => Date.parse("2030-01-01T00:02:00.000Z");
      const request = f.client.request.getMockImplementation()!;
      f.client.request.mockImplementation(async method => method === "thread/turns/list" ? { data: [{
        id: "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa", status: "completed", error: null, itemsView: "notLoaded", items: [], completedAt: 1893456120,
      }] } : request(method));
    };
    return { ...f, item, progress, advance };
  }

  it("wakes the same owner once on a new reciprocal failure without another release or changing the original receipt", async () => {
    const f = progressFixture();
    const first = await prepareOwnedDesktopContinuation({ context: f.context, item: f.item }, f.deps);
    const firstBytes = readFileSync(first.receiptPath, "utf8");
    f.advance();
    const item = { ...f.item, failedLearningProgress: f.progress };
    const follow = await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps);
    expect(follow).toMatchObject({ outcome: "desktop_continuation_message_required", threadId: CHILD, monitoringVerified: false });
    expect(follow.prompt).toContain(`newly terminal failed learning result is available: ${f.progress.jobId}`);
    expect(follow.receiptPath).toContain(`desktop-repair-followthrough-${REF}-${f.progress.fingerprint}`);
    expect(JSON.parse(readFileSync(follow.receiptPath, "utf8"))).toMatchObject({ parentReceiptPath: first.receiptPath,
      failedLearningProgress: f.progress, observedFailureFingerprint: f.progress.fingerprint });
    expect(readFileSync(first.receiptPath, "utf8")).toBe(firstBytes);
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps)).toMatchObject({ outcome: "already_requested", messageRequired: false });
    expect(f.deps.clientFactory).toHaveBeenCalledTimes(2);
    expect(f.client.request.mock.calls.some(([method]) => /start|resume|send|steer/u.test(method))).toBe(false);
  });

  it("does not resend a primary intent when no later native turn proves it ran", async () => {
    const f = progressFixture();
    await prepareOwnedDesktopContinuation({ context: f.context, item: f.item }, f.deps);
    f.deps.now = () => Date.parse("2030-01-01T00:02:00.000Z");
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item: { ...f.item, failedLearningProgress: f.progress } }, f.deps))
      .toMatchObject({ outcome: "prior_continuation_not_observed", messageRequired: false });
  });

  it("does not grant a second wake for a failure already observed by the primary intent", async () => {
    const f = progressFixture(); f.advance();
    const item = { ...f.item, failedLearningProgress: f.progress };
    await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps);
    f.deps.now = () => Date.parse("2030-01-01T00:03:00.000Z");
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps)).toMatchObject({ outcome: "already_requested", messageRequired: false });
    expect(f.deps.clientFactory).toHaveBeenCalledTimes(1);
  });

  it.each(["foreign-release", "future", "added-url", "invalid-date"])("rejects %s diagnostic progress before native access", async scenario => {
    const f = progressFixture(); f.advance();
    const progress = { ...f.progress, ...(scenario === "added-url" ? { sourceUrl: "https://untrusted.example" } : {}) };
    if (scenario === "future") progress.completedAt = "2030-01-02T00:00:00.000Z";
    if (scenario === "invalid-date") progress.completedAt = "invalid";
    const item = { ...f.item, ...(scenario === "foreign-release" ? { releaseSha: "d".repeat(40) } : {}), failedLearningProgress: progress };
    await expect(prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps)).rejects.toThrow();
    expect(f.deps.clientFactory).not.toHaveBeenCalled();
  });

  it("preserves one-use follow-through while its original worker is active", async () => {
    const f = progressFixture();
    await prepareOwnedDesktopContinuation({ context: f.context, item: f.item }, f.deps); f.advance();
    const original = f.client.request.getMockImplementation()!;
    f.client.request.mockImplementation(async method => method === "thread/read"
      ? { thread: { id: CHILD, cwd: f.worker, status: { type: "active" } } } : original(method));
    const item = { ...f.item, failedLearningProgress: f.progress };
    expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps)).toMatchObject({ outcome: "original_worker_active", messageRequired: false });
    expect(existsSync(join(f.selected, ".codex-artifacts", `desktop-repair-followthrough-${REF}-${f.progress.fingerprint}.private.json`))).toBe(false);
  });

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

  it.each(["owned", "unplanned", "whitespace", "ambiguous-base", "wrong-release", "missing-paths", "dirty"])("preserves only the original planned unregistered candidate: %s", async scenario => {
    const f = fixture(), published = "c".repeat(40), candidate = "d".repeat(40), shared = "e".repeat(40);
    const item = { ...f.item, continuationMode: "PUBLISHED_IMPLEMENTATION", continuationTrigger: "UNFINISHED_FULL_REPAIR",
      releaseSha: published, plannedPaths: scenario === "missing-paths" ? [] : ["src/lib/adapters/owned.ts"] };
    const priorGit = f.deps.git.getMockImplementation()!;
    f.deps.git.mockImplementation((cwd, args) => {
      if (cwd === f.worker && args[0] === "rev-parse" && args[1] === "HEAD") return candidate;
      if (cwd === f.worker && args[0] === "status" && scenario === "dirty") return " M src/lib/adapters/owned.ts";
      if (args[0] === "merge-base" && args[1] === "--all") return scenario === "ambiguous-base" ? `${shared}\n${published}` : shared;
      if (args[0] === "merge-base" && args[2] === published && args[3] === shared && scenario === "wrong-release") throw Error("Wrong release ancestry");
      if (args[0] === "diff") return `${scenario === "unplanned" ? "src/lib/other.ts" : scenario === "whitespace" ? " src/lib/adapters/owned.ts" : "src/lib/adapters/owned.ts"}\0`;
      return priorGit(cwd, args);
    });
    if (scenario !== "owned") {
      await expect(prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps)).rejects.toThrow();
      expect(f.deps.clientFactory).not.toHaveBeenCalled();
    } else {
      const result = await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps);
      expect(result).toMatchObject({ outcome: "desktop_continuation_message_required", monitoringVerified: false });
      expect(result.prompt).toContain(`Preserved unregistered local candidate: ${candidate}`);
      expect(JSON.parse(readFileSync(result.receiptPath, "utf8"))).toMatchObject({ localCandidate: { headSha: candidate, sharedBaseSha: shared,
        paths: ["src/lib/adapters/owned.ts"] } });
      expect(await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps)).toMatchObject({ outcome: "already_requested", messageRequired: false });
      expect(f.deps.git.mock.calls.some(([, args]) => ["merge", "checkout", "reset", "commit"].includes(args[0]))).toBe(false);
      expect(f.client.request.mock.calls.some(([method]) => /start|resume|send|steer/u.test(method))).toBe(false);
    }
    expect(JSON.parse(readFileSync(f.launcherPath, "utf8"))).toEqual(f.launcher);
  });

  it("also preserves the first clean claimed candidate before its initial release registration", async () => {
    const f = fixture(), candidate = "c".repeat(40);
    const item = { ...f.item, continuationMode: "CLAIMED_IMPLEMENTATION", continuationTrigger: "UNFINISHED_FULL_REPAIR",
      plannedPaths: ["src/lib/adapters/owned.ts"] };
    const previous = f.deps.git.getMockImplementation()!;
    f.deps.git.mockImplementation((cwd, args) => {
      if (cwd === f.worker && args[0] === "rev-parse" && args[1] === "HEAD") return candidate;
      if (args[0] === "merge-base" && args[1] === "--all") return BEFORE;
      if (args[0] === "diff") return "src/lib/adapters/owned.ts\0";
      return previous(cwd, args);
    });
    const result = await prepareOwnedDesktopContinuation({ context: f.context, item }, f.deps);
    expect(result).toMatchObject({ outcome: "desktop_continuation_message_required", monitoringVerified: false });
    expect(result.prompt).toContain(`Preserved unregistered local candidate: ${candidate}`);
    expect(JSON.parse(readFileSync(result.receiptPath, "utf8"))).toMatchObject({ localCandidate: { headSha: candidate } });
    expect(f.deps.git.mock.calls.some(([, args]) => ["merge", "checkout", "reset", "commit"].includes(args[0]))).toBe(false);
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
