import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  batchFindFirst: vi.fn(),
  batchFindMany: vi.fn(),
  batchFindUnique: vi.fn(),
  batchCreate: vi.fn(),
  batchUpdateMany: vi.fn(),
  batchIncidentCreateMany: vi.fn(),
  supportIncidentFindMany: vi.fn(),
  incidentUpdateMany: vi.fn(),
  supportIncidentUpdateMany: vi.fn(),
  automationRunFindFirst: vi.fn(),
  automationRunCreate: vi.fn(),
  courseProbeFindMany: vi.fn(),
  verificationRequestFindUnique: vi.fn(),
  verificationRequestFindMany: vi.fn(),
  verificationRequestUpdateMany: vi.fn(),
  teeSearchCount: vi.fn(),
  transaction: vi.fn()
}));
const verificationMocks = vi.hoisted(() => ({
  buildCourseSupportProviderSnapshotFingerprint: vi.fn(),
  getCurrentCourseSupportVerificationFailure: vi.fn(),
  getEligibleCourseSupportVerificationProof: vi.fn(),
  scheduleCourseSupportVerificationRequests: vi.fn()
}));
const leaseMocks = vi.hoisted(() => ({
  withPostgresAdvisoryTextLease: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    courseSupportBatch: {
      findFirst: prismaMocks.batchFindFirst,
      findMany: prismaMocks.batchFindMany,
      findUnique: prismaMocks.batchFindUnique
    },
    courseSupportIncident: { findMany: prismaMocks.supportIncidentFindMany },
    courseProbe: { findMany: prismaMocks.courseProbeFindMany },
    courseSupportVerificationRequest: {
      findMany: prismaMocks.verificationRequestFindMany
    },
    automationRun: {
      findFirst: prismaMocks.automationRunFindFirst,
      create: prismaMocks.automationRunCreate
    },
    $transaction: prismaMocks.transaction
  }
}));

vi.mock("./course-support-verification", () => verificationMocks);
vi.mock("./lease", () => leaseMocks);

import {
  assessCourseSupportRecovery,
  assessCourseSupportReleaseTransition,
  buildFailureFingerprint,
  buildCourseSupportReleaseHistory,
  canCloseCourseSupportRetry,
  chooseNewestProviderVerificationEvidence,
  classifyCourseSupportQueueInspection,
  classifyDetachedVerificationFailure,
  classifyDetachedVerificationEvidence,
  classifyFreshBatchEvidence,
  claimCourseSupportBatch,
  closeoutCourseSupportBatch,
  collectFreshRemediatedCourseProof,
  computeCourseSupportNextAttemptAt,
  deriveCourseSupportCurrentDemand,
  heartbeatCourseSupportBatch,
  inspectCourseSupportQueue,
  isDurableTerminalProof,
  isRemediatedSearchSchedulerHealthy,
  markCourseSupportBatchNeedsHuman,
  normalizeCourseSupportObservedGitPaths,
  nextCourseSupportEngineeringSweepAt,
  orderCourseSupportBatchIncidents,
  preserveExplicitHumanVerification,
  resolveCourseSupportProviderCapability,
  selectCourseSupportBatch,
  selectCourseSupportRetryBatch,
  shouldDispatchRemediatedCourseRechecks,
  shouldFinalizeSourceUnverified,
  verifyCourseSupportBatch,
  type CourseSupportCandidate,
  type CourseSupportRetryBatchEvidence
} from "./course-support-batches";

const now = new Date("2026-07-15T20:00:00.000Z");

const transactionClient = {
  automationRun: { create: prismaMocks.automationRunCreate },
  courseSupportBatch: {
    create: prismaMocks.batchCreate,
    updateMany: prismaMocks.batchUpdateMany
  },
  courseSupportBatchIncident: {
    createMany: prismaMocks.batchIncidentCreateMany,
    updateMany: prismaMocks.incidentUpdateMany
  },
  courseSupportIncident: {
    findMany: prismaMocks.supportIncidentFindMany,
    updateMany: prismaMocks.supportIncidentUpdateMany
  },
  courseSupportVerificationRequest: {
    findUnique: prismaMocks.verificationRequestFindUnique,
    findMany: prismaMocks.verificationRequestFindMany,
    updateMany: prismaMocks.verificationRequestUpdateMany
  },
  teeSearch: { count: prismaMocks.teeSearchCount }
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.transaction.mockImplementation(
    async (
      worker: (transaction: typeof transactionClient) => Promise<unknown>
    ) => worker(transactionClient)
  );
  verificationMocks.getEligibleCourseSupportVerificationProof.mockResolvedValue({
    eligible: false,
    reason: "not_found"
  });
  verificationMocks.getCurrentCourseSupportVerificationFailure.mockResolvedValue({
    current: false,
    reason: "not_found"
  });
  verificationMocks.scheduleCourseSupportVerificationRequests.mockResolvedValue({
    createdCount: 0,
    eligibleCount: 0,
    ineligibleCount: 0,
    requests: []
  });
  verificationMocks.buildCourseSupportProviderSnapshotFingerprint.mockReturnValue(
    "b".repeat(64)
  );
  prismaMocks.verificationRequestFindMany.mockResolvedValue([]);
  prismaMocks.verificationRequestUpdateMany.mockResolvedValue({ count: 0 });
  prismaMocks.teeSearchCount.mockResolvedValue(0);
  prismaMocks.supportIncidentFindMany.mockResolvedValue([]);
  prismaMocks.batchFindFirst.mockResolvedValue(null);
  prismaMocks.batchFindMany.mockResolvedValue([]);
  prismaMocks.batchFindUnique.mockResolvedValue(null);
  prismaMocks.batchCreate.mockResolvedValue({
    id: "batch-1",
    reference: "batch-reference"
  });
  prismaMocks.batchIncidentCreateMany.mockResolvedValue({ count: 1 });
  prismaMocks.courseProbeFindMany.mockResolvedValue([]);
  prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
  prismaMocks.automationRunFindFirst.mockResolvedValue(null);
  prismaMocks.automationRunCreate.mockResolvedValue({ id: "routine-run" });
  leaseMocks.withPostgresAdvisoryTextLease.mockImplementation(
    async (
      _client: unknown,
      _key: string,
      worker: () => Promise<unknown>
    ) => ({ acquired: true, value: await worker() })
  );
});

function candidate(
  overrides: Partial<CourseSupportCandidate> = {}
): CourseSupportCandidate {
  return {
    id: "incident-1",
    courseId: "course-1",
    cycle: 1,
    kind: "NEEDS_ADAPTER",
    providerFamilyKey: "CHRONOGOLF",
    failureClass: "UNSUPPORTED_FAMILY",
    failureFingerprint: "v1:UNSUPPORTED_FAMILY:NEEDS_ADAPTER",
    engineeringOnly: true,
    activeRealSearchCount: 0,
    earliestTargetDate: null,
    firstSeenAt: new Date("2026-07-14T18:00:00.000Z"),
    lastSeenAt: new Date("2026-07-15T18:00:00.000Z"),
    lastAttemptAt: null,
    nextAttemptAt: new Date("2026-07-15T19:30:00.000Z"),
    attemptCount: 0,
    updatedAt: new Date("2026-07-15T18:00:00.000Z"),
    ...overrides
  };
}

function retryBatchEvidence(
  intended: CourseSupportCandidate,
  overrides: Partial<CourseSupportRetryBatchEvidence> = {}
): CourseSupportRetryBatchEvidence {
  const batchIncidentId = `batch-entry-${intended.id}`;
  return {
    status: "RETRYABLE_FAILED",
    completedAt: new Date("2026-07-15T19:00:00.000Z"),
    summary: { closeout: { outcome: "retryable_failed" } },
    providerFamilyKey: intended.providerFamilyKey,
    failureFingerprint: intended.failureFingerprint,
    incidents: [
      {
        id: batchIncidentId,
        incidentId: intended.id,
        courseId: intended.courseId,
        cycle: intended.cycle,
        result: "RETRY_SCHEDULED",
        incident: {
          batchIncidents: [{ id: batchIncidentId, cycle: intended.cycle }]
        }
      }
    ],
    ...overrides
  };
}

function retryBatchEntry(intended: CourseSupportCandidate) {
  return retryBatchEvidence(intended).incidents[0];
}

describe("course-support batch selection", () => {
  it("deduplicates live demand and keeps its earliest target date", () => {
    expect(
      deriveCourseSupportCurrentDemand([
        {
          teeSearch: {
            id: "search-2",
            date: new Date("2026-07-20T00:00:00.000Z")
          }
        },
        {
          teeSearch: {
            id: "search-1",
            date: new Date("2026-07-18T00:00:00.000Z")
          }
        },
        {
          teeSearch: {
            id: "search-1",
            date: new Date("2026-07-18T00:00:00.000Z")
          }
        }
      ])
    ).toEqual({
      activeRealSearchCount: 2,
      earliestTargetDate: new Date("2026-07-18T00:00:00.000Z")
    });
    expect(deriveCourseSupportCurrentDemand([])).toEqual({
      activeRealSearchCount: 0,
      earliestTargetDate: null
    });
  });

  it("keeps a same-day western search current across the UTC date rollover", () => {
    const currentDemand = deriveCourseSupportCurrentDemand(
      [
        {
          teeSearch: {
            id: "same-local-day",
            date: new Date("2026-07-20T00:00:00.000Z")
          }
        },
        {
          teeSearch: {
            id: "previous-local-day",
            date: new Date("2026-07-19T00:00:00.000Z")
          }
        }
      ],
      {
        timeZone: "America/Los_Angeles",
        now: new Date("2026-07-21T01:00:00.000Z")
      }
    );

    expect(currentDemand).toEqual({
      activeRealSearchCount: 1,
      earliestTargetDate: new Date("2026-07-20T00:00:00.000Z")
    });
  });

  it("prioritizes a near-date real fetch failure", () => {
    const selected = selectCourseSupportBatch({
      candidates: [
        candidate({ id: "synthetic", courseId: "course-synthetic" }),
        candidate({
          id: "real",
          courseId: "course-real",
          kind: "FETCH_FAILED",
          failureClass: "NETWORK",
          failureFingerprint: "v1:NETWORK:FETCH_FAILED",
          engineeringOnly: false,
          activeRealSearchCount: 1,
          earliestTargetDate: new Date("2026-07-18T00:00:00.000Z")
        })
      ],
      now
    });

    expect(selected).toMatchObject({
      failureFingerprint: "v1:NETWORK:FETCH_FAILED",
      containsCriticalRealDemand: true
    });
    expect(selected?.incidents.map((incident) => incident.id)).toEqual(["real"]);
  });

  it("reserves the fourth noncritical batch opportunity for aged synthetic work", () => {
    const selected = selectCourseSupportBatch({
      candidates: [
        candidate({
          id: "real",
          courseId: "course-real",
          providerFamilyKey: "FOREUP",
          failureFingerprint: "v1:UNSUPPORTED_FAMILY:NEEDS_ADAPTER",
          engineeringOnly: false,
          activeRealSearchCount: 1,
          firstSeenAt: new Date("2026-07-15T18:00:00.000Z")
        }),
        candidate({
          id: "aged-synthetic",
          courseId: "course-synthetic",
          providerFamilyKey: "CHRONOGOLF",
          firstSeenAt: new Date("2026-07-13T18:00:00.000Z")
        })
      ],
      recentBatches: Array.from({ length: 3 }, () => ({
        includedEngineeringOnly: false,
        includedCriticalRealDemand: false
      })),
      now
    });

    expect(selected).toMatchObject({
      providerFamilyKey: "CHRONOGOLF",
      fairnessReason: "AGED_SYNTHETIC_RESERVATION"
    });
  });

  it("keeps a provider/fingerprint batch bounded at twenty", () => {
    const selected = selectCourseSupportBatch({
      candidates: Array.from({ length: 30 }, (_, index) =>
        candidate({
          id: `incident-${index}`,
          courseId: `course-${index}`
        })
      ),
      maxCourses: 100,
      now
    });

    expect(selected?.incidents).toHaveLength(20);
  });

  it("reserves one slot in a five-course mixed group for aged synthetic coverage", () => {
    const selected = selectCourseSupportBatch({
      candidates: [
        ...Array.from({ length: 5 }, (_, index) =>
          candidate({
            id: `real-${index}`,
            courseId: `real-course-${index}`,
            engineeringOnly: false,
            activeRealSearchCount: 1,
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z")
          })
        ),
        candidate({
          id: "aged-synthetic",
          courseId: "synthetic-course",
          firstSeenAt: new Date("2026-07-13T18:00:00.000Z")
        })
      ],
      maxCourses: 5,
      now
    });

    expect(selected?.incidents).toHaveLength(5);
    expect(selected?.incidents.some((incident) => incident.id === "aged-synthetic")).toBe(
      true
    );
  });

  it("claims only the exact due incidents from a completed retryable batch", () => {
    const intended = candidate({
      id: "retry-incident",
      courseId: "retry-course",
      cycle: 3,
      providerFamilyKey: "BROWSER_DISCOVERY",
      failureFingerprint: "v1:MISSING_SOURCE:NEEDS_ADAPTER"
    });
    const selected = selectCourseSupportRetryBatch({
      candidates: [candidate(), intended],
      retryBatch: retryBatchEvidence(intended),
      maxCourses: 1,
      now
    });

    expect(selected).toMatchObject({
      fairnessReason: "TARGETED_RETRY",
      incidents: [{ id: "retry-incident", courseId: "retry-course" }]
    });
  });

  it("claims one exact source ordinal without requiring sibling retries to be due", () => {
    const first = candidate({ id: "retry-first", courseId: "retry-course-1" });
    const intended = candidate({
      id: "retry-intended",
      courseId: "retry-course-2",
      cycle: 3
    });
    const last = candidate({ id: "retry-last", courseId: "retry-course-3" });
    const retryBatch = retryBatchEvidence(intended, {
      incidents: [
        retryBatchEntry(first),
        retryBatchEntry(intended),
        retryBatchEntry(last)
      ]
    });

    expect(
      selectCourseSupportRetryBatch({
        candidates: [candidate(), intended],
        retryBatch,
        retryOrdinal: 2,
        maxCourses: 1,
        now
      })
    ).toMatchObject({
      fairnessReason: "TARGETED_RETRY",
      incidents: [{ id: "retry-intended", courseId: "retry-course-2" }]
    });
  });

  it("fails closed for invalid exact-entry retry ordinals and batch sizes", () => {
    const intended = candidate();
    const retryBatch = retryBatchEvidence(intended);

    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch,
        retryOrdinal: 0,
        maxCourses: 1,
        now
      })
    ).toThrow("positive integer");
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch,
        retryOrdinal: 2,
        maxCourses: 1,
        now
      })
    ).toThrow("out of range");
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch,
        retryOrdinal: 1,
        now
      })
    ).toThrow("requires maxCourses to be 1");
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch,
        retryOrdinal: 1,
        maxCourses: 0,
        now
      })
    ).toThrow("requires maxCourses to be 1");
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch,
        retryOrdinal: 1,
        maxCourses: 2,
        now
      })
    ).toThrow("requires maxCourses to be 1");
  });

  it("never falls back when the selected retry ordinal is not currently eligible", () => {
    const selected = candidate({
      id: "selected-retry",
      courseId: "selected-course"
    });
    const unrelated = candidate({
      id: "unrelated-due",
      courseId: "unrelated-course"
    });

    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [unrelated],
        retryBatch: retryBatchEvidence(selected),
        retryOrdinal: 1,
        maxCourses: 1,
        now
      })
    ).toThrow("not currently due or its provenance changed");
  });

  it("fails closed when a targeted retry is not due or its provenance changed", () => {
    const intended = candidate({
      id: "retry-incident",
      courseId: "retry-course",
      cycle: 3
    });
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [
          {
            ...intended,
            failureFingerprint: "v2:changed"
          }
        ],
        retryBatch: retryBatchEvidence(intended),
        now
      })
    ).toThrow("not currently due or its provenance changed");
  });

  it("rejects incomplete, terminal, duplicate, or oversized retry evidence", () => {
    const intended = candidate();
    const retryBatch = retryBatchEvidence(intended);
    retryBatch.incidents[0].result = "FINAL_DISPOSITION";

    expect(() =>
      selectCourseSupportRetryBatch({ candidates: [intended], retryBatch, now })
    ).toThrow("non-retryable incident evidence");
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch: { ...retryBatch, status: "PARTIAL" },
        now
      })
    ).toThrow("durably closed retryable batch");
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch: {
          ...retryBatch,
          incidents: [
            { ...retryBatch.incidents[0], result: "RETRY_SCHEDULED" },
            { ...retryBatch.incidents[0], result: "RETRY_SCHEDULED" }
          ]
        },
        maxCourses: 2,
        now
      })
    ).toThrow("duplicate incident evidence");
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch: {
          ...retryBatch,
          incidents: [
            { ...retryBatch.incidents[0], result: "RETRY_SCHEDULED" },
            {
              ...retryBatch.incidents[0],
              incidentId: "incident-2",
              courseId: "course-2",
              result: "RETRY_SCHEDULED"
            }
          ]
        },
        maxCourses: 1,
        now
      })
    ).toThrow("exceeds the requested batch size");
  });

  it("does not let a targeted retry bypass due critical real demand", () => {
    const intended = candidate({
      id: "retry-incident",
      courseId: "retry-course"
    });
    const critical = candidate({
      id: "critical-incident",
      courseId: "critical-course",
      kind: "FETCH_FAILED",
      engineeringOnly: false,
      activeRealSearchCount: 1,
      earliestTargetDate: new Date("2026-07-18T00:00:00.000Z")
    });

    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended, critical],
        retryBatch: retryBatchEvidence(intended),
        maxCourses: 1,
        now
      })
    ).toThrow("cannot bypass due critical real-demand work");
  });

  it.each([
    ["missing", null],
    ["not newer than closeout", new Date("2026-07-15T19:00:00.000Z")],
    ["not due yet", new Date("2026-07-15T20:01:00.000Z")]
  ])("rejects a %s targeted retry schedule", (_label, nextAttemptAt) => {
    const intended = candidate({
      id: "retry-incident",
      courseId: "retry-course",
      nextAttemptAt
    });

    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch: retryBatchEvidence(intended),
        now
      })
    ).toThrow("does not have a current due retry schedule");
  });

  it("rejects an old retry source after a later batch attempt", () => {
    const intended = candidate({
      id: "retry-incident",
      courseId: "retry-course"
    });
    const retryBatch = retryBatchEvidence(intended);
    retryBatch.incidents[0].incident.batchIncidents = [
      { id: "newer-batch-entry", cycle: intended.cycle }
    ];

    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch,
        now
      })
    ).toThrow("superseded by a later batch");
  });
});

