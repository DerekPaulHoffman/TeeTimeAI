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
});
