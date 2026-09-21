import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), count: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { courseSupportBatch: { findMany: mocks.findMany, count: mocks.count }, $transaction: mocks.transaction } }));
import { assessCustomerRecovery, refreshPendingCustomerRecoveries, type CustomerRecoverySearch } from "./course-support-customer-recovery";

const floor = new Date("2026-09-21T12:00:00Z");
const now = new Date("2026-09-21T12:20:00Z");
const releaseSha = "a".repeat(40);
function search(): CustomerRecoverySearch {
  return {
    id: "private-search", status: "ACTIVE", trafficClass: "PUBLIC", scheduleVersion: 3, alertGeneration: 2,
    alertEmail: null, additionalEmails: ["extra@example.com"], user: { email: "owner@example.com" },
    workflowRunId: "wrun_live", checkStatus: "WAITING", checkLeaseToken: null, checkLeaseExpiresAt: null,
    nextCheckAt: new Date("2026-09-21T12:30:00Z"), lastCheckedAt: new Date("2026-09-21T12:16:00Z"),
    preferences: [{ courseId: "private-course" }],
    probes: ["12:01", "12:16"].map((time, i) => ({ courseId: "private-course", automationRunId: `run-${i}`,
      outcome: "NO_MATCH", observedAt: new Date(`2026-09-21T${time}:00Z`), runtimeVersion: releaseSha,
      rawSummary: { providerExecution: "RUNNABLE_PROVIDER_CHECK", providerObservedAt: new Date(`2026-09-21T${time}:00Z`).toISOString() } })),
    emailDeliveries: ["owner@example.com", "extra@example.com"].map(recipient => ({ recipient,
      alertGeneration: 2, status: "SENT", sentAt: new Date("2026-09-21T12:02:00Z"), payload: {
        schemaVersion: 2, checkedAt: "2026-09-21T12:01:00Z", statusReport: { kind: "recovery", courses: [
          { courseId: "private-course", outcome: "NO_MATCH" },
        ] },
      } })),
  };
}
function assess(value = search(), previous?: unknown) {
  return assessCustomerRecovery({ searches: [{ dispatchedVersion: 3, search: value }], courseIds: ["private-course"],
    releaseSha, evidenceSince: floor, notificationSince: floor, now, previous });
}