describe("course-support claim demand fencing", () => {
  const baseSha = "a".repeat(40);

  function incidentRecord(input: {
    engineeringOnly: boolean;
    preferences: Array<{
      teeSearch: { id: string; date: Date };
    }>;
  }) {
    return {
      ...candidate({ engineeringOnly: input.engineeringOnly }),
      course: {
        timeZone: "America/Los_Angeles",
        preferences: input.preferences
      }
    };
  }

  it("rejects an exact retry ordinal without a source batch", async () => {
    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        retryOrdinal: 1,
        maxCourses: 1,
        now
      })
    ).rejects.toThrow("requires a retry batch reference");

    expect(prismaMocks.automationRunCreate).not.toHaveBeenCalled();
    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
  });

  it("atomically promotes synthetic provenance when current real demand exists", async () => {
    const preferences = [
      {
        teeSearch: {
          id: "real-search",
          date: new Date("2026-07-20T00:00:00.000Z")
        }
      }
    ];
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([
        incidentRecord({ engineeringOnly: true, preferences })
      ])
      .mockResolvedValueOnce([
        incidentRecord({ engineeringOnly: true, preferences })
      ]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now: new Date("2026-07-21T01:00:00.000Z")
      })
    ).resolves.toMatchObject({ outcome: "ready", incidentCount: 1 });

    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          activeRealSearchCount: 1,
          earliestTargetDate: new Date("2026-07-20T00:00:00.000Z"),
          engineeringOnly: false
        })
      })
    );
    expect(prismaMocks.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "Serializable" }
    );
  });

  it("rolls back claim creation when live demand changes after selection", async () => {
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([
        incidentRecord({ engineeringOnly: true, preferences: [] })
      ])
      .mockResolvedValueOnce([
        incidentRecord({
          engineeringOnly: true,
          preferences: [
            {
              teeSearch: {
                id: "late-real-search",
                date: new Date("2026-07-20T00:00:00.000Z")
              }
            }
          ]
        })
      ]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now: new Date("2026-07-21T01:00:00.000Z")
      })
    ).rejects.toThrow("demand changed during claim");

    expect(prismaMocks.automationRunCreate).not.toHaveBeenCalled();
    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
    expect(prismaMocks.supportIncidentUpdateMany).not.toHaveBeenCalled();
  });

  it("rolls back claim creation when live demand ends after selection", async () => {
    const preferences = [
      {
        teeSearch: {
          id: "ending-real-search",
          date: new Date("2026-07-20T00:00:00.000Z")
        }
      }
    ];
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([
        incidentRecord({ engineeringOnly: false, preferences })
      ])
      .mockResolvedValueOnce([
        incidentRecord({ engineeringOnly: false, preferences: [] })
      ]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now: new Date("2026-07-21T01:00:00.000Z")
      })
    ).rejects.toThrow("demand changed during claim");

    expect(prismaMocks.automationRunCreate).not.toHaveBeenCalled();
    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
    expect(prismaMocks.supportIncidentUpdateMany).not.toHaveBeenCalled();
  });

  it("claims only one exact retry ordinal and records redacted source provenance", async () => {
    const first = candidate({ id: "retry-first", courseId: "retry-course-1" });
    const intended = candidate({
      id: "retry-intended",
      courseId: "retry-course-2",
      engineeringOnly: false
    });
    const last = candidate({ id: "retry-last", courseId: "retry-course-3" });
    const retryBatch = retryBatchEvidence(intended, {
      incidents: [
        retryBatchEntry(first),
        retryBatchEntry(intended),
        retryBatchEntry(last)
      ]
    });
    const incident = {
      ...intended,
      course: { timeZone: "America/Los_Angeles", preferences: [] }
    };
    prismaMocks.batchFindUnique.mockResolvedValue(retryBatch);
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([incident]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        retryBatchId: "private-source-batch-id",
        retryOrdinal: 2,
        maxCourses: 1,
        now
      })
    ).resolves.toMatchObject({
      outcome: "ready",
      incidentCount: 1,
      fairnessReason: "TARGETED_RETRY"
    });

    expect(prismaMocks.batchIncidentCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          incidentId: "retry-intended",
          courseId: "retry-course-2"
        })
      ]
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "retry-intended",
          batchIncidents: {
            some: expect.objectContaining({
              id: "batch-entry-retry-intended",
              batchId: "private-source-batch-id",
              incidentId: "retry-intended",
              courseId: "retry-course-2",
              result: "RETRY_SCHEDULED"
            })
          }
        })
      })
    );
    const notes = JSON.parse(
      prismaMocks.automationRunCreate.mock.calls[0][0].data.notes
    );
    expect(notes).toMatchObject({
      targetedRetry: true,
      retryScope: "ENTRY",
      retrySourceOrdinal: "02"
    });
    expect(notes.retrySourceBatchDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(notes)).not.toContain("private-source-batch-id");
    const summary = prismaMocks.batchCreate.mock.calls[0][0].data.summary;
    expect(summary).toMatchObject({
      targetedRetry: true,
      retryScope: "ENTRY",
      retrySourceOrdinal: "02"
    });
    expect(summary.retrySourceBatchDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(summary)).not.toContain("private-source-batch-id");
  });

  it("rolls back an exact-entry retry when live demand changes during claim", async () => {
    const intended = candidate({
      id: "retry-intended",
      courseId: "retry-course",
      engineeringOnly: false
    });
    const retryBatch = retryBatchEvidence(intended);
    prismaMocks.batchFindUnique.mockResolvedValue(retryBatch);
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([
        {
          ...intended,
          course: { timeZone: "America/Los_Angeles", preferences: [] }
        }
      ])
      .mockResolvedValueOnce([
        {
          ...intended,
          course: {
            timeZone: "America/Los_Angeles",
            preferences: [
              {
                teeSearch: {
                  id: "new-real-demand",
                  date: new Date("2026-07-20T00:00:00.000Z")
                }
              }
            ]
          }
        }
      ]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        retryBatchId: "private-source-batch-id",
        retryOrdinal: 1,
        maxCourses: 1,
        now: new Date("2026-07-21T01:00:00.000Z")
      })
    ).rejects.toThrow("demand changed during claim");

    expect(prismaMocks.automationRunCreate).not.toHaveBeenCalled();
    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
    expect(prismaMocks.supportIncidentUpdateMany).not.toHaveBeenCalled();
  });

  it("rolls back an exact-entry retry when critical real demand appears", async () => {
    const intended = candidate({
      id: "retry-intended",
      courseId: "retry-course",
      engineeringOnly: false
    });
    const incident = {
      ...intended,
      course: { timeZone: "America/Los_Angeles", preferences: [] }
    };
    prismaMocks.batchFindUnique.mockResolvedValue(retryBatchEvidence(intended));
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([
        {
          course: {
            timeZone: "America/New_York",
            preferences: [
              {
                teeSearch: {
                  id: "new-critical-demand",
                  date: new Date("2026-07-22T00:00:00.000Z")
                }
              }
            ]
          }
        }
      ]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        retryBatchId: "private-source-batch-id",
        retryOrdinal: 1,
        maxCourses: 1,
        now: new Date("2026-07-21T01:00:00.000Z")
      })
    ).rejects.toThrow("cannot bypass due critical real-demand work");

    expect(prismaMocks.automationRunCreate).not.toHaveBeenCalled();
    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
    expect(prismaMocks.supportIncidentUpdateMany).not.toHaveBeenCalled();
  });
});

describe("course-support retry policy", () => {
  it("backs transient failures off from minutes to one day", () => {
    const attempts = [1, 2, 3, 4].map((attemptCount) =>
      computeCourseSupportNextAttemptAt({
        failureClass: "NETWORK",
        failureFingerprint: "v1:NETWORK:FETCH_FAILED",
        attemptCount,
        now
      }).getTime()
    );

    expect(attempts[0]).toBeGreaterThan(now.getTime() + 13 * 60 * 1000);
    expect(attempts[1]).toBeGreaterThan(now.getTime() + 54 * 60 * 1000);
    expect(attempts[2]).toBeGreaterThan(now.getTime() + 5 * 60 * 60 * 1000);
    expect(attempts[3]).toBeGreaterThan(now.getTime() + 21 * 60 * 60 * 1000);
  });

  it("honors a bounded rate-limit Retry-After", () => {
    expect(
      computeCourseSupportNextAttemptAt({
        failureClass: "RATE_LIMIT",
        failureFingerprint: "v1:RATE_LIMIT:FETCH_FAILED",
        attemptCount: 1,
        retryAfterSeconds: 90,
        now
      }).toISOString()
    ).toBe("2026-07-15T20:01:30.000Z");
  });

  it("permits non-transient retry release only for explicit operational failures", () => {
    expect(canCloseCourseSupportRetry("AUTH", "blocked_auth")).toBe(true);
    expect(canCloseCourseSupportRetry("UNSUPPORTED_FAMILY", "blocked_git")).toBe(
      true
    );
    expect(canCloseCourseSupportRetry("AUTH", "retryable_failed")).toBe(false);
    expect(canCloseCourseSupportRetry("AUTH")).toBe(false);
  });
});

