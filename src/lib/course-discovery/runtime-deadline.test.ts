import { describe, expect, it, vi } from "vitest";
import { recipeExecutionDeadline, resumeColdStartTrace, type ColdStartTrace } from "./runtime";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("./service", () => ({ assertActiveAccessRecipeInTransaction: vi.fn(), getActiveAccessRecipe: vi.fn() }));

describe("cold discovery execution budget", () => {
  const now = new Date("2026-10-20T14:12:30Z");
  const cold: ColdStartTrace = { discoveryJobId: "job", firstPickedUpAt: "2026-10-20T14:00:00Z", deadlineAt: "2026-10-20T14:15:00Z",
    firstWarmQueuedAt: now.toISOString(), initialExecution: true, firstWarmExceeded: false };
  it("retains the original first-warm cap after serialization and process restart", () => {
    const restored = JSON.parse(JSON.stringify(cold));
    expect(recipeExecutionDeadline(now, restored).toISOString()).toBe(new Date(cold.deadlineAt).toISOString());
  });
  it("gives subsequent normal checks their ordinary three-minute budget", () => {
    expect(recipeExecutionDeadline(now, { ...cold, initialExecution: false }).toISOString()).toBe("2026-10-20T14:15:30.000Z");
    expect(recipeExecutionDeadline(now).toISOString()).toBe("2026-10-20T14:15:30.000Z");
  });
  it("allows useful late work after an already missed deadline", () => {
    expect(recipeExecutionDeadline(new Date("2026-10-20T14:16:00Z"), { ...cold, firstWarmExceeded: true }).toISOString()).toBe("2026-10-20T14:19:00.000Z");
  });
  it("does not relabel a historical on-time first warm as late during later checks", () => {
    const nextDay = new Date("2026-10-21T14:00:00Z");
    const trace = resumeColdStartTrace({ ...cold, firstWarmFinishedAt: "2026-10-20T14:13:00Z", firstWarmStatus: "AVAILABLE" }, nextDay);
    expect(trace).toMatchObject({ firstWarmExceeded: false, currentLateFromColdDeadline: true, initialExecution: false, firstWarmFinishedAt: "2026-10-20T14:13:00Z" });
  });
});
