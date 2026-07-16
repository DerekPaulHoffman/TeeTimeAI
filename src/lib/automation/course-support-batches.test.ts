import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  batchFindFirst: vi.fn(),
  batchUpdateMany: vi.fn(),
  incidentUpdateMany: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    courseSupportBatch: { findFirst: prismaMocks.batchFindFirst },
    $transaction: prismaMocks.transaction
  }
}));

import {
  assessCourseSupportRecovery,
  assessCourseSupportReleaseTransition,
  buildFailureFingerprint,
  buildCourseSupportReleaseHistory,
  canCloseCourseSupportRetry,
  classifyFreshBatchEvidence,
  collectFreshRemediatedCourseProof,
  computeCourseSupportNextAttemptAt,
  heartbeatCourseSupportBatch,
  isDurableTerminalProof,
  isRemediatedSearchSchedulerHealthy,
  normalizeCourseSupportObservedGitPaths,
  orderCourseSupportBatchIncidents,
  preserveExplicitHumanVerification,
  resolveCourseSupportProviderCapability,
  selectCourseSupportBatch,
  shouldDispatchRemediatedCourseRechecks,
  verifyCourseSupportBatch,
  type CourseSupportCandidate
} from "./course-support-batches";

const now = new Date("2026-07-15T20:00:00.000Z");

const transactionClient = {
  courseSupportBatch: { updateMany: prismaMocks.batchUpdateMany },
  courseSupportBatchIncident: { updateMany: prismaMocks.incidentUpdateMany }
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.transaction.mockImplementation(
    async (
      worker: (transaction: typeof transactionClient) => Promise<unknown>
    ) => worker(transactionClient)
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
    attemptCount: 0,
    updatedAt: new Date("2026-07-15T18:00:00.000Z"),
    ...overrides
  };
}

describe("course-support batch selection", () => {
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

  it("accepts a current source-backed prohibited-automation disposition", () => {
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
    ).toBe("FINAL_DISPOSITION");
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
    ).toBe(true);
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