describe("customer recovery acceptance", () => {
  it("requires two real provider cycles, a live schedule, and every current recipient's visible accepted notice", () => {
    const result = assess();
    expect(result).toMatchObject({ status: "COMPLETE", affectedSearchCount: 1, pendingProviderPairCount: 0, pendingSchedulerCount: 0, pendingRecipientCourseCount: 0 });
    const serialized = JSON.stringify(result);
    for (const sensitive of ["private-search", "private-course", "owner@example.com", "extra@example.com", "wrun_live"]) expect(serialized).not.toContain(sensitive);
  });
  it("does not treat a successful first check, reused run, or duplicated provider observation as follow-up proof", () => {
    const value = search();
    value.probes.pop();
    expect(assess(value).pendingProviderPairCount).toBe(1);
    value.probes.push({ ...value.probes[0], observedAt: now });
    expect(assess(value).pendingProviderPairCount).toBe(1);
  });
  it("keeps recovery open for the additional recipient despite successful owner delivery", () => {
    const value = search(); value.emailDeliveries[1].status = "SUPPRESSED";
    expect(assess(value)).toMatchObject({ status: "OPEN", pendingRecipientCourseCount: 1 });
  });
  it("rejects stale generation, a hidden snapshot, and a pending-source notice", () => {
    for (const change of [
      (v: CustomerRecoverySearch) => { v.emailDeliveries[0].alertGeneration--; },
      (v: CustomerRecoverySearch) => { v.emailDeliveries[0].payload = { schemaVersion: 2, checkedAt: now.toISOString(), statusSnapshot: { courses: [{ courseId: "private-course", outcome: "NO_MATCH" }] } }; },
      (v: CustomerRecoverySearch) => { v.emailDeliveries[0].payload = { schemaVersion: 2, checkedAt: now.toISOString(), statusReport: { courses: [{ courseId: "private-course", outcome: "FETCH_FAILED" }] } }; },
    ]) { const value = search(); change(value); expect(assess(value).pendingRecipientCourseCount).toBe(1); }
  });
  it("accepts a matching-times email as the recovery notice", () => {
    const value = search();
    for (const delivery of value.emailDeliveries) delivery.payload = { schemaVersion: 2, checkedAt: now.toISOString(), matchReport: { matches: [{ courseId: "private-course" }] } };
    expect(assess(value).status).toBe("COMPLETE");
  });
  it("rejects later failures and a stopped scheduler even after two successes", () => {
    const value = search();
    value.probes.push({ ...value.probes[1], outcome: "FETCH_FAILED", observedAt: now, rawSummary: { providerExecution: "RUNNABLE_PROVIDER_CHECK", providerObservedAt: now.toISOString() } });
    value.checkStatus = "STOPPED";
    expect(assess(value)).toMatchObject({ status: "OPEN", pendingProviderPairCount: 1, pendingSchedulerCount: 1 });
  });
  it("starts a durable new evidence floor on owner edits", () => {
    const value = search(); const previous = assess(value); value.scheduleVersion++; value.alertGeneration++;
    const edited = assess(value, previous);
    expect(edited.status).toBe("OPEN");
    expect(Object.values(edited.searches)[0].evidenceSince).toBe(now.toISOString());
    expect(assess(value, edited).searches).toEqual(edited.searches);
  });
  it("does not send or require customer emails for ended demand or engineering tests", () => {
    for (const status of ["PAUSED", "CANCELLED", "COMPLETED"]) { const value = search(); value.status = status; expect(assess(value).status).toBe("NO_ACTIVE_DEMAND"); }
    for (const trafficClass of ["TEST", "AUTOMATION"]) { const value = search(); value.trafficClass = trafficClass; expect(assess(value).status).toBe("NO_ACTIVE_DEMAND"); }
  });
  it("uses current recipients without retaining removed recipients", () => {
    const value = search(); value.additionalEmails = []; value.emailDeliveries.pop();
    expect(assess(value).status).toBe("COMPLETE");
  });
});

describe("durable recovery across responder runs", () => {
  beforeEach(() => vi.clearAllMocks());
  it("revisits a closed provider batch and persists completion only after the missing delivery arrives", async () => {
    const value = search(); const extra = value.emailDeliveries.pop()!;
    const batch = { id: "batch", reference: "CS-test", createdAt: floor, releaseSha, deployedAt: floor,
      recheckDispatchStartedAt: floor, revision: 1, summary: { customerRecoveryVersion: 1, customerRecovery: assess(value) },
      incidents: [{ courseId: "private-course" }] };
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]), courseSupportBatchSearch: { findMany: vi.fn().mockImplementation(() => [{ scheduleVersion: 3, teeSearch: value }]) },
      courseSupportBatch: { updateMany: vi.fn().mockImplementation(({ where, data }) => {
        expect(where.revision).toBe(batch.revision); batch.summary = data.summary; batch.revision++; return { count: 1 };
      }) } };
    mocks.findMany.mockImplementation(() => [batch]);
    mocks.count.mockImplementation(() => batch.summary.customerRecovery.status === "OPEN" ? 1 : 0);
    mocks.transaction.mockImplementation(fn => fn(tx));
    expect(await refreshPendingCustomerRecoveries(now)).toMatchObject({ completedCount: 0, pendingCount: 1 });
    value.emailDeliveries.push(extra);
    expect(await refreshPendingCustomerRecoveries(now)).toMatchObject({ completedCount: 1, pendingCount: 0 });
    expect(batch.summary.customerRecovery.status).toBe("COMPLETE");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
