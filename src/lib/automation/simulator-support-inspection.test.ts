// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSimulatorSupportArguments, assertSimulatorSupportInspectionFence } from "../../../scripts/automation/simulator-support";
import { readSimulatorSupportClaim } from "./simulator-support-ownership";

const mocks = vi.hoisted(() => ({ live: vi.fn(), offering: vi.fn(), prior: vi.fn(), history: vi.fn(), engineering: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  courseOffering: { findUniqueOrThrow: mocks.offering },
  automationRun: { findFirst: mocks.prior, findMany: mocks.history },
} }));
vi.mock("./course-support-course-dispatch", () => ({ listLiveCourseSupportDispatchReservations: mocks.live }));
vi.mock("@/lib/course-discovery/engineering-repair", () => ({ discoveryEngineeringContext: mocks.engineering }));

const assignmentRef = "course-assignment-original", ownerThreadId = "original-worker";
function fixture() {
  const claim = { token: "private-claim", revision: 3, phase: "CLAIMED", claimedAt: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), sourceFingerprint: "a".repeat(64),
    originalSourceFingerprint: "a".repeat(64), offeringRevision: 1, plannedPaths: [], releaseSha: null,
    branch: "automation/original-worker", deployment: null, recheckQueuedAt: null, verificationCycle: 1 };
  const row = { runId: "owned-run", audit: { assignmentRef, childThreadId: ownerThreadId, state: "CONSUMED",
    baseSha: "b".repeat(40), simulatorClaim: claim,
    target: { mode: "SIMULATOR", courseId: "course", offeringId: "offering", incidentId: "incident" } } };
  return { claim, row };
}

describe("simulator inspection to next-command ownership handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prior.mockResolvedValue(null); mocks.history.mockResolvedValue([]); mocks.engineering.mockResolvedValue(null);
    mocks.offering.mockResolvedValue({ id: "offering", courseId: "course", kind: "SIMULATOR", active: true,
      publicAccessStatus: "UNVERIFIED", providerFamilyKey: null, providerMetadata: null, supportedDurationsMinutes: [],
      bookingUrl: null, evidenceUrl: null, course: { name: "Public simulator", address: "1 Main St", website: "https://official.example",
        timeZone: "America/New_York", googlePlaceId: "place", latitude: 41, longitude: -73 } });
  });

  it("retains the original reference and current claim through JSON inspection without a provider read or mutation", async () => {
    const f = fixture(); mocks.live.mockResolvedValue([f.row]);
    const before = JSON.stringify(f.row);
    const inspected = JSON.parse(JSON.stringify(await readSimulatorSupportClaim({ assignmentRef, ownerThreadId })));
    expect(inspected).toMatchObject({ assignmentRef, token: f.claim.token, revision: 3, offeringId: "offering" });
    const next = readSimulatorSupportArguments(["source-read", "--assignment-ref", inspected.assignmentRef,
      "--token", inspected.token, "--revision", String(inspected.revision), "--source", "official"]);
    expect(next).toMatchObject({ assignmentRef, token: f.claim.token, revision: 3, source: "official" });
    expect(() => assertSimulatorSupportInspectionFence(next, inspected)).not.toThrow();
    expect(() => assertSimulatorSupportInspectionFence({ ...next, revision: 2 }, inspected)).toThrow("current owner token and revision");
    expect(JSON.stringify(f.row)).toBe(before);
    expect(mocks.offering).toHaveBeenCalledTimes(1);
  });

  it.each([["another-assignment", ownerThreadId], [assignmentRef, "another-worker"]])("does not return a claim for a different assignment or worker (%s, %s)", async (ref, worker) => {
    mocks.live.mockResolvedValue([fixture().row]);
    await expect(readSimulatorSupportClaim({ assignmentRef: ref, ownerThreadId: worker })).rejects.toThrow();
    expect(mocks.offering).not.toHaveBeenCalled();
    expect(mocks.engineering).not.toHaveBeenCalled();
  });
});
