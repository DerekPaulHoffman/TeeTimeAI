import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { SearchEmailDeliveryInProgressError } from "@/lib/users/pending-email";
import { SearchCourseValidationError } from "@/lib/searches/service";
import {
  activateVerifiedRecoveryDemands, cancelRecoveryDemandForUser, getRecoveryDemandExpiry,
  getRecoveryDemandForUser, listPendingRecoveryDemandsForUser, saveRecoveryDemandForUser,
} from "./demand";

const mocks = vi.hoisted(() => ({ capacity: vi.fn(), lock: vi.fn(), createSearch: vi.fn(), schedule: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  $transaction: vi.fn(), user: { findUniqueOrThrow: vi.fn() },
  courseRecoveryRequest: { findUnique: vi.fn() },
  courseRecoveryDemand: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
} }));
vi.mock("@/lib/searches/service", () => {
  class RecoveryDemandNoLongerEligibleError extends Error {}
  class SearchCourseValidationError extends Error {
    readonly reason: "public_access" | "layout";
    constructor(message: string, reason: "public_access" | "layout") { super(message); this.reason = reason; }
  }
  return { assertQueueCapacityInTransaction: mocks.capacity, lockUserAlertCapacity: mocks.lock,
    createTeeSearchForUser: mocks.createSearch, RecoveryDemandNoLongerEligibleError, SearchCourseValidationError };
});
vi.mock("@/lib/automation/search-scheduler", () => ({ startSearchSchedule: mocks.schedule }));
const db = vi.mocked(prisma, { deep: true });
const settings = { date: "2026-10-10", startTime: "09:00", endTime: "16:00", players: 2,
  userTimeZone: "America/New_York", cadenceMinutes: 15, additionalEmails: ["FRIEND@example.com", "friend@example.com", "owner@example.com"] };
