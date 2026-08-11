import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  course: {
    findMany: vi.fn()
  },
  courseSupportIncident: {
    findMany: vi.fn()
  },
  teeSearch: {
    aggregate: vi.fn()
  },
  courseMonitoringEvent: {
    findMany: vi.fn()
  },
  $transaction: vi.fn()
}));
const transactionMocks = vi.hoisted(() => ({
  course: {
    findUnique: vi.fn(),
    updateMany: vi.fn()
  },
  courseMonitoringStatus: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn()
  },
  courseSupportIncident: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    createMany: vi.fn()
  },
  teeSearch: {
    aggregate: vi.fn(),
    updateMany: vi.fn()
  },
  courseMonitoringEvent: {
    findUnique: vi.fn(),
    create: vi.fn()
  }
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));

import {
  backfillCourseMonitoringLifecycle,
  backfillCourseMonitoringPlaybook,
  getIncidentLifecycleState,
  reconcileCourseMonitoringLifecycle
} from "./course-monitoring-backfill";

function course(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Course ${id}`,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    timeZone: "America/New_York",
    isPublic: true,
    bookingMethod: "UNKNOWN",
    automationReason: "NONE",
    automationEligibility: "UNKNOWN",
    bookingAccessMode: "UNKNOWN",
    detectedBookingUrl: null,
    website: "https://course.example",
    detectedPlatform: "UNKNOWN",
    providerFamilyKey: "SOURCE_MISSING",
    monitoringStatus: null,
    supportIncident: null,
    probes: [],
    ...overrides
  };
}

function playbookIncident(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `incident-${id}`,
    reference: `ref-${id}`,
    courseId: id,
    cycle: 2,
    revision: 7,
    status: "AUTO_INVESTIGATING",
    resolution: null,
    attemptLedger: null,
    activeBatchId: null,
    engineeringOnly: false,
    occurrenceCount: 2,
    failureFingerprint: "SOURCE_MISSING:MISSING_SOURCE",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    course: {
      timeZone: "America/New_York",
      monitoringStatus: {
        courseId: id,
        state: "AUTO_INVESTIGATING",
        revision: 4
      }
    },
    ...overrides
  };
}

describe("course monitoring backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.course.findMany.mockResolvedValue([]);
    prismaMocks.teeSearch.aggregate.mockResolvedValue({
      _count: { id: 0 },
      _min: { date: null }
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([]);
    prismaMocks.courseMonitoringEvent.findMany.mockResolvedValue([]);
    prismaMocks.$transaction.mockImplementation(
      async (callback: (transaction: typeof transactionMocks) => Promise<unknown>) =>
        callback(transactionMocks)
    );
    transactionMocks.courseMonitoringStatus.findUnique.mockReset();
    transactionMocks.courseMonitoringStatus.updateMany.mockReset();
    transactionMocks.courseMonitoringStatus.create.mockReset();
    transactionMocks.courseSupportIncident.findUnique.mockReset();
    transactionMocks.courseSupportIncident.updateMany.mockReset();
    transactionMocks.courseSupportIncident.createMany.mockReset();
    transactionMocks.course.findUnique.mockReset();
    transactionMocks.course.updateMany.mockReset();
    transactionMocks.teeSearch.aggregate.mockReset();
    transactionMocks.teeSearch.updateMany.mockReset();
    transactionMocks.courseMonitoringEvent.findUnique.mockReset();
    transactionMocks.courseMonitoringEvent.create.mockReset();
  });

  it("plans only missing-ledger work and uses the course-local date near UTC rollover", async () => {
    const now = new Date("2026-08-11T02:00:00.000Z");
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      playbookIncident("open"),
      playbookIncident("automatic-active", {
        status: "RESOLVED",
        resolution: "TECHNICAL_LIMITATION_CLASSIFIED",
        course: {
          timeZone: "America/New_York",
          monitoringStatus: {
            courseId: "automatic-active",
            state: "FINAL_TECHNICAL",
            revision: 3
          }
        }
      }),
      playbookIncident("automatic-inactive", {
        status: "RESOLVED",
        resolution: "TECHNICAL_LIMITATION_CLASSIFIED",
        course: {
          timeZone: "America/New_York",
          monitoringStatus: {
            courseId: "automatic-inactive",
            state: "FINAL_TECHNICAL",
            revision: 3
          }
        }
      }),
      playbookIncident("human-approved", {
        status: "RESOLVED",
        resolution: "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
        course: {
          timeZone: "America/New_York",
          monitoringStatus: {
            courseId: "human-approved",
            state: "FINAL_TECHNICAL",
            revision: 3
          }
        }
      }),
      playbookIncident("proof-backed", {
        status: "RESOLVED",
        resolution: "TECHNICAL_LIMITATION_CLASSIFIED",
        attemptLedger: { version: 1, events: [] },
        course: {
          timeZone: "America/New_York",
          monitoringStatus: {
            courseId: "proof-backed",
            state: "FINAL_TECHNICAL",
            revision: 3
          }
        }
      }),
      playbookIncident("manual", {
        status: "NEEDS_HUMAN",
        course: {
          timeZone: "America/New_York",
          monitoringStatus: { courseId: "manual", state: "FINAL_MANUAL", revision: 3 }
        }
      }),
      playbookIncident("identity", {
        status: "NEEDS_HUMAN",
        course: {
          timeZone: "America/New_York",
          monitoringStatus: { courseId: "identity", state: "FINAL_IDENTITY", revision: 3 }
        }
      }),
      playbookIncident("leased", { activeBatchId: "batch-active" })
    ]);
    prismaMocks.teeSearch.aggregate.mockImplementation(
      ({ where }: { where: { preferences: { some: { courseId: string } } } }) => {
        const courseId = where.preferences.some.courseId;
        return Promise.resolve({
          _count: { id: courseId === "automatic-inactive" ? 0 : 1 },
          _min: {
            date:
              courseId === "automatic-inactive"
                ? null
                : new Date("2026-08-10T00:00:00.000Z")
          }
        });
      }
    );

    await expect(backfillCourseMonitoringPlaybook({ apply: false, now })).resolves.toEqual({
      apply: false,
      incidentsScanned: 8,
      incidentlessAutomaticTechnicalFinalsToOpen: 0,
      candidatesToBackfill: 2,
      openIncidentsToRequeue: 1,
      automaticTechnicalFinalsToReopen: 1,
      activeBatchesSkipped: 1,
      existingLedgersPreserved: 1,
      manualFinalsPreserved: 1,
      identityFinalsPreserved: 1,
      humanApprovedTechnicalFinalsPreserved: 1,
      inactiveAutomaticTechnicalFinalsPreserved: 1,
      applied: {
        freshCyclesOpened: 0,
        incidentsCreated: 0,
        monitoringStatusesCreated: 0,
        monitoringStatusesUpdated: 0,
        eventsCreated: 0,
        searchesQueued: 0,
        skippedAfterRefresh: 0
      }
    });
    expect(prismaMocks.teeSearch.aggregate).toHaveBeenCalledTimes(3);
    for (const [call] of prismaMocks.teeSearch.aggregate.mock.calls) {
      expect(call.where.date.gte.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    }
  });

  it("opens one audited fresh cycle and a second dry run plans no mutation", async () => {
    const now = new Date("2026-08-11T02:00:00.000Z");
    const incident = playbookIncident("open", {
      status: "NEEDS_HUMAN",
      course: {
        timeZone: "America/New_York",
        monitoringStatus: {
          courseId: "open",
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 4
        }
      }
    });
    const demand = {
      _count: { id: 2 },
      _min: { date: new Date("2026-08-10T00:00:00.000Z") }
    };
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([incident]);
    prismaMocks.teeSearch.aggregate.mockResolvedValue(demand);
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(incident);
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      incident.course.monitoringStatus
    );
    transactionMocks.teeSearch.aggregate.mockResolvedValue(demand);
    transactionMocks.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    transactionMocks.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 });
    transactionMocks.courseMonitoringStatus.updateMany.mockResolvedValue({ count: 1 });
    transactionMocks.teeSearch.updateMany.mockResolvedValue({ count: 2 });
    transactionMocks.courseMonitoringEvent.create.mockResolvedValue({ id: "event-1" });

    await expect(backfillCourseMonitoringPlaybook({ apply: true, now })).resolves.toMatchObject({
      candidatesToBackfill: 1,
      applied: {
        freshCyclesOpened: 1,
        monitoringStatusesCreated: 0,
        monitoringStatusesUpdated: 1,
        eventsCreated: 1,
        searchesQueued: 2,
        skippedAfterRefresh: 0
      }
    });
    expect(transactionMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: incident.id,
          cycle: 2,
          revision: 7,
          status: "NEEDS_HUMAN",
          activeBatchId: null
        }),
        data: expect.objectContaining({
          cycle: { increment: 1 },
          status: "AUTO_INVESTIGATING",
          attemptLedger: { version: 1, events: [] },
          activeRealSearchCount: 2,
          earliestTargetDate: new Date("2026-08-10T00:00:00.000Z")
        })
      })
    );
    expect(transactionMocks.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          date: { gte: new Date("2026-08-10T00:00:00.000Z") }
        }),
        data: { nextCheckAt: now, recheckRequestedAt: now }
      })
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "REVALIDATION_REQUESTED",
          source: "MAINTENANCE",
          fromState: "ENGINEERING_VERIFICATION_NEEDED",
          toState: "AUTO_INVESTIGATING",
          audit: expect.objectContaining({
            priorCycle: 2,
            cycle: 3,
            playbookVersion: 1,
            inferredPlaybookStages: false
          })
        })
      })
    );

    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { ...incident, attemptLedger: { version: 1, events: [] } }
    ]);
    prismaMocks.teeSearch.aggregate.mockClear();
    await expect(backfillCourseMonitoringPlaybook({ apply: false, now })).resolves.toMatchObject({
      candidatesToBackfill: 0,
      openIncidentsToRequeue: 0,
      automaticTechnicalFinalsToReopen: 0,
      existingLedgersPreserved: 1,
      applied: {
        freshCyclesOpened: 0,
        eventsCreated: 0,
        searchesQueued: 0
      }
    });
    expect(prismaMocks.teeSearch.aggregate).not.toHaveBeenCalled();
  });

  it("creates and queues an unexhausted incident for an active-demand legacy technical final", async () => {
    const now = new Date("2026-08-11T02:00:00.000Z");
    const technicalFinal = course("legacy-technical", {
      automationEligibility: "BLOCKED",
      automationReason: "CAPTCHA_OR_QUEUE",
      bookingAccessMode: "CAPTCHA_OR_QUEUE",
      monitoringStatus: {
        courseId: "legacy-technical",
        state: "FINAL_TECHNICAL",
        revision: 5
      }
    });
    prismaMocks.course.findMany.mockResolvedValue([
      technicalFinal,
      course("manual", {
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
        bookingAccessMode: "CAPTCHA_OR_QUEUE",
        monitoringStatus: {
          courseId: "manual",
          state: "FINAL_MANUAL",
          revision: 2
        }
      }),
      course("identity", {
        isPublic: false,
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
        bookingAccessMode: "CAPTCHA_OR_QUEUE",
        monitoringStatus: {
          courseId: "identity",
          state: "FINAL_IDENTITY",
          revision: 2
        }
      })
    ]);
    const demand = {
      _count: { id: 2 },
      _min: { date: new Date("2026-08-10T00:00:00.000Z") }
    };
    prismaMocks.teeSearch.aggregate.mockResolvedValue(demand);
    transactionMocks.course.findUnique.mockResolvedValue(technicalFinal);
    transactionMocks.teeSearch.aggregate.mockResolvedValue(demand);
    transactionMocks.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    transactionMocks.courseSupportIncident.createMany.mockResolvedValue({ count: 1 });
    transactionMocks.course.updateMany.mockResolvedValue({ count: 1 });
    transactionMocks.courseMonitoringStatus.updateMany.mockResolvedValue({ count: 1 });
    transactionMocks.teeSearch.updateMany.mockResolvedValue({ count: 2 });
    transactionMocks.courseMonitoringEvent.create.mockResolvedValue({ id: "event-legacy" });

    await expect(backfillCourseMonitoringPlaybook({ apply: true, now })).resolves.toMatchObject({
      incidentsScanned: 0,
      incidentlessAutomaticTechnicalFinalsToOpen: 1,
      candidatesToBackfill: 1,
      automaticTechnicalFinalsToReopen: 1,
      manualFinalsPreserved: 0,
      identityFinalsPreserved: 0,
      applied: {
        freshCyclesOpened: 1,
        incidentsCreated: 1,
        monitoringStatusesCreated: 0,
        monitoringStatusesUpdated: 1,
        eventsCreated: 1,
        searchesQueued: 2,
        skippedAfterRefresh: 0
      }
    });
    expect(transactionMocks.courseSupportIncident.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          courseId: "legacy-technical",
          status: "AUTO_INVESTIGATING",
          attemptLedger: { version: 1, events: [] },
          activeRealSearchCount: 2,
          earliestTargetDate: demand._min.date
        })
      ],
      skipDuplicates: true
    });
    expect(transactionMocks.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          automationEligibility: "NEEDS_REVIEW",
          intelligenceReviewAt: null
        }
      })
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "REVALIDATION_REQUESTED",
          source: "MAINTENANCE",
          audit: expect.objectContaining({
            cycle: 1,
            reason: "ACTIVE_DEMAND_TECHNICAL_FINAL_WITHOUT_INCIDENT_OR_LEDGER",
            inferredPlaybookStages: false,
            customerDataIncluded: false
          })
        })
      })
    );
    expect(transactionMocks.teeSearch.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: "ACTIVE",
        date: { gte: new Date("2026-08-10T00:00:00.000Z") },
        preferences: { some: { courseId: "legacy-technical" } }
      }),
      data: { nextCheckAt: now, recheckRequestedAt: now }
    });
  });

  it("keeps the legacy lifecycle backfill from reopening proof-backed or inactive finals", async () => {
    prismaMocks.course.findMany.mockResolvedValue([
      course("proof-backed", {
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
        bookingAccessMode: "CAPTCHA_OR_QUEUE",
        supportIncident: {
          id: "incident-proof",
          status: "RESOLVED",
          resolution: "TECHNICAL_LIMITATION_CLASSIFIED",
          confirmedAt: new Date("2026-08-10T00:00:00.000Z"),
          attemptLedger: { version: 1, events: [] }
        }
      }),
      course("inactive", {
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
        bookingAccessMode: "CAPTCHA_OR_QUEUE",
        supportIncident: {
          id: "incident-inactive",
          status: "RESOLVED",
          resolution: "TECHNICAL_LIMITATION_CLASSIFIED",
          confirmedAt: new Date("2026-08-10T00:00:00.000Z"),
          attemptLedger: null
        }
      })
    ]);
    prismaMocks.teeSearch.aggregate.mockImplementation(
      ({ where }: { where: { preferences: { some: { courseId: string } } } }) =>
        Promise.resolve({
          _count: { id: where.preferences.some.courseId === "proof-backed" ? 1 : 0 },
          _min: { date: null }
        })
    );

    await expect(backfillCourseMonitoringLifecycle({ apply: false })).resolves.toMatchObject({
      technicalRowsToReopen: 0
    });
  });

  it("reports a dry run without inventing events or reopening human finals", async () => {
    prismaMocks.course.findMany.mockResolvedValue([
      course("manual", {
        bookingMethod: "PHONE_ONLY",
        automationReason: "NO_ONLINE_BOOKING"
      }),
      course("reader", {
        detectedBookingUrl: "https://grassyhill.cps.golf/"
      }),
      course("human-final", {
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
        bookingAccessMode: "CAPTCHA_OR_QUEUE",
        supportIncident: {
          id: "incident-human",
          status: "RESOLVED",
          resolution: "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
          confirmedAt: new Date("2026-07-20T00:00:00.000Z")
        }
      })
    ]);

    await expect(
      backfillCourseMonitoringLifecycle({
        apply: false,
        now: new Date("2026-07-27T12:00:00.000Z")
      })
    ).resolves.toMatchObject({
      apply: false,
      coursesScanned: 3,
      statusesToCreate: 3,
      baselineEventsToCreate: 3,
      technicalRowsToReopen: 0,
      incidentsToCreate: 1,
      readerCandidateIncidentsToCreate: 1,
      manualFinalsPreserved: 1,
      technicalFinalsPreserved: 1,
      identityFinalsPreserved: 0,
      applied: {
        statusesCreated: 0,
        baselineEventsCreated: 0,
        technicalRowsReopened: 0,
        incidentsCreated: 0,
        incidentsConfirmed: 0
      }
    });
    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
  });

  it("counts existing unconfirmed work for explicit confirmation", async () => {
    prismaMocks.course.findMany.mockResolvedValue([
      course("open", {
        supportIncident: {
          id: "incident-open",
          status: "AUTO_INVESTIGATING",
          resolution: null,
          confirmedAt: null,
          occurrenceCount: 2,
          failureFingerprint: "SOURCE_MISSING:UNKNOWN",
          firstSeenAt: new Date("2026-07-25T00:00:00.000Z"),
          lastSeenAt: new Date("2026-07-27T00:00:00.000Z")
        }
      })
    ]);

    await expect(backfillCourseMonitoringLifecycle({ apply: false })).resolves.toMatchObject({
      incidentsToCreate: 0,
      incidentsToConfirm: 1
    });
  });

  it("derives lifecycle state from the authoritative incident outcome", () => {
    expect(
      getIncidentLifecycleState({
        incidentStatus: "NEEDS_HUMAN",
        resolution: null,
        currentState: "AUTO_INVESTIGATING"
      })
    ).toBe("ENGINEERING_VERIFICATION_NEEDED");
    expect(
      getIncidentLifecycleState({
        incidentStatus: "RESOLVED",
        resolution: "MONITORING_RESTORED",
        currentState: "AUTO_INVESTIGATING"
      })
    ).toBe("HEALTHY");
    expect(
      getIncidentLifecycleState({
        incidentStatus: "RESOLVED",
        resolution: "DIRECT_BOOKING_CLASSIFIED",
        currentState: "AUTO_INVESTIGATING"
      })
    ).toBe("FINAL_MANUAL");
    expect(
      getIncidentLifecycleState({
        incidentStatus: "RESOLVED",
        resolution: "IDENTITY_CLASSIFIED",
        currentState: "AUTO_INVESTIGATING"
      })
    ).toBe("FINAL_IDENTITY");
    expect(
      getIncidentLifecycleState({
        incidentStatus: "RESOLVED",
        resolution: "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
        currentState: "REVALIDATING_FINAL"
      })
    ).toBe("REVALIDATING_FINAL");
    expect(
      getIncidentLifecycleState({
        incidentStatus: "RESOLVED",
        resolution: "DIRECT_BOOKING_CLASSIFIED",
        currentState: "FINAL_IDENTITY"
      })
    ).toBeNull();
  });

  it("reports lifecycle drift without mutating on a reconciliation dry run", async () => {
    prismaMocks.course.findMany.mockResolvedValue([
      {
        id: "needs-human",
        monitoringStatus: { state: "AUTO_INVESTIGATING" },
        supportIncident: { status: "NEEDS_HUMAN", resolution: null }
      },
      {
        id: "restored",
        monitoringStatus: { state: "AUTO_INVESTIGATING" },
        supportIncident: {
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED"
        }
      },
      {
        id: "aligned",
        monitoringStatus: { state: "AUTO_INVESTIGATING" },
        supportIncident: { status: "AUTO_INVESTIGATING", resolution: null }
      }
    ]);

    await expect(
      reconcileCourseMonitoringLifecycle({
        apply: false,
        actorId: "operator-cli-dry-run"
      })
    ).resolves.toEqual({
      apply: false,
      coursesScanned: 3,
      mismatchesFound: 2,
      transitions: {
        "AUTO_INVESTIGATING->ENGINEERING_VERIFICATION_NEEDED": 1,
        "AUTO_INVESTIGATING->HEALTHY": 1
      },
      applied: 0,
      skippedAfterRefresh: 0
    });
    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
  });

  it("rechecks current revisions and appends an audited event when applying", async () => {
    prismaMocks.course.findMany.mockResolvedValue([
      {
        id: "needs-human",
        monitoringStatus: { state: "AUTO_INVESTIGATING" },
        supportIncident: { status: "NEEDS_HUMAN", resolution: null }
      }
    ]);
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      courseId: "needs-human",
      state: "AUTO_INVESTIGATING",
      revision: 4
    });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-human",
      courseId: "needs-human",
      cycle: 2,
      revision: 7,
      status: "NEEDS_HUMAN",
      resolution: null,
      failureFingerprint: "SOURCE_MISSING:MISSING_SOURCE",
      nextAttemptAt: new Date("2026-07-29T18:00:00.000Z"),
      resolvedAt: null
    });
    transactionMocks.courseMonitoringStatus.updateMany.mockResolvedValue({
      count: 1
    });
    transactionMocks.courseMonitoringEvent.create.mockResolvedValue({
      id: "event-1"
    });

    await expect(
      reconcileCourseMonitoringLifecycle({
        apply: true,
        actorId: "operator-test",
        now: new Date("2026-07-29T17:45:00.000Z")
      })
    ).resolves.toMatchObject({
      mismatchesFound: 1,
      applied: 1,
      skippedAfterRefresh: 0
    });
    expect(transactionMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          courseId: "needs-human",
          revision: 4,
          state: "AUTO_INVESTIGATING"
        },
        data: expect.objectContaining({
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: { increment: 1 }
        })
      })
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "STATE_CHANGED",
          source: "OPERATOR_CLI",
          fromState: "AUTO_INVESTIGATING",
          toState: "ENGINEERING_VERIFICATION_NEEDED",
          operatorActorId: "operator-test"
        })
      })
    );
  });
});
