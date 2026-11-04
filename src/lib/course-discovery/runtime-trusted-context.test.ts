// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ active: vi.fn(), assert: vi.fn(), pilot: vi.fn(), db: { $transaction: vi.fn(), $queryRaw: vi.fn(),
  course: { findUnique: vi.fn() }, courseOffering: { findUnique: vi.fn() }, courseAccessRecipe: { findUniqueOrThrow: vi.fn() },
  localReaderJob: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() }, teeSearch: { findUnique: vi.fn() } } }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("./service", () => ({ getActiveAccessRecipe: mocks.active, assertActiveAccessRecipeInTransaction: mocks.assert }));
vi.mock("./config", () => ({ isDiscoveryPilotSearch: mocks.pilot }));
import { claimNextRecipeExecution, completeRecipeExecution, recipeExecutionNeedsRepair } from "./runtime";

let context: Record<string, unknown>;
let active: Record<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  context = { searchId: "search1", target: { courseId: "course1", kind: "OUTDOOR" }, recipeId: "recipe1", recipeHash: "a".repeat(64), alertGeneration: 1,
    input: { date: "2030-01-02", timeZone: "America/Denver", players: 2, startTime: "09:00", endTime: "17:00" }, trustedContext: { canonicalCoursePhone: "+13035551234" } };
  active = { record: { id: "recipe1", hash: "a".repeat(64) }, recipe: { engine: "EXISTING_ADAPTER", adapter: { family: "CPS", officialPostalConflictProof: {} } },
    trustedContext: { canonicalCoursePhone: "+13035551234" } };
  mocks.active.mockImplementation(async () => active); mocks.pilot.mockResolvedValue(true);
  mocks.db.localReaderJob.findMany.mockImplementation(async () => [{ id: "job1", purpose: "RECIPE_CHECK", status: "PENDING", leaseToken: null, scheduleVersion: 2, sourceContext: context, jobExpiresAt: new Date("2030-01-02") }]);
  mocks.db.localReaderJob.updateMany.mockResolvedValue({ count: 1 });
  mocks.db.teeSearch.findUnique.mockResolvedValue({ id: "search1", status: "ACTIVE", alertGeneration: 1, scheduleVersion: 2, date: new Date("2030-01-02"), endTime: "17:00", userTimeZone: "UTC", preferences: [{ courseId: "course1" }] });
});
describe("current durable phone context on warm claim", () => {
  it.each(["valid", "unlisted room", "wrong room identity", "wrong product", "partial interval"])("accepts only verified full rental room evidence on normal execution: %s", async change => {
    const bookingUrl = "https://first-room.youcanbook.me/", now = new Date();
    const rooms = ["12345678-1234-4234-8234-123456789abc", "12345678-1234-4234-8234-123456789abd"].map((profileId, index) => ({
      profileId, label: `Room ${index + 1}`, officialPageUrl: `https://golf.example.com/room-${index + 1}/`,
      bookingUrl: index ? "https://second-room.youcanbook.me/" : bookingUrl, durationMinutes: 50, contextSha256: "a".repeat(64),
    }));
    const payload = { engine: "EXISTING_ADAPTER", source: { bookingUrl }, adapter: { family: "YOUCANBOOKME",
      officialEntryUrl: "https://golf.example.com/rooms/", catalogSha256: "b".repeat(64), rooms } };
    context.target = { courseId: "course1", offeringId: "offering1", kind: "SIMULATOR" };
    context.input = { ...(context.input as object), durationMinutes: 50 };
    const row = { id: "job1", purpose: "RECIPE_CHECK", status: "LEASED", leaseToken: "owned", sourceContext: context,
      scheduleVersion: 2, claimedAt: new Date(now.getTime() - 1000), leaseExpiresAt: new Date(now.getTime() + 60000), jobExpiresAt: new Date(now.getTime() + 60000) };
    mocks.db.$transaction.mockImplementation(async callback => callback(mocks.db)); mocks.db.$queryRaw.mockResolvedValue([]);
    mocks.db.localReaderJob.findUnique.mockResolvedValue(row);
    mocks.db.courseAccessRecipe.findUniqueOrThrow.mockResolvedValue({ payload });
    mocks.db.courseOffering.findUnique.mockResolvedValue({ activeAccessRecipeId: "recipe1" });
    mocks.db.teeSearch.findUnique.mockResolvedValue({ id: "search1", status: "ACTIVE", alertGeneration: 1, scheduleVersion: 2,
      preferences: [{ courseId: "course1", offeringId: "offering1" }] });
    const slots = rooms.map(room => ({ sourceId: `ycbm:${room.profileId}:${Date.parse("2030-01-02T17:00:00Z")}:50`,
      startsAt: "2030-01-02T17:00:00Z", endsAt: "2030-01-02T17:50:00Z", bookingUrl: room.bookingUrl,
      resourceId: room.profileId, productId: `ycbm:${room.profileId}:50`, availableSpots: 1, capacity: null }));
    if (change === "unlisted room") slots[1].bookingUrl = "https://unlisted.youcanbook.me/";
    if (change === "wrong room identity") slots[1].resourceId = rooms[0].profileId;
    if (change === "wrong product") slots[1].productId = `ycbm:${rooms[1].profileId}:60`;
    if (change === "partial interval") slots[1].endsAt = "2030-01-02T17:45:00Z";
    const result = { status: "AVAILABLE", complete: true, observedAt: now.toISOString(), sourceUrl: bookingUrl, slots,
      evidence: { recipeHash: "a".repeat(64), venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } };
    if (change === "valid") {
      await expect(completeRecipeExecution("job1", "owned", result)).resolves.toMatchObject({ complete: true });
      expect(mocks.db.localReaderJob.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        status: "COMPLETED", result: expect.objectContaining({ slots }),
      }) }));
    } else {
      await expect(completeRecipeExecution("job1", "owned", result)).rejects.toThrow("Invalid recipe slot");
      expect(mocks.db.localReaderJob.update).not.toHaveBeenCalled();
    }
  });
  it.each(["unchanged", "changed", "absent"])("binds %s service-pool phone before simulator warm launch", async change => {
    context.target = { courseId: "course1", offeringId: "offering1", kind: "SIMULATOR" };
    active.recipe = { engine: "EXISTING_ADAPTER", adapter: { family: "USCHEDULE", publicLocationProof: { kind: "PUBLIC_LOCATION_SERVICE_POOL_V1" } } };
    mocks.db.teeSearch.findUnique.mockResolvedValue({ status: "ACTIVE", alertGeneration: 1, scheduleVersion: 2,
      date: new Date("2030-01-02"), endTime: "17:00", userTimeZone: "UTC",
      preferences: [{ courseId: "course1", offeringId: "offering1" }] });
    if (change === "changed") active.trustedContext = { canonicalCoursePhone: "+13035554321" };
    if (change === "absent") delete context.trustedContext;
    if (change === "unchanged") expect(await claimNextRecipeExecution("worker1")).toMatchObject({ trustedContext: active.trustedContext });
    else expect(await claimNextRecipeExecution("worker1")).toBeNull();
  });
  it("keeps the old public-location profile free from the new phone requirement", async () => {
    active.recipe = { engine: "EXISTING_ADAPTER", adapter: { family: "USCHEDULE", publicLocationProof: { kind: "PUBLIC_LOCATION_RENTAL_V1" } } };
    delete context.trustedContext; delete active.trustedContext;
    expect(await claimNextRecipeExecution("worker1")).toHaveProperty("id", "job1");
  });
  it.each(["unchanged", "changed", "absent"])("rechecks %s parent Course phone before completing simulator evidence", async change => {
    context.target = { courseId: "course1", offeringId: "offering1", kind: "SIMULATOR" };
    context.input = { ...(context.input as object), durationMinutes: 60 };
    const payload = { engine: "EXISTING_ADAPTER", source: { bookingUrl: "https://clients.uschedule.com/examplegolf/booking?filter=loc[82]" },
      adapter: { family: "USCHEDULE", publicLocationProof: { kind: "PUBLIC_LOCATION_SERVICE_POOL_V1" } } };
    const now = new Date(), row = { id: "job1", purpose: "RECIPE_CHECK", status: "LEASED", leaseToken: "owned", sourceContext: context,
      scheduleVersion: 2, claimedAt: new Date(now.getTime() - 1000), leaseExpiresAt: new Date(now.getTime() + 60000), jobExpiresAt: new Date(now.getTime() + 60000) };
    mocks.db.$transaction.mockImplementation(async callback => callback(mocks.db)); mocks.db.$queryRaw.mockResolvedValue([]);
    mocks.db.localReaderJob.findUnique.mockResolvedValue(row);
    mocks.db.courseAccessRecipe.findUniqueOrThrow.mockResolvedValue({ payload });
    mocks.db.courseOffering.findUnique.mockResolvedValue({ activeAccessRecipeId: "recipe1" });
    mocks.db.course.findUnique.mockResolvedValue(change === "absent" ? { phone: null } : { phone: change === "changed" ? "+13035554321" : "+13035551234" });
    mocks.db.teeSearch.findUnique.mockResolvedValue({ id: "search1", status: "ACTIVE", alertGeneration: 1, scheduleVersion: 2,
      preferences: [{ courseId: "course1", offeringId: "offering1" }] });
    const result = { status: "EMPTY", complete: true, observedAt: now.toISOString(), sourceUrl: payload.source.bookingUrl, slots: [],
      evidence: { recipeHash: "a".repeat(64), venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } };
    if (change === "unchanged") {
      await expect(completeRecipeExecution("job1", "owned", result)).resolves.toMatchObject({ complete: true });
      expect(mocks.db.course.findUnique).toHaveBeenCalledWith({ where: { id: "course1" }, select: { phone: true } });
    } else {
      await expect(completeRecipeExecution("job1", "owned", result)).rejects.toThrow("no longer current");
      expect(mocks.db.localReaderJob.update).not.toHaveBeenCalled(); expect(mocks.assert).not.toHaveBeenCalled();
    }
  });
  it.each(["unchanged", "changed", "absent"])("binds %s ForeUP ownership phone before warm launch", async change => {
    active.recipe = { engine: "EXISTING_ADAPTER", adapter: { family: "FOREUP", officialRouteOwnershipProof: {} } };
    if (change === "changed") context.trustedContext = { canonicalCoursePhone: "+13035554321" };if (change === "absent") delete context.trustedContext;
    if (change === "unchanged") expect(await claimNextRecipeExecution("worker1")).toMatchObject({ trustedContext: active.trustedContext });
    else expect(await claimNextRecipeExecution("worker1")).toBeNull();
  });
  it("keeps legacy ForeUP metadata free from a new private-phone requirement", async () => {
    active.recipe = { engine: "EXISTING_ADAPTER", adapter: { family: "FOREUP" } };delete context.trustedContext;delete active.trustedContext;
    expect(await claimNextRecipeExecution("worker1")).toHaveProperty("id", "job1");
  });
  it.each(["unchanged", "changed", "absent"])("binds %s delegated physical context before a warm launch", async change => {
    active.recipe = { engine: "EXISTING_ADAPTER", adapter: { family: "TEEITUP", officialDelegatedBookingProof: { physicalContactProof: {} } } };
    if (change === "changed") context.trustedContext = { canonicalCoursePhone: "+13035554321" };if (change === "absent") delete context.trustedContext;
    if (change === "unchanged") expect(await claimNextRecipeExecution("worker1")).toMatchObject({ trustedContext: active.trustedContext });
    else { expect(await claimNextRecipeExecution("worker1")).toBeNull();expect(mocks.db.localReaderJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "EXPIRED" } })); }
  });
  it("keeps legacy delegated native proofs free from a new phone requirement", async () => {
    active.recipe = { engine: "EXISTING_ADAPTER", adapter: { family: "TEEITUP", officialDelegatedBookingProof: {} } };delete context.trustedContext;delete active.trustedContext;
    expect(await claimNextRecipeExecution("worker1")).toHaveProperty("id", "job1");
  });
  it("returns unchanged TeeItUp omission context only to the private executor", async () => {
    active.recipe = { engine: "EXISTING_ADAPTER", adapter: { family: "TEEITUP", officialStreetTypeOmittedProof: {} } };
    expect(await claimNextRecipeExecution("worker1")).toMatchObject({ trustedContext: active.trustedContext });
  });
  it.each(["changed", "absent"])("expires %s TeeItUp omission context before launch", async change => {
    active.recipe = { engine: "EXISTING_ADAPTER", adapter: { family: "TEEITUP", officialStreetTypeOmittedProof: {} } };
    if (change === "changed") context.trustedContext = { canonicalCoursePhone: "+13035554321" };else delete context.trustedContext;
    expect(await claimNextRecipeExecution("worker1")).toBeNull();
    expect(mocks.db.localReaderJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "EXPIRED" } }));
  });
  it("does not give historical ordinary TeeItUp methods a new phone requirement", async () => {
    active.recipe = { engine: "EXISTING_ADAPTER", adapter: { family: "TEEITUP" } };delete context.trustedContext;delete active.trustedContext;
    expect(await claimNextRecipeExecution("worker1")).toHaveProperty("id", "job1");
  });
  it("returns only freshly server-derived context to the private executor", async () => {
    expect(await claimNextRecipeExecution("worker1")).toMatchObject({ trustedContext: active.trustedContext });
  });
  it.each(["changed", "absent"])("expires a %s queued context before launch", async change => {
    if (change === "changed") context.trustedContext = { canonicalCoursePhone: "+13035554321" };
    else delete context.trustedContext;
    expect(await claimNextRecipeExecution("worker1")).toBeNull();
    expect(mocks.db.localReaderJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "EXPIRED" } }));
  });
  it("keeps historical recipes without a phone proof compatible", async () => {
    delete context.trustedContext; active.recipe = { engine: "HTTP_JSON" }; delete active.trustedContext;
    expect(await claimNextRecipeExecution("worker1")).toHaveProperty("id", "job1");
  });
  it("keeps a missing local Chrome capability retryable without invalidating the saved recipe", () => {
    expect(recipeExecutionNeedsRepair({ status: "FAILED", complete: false, observedAt: new Date().toISOString(), sourceUrl: "https://publicgolf.cps.golf/", slots: [],
      evidence: { recipeHash: "a".repeat(64), venueVerified: false, dateVerified: false, capacityVerified: false, durationVerified: false, completeVerified: false, reason: "LOCAL_CHROME_REQUIRED" } })).toBe(false);
  });
});
