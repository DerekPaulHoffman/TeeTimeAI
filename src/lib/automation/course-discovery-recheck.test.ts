import { describe, expect, it, vi } from "vitest";

import {
  parseCourseDiscoveryRecheckArgs,
  runCourseDiscoveryRecheck
} from "../../../scripts/automation/course-discovery-recheck";

function target(
  id: string,
  name: string,
  overrides: Partial<{
    website: string | null;
    status: "AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "RESOLVED";
    activeBatchId: string | null;
  }> = {}
) {
  return {
    id,
    name,
    website: overrides.website === undefined ? "https://official.example" : overrides.website,
    supportIncident: {
      id: `incident-${id}`,
      cycle: 2,
      revision: 4,
      status: overrides.status ?? ("NEEDS_HUMAN" as const),
      activeBatchId: overrides.activeBatchId ?? null
    }
  };
}

function dependencies(targets: ReturnType<typeof target>[]) {
  return {
    loadTargets: vi.fn().mockResolvedValue(targets),
    recheck: vi.fn(async (candidate: ReturnType<typeof target>) => ({
      attemptedCourseIds: [candidate.id],
      appliedCourseIds: [candidate.id],
      failedCourseIds: [],
      deferredCourseIds: []
    })),
    loadSnapshot: vi.fn().mockResolvedValue({
      detectedPlatform: "TEEITUP",
      providerFamilyKey: "first-public-course.example",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      bookingAccessMode: "PUBLIC_SIGNED_OUT",
      supportIncident: { status: "AUTO_INVESTIGATING", activeBatchId: null },
      monitoringStatus: { state: "REVALIDATING_FINAL" }
    }),
    startRun: vi.fn().mockResolvedValue({ id: "run-private" }),
    finishRun: vi.fn().mockResolvedValue(undefined)
  };
}