describe("fresh runtime verification", () => {
  const runnableCourse = {
    isPublic: true,
    bookingMethod: "PUBLIC_ONLINE" as const,
    automationEligibility: "ALLOWED" as const,
    automationReason: "NONE" as const
  };
  const browserPrivateSourceUrl =
    "https://course.example/golf/deer-creek";
  const browserPrivatePolicyNotes =
    "The official course profile identifies this course as private. Tee Time Spot must not present public tee-time monitoring for member-controlled inventory.";
  const browserPrivateProof = {
    kind: "BROWSER_PRIVATE_IDENTITY",
    disposition: "VERIFIED_PRIVATE",
    discoveryCreatedAt: "2026-07-15T19:30:00.000Z",
    intelligenceVerifiedAt: "2026-07-15T19:31:00.000Z",
    intelligenceReviewAt: "2027-01-11T19:31:00.000Z",
    evidenceOrigin: "https://course.example",
    provenance: "official-private-course-profile",
    confidence: 0.98,
    intelligenceConfidence: 0.98,
    policyNotes: browserPrivatePolicyNotes,
    courseBookingMethod: "UNKNOWN",
    courseAutomationEligibility: "BLOCKED",
    courseAutomationReason: "OTHER",
    discoveryStatus: "VERIFIED",
    discoveryDetectedPlatform: "UNKNOWN",
    discoveryBookingMethod: "UNKNOWN",
    discoveryBookingPhone: null,
    discoveryAutomationEligibility: "BLOCKED",
    discoveryAutomationReason: "OTHER",
    discoveryApiEndpoint: null,
    discoveryApiMetadata: null
  } as const;

  function browserPrivateCourse(input?: {
    discoveryCreatedAt?: Date;
    intelligenceVerifiedAt?: Date;
    intelligenceReviewAt?: Date;
    provenance?: string;
    bookingPhone?: string | null;
    apiEndpoint?: string | null;
    apiMetadata?: Record<string, string> | null;
  }) {
    return {
      ...runnableCourse,
      isPublic: false,
      bookingMethod: "UNKNOWN" as const,
      automationEligibility: "BLOCKED" as const,
      automationReason: "OTHER" as const,
      policyNotes: browserPrivatePolicyNotes,
      intelligenceVerifiedAt:
        input?.intelligenceVerifiedAt ??
        new Date("2026-07-15T19:31:00.000Z"),
      intelligenceReviewAt:
        input?.intelligenceReviewAt ??
        new Date("2027-01-11T19:31:00.000Z"),
      intelligenceConfidence: 0.98,
      latestDiscovery: {
        status: "VERIFIED",
        detectedPlatform: "UNKNOWN",
        bookingMethod: "UNKNOWN" as const,
        bookingPhone: input?.bookingPhone ?? null,
        automationEligibility: "BLOCKED" as const,
        automationReason: "OTHER" as const,
        sourceUrl: browserPrivateSourceUrl,
        bookingUrl: browserPrivateSourceUrl,
        apiEndpoint: input?.apiEndpoint ?? null,
        apiMetadata: input?.apiMetadata ?? null,
        confidence: 0.98,
        evidence: {
          learnedFrom:
            input?.provenance ?? "official-private-course-profile",
          finalUrl: browserPrivateSourceUrl,
          observedUrls: [browserPrivateSourceUrl],
          visibleText: "Deer Creek Details Status: Private"
        },
        createdAt:
          input?.discoveryCreatedAt ??
          new Date("2026-07-15T19:30:00.000Z")
      }
    };
  }

  it("accepts fresh no-email provider verification from the exact release", () => {
    const releaseSha = "a".repeat(40);
    expect(
      classifyDetachedVerificationEvidence({
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        recheckDispatchStartedAt: new Date("2026-07-15T20:05:30.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T20:04:00.000Z"),
        proof: {
          eligible: true,
          releaseSha,
          runtimeVersion: releaseSha,
          outcome: "NO_MATCH",
          completedAt: new Date("2026-07-15T20:06:30.000Z"),
          providerSnapshotFingerprint: "b".repeat(64),
          evidence: {
            kind: "PROVIDER_VERIFICATION",
            runtimeVersion: releaseSha,
            outcome: "NO_MATCH",
            observedAt: "2026-07-15T20:06:00.000Z",
            providerExecution: true
          }
        }
      })
    ).toMatchObject({
      result: "RESTORED",
      postProbeId: null,
      proofSnapshot: { kind: "PROVIDER_VERIFICATION" }
    });
  });

  it("rejects detached proof observed before the remediation dispatch", () => {
    const releaseSha = "a".repeat(40);
    expect(
      classifyDetachedVerificationEvidence({
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        recheckDispatchStartedAt: new Date("2026-07-15T20:10:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T20:04:00.000Z"),
        proof: {
          eligible: true,
          releaseSha,
          runtimeVersion: releaseSha,
          outcome: "NO_MATCH",
          completedAt: new Date("2026-07-15T20:06:30.000Z"),
          providerSnapshotFingerprint: "b".repeat(64),
          evidence: {
            kind: "PROVIDER_VERIFICATION",
            runtimeVersion: releaseSha,
            outcome: "NO_MATCH",
            observedAt: "2026-07-15T20:06:00.000Z",
            providerExecution: true
          }
        }
      })?.result
    ).toBe("STALE_EVIDENCE");
  });

  it("persists current exact-runtime detached failure evidence as retryable", () => {
    const releaseSha = "a".repeat(40);
    expect(
      classifyDetachedVerificationFailure({
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        recheckDispatchStartedAt: new Date("2026-07-15T20:05:30.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T20:04:00.000Z"),
        failure: {
          current: true,
          releaseSha,
          runtimeVersion: releaseSha,
          status: "RETRYABLE_FAILED",
          outcome: "FETCH_FAILED",
          failureClass: "RATE_LIMIT",
          providerExecution: true,
          observedAt: new Date("2026-07-15T20:06:00.000Z"),
          completedAt: null,
          nextAttemptAt: new Date("2026-07-15T20:21:00.000Z"),
          providerRetryNotBeforeAt: new Date("2026-07-15T22:00:00.000Z"),
          providerSnapshotFingerprint: "b".repeat(64),
          evidence: {
            kind: "PROVIDER_VERIFICATION",
            runtimeVersion: releaseSha,
            outcome: "FETCH_FAILED",
            failureClass: "RATE_LIMIT",
            providerExecution: true,
            observedAt: "2026-07-15T20:06:00.000Z"
          }
        }
      })
    ).toMatchObject({
      result: "RETRY_SCHEDULED",
      proofSnapshot: {
        kind: "PROVIDER_VERIFICATION_FAILURE",
        outcome: "FETCH_FAILED",
        failureClass: "RATE_LIMIT",
        providerExecution: true,
        providerRetryNotBeforeAt: "2026-07-15T22:00:00.000Z"
      }
    });
  });

  it("keeps a newer detached failure over an older workflow success", () => {
    const selected = chooseNewestProviderVerificationEvidence({
      workflow: {
        result: "RESTORED",
        postProbeId: "probe-success",
        message: "Older workflow success.",
        proofSnapshot: {
          kind: "PROVIDER_PROBE",
          outcome: "NO_MATCH",
          observedAt: "2026-07-15T20:06:00.000Z"
        }
      },
      detachedVerification: null,
      detachedFailure: {
        result: "RETRY_SCHEDULED",
        postProbeId: null,
        message: "Newer detached failure.",
        proofSnapshot: {
          kind: "PROVIDER_VERIFICATION_FAILURE",
          outcome: "FETCH_FAILED",
          observedAt: "2026-07-15T20:07:00.000Z"
        }
      }
    });

    expect(selected).toMatchObject({
      result: "RETRY_SCHEDULED",
      message: "Newer detached failure.",
      proofSnapshot: { kind: "PROVIDER_VERIFICATION_FAILURE" }
    });
  });

  it("keeps a newer workflow success over an older detached failure", () => {
    const selected = chooseNewestProviderVerificationEvidence({
      workflow: {
        result: "RESTORED",
        postProbeId: "probe-success",
        message: "Newer workflow success.",
        proofSnapshot: {
          kind: "PROVIDER_PROBE",
          outcome: "NO_MATCH",
          observedAt: "2026-07-15T20:07:00.000Z"
        }
      },
      detachedVerification: null,
      detachedFailure: {
        result: "RETRY_SCHEDULED",
        postProbeId: null,
        message: "Older detached failure.",
        proofSnapshot: {
          kind: "PROVIDER_VERIFICATION_FAILURE",
          outcome: "FETCH_FAILED",
          observedAt: "2026-07-15T20:06:00.000Z"
        }
      }
    });

    expect(selected).toMatchObject({
      result: "RESTORED",
      message: "Newer workflow success.",
      proofSnapshot: { kind: "PROVIDER_PROBE" }
    });
  });

  it("fails safe when success and failure observations have the same timestamp", () => {
    const selected = chooseNewestProviderVerificationEvidence({
      workflow: null,
      detachedVerification: {
        result: "RESTORED",
        postProbeId: null,
        message: "Tied detached success.",
        proofSnapshot: {
          kind: "PROVIDER_VERIFICATION",
          outcome: "NO_MATCH",
          observedAt: "2026-07-15T20:06:00.000Z"
        }
      },
      detachedFailure: {
        result: "RETRY_SCHEDULED",
        postProbeId: null,
        message: "Tied detached failure.",
        proofSnapshot: {
          kind: "PROVIDER_VERIFICATION_FAILURE",
          outcome: "FETCH_FAILED",
          observedAt: "2026-07-15T20:06:00.000Z"
        }
      }
    });

    expect(selected).toMatchObject({
      result: "RETRY_SCHEDULED",
      message: "Tied detached failure."
    });
  });

  it("does not carry detached failure evidence from before dispatch", () => {
    const releaseSha = "a".repeat(40);
    expect(
      classifyDetachedVerificationFailure({
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        recheckDispatchStartedAt: new Date("2026-07-15T20:10:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T20:04:00.000Z"),
        failure: {
          current: true,
          releaseSha,
          runtimeVersion: releaseSha,
          status: "STALE",
          outcome: "FETCH_FAILED",
          failureClass: "SCHEMA",
          providerExecution: false,
          observedAt: new Date("2026-07-15T20:06:00.000Z"),
          completedAt: new Date("2026-07-15T20:06:30.000Z"),
          nextAttemptAt: null,
          providerRetryNotBeforeAt: null,
          providerSnapshotFingerprint: "b".repeat(64),
          evidence: {
            kind: "PROVIDER_VERIFICATION",
            runtimeVersion: releaseSha,
            outcome: "FETCH_FAILED",
            failureClass: "SCHEMA",
            providerExecution: false,
            observedAt: "2026-07-15T20:06:00.000Z"
          }
        }
      })
    ).toBeNull();
  });

  it("rejects an older successful probe from another runtime", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        releaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        recheckDispatchStartedAt: new Date("2026-07-15T20:05:30.000Z"),
        preProbeId: "pre-probe",
        newestProbe: {
          id: "old-runtime-probe",
          outcome: "NO_MATCH",
          observedAt: new Date("2026-07-15T20:06:00.000Z"),
          runtimeVersion: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          providerExecution: true
        },
        course: runnableCourse
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("accepts the newest successful observation from the deployed release", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        releaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        recheckDispatchStartedAt: new Date("2026-07-15T20:05:30.000Z"),
        preProbeId: "pre-probe",
        newestProbe: {
          id: "post-probe",
          outcome: "MATCH_FOUND",
          observedAt: new Date("2026-07-15T20:06:00.000Z"),
          runtimeVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          providerExecution: true
        },
        course: runnableCourse
      })
    ).toMatchObject({ result: "RESTORED", postProbeId: "post-probe" });
  });

  it("accepts an exact-runtime reused probe only with a fresh dispatched search check", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentLastSeenAt: new Date("2026-07-15T20:09:00.000Z"),
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        releaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        recheckDispatchStartedAt: new Date("2026-07-15T20:10:00.000Z"),
        newestProbe: {
          id: "reused-exact-runtime-probe",
          outcome: "NO_MATCH",
          observedAt: new Date("2026-07-15T20:06:00.000Z"),
          freshSearchCheckedAt: new Date("2026-07-15T20:11:00.000Z"),
          runtimeVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          providerExecution: true
        },
        course: runnableCourse
      }).result
    ).toBe("RESTORED");
  });

  it("does not consume an exact-release probe before a recheck dispatch is durable", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        releaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        newestProbe: {
          id: "pre-dispatch-probe",
          outcome: "NO_MATCH",
          observedAt: new Date("2026-07-15T20:06:00.000Z"),
          runtimeVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          providerExecution: true
        },
        course: runnableCourse
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("rejects a fresh semantic NO_MATCH that did not execute the provider", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        releaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        preProbeId: "pre-probe",
        newestProbe: {
          id: "layout-skip-probe",
          outcome: "NO_MATCH",
          observedAt: new Date("2026-07-15T20:06:00.000Z"),
          runtimeVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          providerExecution: false
        },
        course: runnableCourse
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("rejects a manual snapshot without current source-backed discovery", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        course: {
          ...runnableCourse,
          bookingMethod: "PHONE_ONLY",
          automationReason: "NO_ONLINE_BOOKING"
        }
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("accepts a current source-backed manual disposition", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T19:45:00.000Z"),
        course: {
          ...runnableCourse,
          bookingMethod: "PHONE_ONLY",
          automationEligibility: "BLOCKED",
          automationReason: "NO_ONLINE_BOOKING",
          latestDiscovery: {
            status: "VERIFIED",
            bookingMethod: "PHONE_ONLY",
            automationEligibility: "BLOCKED",
            automationReason: "NO_ONLINE_BOOKING",
            sourceUrl: "https://course.example/official-booking",
            bookingUrl: null,
            confidence: 0.9,
            createdAt: new Date("2026-07-15T19:30:00.000Z")
          }
        }
      }).result
    ).toBe("FINAL_DISPOSITION");
  });

  it("accepts current exact browser-verified private identity evidence", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T19:45:00.000Z"),
        now,
        course: browserPrivateCourse()
      })
    ).toMatchObject({
      result: "FINAL_DISPOSITION",
      proofSnapshot: {
        kind: "BROWSER_PRIVATE_IDENTITY",
        disposition: "VERIFIED_PRIVATE",
        provenance: "official-private-course-profile",
        discoveryApiMetadata: null
      }
    });
  });

  it("accepts replayed private identity evidence when discovery is recorded after the course update", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        now,
        course: browserPrivateCourse({
          intelligenceVerifiedAt: new Date("2026-07-15T19:30:00.000Z"),
          discoveryCreatedAt: new Date("2026-07-15T19:31:00.000Z")
        })
      }).result
    ).toBe("FINAL_DISPOSITION");
  });

  it("rejects forged browser-private provenance as a batch final", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        now,
        course: browserPrivateCourse({
          provenance: "official-private-course-profile:untrusted-marker"
        })
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("requires an explicit persisted private identity for a batch final", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        now,
        course: { ...browserPrivateCourse(), isPublic: undefined }
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it.each([
    { field: "booking phone", value: { bookingPhone: "555-0100" } },
    {
      field: "API endpoint",
      value: { apiEndpoint: "https://course.example/api/tee-times" }
    },
    {
      field: "API metadata",
      value: { apiMetadata: { provider: "unexpected" } }
    }
  ])("rejects browser-private evidence with forged $field metadata", ({ value }) => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        now,
        course: browserPrivateCourse(value)
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("rejects browser-private evidence timestamped beyond the clock-skew allowance", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        now,
        course: browserPrivateCourse({
          intelligenceVerifiedAt: new Date("2026-07-15T20:01:01.000Z"),
          discoveryCreatedAt: new Date("2026-07-15T20:01:01.000Z")
        })
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it.each([
    {
      label: "the current course method is unknown",
      courseMethod: "UNKNOWN" as const,
      courseEligibility: "BLOCKED" as const,
      discoveryMethod: "UNKNOWN" as const,
      discoveryEligibility: "BLOCKED" as const,
      discoveryStatus: "VERIFIED"
    },
    {
      label: "the current course is not blocked",
      courseMethod: "PHONE_ONLY" as const,
      courseEligibility: "ALLOWED" as const,
      discoveryMethod: "PHONE_ONLY" as const,
      discoveryEligibility: "BLOCKED" as const,
      discoveryStatus: "VERIFIED"
    },
    {
      label: "the discovery is not blocked",
      courseMethod: "CONTACT_COURSE" as const,
      courseEligibility: "BLOCKED" as const,
      discoveryMethod: "CONTACT_COURSE" as const,
      discoveryEligibility: "ALLOWED" as const,
      discoveryStatus: "VERIFIED"
    },
    {
      label: "the discovery is learned but not verified",
      courseMethod: "WALK_IN" as const,
      courseEligibility: "BLOCKED" as const,
      discoveryMethod: "WALK_IN" as const,
      discoveryEligibility: "BLOCKED" as const,
      discoveryStatus: "LEARNED"
    }
  ])("rejects a manual final when $label", (scenario) => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T19:45:00.000Z"),
        course: {
          ...runnableCourse,
          bookingMethod: scenario.courseMethod,
          automationEligibility: scenario.courseEligibility,
          automationReason: "NO_ONLINE_BOOKING",
          latestDiscovery: {
            status: scenario.discoveryStatus,
            bookingMethod: scenario.discoveryMethod,
            automationEligibility: scenario.discoveryEligibility,
            automationReason: "NO_ONLINE_BOOKING",
            sourceUrl: "https://course.example/official-booking",
            bookingUrl: null,
            confidence: 0.9,
            createdAt: new Date("2026-07-15T19:30:00.000Z")
          }
        }
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("accepts a current technical access barrier as a terminal disposition", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T19:45:00.000Z"),
        course: {
          ...runnableCourse,
          automationEligibility: "BLOCKED",
          automationReason: "ACCOUNT_REQUIRED",
          latestDiscovery: {
            status: "BLOCKED",
            bookingMethod: "PUBLIC_ONLINE",
            automationEligibility: "BLOCKED",
            automationReason: "ACCOUNT_REQUIRED",
            sourceUrl: "https://course.example/official-booking",
            bookingUrl: "https://course.example/official-booking",
            confidence: 0.9,
            createdAt: new Date("2026-07-15T18:30:00.000Z")
          }
        }
      }).result
    ).toBe("FINAL_DISPOSITION");
  });

  it("keeps a current source-backed prohibited-automation disposition actionable", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T19:45:00.000Z"),
        course: {
          ...runnableCourse,
          automationEligibility: "BLOCKED",
          automationReason: "AUTOMATION_PROHIBITED",
          latestDiscovery: {
            status: "BLOCKED",
            bookingMethod: "PUBLIC_ONLINE",
            automationEligibility: "BLOCKED",
            automationReason: "AUTOMATION_PROHIBITED",
            sourceUrl: "https://course.example/official-booking",
            bookingUrl: "https://course.example/official-booking",
            confidence: 0.9,
            createdAt: new Date("2026-07-15T18:30:00.000Z")
          }
        }
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("accepts a current exact-place non-course disposition after course reconciliation", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T19:45:00.000Z"),
        course: {
          ...runnableCourse,
          isPublic: false,
          automationEligibility: "BLOCKED",
          automationReason: "OTHER",
          latestPlaceReview: {
            active: true,
            accessOverride: "VERIFIED_NON_COURSE",
            classification: "PRIVATE_PRACTICE_GREEN",
            evidenceUrl: "https://course.example/",
            reviewedAt: new Date("2026-07-15T00:00:00.000Z"),
            updatedAt: new Date("2026-07-15T19:30:00.000Z")
          }
        }
      })
    ).toMatchObject({
      result: "FINAL_DISPOSITION",
      proofSnapshot: {
        kind: "EXACT_PLACE_REVIEW",
        disposition: "VERIFIED_NON_COURSE"
      }
    });
  });

  it.each([
    {
      label: "the exact review predates the incident cycle",
      isPublic: false,
      automationEligibility: "BLOCKED" as const,
      automationReason: "OTHER" as const,
      active: true,
      updatedAt: new Date("2026-07-15T18:30:00.000Z")
    },
    {
      label: "the reconciled course state is still public",
      isPublic: true,
      automationEligibility: "BLOCKED" as const,
      automationReason: "OTHER" as const,
      active: true,
      updatedAt: new Date("2026-07-15T19:30:00.000Z")
    },
    {
      label: "the exact review is inactive",
      isPublic: false,
      automationEligibility: "BLOCKED" as const,
      automationReason: "OTHER" as const,
      active: false,
      updatedAt: new Date("2026-07-15T19:30:00.000Z")
    }
  ])("rejects an exact-place disposition when $label", (scenario) => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T19:00:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T19:45:00.000Z"),
        course: {
          ...runnableCourse,
          isPublic: scenario.isPublic,
          automationEligibility: scenario.automationEligibility,
          automationReason: scenario.automationReason,
          latestPlaceReview: {
            active: scenario.active,
            accessOverride: "VERIFIED_NON_COURSE",
            classification: "PRIVATE_PRACTICE_GREEN",
            evidenceUrl: "https://course.example/",
            reviewedAt: new Date("2026-07-15T00:00:00.000Z"),
            updatedAt: scenario.updatedAt
          }
        }
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("accepts a fresh reconciled exact-place review as durable terminal proof", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: {
            kind: "EXACT_PLACE_REVIEW",
            disposition: "VERIFIED_NON_COURSE",
            classification: "PRIVATE_PRACTICE_GREEN",
            evidenceOrigin: "https://course.example",
            reviewedAt: "2026-07-15T00:00:00.000Z",
            reviewUpdatedAt: "2026-07-15T19:30:00.000Z",
            automationEligibility: "BLOCKED",
            automationReason: "OTHER"
          },
          verifiedAt: new Date("2026-07-15T20:00:00.000Z"),
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:00:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(true);
  });

  it("rejects exact-place terminal proof older than the incident cycle", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: {
            kind: "EXACT_PLACE_REVIEW",
            disposition: "VERIFIED_PRIVATE",
            classification: "PRIVATE_MEMBER_AMENITY",
            evidenceOrigin: "https://course.example",
            reviewedAt: "2026-07-15T00:00:00.000Z",
            reviewUpdatedAt: "2026-07-15T18:30:00.000Z",
            automationEligibility: "BLOCKED",
            automationReason: "OTHER"
          },
          verifiedAt: new Date("2026-07-15T20:00:00.000Z"),
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:00:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T19:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(false);
  });

  it("accepts strict browser-private identity evidence as durable terminal proof", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: browserPrivateProof,
          verifiedAt: now,
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:45:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(true);
  });

  it("keeps replay-ordered browser-private identity evidence durable", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: {
            ...browserPrivateProof,
            discoveryCreatedAt: "2026-07-15T19:31:00.000Z",
            intelligenceVerifiedAt: "2026-07-15T19:30:00.000Z"
          },
          verifiedAt: now,
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:45:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(true);
  });

  it.each([
    {
      label: "provider metadata",
      proof: {
        ...browserPrivateProof,
        discoveryApiMetadata: { provider: "unexpected" }
      }
    },
    {
      label: "a future evidence timestamp",
      proof: {
        ...browserPrivateProof,
        discoveryCreatedAt: "2026-07-15T20:01:01.000Z",
        intelligenceVerifiedAt: "2026-07-15T20:01:01.000Z"
      }
    },
    {
      label: "evidence timestamps more than five minutes apart",
      proof: {
        ...browserPrivateProof,
        intelligenceVerifiedAt: "2026-07-15T19:36:01.000Z"
      }
    },
    {
      label: "forged provenance",
      proof: {
        ...browserPrivateProof,
        provenance: "official-private-course-profile:forged"
      }
    },
    {
      label: "tampered course eligibility",
      proof: {
        ...browserPrivateProof,
        courseAutomationEligibility: "ALLOWED"
      }
    },
    {
      label: "tampered policy notes",
      proof: {
        ...browserPrivateProof,
        policyNotes: "Private according to an unverified source."
      }
    }
  ])("rejects durable browser-private proof with $label", ({ proof }) => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: proof,
          verifiedAt: now,
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:45:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(false);
  });

  it("keeps a source-backed terminal disposition durable across repeated identical failures", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: {
            kind: "FINAL_DISPOSITION",
            disposition: "MANUAL_DIRECT",
            evidenceOrigin: "https://course.example",
            discoveryCreatedAt: "2026-07-15T18:30:00.000Z",
            confidence: 0.9,
            discoveryStatus: "VERIFIED",
            bookingMethod: "PHONE_ONLY",
            automationEligibility: "BLOCKED",
            automationReason: "NO_ONLINE_BOOKING",
            discoveryBookingMethod: "PHONE_ONLY",
            discoveryAutomationEligibility: "BLOCKED",
            discoveryAutomationReason: "NO_ONLINE_BOOKING"
          },
          verifiedAt: new Date("2026-07-15T20:00:00.000Z"),
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:45:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(true);
  });

  it("rejects legacy manual proof without coherent course and discovery fields", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: {
            kind: "FINAL_DISPOSITION",
            disposition: "MANUAL_DIRECT",
            evidenceOrigin: "https://course.example",
            discoveryCreatedAt: "2026-07-15T18:30:00.000Z",
            confidence: 0.9
          },
          verifiedAt: new Date("2026-07-15T20:00:00.000Z"),
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:45:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(false);
  });

  it("rejects a legacy policy-only terminal proof", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: {
            kind: "FINAL_DISPOSITION",
            disposition: "AUTOMATION_PROHIBITED",
            evidenceOrigin: "https://course.example",
            discoveryCreatedAt: "2026-07-15T19:30:00.000Z",
            confidence: 0.99
          },
          verifiedAt: new Date("2026-07-15T20:00:00.000Z"),
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:45:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T19:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T19:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(false);
  });

  it("still requires restored monitoring to supersede the newest failure", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "RESTORED",
          proofSnapshot: {
            kind: "PROVIDER_PROBE",
            outcome: "NO_MATCH",
            observedAt: "2026-07-15T20:06:00.000Z",
            freshSearchCheckedAt: "2026-07-15T20:06:00.000Z",
            runtimeVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            providerExecution: true
          },
          verifiedAt: new Date("2026-07-15T20:07:00.000Z"),
          verifiedIncidentUpdatedAt: new Date("2026-07-15T20:06:30.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T20:06:30.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T20:00:00.000Z"),
          releaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          deployedAt: new Date("2026-07-15T20:05:00.000Z"),
          recheckDispatchStartedAt: new Date("2026-07-15T20:05:30.000Z")
        }
      )
    ).toBe(false);
  });

  it("accepts durable no-email provider proof after deployment and dispatch", () => {
    const releaseSha = "a".repeat(40);
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "RESTORED",
          proofSnapshot: {
            kind: "PROVIDER_VERIFICATION",
            outcome: "NO_MATCH",
            observedAt: "2026-07-15T20:06:00.000Z",
            completedAt: "2026-07-15T20:06:30.000Z",
            runtimeVersion: releaseSha,
            providerExecution: true,
            providerSnapshotFingerprint: "b".repeat(64)
          },
          verifiedAt: new Date("2026-07-15T20:07:00.000Z"),
          verifiedIncidentUpdatedAt: new Date("2026-07-15T20:04:00.000Z"),
          currentProviderSnapshotFingerprint: "b".repeat(64),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T20:04:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T20:00:00.000Z"),
          releaseSha,
          deployedAt: new Date("2026-07-15T20:05:00.000Z"),
          recheckDispatchStartedAt: new Date("2026-07-15T20:05:30.000Z")
        }
      )
    ).toBe(true);
  });

  it("rejects contradictory online metadata for a no-online-booking disposition", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentLastSeenAt: new Date("2026-07-15T19:00:00.000Z"),
        course: {
          ...runnableCourse,
          bookingMethod: "PUBLIC_ONLINE",
          automationEligibility: "BLOCKED",
          automationReason: "NO_ONLINE_BOOKING",
          latestDiscovery: {
            status: "VERIFIED",
            bookingMethod: "PUBLIC_ONLINE",
            automationEligibility: "BLOCKED",
            automationReason: "NO_ONLINE_BOOKING",
            sourceUrl: "https://course.example/official-booking",
            bookingUrl: "https://course.example/official-booking",
            confidence: 0.9,
            createdAt: new Date("2026-07-15T19:30:00.000Z")
          }
        }
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("dispatches rechecks only on the first persisted release transition", () => {
    const releaseSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const deployedAt = new Date("2026-07-15T20:05:00.000Z");
    expect(
      shouldDispatchRemediatedCourseRechecks({
        persistedReleaseSha: releaseSha,
        persistedDeployedAt: null,
        nextReleaseSha: null,
        nextDeployedAt: deployedAt
      })
    ).toBe(true);
    expect(
      shouldDispatchRemediatedCourseRechecks({
        persistedReleaseSha: null,
        persistedDeployedAt: null,
        nextReleaseSha: releaseSha,
        nextDeployedAt: deployedAt
      })
    ).toBe(true);
    expect(
      shouldDispatchRemediatedCourseRechecks({
        persistedReleaseSha: releaseSha,
        persistedDeployedAt: deployedAt,
        nextReleaseSha: releaseSha,
        nextDeployedAt: deployedAt
      })
    ).toBe(false);
    expect(
      shouldDispatchRemediatedCourseRechecks({
        persistedReleaseSha: null,
        persistedDeployedAt: null,
        nextReleaseSha: releaseSha,
        nextDeployedAt: null
      })
    ).toBe(false);
  });

  it("preserves an explicit real-demand human escalation across verification", () => {
    expect(
      preserveExplicitHumanVerification({
        result: "NEEDS_HUMAN",
        engineeringOnly: false,
        message: "Provider approval is required."
      })
    ).toMatchObject({
      result: "NEEDS_HUMAN",
      message: "Provider approval is required."
    });
    expect(
      preserveExplicitHumanVerification({
        result: "NEEDS_HUMAN",
        engineeringOnly: true,
        message: "Must remain autonomous."
      })
    ).toBeNull();
  });
});

