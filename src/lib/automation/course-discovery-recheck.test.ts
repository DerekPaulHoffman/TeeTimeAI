import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  findMany: vi.fn(), findUnique: vi.fn(), recheck: vi.fn(),
  startRun: vi.fn(), finishRun: vi.fn()
}));
vi.mock("../../../scripts/automation/load-local-env", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: { course: {
  findMany: native.findMany, findUnique: native.findUnique
} } }));
vi.mock("@/lib/automation/db-service", () => ({
  startAutomationRun: native.startRun, finishAutomationRun: native.finishRun
}));
vi.mock("@/lib/automation/search-monitoring-discovery", () => ({
  prepareCourseSupportVerificationMonitoring: native.recheck
}));

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
        providerFamilyCategory: "PROVIDER_SPECIFIC"
      }),
      expect.objectContaining({
        ordinal: 2,
        outcome: "EVIDENCE_APPLIED",
        providerFamilyCategory: "PROVIDER_SPECIFIC"
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

describe("exact private course-reference discovery recheck", () => {
  const firstRef = `cm_${"a".repeat(24)}`;
  const secondRef = `cm_${"b".repeat(24)}`;
  const exactTarget = () => ({
    ...target("private-exact-id", "Duplicate Course Name"),
    monitoringStatus: { reference: firstRef }
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("OFFLINE_NETWORK_FORBIDDEN"); }));
    native.findMany.mockResolvedValue([exactTarget()]);
    native.findUnique.mockResolvedValue({
      detectedPlatform: "TEEITUP", providerFamilyKey: "TEEITUP",
      bookingMethod: "PUBLIC_ONLINE", automationEligibility: "ALLOWED",
      automationReason: "NONE", bookingAccessMode: "PUBLIC_SIGNED_OUT",
      supportIncident: { status: "AUTO_INVESTIGATING", activeBatchId: null },
      monitoringStatus: { state: "AUTO_INVESTIGATING" }
    });
    native.recheck.mockResolvedValue({ attemptedCourseIds: ["private-exact-id"],
      appliedCourseIds: ["private-exact-id"], failedCourseIds: [], deferredCourseIds: [] });
    native.startRun.mockResolvedValue({ id: "private-run" });
    native.finishRun.mockResolvedValue(undefined);
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("selects only the exact referenced member when three courses share a name", async () => {
    const candidates = [exactTarget(),
      { ...target("other-id-1", "Duplicate Course Name"), monitoringStatus: { reference: secondRef } },
      { ...target("other-id-2", "Duplicate Course Name"), monitoringStatus: null }];
    native.findMany.mockImplementation(async (query) => {
      expect(query.where).toEqual({ monitoringStatus: { is: { reference: { in: [firstRef] } } } });
      expect(query.select.monitoringStatus).toEqual({ select: { reference: true } });
      return candidates.filter((candidate) => candidate.monitoringStatus?.reference === firstRef);
    });
    const result = await runCourseDiscoveryRecheck(parseCourseDiscoveryRecheckArgs([
      "--course-ref", firstRef, "--apply"
    ]));
    expect(native.recheck).toHaveBeenCalledExactlyOnceWith("private-exact-id", undefined,
      expect.any(Date), { forceFresh: true, preferOfficialWebsiteForUnsupported: true, expectedUnownedIncident: {
        id: "incident-private-exact-id", cycle: 2, revision: 4, status: "NEEDS_HUMAN"
      } });
    expect(result).toMatchObject({ mode: "apply", requestedCount: 1, readyCount: 1,
      outcomes: [{ ordinal: 1, outcome: "EVIDENCE_APPLIED", providerFamilyCategory: "PROVIDER_SPECIFIC" }] });
    const notes = native.finishRun.mock.calls[0][1].notes;
    expect(JSON.parse(notes)).toEqual(result);
    for (const privateValue of [firstRef, "private-exact-id", "Duplicate Course Name", "TEEITUP"]) {
      expect(JSON.stringify(result)).not.toContain(privateValue);
      expect(notes).not.toContain(privateValue);
    }
    expect(result.outcomes[0]).not.toHaveProperty("detectedPlatform");
    expect(result.outcomes[0]).not.toHaveProperty("providerFamilyKey");
  });

  it("retains the old name ambiguity guard instead of selecting an arbitrary match", async () => {
    native.findMany.mockResolvedValue([exactTarget(), target("other-id", "Duplicate Course Name")]);
    await expect(runCourseDiscoveryRecheck({ apply: true, courseNames: ["Duplicate Course Name"] }))
      .rejects.toThrow("ambiguous");
    expect(native.startRun).not.toHaveBeenCalled();
    expect(native.recheck).not.toHaveBeenCalled();
  });

  it("preserves ordinal-only read-only readiness for references", async () => {
    const result = await runCourseDiscoveryRecheck(parseCourseDiscoveryRecheckArgs(["--course-ref", firstRef]));
    expect(result).toEqual({ mode: "dry-run", requestedCount: 1, readyCount: 1,
      outcomes: [{ ordinal: 1, outcome: "READY" }] });
    expect(native.startRun).not.toHaveBeenCalled();
    expect(native.recheck).not.toHaveBeenCalled();
    expect(native.findUnique).not.toHaveBeenCalled();
  });

  it.each([{ loaded: [] }, { loaded: [exactTarget(), exactTarget()] },
    { loaded: [{ ...exactTarget(), monitoringStatus: null }] }])(
    "rejects missing or ambiguous reference mappings before starting a run", async ({ loaded }) => {
      native.findMany.mockResolvedValue(loaded);
      await expect(runCourseDiscoveryRecheck(parseCourseDiscoveryRecheckArgs(["--course-ref", firstRef, "--apply"])))
        .rejects.toThrow(/not found|ambiguous/u);
      expect(native.startRun).not.toHaveBeenCalled();
      expect(native.recheck).not.toHaveBeenCalled();
    }
  );

  it.each(["", "private-database-id", "cm_short", `cm_${"g".repeat(24)}`, `cm_${"a".repeat(25)}`])(
    "rejects invalid references without echoing private input", async (reference) => {
      await expect(runCourseDiscoveryRecheck({ apply: true, courseNames: [], courseRefs: [reference] }))
        .rejects.toThrow("valid course references");
      expect(native.findMany).not.toHaveBeenCalled();
    }
  );

  it("rejects mixed selectors and parked/reference combinations in parser and direct calls", async () => {
    expect(() => parseCourseDiscoveryRecheckArgs(["--course-name", "Name", "--course-ref", firstRef]))
      .toThrow("cannot be combined");
    expect(() => parseCourseDiscoveryRecheckArgs(["--parked-cohort", "--expect-count", "112", "--course-ref", firstRef]))
      .toThrow("cannot be combined");
    await expect(runCourseDiscoveryRecheck({ apply: true, courseNames: ["Name"], courseRefs: [firstRef] }))
      .rejects.toThrow("cannot be combined");
    await expect(runCourseDiscoveryRecheck({ apply: true, parkedCohort: true, expectCount: 112,
      courseNames: [], courseRefs: [firstRef] })).rejects.toThrow("cannot be combined");
    expect(native.findMany).not.toHaveBeenCalled();
    expect(native.startRun).not.toHaveBeenCalled();
  });

  it("bounds reference selections at ten and rejects duplicate selections", async () => {
    const refs = Array.from({ length: 10 }, (_, index) => `cm_${index.toString(16).padStart(24, "0")}`);
    native.findMany.mockResolvedValue(refs.map((reference, index) => ({
      ...target(`id-${index}`, "Duplicate Course Name"), monitoringStatus: { reference }
    })));
    const result = await runCourseDiscoveryRecheck({ apply: false, courseNames: [], courseRefs: refs });
    expect(result.requestedCount).toBe(10);
    native.findMany.mockClear();
    await expect(runCourseDiscoveryRecheck({ apply: false, courseNames: [], courseRefs: [...refs, firstRef] }))
      .rejects.toThrow("At most 10");
    await expect(runCourseDiscoveryRecheck({ apply: false, courseNames: [], courseRefs: [firstRef, firstRef] }))
      .rejects.toThrow("unique");
    expect(native.findMany).not.toHaveBeenCalled();
  });

  it("rejects multiple references aliasing the same course and never falls back to its name", async () => {
    native.findMany.mockResolvedValue([exactTarget(), {
      ...exactTarget(), monitoringStatus: { reference: secondRef }
    }]);
    await expect(runCourseDiscoveryRecheck({ apply: true, courseNames: [], courseRefs: [firstRef, secondRef] }))
      .rejects.toThrow("ambiguous");
    native.findMany.mockResolvedValue([{ ...target("other-id", firstRef), monitoringStatus: { reference: secondRef } }]);
    await expect(runCourseDiscoveryRecheck({ apply: true, courseNames: [], courseRefs: [firstRef] }))
      .rejects.toThrow("not found");
    expect(native.startRun).not.toHaveBeenCalled();
  });

  it("validates missing, malformed, duplicate and oversized CLI references before lookup", () => {
    expect(() => parseCourseDiscoveryRecheckArgs(["--course-ref"])).toThrow("requires a value");
    expect(() => parseCourseDiscoveryRecheckArgs(["--course-ref", "cm_invalid"])).toThrow("valid course references");
    expect(() => parseCourseDiscoveryRecheckArgs(["--course-ref", firstRef, "--course-ref", firstRef])).toThrow("unique");
    const selectors = Array.from({ length: 11 }, (_, index) => ["--course-ref", `cm_${index.toString(16).padStart(24, "0")}`]).flat();
    expect(() => parseCourseDiscoveryRecheckArgs(selectors)).toThrow("At most 10");
    expect(native.findMany).not.toHaveBeenCalled();
  });

  it("does not expose a reference in query failures or unexpected argument errors", async () => {
    native.findMany.mockRejectedValue(new Error(`query failed for ${firstRef}`));
    await expect(runCourseDiscoveryRecheck({ apply: true, courseNames: [], courseRefs: [firstRef] }))
      .rejects.toThrow("Unable to load course discovery recheck targets.");
    expect(() => parseCourseDiscoveryRecheckArgs([firstRef])).toThrow("Unknown course discovery recheck argument.");
    expect(native.startRun).not.toHaveBeenCalled();
  });

  it("never copies a selected reference from a provider failure into outcomes or durable errors", async () => {
    native.recheck.mockRejectedValue(new Error(`private provider failure for ${firstRef}`));
    const result = await runCourseDiscoveryRecheck({ apply: true, courseNames: [], courseRefs: [firstRef] });
    expect(result.outcomes).toEqual([{ ordinal: 1, outcome: "FETCH_FAILED" }]);
    expect(native.finishRun.mock.calls[0][1]).toMatchObject({
      outcome: "completed_with_findings", errors: { failedOrdinals: [1] }
    });
    expect(JSON.stringify(native.finishRun.mock.calls[0][1])).not.toContain(firstRef);
  });

  it.each([
    ["TEEITUP", "PROVIDER_SPECIFIC"], ["private-provider.example", "PROVIDER_SPECIFIC"],
    ["SOURCE_MISSING", "SOURCE_MISSING"], ["SOURCE_CONFLICT", "SOURCE_CONFLICT"]
  ])("uses only shared categories in result and durable notes", async (family, category) => {
    native.findUnique.mockResolvedValue({
      ...await native.findUnique(), detectedPlatform: "TEEITUP", providerFamilyKey: family
    });
    const result = await runCourseDiscoveryRecheck({ apply: true, courseNames: [], courseRefs: [firstRef] });
    expect(result.outcomes[0]).toMatchObject({ providerFamilyCategory: category });
    const notes = native.finishRun.mock.calls[0][1].notes;
    expect(JSON.parse(notes)).toEqual(result);
    expect(notes).not.toContain("detectedPlatform");
    expect(notes).not.toContain("providerFamilyKey");
    expect(notes).not.toContain("TEEITUP");
    expect(notes).not.toContain("private-provider.example");
    expect(notes).not.toContain(firstRef);
  });
});