const owner = { id: "owner-1", email: "owner@example.com" };
function demand(extra: Record<string, unknown> = {}) {
  return { id: "demand-1", requestId: "request-1", userId: owner.id, status: "WAITING", revision: 1,
    settings: { ...settings, alertEmail: owner.email }, trafficClass: "TEST", teeSearchId: null,
    expiresAt: new Date("2026-10-12T00:00:00Z"), createdAt: new Date(), updatedAt: new Date(), ...extra } as never;
}
const verified = { id: "request-1", status: "VERIFIED", course: { id: "course-1", name: "Unfamiliar Municipal Course", googlePlaceId: "place-1",
  latitude: 41.1, longitude: -73.1, address: "8 Course Lane", website: "https://course.example", isPublic: true } };
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
  db.$transaction.mockImplementation(async worker => (worker as (transaction: typeof prisma) => unknown)(prisma));
  db.user.findUniqueOrThrow.mockResolvedValue({ email: "OWNER@example.com" } as never);
  db.courseRecoveryRequest.findUnique.mockResolvedValue({ id: "request-1", status: "QUEUED" } as never);
  db.courseRecoveryDemand.findUnique.mockResolvedValue(null);
  db.courseRecoveryDemand.updateMany.mockResolvedValue({ count: 1 });
  db.courseRecoveryDemand.create.mockResolvedValue(demand());
  db.courseRecoveryDemand.update.mockResolvedValue(demand({ revision: 2 }));
  db.courseRecoveryDemand.findMany.mockResolvedValue([]);
  mocks.createSearch.mockResolvedValue({ id: "search-1" }); mocks.schedule.mockResolvedValue({ runId: "run-1" });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("pending alert ownership and capacity", () => {
  it("locks account capacity before saving and derives primary recipient from current account", async () => {
    await saveRecoveryDemandForUser("request-1", owner, settings, "TEST");
    expect(mocks.lock).toHaveBeenCalledWith(prisma, owner.id);
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.capacity.mock.invocationCallOrder[0]);
    expect(mocks.capacity.mock.invocationCallOrder[0]).toBeLessThan(db.courseRecoveryDemand.create.mock.invocationCallOrder[0]);
    expect(db.courseRecoveryDemand.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: owner.id, requestId: "request-1", trafficClass: "TEST", expiresAt: new Date("2026-10-12T00:00:00Z"),
      settings: expect.objectContaining({ alertEmail: "owner@example.com", additionalEmails: ["friend@example.com"] }),
    }) });
  });
  it("does not save when all three slots are reserved", async () => {
    mocks.capacity.mockRejectedValue(new Error("Three alert slots are already in use"));
    await expect(saveRecoveryDemandForUser("request-1", owner, settings)).rejects.toThrow(/slots/);
    expect(db.courseRecoveryDemand.create).not.toHaveBeenCalled();
  });
  it("repeat identical settings do not extend deadlines, increment revision, or restart work", async () => {
    const stored = demand({ settings: { ...settings, additionalEmails: ["friend@example.com"], alertEmail: owner.email }, trafficClass: "UNCLASSIFIED" });
    db.courseRecoveryDemand.findUnique.mockResolvedValue(stored);
    const view = await saveRecoveryDemandForUser("request-1", owner, settings);
    expect(view?.revision).toBe(1); expect(db.courseRecoveryDemand.update).not.toHaveBeenCalled();
    expect(db.courseRecoveryDemand.create).not.toHaveBeenCalled(); expect(mocks.createSearch).not.toHaveBeenCalled();
  });
  it("owner editing a waiting demand increments its revision and excludes its reserved slot", async () => {
    db.courseRecoveryDemand.findUnique.mockResolvedValue(demand());
    await saveRecoveryDemandForUser("request-1", owner, { ...settings, players: 4 });
    expect(mocks.capacity).toHaveBeenCalledWith(prisma, owner.id, { excludeDemandId: "demand-1" });
    expect(db.courseRecoveryDemand.update).toHaveBeenCalledWith({ where: { id: "demand-1" },
      data: expect.objectContaining({ revision: { increment: 1 }, settings: expect.objectContaining({ players: 4 }) }) });
  });
  it.each(["CANCELLED", "EXPIRED", "ACTIVATED", "ACTION_REQUIRED"])("repeat submission never reopens %s", async status => {
    db.courseRecoveryDemand.findUnique.mockResolvedValue(demand({ status }));
    expect((await saveRecoveryDemandForUser("request-1", owner, settings))?.status).toBe(status);
    expect(db.courseRecoveryDemand.create).not.toHaveBeenCalled(); expect(db.courseRecoveryDemand.update).not.toHaveBeenCalled();
    expect(mocks.createSearch).not.toHaveBeenCalled();
  });
  it("owner GET never reads another owner's demand", async () => {
    expect(await getRecoveryDemandForUser("request-1", "other-owner")).toBeNull();
    expect(db.courseRecoveryDemand.findUnique).toHaveBeenCalledWith({ where: { requestId_userId: { requestId: "request-1", userId: "other-owner" } } });
  });
  it("reports a removed activated alert honestly without reopening it", async () => {
    db.courseRecoveryDemand.findUnique.mockResolvedValue(demand({ status: "ACTIVATED", teeSearchId: null }));
    expect(await getRecoveryDemandForUser("request-1", owner.id)).toMatchObject({
      status: "ACTIVATED", teeSearchId: null, message: expect.stringContaining("removed from your dashboard"),
    });
    expect(db.courseRecoveryDemand.update).not.toHaveBeenCalled(); expect(mocks.createSearch).not.toHaveBeenCalled();
  });
  it("owner cancellation serializes with activation and increments the revision", async () => {
    db.courseRecoveryDemand.findUnique.mockResolvedValue(demand());
    db.courseRecoveryDemand.update.mockResolvedValue(demand({ status: "CANCELLED", revision: 2 }));
    expect((await cancelRecoveryDemandForUser("request-1", owner.id)).status).toBe("CANCELLED");
    expect(db.courseRecoveryDemand.update).toHaveBeenCalledWith({ where: { id: "demand-1" }, data: { status: "CANCELLED", revision: { increment: 1 } } });
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(db.courseRecoveryDemand.update.mock.invocationCallOrder[0]);
  });
  it("activation cancellation is managed through the existing owner dashboard", async () => {
    db.courseRecoveryDemand.findUnique.mockResolvedValue(demand({ status: "ACTIVATED", teeSearchId: "search-1" }));
    await expect(cancelRecoveryDemandForUser("request-1", owner.id)).rejects.toThrow(/dashboard/);
    expect(db.courseRecoveryDemand.update).not.toHaveBeenCalled();
  });
  it("uses conservative date expiry until course timezone is known", () => {
    expect(getRecoveryDemandExpiry("2026-10-10").toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });
});