describe("search-specific remediation proof", () => {
  const releaseSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const deployedAt = new Date("2026-07-15T20:05:00.000Z");
  const dispatchedAt = new Date("2026-07-15T20:10:00.000Z");
  const checkedAt = new Date("2026-07-15T20:11:00.000Z");

  function searchEvidence(
    outcome: "MATCH_FOUND" | "NO_MATCH" | "FETCH_FAILED",
    overrides: Record<string, unknown> = {}
  ) {
    return {
      status: "ACTIVE",
      scheduleVersion: 2,
      dispatchedScheduleVersion: 2,
      lastCheckedAt: checkedAt,
      trafficClass: "PUBLIC",
      courseIds: ["course-1"],
      probes: [
        {
          id: `probe-${outcome.toLowerCase()}`,
          courseId: "course-1",
          outcome,
          observedAt: checkedAt,
          runtimeVersion: releaseSha,
          providerExecution: true
        }
      ],
      ...overrides
    };
  }

  it("does not let one search's success hide another affected search's failure", () => {
    const proof = collectFreshRemediatedCourseProof({
      searches: [searchEvidence("NO_MATCH"), searchEvidence("FETCH_FAILED")],
      courseIds: ["course-1"],
      releaseSha,
      deployedAt,
      dispatchedAt
    });

    expect(proof.freshProviderProofByCourse.has("course-1")).toBe(false);
    expect(proof.affectedCourseSearchPairCountByCourse.get("course-1")).toBe(2);
    expect(proof.healthyCourseSearchPairCountByCourse.get("course-1")).toBe(1);
  });

  it("requires the claimed runtime and fresh checks for every affected search", () => {
    const proof = collectFreshRemediatedCourseProof({
      searches: [
        searchEvidence("NO_MATCH"),
        searchEvidence("MATCH_FOUND", {
          probes: [
            {
              id: "wrong-runtime",
              courseId: "course-1",
              outcome: "MATCH_FOUND",
              observedAt: checkedAt,
              runtimeVersion: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              providerExecution: true
            }
          ]
        })
      ],
      courseIds: ["course-1"],
      releaseSha,
      deployedAt,
      dispatchedAt
    });

    expect(proof.freshProviderProofByCourse.has("course-1")).toBe(false);
  });

  it("does not use a successful probe from another course as remediation proof", () => {
    const proof = collectFreshRemediatedCourseProof({
      searches: [
        searchEvidence("NO_MATCH", {
          probes: [
            {
              id: "unrelated-course-probe",
              courseId: "course-2",
              outcome: "NO_MATCH",
              observedAt: checkedAt,
              runtimeVersion: releaseSha,
              providerExecution: true
            }
          ]
        })
      ],
      courseIds: ["course-1"],
      releaseSha,
      deployedAt,
      dispatchedAt
    });

    expect(proof.freshProviderProofByCourse.has("course-1")).toBe(false);
  });

  it("accepts a course only after every active affected search has runnable proof", () => {
    const proof = collectFreshRemediatedCourseProof({
      searches: [searchEvidence("NO_MATCH"), searchEvidence("MATCH_FOUND")],
      courseIds: ["course-1"],
      releaseSha,
      deployedAt,
      dispatchedAt
    });

    expect(proof.freshProviderProofByCourse.get("course-1")).toMatchObject({
      runtimeVersion: releaseSha,
      providerExecution: true,
      freshSearchCheckedAt: checkedAt
    });
    expect(proof.healthyCourseSearchPairCountByCourse.get("course-1")).toBe(2);
  });
});

