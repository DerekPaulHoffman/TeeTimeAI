import { describe, expect, it } from "vitest";
import { recipeExecutionBlocksDelivery } from "./delivery-freshness";

const now = new Date("2030-01-01T12:00:00Z");
const demand = { id: "search", alertGeneration: 2, mode: "SIMULATOR", date: new Date("2030-01-02"), startTime: "10:00", endTime: "20:00", players: 2, durationMinutes: 60 };
const context = { searchId: demand.id, alertGeneration: 2, recipeHash: "hash", target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" },
  input: { date: "2030-01-02", startTime: "10:00", endTime: "20:00", players: 2, durationMinutes: 60 }, queuedAt: "2030-01-01T11:59:30Z" };
const matches = [{ courseId: "course", offeringId: "offering", lastConfirmedAt: new Date("2030-01-01T11:59:00Z") }];
const job = { status: "COMPLETED", sourceContext: context, result: { status: "EMPTY", observedAt: "2030-01-01T11:59:40Z" },
  jobExpiresAt: new Date("2030-01-01T12:03:00Z"), createdAt: new Date("2029-12-31"), updatedAt: now, claimedAt: new Date("2030-01-01T11:59:31Z"), completedAt: new Date("2030-01-01T11:59:41Z") };

describe("recipe observation fence for unsent matches", () => {
  it.each(["AVAILABLE", "EMPTY", "FAILED"])("defers a newer unconsumed %s result even after its result cache expires", status => {
    expect(recipeExecutionBlocksDelivery({ ...job, result: { ...job.result, status } }, matches, demand, now)).toBe(true);
  });
  it.each(["PENDING", "LEASED"])("defers an active newer %s execution, including a reused row", status => {
    expect(recipeExecutionBlocksDelivery({ ...job, status }, matches, demand, now)).toBe(true);
    expect(recipeExecutionBlocksDelivery({ ...job, status, jobExpiresAt: new Date(0) }, matches, demand, now)).toBe(false);
  });
  it("accepts only the exact server consumption marker", () => {
    const consumed = { recipeHash: "hash", observedAt: job.result.observedAt, consumedAt: now.toISOString() };
    expect(recipeExecutionBlocksDelivery({ ...job, sourceContext: { ...context, consumed } }, matches, demand, now)).toBe(false);
    expect(recipeExecutionBlocksDelivery({ ...job, sourceContext: { ...context, consumed: { ...consumed, observedAt: "2029-01-01" } } }, matches, demand, now)).toBe(true);
  });
  it("ignores another alert generation, target, or requested input", () => {
    for (const change of [{ alertGeneration: 3 }, { searchId: "other" }, { target: { ...context.target, offeringId: "other" } },
      { input: { ...context.input, durationMinutes: 90 } }]) {
      expect(recipeExecutionBlocksDelivery({ ...job, sourceContext: { ...context, ...change } }, matches, demand, now)).toBe(false);
    }
  });
  it("allows an older abandoned result superseded by a later canonical confirmation", () => {
    expect(recipeExecutionBlocksDelivery(job, [{ ...matches[0], lastConfirmedAt: now }], demand, now)).toBe(false);
  });
});