describe("owner pending recovery list", () => {
  const request = { name: "Harbor Dunes", town: "Harborville, CT" };

  it("locks and lists only this owner's current waiting demand with stable order and the shared three-slot bound", async () => {
    db.courseRecoveryDemand.findMany.mockResolvedValue([demand({ request })]);
    const views = await listPendingRecoveryDemandsForUser(owner.id);
    expect(mocks.lock).toHaveBeenCalledWith(prisma, owner.id);
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(db.courseRecoveryDemand.updateMany.mock.invocationCallOrder[0]);
    expect(db.courseRecoveryDemand.updateMany.mock.invocationCallOrder.at(-1)).toBeLessThan(db.courseRecoveryDemand.findMany.mock.invocationCallOrder[0]);
    expect(db.courseRecoveryDemand.findMany).toHaveBeenCalledWith({
      where: { userId: owner.id, status: "WAITING", expiresAt: { gt: new Date() } },
      include: { request: { select: { name: true, town: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 3,
    });
    expect(views).toEqual([expect.objectContaining({ id: "demand-1", requestId: "request-1",
      status: "WAITING", courseName: request.name, town: request.town,
      date: "2026-10-10", startTime: "09:00", endTime: "16:00", players: 2 })]);
    expect(views[0]).not.toHaveProperty("settings"); expect(views[0]).not.toHaveProperty("userId");
    expect(views[0]).not.toHaveProperty("alertEmail"); expect(views[0]).not.toHaveProperty("additionalEmails");
    expect(mocks.createSearch).not.toHaveBeenCalled(); expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it("reconciles expired and terminal waiting rows only for the signed-in owner before reading", async () => {
    expect(await listPendingRecoveryDemandsForUser("other-owner")).toEqual([]);
    expect(db.courseRecoveryDemand.updateMany).toHaveBeenCalledWith({
      where: { userId: "other-owner", status: "WAITING", expiresAt: { lte: new Date() } },
      data: { status: "EXPIRED", revision: { increment: 1 } },
    });
    for (const status of ["NEEDS_DETAILS", "NOT_PUBLIC", "UNRESOLVED", "ACCESS_LIMITED"]) {
      expect(db.courseRecoveryDemand.updateMany).toHaveBeenCalledWith({
        where: { userId: "other-owner", status: "WAITING", request: { status } },
        data: { status: "ACTION_REQUIRED", reason: expect.any(String), revision: { increment: 1 } },
      });
    }
    expect(db.courseRecoveryDemand.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "other-owner", status: "WAITING", expiresAt: { gt: new Date() } },
    }));
    expect(db.courseRecoveryDemand.create).not.toHaveBeenCalled(); expect(db.courseRecoveryDemand.update).not.toHaveBeenCalled();
  });

  it("retains multiple valid request receipts across repeated reads without changing demand", async () => {
    db.courseRecoveryDemand.findMany.mockResolvedValue([
      demand({ id: "demand-a", requestId: "request-a", request }),
      demand({ id: "demand-b", requestId: "request-b", request: { name: "Pine Creek", town: "Harborville, CT" } }),
    ]);
    const first = await listPendingRecoveryDemandsForUser(owner.id);
    expect(await listPendingRecoveryDemandsForUser(owner.id)).toEqual(first);
    expect(first.map(view => view.requestId)).toEqual(["request-a", "request-b"]);
    expect(db.courseRecoveryDemand.update).not.toHaveBeenCalled(); expect(mocks.createSearch).not.toHaveBeenCalled();
  });

  it("fails closed on corrupt saved settings without implicitly activating or cancelling demand", async () => {
    db.courseRecoveryDemand.findMany.mockResolvedValue([demand({ request, settings: { ...settings, date: "2026-02-30" } })]);
    await expect(listPendingRecoveryDemandsForUser(owner.id)).rejects.toThrow();
    expect(db.courseRecoveryDemand.update).not.toHaveBeenCalled(); expect(mocks.createSearch).not.toHaveBeenCalled();
    expect(db.courseRecoveryDemand.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CANCELLED" }),
    }));
    expect(db.courseRecoveryDemand.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "ACTIVATED" }),
    }));
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});