describe("remediated scheduler health", () => {
  const dispatchedAt = new Date("2026-07-15T20:00:00.000Z");
  const observedAt = new Date("2026-07-15T20:30:00.000Z");

  it("requires a WAITING scheduler to retain a non-overdue next wake", () => {
    expect(
      isRemediatedSearchSchedulerHealthy(
        {
          status: "ACTIVE",
          workflowRunId: "workflow-1",
          checkStatus: "WAITING",
          checkLeaseExpiresAt: null,
          nextCheckAt: null,
          updatedAt: observedAt
        },
        dispatchedAt,
        observedAt
      )
    ).toBe(false);
    expect(
      isRemediatedSearchSchedulerHealthy(
        {
          status: "ACTIVE",
          workflowRunId: "workflow-1",
          checkStatus: "WAITING",
          checkLeaseExpiresAt: null,
          nextCheckAt: new Date("2026-07-15T20:14:59.000Z"),
          updatedAt: observedAt
        },
        dispatchedAt,
        observedAt
      )
    ).toBe(false);
  });

  it("rejects queued, failed, and stale checking states", () => {
    for (const checkStatus of ["QUEUED", "FAILED"]) {
      expect(
        isRemediatedSearchSchedulerHealthy(
          {
            status: "ACTIVE",
            workflowRunId: "workflow-1",
            checkStatus,
            checkLeaseExpiresAt: null,
            nextCheckAt: observedAt,
            updatedAt: observedAt
          },
          dispatchedAt,
          observedAt
        )
      ).toBe(false);
    }
    expect(
      isRemediatedSearchSchedulerHealthy(
        {
          status: "ACTIVE",
          workflowRunId: "workflow-1",
          checkStatus: "CHECKING",
          checkLeaseExpiresAt: new Date("2026-07-15T20:31:00.000Z"),
          nextCheckAt: observedAt,
          updatedAt: new Date("2026-07-15T20:14:59.000Z")
        },
        dispatchedAt,
        observedAt
      )
    ).toBe(false);
  });
});

describe("course-support recovery", () => {
  it("allows a clean expired batch to move to a new task", () => {
    expect(
      assessCourseSupportRecovery({
        leaseExpiresAt: new Date("2026-07-15T19:00:00.000Z"),
        ownerThreadId: "old-thread",
        requestingThreadId: "new-thread",
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        releaseSha: null,
        expectedBranch: "automation/course-support-20260715-190000",
        currentBranch: "automation/course-support-20260715-190000",
        currentHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        plannedPaths: [],
        dirtyPaths: [],
        now
      }).action
    ).toBe("RECOVER");
  });

  it("blocks another task from adopting dirty work", () => {
    expect(
      assessCourseSupportRecovery({
        leaseExpiresAt: new Date("2026-07-15T19:00:00.000Z"),
        ownerThreadId: "old-thread",
        requestingThreadId: "new-thread",
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        releaseSha: null,
        expectedBranch: "automation/course-support-20260715-190000",
        currentBranch: "automation/course-support-20260715-190000",
        currentHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        plannedPaths: ["src/lib/provider.ts"],
        dirtyPaths: ["src/lib/provider.ts"],
        now
      }).action
    ).toBe("BLOCK");
  });

  it("recovers a clean committed planned-path change before release heartbeat", () => {
    expect(
      assessCourseSupportRecovery({
        leaseExpiresAt: new Date("2026-07-15T19:00:00.000Z"),
        ownerThreadId: "old-thread",
        requestingThreadId: "new-thread",
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        releaseSha: null,
        expectedBranch: "automation/course-support-20260715-190000",
        currentBranch: "automation/course-support-20260715-190000",
        currentHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        plannedPaths: ["src/lib/provider.ts"],
        committedPaths: ["src/lib/provider.ts"],
        baseIsAncestor: true,
        dirtyPaths: [],
        now
      }).action
    ).toBe("RECOVER");
  });

  it("lets only the same task recover a planned descendant of a persisted release", () => {
    const input = {
      leaseExpiresAt: new Date("2026-07-15T19:00:00.000Z"),
      ownerThreadId: "owner-thread",
      requestingThreadId: "owner-thread",
      baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      releaseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      expectedBranch: "automation/course-support-20260715-190000",
      currentBranch: "automation/course-support-20260715-190000",
      currentHeadSha: "cccccccccccccccccccccccccccccccccccccccc",
      plannedPaths: ["src/lib/provider.ts"],
      committedPaths: ["src/lib/provider.ts"],
      releaseCommittedPaths: ["src/lib/provider.ts"],
      baseIsAncestor: true,
      releaseIsAncestor: true,
      dirtyPaths: [],
      now
    };

    expect(assessCourseSupportRecovery(input).action).toBe("RECOVER");
    expect(
      assessCourseSupportRecovery({
        ...input,
        requestingThreadId: "different-thread"
      }).action
    ).toBe("BLOCK");
    expect(
      assessCourseSupportRecovery({
        ...input,
        releaseIsAncestor: false
      }).action
    ).toBe("BLOCK");
  });

  it("keeps observed Git-path whitespace exact and blocks a lookalike claimed path", () => {
    const observedPaths = normalizeCourseSupportObservedGitPaths([
      " src\\lib\\provider.ts"
    ]);

    expect(observedPaths).toEqual([" src/lib/provider.ts"]);
    expect(
      assessCourseSupportRecovery({
        leaseExpiresAt: new Date("2026-07-15T19:00:00.000Z"),
        ownerThreadId: "owner-thread",
        requestingThreadId: "owner-thread",
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        releaseSha: null,
        expectedBranch: "automation/course-support-20260715-190000",
        currentBranch: "automation/course-support-20260715-190000",
        currentHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        plannedPaths: ["src/lib/provider.ts"],
        committedPaths: observedPaths,
        baseIsAncestor: true,
        dirtyPaths: [],
        now
      }).action
    ).toBe("BLOCK");
  });
});

