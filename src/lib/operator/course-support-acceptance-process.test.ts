import type { ChildProcess } from "node:child_process";

import { describe, expect, it } from "vitest";

import { attachCourseSupportAcceptanceProjectionFromWorker } from "./course-support-acceptance-process";

const inspection = {
  outcome: "ready",
  handoff: { action: "CLAIM", source: "ORDINARY_DISPATCH" },
  observedAt: "2026-08-22T12:00:00.000Z",
  parkedCampaign: null,
};

describe("course-support acceptance worker process", () => {
  it("kills a stuck projection worker and returns the unchanged handoff", async () => {
    let child: ChildProcess | null = null;
    const startedAt = Date.now();
    const result = await attachCourseSupportAcceptanceProjectionFromWorker(
      inspection,
      {
        command: {
          executable: process.execPath,
          args: [
            "-e",
            "process.stdin.resume(); setInterval(() => undefined, 1000);",
          ],
        },
        killGraceMs: 1_000,
        onWorkerSpawn: (spawned) => {
          child = spawned;
        },
        timeoutMs: 50,
      },
    );

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(child?.killed).toBe(true);
    expect(result.handoff).toBe(inspection.handoff);
    expect(result).toMatchObject({
      outcome: "ready",
      acceptanceProjection: {
        status: "UNKNOWN",
        reason: "ACCEPTANCE_READ_TIMEOUT",
      },
    });
  });

  it("fails closed on malformed worker output without echoing it", async () => {
    const malformedOutput = JSON.stringify({
      protocolVersion: 1,
      projection: {
        schemaVersion: 1,
        status: "PASS",
        rawProviderFamilyKey: "private-provider.example",
      },
    });
    const result = await attachCourseSupportAcceptanceProjectionFromWorker(
      inspection,
      {
        command: {
          executable: process.execPath,
          args: [
            "-e",
            `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(
              malformedOutput,
            )}));`,
          ],
        },
        timeoutMs: 2_000,
      },
    );

    expect(result.handoff).toBe(inspection.handoff);
    expect(result.acceptanceProjection).toMatchObject({
      status: "UNKNOWN",
      reason: "ACCEPTANCE_READ_FAILED",
    });
    expect(JSON.stringify(result)).not.toContain("private-provider");
  });

  it("fails closed on a well-shaped PASS that contradicts its gate evidence", async () => {
    const incoherentOutput = JSON.stringify({
      protocolVersion: 1,
      projection: incoherentPassProjection(),
    });
    const result = await attachCourseSupportAcceptanceProjectionFromWorker(
      inspection,
      {
        command: {
          executable: process.execPath,
          args: [
            "-e",
            `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(
              incoherentOutput,
            )}));`,
          ],
        },
        timeoutMs: 2_000,
      },
    );

    expect(result.handoff).toBe(inspection.handoff);
    expect(result.acceptanceProjection).toMatchObject({
      status: "UNKNOWN",
      reason: "ACCEPTANCE_READ_FAILED",
    });
  });
});

function incoherentPassProjection() {
  return {
    schemaVersion: 1,
    status: "PASS",
    reason: "ALL_GATES_PASS",
    fleet: {
      attention: { actionCount: 0, watchCount: 0, totalCount: 0 },
      engineeringNeededCount: 0,
    },
    latestCampaign: {
      lifecycleStatus: "COMPLETED",
      capturedAt: "2026-08-20T12:00:00.000Z",
      expectedCount: 112,
      totalCount: 112,
      membershipDigest: "a".repeat(64),
      aggregateEvidenceCategories: {
        sourceMissingCount: 14,
        sourceConflictCount: 0,
        providerSpecificCount: 98,
        priorProbeCount: 16,
        priorDiscoveryCount: 99,
        noPriorEvidenceCount: 12,
      },
      progress: {
        terminalCount: 112,
        totalCount: 112,
        pendingCount: 0,
        remainingGlobalParkedCount: 0,
        status: "COMPLETE",
      },
      currentResults: {
        resultCount: 112,
        accountedCount: 112,
        totalCount: 112,
        missingCount: 0,
        monitoredCount: 112,
        bookingNotOpenCount: 0,
        factualLimitationCount: 0,
        technicalLimitationCount: 0,
        sourceUnverifiedCount: 0,
        readyCount: 0,
        activeCount: 0,
        engineeringBlockerCount: 0,
        campaignHumanReviewCount: 0,
        bucketInvariantStatus: "PASS",
        status: "PASS",
      },
      baselineAutomaticWithin24Hours: {
        automaticCount: 112,
        totalCount: 112,
        deadlineAt: "2026-08-21T12:00:00.000Z",
        targetPercent: 95,
        status: "PASS",
      },
    },
    operational: {
      futureAutomaticWithin24Hours: {
        windowDays: 30,
        eligibleCount: 10,
        automaticCount: 9,
        nonAutomaticCount: 1,
        pendingCount: 0,
        unknownCount: 0,
        ratePercent: 90,
        targetPercent: 95,
        status: "FAIL",
      },
      rollingHumanReview: {
        windowDays: 30,
        humanReviewCount: 1,
        endpointCount: 20,
        ratePercent: 5,
        targetPercent: 5,
        ambiguousEndpointCount: 0,
        status: "PASS",
      },
      repeatImplementations: {
        repeatImplementationCount: 0,
        implementationBatchCount: 2,
        implementationGroupCount: 2,
        status: "PASS",
      },
    },
  };
}
