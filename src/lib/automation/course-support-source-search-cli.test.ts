import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sourceCommandMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  resolveBatch: vi.fn(),
  getLease: vi.fn(),
  getProvenance: vi.fn(),
  getContext: vi.fn(),
  recordResult: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: { ...actual, execFileSync: sourceCommandMocks.execFileSync },
    execFileSync: sourceCommandMocks.execFileSync,
  };
});

vi.mock("@/lib/automation/course-support-batches", async (importOriginal) => ({
  ...await importOriginal<typeof import("./course-support-batches")>(),
  resolveCourseSupportBatchReference: sourceCommandMocks.resolveBatch,
  getOwnedCourseSupportLeaseToken: sourceCommandMocks.getLease,
  getCourseSupportBatchRecoveryProvenance: sourceCommandMocks.getProvenance,
  getOwnedCourseSupportSourceSearchContext: sourceCommandMocks.getContext,
  recordOwnedCourseSupportSourceSearchResult: sourceCommandMocks.recordResult,
}));

import {
  parseCanonicalCourseSupportDeployedAt,
  parseCourseSupportSourceSearchResultOptions,
  runConfiguredCommand,
  shouldCompleteParkedCampaignForInspection,
} from "../../../scripts/automation/course-support";
import { getAutomationRuntimeVersion } from "./runtime-version";

describe("course-support source-search CLI", () => {
  it("accepts only one exact canonical UTC deployment timestamp", () => {
    expect(
      parseCanonicalCourseSupportDeployedAt([
        "--deployed-at",
        "2026-08-21T15:04:05.123Z",
      ]),
    ).toEqual(new Date("2026-08-21T15:04:05.123Z"));
    expect(parseCanonicalCourseSupportDeployedAt([])).toBeNull();

    for (const raw of [
      " 2026-08-21T15:04:05.123Z",
      "2026-08-21T15:04:05.123Z ",
      "2026-08-21T11:04:05.123-04:00",
      "2026-08-21T15:04:05Z",
      "not-a-timestamp",
    ]) {
      expect(() =>
        parseCanonicalCourseSupportDeployedAt(["--deployed-at", raw]),
      ).toThrow("exact canonical UTC ISO");
    }
    expect(() =>
      parseCanonicalCourseSupportDeployedAt([
        "--deployed-at",
        "2026-08-21T15:04:05.123Z",
        "--deployed-at",
        "2026-08-21T15:04:05.123Z",
      ]),
    ).toThrow("only once");
    expect(() =>
      parseCanonicalCourseSupportDeployedAt(["--deployed-at"]),
    ).toThrow("requires a value");
  });

  it("parses one ordinal-scoped candidate result", () => {
    expect(
      parseCourseSupportSourceSearchResultOptions([
        "--ordinal",
        "2",
        "--attempt-ref",
        "a".repeat(64),
        "--candidate-url",
        "https://course.example/",
      ]),
    ).toEqual({
      ordinal: 2,
      attemptRef: "a".repeat(64),
      candidateUrl: "https://course.example/",
      noUnique: false,
    });
  });

  it("parses the bounded no-result alternative and rejects duplicate flags", () => {
    expect(
      parseCourseSupportSourceSearchResultOptions([
        "--ordinal",
        "1",
        "--attempt-ref",
        "b".repeat(64),
        "--no-unique",
      ]),
    ).toEqual({
      ordinal: 1,
      attemptRef: "b".repeat(64),
      candidateUrl: undefined,
      noUnique: true,
    });
    expect(() =>
      parseCourseSupportSourceSearchResultOptions([
        "--ordinal",
        "1",
        "--attempt-ref",
        "b".repeat(64),
        "--no-unique",
        "--no-unique",
      ]),
    ).toThrow("only once");
  });

  it("allows only the scheduled responder inspection to complete a parked campaign", () => {
    expect(shouldCompleteParkedCampaignForInspection([])).toBe(false);
    expect(shouldCompleteParkedCampaignForInspection(["--owner-thread", "hourly-loop"])).toBe(
      false,
    );
    expect(shouldCompleteParkedCampaignForInspection(["--scheduled-cycle"])).toBe(true);
  });
});

