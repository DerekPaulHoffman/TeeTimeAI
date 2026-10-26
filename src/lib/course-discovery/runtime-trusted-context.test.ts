// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ active: vi.fn(), pilot: vi.fn(), db: { localReaderJob: { findMany: vi.fn(), updateMany: vi.fn() }, teeSearch: { findUnique: vi.fn() } } }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("./service", () => ({ getActiveAccessRecipe: mocks.active, assertActiveAccessRecipeInTransaction: vi.fn() }));
vi.mock("./config", () => ({ isDiscoveryPilotSearch: mocks.pilot }));
import { claimNextRecipeExecution, recipeExecutionNeedsRepair } from "./runtime";

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
