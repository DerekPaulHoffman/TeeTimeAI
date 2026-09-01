import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { buildBrowserDiscovery } from "./browser-discovery";
import { COURSE_PROVIDER_EXECUTION_EVIDENCE_FIELDS } from "./course-provider-execution-evidence";
import { appendAutomationPlaybookEvent } from "./course-monitoring-playbook";
import { buildCourseSupportSourceSearchScopeDigest } from "./course-support-source-search";
import {
  applyBrowserDiscoveryToCourse,
  applyRecoveredOfficialWebsiteToCourse,
  bindBrowserDiscoveryToProviderSnapshot,
  listBrowserProbeTargets,
  recordAndApplyBrowserDiscoveryToCourse,
  recordAndApplyOwnedBrowserDiscoveryToCourse,
  recordBrowserDiscovery,
  retireLegacyPolicyOnlyCourseBlock
} from "./db-service";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";

const providerExecutionMarkerMocks = vi.hoisted(() => ({
  renewCourseProviderObservationInTransaction: vi.fn(),
}));

vi.mock("./provider-execution-marker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-execution-marker")>()),
  renewCourseProviderObservationInTransaction:
    providerExecutionMarkerMocks.renewCourseProviderObservationInTransaction,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
    course: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    },
    courseAutomationDiscovery: {
      create: vi.fn(),
      findMany: vi.fn()
    },
    courseSupportIncident: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn()
    },
    courseSupportBatch: {
      findFirst: vi.fn(),
      updateMany: vi.fn()
    },
    courseSupportBatchIncident: {
      findUnique: vi.fn()
    },
    courseMonitoringStatus: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn()
    },
    courseMonitoringEvent: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn()
    },
    teeSearch: {
      findMany: vi.fn(),
      updateMany: vi.fn()
    },
    teeTimeMatch: {
      updateMany: vi.fn()
    }
  }
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });
const chronogolfOfficialLinkProof = {
  kind: "OFFICIAL_COURSE_PROVIDER_LINK" as const,
  officialWebsiteUrl: "https://westwoodsgc.com/",
  officialPageUrl: "https://westwoodsgc.com/",
  providerUrl: "https://www.chronogolf.com/club/westwoods-golf-course"
};
const arthurSimOfficialUrl =
  "https://www.wichita.gov/facilities/facility/details/Arthur-B-Sim-Golf-Course-150";
const arthurSimMemberSportsUrl =
  "https://app.membersports.com/tee-times/7128/8903/0/8/0";
const arthurSimNonRunnableLinkProof = {
  kind: "OFFICIAL_COURSE_NON_RUNNABLE_BOOKING_LINK" as const,
  courseName: "Arthur B. Sim Golf Course",
  officialWebsiteUrl: arthurSimOfficialUrl,
  officialPageUrl: arthurSimOfficialUrl,
  providerUrl: arthurSimMemberSportsUrl
};

function currentIntelligenceEvidence() {
  const now = Date.now();
  return {
    intelligenceVerifiedAt: new Date(now - 60 * 60 * 1000),
    intelligenceReviewAt: new Date(now + 30 * 24 * 60 * 60 * 1000)
  };
}

function expectCompleteProviderExecutionEvidenceSelect(query: unknown) {
  const select = (query as { select?: Record<string, unknown> }).select;
  expect(select).toEqual(
    expect.objectContaining(
      Object.fromEntries(
        COURSE_PROVIDER_EXECUTION_EVIDENCE_FIELDS.map((field) => [field, true])
      )
    )
  );
}

function browserReadyAttemptLedger(cycle = 1) {
  const observedAt = new Date("2026-08-10T12:00:00.000Z");
  let ledger: unknown = null;
  ledger = appendAutomationPlaybookEvent(ledger, {
    cycle,
    stage: "OFFICIAL_IDENTITY",
    transition: "COMPLETED",
    readPath: "OFFICIAL_IDENTITY",
    evidenceKind: "OFFICIAL_SOURCE",
    failureFingerprint: "IDENTITY:CURRENT",
    runtimeVersion: "test-runtime",
    observedAt
  });
  ledger = appendAutomationPlaybookEvent(ledger, {
    cycle,
    stage: "TYPED_ADAPTER",
    transition: "FAILED_TERMINAL",
    readPath: "TYPED_PROVIDER_ADAPTER",
    evidenceKind: "PROVIDER_RESPONSE",
    failureClass: "NOT_FOUND",
    failureFingerprint: "ADAPTER:NOT_FOUND",
    runtimeVersion: "test-runtime",
    observedAt
  });
  ledger = appendAutomationPlaybookEvent(ledger, {
    cycle,
    stage: "OFFICIAL_HTTP_DISCOVERY",
    transition: "COMPLETED",
    readPath: "OFFICIAL_HTTP",
    evidenceKind: "OFFICIAL_SOURCE",
    failureFingerprint: "HTTP:COMPLETE",
    runtimeVersion: "test-runtime",
    observedAt
  });
  return appendAutomationPlaybookEvent(ledger, {
    cycle,
    stage: "HTTP_ADAPTER_RETRY",
    transition: "FAILED_TERMINAL",
    readPath: "TYPED_PROVIDER_ADAPTER",
    evidenceKind: "PROVIDER_RESPONSE",
    failureClass: "NOT_FOUND",
    failureFingerprint: "ADAPTER:NOT_FOUND",
    runtimeVersion: "test-runtime",
    observedAt
  });
}

const browserDiscoveryParentUpdatedAt = new Date("2026-08-31T00:00:00.001Z");
const providerObservationLease = {
  courseId: "course-owned-browser",
  leaseToken: "provider-observation-owned-browser",
  observationStartedAt: new Date("2026-08-22T12:00:00.000Z"),
  leaseExpiresAt: new Date("2026-08-22T12:20:00.000Z"),
  ttlMs: 20 * 60_000,
  supersededUnresolvedObservationStartedAt: null,
};

function providerDiscoveryFor(courseId: string) {
  const sourceUrl = `https://${courseId}.example.com/`;
  return {
    courseId,
    status: "FAILED" as const,
    detectedPlatform: "UNKNOWN" as const,
    sourceUrl,
    confidence: 0,
    evidence: {
      learnedFrom: "official-site-fetch-failed",
      observedUrls: [sourceUrl],
      visibleText: "Provider unavailable",
    },
  };
}