describe("course-support inspection ownership", () => {
  const inspection = {
    hasActiveBatch: true,
    activeBatchOwnerThreadId: "owner-thread",
    requestingThreadId: "owner-thread",
    hasExpiredBatch: false,
    dueIncidentCount: 4
  };

  it("resumes a healthy batch owned by the requesting task", () => {
    expect(classifyCourseSupportQueueInspection(inspection)).toBe(
      "resume_owned_work"
    );
  });

  it.each([undefined, null, "different-thread"])(
    "defers when the active batch is not proven to belong to the requester (%s)",
    (requestingThreadId) => {
      expect(
        classifyCourseSupportQueueInspection({
          ...inspection,
          requestingThreadId
        })
      ).toBe("deferred_busy");
    }
  );

  it("preserves expired, empty, and ready queue outcomes without an active writer", () => {
    expect(
      classifyCourseSupportQueueInspection({
        ...inspection,
        hasActiveBatch: false,
        hasExpiredBatch: true
      })
    ).toBe("recovery_required");
    expect(
      classifyCourseSupportQueueInspection({
        ...inspection,
        hasActiveBatch: false,
        hasExpiredBatch: false,
        dueIncidentCount: 0
      })
    ).toBe("no_due_work");
    expect(
      classifyCourseSupportQueueInspection({
        ...inspection,
        hasActiveBatch: false,
        hasExpiredBatch: false
      })
    ).toBe("ready");
  });

  it("defers non-customer work outside the bounded engineering sweep", () => {
    expect(
      classifyCourseSupportQueueInspection({
        ...inspection,
        hasActiveBatch: false,
        dueRealCount: 0,
        engineeringSweepDue: false
      })
    ).toBe("deferred_engineering_cadence");
    expect(
      classifyCourseSupportQueueInspection({
        ...inspection,
        hasActiveBatch: false,
        dueRealCount: 1,
        engineeringSweepDue: false
      })
    ).toBe("ready");
    expect(
      nextCourseSupportEngineeringSweepAt(
        new Date("2026-07-22T05:23:45.000Z")
      ).toISOString()
    ).toBe("2026-07-22T06:00:00.000Z");
  });

  it("finalizes only old repeated source gaps without active real demand", () => {
    const evidence = {
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE" as const,
      attemptCount: 4,
      activeRealSearchCount: 0,
      firstSeenAt: new Date("2026-07-20T20:00:00.000Z"),
      verifiedAt: new Date("2026-07-22T20:00:00.000Z"),
      result: "RETRY_SCHEDULED" as const,
      now: new Date("2026-07-22T20:00:00.000Z")
    };
    expect(shouldFinalizeSourceUnverified(evidence)).toBe(true);
    expect(
      shouldFinalizeSourceUnverified({
        ...evidence,
        activeRealSearchCount: 1
      })
    ).toBe(false);
    expect(
      shouldFinalizeSourceUnverified({
        ...evidence,
        attemptCount: 3
      })
    ).toBe(false);
  });

  it("selects the owner internally and resumes only the same task", async () => {
    prismaMocks.batchFindFirst
      .mockResolvedValueOnce({
        id: "batch-1",
        reference: "batch-reference",
        status: "VERIFYING",
        leaseExpiresAt: new Date("2026-07-15T20:15:00.000Z"),
        providerFamilyKey: "CHRONOGOLF",
        ownerThreadId: "owner-thread"
      })
      .mockResolvedValueOnce(null);

    const result = await inspectCourseSupportQueue({
      requestingThreadId: "owner-thread",
      now
    });

    expect(result).toMatchObject({
      outcome: "resume_owned_work",
      ownedByCurrentTask: true,
      durableCloseoutRecorded: false,
      threadDisposition: "KEEP_VISIBLE"
    });
    expect(prismaMocks.batchFindFirst.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        select: expect.objectContaining({ ownerThreadId: true })
      })
    );
    expect(prismaMocks.automationRunCreate).not.toHaveBeenCalled();
  });

  it("reports live demand separately from historical real provenance", async () => {
    prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([
      {
        providerFamilyKey: "FOREUP",
        failureFingerprint: "historical",
        engineeringOnly: false,
        course: { timeZone: "America/New_York", preferences: [] }
      },
      {
        providerFamilyKey: "FOREUP",
        failureFingerprint: "live",
        engineeringOnly: true,
        course: {
          timeZone: "America/New_York",
          preferences: [
            {
              teeSearch: {
                id: "search-live",
                date: new Date("2026-07-18T00:00:00.000Z")
              }
            }
          ]
        }
      },
      {
        providerFamilyKey: "CPS",
        failureFingerprint: "synthetic",
        engineeringOnly: true,
        course: { timeZone: "America/New_York", preferences: [] }
      }
    ]);
    prismaMocks.batchFindFirst.mockResolvedValue(null);

    await expect(inspectCourseSupportQueue({ now })).resolves.toMatchObject({
      outcome: "ready",
      dueIncidentCount: 3,
      dueRealCount: 1,
      dueHistoricalRealCount: 1,
      dueEngineeringCount: 1,
      providerGroupCount: 3
    });
    expect(prismaMocks.supportIncidentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          course: expect.objectContaining({ select: expect.any(Object) })
        })
      })
    );
  });

  it("resumes owned responder work without consulting the hourly lane", async () => {
    prismaMocks.batchFindFirst
      .mockResolvedValueOnce({
        id: "batch-1",
        reference: "batch-reference",
        status: "VERIFYING",
        leaseExpiresAt: new Date("2026-07-15T20:15:00.000Z"),
        providerFamilyKey: "CHRONOGOLF",
        ownerThreadId: "owner-thread"
      })
      .mockResolvedValueOnce(null);
    const result = await inspectCourseSupportQueue({
      requestingThreadId: "owner-thread",
      now
    });

    expect(result).toMatchObject({
      outcome: "resume_owned_work",
      ownedByCurrentTask: true,
      durableCloseoutRecorded: false,
      threadDisposition: "KEEP_VISIBLE"
    });
    expect(prismaMocks.automationRunFindFirst).not.toHaveBeenCalled();
    expect(prismaMocks.automationRunCreate).not.toHaveBeenCalled();
  });

  it.each([undefined, "different-thread"])(
    "keeps inspect fail-closed for an unproven requester (%s)",
    async (requestingThreadId) => {
      prismaMocks.batchFindFirst
        .mockResolvedValueOnce({
          id: "batch-1",
          reference: "batch-reference",
          status: "VERIFYING",
          leaseExpiresAt: new Date("2026-07-15T20:15:00.000Z"),
          providerFamilyKey: "CHRONOGOLF",
          ownerThreadId: "owner-thread"
        })
        .mockResolvedValueOnce(null);

      const result = await inspectCourseSupportQueue({
        requestingThreadId,
        now
      });

      expect(result).toMatchObject({
        outcome: "deferred_busy",
        ownedByCurrentTask: false,
        durableCloseoutRecorded: true,
        threadDisposition: "ARCHIVE"
      });
      expect(prismaMocks.automationRunCreate).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects a blank requester identity before reading queue state", async () => {
    await expect(
      inspectCourseSupportQueue({ requestingThreadId: " ", now })
    ).rejects.toThrow("current task id");
    expect(prismaMocks.batchFindFirst).not.toHaveBeenCalled();
  });
});

describe("course-support batch ordinals", () => {
  it("uses course name before creation time and id for stable packet/history ordinals", () => {
    const entries = [
      {
        id: "entry-1",
        createdAt: new Date("2026-07-15T18:00:00.000Z"),
        course: { name: "Zulu Course" }
      },
      {
        id: "entry-3",
        createdAt: new Date("2026-07-15T19:00:00.000Z"),
        course: { name: "Alpha Course" }
      },
      {
        id: "entry-2",
        createdAt: new Date("2026-07-15T19:00:00.000Z"),
        course: { name: "Alpha Course" }
      }
    ];

    expect(orderCourseSupportBatchIncidents(entries).map((entry) => entry.id)).toEqual([
      "entry-2",
      "entry-3",
      "entry-1"
    ]);
  });
});

describe("course-support follow-up releases", () => {
  const previousReleaseSha = "a".repeat(40);
  const nextReleaseSha = "b".repeat(40);
  const branch = "automation/course-support-20260715-190000";

  it("accepts a nonempty same-branch descendant containing only planned paths", () => {
    expect(
      assessCourseSupportReleaseTransition({
        persistedReleaseSha: previousReleaseSha,
        requestedReleaseSha: nextReleaseSha,
        expectedBranch: branch,
        plannedPaths: ["src/lib/provider.ts"],
        advanceProof: {
          fromSha: previousReleaseSha,
          toSha: nextReleaseSha,
          branch,
          committedPaths: ["src/lib/provider.ts"],
          descendantVerified: true
        }
      })
    ).toEqual({ action: "ADVANCE", reasons: [] });
  });

  it.each([
    {
      label: "mismatched target SHA",
      advanceProof: {
        fromSha: previousReleaseSha,
        toSha: "c".repeat(40),
        branch,
        committedPaths: ["src/lib/provider.ts"],
        descendantVerified: true
      }
    },
    {
      label: "sibling release",
      advanceProof: {
        fromSha: previousReleaseSha,
        toSha: nextReleaseSha,
        branch,
        committedPaths: ["src/lib/provider.ts"],
        descendantVerified: false
      }
    },
    {
      label: "wrong branch",
      advanceProof: {
        fromSha: previousReleaseSha,
        toSha: nextReleaseSha,
        branch: "automation/course-support-other",
        committedPaths: ["src/lib/provider.ts"],
        descendantVerified: true
      }
    },
    {
      label: "empty delta",
      advanceProof: {
        fromSha: previousReleaseSha,
        toSha: nextReleaseSha,
        branch,
        committedPaths: [],
        descendantVerified: true
      }
    },
    {
      label: "unplanned path",
      advanceProof: {
        fromSha: previousReleaseSha,
        toSha: nextReleaseSha,
        branch,
        committedPaths: ["src/lib/unplanned.ts"],
        descendantVerified: true
      }
    },
    {
      label: "whitespace lookalike path",
      advanceProof: {
        fromSha: previousReleaseSha,
        toSha: nextReleaseSha,
        branch,
        committedPaths: [" src/lib/provider.ts"],
        descendantVerified: true
      }
    }
  ])("rejects a $label", ({ advanceProof }) => {
    expect(
      assessCourseSupportReleaseTransition({
        persistedReleaseSha: previousReleaseSha,
        requestedReleaseSha: nextReleaseSha,
        expectedBranch: branch,
        plannedPaths: ["src/lib/provider.ts"],
        advanceProof
      }).action
    ).toBe("REJECT");
  });

  it("archives prior deployment and verification evidence without duplicating unchanged releases", () => {
    expect(
      assessCourseSupportReleaseTransition({
        persistedReleaseSha: previousReleaseSha,
        requestedReleaseSha: previousReleaseSha,
        expectedBranch: branch,
        plannedPaths: []
      }).action
    ).toBe("UNCHANGED");

    const summary = buildCourseSupportReleaseHistory({
      summary: {
        branch,
        plannedPaths: ["src/lib/provider.ts"],
        recheckDispatch: { attempted: true }
      },
      previousReleaseSha,
      previousDeployedAt: new Date("2026-07-15T20:05:00.000Z"),
      previousRecheckDispatchKey: "dispatch-key",
      previousRecheckDispatchStartedAt: new Date("2026-07-15T20:06:00.000Z"),
      previousRecheckDispatchedAt: new Date("2026-07-15T20:07:00.000Z"),
      previousIncidentVerifications: [
        {
          ordinal: 1,
          result: "FINAL_DISPOSITION",
          message: "Reviewed final disposition.",
          proofSnapshot: { kind: "EXACT_PLACE_REVIEW" },
          verifiedIncidentUpdatedAt: new Date("2026-07-15T20:04:00.000Z"),
          verifiedAt: new Date("2026-07-15T20:08:00.000Z")
        }
      ],
      nextReleaseSha,
      advancedAt: new Date("2026-07-15T20:10:00.000Z")
    }) as Record<string, unknown>;

    expect(summary.recheckDispatch).toBeNull();
    expect(summary.releaseHistory).toEqual([
      expect.objectContaining({
        releaseSha: previousReleaseSha,
        deployedAt: "2026-07-15T20:05:00.000Z",
        supersededBy: nextReleaseSha,
        supersededAt: "2026-07-15T20:10:00.000Z",
        incidentVerifications: [
          expect.objectContaining({
            ordinal: 1,
            result: "FINAL_DISPOSITION"
          })
        ]
      })
    ]);
  });
});

describe("course-support release heartbeat persistence", () => {
  const previousReleaseSha = "a".repeat(40);
  const nextReleaseSha = "b".repeat(40);
  const branch = "automation/course-support-20260715-190000";
  const deployedAt = new Date("2026-07-15T20:05:00.000Z");

  function ownedBatch() {
    return {
      status: "VERIFYING",
      revision: 7,
      releaseSha: previousReleaseSha,
      deployedAt,
      recheckDispatchKey: "dispatch-key",
      recheckDispatchStartedAt: new Date("2026-07-15T20:06:00.000Z"),
      recheckDispatchedAt: new Date("2026-07-15T20:07:00.000Z"),
      summary: {
        branch,
        plannedPaths: ["src/lib/provider.ts"],
        recheckDispatch: { attempted: true }
      },
      incidents: [
        {
          id: "entry-zulu",
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          course: { name: "Zulu Course" },
          result: "NEEDS_HUMAN",
          message: "Owner action is still required.",
          proofSnapshot: { kind: "HUMAN_ACTION" },
          verifiedIncidentUpdatedAt: new Date("2026-07-15T20:03:00.000Z"),
          verifiedAt: new Date("2026-07-15T20:08:00.000Z")
        },
        {
          id: "entry-alpha",
          createdAt: new Date("2026-07-15T19:00:00.000Z"),
          course: { name: "Alpha Course" },
          result: "FINAL_DISPOSITION",
          message: "Reviewed final disposition.",
          proofSnapshot: { kind: "EXACT_PLACE_REVIEW" },
          verifiedIncidentUpdatedAt: new Date("2026-07-15T20:04:00.000Z"),
          verifiedAt: new Date("2026-07-15T20:09:00.000Z")
        }
      ]
    };
  }

  const advanceProof = {
    fromSha: previousReleaseSha,
    toSha: nextReleaseSha,
    branch,
    committedPaths: ["src/lib/provider.ts"],
    descendantVerified: true
  };

  it("advances with owner/CAS fences, archives stable ordinals, and resets only machine proof", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(ownedBatch());
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });

    const result = await heartbeatCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      status: "VERIFYING",
      releaseSha: nextReleaseSha,
      releaseAdvanceProof: advanceProof,
      now
    });

    expect(result).toMatchObject({
      outcome: "ready",
      releaseSha: nextReleaseSha,
      releaseAdvanced: true
    });
    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "batch-1",
          leaseToken: "lease-1",
          ownerThreadId: "owner-thread",
          status: "VERIFYING",
          revision: 7,
          releaseSha: previousReleaseSha,
          deployedAt
        }),
        data: expect.objectContaining({
          status: "VERIFYING",
          releaseSha: nextReleaseSha,
          deployedAt: null,
          recheckDispatchKey: null,
          recheckDispatchStartedAt: null,
          recheckDispatchedAt: null
        })
      })
    );
    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith({
      where: {
        batchId: "batch-1",
        result: { not: "NEEDS_HUMAN" }
      },
      data: {
        result: "PENDING",
        postProbeId: null,
        message: null,
        proofSnapshot: expect.anything(),
        verifiedIncidentUpdatedAt: null,
        verifiedAt: null
      }
    });

    const updateInput = prismaMocks.batchUpdateMany.mock.calls[0]?.[0] as {
      data: { summary: { releaseHistory: Array<Record<string, unknown>> } };
    };
    expect(
      updateInput.data.summary.releaseHistory[0]?.incidentVerifications
    ).toEqual([
      expect.objectContaining({ ordinal: 1, result: "FINAL_DISPOSITION" }),
      expect.objectContaining({ ordinal: 2, result: "NEEDS_HUMAN" })
    ]);
  });

  it("requires an explicit VERIFYING transition before advancing", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(ownedBatch());

    await expect(
      heartbeatCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        status: "IMPLEMENTING",
        releaseSha: nextReleaseSha,
        releaseAdvanceProof: advanceProof,
        now
      })
    ).rejects.toThrow("explicitly enter VERIFYING");
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
  });

  it("does not reset incident proof when the batch compare-and-set loses", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(ownedBatch());
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 0 });

    const result = await heartbeatCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      status: "VERIFYING",
      releaseSha: nextReleaseSha,
      releaseAdvanceProof: advanceProof,
      now
    });

    expect(result).toMatchObject({
      outcome: "recovery_required",
      releaseAdvanced: false
    });
    expect(prismaMocks.incidentUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects release verification until deployment proof exists", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      releaseSha: previousReleaseSha,
      deployedAt: null,
      incidents: []
    });

    await expect(
      verifyCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        releaseSha: previousReleaseSha,
        now
      })
    ).rejects.toThrow("requires deployment proof");
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
  });
});

