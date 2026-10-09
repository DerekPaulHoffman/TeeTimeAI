import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSimulatorOfferingManifest, parseSimulatorOfferingCommand, parseSimulatorOfferingManifest } from "../../../scripts/automation/manage-simulator-offerings";

const mocks = vi.hoisted(() => ({
  findReview: vi.fn(), upsertCourse: vi.fn(), updateCourse: vi.fn(), findOffering: vi.fn(), upsertOffering: vi.fn(),
  findOwners: vi.fn(), resolveIncident: vi.fn(), queryRaw: vi.fn(), transaction: vi.fn(), commit: vi.fn(),
  writerLease: vi.fn(), conflictRetry: vi.fn(), updateSearch: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/automation/course-support-batches", () => ({
  runWithCourseSupportWriterTransitionLease: mocks.writerLease,
  withCourseSupportWriteConflictRetry: mocks.conflictRetry,
}));
const originalDatabaseUrl = process.env.DATABASE_URL;
const now = new Date("2026-10-06T20:00:00.000Z");

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  mocks.queryRaw.mockImplementation(async (query: { strings: string[] }) => query.strings.join("").includes("clock_timestamp") ? [{ now }] : []);
  mocks.findReview.mockResolvedValue(null);
  mocks.upsertCourse.mockResolvedValue({ id: "venue-1", website: "https://venue.example", isPublic: true, layoutHoleCounts: [18], providerFamilyKey: "FOREUP" });
  mocks.findOffering.mockResolvedValue({ id: "offering-1", observationToken: null, observationExpiresAt: null });
  mocks.upsertOffering.mockResolvedValue({ id: "offering-1" });
  mocks.findOwners.mockResolvedValue([]);
  mocks.resolveIncident.mockResolvedValue({ count: 1 });
  mocks.writerLease.mockImplementation(async (operation: () => Promise<unknown>) => ({ acquired: true, value: await operation() }));
  mocks.conflictRetry.mockImplementation(async (operation: () => Promise<unknown>) => operation());
  mocks.transaction.mockImplementation(async (callback: (transaction: unknown) => Promise<unknown>) => {
    const value = await callback({
      $queryRaw: mocks.queryRaw, googlePlaceReview: { findUnique: mocks.findReview },
      course: { upsert: mocks.upsertCourse, update: mocks.updateCourse },
      courseOffering: { findUnique: mocks.findOffering, upsert: mocks.upsertOffering },
      automationRun: { findMany: mocks.findOwners }, simulatorSupportIncident: { updateMany: mocks.resolveIncident },
      teeSearch: { update: mocks.updateSearch },
    });
    mocks.commit(); return value;
  });
  process.env.DATABASE_URL = "postgresql://fixture-user:fixture-password@preview.example/simulator-test";
});
afterEach(() => {
  vi.useRealTimers();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

const manifest = {
  googlePlaceId: "actual-place-id", name: "Indoor Golf Venue", address: "10 Main St, Town CT",
  latitude: 41.2, longitude: -73.2, website: "https://venue.example", bookingUrl: "https://booking.example/bays",
  evidenceUrl: "https://venue.example/public-rentals", verifiedAt: "2026-09-01T12:00:00.000Z",
  publicAccessStatus: "PUBLIC", maxPartySize: 6, supportedDurationsMinutes: [120, 60, 120],
};
const classification = (reason: "MEMBERS_ONLY" | "NOT_SIMULATOR_RENTAL" = "MEMBERS_ONLY") => ({
  ...manifest, publicAccessStatus: "NOT_PUBLIC", notPublicReason: reason,
  verifiedAt: now.toISOString(), supportedDurationsMinutes: [],
});
const apply = { apply: true, expectedDatabaseHost: "preview.example" };

describe("protected simulator offering review command", () => {
  it("defaults to an unsent, unapplied dry run and normalizes durations", async () => {
    const command = parseSimulatorOfferingCommand(["--manifest", "reviewed-rentals.json"]);
    expect(command.apply).toBe(false);
    const rows = parseSimulatorOfferingManifest(manifest);
    expect(rows[0].supportedDurationsMinutes).toEqual([60, 120]);
    expect(await executeSimulatorOfferingManifest(rows, command)).toMatchObject({
      mode: "dry-run", offerings: [expect.objectContaining({ kind: "SIMULATOR", monitoringState: "UNKNOWN" })],
    });
    expect(mocks.writerLease).not.toHaveBeenCalled();
  });
  it("accepts only a source-bound one-hour USchedule manifest with opaque capacity", () => {
    const reviewed = { ...manifest, bookingUrl: "https://clients.uschedule.com/syntheticvenue/booking",
      maxPartySize: null, supportedDurationsMinutes: [60], providerFamilyKey: "USCHEDULE",
      providerMetadata: { tenant: "syntheticvenue", serviceId: "29547" } };
    expect(parseSimulatorOfferingManifest(reviewed)[0]).toMatchObject({ providerFamilyKey: "USCHEDULE",
      providerMetadata: { tenant: "syntheticvenue", serviceId: "29547" }, supportedDurationsMinutes: [60] });
    for (const changed of [{ bookingUrl: "https://clients.uschedule.com/other/booking" },
      { bookingUrl: "https://clients.uschedule.com/syntheticvenue/booking/changefield" },
      { providerMetadata: { tenant: "syntheticvenue", serviceId: "29547", session: "private" } },
      { supportedDurationsMinutes: [60, 90] }, { maxPartySize: 5 }]) {
      expect(() => parseSimulatorOfferingManifest({ ...reviewed, ...changed })).toThrow();
    }
    expect(mocks.writerLease).not.toHaveBeenCalled();
  });

  it("requires a named target before applying and rejects a different loaded target", async () => {
    expect(() => parseSimulatorOfferingCommand(["--manifest", "review.json", "--apply"])).toThrow("expected-database-host");
    await expect(executeSimulatorOfferingManifest(parseSimulatorOfferingManifest(manifest), {
      apply: true, expectedDatabaseHost: "does-not-match.example",
    })).rejects.toThrow("does not match");
    expect(mocks.writerLease).not.toHaveBeenCalled();
  });

  it.each([
    { website: "https://user:password@venue.example" }, { publicAccessStatus: "VERIFIED_PUBLIC" },
    { maxPartySize: 0 }, { supportedDurationsMinutes: [45] }, { googlePlaceId: "places/alias" },
    { verifiedAt: "2999-01-01T12:00:00.000Z" }, { automationEligibility: "ALLOWED" },
  ])("rejects unsafe or optimistic manifest fields %s", override => {
    expect(() => parseSimulatorOfferingManifest({ ...manifest, ...override })).toThrow();
  });

  it("rejects duplicate venue identities", () => {
    expect(() => parseSimulatorOfferingManifest([manifest, manifest])).toThrow("only once");
  });

  it("preserves existing venue intelligence and clears only expired observation authority", async () => {
    mocks.findOffering.mockResolvedValue({
      id: "offering-1", observationToken: "expired-observation", observationExpiresAt: new Date(now.getTime() - 1),
    });
    expect(await executeSimulatorOfferingManifest(parseSimulatorOfferingManifest(manifest), apply)).toMatchObject({
      mode: "applied", offerings: [{ courseId: "venue-1", offeringId: "offering-1" }],
    });
    expect(mocks.upsertCourse).toHaveBeenCalledWith(expect.objectContaining({ update: {}, create: expect.objectContaining({ isPublic: false }) }));
    const update = mocks.upsertOffering.mock.calls[0][0].update;
    expect(update).toMatchObject({
      monitoringState: "UNKNOWN", automationEligibility: "UNKNOWN", monitoringVerifiedAt: null,
      observationToken: null, observationExpiresAt: null, monitoringRevision: { increment: 1 },
    });
    expect(update).not.toHaveProperty("isPublic");
    expect(mocks.updateCourse).not.toHaveBeenCalled(); expect(mocks.resolveIncident).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000,
    });
    expect(mocks.queryRaw.mock.calls.map(([query]) => query.strings.join(""))).toEqual(expect.arrayContaining([
      expect.stringContaining('FROM "Course"'), expect.stringContaining('FROM "CourseOffering"'),
      expect.stringContaining('FROM "SimulatorSupportIncident"'),
    ]));
  });

  it("rejects credential-bearing metadata before database access", () => {
    expect(() => parseSimulatorOfferingManifest({
      ...manifest, providerMetadata: { request: { Authorization: "fixture-token" } },
    })).toThrow("credentials");
    expect(mocks.upsertCourse).not.toHaveBeenCalled();
  });

  it.each([
    { publicAccessStatus: "PUBLIC" }, { notPublicReason: "ACCOUNT_REQUIRED" },
    { verifiedAt: new Date(now.getTime() - 31 * 60_000).toISOString() },
    { evidenceUrl: "https://unrelated.example/membership" },
  ])("rejects invalid or stale explicit identity evidence %s", override => {
    expect(() => parseSimulatorOfferingManifest({ ...classification(), ...override })).toThrow();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("shows explicit identity disposition in a read-only dry run", async () => {
    expect(await executeSimulatorOfferingManifest(parseSimulatorOfferingManifest(classification()), { apply: false })).toMatchObject({
      mode: "dry-run", offerings: [expect.objectContaining({
        monitoringState: "FINAL_IDENTITY", automationEligibility: "BLOCKED", incidentDisposition: {
          status: "RESOLVED", reason: "MEMBERS_ONLY", evidenceUrl: manifest.evidenceUrl, resolvedAt: now.toISOString(), retryAt: null,
        },
      })],
    });
    expect(mocks.writerLease).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(["MEMBERS_ONLY", "NOT_SIMULATOR_RENTAL"] as const)("classifies only the offering and existing unowned incident as %s", async reason => {
    await executeSimulatorOfferingManifest(parseSimulatorOfferingManifest(classification(reason)), apply);
    expect(mocks.upsertCourse).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    expect(mocks.updateCourse).not.toHaveBeenCalled(); expect(mocks.updateSearch).not.toHaveBeenCalled();
    expect(mocks.upsertOffering).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        publicAccessStatus: "NOT_PUBLIC", monitoringState: "FINAL_IDENTITY", automationEligibility: "BLOCKED", verifiedAt: now,
      }),
    }));
    expect(mocks.resolveIncident).toHaveBeenCalledWith({
      where: { offeringId: "offering-1" },
      data: { status: "RESOLVED", reason, evidenceUrl: manifest.evidenceUrl, resolvedAt: now, retryAt: null },
    });
  });

  it("retains legacy NOT_PUBLIC manifests without inferring an identity reason", async () => {
    await executeSimulatorOfferingManifest(parseSimulatorOfferingManifest({ ...manifest, publicAccessStatus: "NOT_PUBLIC" }), apply);
    expect(mocks.upsertOffering.mock.calls[0][0].update).toMatchObject({ monitoringState: "UNKNOWN", automationEligibility: "UNKNOWN" });
    expect(mocks.resolveIncident).not.toHaveBeenCalled();
  });

  it("keeps newly configured public readers UNKNOWN until normal monitoring proves them", async () => {
    await executeSimulatorOfferingManifest(parseSimulatorOfferingManifest({ ...manifest, providerFamilyKey: "YOUR_GOLF_BOOKING" }), apply);
    expect(mocks.upsertOffering.mock.calls[0][0].update).toMatchObject({
      providerFamilyKey: "YOUR_GOLF_BOOKING", publicAccessStatus: "PUBLIC",
      monitoringState: "UNKNOWN", automationEligibility: "UNKNOWN", monitoringVerifiedAt: null,
    });
    expect(mocks.resolveIncident).not.toHaveBeenCalled(); expect(mocks.updateSearch).not.toHaveBeenCalled();
  });

  it.each(["RESERVED", "STARTING", "BOUND", "CONSUMED"])("preserves %s native support ownership", async state => {
    const simulatorClaim = {
      token: "owner-token", revision: 1, phase: "CLAIMED", claimedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() - 1).toISOString(),
      sourceFingerprint: "a".repeat(64), originalSourceFingerprint: "a".repeat(64), offeringRevision: 0,
      plannedPaths: [], releaseSha: null, branch: "automation/course-support-owned",
      deployment: null, recheckQueuedAt: null, verificationCycle: 0,
    };
    mocks.findOwners.mockResolvedValue([{ audit: { state, ...(state === "CONSUMED" ? { simulatorClaim } : {}) } }]);
    await expect(executeSimulatorOfferingManifest(parseSimulatorOfferingManifest(manifest), apply)).rejects.toThrow("live support ownership");
    expect(mocks.findOwners).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "RUNNING", audit: { path: ["target", "offeringId"], equals: "offering-1" } }),
    }));
    expect(mocks.upsertOffering).not.toHaveBeenCalled(); expect(mocks.resolveIncident).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled();
  });

  it.each([
    { observationToken: "live-observation", observationExpiresAt: new Date(now.getTime() + 60_000) },
    { observationToken: "unknown-expiry", observationExpiresAt: null },
    { observationToken: null, observationExpiresAt: new Date(now.getTime() + 60_000) },
  ])("preserves live or ambiguous provider observation %s", async observation => {
    mocks.findOffering.mockResolvedValue({ id: "offering-1", ...observation });
    await expect(executeSimulatorOfferingManifest(parseSimulatorOfferingManifest(classification()), apply)).rejects.toThrow("observation lease");
    expect(mocks.upsertOffering).not.toHaveBeenCalled(); expect(mocks.resolveIncident).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("aborts the entire single transaction if a later named offering is busy", async () => {
    mocks.upsertCourse.mockImplementation(async ({ where }) => ({ id: where.googlePlaceId, website: manifest.website }));
    mocks.findOffering.mockImplementation(async ({ where }) => ({
      id: where.courseId_kind.courseId + "-sim", observationToken: null, observationExpiresAt: null,
    }));
    mocks.findOwners.mockImplementation(async ({ where }) => where.audit.equals === "b-place-sim" ? [{ audit: { state: "STARTING" } }] : []);
    await expect(executeSimulatorOfferingManifest(parseSimulatorOfferingManifest([
      { ...manifest, googlePlaceId: "b-place" }, { ...manifest, googlePlaceId: "a-place" },
    ]), apply)).rejects.toThrow("live support ownership");
    expect(mocks.transaction).toHaveBeenCalledTimes(1); expect(mocks.upsertOffering).toHaveBeenCalledTimes(1); expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.upsertCourse.mock.calls.map(([argument]) => argument.where.googlePlaceId)).toEqual(["a-place", "b-place"]);
  });

  it("fails closed when the shared writer transition is occupied", async () => {
    mocks.writerLease.mockResolvedValue({ acquired: false });
    await expect(executeSimulatorOfferingManifest(parseSimulatorOfferingManifest(manifest), apply)).rejects.toThrow("writer transition is busy");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rechecks evidence age against database time before accepting classification", async () => {
    mocks.queryRaw.mockImplementation(async (query: { strings: string[] }) =>
      query.strings.join("").includes("clock_timestamp") ? [{ now: new Date(now.getTime() + 31 * 60_000) }] : []);
    await expect(executeSimulatorOfferingManifest(parseSimulatorOfferingManifest(classification()), apply)).rejects.toThrow("fresh evidence");
    expect(mocks.upsertOffering).not.toHaveBeenCalled(); expect(mocks.resolveIncident).not.toHaveBeenCalled();
  });

  it("does not replace an existing official website to justify identity classification", async () => {
    mocks.upsertCourse.mockResolvedValue({ id: "venue-1", website: "https://existing-official.example" });
    await expect(executeSimulatorOfferingManifest(parseSimulatorOfferingManifest(classification()), apply)).rejects.toThrow("exact existing official website");
    expect(mocks.upsertOffering).not.toHaveBeenCalled(); expect(mocks.updateCourse).not.toHaveBeenCalled();
  });
});