describe("browser discovery persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (worker) =>
      worker(mockedPrisma as never)
    );
    mockedPrisma.$queryRaw.mockResolvedValue([
      { updatedAt: browserDiscoveryParentUpdatedAt }
    ] as never);
    mockedPrisma.$queryRawUnsafe.mockResolvedValue([] as never);
    mockedPrisma.courseSupportIncident.findMany.mockResolvedValue([]);
    mockedPrisma.courseSupportIncident.findUnique.mockResolvedValue(null);
    mockedPrisma.courseMonitoringEvent.findFirst.mockResolvedValue(null);
    mockedPrisma.courseSupportBatch.findFirst.mockResolvedValue(null);
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 0 } as never);
    mockedPrisma.teeTimeMatch.updateMany.mockResolvedValue({ count: 0 } as never);
    providerExecutionMarkerMocks.renewCourseProviderObservationInTransaction.mockResolvedValue(
      true,
    );
  });

  it("does not record failed landing evidence after a successor takes the provider marker", async () => {
    const courseId = "lost-failed-discovery-marker";
    const observation = { ...providerObservationLease, courseId };
    providerExecutionMarkerMocks.renewCourseProviderObservationInTransaction.mockResolvedValueOnce(
      false,
    );

    await expect(
      recordBrowserDiscovery(
        providerDiscoveryFor(courseId) as never,
        undefined,
        undefined,
        undefined,
        observation.observationStartedAt,
        observation,
      ),
    ).rejects.toThrow(
      "Provider observation ownership expired before discovery persistence completed",
    );

    expect(mockedPrisma.courseAutomationDiscovery.create).not.toHaveBeenCalled();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("does not apply landing evidence after a successor takes the provider marker", async () => {
    const courseId = "lost-landing-apply-marker";
    const observation = { ...providerObservationLease, courseId };
    providerExecutionMarkerMocks.renewCourseProviderObservationInTransaction.mockResolvedValueOnce(
      false,
    );

    await expect(
      recordAndApplyBrowserDiscoveryToCourse(
        providerDiscoveryFor(courseId) as never,
        undefined,
        undefined,
        {
          observedAt: observation.observationStartedAt,
          providerObservation: observation,
        },
      ),
    ).rejects.toThrow(
      "Provider observation ownership expired before discovery persistence completed",
    );

    expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.courseAutomationDiscovery.create).not.toHaveBeenCalled();
  });

  it("does not retire a legacy policy projection after a successor takes the provider marker", async () => {
    const courseId = "lost-legacy-retirement-marker";
    const observation = { ...providerObservationLease, courseId };
    providerExecutionMarkerMocks.renewCourseProviderObservationInTransaction.mockResolvedValueOnce(
      false,
    );

    await expect(
      retireLegacyPolicyOnlyCourseBlock(
        courseId,
        {
          updatedAt: new Date("2026-08-22T11:00:00.000Z"),
          detectedBookingUrl: "https://booking.example.com/tee-times",
          bookingMethod: "PUBLIC_ONLINE",
          automationEligibility: "BLOCKED",
        } as never,
        {
          preserveWebsite: true,
          preserveDetectedBookingUrl: true,
          preserveBookingMetadata: true,
        },
        undefined,
        observation.observationStartedAt,
        observation,
      ),
    ).rejects.toThrow(
      "Provider observation ownership expired before discovery persistence completed",
    );

    expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.courseAutomationDiscovery.create).not.toHaveBeenCalled();
  });

  it("does not apply a recovered official website after a successor takes the provider marker", async () => {
    const courseId = "lost-official-website-marker";
    const observation = { ...providerObservationLease, courseId };
    providerExecutionMarkerMocks.renewCourseProviderObservationInTransaction.mockResolvedValueOnce(
      false,
    );

    await expect(
      applyRecoveredOfficialWebsiteToCourse({
        courseId,
        website: "https://municipal.example.com/golf",
        expectedUpdatedAt: new Date("2026-08-22T11:00:00.000Z"),
        observedAt: observation.observationStartedAt,
        providerObservation: observation,
      }),
    ).rejects.toThrow(
      "Provider observation ownership expired before discovery persistence completed",
    );

    expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.courseAutomationDiscovery.create).not.toHaveBeenCalled();
  });

  it("records browser evidence and learned API metadata", async () => {
    mockedPrisma.courseAutomationDiscovery.create.mockResolvedValue({
      id: "discovery-1"
    } as never);

    await recordBrowserDiscovery({
      courseId: "course-1",
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://course.example.com",
      bookingUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
      apiEndpoint: "https://foreupsoftware.com/index.php/api/booking/times",
      apiMetadata: {
        scheduleId: 11739,
        bookingClassId: 22739,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "foreup-api-request",
        observedUrls: ["https://foreupsoftware.com/index.php/api/booking/times?schedule_id=11739"]
      }
    });

    expect(mockedPrisma.courseAutomationDiscovery.create).toHaveBeenCalledWith({
      data: {
        courseId: "course-1",
        status: "LEARNED",
        detectedPlatform: "FOREUP",
        bookingMethod: "PUBLIC_ONLINE",
        bookingPhone: undefined,
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        bookingAccessMode: "PUBLIC_SIGNED_OUT",
        sourceUrl: "https://course.example.com",
        bookingUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
        apiEndpoint: "https://foreupsoftware.com/index.php/api/booking/times",
        apiMetadata: {
          scheduleId: 11739,
          bookingClassId: 22739,
          bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
        },
        confidence: 0.95,
        evidence: {
          learnedFrom: "foreup-api-request",
          observedUrls: ["https://foreupsoftware.com/index.php/api/booking/times?schedule_id=11739"]
        }
      }
    });
  });

  it("persists an exact recovered official website only onto the expected empty snapshot", async () => {
    const expectedUpdatedAt = new Date("2026-08-19T11:00:00.000Z");
    const observedAt = new Date("2026-08-19T11:01:00.000Z");
    const current = {
      id: "course-source-missing",
      name: "Source Missing Golf Course",
      timeZone: "America/Denver",
      website: null,
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "UNKNOWN",
      automationEligibility: "UNKNOWN",
      automationReason: "NONE",
      monitoringMode: "AUTOMATIC",
      bookingAccessMode: "UNKNOWN",
      isPublic: true,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
      monitoringStatus: null,
      supportIncident: null,
      updatedAt: expectedUpdatedAt
    };
    const applied = {
      ...current,
      website: "https://municipal.example/golf",
      updatedAt: new Date("2026-08-19T11:01:01.000Z")
    };
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce(current as never)
      .mockResolvedValueOnce(applied as never);
    mockedPrisma.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    await expect(
      applyRecoveredOfficialWebsiteToCourse({
        courseId: current.id,
        website: applied.website,
        expectedUpdatedAt,
        expectedUnownedIncident: {
          id: "incident-source-missing",
          cycle: 3,
          revision: 7,
          status: "NEEDS_HUMAN"
        },
        observedAt
      })
    ).resolves.toEqual({ ...applied, updatedAt: browserDiscoveryParentUpdatedAt });

    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: {
        id: current.id,
        updatedAt: expectedUpdatedAt,
        website: null
      },
      data: { website: applied.website }
    });
    expect(mockedPrisma.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-source-missing",
        courseId: current.id,
        cycle: 3,
        revision: 7,
        status: "NEEDS_HUMAN",
        activeBatchId: null
      },
      data: { revision: { increment: 0 } }
    });
    expect(mockedPrisma.courseAutomationDiscovery.create).toHaveBeenCalledWith({
      data: {
        courseId: current.id,
        status: "INSPECTED",
        detectedPlatform: "UNKNOWN",
        bookingMethod: "UNKNOWN",
        automationEligibility: "UNKNOWN",
        automationReason: "NONE",
        bookingAccessMode: "UNKNOWN",
        sourceUrl: applied.website,
        bookingUrl: null,
        confidence: 0.9,
        createdAt: observedAt,
        evidence: {
          learnedFrom: "google-places-official-website",
          observedUrls: [applied.website],
          courseProjectionApplied: true,
          customerDataIncluded: false
        }
      }
    });
  });

  it("does not replace an already persisted official website", async () => {
    const expectedUpdatedAt = new Date("2026-08-19T11:00:00.000Z");
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      website: "https://existing.example/golf",
      monitoringStatus: null,
      supportIncident: null,
      updatedAt: expectedUpdatedAt
    } as never);

    await expect(
      applyRecoveredOfficialWebsiteToCourse({
        courseId: "course-existing-source",
        website: "https://replacement.example/golf",
        expectedUpdatedAt
      })
    ).resolves.toBeNull();

    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.courseAutomationDiscovery.create).not.toHaveBeenCalled();
  });

  it("applies learned ForeUP metadata to the reusable course adapter fields", async () => {
    const updatedAt = new Date("2026-07-16T12:00:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "FOREUP",
        detectedPlatform: "FOREUP",
        detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
        website: "https://course.example.com",
        bookingMetadata: null,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "course-1" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    await applyBrowserDiscoveryToCourse({
      courseId: "course-1",
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://course.example.com",
      bookingUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
      apiMetadata: {
        scheduleId: 11739,
        bookingClassId: 22739,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "foreup-api-request",
        observedUrls: []
      }
    });

    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: { id: "course-1", updatedAt },
      data: {
        providerFamilyKey: "FOREUP",
        detectedPlatform: "FOREUP",
        automationEligibility: "ALLOWED",
        detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
        bookingMetadata: {
          scheduleId: 11739,
          bookingClassId: 22739,
          bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
        },
        bookingMethod: "PUBLIC_ONLINE",
        bookingAccessMode: "PUBLIC_SIGNED_OUT",
        bookingPhone: undefined,
        automationReason: "NONE",
        policyNotes: undefined,
        intelligenceVerifiedAt: expect.any(Date),
        intelligenceReviewAt: null,
        intelligenceConfidence: 0.95
      }
    });
    expectCompleteProviderExecutionEvidenceSelect(
      mockedPrisma.course.findUnique.mock.calls[0]?.[0]
    );
  });

  it("does not reopen monitoring for an immaterial discovery refresh on a verified-layout course", async () => {
    const updatedAt = new Date("2026-08-18T18:00:00.000Z");
    const layoutHolesVerifiedAt = new Date("2026-07-15T19:40:00.000Z");
    const bookingMetadata = {
      scheduleId: 11739,
      bookingClassId: 22739,
      bookingBaseUrl:
        "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
    };
    const current = {
      id: "course-verified-layout",
      name: "Verified Layout Golf Course",
      timeZone: "America/New_York",
      website: "https://course.example.com",
      detectedBookingUrl:
        "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
      detectedPlatform: "FOREUP",
      providerFamilyKey: "FOREUP",
      bookingMethod: "PUBLIC_ONLINE",
      bookingWindowDaysAhead: null,
      bookingWindowEvidenceUrl: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      monitoringMode: "AUTOMATIC",
      bookingAccessMode: "PUBLIC_SIGNED_OUT",
      isPublic: true,
      intelligenceVerifiedAt: new Date("2026-08-17T18:00:00.000Z"),
      intelligenceReviewAt: null,
      intelligenceConfidence: 0.95,
      bookingMetadata,
      layoutHoleCounts: [18],
      layoutHolesVerifiedAt,
      updatedAt
    };
    const applied = {
      ...current,
      intelligenceVerifiedAt: new Date("2026-08-18T18:01:00.000Z"),
      updatedAt: new Date("2026-08-18T18:01:00.000Z")
    };
    mockedPrisma.course.findUnique
      .mockImplementationOnce(async (query) => {
        const select = (query as { select?: Record<string, unknown> }).select;
        return Object.fromEntries(
          Object.entries(current).filter(([field]) => select?.[field] === true)
        ) as never;
      })
      .mockResolvedValueOnce(applied as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    await expect(
      applyBrowserDiscoveryToCourse({
        courseId: current.id,
        status: "LEARNED",
        detectedPlatform: "FOREUP",
        sourceUrl: current.website,
        bookingUrl: current.detectedBookingUrl,
        apiMetadata: bookingMetadata,
        confidence: current.intelligenceConfidence,
        evidence: {
          learnedFrom: "foreup-api-request",
          observedUrls: []
        }
      })
    ).resolves.toEqual(applied);

    expectCompleteProviderExecutionEvidenceSelect(
      mockedPrisma.course.findUnique.mock.calls[0]?.[0]
    );
    expect(mockedPrisma.courseSupportIncident.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.courseMonitoringStatus.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.courseMonitoringEvent.create).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("does not persist failed discovery evidence after unowned incident state changes", async () => {
    mockedPrisma.courseSupportIncident.updateMany.mockResolvedValue({ count: 0 } as never);

    await expect(
      recordBrowserDiscovery(
        {
          courseId: "course-1",
          status: "FAILED",
          detectedPlatform: "UNKNOWN",
          sourceUrl: "https://course.example.com",
          confidence: 0,
          evidence: {
            learnedFrom: "official-site-fetch-failed",
            observedUrls: []
          }
        },
        undefined,
        undefined,
        {
          id: "incident-1",
          cycle: 2,
          revision: 6,
          status: "NEEDS_HUMAN"
        }
      )
    ).resolves.toBeNull();

    expect(mockedPrisma.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        courseId: "course-1",
        cycle: 2,
        revision: 6,
        status: "NEEDS_HUMAN",
        activeBatchId: null
      },
      data: { revision: { increment: 0 } }
    });
    expect(mockedPrisma.courseAutomationDiscovery.create).not.toHaveBeenCalled();
  });

  it("does not persist evidence or change a course when responder ownership appears after cohort selection", async () => {
    mockedPrisma.courseSupportIncident.updateMany.mockResolvedValue({
      count: 0,
    } as never);

    await expect(
      recordAndApplyBrowserDiscoveryToCourse(
        {
          courseId: "course-1",
          status: "LEARNED",
          detectedPlatform: "FOREUP",
          sourceUrl: "https://course.example.com",
          bookingUrl:
            "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
          apiMetadata: {
            scheduleId: 11739,
            bookingClassId: 22739,
            bookingBaseUrl:
              "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
          },
          confidence: 0.95,
          evidence: { learnedFrom: "foreup-api-request", observedUrls: [] },
        },
        undefined,
        {
          id: "incident-1",
          cycle: 2,
          revision: 6,
          status: "NEEDS_HUMAN",
        },
      ),
    ).resolves.toBeNull();

    expect(mockedPrisma.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        courseId: "course-1",
        cycle: 2,
        revision: 6,
        status: "NEEDS_HUMAN",
        activeBatchId: null,
      },
      data: { revision: { increment: 0 } },
    });
    expect(mockedPrisma.courseAutomationDiscovery.create).not.toHaveBeenCalled();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("does not retire a legacy policy block after responder ownership appears", async () => {
    const updatedAt = new Date("2026-08-18T17:20:00.000Z");
    mockedPrisma.course.findUnique.mockResolvedValueOnce({ id: "course-1" } as never);
    mockedPrisma.courseSupportIncident.updateMany.mockResolvedValue({ count: 0 } as never);

    await expect(
      retireLegacyPolicyOnlyCourseBlock(
        "course-1",
        {
          updatedAt,
          detectedBookingUrl: null,
          bookingMethod: "UNKNOWN",
          automationEligibility: "BLOCKED"
        },
        {
          preserveWebsite: false,
          preserveDetectedBookingUrl: false,
          preserveBookingMetadata: false
        },
        {
          id: "incident-1",
          cycle: 2,
          revision: 6,
          status: "NEEDS_HUMAN"
        }
      )
    ).resolves.toBeNull();

    expect(mockedPrisma.courseSupportIncident.updateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        courseId: "course-1",
        cycle: 2,
        revision: 6,
        status: "NEEDS_HUMAN",
        activeBatchId: null
      },
      data: { revision: { increment: 0 } }
    });
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("atomically opens a fresh human-review cycle when learned adapter metadata changes", async () => {
    const updatedAt = new Date("2026-08-11T12:00:00.000Z");
    const observedAt = new Date("2026-08-10T11:00:00.000Z");
    const current = {
      id: "course-1",
      name: "Public Course",
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl:
        "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
      website: "https://course.example.com",
      bookingMetadata: {
        scheduleId: 11739,
        parserVersion: 1,
        bookingBaseUrl:
          "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
      },
      isPublic: true,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      bookingAccessMode: "PUBLIC_SIGNED_OUT",
      monitoringMode: "AUTOMATIC",
      intelligenceVerifiedAt: updatedAt,
      intelligenceReviewAt: null,
      intelligenceConfidence: 0.95,
      updatedAt
    };
    const applied = {
      ...current,
      bookingMetadata: {
        ...current.bookingMetadata,
        parserVersion: 2
      },
      intelligenceVerifiedAt: observedAt,
      updatedAt: new Date("2026-08-11T12:01:00.000Z")
    };
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce(current as never)
      .mockResolvedValueOnce(applied as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-1",
      cycle: 3,
      revision: 8,
      status: "NEEDS_HUMAN",
      activeBatchId: null,
      activeRealSearchCount: 1,
      failureFingerprint: "FOREUP:SCHEMA",
      humanReviewReason: "OTHER_TECHNICAL_LIMITATION",
      resolution: null
    } as never);
    mockedPrisma.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 4
    } as never);
    mockedPrisma.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    mockedPrisma.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.courseMonitoringStatus.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 1 } as never);

    await expect(
      applyBrowserDiscoveryToCourse(
        {
          courseId: "course-1",
          status: "LEARNED",
          detectedPlatform: "FOREUP",
          sourceUrl: "https://course.example.com",
          bookingUrl:
            "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
          apiMetadata: applied.bookingMetadata,
          confidence: 0.97,
          evidence: {
            learnedFrom: "foreup-api-request",
            observedUrls: []
          }
        },
        undefined,
        undefined,
        undefined,
        undefined,
        observedAt
      )
    ).resolves.toEqual(applied);

    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ intelligenceVerifiedAt: observedAt })
      })
    );
    expect(mockedPrisma.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "incident-1", cycle: 3 }),
        data: expect.objectContaining({
          cycle: { increment: 1 },
          status: "AUTO_INVESTIGATING"
        })
      })
    );
    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledOnce();
    expect(mockedPrisma.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "REVALIDATION_REQUESTED",
        occurredAt: observedAt,
        idempotencyKey: expect.stringMatching(/^course-provider-evidence-revalidate:/u),
        audit: expect.objectContaining({
          priorCycle: 3,
          cycle: 4,
          changedFields: ["bookingMetadata"]
        })
      })
    });
  });

  it("rejects a materially future browser observation before persistence", async () => {
    const futureObservedAt = new Date(Date.now() + 5 * 60 * 1000);

    await expect(
      applyBrowserDiscoveryToCourse(
        {
          courseId: "course-future-observation",
          status: "LEARNED",
          detectedPlatform: "FOREUP",
          sourceUrl: "https://course.example.com",
          bookingUrl:
            "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
          confidence: 0.95,
          evidence: { learnedFrom: "foreup-api-request", observedUrls: [] }
        },
        undefined,
        undefined,
        undefined,
        undefined,
        futureObservedAt
      )
    ).rejects.toThrow("Browser discovery observedAt must be a valid non-future date");

    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
  });

  it("applies learned Chronogolf metadata to the reusable course adapter fields", async () => {
    const updatedAt = new Date("2026-07-16T12:00:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "CHRONOGOLF",
        detectedPlatform: "CHRONOGOLF",
        detectedBookingUrl: "https://www.chronogolf.com/club/blue-rock-golf-course",
        website: "https://bluerockgolfcourse.com/",
        bookingMetadata: null,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "blue-rock" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    await applyBrowserDiscoveryToCourse({
      courseId: "blue-rock",
      status: "LEARNED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://bluerockgolfcourse.com/",
      bookingUrl: "https://www.chronogolf.com/club/blue-rock-golf-course",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiEndpoint: "https://www.chronogolf.com/marketplace/v2/teetimes",
      apiMetadata: {
        clubId: 7221,
        courseIds: ["7657db51-4e0c-4bc7-8e98-bd0a705370af"],
        bookingBaseUrl: "https://www.chronogolf.com/club/blue-rock-golf-course"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "chronogolf-public-club-profile",
        observedUrls: []
      }
    });

    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "blue-rock", updatedAt },
        data: expect.objectContaining({
          detectedPlatform: "CHRONOGOLF",
          automationEligibility: "ALLOWED",
          bookingMethod: "PUBLIC_ONLINE",
          bookingMetadata: {
            clubId: 7221,
            courseIds: ["7657db51-4e0c-4bc7-8e98-bd0a705370af"],
            bookingBaseUrl: "https://www.chronogolf.com/club/blue-rock-golf-course"
          }
        })
      })
    );
  });

  it("persists only known provider identity from an inspected booking surface", async () => {
    const updatedAt = new Date("2026-07-16T12:00:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "bluerockgolfcourse.com",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: "https://bluerockgolfcourse.com/book-a-tee-time",
        website: "https://bluerockgolfcourse.com/",
        bookingMetadata: null,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "blue-rock" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    await applyBrowserDiscoveryToCourse({
      courseId: "blue-rock",
      status: "INSPECTED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://bluerockgolfcourse.com/",
      bookingUrl: "https://www.chronogolf.com/club/blue-rock-golf-course",
      confidence: 0.45,
      evidence: {
        learnedFrom: "browser-visible-links",
        observedUrls: ["https://www.chronogolf.com/club/blue-rock-golf-course"]
      }
    });

    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: { id: "blue-rock", updatedAt },
      data: {
        detectedPlatform: "CHRONOGOLF",
        providerFamilyKey: "CHRONOGOLF",
        detectedBookingUrl: "https://www.chronogolf.com/club/blue-rock-golf-course"
      }
    });
    expectCompleteProviderExecutionEvidenceSelect(
      mockedPrisma.course.findUnique.mock.calls[0]?.[0]
    );
  });

  it("persists EZLinks identity without marking the course runnable", async () => {
    const updatedAt = new Date("2026-07-16T12:00:00.000Z");
    const providerUrl = "https://public-course.ezlinksgolf.com/";
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "public-course.example",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: "https://public-course.example/book-now/",
        website: "https://public-course.example/",
        bookingMetadata: null,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "public-course" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    await applyBrowserDiscoveryToCourse({
      courseId: "public-course",
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      sourceUrl: "https://public-course.example/",
      bookingUrl: providerUrl,
      confidence: 0.45,
      evidence: {
        learnedFrom: "browser-visible-links",
        observedUrls: [providerUrl]
      }
    });

    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: { id: "public-course", updatedAt },
      data: {
        detectedPlatform: "CUSTOM",
        providerFamilyKey: "EZLINKS",
        detectedBookingUrl: providerUrl
      }
    });
  });

  it("does not apply a stale inspected identity after the course changed", async () => {
    const updatedAt = new Date("2026-07-16T12:00:00.000Z");
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      providerFamilyKey: "course.example.com",
      detectedPlatform: "UNKNOWN",
      detectedBookingUrl: "https://course.example.com/book-a-tee-time",
      website: "https://course.example.com/",
      bookingMetadata: null,
      updatedAt
    } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 0 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-1",
      status: "INSPECTED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://course.example.com/",
      bookingUrl: "https://www.chronogolf.com/club/example-course",
      confidence: 0.95,
      evidence: { learnedFrom: "browser-visible-links", observedUrls: [] }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "course-1", updatedAt } })
    );
  });

  it("rejects a platform label that is not corroborated by the selected booking URL", async () => {
    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-1",
      status: "INSPECTED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://course.example.com/",
      bookingUrl: "https://course.example.com/book-a-tee-time",
      confidence: 0.95,
      evidence: { learnedFrom: "browser-visible-links", observedUrls: [] }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("does not persist an unrecognized inspected official-site host", async () => {
    const result = await applyBrowserDiscoveryToCourse({
      courseId: "unknown-course",
      status: "INSPECTED",
      detectedPlatform: "UNKNOWN",
      sourceUrl: "https://course.example.com/",
      bookingUrl: "https://course.example.com/book-a-tee-time",
      confidence: 0.45,
      evidence: {
        learnedFrom: "browser-visible-links",
        observedUrls: ["https://course.example.com/book-a-tee-time"]
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
  });

  it("does not apply an unverified owner source candidate from a known provider", async () => {
    const discovery = buildBrowserDiscovery({
      courseId: "target-course",
      courseName: "Target Golf Club",
      sourceUrl: "https://foreupsoftware.com/index.php/booking/22687/11624",
      finalUrl: "https://foreupsoftware.com/index.php/booking/22687/11624",
      observedUrls: [
        "https://foreupsoftware.com/index.php/booking/22687/11624",
      ],
      unprojectedSourceCandidate: true,
      sourceCandidateIdentityVerified: false,
    });

    await expect(applyBrowserDiscoveryToCourse(discovery)).resolves.toBeNull();
    expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("retains Arthur B. Sim's exact official MemberSports link without granting runnable support", async () => {
    const updatedAt = new Date("2026-08-20T12:00:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        name: "Arthur B. Sim Golf Course",
        providerFamilyKey: "wichita.gov",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: null,
        website: arthurSimOfficialUrl,
        bookingMetadata: null,
        isPublic: true,
        bookingMethod: "UNKNOWN",
        automationEligibility: "NEEDS_REVIEW",
        automationReason: "UNSUPPORTED_PLATFORM",
        bookingAccessMode: "UNKNOWN",
        monitoringStatus: { state: "ENGINEERING_NEEDED" },
        supportIncident: { resolution: null },
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "arthur-sim" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "arthur-sim",
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      sourceUrl: arthurSimOfficialUrl,
      bookingUrl: arthurSimMemberSportsUrl,
      confidence: 0.8,
      evidence: {
        learnedFrom: "official-course-non-runnable-booking-link",
        observedUrls: [arthurSimOfficialUrl, arthurSimMemberSportsUrl],
        bookingCallToAction: true,
        courseIdentityCorroboration: arthurSimNonRunnableLinkProof
      }
    });

    expect(result).toEqual({ id: "arthur-sim" });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: { id: "arthur-sim", updatedAt },
      data: {
        detectedPlatform: "CUSTOM",
        providerFamilyKey: "MEMBERSPORTS",
        detectedBookingUrl: arthurSimMemberSportsUrl
      }
    });
    expectCompleteProviderExecutionEvidenceSelect(
      mockedPrisma.course.findUnique.mock.calls[0]?.[0]
    );
  });

  it("does not persist an exact MemberSports route without official course corroboration", async () => {
    const result = await applyBrowserDiscoveryToCourse({
      courseId: "arthur-sim",
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      sourceUrl: arthurSimOfficialUrl,
      bookingUrl: arthurSimMemberSportsUrl,
      confidence: 0.95,
      evidence: {
        learnedFrom: "browser-visible-links",
        observedUrls: [arthurSimMemberSportsUrl]
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("upgrades a safe CUSTOM placeholder when stronger exact official CTA evidence arrives", async () => {
    const updatedAt = new Date("2026-08-20T12:01:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        name: "Arthur B. Sim Golf Course",
        providerFamilyKey: "wichita.gov",
        detectedPlatform: "CUSTOM",
        detectedBookingUrl: null,
        website: arthurSimOfficialUrl,
        bookingMetadata: null,
        isPublic: true,
        bookingMethod: "UNKNOWN",
        automationEligibility: "NEEDS_REVIEW",
        automationReason: "OTHER",
        bookingAccessMode: "UNKNOWN",
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "arthur-sim" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "arthur-sim",
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      sourceUrl: arthurSimOfficialUrl,
      bookingUrl: arthurSimMemberSportsUrl,
      confidence: 0.8,
      evidence: {
        learnedFrom: "official-course-non-runnable-booking-link",
        observedUrls: [arthurSimMemberSportsUrl],
        bookingCallToAction: true,
        courseIdentityCorroboration: arthurSimNonRunnableLinkProof
      }
    });

    expect(result).toEqual({ id: "arthur-sim" });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: { id: "arthur-sim", updatedAt },
      data: {
        detectedPlatform: "CUSTOM",
        providerFamilyKey: "MEMBERSPORTS",
        detectedBookingUrl: arthurSimMemberSportsUrl
      }
    });
  });

  it("rejects a broadly similar sibling-course name in official CTA proof", async () => {
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      name: "Arthur B. Sim Golf Course",
      providerFamilyKey: "wichita.gov",
      detectedPlatform: "UNKNOWN",
      detectedBookingUrl: null,
      website: arthurSimOfficialUrl,
      bookingMetadata: null,
      isPublic: true,
      bookingMethod: "UNKNOWN",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "UNSUPPORTED_PLATFORM",
      bookingAccessMode: "UNKNOWN",
      updatedAt: new Date("2026-08-20T12:02:00.000Z")
    } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "arthur-sim",
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      sourceUrl: arthurSimOfficialUrl,
      bookingUrl: arthurSimMemberSportsUrl,
      confidence: 0.8,
      evidence: {
        learnedFrom: "official-course-non-runnable-booking-link",
        observedUrls: [arthurSimMemberSportsUrl],
        bookingCallToAction: true,
        courseIdentityCorroboration: {
          ...arthurSimNonRunnableLinkProof,
          courseName: "Arthur B. Sim Golf Course at MacDonald Golf Course"
        }
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("does not combine an official non-runnable link with existing execution metadata", async () => {
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      name: "Arthur B. Sim Golf Course",
      providerFamilyKey: "wichita.gov",
      detectedPlatform: "UNKNOWN",
      detectedBookingUrl: null,
      website: arthurSimOfficialUrl,
      bookingMetadata: {
        scheduleId: 999,
        bookingBaseUrl: "https://unrelated.example/tee-times"
      },
      isPublic: true,
      bookingMethod: "UNKNOWN",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "UNSUPPORTED_PLATFORM",
      bookingAccessMode: "UNKNOWN",
      updatedAt: new Date("2026-08-20T12:00:00.000Z")
    } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "arthur-sim",
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      sourceUrl: arthurSimOfficialUrl,
      bookingUrl: arthurSimMemberSportsUrl,
      confidence: 0.8,
      evidence: {
        learnedFrom: "official-course-non-runnable-booking-link",
        observedUrls: [arthurSimMemberSportsUrl],
        bookingCallToAction: true,
        courseIdentityCorroboration: arthurSimNonRunnableLinkProof
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("does not overwrite a different current booking link with non-runnable CTA evidence", async () => {
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      name: "Arthur B. Sim Golf Course",
      providerFamilyKey: "wichita.gov",
      detectedPlatform: "UNKNOWN",
      detectedBookingUrl: "https://legacy-booking.example/arthur-sim",
      website: arthurSimOfficialUrl,
      bookingMetadata: null,
      isPublic: true,
      bookingMethod: "UNKNOWN",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "UNSUPPORTED_PLATFORM",
      bookingAccessMode: "UNKNOWN",
      updatedAt: new Date("2026-08-20T12:00:00.000Z")
    } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "arthur-sim",
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      sourceUrl: arthurSimOfficialUrl,
      bookingUrl: arthurSimMemberSportsUrl,
      confidence: 0.8,
      evidence: {
        learnedFrom: "official-course-non-runnable-booking-link",
        observedUrls: [arthurSimMemberSportsUrl],
        bookingCallToAction: true,
        courseIdentityCorroboration: arthurSimNonRunnableLinkProof
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "without exact course corroboration",
      bookingUrl: arthurSimMemberSportsUrl,
      observedUrls: [arthurSimMemberSportsUrl],
      courseIdentityCorroboration: undefined
    },
    {
      label: "with ambiguous destination evidence",
      bookingUrl: arthurSimMemberSportsUrl,
      observedUrls: [
        arthurSimMemberSportsUrl,
        "https://other-booking.example/tee-times/another-course"
      ],
      courseIdentityCorroboration: {
        ...arthurSimNonRunnableLinkProof,
        providerUrl: "https://other-booking.example/tee-times/another-course"
      }
    },
    {
      label: "with an untrusted credential-bearing destination",
      bookingUrl: "https://user:secret@app.membersports.com/tee-times/7128/8903/0/8/0",
      observedUrls: [
        "https://user:secret@app.membersports.com/tee-times/7128/8903/0/8/0"
      ],
      courseIdentityCorroboration: {
        ...arthurSimNonRunnableLinkProof,
        providerUrl:
          "https://user:secret@app.membersports.com/tee-times/7128/8903/0/8/0"
      }
    },
    {
      label: "with a truncated known-provider route",
      bookingUrl: "https://app.membersports.com/tee-times/7128/8903",
      observedUrls: ["https://app.membersports.com/tee-times/7128/8903"],
      courseIdentityCorroboration: {
        ...arthurSimNonRunnableLinkProof,
        providerUrl: "https://app.membersports.com/tee-times/7128/8903"
      }
    },
    {
      label: "with a non-tee-time known-provider route",
      bookingUrl: "https://app.membersports.com/reservations/arthur-sim",
      observedUrls: ["https://app.membersports.com/reservations/arthur-sim"],
      courseIdentityCorroboration: {
        ...arthurSimNonRunnableLinkProof,
        providerUrl: "https://app.membersports.com/reservations/arthur-sim"
      }
    }
  ])("rejects an official non-runnable booking link $label", async (testCase) => {
    const result = await applyBrowserDiscoveryToCourse({
      courseId: "arthur-sim",
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      sourceUrl: arthurSimOfficialUrl,
      bookingUrl: testCase.bookingUrl,
      confidence: 0.8,
      evidence: {
        learnedFrom: "official-course-non-runnable-booking-link",
        observedUrls: testCase.observedUrls,
        bookingCallToAction: true,
        ...(testCase.courseIdentityCorroboration
          ? { courseIdentityCorroboration: testCase.courseIdentityCorroboration }
          : {})
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("persists the exact built soft-404 classification without rewriting provider fields", async () => {
    const updatedAt = new Date("2026-07-21T12:00:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "eastwood.example",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: null,
        website: "http://eastwood.example/",
        bookingMetadata: null,
        isPublic: true,
        bookingMethod: "UNKNOWN",
        automationEligibility: "UNKNOWN",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "eastwood" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);
    const discovery = buildBrowserDiscovery({
      courseId: "eastwood",
      courseName: "Eastwood Country Club",
      sourceUrl: "http://eastwood.example/?campaign=stale#top",
      finalUrl: "https://www.eastwood.example/",
      sourcePageAvailability: "SOFT_NOT_FOUND",
      observedUrls: ["https://unrelated.example/book-tee-times"]
    });

    const result = await applyBrowserDiscoveryToCourse(discovery);

    expect(result).toEqual({ id: "eastwood" });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledOnce();
    const update = mockedPrisma.course.updateMany.mock.calls[0]?.[0];
    expect(update).toEqual({
      where: { id: "eastwood", updatedAt },
      data: {
        automationEligibility: "NEEDS_REVIEW",
        bookingMethod: "UNKNOWN",
        automationReason: "TEMPORARILY_UNAVAILABLE",
        policyNotes:
          "The saved official course site currently serves a not-found page and exposes no trustworthy public booking surface. Tee Time Spot will retry discovery without following unrelated page links.",
        intelligenceVerifiedAt: expect.any(Date),
        intelligenceReviewAt: expect.any(Date),
        intelligenceConfidence: 0.98
      }
    });
    expect(update?.data).not.toHaveProperty("providerFamilyKey");
    expect(update?.data).not.toHaveProperty("detectedPlatform");
    expect(update?.data).not.toHaveProperty("detectedBookingUrl");
    expect(update?.data).not.toHaveProperty("bookingMetadata");
    expect(update?.data).not.toHaveProperty("bookingPhone");
  });

  it.each([
    {
      label: "runnable provider state",
      current: {
        providerFamilyKey: "FOREUP",
        detectedPlatform: "FOREUP",
        detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
        bookingMetadata: {
          scheduleId: 11739,
          bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
        },
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED"
      }
    },
    {
      label: "different unsupported provider family",
      current: {
        providerFamilyKey: "unrelated-provider.example",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: null,
        bookingMetadata: null,
        bookingMethod: "UNKNOWN",
        automationEligibility: "UNKNOWN"
      }
    }
  ])("does not let a soft-404 classification replace $label", async ({ current }) => {
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      ...current,
      website: "https://eastwood.example/",
      isPublic: true,
      automationReason: "NONE",
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      updatedAt: new Date("2026-07-21T12:00:00.000Z")
    } as never);
    const discovery = buildBrowserDiscovery({
      courseId: "eastwood",
      courseName: "Eastwood Country Club",
      sourceUrl: "https://eastwood.example/",
      finalUrl: "https://eastwood.example/",
      sourcePageAvailability: "SOFT_NOT_FOUND",
      observedUrls: []
    });

    const result = await applyBrowserDiscoveryToCourse(discovery);

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("applies a high-confidence phone-only finding without adapter metadata", async () => {
    const updatedAt = new Date("2026-07-16T12:00:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "fairviewfarmgc.com",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: null,
        website: "https://fairviewfarmgc.com/",
        bookingMetadata: null,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "fairview" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    await applyBrowserDiscoveryToCourse({
      courseId: "fairview",
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      bookingMethod: "PHONE_ONLY",
      bookingPhone: "(860) 689-1000",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      intelligenceReviewAt: "2026-10-10T00:00:00.000Z",
      sourceUrl: "https://fairviewfarmgc.com/",
      confidence: 1,
      evidence: {
        learnedFrom: "official-site-research",
        observedUrls: ["https://fairviewfarmgc.com/golf/"]
      }
    });

    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: { id: "fairview", updatedAt },
      data: {
        providerFamilyKey: "fairviewfarmgc.com",
        detectedPlatform: "UNKNOWN",
        automationEligibility: "BLOCKED",
        detectedBookingUrl: null,
        bookingMetadata: Prisma.DbNull,
        bookingMethod: "PHONE_ONLY",
        bookingAccessMode: "PHONE_ONLY",
        bookingPhone: "(860) 689-1000",
        automationReason: "NO_ONLINE_BOOKING",
        policyNotes: undefined,
        intelligenceVerifiedAt: expect.any(Date),
        intelligenceReviewAt: new Date("2026-10-10T00:00:00.000Z"),
        intelligenceConfidence: 1
      }
    });
  });

  it("preserves an official request page for a contact-course finding", async () => {
    const updatedAt = new Date("2026-08-04T12:00:00.000Z");
    const requestUrl = "https://greatrivergolfclub.com/member-for-a-day/";
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "greatrivergolfclub.com",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: null,
        website: "https://greatrivergolfclub.com/",
        bookingMetadata: null,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "great-river" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    await applyBrowserDiscoveryToCourse({
      courseId: "great-river",
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      bookingUrl: requestUrl,
      bookingMethod: "CONTACT_COURSE",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      sourceUrl: "https://greatrivergolfclub.com/",
      intelligenceReviewAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      confidence: 0.95,
      evidence: {
        learnedFrom: "official-public-play-request-form",
        observedUrls: [requestUrl]
      }
    });

    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: { id: "great-river", updatedAt },
      data: expect.objectContaining({
        detectedBookingUrl: requestUrl,
        bookingMethod: "CONTACT_COURSE",
        bookingAccessMode: "CONTACT_COURSE",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING"
      })
    });
  });

  it("records technical evidence without overwriting a previously runnable course as blocked", async () => {
    const updatedAt = new Date("2026-07-16T12:05:00.000Z");
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      website: "https://westwoodsgc.com/",
      bookingMetadata: {
        scheduleId: 6123,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      isPublic: true,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      intelligenceVerifiedAt: new Date("2026-07-15T12:00:00.000Z"),
      intelligenceReviewAt: null,
      intelligenceConfidence: 0.95,
      updatedAt
    } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "VERIFIED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl: "https://foreupsoftware.com/index.php/booking/22518#/teetimes",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "CAPTCHA_OR_QUEUE",
      intelligenceReviewAt: "2026-08-16T00:00:00.000Z",
      confidence: 0.95,
      evidence: {
        learnedFrom: "foreup-access-control",
        observedUrls: []
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("records a weak contact-only observation without erasing runnable provider evidence", async () => {
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      name: "Westwoods Golf Course",
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl:
        "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      website: "https://westwoodsgc.com/",
      bookingMetadata: {
        scheduleId: 6123,
        bookingBaseUrl:
          "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      isPublic: true,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      bookingAccessMode: "PUBLIC_SIGNED_OUT",
      intelligenceVerifiedAt: new Date("2026-08-19T12:00:00.000Z"),
      intelligenceReviewAt: null,
      intelligenceConfidence: 0.98,
      updatedAt: new Date("2026-08-19T12:00:00.000Z")
    } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      sourceUrl: "https://westwoodsgc.com/contact/",
      bookingUrl: "https://westwoodsgc.com/contact/",
      bookingMethod: "CONTACT_COURSE",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      intelligenceReviewAt: "2026-11-19T12:00:00.000Z",
      confidence: 0.92,
      evidence: {
        learnedFrom: "official-phone-reservation-contact",
        observedUrls: ["https://westwoodsgc.com/contact/"],
        finalUrl: "https://westwoodsgc.com/contact/"
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("allows explicit high-confidence phone-only proof to replace stale runnable metadata", async () => {
    const updatedAt = new Date("2026-08-01T12:00:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        name: "Westwoods Golf Course",
        timeZone: "America/New_York",
        providerFamilyKey: "FOREUP",
        detectedPlatform: "FOREUP",
        detectedBookingUrl:
          "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
        website: "https://westwoodsgc.com/",
        bookingMetadata: {
          scheduleId: 6123,
          bookingBaseUrl:
            "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
        },
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        bookingAccessMode: "PUBLIC_SIGNED_OUT",
        intelligenceVerifiedAt: new Date("2026-08-01T12:00:00.000Z"),
        intelligenceReviewAt: null,
        intelligenceConfidence: 0.98,
        monitoringStatus: null,
        supportIncident: null,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "course-westwoods" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      sourceUrl: "https://westwoodsgc.com/tee-times/",
      bookingUrl: "https://westwoodsgc.com/tee-times/",
      bookingMethod: "PHONE_ONLY",
      bookingPhone: "860-555-0100",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      intelligenceReviewAt: "2026-11-19T12:00:00.000Z",
      confidence: 0.98,
      evidence: {
        learnedFrom: "official-phone-only-tee-time-access",
        observedUrls: ["https://westwoodsgc.com/tee-times/"],
        finalUrl: "https://westwoodsgc.com/tee-times/"
      }
    });

    expect(result).toEqual({ id: "course-westwoods" });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "course-westwoods", updatedAt },
        data: expect.objectContaining({
          detectedPlatform: "UNKNOWN",
          providerFamilyKey: "westwoodsgc.com",
          detectedBookingUrl: null,
          bookingMetadata: Prisma.DbNull,
          bookingMethod: "PHONE_ONLY",
          bookingPhone: "860-555-0100"
        })
      })
    );
  });

  it("keeps a first browser challenge actionable while retaining learned metadata", async () => {
    const updatedAt = new Date("2026-07-16T12:06:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "westwoods.example",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: null,
        website: "https://westwoods.example/",
        bookingMetadata: null,
        isPublic: true,
        bookingMethod: "UNKNOWN",
        automationEligibility: "UNKNOWN",
        automationReason: "NONE",
        bookingAccessMode: "UNKNOWN",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "course-westwoods" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "VERIFIED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://westwoods.example/",
      bookingUrl:
        "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      apiMetadata: {
        bookingClassId: 22518,
        scheduleId: 6123,
        bookingBaseUrl:
          "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "CAPTCHA_OR_QUEUE",
      intelligenceReviewAt: new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      ).toISOString(),
      confidence: 0.95,
      evidence: {
        learnedFrom: "foreup-access-control",
        observedUrls: []
      }
    });

    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: { id: "course-westwoods", updatedAt },
      data: expect.objectContaining({
        providerFamilyKey: "FOREUP",
        detectedPlatform: "FOREUP",
        automationEligibility: "NEEDS_REVIEW",
        automationReason: "CAPTCHA_OR_QUEUE",
        bookingMethod: "PUBLIC_ONLINE",
        detectedBookingUrl:
          "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      })
    });
    expect(
      mockedPrisma.course.updateMany.mock.calls[0]?.[0].data
    ).not.toMatchObject({ automationEligibility: "BLOCKED" });
  });

  it("keeps the exact retained booking URL on a first managed-protection observation", async () => {
    const updatedAt = new Date("2026-08-24T12:00:00.000Z");
    const sourceUrl = "https://managed-query-course.example/";
    const retainedBookingUrl =
      "https://booking.nonrunnable-provider.example/tee-times?course=4477#calendar";
    const managedMarkerUrl =
      "https://booking.nonrunnable-provider.example/tee-times";
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "nonrunnable-provider.example",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: retainedBookingUrl,
        website: sourceUrl,
        bookingMetadata: null,
        isPublic: true,
        bookingMethod: "UNKNOWN",
        automationEligibility: "UNKNOWN",
        automationReason: "NONE",
        bookingAccessMode: "UNKNOWN",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null,
        monitoringStatus: null,
        supportIncident: null,
        updatedAt,
      } as never)
      .mockResolvedValueOnce({ id: "managed-query-course" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    const discovery = buildBrowserDiscovery({
      courseId: "managed-query-course",
      courseName: "Managed Query Golf Course",
      sourceUrl,
      officialCourseWebsite: sourceUrl,
      finalUrl: sourceUrl,
      observedUrls: [sourceUrl],
      retainedBookingTarget: {
        kind: "RETAINED_COURSE_BOOKING_TARGET",
        url: retainedBookingUrl,
      },
      renderedAccessControls: [
        {
          kind: "MANAGED_PROTECTION_DOCUMENT",
          scope: "RETAINED_ROOT",
          url: sourceUrl,
        },
        {
          kind: "MANAGED_PROTECTION_DOCUMENT",
          scope: "COURSE_SCOPED_BOOKING",
          url: managedMarkerUrl,
        },
      ],
    });

    expect(discovery).toMatchObject({
      status: "BLOCKED",
      detectedPlatform: "UNKNOWN",
      bookingUrl: retainedBookingUrl,
      automationEligibility: "BLOCKED",
      automationReason: "CAPTCHA_OR_QUEUE",
      evidence: {
        renderedAccessControls: [
          {
            kind: "MANAGED_PROTECTION_DOCUMENT",
            scope: "COURSE_SCOPED_BOOKING",
            url: managedMarkerUrl,
          },
        ],
      },
    });
    expect(JSON.stringify(discovery.evidence)).not.toContain("course=4477");
    expect(JSON.stringify(discovery.evidence)).not.toContain("#calendar");

    await applyBrowserDiscoveryToCourse(discovery);

    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: { id: "managed-query-course", updatedAt },
      data: expect.objectContaining({
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: retainedBookingUrl,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "NEEDS_REVIEW",
        automationReason: "CAPTCHA_OR_QUEUE",
      }),
    });
    expect(
      mockedPrisma.course.updateMany.mock.calls[0]?.[0].data.detectedBookingUrl,
    ).not.toBe(managedMarkerUrl);
    expect(
      mockedPrisma.course.updateMany.mock.calls[0]?.[0].data,
    ).not.toMatchObject({ automationEligibility: "BLOCKED" });
  });

  it("does not let discovery metadata alone overwrite a current technical final", async () => {
    const updatedAt = new Date("2026-07-16T12:05:00.000Z");
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22518#/teetimes",
      website: "https://westwoodsgc.com/",
      bookingMetadata: {
        scheduleId: 6123,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      isPublic: true,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "ACCOUNT_REQUIRED",
      ...currentIntelligenceEvidence(),
      intelligenceConfidence: 0.95,
      updatedAt
    } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl: "https://www.chronogolf.com/club/westwoods-golf-course",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        clubId: 7221,
        courseIds: ["westwoods-course"],
        bookingBaseUrl: "https://www.chronogolf.com/club/westwoods-golf-course"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "chronogolf-public-club-profile",
        observedUrls: [],
        courseIdentityCorroboration: chronogolfOfficialLinkProof
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("lets a corroborated cross-provider discovery replace stale known metadata", async () => {
    const updatedAt = new Date("2026-07-16T12:05:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "FOREUP",
        detectedPlatform: "FOREUP",
        detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
        website: "https://westwoodsgc.com/",
        bookingMetadata: {
          scheduleId: 6123,
          bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
        },
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED",
        intelligenceVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
        intelligenceReviewAt: new Date("2025-02-01T00:00:00.000Z"),
        intelligenceConfidence: 0.95,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "course-westwoods" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl: "https://www.chronogolf.com/club/westwoods-golf-course",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        clubId: 7221,
        courseIds: ["westwoods-course"],
        bookingBaseUrl: "https://www.chronogolf.com/club/westwoods-golf-course"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "chronogolf-public-club-profile",
        observedUrls: [],
        courseIdentityCorroboration: chronogolfOfficialLinkProof
      }
    });

    expect(result).toEqual({ id: "course-westwoods" });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "course-westwoods", updatedAt },
        data: expect.objectContaining({
          providerFamilyKey: "CHRONOGOLF",
          detectedPlatform: "CHRONOGOLF",
          automationEligibility: "ALLOWED",
          automationReason: "NONE"
        })
      })
    );
  });

  it("rejects provider-page self-attestation for cross-provider replacement", async () => {
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      website: "https://westwoodsgc.com/",
      bookingMetadata: {
        scheduleId: 6123,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      isPublic: true,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "ACCOUNT_REQUIRED",
      intelligenceVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
      intelligenceReviewAt: new Date("2025-02-01T00:00:00.000Z"),
      intelligenceConfidence: 0.95,
      updatedAt: new Date("2026-07-16T12:05:00.000Z")
    } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl: "https://www.chronogolf.com/club/westwoods-golf-course",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        clubId: 7221,
        courseIds: ["westwoods-course"],
        bookingBaseUrl: "https://www.chronogolf.com/club/westwoods-golf-course"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "chronogolf-public-club-profile",
        observedUrls: [],
        courseIdentityCorroboration: {
          kind: "OFFICIAL_COURSE_PROVIDER_LINK",
          officialWebsiteUrl: "https://westwoodsgc.com/",
          officialPageUrl: "https://www.chronogolf.com/club/westwoods-golf-course",
          providerUrl: "https://www.chronogolf.com/club/westwoods-golf-course"
        }
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("keeps current coherent provider metadata despite cross-provider corroboration", async () => {
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      website: "https://westwoodsgc.com/",
      bookingMetadata: {
        scheduleId: 6123,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      isPublic: true,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      ...currentIntelligenceEvidence(),
      intelligenceConfidence: 0.95,
      updatedAt: new Date("2026-07-16T12:05:00.000Z")
    } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl: "https://www.chronogolf.com/club/westwoods-golf-course",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        clubId: 7221,
        courseIds: ["westwoods-course"],
        bookingBaseUrl: "https://www.chronogolf.com/club/westwoods-golf-course"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "chronogolf-public-club-profile",
        observedUrls: [],
        courseIdentityCorroboration: chronogolfOfficialLinkProof
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("lets corroborated learned metadata replace stale conflicting provider evidence", async () => {
    const updatedAt = new Date("2026-07-16T12:07:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "GOLFNOW",
        detectedPlatform: "GOLFNOW",
        detectedBookingUrl: "https://www.golfnow.com/course/westwoods",
        website: "https://westwoodsgc.com/",
        bookingMetadata: {
          provider: "GOLFBACK",
          courseId: "123e4567-e89b-42d3-a456-426614174000",
          bookingBaseUrl: "https://golfback.com/#/course/123e4567-e89b-42d3-a456-426614174000"
        },
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED",
        intelligenceVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
        intelligenceReviewAt: new Date("2025-02-01T00:00:00.000Z"),
        intelligenceConfidence: 0.95,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "course-westwoods" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "CHRONOGOLF",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl: "https://www.chronogolf.com/club/westwoods-golf-course",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        clubId: 7221,
        courseIds: ["westwoods-course"],
        bookingBaseUrl: "https://www.chronogolf.com/club/westwoods-golf-course"
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "chronogolf-public-club-profile",
        observedUrls: [],
        courseIdentityCorroboration: chronogolfOfficialLinkProof
      }
    });

    expect(result).toEqual({ id: "course-westwoods" });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "course-westwoods", updatedAt },
        data: expect.objectContaining({ providerFamilyKey: "CHRONOGOLF" })
      })
    );
  });

  it("lets learned runnable metadata replace a stale manual final", async () => {
    const updatedAt = new Date("2026-07-16T12:05:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "FOREUP",
        detectedPlatform: "FOREUP",
        detectedBookingUrl: null,
        website: "https://westwoodsgc.com/",
        bookingMetadata: null,
        isPublic: true,
        bookingMethod: "PHONE_ONLY",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
        intelligenceVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
        intelligenceReviewAt: new Date("2025-02-01T00:00:00.000Z"),
        intelligenceConfidence: 0.95,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "course-westwoods" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        scheduleId: 6123,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      confidence: 0.95,
      evidence: { learnedFrom: "foreup-api-request", observedUrls: [] }
    });

    expect(result).toEqual({ id: "course-westwoods" });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "course-westwoods", updatedAt },
        data: expect.objectContaining({
          bookingMethod: "PUBLIC_ONLINE",
          automationEligibility: "ALLOWED",
          automationReason: "NONE"
        })
      })
    );
  });

  it("lets learned runnable metadata replace a stale technical final", async () => {
    const updatedAt = new Date("2026-07-16T12:06:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "FOREUP",
        detectedPlatform: "FOREUP",
        detectedBookingUrl: null,
        website: "https://westwoodsgc.com/",
        bookingMetadata: null,
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED",
        intelligenceVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
        intelligenceReviewAt: new Date("2025-02-01T00:00:00.000Z"),
        intelligenceConfidence: 0.95,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "course-westwoods" } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        scheduleId: 6123,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      confidence: 0.95,
      evidence: { learnedFrom: "foreup-api-request", observedUrls: [] }
    });

    expect(result).toEqual({ id: "course-westwoods" });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "course-westwoods", updatedAt },
        data: expect.objectContaining({
          bookingMethod: "PUBLIC_ONLINE",
          automationEligibility: "ALLOWED",
          automationReason: "NONE"
        })
      })
    );
  });

  it("does not let learned runnable metadata replace a current manual final", async () => {
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl: null,
      website: "https://westwoodsgc.com/",
      bookingMetadata: null,
      isPublic: true,
      bookingMethod: "CONTACT_COURSE",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      ...currentIntelligenceEvidence(),
      intelligenceConfidence: 0.95,
      updatedAt: new Date("2026-07-16T12:05:00.000Z")
    } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        scheduleId: 6123,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      confidence: 0.95,
      evidence: { learnedFrom: "foreup-api-request", observedUrls: [] }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["FINAL_MANUAL", null],
    ["FINAL_IDENTITY", null],
    ["AUTO_INVESTIGATING", "DIRECT_BOOKING_CLASSIFIED"],
    ["AUTO_INVESTIGATING", "IDENTITY_CLASSIFIED"]
  ])(
    "does not let automated discovery rewrite factual authority from %s / %s",
    async (state, resolution) => {
      mockedPrisma.course.findUnique.mockResolvedValueOnce({
        providerFamilyKey: "SOURCE_MISSING",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: null,
        website: "https://westwoodsgc.com/",
        bookingMetadata: null,
        isPublic: true,
        bookingMethod: "PHONE_ONLY",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
        bookingAccessMode: "PHONE_ONLY",
        intelligenceVerifiedAt: new Date("2026-08-19T12:00:00.000Z"),
        intelligenceReviewAt: null,
        intelligenceConfidence: 1,
        monitoringStatus: { state },
        supportIncident: { resolution },
        updatedAt: new Date("2026-08-19T12:00:00.000Z")
      } as never);

      await expect(
        applyBrowserDiscoveryToCourse({
          courseId: "course-operator-final",
          status: "LEARNED",
          detectedPlatform: "FOREUP",
          sourceUrl: "https://westwoodsgc.com/",
          bookingUrl:
            "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
          bookingMethod: "PUBLIC_ONLINE",
          automationEligibility: "ALLOWED",
          automationReason: "NONE",
          apiMetadata: {
            scheduleId: 6123,
            bookingBaseUrl:
              "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
          },
          confidence: 0.95,
          evidence: { learnedFrom: "foreup-api-request", observedUrls: [] }
        })
      ).resolves.toBeNull();

      expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
    }
  );

  it("appends contradictory discovery without changing an operator-final manual projection", async () => {
    const updatedAt = new Date("2026-08-19T12:00:00.000Z");
    mockedPrisma.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      providerFamilyKey: "SOURCE_MISSING",
      detectedPlatform: "UNKNOWN",
      detectedBookingUrl: null,
      website: "https://westwoodsgc.com/",
      bookingMetadata: null,
      isPublic: true,
      bookingMethod: "PHONE_ONLY",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      bookingAccessMode: "PHONE_ONLY",
      intelligenceVerifiedAt: updatedAt,
      intelligenceReviewAt: null,
      intelligenceConfidence: 1,
      monitoringStatus: { state: "FINAL_MANUAL" },
      supportIncident: { resolution: "DIRECT_BOOKING_CLASSIFIED" },
      updatedAt
    } as never);
    mockedPrisma.courseAutomationDiscovery.create.mockResolvedValue({
      id: "discovery-operator-final"
    } as never);

    await expect(
      recordAndApplyBrowserDiscoveryToCourse(
        {
          courseId: "course-operator-final",
          status: "LEARNED",
          detectedPlatform: "FOREUP",
          sourceUrl: "https://westwoodsgc.com/",
          bookingUrl:
            "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
          bookingMethod: "PUBLIC_ONLINE",
          automationEligibility: "ALLOWED",
          automationReason: "NONE",
          apiMetadata: {
            scheduleId: 6123,
            bookingBaseUrl:
              "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
          },
          confidence: 0.95,
          evidence: { learnedFrom: "foreup-api-request", observedUrls: [] }
        },
        {
          updatedAt,
          detectedBookingUrl: null,
          bookingMethod: "PHONE_ONLY",
          automationEligibility: "BLOCKED"
        },
        {
          id: "incident-operator-final",
          cycle: 2,
          revision: 6,
          status: "RESOLVED"
        },
        { observedAt: updatedAt }
      )
    ).resolves.toEqual({
      applied: null,
      discovery: { id: "discovery-operator-final" }
    });

    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.courseAutomationDiscovery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        courseId: "course-operator-final",
        status: "LEARNED",
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        createdAt: updatedAt
      })
    });
  });

  it.each([
    ["direct evidence", ""],
    ["legacy policy reconciliation", ":legacy-policy-reconciliation"]
  ])(
    "persists exact verified private identity from %s without fabricating public manual-booking facts",
    async (_label, provenanceSuffix) => {
      const updatedAt = new Date("2026-07-21T14:10:00.000Z");
      mockedPrisma.course.findUnique
        .mockResolvedValueOnce({
          name: "Deer Creek Golf Course",
          providerFamilyKey: "thelandings.com",
          detectedPlatform: "UNKNOWN",
          detectedBookingUrl: null,
          website: "https://thelandings.com/",
          bookingMetadata: null,
          isPublic: true,
          bookingMethod: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          automationReason: "NONE",
          intelligenceVerifiedAt: null,
          intelligenceReviewAt: null,
          intelligenceConfidence: null,
          updatedAt
        } as never)
        .mockResolvedValueOnce({ id: "deer-creek", isPublic: false } as never);
      mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);
      const sourceUrl = "https://thelandings.com/golf-and-athletic-club/golf/deer-creek";
      const discovery = buildBrowserDiscovery({
        courseId: "deer-creek",
        courseName: "Deer Creek Golf Course at The Landings Golf & Athletic Club",
        sourceUrl,
        finalUrl: sourceUrl,
        observedUrls: [sourceUrl],
        officialPage: {
          url: sourceUrl,
          courseName: "Deer Creek Golf Course at The Landings Golf & Athletic Club",
          linkCandidates: [],
          visibleText:
            "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
        },
        visibleText:
          "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
      });

      const result = await applyBrowserDiscoveryToCourse({
        ...discovery,
        evidence: {
          ...discovery.evidence,
          learnedFrom: `${discovery.evidence.learnedFrom}${provenanceSuffix}`
        }
      });

      expect(result).toEqual({ id: "deer-creek", isPublic: false });
      expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
        where: { id: "deer-creek", updatedAt },
        data: expect.objectContaining({
          isPublic: false,
          bookingMethod: "UNKNOWN",
          automationEligibility: "BLOCKED",
          automationReason: "OTHER"
        })
      });
      const update = mockedPrisma.course.updateMany.mock.calls[0]?.[0];
      expect(update?.data).not.toHaveProperty("providerFamilyKey");
      expect(update?.data).not.toHaveProperty("detectedPlatform");
      expect(update?.data).not.toHaveProperty("detectedBookingUrl");
      expect(update?.data).not.toHaveProperty("bookingMetadata");
      expect(update?.data).not.toHaveProperty("bookingPhone");
    }
  );

  it("rejects a forged generic private identity discovery", async () => {
    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-forged-private",
      isPublic: false,
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      sourceUrl: "https://course.example/",
      bookingUrl: "https://course.example/",
      bookingMethod: "UNKNOWN",
      automationEligibility: "BLOCKED",
      automationReason: "OTHER",
      policyNotes: "A generic page looked private.",
      intelligenceReviewAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
      confidence: 0.98,
      evidence: {
        learnedFrom: "browser-visible-links",
        observedUrls: ["https://course.example/"],
        visibleText: "Members"
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized suffix on otherwise exact private provenance", async () => {
    const sourceUrl = "https://thelandings.com/golf/deer-creek";
    const discovery = buildBrowserDiscovery({
      courseId: "course-forged-private-suffix",
      courseName: "Deer Creek Golf Course",
      sourceUrl,
      finalUrl: sourceUrl,
      observedUrls: [sourceUrl],
      visibleText:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    });

    const result = await applyBrowserDiscoveryToCourse({
      ...discovery,
      evidence: {
        ...discovery.evidence,
        learnedFrom: `${discovery.evidence.learnedFrom}:untrusted-marker`
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("lets fresh exact verified private identity override stale runnable provider metadata", async () => {
    const updatedAt = new Date("2026-07-21T14:10:00.000Z");
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        providerFamilyKey: "FOREUP",
        detectedPlatform: "FOREUP",
        detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
        website: "https://thelandings.com/",
        bookingMetadata: {
          scheduleId: 6123,
          bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
        },
        isPublic: true,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: new Date("2026-07-21T14:00:00.000Z"),
        intelligenceReviewAt: null,
        intelligenceConfidence: 0.99,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "deer-creek", isPublic: false } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);
    const sourceUrl = "https://thelandings.com/golf-and-athletic-club/golf/deer-creek";
    const discovery = buildBrowserDiscovery({
      courseId: "deer-creek",
      courseName: "Deer Creek Golf Course at The Landings Golf & Athletic Club",
      sourceUrl,
      finalUrl: sourceUrl,
      observedUrls: [sourceUrl],
      officialPage: {
        url: sourceUrl,
        courseName: "Deer Creek Golf Course at The Landings Golf & Athletic Club",
        linkCandidates: [],
        visibleText:
          "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
      },
      visibleText:
        "Deer Creek Details\nArchitect: Tom Fazio\nStats: 7,094 Yards / Par 72\nEstablished: 1991\nStatus: Private\nLocation: Savannah, GA"
    });

    const result = await applyBrowserDiscoveryToCourse(discovery);

    expect(result).toEqual({ id: "deer-creek", isPublic: false });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: { id: "deer-creek", updatedAt },
      data: expect.objectContaining({
        isPublic: false,
        bookingMethod: "UNKNOWN",
        automationEligibility: "BLOCKED",
        automationReason: "OTHER"
      })
    });
    const update = mockedPrisma.course.updateMany.mock.calls[0]?.[0];
    expect(update?.data).not.toHaveProperty("providerFamilyKey");
    expect(update?.data).not.toHaveProperty("detectedPlatform");
    expect(update?.data).not.toHaveProperty("detectedBookingUrl");
    expect(update?.data).not.toHaveProperty("bookingMetadata");
  });

  it("verifies a pending course from an exact official runnable-provider link", async () => {
    const updatedAt = new Date("2026-07-24T16:20:00.000Z");
    const bookingUrl = "https://foreupsoftware.com/index.php/booking/20359/4358#/teetimes";
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        name: "Orange Hills Country Club",
        providerFamilyKey: "orangehillscountryclub.com",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: null,
        website: "https://orangehillscountryclub.com/",
        bookingMetadata: null,
        isPublic: null,
        bookingMethod: "UNKNOWN",
        automationEligibility: "UNKNOWN",
        automationReason: "NONE",
        policyNotes: null,
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "orange-hills", isPublic: true } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "orange-hills",
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://orangehillscountryclub.com/",
      bookingUrl,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        scheduleId: 4358,
        bookingClassId: 20359,
        bookingBaseUrl: bookingUrl
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "foreup-api-request",
        observedUrls: [bookingUrl],
        courseIdentityCorroboration: {
          kind: "OFFICIAL_COURSE_PROVIDER_LINK",
          courseName: "Orange Hills Country Club",
          officialWebsiteUrl: "https://orangehillscountryclub.com/",
          officialPageUrl: "https://orangehillscountryclub.com/",
          providerUrl: bookingUrl
        }
      }
    });

    expect(result).toEqual({ id: "orange-hills", isPublic: true });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: { id: "orange-hills", updatedAt },
      data: expect.objectContaining({
        isPublic: true,
        detectedPlatform: "FOREUP",
        providerFamilyKey: "FOREUP",
        detectedBookingUrl: bookingUrl,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED"
      })
    });
  });

  it("reopens a private identity only from an exact official runnable-provider link", async () => {
    const updatedAt = new Date("2026-07-21T14:10:00.000Z");
    const bookingUrl = "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes";
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        name: "Deer Creek Golf Course",
        providerFamilyKey: "thelandings.com",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: null,
        website: "https://thelandings.com/",
        bookingMetadata: null,
        isPublic: false,
        bookingMethod: "UNKNOWN",
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
        policyNotes: "Previously verified private.",
        intelligenceVerifiedAt: new Date(),
        intelligenceReviewAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
        intelligenceConfidence: 0.98,
        updatedAt
      } as never)
      .mockResolvedValueOnce({ id: "deer-creek", isPublic: true } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "deer-creek",
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://thelandings.com/golf/deer-creek",
      bookingUrl,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      apiMetadata: {
        scheduleId: 11739,
        bookingClassId: 22739,
        bookingBaseUrl: bookingUrl
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "foreup-api-request",
        observedUrls: [bookingUrl],
        courseIdentityCorroboration: {
          kind: "OFFICIAL_COURSE_PROVIDER_LINK",
          courseName: "Deer Creek Golf Course",
          officialWebsiteUrl: "https://thelandings.com/",
          officialPageUrl: "https://thelandings.com/golf/deer-creek",
          providerUrl: bookingUrl
        }
      }
    });

    expect(result).toEqual({ id: "deer-creek", isPublic: true });
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith({
      where: { id: "deer-creek", updatedAt },
      data: expect.objectContaining({
        isPublic: true,
        detectedPlatform: "FOREUP",
        providerFamilyKey: "FOREUP",
        detectedBookingUrl: bookingUrl,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        bookingPhone: null,
        policyNotes: null
      })
    });
  });

  it("does not reopen a private identity from an uncorroborated provider observation", async () => {
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      name: "Deer Creek Golf Course",
      providerFamilyKey: "thelandings.com",
      detectedPlatform: "UNKNOWN",
      detectedBookingUrl: null,
      website: "https://thelandings.com/",
      bookingMetadata: null,
      isPublic: false,
      bookingMethod: "UNKNOWN",
      automationEligibility: "BLOCKED",
      automationReason: "OTHER",
      intelligenceVerifiedAt: new Date(),
      intelligenceReviewAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
      intelligenceConfidence: 0.98,
      updatedAt: new Date("2026-07-21T14:10:00.000Z")
    } as never);
    const bookingUrl = "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes";

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "deer-creek",
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://unrelated.example/golf",
      bookingUrl,
      apiMetadata: {
        scheduleId: 11739,
        bookingClassId: 22739,
        bookingBaseUrl: bookingUrl
      },
      confidence: 0.95,
      evidence: {
        learnedFrom: "foreup-api-request",
        observedUrls: [bookingUrl]
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "account-required provider evidence",
      discovery: {
        status: "VERIFIED" as const,
        detectedPlatform: "CUSTOM" as const,
        bookingUrl: "https://app.whoosh.io/patron/club/deer-creek",
        bookingMethod: "PUBLIC_ONLINE" as const,
        automationEligibility: "BLOCKED" as const,
        automationReason: "ACCOUNT_REQUIRED" as const,
        policyNotes: "Availability currently requires an account.",
        learnedFrom: "official-account-required-booking"
      }
    },
    {
      label: "phone-only evidence",
      discovery: {
        status: "VERIFIED" as const,
        detectedPlatform: "UNKNOWN" as const,
        bookingUrl: "https://thelandings.com/golf/deer-creek",
        bookingMethod: "PHONE_ONLY" as const,
        bookingPhone: "912-555-0100",
        automationEligibility: "BLOCKED" as const,
        automationReason: "NO_ONLINE_BOOKING" as const,
        policyNotes: "The official course page directs golfers to call.",
        learnedFrom: "official-phone-reservation"
      }
    }
  ])("does not refresh an expired private identity from $label", async ({ discovery }) => {
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      name: "Deer Creek Golf Course",
      providerFamilyKey: "thelandings.com",
      detectedPlatform: "UNKNOWN",
      detectedBookingUrl: "https://app.whoosh.io/patron/club/deer-creek",
      website: "https://thelandings.com/golf/deer-creek",
      bookingMetadata: null,
      isPublic: false,
      bookingMethod: "UNKNOWN",
      automationEligibility: "BLOCKED",
      automationReason: "OTHER",
      intelligenceVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      intelligenceReviewAt: new Date("2026-07-01T00:00:00.000Z"),
      intelligenceConfidence: 0.98,
      updatedAt: new Date("2026-07-01T00:00:00.000Z")
    } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "deer-creek",
      status: discovery.status,
      detectedPlatform: discovery.detectedPlatform,
      sourceUrl: "https://thelandings.com/golf/deer-creek",
      bookingUrl: discovery.bookingUrl,
      bookingMethod: discovery.bookingMethod,
      bookingPhone: "bookingPhone" in discovery ? discovery.bookingPhone : undefined,
      automationEligibility: discovery.automationEligibility,
      automationReason: discovery.automationReason,
      policyNotes: discovery.policyNotes,
      intelligenceReviewAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      confidence: 0.95,
      evidence: {
        learnedFrom: discovery.learnedFrom,
        observedUrls: [discovery.bookingUrl]
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "the booking method is unknown",
      bookingMethod: "UNKNOWN" as const,
      automationEligibility: "BLOCKED" as const,
      automationReason: "NO_ONLINE_BOOKING" as const
    },
    {
      label: "the discovery is allowed",
      bookingMethod: "PHONE_ONLY" as const,
      automationEligibility: "ALLOWED" as const,
      automationReason: "NO_ONLINE_BOOKING" as const
    },
    {
      label: "the reason is not no-online-booking",
      bookingMethod: "CONTACT_COURSE" as const,
      automationEligibility: "BLOCKED" as const,
      automationReason: "OTHER" as const
    }
  ])("does not accept an incoherent manual discovery when $label", async (scenario) => {
    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-manual",
      status: "VERIFIED",
      detectedPlatform: "UNKNOWN",
      sourceUrl: "https://course.example/",
      bookingUrl: "https://course.example/tee-times",
      bookingMethod: scenario.bookingMethod,
      automationEligibility: scenario.automationEligibility,
      automationReason: scenario.automationReason,
      intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
      confidence: 0.95,
      evidence: {
        learnedFrom: "official-site-research",
        observedUrls: ["https://course.example/tee-times"]
      }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
  });

  it("uses updatedAt compare-and-set for learned provider writes", async () => {
    const updatedAt = new Date("2026-07-16T12:00:00.000Z");
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22518#/teetimes",
      website: "https://westwoodsgc.com/",
      bookingMetadata: null,
      updatedAt
    } as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 0 } as never);

    const result = await applyBrowserDiscoveryToCourse({
      courseId: "course-westwoods",
      status: "LEARNED",
      detectedPlatform: "FOREUP",
      sourceUrl: "https://westwoodsgc.com/",
      bookingUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      apiMetadata: {
        scheduleId: 6123,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
      },
      confidence: 0.95,
      evidence: { learnedFrom: "foreup-api-request", observedUrls: [] }
    });

    expect(result).toBeNull();
    expect(mockedPrisma.course.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "course-westwoods", updatedAt } })
    );
  });

  it("lists active unknown courses with websites as browser probe targets", async () => {
    mockedPrisma.teeSearch.findMany.mockResolvedValue([
      {
        id: "search-1",
        date: new Date("2026-07-10T00:00:00Z"),
        startTime: "13:40",
        endTime: "16:00",
        players: 3,
        preferences: [
          {
            rank: 1,
            course: {
              id: "course-1",
              name: "Longshore Golf Course",
              website: "https://longshoregolfcourse.com",
              detectedBookingUrl: null,
              detectedPlatform: "UNKNOWN",
              automationEligibility: "UNKNOWN",
              bookingMetadata: null
            }
          }
        ]
      }
    ] as never);

    await listBrowserProbeTargets();

    expect(mockedPrisma.teeSearch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "ACTIVE"
        })
      })
    );
  });

  it("filters non-browser incidents before limiting active-demand targets", async () => {
    const firstSeenAt = new Date("2026-08-10T12:00:00.000Z");
    const readyCourse = {
      id: "course-ready",
      name: "New Alert Course",
      website: "https://new-alert-course.example/",
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "SOURCE_MISSING",
      automationEligibility: "UNKNOWN",
      automationReason: "OTHER",
      monitoringMode: "AUTOMATIC",
      bookingAccessMode: "UNKNOWN",
      bookingMethod: "UNKNOWN",
      isPublic: true,
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      probes: []
    };
    mockedPrisma.teeSearch.findMany.mockResolvedValue([
      {
        id: "search-new",
        preferences: [{ rank: 1, course: readyCourse }]
      }
    ] as never);
    mockedPrisma.courseSupportIncident.findMany.mockResolvedValue([
      ...Array.from({ length: 5 }, (_, index) => ({
        courseId: `course-human-${index}`,
        status: "NEEDS_HUMAN",
        cycle: 1,
        attemptLedger: null,
        activeRealSearchCount: 1,
        firstSeenAt: new Date(firstSeenAt.getTime() - (index + 1) * 60_000),
        nextAttemptAt: new Date("2026-08-10T18:00:00.000Z"),
        kind: "NEEDS_ADAPTER",
        occurrenceCount: 1,
        lastSeenAt: firstSeenAt,
        course: null
      })),
      {
        courseId: "course-ready",
        status: "AUTO_INVESTIGATING",
        cycle: 1,
        attemptLedger: browserReadyAttemptLedger(),
        activeRealSearchCount: 1,
        firstSeenAt,
        nextAttemptAt: firstSeenAt,
        kind: "NEEDS_ADAPTER",
        occurrenceCount: 1,
        lastSeenAt: firstSeenAt,
        course: readyCourse
      }
    ] as never);

    const targets = await listBrowserProbeTargets(1);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.course.id).toBe("course-ready");
  });

  it("keeps repeated runnable-provider failures on the non-interactive adapter path", async () => {
    mockedPrisma.teeSearch.findMany.mockResolvedValue([]);
    mockedPrisma.courseSupportIncident.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        status: "AUTO_INVESTIGATING",
        kind: "FETCH_FAILED",
        occurrenceCount: 3,
        lastSeenAt: new Date(),
        course: {
          id: "course-1",
          name: "Repeated Failure Course",
          website: "https://course.example/",
          detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/1/2#/teetimes",
          detectedPlatform: "FOREUP",
          providerFamilyKey: "FOREUP",
          automationEligibility: "ALLOWED",
          automationReason: "NONE",
          bookingMethod: "PUBLIC_ONLINE",
          isPublic: true,
          intelligenceVerifiedAt: null,
          intelligenceReviewAt: null,
          intelligenceConfidence: null,
          bookingMetadata: {
            scheduleId: 2,
            bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/1/2#/teetimes"
          },
          probes: [{ outcome: "FETCH_FAILED", observedAt: new Date() }]
        }
      }
    ] as never);

    const targets = await listBrowserProbeTargets();

    expect(targets).toEqual([]);
  });

  it("limits a targeted browser probe to the exact requested course", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-westwoods",
        name: "Westwoods Golf Course",
        website: "https://westwoodsgc.com/",
        detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22518#/teetimes",
        detectedPlatform: "FOREUP",
        providerFamilyKey: "FOREUP",
        automationEligibility: "NEEDS_REVIEW",
        bookingMetadata: null,
        preferences: []
      }
    ] as never);

    const targets = await listBrowserProbeTargets(1, " westwoods golf course ");

    expect(targets).toHaveLength(1);
    expect(targets[0]?.course.name).toBe("Westwoods Golf Course");
    expect(targets[0]?.course.providerFamilyKey).toBe("FOREUP");
    expect(targets[0]?.searchId).toBeUndefined();
  });

  it("keeps a policy-only stored block off the interactive browser path", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "policy-course",
        name: "Policy Course",
        website: "https://policy-course.example/",
        detectedBookingUrl: "https://policy-course.example/tee-times",
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "policy-course.example",
        automationEligibility: "BLOCKED",
        automationReason: "AUTOMATION_PROHIBITED",
        bookingMethod: "PUBLIC_ONLINE",
        isPublic: true,
        intelligenceVerifiedAt: new Date("2026-07-16T12:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-16T00:00:00.000Z"),
        intelligenceConfidence: 0.99,
        bookingMetadata: null,
        preferences: []
      }
    ] as never);

    const targets = await listBrowserProbeTargets(1, "Policy Course");

    expect(targets).toEqual([]);
  });

  it("does not target a current corroborated technical final", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "account-course",
        name: "Account Course",
        website: "https://account-course.example/",
        detectedBookingUrl: "https://account-course.example/tee-times",
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "account-course.example",
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED",
        bookingMethod: "PUBLIC_ONLINE",
        isPublic: true,
        intelligenceVerifiedAt: new Date(),
        intelligenceReviewAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        intelligenceConfidence: 0.95,
        bookingMetadata: null,
        preferences: []
      }
    ] as never);

    await expect(listBrowserProbeTargets(1, "Account Course")).resolves.toEqual([]);
  });

  it("rejects an ambiguous targeted course name", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "westwoods-a",
        name: "Westwoods Golf Course",
        website: "https://westwoods-a.example.com",
        detectedBookingUrl: null,
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "SOURCE_MISSING",
        automationEligibility: "UNKNOWN",
        bookingMetadata: null,
        preferences: []
      },
      {
        id: "westwoods-b",
        name: "Westwoods Golf Course",
        website: "https://westwoods-b.example.com",
        detectedBookingUrl: null,
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "SOURCE_MISSING",
        automationEligibility: "UNKNOWN",
        bookingMetadata: null,
        preferences: []
      }
    ] as never);

    await expect(listBrowserProbeTargets(1, "Westwoods Golf Course")).rejects.toThrow("ambiguous");
  });

  it("does not target an open incident whose course is already runnable", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-westwoods",
        name: "Westwoods Golf Course",
        website: "https://westwoodsgc.com/",
        detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
        detectedPlatform: "FOREUP",
        providerFamilyKey: "FOREUP",
        automationEligibility: "ALLOWED",
        bookingMetadata: {
          scheduleId: 6123,
          bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
        },
        preferences: []
      }
    ] as never);

    await expect(listBrowserProbeTargets(1, "Westwoods Golf Course")).resolves.toEqual([]);
  });

  it("allows an exact targeted browser probe for a runnable course with a current auth failure", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-current-auth",
        name: "Current Auth Course",
        website: "https://sample-course.example/",
        detectedBookingUrl: "https://sample-course.cps.golf/",
        detectedPlatform: "CUSTOM",
        providerFamilyKey: "CPS",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        bookingMethod: "PUBLIC_ONLINE",
        bookingMetadata: {
          bookingBaseUrl: "https://sample-course.cps.golf/",
          courseId: 1
        },
        supportIncident: {
          kind: "FETCH_FAILED",
          failureClass: "AUTH",
          occurrenceCount: 1,
          lastSeenAt: new Date()
        },
        probes: [{ outcome: "FETCH_FAILED", observedAt: new Date() }],
        preferences: []
      }
    ] as never);

    const targets = await listBrowserProbeTargets(1, "Current Auth Course");

    expect(targets).toHaveLength(1);
    expect(targets[0]?.course.providerFamilyKey).toBe("CPS");
  });

  it("allows an exact targeted browser probe for a blocked course with a current unsupported-family incident", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-current-unsupported",
        name: "Current Unsupported Course",
        website: "https://current-unsupported.example/",
        detectedBookingUrl: null,
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "current-unsupported.example",
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
        bookingMethod: "CONTACT_COURSE",
        isPublic: true,
        bookingMetadata: null,
        supportIncident: {
          kind: "NEEDS_ADAPTER",
          failureClass: "UNSUPPORTED_FAMILY",
          occurrenceCount: 1,
          lastSeenAt: new Date()
        },
        probes: [{ outcome: "NEEDS_ADAPTER", observedAt: new Date() }],
        preferences: []
      }
    ] as never);

    const targets = await listBrowserProbeTargets(1, "Current Unsupported Course");

    expect(targets).toHaveLength(1);
    expect(targets[0]?.course.automationEligibility).toBe("BLOCKED");
  });

  it.each(["PENDING", "STALE_EVIDENCE", "RETRY_SCHEDULED"])("uses an unprojected source candidate only for its exact owned %s browser fence", async (result) => {
    const fence = {
      batchId: "batch-source",
      leaseToken: "lease-source",
      ownerThreadId: "owner-source",
      releaseSha: "a".repeat(40),
      deployedAt: new Date("2026-08-20T12:00:00.000Z"),
      runtimeVersion: "a".repeat(40),
      incidentId: "incident-source",
      courseId: "course-source",
      cycle: 2,
      stage: "RENDERED_BROWSER_DISCOVERY" as const
    };
    const ownershipScopeDigest = buildCourseSupportSourceSearchScopeDigest({
      batchId: fence.batchId,
      incidentId: fence.incidentId,
      cycle: fence.cycle
    });
    const course = {
      id: "course-source",
      name: "Source Missing Golf Course",
      website: null,
      detectedBookingUrl: null,
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "SOURCE_MISSING",
      automationEligibility: "UNKNOWN",
      automationReason: "NONE",
      monitoringMode: "AUTOMATIC",
      bookingAccessMode: "UNKNOWN",
      bookingMethod: "UNKNOWN",
      isPublic: true,
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
      supportIncident: {
        id: fence.incidentId,
        kind: "NEEDS_ADAPTER",
        failureClass: "MISSING_SOURCE",
        status: "AUTO_INVESTIGATING",
        activeBatchId: fence.batchId,
        occurrenceCount: 2,
        lastSeenAt: new Date("2026-08-20T12:00:00.000Z"),
        cycle: 2,
        attemptLedger: browserReadyAttemptLedger(2)
      },
      probes: [],
      preferences: []
    };
    mockedPrisma.course.findMany.mockResolvedValue([course] as never);
    mockedPrisma.courseMonitoringEvent.findFirst.mockResolvedValue({
      evidenceUrl: "https://parks.example.gov/golf/source-missing",
      audit: {
        result: "CANDIDATE",
        incidentCycle: 2,
        ownershipScopeDigest,
        courseProjectionApplied: false,
        browserVerificationRequired: true
      }
    } as never);
    mockedPrisma.courseSupportBatch.findFirst.mockResolvedValue({
      releaseSha: fence.releaseSha,
      deployedAt: fence.deployedAt,
      incidents: [
        {
          courseId: fence.courseId,
          cycle: fence.cycle,
          result,
          course: {
            website: null,
            detectedBookingUrl: null
          },
          incident: {
            id: fence.incidentId,
            cycle: fence.cycle,
            status: "AUTO_INVESTIGATING",
            activeBatchId: fence.batchId,
            attemptLedger: browserReadyAttemptLedger(2)
          }
        }
      ]
    } as never);

    await expect(listBrowserProbeTargets(1, undefined, "course-source")).resolves.toEqual([]);
    const targets = await listBrowserProbeTargets(
      1,
      undefined,
      "course-source",
      fence
    );

    expect(targets).toHaveLength(1);
    expect(targets[0]?.probeUrl).toBe(
      "https://parks.example.gov/golf/source-missing"
    );
    expect(targets[0]?.unprojectedSourceCandidate).toBe(true);
    expect(targets[0]?.course.website).toBeNull();
    expect(mockedPrisma.courseMonitoringEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          courseId: "course-source",
          incidentId: "incident-source",
          audit: { path: ["ownershipScopeDigest"], equals: ownershipScopeDigest }
        })
      })
    );
    expect(mockedPrisma.courseSupportBatch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: fence.batchId,
          leaseToken: fence.leaseToken,
          ownerThreadId: fence.ownerThreadId,
          releaseSha: fence.releaseSha,
          deployedAt: fence.deployedAt
        })
      })
    );
  });

  it("atomically stamps owned browser evidence with the resulting provider snapshot", async () => {
    const updatedAt = new Date("2026-08-22T12:00:00.000Z");
    const current = {
      id: "course-owned-browser",
      name: "Owned Browser Course",
      timeZone: "America/New_York",
      website: "https://course.example.com",
      detectedBookingUrl:
        "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
      detectedPlatform: "FOREUP",
      providerFamilyKey: "FOREUP",
      bookingMethod: "UNKNOWN",
      bookingWindowDaysAhead: null,
      bookingWindowEvidenceUrl: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "UNSUPPORTED_PLATFORM",
      monitoringMode: "AUTOMATIC",
      bookingAccessMode: "UNKNOWN",
      isPublic: true,
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
      updatedAt
    };
    const bookingMetadata = {
      scheduleId: 11739,
      bookingClassId: 22739,
      bookingBaseUrl:
        "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
    };
    const applied = {
      ...current,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      bookingAccessMode: "PUBLIC_SIGNED_OUT",
      intelligenceVerifiedAt: new Date("2026-08-22T12:01:00.000Z"),
      intelligenceConfidence: 0.95,
      bookingMetadata,
      updatedAt: new Date("2026-08-22T12:01:00.000Z")
    };
    const runtimeVersion = "a".repeat(40);
    const fence = {
      batchId: "batch-owned-browser",
      leaseToken: "lease-owned-browser",
      ownerThreadId: "thread-owned-browser",
      releaseSha: runtimeVersion,
      deployedAt: new Date("2026-08-22T11:55:00.000Z"),
      runtimeVersion,
      incidentId: "incident-owned-browser",
      courseId: current.id,
      cycle: 1,
      stage: "RENDERED_BROWSER_DISCOVERY" as const
    };
    const discovery = {
      courseId: current.id,
      status: "LEARNED" as const,
      detectedPlatform: "FOREUP" as const,
      sourceUrl: current.website,
      bookingUrl: current.detectedBookingUrl,
      apiMetadata: bookingMetadata,
      confidence: 0.95,
      evidence: {
        learnedFrom: "foreup-api-request",
        observedUrls: [],
        browserInvestigation: {
          mode: "RENDERED",
          incidentCycle: 1,
          runtimeVersion,
          observedAt: "2026-08-22T12:00:30.000Z",
          networkContracts: []
        }
      }
    };
    mockedPrisma.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.courseSupportBatch.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.courseSupportBatchIncident.findUnique.mockResolvedValue({
      courseId: current.id,
      cycle: 1,
      result: "PENDING"
    } as never);
    mockedPrisma.courseSupportIncident.findUnique
      .mockResolvedValueOnce({
        cycle: 1,
        attemptLedger: browserReadyAttemptLedger()
      } as never)
      .mockResolvedValueOnce(null);
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce(current as never)
      .mockResolvedValueOnce(current as never)
      .mockResolvedValueOnce(applied as never);
    mockedPrisma.course.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.courseAutomationDiscovery.create.mockResolvedValue({
      id: "discovery-owned-browser"
    } as never);

    const result = await recordAndApplyOwnedBrowserDiscoveryToCourse(
      discovery as never,
      discovery as never,
      fence,
      runtimeVersion,
      buildCourseSupportProviderSnapshotFingerprint(current as never),
      providerObservationLease,
      new Date("2026-08-22T12:00:30.000Z")
    );

    const resultingFingerprint = buildCourseSupportProviderSnapshotFingerprint(applied as never);
    expect(result).toMatchObject({
      applied: { ...applied, updatedAt: browserDiscoveryParentUpdatedAt },
      providerSnapshotFingerprint: resultingFingerprint,
      snapshotBound: true
    });
    expect(mockedPrisma.courseAutomationDiscovery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        evidence: expect.objectContaining({
          browserInvestigation: expect.objectContaining({
            providerSnapshotFingerprint: resultingFingerprint
          })
        })
      })
    });
    expect(mockedPrisma.$transaction).toHaveBeenCalledOnce();
    expect(mockedPrisma.course.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockedPrisma.courseAutomationDiscovery.create.mock.invocationCallOrder[0]
    );
  });

  it("rejects owned browser persistence before canonical writes when a successor took the provider marker", async () => {
    const courseId = "course-lost-browser-marker";
    const runtimeVersion = "a".repeat(40);
    const fence = {
      batchId: "batch-lost-browser-marker",
      leaseToken: "batch-lease-lost-browser-marker",
      ownerThreadId: "thread-lost-browser-marker",
      releaseSha: runtimeVersion,
      deployedAt: new Date("2026-08-22T11:55:00.000Z"),
      runtimeVersion,
      incidentId: "incident-lost-browser-marker",
      courseId,
      cycle: 1,
      stage: "RENDERED_BROWSER_DISCOVERY" as const,
    };
    const discovery = {
      courseId,
      status: "LEARNED" as const,
      detectedPlatform: "CUSTOM" as const,
      sourceUrl: "https://course.example.com/",
      bookingUrl: "https://booking.example.com/tee-times",
      confidence: 0.8,
      evidence: {
        learnedFrom: "rendered-browser",
        observedUrls: ["https://booking.example.com/tee-times"],
        browserInvestigation: {
          mode: "RENDERED",
          incidentCycle: 1,
          runtimeVersion,
          observedAt: "2026-08-22T12:00:00.000Z",
          networkContracts: [],
        },
      },
    };
    mockedPrisma.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.courseSupportBatch.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.courseSupportBatchIncident.findUnique.mockResolvedValue({
      courseId,
      cycle: 1,
      result: "PENDING",
    } as never);
    mockedPrisma.courseSupportIncident.findUnique.mockResolvedValue({
      cycle: 1,
      attemptLedger: browserReadyAttemptLedger(),
    } as never);
    providerExecutionMarkerMocks.renewCourseProviderObservationInTransaction.mockResolvedValueOnce(
      false,
    );

    await expect(
      recordAndApplyOwnedBrowserDiscoveryToCourse(
        discovery as never,
        discovery as never,
        fence,
        runtimeVersion,
        "b".repeat(64),
        {
          ...providerObservationLease,
          courseId,
        },
        new Date("2026-08-22T12:00:00.000Z"),
      ),
    ).rejects.toThrow(
      "Rendered provider observation ownership expired before course persistence completed",
    );

    expect(mockedPrisma.course.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.courseAutomationDiscovery.create).not.toHaveBeenCalled();
  });

  it("keeps contracts unbound when the course drifts after browser observation", async () => {
    const runtimeVersion = "a".repeat(40);
    const observedCourse = {
      id: "course-stale-owned-browser",
      timeZone: "America/New_York",
      website: "https://course.example.com",
      detectedBookingUrl: "https://booking.example.com/tee-times",
      detectedPlatform: "CUSTOM",
      providerFamilyKey: "BOOKING_EXAMPLE",
      bookingMethod: "UNKNOWN",
      bookingWindowDaysAhead: null,
      bookingWindowEvidenceUrl: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "UNSUPPORTED_PLATFORM",
      monitoringMode: "AUTOMATIC",
      bookingAccessMode: "UNKNOWN",
      isPublic: true,
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: null,
      layoutHoleCounts: [],
      layoutHolesVerifiedAt: null,
      updatedAt: new Date("2026-08-22T12:00:00.000Z")
    };
    const concurrentCourse = {
      ...observedCourse,
      detectedBookingUrl: "https://booking.example.com/new-provider-state",
      updatedAt: new Date("2026-08-22T12:00:15.000Z")
    };
    const discovery = {
      courseId: observedCourse.id,
      status: "INSPECTED" as const,
      detectedPlatform: "CUSTOM" as const,
      sourceUrl: observedCourse.website,
      bookingUrl: observedCourse.detectedBookingUrl,
      confidence: 0.8,
      evidence: {
        learnedFrom: "rendered-browser",
        observedUrls: [],
        browserInvestigation: {
          mode: "RENDERED",
          incidentCycle: 1,
          runtimeVersion,
          observedAt: "2026-08-22T12:00:10.000Z",
          restrictedNetworkObserved: true,
          networkContracts: [
            {
              origin: "https://booking.example.com",
              method: "GET",
              pathPattern: "/api/availability",
              queryKeys: ["date"],
              resourceType: "fetch",
              status: 200
            }
          ]
        }
      }
    };
    const fence = {
      batchId: "batch-stale-owned-browser",
      leaseToken: "lease-stale-owned-browser",
      ownerThreadId: "thread-stale-owned-browser",
      releaseSha: runtimeVersion,
      deployedAt: new Date("2026-08-22T11:55:00.000Z"),
      runtimeVersion,
      incidentId: "incident-stale-owned-browser",
      courseId: observedCourse.id,
      cycle: 1,
      stage: "RENDERED_BROWSER_DISCOVERY" as const
    };
    mockedPrisma.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.courseSupportBatch.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.courseSupportBatchIncident.findUnique.mockResolvedValue({
      courseId: observedCourse.id,
      cycle: 1,
      result: "PENDING"
    } as never);
    mockedPrisma.courseSupportIncident.findUnique.mockResolvedValue({
      cycle: 1,
      attemptLedger: browserReadyAttemptLedger()
    } as never);
    mockedPrisma.course.findUnique.mockResolvedValueOnce(concurrentCourse as never);
    mockedPrisma.courseAutomationDiscovery.create.mockResolvedValue({
      id: "discovery-stale-owned-browser"
    } as never);

    const result = await recordAndApplyOwnedBrowserDiscoveryToCourse(
      discovery as never,
      discovery as never,
      fence,
      runtimeVersion,
      buildCourseSupportProviderSnapshotFingerprint(observedCourse as never),
      {
        ...providerObservationLease,
        courseId: observedCourse.id,
      },
      new Date("2026-08-22T12:00:10.000Z")
    );

    expect(result).toMatchObject({
      applied: null,
      providerSnapshotFingerprint: null,
      snapshotBound: false
    });
    expect(mockedPrisma.course.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    const [courseLock] = mockedPrisma.$queryRaw.mock.calls[0] as [
      { strings: readonly string[]; values: unknown[] }
    ];
    expect(courseLock.strings.join("")).toContain('FROM "Course"');
    expect(courseLock.strings.join("")).toContain("FOR UPDATE");
    expect(courseLock.values).toEqual([observedCourse.id]);
    const [parentFence] = mockedPrisma.$queryRaw.mock.calls[1] as [
      { strings: readonly string[]; values: unknown[] }
    ];
    expect(parentFence.strings.join("")).toContain('UPDATE "Course"');
    expect(parentFence.values).toEqual([observedCourse.id]);
    const persistedEvidence = mockedPrisma.courseAutomationDiscovery.create.mock.calls[0]?.[0]
      ?.data.evidence as {
      browserInvestigation?: Record<string, unknown>;
    };
    expect(persistedEvidence.browserInvestigation).toEqual(
      expect.objectContaining({
        restrictedNetworkObserved: true,
        networkContracts: expect.any(Array)
      })
    );
    expect(
      persistedEvidence.browserInvestigation?.providerSnapshotFingerprint
    ).toBeUndefined();
  });

  it("requires a valid browser audit when binding a persisted snapshot", () => {
    expect(() =>
      bindBrowserDiscoveryToProviderSnapshot(
        {
          courseId: "course-legacy-browser",
          status: "INSPECTED",
          detectedPlatform: "UNKNOWN",
          sourceUrl: "https://course.example.com",
          confidence: 0.5,
          evidence: { learnedFrom: "official-site", observedUrls: [] }
        },
        "b".repeat(64)
      )
    ).toThrow("requires a browser investigation audit");
  });

  it.each([
    ["restored entry", { result: "RESTORED" }],
    ["final-disposition entry", { result: "FINAL_DISPOSITION" }],
    ["needs-human entry", { result: "NEEDS_HUMAN" }],
    ["stale incident status", { incidentStatus: "RESOLVED" }],
    ["different active batch", { activeBatchId: "batch-other" }],
    ["different incident cycle", { incidentCycle: 3 }],
    ["different playbook stage", { attemptLedger: null }],
    ["newly persisted course URL", { courseWebsite: "https://current.example/" }],
    ["different release fence", { releaseSha: "b".repeat(40) }]
  ])("rejects a source candidate with %s", async (_label, override) => {
    const fence = {
      batchId: "batch-source",
      leaseToken: "lease-source",
      ownerThreadId: "owner-source",
      releaseSha: "a".repeat(40),
      deployedAt: new Date("2026-08-20T12:00:00.000Z"),
      runtimeVersion: "a".repeat(40),
      incidentId: "incident-source",
      courseId: "course-source",
      cycle: 2,
      stage: "RENDERED_BROWSER_DISCOVERY" as const
    };
    const ownershipScopeDigest = buildCourseSupportSourceSearchScopeDigest({
      batchId: fence.batchId,
      incidentId: fence.incidentId,
      cycle: fence.cycle
    });
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: fence.courseId,
        name: "Source Missing Golf Course",
        website: null,
        detectedBookingUrl: null,
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "SOURCE_MISSING",
        automationEligibility: "UNKNOWN",
        automationReason: "NONE",
        monitoringMode: "AUTOMATIC",
        bookingAccessMode: "UNKNOWN",
        bookingMethod: "UNKNOWN",
        isPublic: true,
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null,
        bookingMetadata: null,
        layoutHoleCounts: [],
        layoutHolesVerifiedAt: null,
        supportIncident: {
          id: fence.incidentId,
          kind: "NEEDS_ADAPTER",
          failureClass: "MISSING_SOURCE",
          status: "AUTO_INVESTIGATING",
          activeBatchId: fence.batchId,
          occurrenceCount: 2,
          lastSeenAt: new Date(),
          cycle: fence.cycle,
          attemptLedger: browserReadyAttemptLedger(fence.cycle)
        },
        probes: [],
        preferences: []
      }
    ] as never);
    mockedPrisma.courseMonitoringEvent.findFirst.mockResolvedValue({
      evidenceUrl: "https://parks.example.gov/golf/source-missing",
      audit: {
        result: "CANDIDATE",
        incidentCycle: fence.cycle,
        ownershipScopeDigest,
        courseProjectionApplied: false,
        browserVerificationRequired: true
      }
    } as never);
    mockedPrisma.courseSupportBatch.findFirst.mockResolvedValue({
      releaseSha: override.releaseSha ?? fence.releaseSha,
      deployedAt: fence.deployedAt,
      incidents: [
        {
          courseId: fence.courseId,
          cycle: fence.cycle,
          result: override.result ?? "PENDING",
          course: {
            website: override.courseWebsite ?? null,
            detectedBookingUrl: null
          },
          incident: {
            id: fence.incidentId,
            cycle: override.incidentCycle ?? fence.cycle,
            status: override.incidentStatus ?? "AUTO_INVESTIGATING",
            activeBatchId: override.activeBatchId ?? fence.batchId,
            attemptLedger:
              "attemptLedger" in override
                ? override.attemptLedger
                : browserReadyAttemptLedger(fence.cycle)
          }
        }
      ]
    } as never);

    await expect(
      listBrowserProbeTargets(1, undefined, fence.courseId, fence)
    ).resolves.toEqual([]);
  });

  it("ignores a source candidate from another cycle and preserves a current course route", async () => {
    const fence = {
      batchId: "batch-source",
      leaseToken: "lease-source",
      ownerThreadId: "owner-source",
      releaseSha: "a".repeat(40),
      deployedAt: new Date("2026-08-20T12:00:00.000Z"),
      runtimeVersion: "a".repeat(40),
      incidentId: "incident-source",
      courseId: "course-source",
      cycle: 2,
      stage: "RENDERED_BROWSER_DISCOVERY" as const
    };
    mockedPrisma.course.findMany.mockResolvedValue([
      {
        id: "course-source",
        name: "Source Missing Golf Course",
        website: "https://current-course.example/",
        detectedBookingUrl: null,
        detectedPlatform: "UNKNOWN",
        providerFamilyKey: "SOURCE_MISSING",
        automationEligibility: "UNKNOWN",
        automationReason: "NONE",
        monitoringMode: "AUTOMATIC",
        bookingAccessMode: "UNKNOWN",
        bookingMethod: "UNKNOWN",
        isPublic: true,
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null,
        bookingMetadata: null,
        layoutHoleCounts: [],
        layoutHolesVerifiedAt: null,
        supportIncident: {
          id: fence.incidentId,
          kind: "NEEDS_ADAPTER",
          failureClass: "MISSING_SOURCE",
          status: "AUTO_INVESTIGATING",
          activeBatchId: fence.batchId,
          occurrenceCount: 2,
          lastSeenAt: new Date(),
          cycle: 2,
          attemptLedger: browserReadyAttemptLedger(2)
        },
        probes: [],
        preferences: []
      }
    ] as never);
    mockedPrisma.courseMonitoringEvent.findFirst.mockResolvedValue({
      evidenceUrl: "https://stale-candidate.example/",
      audit: {
        result: "CANDIDATE",
        incidentCycle: 1,
        ownershipScopeDigest: buildCourseSupportSourceSearchScopeDigest({
          batchId: fence.batchId,
          incidentId: fence.incidentId,
          cycle: fence.cycle
        }),
        courseProjectionApplied: false,
        browserVerificationRequired: true
      }
    } as never);
    mockedPrisma.courseSupportBatch.findFirst.mockResolvedValue({
      id: fence.batchId
    } as never);

    const targets = await listBrowserProbeTargets(1, undefined, "course-source", fence);

    expect(targets[0]?.probeUrl).toBe("https://current-course.example/");
    expect(targets[0]).not.toHaveProperty("unprojectedSourceCandidate");
    expect(mockedPrisma.courseMonitoringEvent.findFirst).not.toHaveBeenCalled();
    expect(mockedPrisma.courseSupportBatch.findFirst).toHaveBeenCalledOnce();
  });
});