describe("detached verification atomic batch fences", () => {
  const releaseSha = "a".repeat(40);
  const providerFingerprint = "b".repeat(64);
  const observedAt = new Date("2026-07-15T19:56:00.000Z");
  const completedAt = new Date("2026-07-15T19:57:00.000Z");
  const incidentUpdatedAt = new Date("2026-07-15T19:45:00.000Z");

  function providerCourse(
    overrides: Partial<{
      isPublic: boolean;
      bookingMethod: "PUBLIC_ONLINE" | "PHONE_ONLY";
      automationEligibility: "ALLOWED" | "BLOCKED";
      automationReason: "NONE" | "ACCOUNT_REQUIRED" | "NO_ONLINE_BOOKING";
      intelligenceVerifiedAt: Date | null;
      intelligenceReviewAt: Date | null;
      intelligenceConfidence: number | null;
    }> = {}
  ) {
    return {
      timeZone: "America/Los_Angeles",
      isPublic: true,
      website: "https://course.example/",
      detectedBookingUrl: "https://booking.example/tee-times",
      detectedPlatform: "CUSTOM",
      providerFamilyKey: "booking.example",
      bookingMethod: "PUBLIC_ONLINE",
      bookingWindowDaysAhead: 7,
      bookingReleaseTimeLocal: "07:00",
      bookingWindowSource: "COURSE_POLICY",
      bookingWindowEvidenceUrl: "https://course.example/booking-policy",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: { adapter: "example" },
      ...overrides
    };
  }

  function proofEvidence() {
    return {
      schemaVersion: 1,
      kind: "PROVIDER_VERIFICATION",
      releaseSha,
      runtimeVersion: releaseSha,
      providerExecution: true,
      outcome: "NO_MATCH",
      observedAt: observedAt.toISOString(),
      providerSnapshotFingerprint: providerFingerprint
    };
  }

  function eligibleProof() {
    return {
      eligible: true as const,
      releaseSha,
      runtimeVersion: releaseSha,
      outcome: "NO_MATCH" as const,
      providerExecution: true,
      completedAt,
      providerSnapshotFingerprint: providerFingerprint,
      evidence: proofEvidence()
    };
  }

  function atomicRequest(course = providerCourse(), engineeringOnly = true) {
    return {
      courseId: "course-1",
      releaseSha,
      runtimeVersion: releaseSha,
      status: "SUCCEEDED",
      leaseToken: null,
      leaseExpiresAt: null,
      outcome: "NO_MATCH",
      evidence: proofEvidence(),
      providerSnapshotFingerprint: providerFingerprint,
      completedAt,
      batchIncident: {
        id: "entry-1",
        batchId: "batch-1",
        incidentId: "incident-1",
        courseId: "course-1",
        cycle: 1,
        batch: {
          id: "batch-1",
          status: "VERIFYING",
          ownerThreadId: "owner-thread",
          leaseToken: "lease-1",
          leaseExpiresAt: new Date("2026-07-15T21:00:00.000Z"),
          releaseSha,
          completedAt: null
        },
        incident: {
          id: "incident-1",
          cycle: 1,
          status: "AUTO_INVESTIGATING",
          activeBatchId: "batch-1",
          engineeringOnly
        },
        course
      }
    };
  }

  function verificationBatch(engineeringOnly = true) {
    return {
      id: "batch-1",
      status: "VERIFYING",
      revision: 7,
      releaseSha,
      deployedAt: new Date("2026-07-15T19:50:00.000Z"),
      recheckDispatchKey: null,
      recheckDispatchStartedAt: new Date("2026-07-15T19:51:00.000Z"),
      recheckDispatchedAt: null,
      summary: null,
      createdAt: new Date("2026-07-15T18:00:00.000Z"),
      incidents: [
        {
          id: "entry-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          result: "PENDING",
          preProbeId: null,
          postProbeId: null,
          message: null,
          proofSnapshot: null,
          updatedAt: incidentUpdatedAt,
          incident: {
            cycle: 1,
            status: "AUTO_INVESTIGATING",
            engineeringOnly,
            activeBatchId: "batch-1",
            firstSeenAt: new Date("2026-07-15T18:30:00.000Z"),
            lastSeenAt: incidentUpdatedAt,
            updatedAt: incidentUpdatedAt
          },
          course: {
            googlePlaceId: null,
            isPublic: true,
            bookingMethod: "PUBLIC_ONLINE",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            automationDiscoveries: []
          }
        }
      ]
    };
  }

  function healthyDetachedDispatch() {
    return {
      recheckDispatch: {
        attempted: true,
        dispatchError: false,
        detachedVerificationDispatchError: false,
        schedulerHealthComplete: true,
        courseOutcomeHealthComplete: true,
        affectedSearchCount: 0,
        currentAffectedSearchCount: 0,
        queuedCount: 0,
        queueFailureCount: 0,
        directStartCount: 0,
        healthySchedulerCount: 0,
        freshSearchCheckCount: 0,
        restoredCourseCount: 1,
        provenRunnableCourseCount: 1,
        affectedCourseSearchPairCount: 0,
        healthyCourseSearchPairCount: 0,
        schedulerHealthObservedAt: now.toISOString()
      }
    };
  }

  function detachedFailureProof(
    overrides: Partial<{
      status: "RETRYABLE_FAILED" | "STALE";
      nextAttemptAt: string | null;
      providerRetryNotBeforeAt: string | null;
    }> = {}
  ) {
    return {
      kind: "PROVIDER_VERIFICATION_FAILURE",
      status: "RETRYABLE_FAILED" as const,
      outcome: "FETCH_FAILED",
      failureClass: "RATE_LIMIT",
      observedAt: observedAt.toISOString(),
      completedAt: null,
      nextAttemptAt: null,
      providerRetryNotBeforeAt: null,
      runtimeVersion: releaseSha,
      providerExecution: true,
      providerSnapshotFingerprint: providerFingerprint,
      ...overrides
    };
  }

  function detachedRequestState(
    status:
      | "QUEUED"
      | "CHECKING"
      | "SUCCEEDED"
      | "RETRYABLE_FAILED"
      | "STALE",
    overrides: Record<string, unknown> = {}
  ) {
    const failed = status === "RETRYABLE_FAILED" || status === "STALE";
    return {
      batchIncidentId: "entry-1",
      releaseSha,
      runtimeVersion: status === "QUEUED" ? null : releaseSha,
      status,
      outcome: failed
        ? "FETCH_FAILED"
        : status === "SUCCEEDED"
          ? "NO_MATCH"
          : null,
      failureClass: failed ? "RATE_LIMIT" : null,
      evidence: failed
        ? {
            ...proofEvidence(),
            outcome: "FETCH_FAILED",
            failureClass: "RATE_LIMIT",
            providerRetryNotBeforeAt: "2026-07-16T02:00:00.000Z"
          }
        : status === "SUCCEEDED"
          ? proofEvidence()
          : null,
      providerSnapshotFingerprint: providerFingerprint,
      nextAttemptAt:
        status === "RETRYABLE_FAILED"
          ? new Date("2026-07-15T22:00:00.000Z")
          : null,
      completedAt: status === "SUCCEEDED" || status === "STALE" ? completedAt : null,
      ...overrides
    };
  }

  function currentDetachedFailure(
    status: "RETRYABLE_FAILED" | "STALE" = "RETRYABLE_FAILED"
  ) {
    const request = detachedRequestState(status);
    return {
      current: true as const,
      releaseSha,
      runtimeVersion: releaseSha,
      status,
      outcome: "FETCH_FAILED" as const,
      failureClass: "RATE_LIMIT" as const,
      providerExecution: true,
      observedAt,
      completedAt: request.completedAt as Date | null,
      nextAttemptAt: request.nextAttemptAt as Date | null,
      providerRetryNotBeforeAt: new Date("2026-07-16T02:00:00.000Z"),
      providerSnapshotFingerprint: providerFingerprint,
      evidence: request.evidence as Record<string, unknown>
    };
  }

  function closeoutBatch(
    result: "RESTORED" | "RETRY_SCHEDULED" | "NEEDS_HUMAN",
    retryProofSnapshot: Record<string, unknown> | null = null
  ) {
    const proofSnapshot =
      result === "RESTORED"
        ? {
            kind: "PROVIDER_VERIFICATION",
            outcome: "NO_MATCH",
            observedAt: observedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            runtimeVersion: releaseSha,
            providerExecution: true,
            providerSnapshotFingerprint: providerFingerprint
          }
        : retryProofSnapshot;
    return {
      id: "batch-1",
      status: "VERIFYING",
      revision: 8,
      releaseSha,
      deployedAt: new Date("2026-07-15T19:50:00.000Z"),
      recheckDispatchStartedAt: new Date("2026-07-15T19:51:00.000Z"),
      leaseToken: "lease-1",
      leaseExpiresAt: new Date("2026-07-15T21:00:00.000Z"),
      ownerThreadId: "owner-thread",
      ownerAutomationRunId: null,
      summary: healthyDetachedDispatch(),
      createdAt: new Date("2026-07-15T18:00:00.000Z"),
      incidents: [
        {
          id: "entry-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          result,
          message: "Current verification recorded.",
          proofSnapshot,
          verifiedAt: new Date("2026-07-15T19:58:00.000Z"),
          verifiedIncidentUpdatedAt: incidentUpdatedAt,
          updatedAt: new Date("2026-07-15T19:58:00.000Z"),
          course: providerCourse(),
          incident: {
            cycle: 1,
            status: "AUTO_INVESTIGATING",
            engineeringOnly: result === "NEEDS_HUMAN" ? false : true,
            activeBatchId: "batch-1",
            firstSeenAt: new Date("2026-07-15T18:30:00.000Z"),
            lastSeenAt: incidentUpdatedAt,
            updatedAt: incidentUpdatedAt,
            failureClass: "UNSUPPORTED_FAMILY",
            failureFingerprint: "fingerprint",
            attemptCount: 1,
            escalatedAt: null
          }
        }
      ]
    };
  }

  it("atomically stales detached work when human evidence supersedes it", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      status: "VERIFYING",
      revision: 7,
      incidents: [
        {
          id: "entry-1",
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          incidentId: "incident-1",
          cycle: 1,
          updatedAt: incidentUpdatedAt,
          course: { name: "Course One" },
          incident: {
            engineeringOnly: false,
            status: "AUTO_INVESTIGATING",
            activeBatchId: "batch-1",
            updatedAt: incidentUpdatedAt
          }
        }
      ]
    });
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.verificationRequestUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      markCourseSupportBatchNeedsHuman({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        ordinal: 1,
        evidence: "Provider approval is required.",
        nextAction: "Request provider access.",
        now
      })
    ).resolves.toMatchObject({ outcome: "needs_human" });

    expect(prismaMocks.verificationRequestUpdateMany).toHaveBeenCalledWith({
      where: {
        batchIncidentId: "entry-1",
        status: {
          in: ["QUEUED", "CHECKING", "SUCCEEDED", "RETRYABLE_FAILED"]
        }
      },
      data: expect.objectContaining({
        status: "STALE",
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        completedAt: now,
        lastError: "human_verification_superseded"
      })
    });
  });

  it("downgrades detached success when live demand appears before atomic persistence", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(verificationBatch());
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.verificationRequestFindUnique.mockResolvedValue(atomicRequest());
    prismaMocks.teeSearchCount.mockResolvedValue(1);
    verificationMocks.getEligibleCourseSupportVerificationProof.mockResolvedValue(
      eligibleProof()
    );

    await verifyCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      releaseSha,
      now
    });

    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          result: "STALE_EVIDENCE",
          proofSnapshot: expect.anything()
        })
      })
    );
    expect(prismaMocks.teeSearchCount).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        date: { gte: new Date("2026-07-15T00:00:00.000Z") },
        preferences: { some: { courseId: "course-1" } }
      }
    });
    expect(prismaMocks.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "Serializable" }
    );
  });

  it.each([
    ["private identity", providerCourse({ isPublic: false })],
    [
      "current technical gate",
      providerCourse({
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED",
        intelligenceVerifiedAt: new Date("2026-07-15T19:59:00.000Z"),
        intelligenceReviewAt: new Date("2026-07-16T20:00:00.000Z"),
        intelligenceConfidence: 0.95
      })
    ],
    [
      "current manual gate",
      providerCourse({
        bookingMethod: "PHONE_ONLY",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
        intelligenceVerifiedAt: new Date("2026-07-15T19:59:00.000Z"),
        intelligenceReviewAt: new Date("2026-07-16T20:00:00.000Z"),
        intelligenceConfidence: 0.95
      })
    ]
  ])(
    "downgrades detached success when the course changes to a %s before atomic persistence",
    async (_label, currentCourse) => {
      prismaMocks.batchFindFirst.mockResolvedValue(verificationBatch());
      prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
      prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
      prismaMocks.verificationRequestFindUnique.mockResolvedValue(
        atomicRequest(currentCourse)
      );
      verificationMocks.getEligibleCourseSupportVerificationProof.mockResolvedValue(
        eligibleProof()
      );

      await verifyCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        releaseSha,
        now
      });

      expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ result: "STALE_EVIDENCE" })
        })
      );
      expect(prismaMocks.teeSearchCount).not.toHaveBeenCalled();
      expect(
        verificationMocks.buildCourseSupportProviderSnapshotFingerprint
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          isPublic: currentCourse.isPublic,
          intelligenceVerifiedAt: currentCourse.intelligenceVerifiedAt,
          intelligenceReviewAt: currentCourse.intelligenceReviewAt,
          intelligenceConfidence: currentCourse.intelligenceConfidence
        })
      );
    }
  );

  it("persists detached success only after the atomic request and fingerprint pass", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(verificationBatch());
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.verificationRequestFindUnique.mockResolvedValue(atomicRequest());
    verificationMocks.getEligibleCourseSupportVerificationProof.mockResolvedValue(
      eligibleProof()
    );

    await verifyCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      releaseSha,
      now
    });

    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ result: "RESTORED" })
      })
    );
    expect(
      verificationMocks.buildCourseSupportProviderSnapshotFingerprint
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingWindowEvidenceUrl: "https://course.example/booking-policy"
      })
    );
  });

  it("persists detached success for historical real demand after its searches end", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(verificationBatch(false));
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.verificationRequestFindUnique.mockResolvedValue(
      atomicRequest(providerCourse(), false)
    );
    verificationMocks.getEligibleCourseSupportVerificationProof.mockResolvedValue(
      eligibleProof()
    );

    await verifyCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      releaseSha,
      now
    });

    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ result: "RESTORED" })
      })
    );
    expect(prismaMocks.teeSearchCount).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        date: { gte: new Date("2026-07-15T00:00:00.000Z") },
        preferences: { some: { courseId: "course-1" } }
      }
    });
  });

  it("reports aggregate pending detached verification and requires a verify rerun", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(verificationBatch());
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.verificationRequestFindMany.mockResolvedValue([
      detachedRequestState("QUEUED")
    ]);
    verificationMocks.scheduleCourseSupportVerificationRequests.mockResolvedValue({
      createdCount: 1,
      eligibleCount: 1,
      ineligibleCount: 0,
      requests: []
    });

    const result = await verifyCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      releaseSha,
      now
    });

    expect(result).toMatchObject({
      detachedVerification: { pendingCount: 1, rerunNeeded: true },
      recheckDispatch: {
        detachedVerificationPendingCount: 1,
        detachedVerificationRerunNeeded: true
      }
    });
  });

  it("does not schedule or await detached work after human evidence wins", async () => {
    const batch = verificationBatch(false);
    batch.incidents[0].result = "NEEDS_HUMAN";
    batch.incidents[0].message = "Provider approval is required.";
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.verificationRequestFindMany.mockResolvedValue([
      detachedRequestState("QUEUED")
    ]);

    const result = await verifyCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      releaseSha,
      now
    });

    expect(
      verificationMocks.scheduleCourseSupportVerificationRequests
    ).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      detachedVerification: { pendingCount: 0, rerunNeeded: false }
    });
  });

  it("carries current detached fetch failure evidence without restoring", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(verificationBatch());
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    verificationMocks.getCurrentCourseSupportVerificationFailure.mockResolvedValue({
      current: true,
      releaseSha,
      runtimeVersion: releaseSha,
      status: "RETRYABLE_FAILED",
      outcome: "FETCH_FAILED",
      failureClass: "RATE_LIMIT",
      providerExecution: true,
      observedAt,
      completedAt: null,
      nextAttemptAt: new Date("2026-07-15T20:15:00.000Z"),
      providerRetryNotBeforeAt: new Date("2026-07-15T22:00:00.000Z"),
      providerSnapshotFingerprint: providerFingerprint,
      evidence: {
        ...proofEvidence(),
        outcome: "FETCH_FAILED",
        failureClass: "RATE_LIMIT"
      }
    });

    await verifyCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      releaseSha,
      now
    });

    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          result: "RETRY_SCHEDULED",
          proofSnapshot: expect.objectContaining({
            kind: "PROVIDER_VERIFICATION_FAILURE",
            outcome: "FETCH_FAILED",
            failureClass: "RATE_LIMIT",
            providerRetryNotBeforeAt: "2026-07-15T22:00:00.000Z"
          })
        })
      })
    );
  });

  it("rejects terminal detached closeout when live demand appears after verification", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(closeoutBatch("RESTORED"));
    prismaMocks.verificationRequestFindUnique.mockResolvedValue(atomicRequest());
    prismaMocks.teeSearchCount.mockResolvedValue(1);

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "success",
        now
      })
    ).rejects.toThrow("changed before terminal closeout");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects terminal detached closeout when current access intelligence becomes terminal", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(closeoutBatch("RESTORED"));
    prismaMocks.verificationRequestFindUnique.mockResolvedValue(
      atomicRequest(
        providerCourse({
          automationEligibility: "BLOCKED",
          automationReason: "ACCOUNT_REQUIRED",
          intelligenceVerifiedAt: new Date("2026-07-15T19:59:00.000Z"),
          intelligenceReviewAt: new Date("2026-07-16T20:00:00.000Z"),
          intelligenceConfidence: 0.95
        })
      )
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "success",
        now
      })
    ).rejects.toThrow("changed before terminal closeout");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
    expect(prismaMocks.teeSearchCount).not.toHaveBeenCalled();
  });

  it.each(["QUEUED", "CHECKING"] as const)(
    "refuses closeout while detached verification is %s",
    async (status) => {
      prismaMocks.batchFindFirst.mockResolvedValue(
        closeoutBatch("RETRY_SCHEDULED")
      );
      prismaMocks.verificationRequestFindMany.mockResolvedValue([
        detachedRequestState(status)
      ]);

      await expect(
        closeoutCourseSupportBatch({
          batchId: "batch-1",
          leaseToken: "lease-1",
          ownerThreadId: "owner-thread",
          requestedOutcome: "retryable_failed",
          now
        })
      ).rejects.toThrow("still pending");
      expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
    }
  );

  it("allows human closeout when an older detached request is still pending", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(closeoutBatch("NEEDS_HUMAN"));
    prismaMocks.verificationRequestFindMany.mockResolvedValue([
      detachedRequestState("QUEUED")
    ]);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "needs_human",
        now
      })
    ).resolves.toMatchObject({
      outcome: "needs_human",
      durableCloseoutRecorded: true
    });
  });

  it("refuses closeout when detached success finished after the last verify read", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(
      closeoutBatch("RETRY_SCHEDULED")
    );
    prismaMocks.verificationRequestFindMany.mockResolvedValue([
      detachedRequestState("SUCCEEDED")
    ]);

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "retryable_failed",
        now
      })
    ).rejects.toThrow("completed after the last evidence read");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses closeout until a current retryable failure is copied by verify", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(
      closeoutBatch("RETRY_SCHEDULED")
    );
    prismaMocks.verificationRequestFindMany.mockResolvedValue([
      detachedRequestState("RETRYABLE_FAILED")
    ]);
    verificationMocks.getCurrentCourseSupportVerificationFailure.mockResolvedValue(
      currentDetachedFailure()
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "retryable_failed",
        now
      })
    ).rejects.toThrow("failure changed after the last evidence read");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses closeout until current stale cooldown evidence is copied by verify", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(
      closeoutBatch("RETRY_SCHEDULED")
    );
    prismaMocks.verificationRequestFindMany.mockResolvedValue([
      detachedRequestState("STALE")
    ]);
    verificationMocks.getCurrentCourseSupportVerificationFailure.mockResolvedValue(
      currentDetachedFailure("STALE")
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "retryable_failed",
        now
      })
    ).rejects.toThrow("cooldown evidence has not been recorded");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("catches a rate-limit request that becomes stale after the pre-closeout evidence read", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(
      closeoutBatch("RETRY_SCHEDULED")
    );
    prismaMocks.verificationRequestFindMany.mockResolvedValue([
      detachedRequestState("STALE")
    ]);

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "retryable_failed",
        now
      })
    ).rejects.toThrow("cooldown evidence has not been recorded");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("allows retry closeout after verify copied the exact current detached failure", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(
      closeoutBatch(
        "RETRY_SCHEDULED",
        detachedFailureProof({
          nextAttemptAt: "2026-07-15T22:00:00.000Z",
          providerRetryNotBeforeAt: "2026-07-16T02:00:00.000Z"
        })
      )
    );
    prismaMocks.verificationRequestFindMany.mockResolvedValue([
      detachedRequestState("RETRYABLE_FAILED")
    ]);
    verificationMocks.getCurrentCourseSupportVerificationFailure.mockResolvedValue(
      currentDetachedFailure()
    );
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "retryable_failed",
        now
      })
    ).resolves.toMatchObject({
      outcome: "retryable_failed",
      durableCloseoutRecorded: true
    });
  });

  it("preserves the later detached provider cooldown during retry closeout", async () => {
    const persistedRetryAt = new Date("2026-07-15T22:00:00.000Z");
    const providerRetryNotBeforeAt = new Date("2026-07-16T02:00:00.000Z");
    prismaMocks.batchFindFirst.mockResolvedValue(
      closeoutBatch(
        "RETRY_SCHEDULED",
        detachedFailureProof({
          nextAttemptAt: persistedRetryAt.toISOString(),
          providerRetryNotBeforeAt: providerRetryNotBeforeAt.toISOString()
        })
      )
    );
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });

    await closeoutCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      requestedOutcome: "retryable_failed",
      now
    });

    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextAttemptAt: providerRetryNotBeforeAt
        })
      })
    );
  });

  it("preserves a valid detached provider cooldown beyond the request horizon", async () => {
    const providerRetryNotBeforeAt = new Date("2026-07-17T02:00:00.000Z");
    prismaMocks.batchFindFirst.mockResolvedValue(
      closeoutBatch(
        "RETRY_SCHEDULED",
        detachedFailureProof({
          status: "STALE",
          nextAttemptAt: null,
          providerRetryNotBeforeAt: providerRetryNotBeforeAt.toISOString()
        })
      )
    );
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });

    await closeoutCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      requestedOutcome: "retryable_failed",
      now
    });

    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextAttemptAt: providerRetryNotBeforeAt
        })
      })
    );
  });

  it("uses a 24-hour fail-safe for current detached rate limits without a valid cooldown", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(
      closeoutBatch(
        "RETRY_SCHEDULED",
        detachedFailureProof({
          status: "STALE",
          nextAttemptAt: null,
          providerRetryNotBeforeAt: null
        })
      )
    );
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });

    await closeoutCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      requestedOutcome: "retryable_failed",
      now
    });

    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextAttemptAt: new Date("2026-07-16T20:00:00.000Z")
        })
      })
    );
  });

  it("allows closeout for stale requests without current eligible failure evidence", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(
      closeoutBatch("RETRY_SCHEDULED")
    );
    prismaMocks.verificationRequestFindMany.mockResolvedValue([
      detachedRequestState("STALE", {
        failureClass: "SCHEMA",
        evidence: {
          ...proofEvidence(),
          outcome: "FETCH_FAILED",
          failureClass: "SCHEMA"
        }
      })
    ]);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.verificationRequestUpdateMany.mockResolvedValue({ count: 2 });

    const result = await closeoutCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      requestedOutcome: "retryable_failed",
      now
    });

    expect(result).toMatchObject({
      outcome: "retryable_failed",
      durableCloseoutRecorded: true
    });
    expect(prismaMocks.verificationRequestUpdateMany).toHaveBeenCalledWith({
      where: {
        batchIncident: { batchId: "batch-1" },
        status: { in: ["QUEUED", "CHECKING", "RETRYABLE_FAILED"] }
      },
      data: expect.objectContaining({
        status: "STALE",
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        completedAt: now,
        lastError: "batch_closed"
      })
    });
  });
});

