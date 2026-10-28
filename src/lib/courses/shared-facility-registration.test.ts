import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  args: { values: { plan: "fixture.json", apply: false, "expected-database-host": "database.invalid" } },
  root: { id: "knolls", name: "Tashua Knolls Golf Course", isPublic: true, providerFamilyKey: "FOREUP", latitude: 41.24, longitude: -73.2,
    timeZone: "America/New_York", bookingMetadata: { scheduleId: 6654, bookingClassId: 14910, bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes" } },
  findUniqueOrThrow: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), transaction: vi.fn(), disconnect: vi.fn(), read: vi.fn(),
}));
const plan = { rootCourseId: "knolls", courses: [
  { existingCourseId: "knolls", name: "Tashua Knolls Golf Course", scheduleId: 6654, bookingClassId: 14910, layoutHoles: 18, layoutEvidenceUrl: "https://official.example/knolls" },
  { name: "Tashua Glen Golf Course", scheduleId: 6463, bookingClassId: 14911, layoutHoles: 9, layoutEvidenceUrl: "https://official.example/glen" },
] };
vi.mock("node:util", async original => {
  const value = { ...await original<typeof import("node:util")>(), parseArgs: () => mocks.args };
  return { ...value, default: value };
});
vi.mock("node:fs/promises", async original => {
  const value = { ...await original<typeof import("node:fs/promises")>(), readFile: async () => JSON.stringify(plan) };
  return { ...value, default: value };
});
vi.mock("@/lib/prisma", () => ({ prisma: {
  course: { findUniqueOrThrow: mocks.findUniqueOrThrow, findUnique: mocks.findUnique, upsert: mocks.upsert, updateMany: mocks.updateMany, findMany: mocks.findMany },
  $transaction: mocks.transaction, $disconnect: mocks.disconnect,
} }));
vi.mock("@/lib/automation/foreup-public-configuration", () => ({ readForeupStandardPublicSchedule: mocks.read }));
vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: async (_family: string, operation: () => unknown) => ({ acquired: true, value: await operation() }) }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@database.invalid/test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.args.values.apply = false;
  mocks.args.values["expected-database-host"] = "database.invalid";
  mocks.findUniqueOrThrow.mockResolvedValue(structuredClone(mocks.root));
  mocks.findUnique.mockResolvedValue(null);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.findMany.mockResolvedValue([mocks.root, { id: "glen" }]);
  mocks.transaction.mockImplementation(async callback => callback({ course: { findUnique: mocks.findUnique, upsert: mocks.upsert, updateMany: mocks.updateMany } }));
  mocks.read.mockImplementation(async input => ({ ...input, sourceBookingUrl: input.bookingUrl,
    bookingBaseUrl: `https://foreupsoftware.com/index.php/booking/21017/${input.scheduleId}#/teetimes` }));
});
afterEach(() => { process.exitCode = 0; vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function run() {
  await import("../../../scripts/automation/manage-shared-public-courses");
  await vi.waitFor(() => expect(mocks.disconnect).toHaveBeenCalledOnce());
}

describe("shared public course operator preparation", () => {
  it("verifies each sheet under the family lease without persisting a dry run", async () => {
    await run();
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.read).toHaveBeenNthCalledWith(2, expect.objectContaining({ courseName: "Tashua Glen Golf Course", scheduleId: 6463, bookingClassId: 14911 }));
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("requires the reviewed database target even with --apply", async () => {
    mocks.args.values.apply = true; mocks.args.values["expected-database-host"] = "wrong.invalid";
    await run();
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/exact database host/));
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("creates Glen with independent metadata and updates the root under compare-and-set", async () => {
    mocks.args.values.apply = true;
    await run();
    expect(mocks.upsert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      where: { id: expect.stringMatching(/^public-course-/) },
      create: expect.objectContaining({ name: "Tashua Glen Golf Course", layoutHoleCounts: [9],
        bookingMetadata: expect.objectContaining({ scheduleId: 6463, bookingClassId: 14911 }),
      }),
    }));
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "knolls", bookingMetadata: { equals: mocks.root.bookingMetadata } },
      data: { bookingMetadata: expect.objectContaining({ scheduleId: 6654, bookingClassId: 14910,
        sharedFacility: expect.objectContaining({ rootCourseId: "knolls", sourceBookingUrl: expect.any(String), verifiedAt: expect.any(String) }),
      }) },
    }));
  });
  it("refuses a failed class verification before any persistent change", async () => {
    mocks.args.values.apply = true; mocks.read.mockResolvedValue(null);
    await run();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/verification failed/));
  });
});
