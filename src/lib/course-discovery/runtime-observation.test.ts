// @vitest-environment node
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const proof = vi.hoisted(() => ({ assert: vi.fn() }));
vi.mock("./service", () => ({ assertActiveAccessRecipeInTransaction: proof.assert, getActiveAccessRecipe: vi.fn() }));
import { assertRecipeObservationCurrent } from "./runtime";

const hash = "a".repeat(64);
const input = { jobId: "job1", recipeId: "recipe1", courseId: "course1", searchId: "search1" };
let context: Record<string, unknown>;
let row: Record<string, unknown>;
let search: Record<string, unknown>;
let tx: Prisma.TransactionClient;
beforeEach(() => {
  vi.resetAllMocks();
  proof.assert.mockResolvedValue({ hash });
  context = { searchId: "search1", target: { courseId: "course1", kind: "OUTDOOR" }, recipeId: "recipe1", recipeHash: hash, alertGeneration: 2,
    input: { date: "2030-01-02", timeZone: "UTC", players: 2, startTime: "09:00", endTime: "17:00" } };
  row = { status: "COMPLETED", purpose: "RECIPE_CHECK", courseId: "course1", targetDate: "2030-01-02", players: 2, scheduleVersion: 5,
    resumeScheduleVersion: null, resultExpiresAt: new Date(Date.now() + 90_000), sourceContext: context,
    result: { status: "EMPTY", complete: true, observedAt: new Date().toISOString(), sourceUrl: "https://golf.example.com/times", slots: [],
      evidence: { recipeHash: hash, venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } } };
  search = { status: "ACTIVE", mode: "OUTDOOR", alertGeneration: 2, scheduleVersion: 5, date: new Date("2030-01-02T00:00:00.000Z"), players: 2, startTime: "09:00", endTime: "17:00" };
  tx = { localReaderJob: { findUnique: vi.fn(async () => row) }, teeSearch: { findUnique: vi.fn(async () => search) } } as unknown as Prisma.TransactionClient;
});

describe("canonical recipe observation fence", () => {
  it("accepts the exact current result and an explicitly attached resume version", async () => {
    await expect(assertRecipeObservationCurrent(tx, input)).resolves.toBeUndefined();
    search.scheduleVersion = 6; context.resumeScheduleVersion = 6;
    await expect(assertRecipeObservationCurrent(tx, input)).resolves.toBeUndefined();
  });
  it.each(["cancel", "generation", "schedule", "parameters"])("rejects changed demand: %s", async change => {
    if (change === "cancel") search.status = "CANCELLED";
    if (change === "generation") search.alertGeneration = 3;
    if (change === "schedule") search.scheduleVersion = 6;
    if (change === "parameters") search.players = 3;
    await expect(assertRecipeObservationCurrent(tx, input)).rejects.toThrow();
  });
  it("rejects a job bound to another recipe or target", async () => {
    context.recipeId = "recipe2";
    await expect(assertRecipeObservationCurrent(tx, input)).rejects.toThrow();
    context.recipeId = "recipe1"; context.target = { courseId: "course2", kind: "OUTDOOR" };
    await expect(assertRecipeObservationCurrent(tx, input)).rejects.toThrow();
  });
  it("requires the active source fingerprint and exact immutable recipe hash", async () => {
    proof.assert.mockRejectedValueOnce(new Error("Source changed"));
    await expect(assertRecipeObservationCurrent(tx, input)).rejects.toThrow("Source changed");
    proof.assert.mockResolvedValue({ hash: "b".repeat(64) });
    await expect(assertRecipeObservationCurrent(tx, input)).rejects.toThrow("version changed");
  });
  it("rejects expired or unsuccessful observations", async () => {
    row.resultExpiresAt = new Date(0);
    await expect(assertRecipeObservationCurrent(tx, input)).rejects.toThrow();
    row.resultExpiresAt = new Date(Date.now() + 90_000);
    row.result = { ...(row.result as object), status: "FAILED", complete: false };
    await expect(assertRecipeObservationCurrent(tx, input)).rejects.toThrow();
  });
});