describe("course-support fingerprints", () => {
  it("groups by structured class and kind without URLs or customer data", () => {
    expect(
      buildFailureFingerprint({
        providerFamilyKey: "FOREUP",
        kind: "FETCH_FAILED",
        failureClass: "HTTP_5XX"
      })
    ).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("course-support provider discovery reconciliation", () => {
  it.each([
    {
      expectedFamily: "CHRONOGOLF",
      detectedPlatform: "CHRONOGOLF",
      bookingUrl: "https://www.chronogolf.com/club/example-course",
      confidence: 0.45
    },
    {
      expectedFamily: "TEEITUP",
      detectedPlatform: "TEEITUP",
      bookingUrl: "https://example-course.book.teeitup.golf/",
      confidence: 0.45
    },
    {
      expectedFamily: "TEESNAP",
      detectedPlatform: "CUSTOM",
      bookingUrl: "https://example-course.teesnap.net/",
      confidence: 0.55
    },
    {
      expectedFamily: "EZLINKS",
      detectedPlatform: "CUSTOM",
      bookingUrl: "https://example-course.ezlinksgolf.com/",
      confidence: 0.45
    }
  ])(
    "uses an inspected $expectedFamily booking surface instead of the official-site host",
    ({ expectedFamily, detectedPlatform, bookingUrl, confidence }) => {
      const provider = resolveCourseSupportProviderCapability({
        providerFamilyKey: "course.example.com",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: "https://course.example.com/book-a-tee-time",
        website: "https://course.example.com/",
        bookingMetadata: null,
        automationDiscoveries: [
          {
            status: "INSPECTED",
            detectedPlatform,
            bookingUrl,
            sourceUrl: "https://course.example.com/",
            apiMetadata: null,
            confidence
          }
        ]
      });

      expect(provider).toMatchObject({
        providerFamilyKey: expectedFamily,
        metadataReady: false,
        isRunnable: false,
        evidenceConflict: false
      });
    }
  );

  it("does not use failed or conflicting discovery evidence", () => {
    const failedProvider = resolveCourseSupportProviderCapability({
      providerFamilyKey: "course.example.com",
      detectedPlatform: "UNKNOWN",
      website: "https://course.example.com/",
      automationDiscoveries: [
        {
          status: "FAILED",
          detectedPlatform: "CHRONOGOLF",
          bookingUrl: "https://www.chronogolf.com/club/example-course",
          sourceUrl: "https://course.example.com/",
          confidence: 0.95
        }
      ]
    });
    const conflictingProvider = resolveCourseSupportProviderCapability({
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl:
        "https://foreupsoftware.com/index.php/booking/1/2#/teetimes",
      website: "https://course.example.com/",
      automationDiscoveries: [
        {
          status: "INSPECTED",
          detectedPlatform: "CHRONOGOLF",
          bookingUrl: "https://www.chronogolf.com/club/example-course",
          sourceUrl: "https://course.example.com/",
          confidence: 0.95
        }
      ]
    });

    expect(failedProvider.providerFamilyKey).toBe("course.example.com");
    expect(conflictingProvider.providerFamilyKey).toBe("FOREUP");
  });

  it("does not trust a platform label when the selected booking URL is still the official site", () => {
    const provider = resolveCourseSupportProviderCapability({
      providerFamilyKey: "course.example.com",
      detectedPlatform: "UNKNOWN",
      website: "https://course.example.com/",
      automationDiscoveries: [
        {
          status: "INSPECTED",
          detectedPlatform: "CHRONOGOLF",
          bookingUrl: "https://course.example.com/book-a-tee-time",
          sourceUrl: "https://course.example.com/",
          confidence: 0.95
        }
      ]
    });

    expect(provider.providerFamilyKey).toBe("course.example.com");
  });
});
