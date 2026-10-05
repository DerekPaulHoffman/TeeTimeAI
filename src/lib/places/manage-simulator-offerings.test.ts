import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSimulatorOfferingManifest, parseSimulatorOfferingCommand, parseSimulatorOfferingManifest } from "../../../scripts/automation/manage-simulator-offerings";

const mocks = vi.hoisted(() => ({ findReview: vi.fn(), upsertCourse: vi.fn(), upsertOffering: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: async (callback: (transaction: unknown) => unknown) => callback({
  googlePlaceReview: { findUnique: mocks.findReview }, course: { upsert: mocks.upsertCourse }, courseOffering: { upsert: mocks.upsertOffering }
}) } }));
const originalDatabaseUrl = process.env.DATABASE_URL;
afterEach(() => { vi.clearAllMocks(); if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabaseUrl; });

const manifest = { googlePlaceId: "actual-place-id", name: "Indoor Golf Venue", address: "10 Main St, Town CT",
  latitude: 41.2, longitude: -73.2, website: "https://venue.example", bookingUrl: "https://booking.example/bays",
  evidenceUrl: "https://venue.example/public-rentals", verifiedAt: "2026-09-01T12:00:00.000Z",
  publicAccessStatus: "PUBLIC", maxPartySize: 6, supportedDurationsMinutes: [120, 60, 120] };

describe("protected simulator offering review command", () => {
  it("defaults to an unsent, unapplied dry run and normalizes durations", async () => {
    const command = parseSimulatorOfferingCommand(["--manifest", "reviewed-rentals.json"]);
    expect(command.apply).toBe(false);
    const rows = parseSimulatorOfferingManifest(manifest);
    expect(rows[0].supportedDurationsMinutes).toEqual([60, 120]);
    expect(await executeSimulatorOfferingManifest(rows, command)).toMatchObject({ mode: "dry-run", offerings: [
      expect.objectContaining({ kind: "SIMULATOR", monitoringState: "UNKNOWN" })
    ] });
  });
  it("requires a named target before applying and rejects a different loaded target", async () => {
    expect(() => parseSimulatorOfferingCommand(["--manifest", "review.json", "--apply"])).toThrow("expected-database-host");
    await expect(executeSimulatorOfferingManifest(parseSimulatorOfferingManifest(manifest), { apply: true, expectedDatabaseHost: "does-not-match.example" }))
      .rejects.toThrow("does not match");
  });
  it.each([
    { website: "https://user:password@venue.example" },
    { publicAccessStatus: "VERIFIED_PUBLIC" },
    { maxPartySize: 0 },
    { supportedDurationsMinutes: [45] },
    { googlePlaceId: "places/alias" },
    { verifiedAt: "2999-01-01T12:00:00.000Z" },
    { automationEligibility: "ALLOWED" }
  ])("rejects unsafe or optimistic manifest fields %s", (override) => {
    expect(() => parseSimulatorOfferingManifest({ ...manifest, ...override })).toThrow();
  });
  it("rejects duplicate venue identities", () => {
    expect(() => parseSimulatorOfferingManifest([manifest, manifest])).toThrow("only once");
  });

  it("preserves existing venue intelligence and revokes stale observation authority when applying reviewed rental facts", async () => {
    process.env.DATABASE_URL = "postgresql://fixture-user:fixture-password@preview.example/simulator-test";
    mocks.findReview.mockResolvedValue(null);
    mocks.upsertCourse.mockResolvedValue({ id: "venue-1" });
    mocks.upsertOffering.mockResolvedValue({ id: "offering-1" });
    const result = await executeSimulatorOfferingManifest(parseSimulatorOfferingManifest(manifest), { apply: true, expectedDatabaseHost: "preview.example" });
    expect(result).toMatchObject({ mode: "applied", offerings: [{ courseId: "venue-1", offeringId: "offering-1" }] });
    expect(mocks.upsertCourse).toHaveBeenCalledWith(expect.objectContaining({ update: {}, create: expect.objectContaining({ isPublic: false }) }));
    const update = mocks.upsertOffering.mock.calls[0][0].update;
    expect(update).toMatchObject({ monitoringState: "UNKNOWN", automationEligibility: "UNKNOWN", monitoringVerifiedAt: null,
      observationToken: null, observationExpiresAt: null, monitoringRevision: { increment: 1 } });
    expect(update).not.toHaveProperty("isPublic");
  });

  it("rejects credential-bearing metadata before any database access", () => {
    expect(() => parseSimulatorOfferingManifest({ ...manifest, providerMetadata: { request: { Authorization: "fixture-token" } } })).toThrow("credentials");
    expect(mocks.upsertCourse).not.toHaveBeenCalled();
  });
});
