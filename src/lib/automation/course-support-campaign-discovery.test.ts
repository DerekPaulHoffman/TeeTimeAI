import { describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({
  discoveryCreate: vi.fn(),
  monitoringEventFindFirst: vi.fn(),
  queryRaw: vi.fn()
}));

const transaction = vi.hoisted(() => ({
  $queryRaw: persistence.queryRaw,
  courseAutomationDiscovery: { create: persistence.discoveryCreate },
  courseMonitoringEvent: { findFirst: persistence.monitoringEventFindFirst }
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("./course-monitoring", () => ({
  revalidateCourseMonitoringForProviderEvidenceChangeInTransaction: vi.fn(),
  runSerializedCourseMonitoringWrite: vi.fn(
    async (_courseId: string, worker: (tx: typeof transaction) => Promise<unknown>) =>
      worker(transaction)
  )
}));
vi.mock("./course-support-browser-stages", () => ({
  runCourseSupportBrowserPersistenceWrite: vi.fn(
    async (input: {
      transaction: typeof transaction;
      mutate: (tx: typeof transaction) => Promise<unknown>;
    }) => input.mutate(input.transaction)
  )
}));

import { recordBrowserDiscovery } from "./db-service";

describe("parked campaign discovery provenance", () => {
  it("carries the current-cycle campaign tag into later discovery evidence", async () => {
    const digest = "a".repeat(64);
    persistence.monitoringEventFindFirst.mockResolvedValue({
      audit: {
        action: "parked_cohort_admission",
        campaignRunId: "campaign-run-1",
        campaignMembershipDigest: digest,
        cycle: 4
      }
    });
    persistence.discoveryCreate.mockImplementation(async ({ data }) => data);
    persistence.queryRaw.mockResolvedValue([
      { updatedAt: new Date("2026-08-20T12:00:00.001Z") }
    ]);

    const result = await recordBrowserDiscovery(
      {
        courseId: "course-1",
        status: "LEARNED",
        detectedPlatform: "FOREUP",
        sourceUrl: "https://course.example/",
        bookingUrl: "https://foreupsoftware.com/index.php/booking/1/2#/teetimes",
        confidence: 0.95,
        evidence: {
          learnedFrom: "foreup-api-request",
          observedUrls: ["https://course.example/"]
        }
      },
      {
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        releaseSha: "b".repeat(40),
        deployedAt: new Date("2026-08-20T12:00:00.000Z"),
        runtimeVersion: "b".repeat(40),
        incidentId: "incident-1",
        courseId: "course-1",
        cycle: 4,
        stage: "RENDERED_BROWSER_DISCOVERY"
      },
      "b".repeat(40)
    );

    expect(persistence.monitoringEventFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          incidentId: "incident-1",
          eventType: "REVALIDATION_REQUESTED",
          source: "COURSE_SUPPORT_RESPONDER",
          AND: [
            { audit: { path: ["action"], equals: "parked_cohort_admission" } },
            { audit: { path: ["cycle"], equals: 4 } }
          ]
        })
      })
    );
    expect(result).toMatchObject({
      evidence: {
        campaign: {
          kind: "PARKED_COHORT",
          runId: "campaign-run-1",
          membershipDigest: digest,
          cycle: 4
        },
        customerDataIncluded: false
      }
    });
    expect(persistence.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      persistence.discoveryCreate.mock.invocationCallOrder[0]
    );
  });
});