describe("bounded course discovery recheck", () => {
  it("parses up to ten explicit courses and defaults to dry-run", () => {
    expect(
      parseCourseDiscoveryRecheckArgs([
        "--course-name",
        "First Public Course",
        "--course-name",
        "Second Public Course"
      ])
    ).toEqual({
      apply: false,
      courseNames: ["First Public Course", "Second Public Course"]
    });
  });

  it("parses the exact parked cohort dry-run and apply digest controls", () => {
    expect(parseCourseDiscoveryRecheckArgs(["--parked-cohort", "--expect-count", "112"])).toEqual({
      apply: false,
      courseNames: [],
      parkedCohort: true,
      expectCount: 112
    });
    expect(
      parseCourseDiscoveryRecheckArgs([
        "--parked-cohort",
        "--expect-count",
        "112",
        "--expect-digest",
        "a".repeat(64),
        "--apply"
      ])
    ).toEqual({
      apply: true,
      courseNames: [],
      parkedCohort: true,
      expectCount: 112,
      expectDigest: "a".repeat(64)
    });
  });

  it("rejects mixed or incomplete parked cohort controls", () => {
    expect(() => parseCourseDiscoveryRecheckArgs(["--parked-cohort"])).toThrow("--expect-count");
    expect(() =>
      parseCourseDiscoveryRecheckArgs([
        "--parked-cohort",
        "--expect-count",
        "112",
        "--course-name",
        "Course"
      ])
    ).toThrow("cannot be combined");
    expect(() => parseCourseDiscoveryRecheckArgs(["--expect-count", "112"])).toThrow(
      "require --parked-cohort"
    );
  });

  it("routes parked cohort execution to the existing discovery recheck command", async () => {
    const deps = {
      ...dependencies([]),
      runParkedCohort: vi.fn().mockResolvedValue({
        scope: "parked-cohort",
        mode: "dry-run",
        campaignState: "PREVIEW",
        expectedCount: 112,
        capturedCount: 112,
        countMatches: true,
        membershipDigest: "a".repeat(64),
        resumed: false
      })
    };

    const result = await runCourseDiscoveryRecheck(
      {
        apply: false,
        courseNames: [],
        parkedCohort: true,
        expectCount: 112
      },
      deps
    );

    expect(result).toMatchObject({
      scope: "parked-cohort",
      capturedCount: 112
    });
    expect(deps.runParkedCohort).toHaveBeenCalledWith({
      apply: false,
      expectedCount: 112,
      expectedDigest: undefined
    });
    expect(deps.loadTargets).not.toHaveBeenCalled();
  });

  it("rejects duplicate or over-broad cohorts before loading data", async () => {
    const deps = dependencies([]);
    await expect(
      runCourseDiscoveryRecheck({ apply: false, courseNames: ["Same", "Same"] }, deps)
    ).rejects.toThrow("unique");
    await expect(
      runCourseDiscoveryRecheck(
        {
          apply: false,
          courseNames: Array.from({ length: 11 }, (_, index) => `Course ${index}`)
        },
        deps
      )
    ).rejects.toThrow("At most 10");
    expect(deps.loadTargets).not.toHaveBeenCalled();
  });

  it("is read-only by default and reports only ordinal readiness", async () => {
    const deps = dependencies([
      target("private-id-1", "First Public Course"),
      target("private-id-2", "Second Public Course", {
        activeBatchId: "owned-batch"
      })
    ]);
    const result = await runCourseDiscoveryRecheck(
      {
        apply: false,
        courseNames: ["First Public Course", "Second Public Course"]
      },
      deps
    );

    expect(result).toEqual({
      mode: "dry-run",
      requestedCount: 2,
      readyCount: 1,
      outcomes: [
        { ordinal: 1, outcome: "READY" },
        { ordinal: 2, outcome: "ACTIVE_OWNER" }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("Public Course");
    expect(JSON.stringify(result)).not.toContain("private-id");
    expect(deps.recheck).not.toHaveBeenCalled();
    expect(deps.startRun).not.toHaveBeenCalled();
  });

  it("applies fresh evidence sequentially and records only sanitized outcomes", async () => {
    const deps = dependencies([
      target("private-id-1", "First Public Course"),
      target("private-id-2", "Second Public Course")
    ]);
    const result = await runCourseDiscoveryRecheck(
      {
        apply: true,
        courseNames: ["First Public Course", "Second Public Course"]
      },
      deps
    );

    expect(deps.recheck).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "private-id-1" })
    );
    expect(deps.recheck).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "private-id-2" })
    );
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        ordinal: 1,
        outcome: "EVIDENCE_APPLIED",
        providerFamilyKey: "CUSTOM"
      }),
      expect.objectContaining({
        ordinal: 2,
        outcome: "EVIDENCE_APPLIED",
        providerFamilyKey: "CUSTOM"
      })
    ]);
    const closeout = deps.finishRun.mock.calls[0][1];
    expect(closeout.outcome).toBe("completed");
    expect(closeout.notes).not.toContain("Public Course");
    expect(closeout.notes).not.toContain("private-id");
    expect(closeout.notes).not.toContain("first-public-course.example");
  });

  it("continues after one sanitized failure and closes the run with findings", async () => {
    const deps = dependencies([
      target("private-id-1", "First Public Course"),
      target("private-id-2", "Second Public Course")
    ]);
    deps.recheck
      .mockRejectedValueOnce(new Error("private provider payload"))
      .mockResolvedValueOnce({
        attemptedCourseIds: ["private-id-2"],
        appliedCourseIds: [],
        failedCourseIds: ["private-id-2"],
        deferredCourseIds: []
      });

    const result = await runCourseDiscoveryRecheck(
      {
        apply: true,
        courseNames: ["First Public Course", "Second Public Course"]
      },
      deps
    );

    expect(result.outcomes).toEqual([
      { ordinal: 1, outcome: "FETCH_FAILED" },
      expect.objectContaining({ ordinal: 2, outcome: "FETCH_FAILED" })
    ]);
    expect(deps.finishRun).toHaveBeenCalledWith(
      "run-private",
      expect.objectContaining({
        outcome: "completed_with_findings",
        errors: { failedOrdinals: [1, 2] }
      })
    );
    expect(JSON.stringify(deps.finishRun.mock.calls[0][1])).not.toContain(
      "private provider payload"
    );
  });

  it("reports a concurrent owner without treating an unfenced discovery as applied", async () => {
    const deps = dependencies([target("private-id-1", "First Public Course")]);
    deps.recheck.mockResolvedValueOnce({
      attemptedCourseIds: ["private-id-1"],
      appliedCourseIds: [],
      failedCourseIds: [],
      deferredCourseIds: ["private-id-1"]
    });
    deps.loadSnapshot.mockResolvedValueOnce({
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "UNKNOWN",
      automationEligibility: "UNKNOWN",
      automationReason: "NONE",
      bookingAccessMode: "UNKNOWN",
      supportIncident: {
        status: "AUTO_INVESTIGATING",
        activeBatchId: "batch-2"
      },
      monitoringStatus: { state: "AUTO_INVESTIGATING" }
    });

    const result = await runCourseDiscoveryRecheck(
      { apply: true, courseNames: ["First Public Course"] },
      deps
    );

    expect(result.outcomes).toEqual([
      expect.objectContaining({ ordinal: 1, outcome: "ACTIVE_OWNER" })
    ]);
    expect(deps.finishRun.mock.calls[0][1].notes).not.toContain("batch-2");
  });
});