describe("source-search command Git provenance", () => {
  const headSha = "a".repeat(40);
  const priorSha = "b".repeat(40);
  const branch = "automation/course-support-source-research";
  const ownerThreadId = "synthetic-source-owner";
  const batchId = "synthetic-source-batch";
  const leaseToken = "synthetic-source-lease";
  const attemptRef = "c".repeat(64);
  const context = { outcome: "ready", searchBudget: 1, query: "Synthetic Public Golf Springfield" };
  const write = vi.fn();
  const providerFetch = vi.fn(async () => {
    throw new Error("Source-search CLI must not perform provider I/O");
  });
  let git: { branch: string; headSha: string; originMainSha: string; status: string };
  let provenance: { branch: string | null; baseSha: string; releaseSha: string | null };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODEX_THREAD_ID", ownerThreadId);
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", undefined);
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", undefined);
    vi.stubGlobal("fetch", providerFetch);
    git = { branch, headSha, originMainSha: headSha, status: "" };
    provenance = { branch, baseSha: priorSha, releaseSha: headSha };
    sourceCommandMocks.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
      expect(file).toBe("git");
      switch (args.join(" ")) {
        case "branch --show-current": return `${git.branch}\n`;
        case "rev-parse HEAD": return `${git.headSha}\n`;
        case "rev-parse origin/main": return `${git.originMainSha}\n`;
        case "status --porcelain=v1 -z": return git.status;
        default: throw new Error("Unexpected Git command during source research");
      }
    });
    sourceCommandMocks.resolveBatch.mockResolvedValue(batchId);
    sourceCommandMocks.getLease.mockResolvedValue(leaseToken);
    sourceCommandMocks.getProvenance.mockImplementation(async () => ({
      ...provenance, plannedPaths: [], remediationDirective: null,
    }));
    sourceCommandMocks.getContext.mockResolvedValue(context);
    sourceCommandMocks.recordResult.mockImplementation(async (input: { noUnique: boolean }) => ({
      outcome: "recorded", result: input.noUnique ? "NO_UNIQUE" : "CANDIDATE", replayed: false,
    }));
  });

  afterEach(() => {
    expect(providerFetch).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const commandCases = [
    { name: "context", command: "source-search-context", resultArgs: [] },
    { name: "candidate", command: "record-source-search", resultArgs: ["--attempt-ref", attemptRef, "--candidate-url", "https://synthetic-course.example/"] },
    { name: "no unique result", command: "record-source-search", resultArgs: ["--attempt-ref", attemptRef, "--no-unique"] },
  ];
  const environmentCases = [
    { name: "absent deployment environment", commit: undefined, deployment: undefined, ambientRuntime: "local" },
    { name: "stale commit environment", commit: priorSha, deployment: "synthetic-deployment", ambientRuntime: priorSha },
    { name: "deployment-only environment", commit: undefined, deployment: "synthetic-deployment", ambientRuntime: "synthetic-deployment" },
  ];
  const successfulCases = environmentCases.flatMap((environment) =>
    ["release", "base"].flatMap((runtimeSource) => commandCases.map((command) => ({
      name: `${command.name}, ${runtimeSource}, ${environment.name}`,
      environment, runtimeSource, command,
    }))),
  );

  function run(command: typeof commandCases[number]) {
    return runConfiguredCommand({
      argv: [command.command, "--batch-ref", "synthetic-reference", "--ordinal", "1", ...command.resultArgs],
      isWorkerExecutionAllowed: vi.fn(async () => true),
      write,
    });
  }

  it.each(successfulCases)("uses checked Git provenance for $name", async ({ environment, runtimeSource, command }) => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", environment.commit);
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", environment.deployment);
    if (runtimeSource === "base") provenance = { branch, baseSha: headSha, releaseSha: null };
    expect(getAutomationRuntimeVersion()).toBe(environment.ambientRuntime);

    await run(command);

    expect(sourceCommandMocks.getLease).toHaveBeenCalledExactlyOnceWith({ batchId, ownerThreadId });
    expect(sourceCommandMocks.getProvenance).toHaveBeenCalledExactlyOnceWith(batchId);
    expect(sourceCommandMocks.execFileSync).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], expect.anything());
    expect(sourceCommandMocks.getLease.mock.invocationCallOrder[0]).toBeLessThan(sourceCommandMocks.execFileSync.mock.invocationCallOrder[0]!);
    if (command.command === "source-search-context") {
      expect(sourceCommandMocks.getContext).toHaveBeenCalledExactlyOnceWith({ batchId, leaseToken, ownerThreadId, ordinal: 1 });
      expect(sourceCommandMocks.getProvenance.mock.invocationCallOrder[0]).toBeLessThan(sourceCommandMocks.getContext.mock.invocationCallOrder[0]!);
      expect(sourceCommandMocks.recordResult).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledExactlyOnceWith(context);
    } else {
      expect(sourceCommandMocks.getContext).not.toHaveBeenCalled();
      expect(sourceCommandMocks.recordResult).toHaveBeenCalledExactlyOnceWith({
        batchId, leaseToken, ownerThreadId, ordinal: 1, attemptRef,
        candidateUrl: command.name === "candidate" ? "https://synthetic-course.example/" : undefined,
        noUnique: command.name !== "candidate", runtimeVersion: headSha,
      });
      expect(sourceCommandMocks.getProvenance.mock.invocationCallOrder[0]).toBeLessThan(sourceCommandMocks.recordResult.mock.invocationCallOrder[0]!);
      expect(write).toHaveBeenCalledExactlyOnceWith({ outcome: "recorded", result: command.name === "candidate" ? "CANDIDATE" : "NO_UNIQUE", replayed: false });
    }
    expect(getAutomationRuntimeVersion()).toBe(environment.ambientRuntime);
    expect(process.env.VERCEL_GIT_COMMIT_SHA).toBe(environment.commit);
    expect(process.env.VERCEL_DEPLOYMENT_ID).toBe(environment.deployment);
  });

  const invalidCases = [
    { name: "unstaged files", change: () => { git.status = " M src/synthetic.ts\0"; } },
    { name: "staged files", change: () => { git.status = "M  src/synthetic.ts\0"; } },
    { name: "untracked files", change: () => { git.status = "?? src/synthetic.ts\0"; } },
    { name: "detached checkout", change: () => { git.branch = ""; } },
    { name: "wrong task branch", change: () => { git.branch = "automation/course-support-unrelated"; } },
    { name: "missing claimed branch", change: () => { provenance.branch = null; } },
    { name: "missing checked-out SHA", change: () => { git.headSha = ""; } },
    { name: "malformed checked-out SHA", change: () => { git.headSha = "not-a-commit"; } },
    { name: "wrong checked-out SHA", change: () => { git.headSha = priorSha; } },
    { name: "malformed expected SHA", change: () => { provenance.releaseSha = "not-a-commit"; } },
  ].flatMap((invalid) => [commandCases[0]!, commandCases[2]!].map((command) => ({
    name: `${command.name}: ${invalid.name}`, change: invalid.change, command,
  })));

  it.each(invalidCases)("rejects $name before query exposure or result writes", async ({ change, command }) => {
    change();
    await expect(run(command)).rejects.toThrow();
    expect(sourceCommandMocks.getContext).not.toHaveBeenCalled();
    expect(sourceCommandMocks.recordResult).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("checks Git again before recording a previously exposed query result", async () => {
    await run(commandCases[0]!);
    expect(write).toHaveBeenCalledExactlyOnceWith(context);
    const firstGitReadCount = sourceCommandMocks.execFileSync.mock.calls.length;
    git.headSha = priorSha;
    write.mockClear();

    await expect(run(commandCases[2]!)).rejects.toThrow();

    expect(sourceCommandMocks.execFileSync.mock.calls.length).toBeGreaterThan(firstGitReadCount);
    expect(sourceCommandMocks.getContext).toHaveBeenCalledOnce();
    expect(sourceCommandMocks.recordResult).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each([commandCases[0]!, commandCases[2]!])("stops $name before Git or source work when ownership is lost", async (command) => {
    sourceCommandMocks.getLease.mockRejectedValueOnce(new Error("Synthetic ownership fence lost"));

    await expect(run(command)).rejects.toThrow("ownership fence lost");

    expect(sourceCommandMocks.execFileSync).not.toHaveBeenCalled();
    expect(sourceCommandMocks.getProvenance).not.toHaveBeenCalled();
    expect(sourceCommandMocks.getContext).not.toHaveBeenCalled();
    expect(sourceCommandMocks.recordResult).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("preserves an existing result with zero research budget without recording again", async () => {
    const exhaustedContext = {
      outcome: "ready", resultRecorded: true, searchBudget: 0,
      browserVerificationRequired: true, query: null,
    };
    sourceCommandMocks.getContext.mockResolvedValueOnce(exhaustedContext);

    await run(commandCases[0]!);

    expect(sourceCommandMocks.getProvenance).toHaveBeenCalledOnce();
    expect(sourceCommandMocks.getContext).toHaveBeenCalledOnce();
    expect(sourceCommandMocks.recordResult).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledExactlyOnceWith(exhaustedContext);
  });
});