describe("verified demand promotion", () => {
  beforeEach(() => {
    db.courseRecoveryRequest.findUnique.mockResolvedValue(verified as never);
    db.courseRecoveryDemand.findMany.mockResolvedValue([demand()]);
  });
  it("passes the exact demand revision and canonical course to atomic search creation", async () => {
    expect(await activateVerifiedRecoveryDemands("request-1")).toEqual({ activated: 1, expired: 0, actionRequired: 0, skipped: 0 });
    expect(mocks.createSearch).toHaveBeenCalledWith(owner.id, expect.objectContaining({ courses: [expect.objectContaining({ courseId: "course-1", rank: 1 })] }),
      "TEST", false, { demandId: "demand-1", requestId: "request-1", expectedRevision: 1 });
    expect(mocks.schedule).toHaveBeenCalledWith("search-1");
  });
  it("preserves saved alert after launch failure without reopening pending demand", async () => {
    mocks.schedule.mockRejectedValue(new Error("Workflow unavailable")); vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await activateVerifiedRecoveryDemands("request-1")).activated).toBe(1);
    expect(db.courseRecoveryDemand.updateMany).not.toHaveBeenCalled();
  });
  it.each(["NEEDS_DETAILS", "NOT_PUBLIC", "UNRESOLVED", "ACCESS_LIMITED", "RETRY_WAIT"])("never starts demand for %s identity", async status => {
    db.courseRecoveryRequest.findUnique.mockResolvedValue({ ...verified, status } as never);
    expect((await activateVerifiedRecoveryDemands("request-1")).activated).toBe(0); expect(mocks.createSearch).not.toHaveBeenCalled();
  });
  it("expires elapsed demand with revision CAS before creating an alert", async () => {
    db.courseRecoveryDemand.findMany.mockResolvedValue([demand({ expiresAt: new Date("2026-09-29") })]);
    expect((await activateVerifiedRecoveryDemands("request-1")).expired).toBe(1);
    expect(db.courseRecoveryDemand.updateMany).toHaveBeenCalledWith({ where: { id: "demand-1", status: "WAITING", revision: 1 }, data: { status: "EXPIRED", revision: { increment: 1 } } });
    expect(mocks.createSearch).not.toHaveBeenCalled();
  });
  it("also expires when canonical course-local date is no longer future", async () => {
    mocks.createSearch.mockRejectedValue(new Error("Search date must be in the future for every selected course"));
    expect((await activateVerifiedRecoveryDemands("request-1")).expired).toBe(1); expect(mocks.schedule).not.toHaveBeenCalled();
  });
  it("requires an owner settings decision for incompatible known physical layout", async () => {
    mocks.createSearch.mockRejectedValue(new SearchCourseValidationError("This course does not have the requested 9-hole layout", "layout"));
    expect((await activateVerifiedRecoveryDemands("request-1")).actionRequired).toBe(1);
    expect(db.courseRecoveryDemand.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: {
      status: "ACTION_REQUIRED", reason: "This course does not have the requested 9-hole layout", revision: { increment: 1 } } }));
  });
  it("keeps transient persistence failure waiting for automatic retry", async () => {
    mocks.createSearch.mockRejectedValue(new Error("Connection unavailable"));
    expect((await activateVerifiedRecoveryDemands("request-1")).skipped).toBe(1); expect(db.courseRecoveryDemand.updateMany).not.toHaveBeenCalled();
  });
  it.each([
    "Invalid prisma.course.findUnique() invocation: select layoutHoleCounts; Can't reach whole-db.internal at postgresql://operator:secret@whole-db.internal/database",
    "Database public golf courses layout table unavailable; password=secret",
  ])("never persists infrastructure errors containing validation keywords: %s", async message => {
    mocks.createSearch.mockRejectedValue(new Error(message));
    expect(await activateVerifiedRecoveryDemands("request-1")).toEqual({ activated: 0, expired: 0, actionRequired: 0, skipped: 1 });
    expect(db.courseRecoveryDemand.updateMany).not.toHaveBeenCalled(); expect(mocks.schedule).not.toHaveBeenCalled();
  });
  it("retains a typed public-access validation failure as a precise owner action", async () => {
    mocks.createSearch.mockRejectedValue(new SearchCourseValidationError("Tee Time Spot can only create alerts for public golf courses.", "public_access"));
    expect((await activateVerifiedRecoveryDemands("request-1")).actionRequired).toBe(1);
    expect(db.courseRecoveryDemand.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: "ACTION_REQUIRED", reason: "Tee Time Spot can only create alerts for public golf courses.",
    }) }));
  });
  it("retains waiting demand during a pending primary-email transition and activates once after it clears", async () => {
    mocks.createSearch.mockRejectedValueOnce(new SearchEmailDeliveryInProgressError());
    expect((await activateVerifiedRecoveryDemands("request-1")).skipped).toBe(1);
    expect(db.courseRecoveryDemand.updateMany).not.toHaveBeenCalled(); expect(mocks.schedule).not.toHaveBeenCalled();
    expect((await activateVerifiedRecoveryDemands("request-1")).activated).toBe(1);
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
  });
});
