import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { listSimulatorSupportDispatchCandidates, validateSimulatorEngineeringAuthority } from "./simulator-support-incidents";
import { parseCourseDispatchAudit, type CourseDispatchAudit } from "./course-support-course-dispatch";
import type { SimulatorEngineeringAuthority } from "./simulator-support-policy";

const now = new Date("2026-10-08T14:00:00Z");
function fixture() {
  const offering = { id: "offering", courseId: "course", kind: "SIMULATOR", active: true, publicAccessStatus: "UNVERIFIED", bookingUrl: "https://official.example.test/book",
    evidenceUrl: null, verifiedAt: null, providerFamilyKey: null, providerMetadata: null, maxPartySize: null, supportedDurationsMinutes: [],
    bookingWindowDaysAhead: null, bookingReleaseTimeLocal: null, monitoringMode: "AUTOMATIC", course: { timeZone: "UTC" } };
  const fingerprint = getSimulatorOfferingSourceFingerprint(offering);
  const audit: CourseDispatchAudit = { schemaVersion: 1, tickRef: "prior", assignmentRef: "original", state: "CONSUMED", ownerThreadId: "parent", childThreadId: "native-child",
    baseSha: "a".repeat(40), reservedAt: "2026-10-08T11:00:00Z", launchStartedAt: "2026-10-08T11:00:01Z", boundAt: "2026-10-08T11:00:02Z", consumedAt: "2026-10-08T11:00:03Z", expiresAt: "2026-10-08T11:10:00Z",
    target: { mode: "SIMULATOR", offeringId: "offering", offeringSourceFingerprint: fingerprint, incidentId: "incident", courseId: "course", cycle: 1,
      providerFamilyKey: "SIMULATOR_SOURCE_PENDING", failureFingerprint: fingerprint, updatedAt: "2026-10-08T11:00:00Z", trafficClass: "SYNTHETIC",
      searchRefs: [{ id: "ended-test", scheduleVersion: 0, alertGeneration: 0, intentDigest: "d".repeat(64) }] },
    simulatorClaim: { token: "private", revision: 5, phase: "CLAIMED", claimedAt: "2026-10-08T11:00:03Z", leaseExpiresAt: "2026-10-08T11:20:00Z",
      sourceFingerprint: fingerprint, originalSourceFingerprint: fingerprint, offeringRevision: 0, plannedPaths: [], releaseSha: null, branch: "worker", deployment: null, recheckQueuedAt: null, verificationCycle: 0 } };
  const row = { id: "origin", kind: "OTHER", status: "COMPLETED", outcome: "simulator_retryable_failed", completedAt: new Date("2026-10-08T11:05:00Z"), audit };
  const rows = [row];
  const tx = { simulatorSupportIncident: { findMany: vi.fn(async () => [{ id: "incident", offeringId: "offering", offering, updatedAt: now }]) },
    coursePreference: { findMany: vi.fn(async () => []) }, automationRun: { findMany: vi.fn(async (args: { where: { id?: { in: string[] } } }) =>
      args.where.id ? rows.filter(candidate => args.where.id!.in.includes(candidate.id)) : rows) } };
  const authority: SimulatorEngineeringAuthority = { schemaVersion: 1, originRunId: "origin", originAssignmentRef: "original", originSourceFingerprint: fingerprint,
    lineageRunId: "origin", lineageAssignmentRef: "original", sourceFingerprint: fingerprint };
  return { offering, audit, row, rows, tx, authority, client: tx as unknown as Prisma.TransactionClient };
}

describe("durable simulator engineering authority", () => {
  it("admits the unresolved incident from a positively consumed historical synthetic claim, without any active alert", async () => {
    const f = fixture();
    const candidates = await listSimulatorSupportDispatchCandidates(now, f.client);
    expect(candidates).toMatchObject([{ sources: [], engineeringAuthority: f.authority, engineeringSearchRefs: f.audit.target.searchRefs }]);
    expect(f.tx.coursePreference.findMany.mock.calls[0][0]).toMatchObject({ where: { teeSearch: { status: "ACTIVE" } } });
  });

  it.each(["missing authority", "unconsumed", "real demand", "malformed child", "missing binding", "unknown outcome", "wrong fingerprint"])("rejects %s as durable engineering authority", async scenario => {
    const f = fixture();
    if (scenario === "missing authority") f.rows.length = 0;
    if (scenario === "unconsumed") f.audit.state = "BOUND";
    if (scenario === "real demand") f.audit.target.trafficClass = "REAL";
    if (scenario === "malformed child") (f.audit as unknown as { childThreadId: unknown }).childThreadId = 123;
    if (scenario === "missing binding") delete f.audit.boundAt;
    if (scenario === "unknown outcome") f.row.outcome = "arbitrary_completed";
    if (scenario === "wrong fingerprint") f.audit.simulatorClaim!.sourceFingerprint = "e".repeat(64);
    expect(await listSimulatorSupportDispatchCandidates(now, f.client)).toEqual([]);
  });

  it("requires original root provenance even when the latest row claims engineering authority", async () => {
    const f = fixture();
    f.audit.target.engineeringAuthority = f.authority;
    await expect(validateSimulatorEngineeringAuthority(f.client, f.authority, f.audit.target, now)).rejects.toThrow("original consumed");
  });

  it("keeps current lineage through adopted source changes and rejects another incident or forged root", async () => {
    const f = fixture(), nextFingerprint = "b".repeat(64);
    const lineageAudit = structuredClone(f.audit);
    lineageAudit.assignmentRef = "replacement";
    lineageAudit.target.engineeringAuthority = f.authority;
    lineageAudit.simulatorClaim!.sourceFingerprint = nextFingerprint;
    const lineage = { ...f.row, id: "lineage", audit: lineageAudit };
    f.rows.push(lineage);
    const authority = { ...f.authority, lineageRunId: "lineage", lineageAssignmentRef: "replacement", sourceFingerprint: nextFingerprint };
    await expect(validateSimulatorEngineeringAuthority(f.client, authority, { ...f.audit.target, offeringSourceFingerprint: nextFingerprint }, now)).resolves.toBeDefined();
    await expect(validateSimulatorEngineeringAuthority(f.client, authority, { ...f.audit.target, incidentId: "another", offeringSourceFingerprint: nextFingerprint }, now)).rejects.toThrow("original consumed");
    await expect(validateSimulatorEngineeringAuthority(f.client, { ...authority, originRunId: "missing" }, { ...f.audit.target, offeringSourceFingerprint: nextFingerprint }, now)).rejects.toThrow("original consumed");
  });

  it("can prove newest current lineage within 64 rows but fails closed when evidence would require another read", async () => {
    const valid = fixture();
    valid.rows.push(...Array.from({ length: 63 }, (_, index) => ({ ...valid.row, id: `old-${index}`, outcome: "unknown" })));
    expect(await listSimulatorSupportDispatchCandidates(now, valid.client)).toHaveLength(1);
    valid.row.outcome = "unknown";
    await expect(listSimulatorSupportDispatchCandidates(now, valid.client)).rejects.toThrow("bounded read limit");
  });

  it("does not accept malformed engineering metadata or empty provenance references in the dispatch parser", () => {
    const f = fixture();
    f.audit.target.engineeringAuthority = { ...f.authority, extra: "unknown" } as SimulatorEngineeringAuthority;
    expect(parseCourseDispatchAudit(f.audit)).toBeNull();
    f.audit.target.engineeringAuthority = f.authority;
    f.audit.target.searchRefs = [];
    expect(parseCourseDispatchAudit(f.audit)).toBeNull();
  });
});
