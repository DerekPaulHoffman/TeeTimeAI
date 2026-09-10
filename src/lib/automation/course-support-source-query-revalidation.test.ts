import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(), $transaction: vi.fn(),
  courseSupportIncident: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  courseMonitoringStatus: { updateMany: vi.fn() },
  courseMonitoringEvent: { findUnique: vi.fn(), create: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { getSourceQueryRevalidationProof } from "./course-support-source-query-revalidation";
import { revalidateCoursesForSourceQueryChange } from "./course-monitoring";
import { obsoleteSourceQueryFixture } from "./course-support-source-query-revalidation.test-fixtures";
import { assessAutomationPlaybook } from "./course-monitoring-playbook";
import { buildCourseSupportSourceSearchContext } from "./course-support-source-search";

describe("material source query revalidation", () => {
  const now = new Date("2026-09-10T06:45:00Z");
  beforeEach(() => {
    vi.resetAllMocks();
    db.$transaction.mockImplementation(async worker => worker(db));
    db.$queryRaw.mockResolvedValue([{ now }]);
    db.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    db.courseSupportIncident.updateMany.mockResolvedValue({ count: 1 });
    db.courseMonitoringStatus.updateMany.mockResolvedValue({ count: 1 });
  });

  it.each([false, true])("recognizes the historical exhausted closeout with retainedSource=%s", retained => {
    expect(getSourceQueryRevalidationProof(obsoleteSourceQueryFixture(retained))).toMatchObject({
      priorRecipe: "QUOTED_IDENTITIES_V1", currentRecipe: "IDENTITY_TERMS_V2",
      sourceSearchEventId: "negative-source-query", closeoutEventId: "exhausted-closeout",
    });
  });

  it("retains operator decisions, active ownership, newer evidence and genuine technical limits", () => {
    const original = obsoleteSourceQueryFixture();
    const rejected = [
      ...["decisionActorId", "decisionAt", "decisionNote", "decisionEvidenceUrl", "decisionIdempotencyKey",
        "resolvedAt", "resolution", "resolutionMessage", "resolutionNotifiedAt", "activeBatchId"]
        .map(key => ({ ...original, [key]: "present" })),
      { ...original, status: "AUTO_INVESTIGATING" },
      { ...original, cycle: original.cycle + 1 },
      { ...original, course: { ...original.course, city: "Elsewhere" } },
      { ...original, course: { ...original.course, bookingAccessMode: "ACCOUNT_REQUIRED" } },
      { ...original, course: { ...original.course, automationReason: "CAPTCHA_OR_QUEUE" } },
      { ...original, course: { ...original.course, bookingMetadata: { courseId: "learned" } } },
      { ...original, course: { ...original.course, monitoringStatus: { ...original.course.monitoringStatus!, lastSuccessfulAt: now } } },
      { ...original, course: { ...original.course, monitoringStatus: { ...original.course.monitoringStatus!, state: "FINAL_TECHNICAL" } } },
      { ...original, monitoringEvents: original.monitoringEvents.slice(1) },
    ];
    for (const row of rejected) expect(getSourceQueryRevalidationProof(row as typeof original)).toBeNull();
    const currentNegative = structuredClone(original);
    currentNegative.monitoringEvents[1].audit = {
      ...currentNegative.monitoringEvents[1].audit as object,
      queryDigest: buildCourseSupportSourceSearchContext(original.course).queryDigest,
    };
    expect(getSourceQueryRevalidationProof(currentNegative)).toBeNull();
  });

  it("atomically starts one fresh cycle while preserving all historical evidence and query results", async () => {
    const row = obsoleteSourceQueryFixture(true);
    const ledger = structuredClone(row.attemptLedger);
    const evidence = structuredClone(row.monitoringEvents);
    const created: unknown[] = [];
    db.courseSupportIncident.findMany.mockResolvedValue([row]);
    db.courseSupportIncident.findUnique.mockImplementation(async () => structuredClone(row));
    db.courseSupportIncident.updateMany.mockImplementation(async ({ where, data }) => {
      if (where.revision !== row.revision || where.cycle !== row.cycle || row.activeBatchId !== null) return { count: 0 };
      Object.assign(row, data, { cycle: row.cycle + 1, revision: row.revision + 1 });
      return { count: 1 };
    });
    db.courseMonitoringStatus.updateMany.mockImplementation(async ({ where, data }) => {
      const status = row.course.monitoringStatus!;
      if (where.revision !== status.revision) return { count: 0 };
      Object.assign(status, data, { revision: status.revision + 1 });
      return { count: 1 };
    });
    db.courseMonitoringEvent.create.mockImplementation(async ({ data }) => { created.push(data); return data; });
    await expect(revalidateCoursesForSourceQueryChange("b".repeat(40))).resolves.toMatchObject({ requeued: 1 });
    expect(row).toMatchObject({ status: "AUTO_INVESTIGATING", cycle: 10, activeBatchId: null, confirmedAt: now, nextAttemptAt: now });
    expect(assessAutomationPlaybook(row.attemptLedger, row.cycle)).toMatchObject({ conclusion: "INCOMPLETE", nextStage: "OFFICIAL_IDENTITY" });
    expect(row.attemptLedger).toEqual(ledger);
    expect(row.monitoringEvents).toEqual(evidence);
    expect(created).toEqual([expect.objectContaining({ source: "RECOVERY_CRON", toState: "AUTO_INVESTIGATING",
      audit: expect.objectContaining({ priorCycle: 9, cycle: 10, sourceSearchEventId: "negative-source-query", preservesPriorAttemptEvents: true }) })]);
    await expect(revalidateCoursesForSourceQueryChange("c".repeat(40))).resolves.toMatchObject({ requeued: 0 });
    expect(db.courseSupportIncident.updateMany).toHaveBeenCalledTimes(1);
  });

  it("rechecks ownership under lock and never consumes a capability twice across deployments", async () => {
    const row = obsoleteSourceQueryFixture();
    db.courseSupportIncident.findMany.mockResolvedValue([row]);
    db.courseSupportIncident.findUnique.mockResolvedValue({ ...row, activeBatchId: "successor" });
    await expect(revalidateCoursesForSourceQueryChange("b".repeat(40))).resolves.toMatchObject({ requeued: 0 });
    db.courseSupportIncident.findUnique.mockResolvedValue(row);
    db.courseMonitoringEvent.findUnique.mockResolvedValue({ id: "already-consumed" });
    await expect(revalidateCoursesForSourceQueryChange("c".repeat(40))).resolves.toMatchObject({ requeued: 0 });
    expect(db.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(db.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });
});
