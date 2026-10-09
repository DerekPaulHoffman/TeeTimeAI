// @vitest-environment node
import { readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { SimulatorAvailabilityResult } from "@/lib/simulators/providers";
import { SimulatorAvailabilityError } from "@/lib/simulators/providers/types";
vi.mock("./simulator-support-ownership", () => ({ withSimulatorEngineeringVerificationTransition: vi.fn() }));
import { normalizeSimulatorEngineeringResult, runSimulatorEngineeringVerification } from "./simulator-support-engineering-verification";
import { readSimulatorEngineeringVerificationState, type SimulatorEngineeringVerificationState } from "./simulator-support-engineering-verification-policy";

const sha = "a".repeat(40), source = "b".repeat(64), start = new Date("2026-10-08T15:00:00Z");
const proof = { aliases: ["teetimespot.com", "www.teetimespot.com"], branch: "main", commitSha: sha,
  deployedAt: "2026-10-08T14:00:00Z", deploymentId: "dpl_test", deploymentUrl: "https://test.vercel.app", source: "git" as const, state: "READY" as const };
const runtime = { runtimeVersion: sha, deploymentId: "dpl_test", deploymentUrl: proof.deploymentUrl, environment: "production", host: "teetimespot.com" };

function fixture() {
  let clock = new Date(start);
  const audit: Record<string, unknown> = {};
  const claim = { token: "owned", revision: 3, sourceFingerprint: source, releaseSha: sha, deployment: proof, claimedAt: "2026-10-08T14:10:00Z" };
  const offering = { id: "offering", providerFamilyKey: "YOUR_GOLF_BOOKING", publicAccessStatus: "PUBLIC", active: true, bookingUrl: "https://public.example/booking", verifiedAt: start,
    evidenceUrl: "https://public.example", supportedDurationsMinutes: [60], automationEligibility: "UNKNOWN", observationToken: null as string | null,
    observationExpiresAt: null as Date | null, bookingWindowDaysAhead: 14, bookingReleaseTimeLocal: "08:00", monitoringState: "VERIFYING" };
  const tx = { courseOffering: { updateMany: vi.fn(async ({ where, data }) => {
    if (where.observationToken && where.observationToken !== offering.observationToken) return { count: 0 };
    if (where.OR && offering.observationToken && offering.observationExpiresAt && offering.observationExpiresAt > clock) return { count: 0 };
    Object.assign(offering, data); return { count: 1 };
  }) } };
  const save = vi.fn(async changes => {
    Object.assign(audit, changes); claim.revision += 1;
    return { revision: claim.revision, token: claim.token, leaseExpiresAt: new Date(clock.getTime() + 15 * 60_000).toISOString() };
  });
  const transition = vi.fn(async (input, operation) => {
    if (input.token !== claim.token || input.revision !== claim.revision || input.runtimeVersion !== claim.releaseSha) throw new Error("STALE_OWNER");
    return { acquired: true as const, value: await operation({ now: clock, audit, claim: { ...claim }, offering: { ...offering }, timeZone: "America/New_York", tx, save }) };
  });
  const result: SimulatorAvailabilityResult = { complete: true, observedAt: start, slots: [], evidenceUrl: "https://public.example/calendar" };
  const read = vi.fn(async () => {
    clock = new Date(clock.getTime() + 1000); vi.setSystemTime(clock);
    return { ...result, observedAt: clock };
  });
  const providerLease = vi.fn(async (_host, operation) => ({ acquired: true as const, value: await operation() }));
  const deps = { transition, read, providerLease, requestId: vi.fn(() => `request_${claim.revision}`) };
  return { audit, claim, offering, tx, save, deps, result, setClock(value: Date) { clock = value; vi.setSystemTime(clock); } };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { vi.useRealTimers(); });

describe("deployed independent simulator verification", () => {
  it("reserves before network, uses shared provider capacity and settles only raw-free counts/clocks", async () => {
    const f = fixture();
    const first = await runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps);
    expect(first).toMatchObject({ revision: 5, outcome: "NO_MATCH", complete: true, freshSuccessfulChecks: 1, engineeringOnly: true, customerAcceptance: false });
    expect(first).not.toHaveProperty("readerGuard");
    expect(f.deps.providerLease).toHaveBeenCalledWith("public.example", expect.any(Function));
    expect(f.deps.read).toHaveBeenCalledWith(expect.objectContaining({ date: "2026-10-09", durationMinutes: 60, partySize: 1, timeZone: "America/New_York" }), expect.any(Function));
    expect(f.deps.transition).toHaveBeenCalledTimes(3);
    const second = await runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 5 }, runtime, f.deps);
    expect(second).toMatchObject({ revision: 7, freshSuccessfulChecks: 2, complete: true });
    expect(f.audit.simulatorEngineeringVerification).toMatchObject({ readsUsed: 2, inFlight: null, observations: [
      { requestId: "request_3", slotCount: 0 }, { requestId: "request_5", slotCount: 0 },
    ] });
    expect(JSON.stringify(f.audit)).not.toContain("public.example");
    expect(f.offering).toMatchObject({ observationToken: null, monitoringState: "HEALTHY", automationEligibility: "ALLOWED" });
    await expect(runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 7 }, runtime, f.deps)).rejects.toThrow("REPAIR_REQUIRED");
    expect(f.deps.read).toHaveBeenCalledTimes(2);
  });
  it("duplicate HTTP requests cannot reserve or settle the same owner revision twice", async () => {
    const f = fixture();
    await runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps);
    await expect(runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps)).rejects.toThrow("STALE_OWNER");
    expect(f.deps.read).toHaveBeenCalledTimes(1);
  });
  it("cannot erase falsy malformed evidence to refund a verification budget", async () => {
    for (const malformed of [false, 0, ""]) {
      const f = fixture(); f.audit.simulatorEngineeringVerification = malformed;
      await expect(runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps)).rejects.toThrow("EVIDENCE_INVALID");
      expect(f.deps.read).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
    }
  });
  it("honors the actual writer-lease envelope without treating unacquired transitions as reservation success", async () => {
    const f = fixture(); f.deps.transition.mockResolvedValueOnce({ acquired: false } as unknown as Awaited<ReturnType<typeof f.deps.transition>>);
    await expect(runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps)).rejects.toThrow("WRITER_BUSY");
    expect(f.deps.read).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  });
  it("records unsupported and schema/access failures honestly without terminal restriction or customer delivery", async () => {
    for (const code of ["UNSUPPORTED_PROVIDER", "SCHEMA_CHANGED", "PUBLIC_SESSION_REQUIRED"] as const) {
      const f = fixture(); f.deps.read.mockRejectedValue(new SimulatorAvailabilityError(code, "provider body must stay private"));
      const result = await runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps);
      expect(result).toMatchObject({ outcome: code === "UNSUPPORTED_PROVIDER" ? "NEEDS_ADAPTER" : "FETCH_FAILED", complete: false,
        failureCode: code, freshSuccessfulChecks: 0, customerAcceptance: false });
      expect(JSON.stringify(f.audit)).not.toContain("provider body");
      await expect(runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 5 }, runtime, f.deps)).rejects.toThrow("REPAIR_REQUIRED");
      expect(f.deps.read).toHaveBeenCalledTimes(1);
    }
  });
  it.each([
    ["SCHEMA_CHANGED", "The public simulator opening hours format changed"],
    ["SCHEMA_CHANGED", "The public simulator occupancy changed shape or identity"],
    ["SCHEMA_CHANGED", "The selected simulator bay changed range identity"],
    ["INVALID_SOURCE", "The published simulator rental changed"],
  ] as const)("returns only a closed private %s reader guard without persisting %s", async (code, guard) => {
    const f = fixture(); f.deps.read.mockRejectedValue(new SimulatorAvailabilityError(code, guard));
    const result = await runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps);
    expect(result).toMatchObject({ complete: false, failureCode: code, readerGuard: guard,
      engineeringOnly: true, customerAcceptance: false });
    const persisted = f.audit.simulatorEngineeringVerification as SimulatorEngineeringVerificationState;
    expect(readSimulatorEngineeringVerificationState(persisted)).toBeDefined();
    expect(Object.keys(persisted.observations[0]).sort()).toEqual([
      "requestId", "revision", "requestedDate", "startedAt", "expiresAt", "completedAt",
      "outcome", "complete", "providerObservedAt", "slotCount", "failureCode",
    ].sort());
    expect(JSON.stringify(f.audit)).not.toContain(guard);
    expect(JSON.stringify(f.audit)).not.toContain("readerGuard");
  });
  it("does not echo dynamic, other-provider, transient or mismatched reader messages", async () => {
    for (const [family, code, message] of [
      ["YOUR_GOLF_BOOKING", "SCHEMA_CHANGED", "The public simulator occupancy changed shape or identity: private token"],
      ["GOLFBOOK", "SCHEMA_CHANGED", "The public simulator occupancy changed shape or identity"],
      ["YOUR_GOLF_BOOKING", "HTTP_ERROR", "The public simulator occupancy changed shape or identity"],
      ["YOUR_GOLF_BOOKING", "PUBLIC_SESSION_REQUIRED", "The public simulator occupancy changed shape or identity"],
      ["YOUR_GOLF_BOOKING", "UNSUPPORTED_DURATION", "The public simulator occupancy changed shape or identity"],
      ["YOUR_GOLF_BOOKING", "INVALID_SOURCE", "The public simulator occupancy changed shape or identity"],
      ["YOUR_GOLF_BOOKING", "INVALID_SOURCE", "The selected simulator bay changed range identity"],
      ["YOUR_GOLF_BOOKING", "SCHEMA_CHANGED", "The published simulator rental changed"],
    ] as const) {
      const f = fixture(); f.offering.providerFamilyKey = family;
      f.deps.read.mockRejectedValue(new SimulatorAvailabilityError(code, message));
      const result = await runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps);
      expect(result).not.toHaveProperty("readerGuard");
      expect(JSON.stringify(f.audit)).not.toContain(message);
    }
    for (const error of [new Error("SIMULATOR_ENGINEERING_READ_DEADLINE"),
      new Error("The public simulator occupancy changed shape or identity")]) {
      const f = fixture(); f.deps.read.mockRejectedValue(error);
      const result = await runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps);
      expect(result).not.toHaveProperty("readerGuard");
      expect(result.failureCode).toBe(error.message === "SIMULATOR_ENGINEERING_READ_DEADLINE" ? "READ_DEADLINE" : "READ_FAILED");
    }
  });
  it("drops a closed reader guard when a real customer takes priority before settlement", async () => {
    const f = fixture(); const actual = f.deps.transition.getMockImplementation()!;
    let customerDemandPresent = false;
    f.deps.transition.mockImplementation(async (authority, operation) =>
      actual(authority, context => operation({ ...context, customerDemandPresent })));
    f.deps.read.mockImplementation(async () => {
      customerDemandPresent = true;
      throw new SimulatorAvailabilityError("SCHEMA_CHANGED", "The public simulator occupancy changed shape or identity");
    });
    const result = await runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps);
    expect(result).toMatchObject({ failureCode: "NORMAL_CUSTOMER_CHECK_REQUIRED", nextAction: "RETRY_ENGINEERING", complete: false });
    expect(result).not.toHaveProperty("readerGuard");
    expect(JSON.stringify(f.audit)).not.toContain("readerGuard");
  });
  it("preserves failed proof and requires fresh observations after an actually registered repaired release", async () => {
    const f = fixture(); f.deps.read.mockRejectedValueOnce(new SimulatorAvailabilityError("SCHEMA_CHANGED", "private"));
    await runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps);
    const repairedSha = "c".repeat(40);
    f.claim.releaseSha = repairedSha; f.claim.deployment = { ...proof, commitSha: repairedSha, deploymentId: "dpl_repaired", deploymentUrl: "https://repaired.vercel.app" };
    const result = await runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 5 }, {
      ...runtime, runtimeVersion: repairedSha, deploymentId: "dpl_repaired", deploymentUrl: "https://repaired.vercel.app" }, f.deps);
    expect(result).toMatchObject({ freshSuccessfulChecks: 1, complete: true });
    expect(f.audit.simulatorEngineeringVerificationHistory).toMatchObject([{ runtimeVersion: sha, readsUsed: 1,
      observations: [{ failureCode: "SCHEMA_CHANGED", complete: false }] }]);
    expect(f.audit.simulatorEngineeringVerification).toMatchObject({ runtimeVersion: repairedSha, readsUsed: 1, observations: [{ complete: true }] });
  });
  it("cannot enter provider I/O when fresh real demand restores normal customer authority", async () => {
    const f = fixture(); const actual = f.deps.transition.getMockImplementation()!;
    let customerDemandPresent = false;
    f.deps.transition.mockImplementation(async (authority, operation) => {
      if (customerDemandPresent && !authority.allowCustomerDemandSettlement) throw new Error("SIMULATOR_ENGINEERING_CUSTOMER_CHECK_REQUIRED");
      return actual(authority, context => operation({ ...context, customerDemandPresent }));
    });
    f.deps.providerLease.mockImplementation(async (_host, operation) => { customerDemandPresent = true; return { acquired: true, value: await operation() }; });
    const result = await runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps);
    expect(result).toMatchObject({ outcome: "FETCH_FAILED", complete: false, failureCode: "NORMAL_CUSTOMER_CHECK_REQUIRED", nextAction: "RETRY_ENGINEERING" });
    expect(f.deps.read).not.toHaveBeenCalled();
    expect(f.audit.simulatorEngineeringVerification).toMatchObject({ readsUsed: 1, inFlight: null,
      observations: [{ complete: false, failureCode: "NORMAL_CUSTOMER_CHECK_REQUIRED" }] });
    expect(f.offering).toMatchObject({ observationToken: null, monitoringState: "VERIFYING", automationEligibility: "UNKNOWN" });
  });
  it("settles an in-flight read without granting engineering or customer success when real demand arrives during network work", async () => {
    const f = fixture(); const actual = f.deps.transition.getMockImplementation()!; const read = f.deps.read.getMockImplementation()!;
    let customerDemandPresent = false;
    f.deps.transition.mockImplementation(async (authority, operation) => {
      if (customerDemandPresent && !authority.allowCustomerDemandSettlement) throw new Error("SIMULATOR_ENGINEERING_CUSTOMER_CHECK_REQUIRED");
      return actual(authority, context => operation({ ...context, customerDemandPresent }));
    });
    f.deps.read.mockImplementation(async () => { customerDemandPresent = true; return read(); });
    const result = await runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps);
    expect(result).toMatchObject({ complete: false, customerAcceptance: false, freshSuccessfulChecks: 0, failureCode: "NORMAL_CUSTOMER_CHECK_REQUIRED" });
    expect(f.deps.read).toHaveBeenCalledTimes(1);
    expect(f.audit.simulatorEngineeringVerification).toMatchObject({ inFlight: null, observations: [{ complete: false }] });
    expect(f.offering.observationToken).toBeNull();
  });
  it("reconciles an expired interrupted reservation with original ownership and no replacement read or budget refund", async () => {
    const f = fixture();
    f.audit.simulatorEngineeringVerification = { schemaVersion: 1, sourceFingerprint: source, runtimeVersion: sha, deploymentId: "dpl_test",
      startedAt: "2026-10-08T14:50:00Z", readsUsed: 1, observations: [], inFlight: { requestId: "interrupted", revision: 2,
        requestedDate: "2026-10-09", startedAt: "2026-10-08T14:50:00Z", expiresAt: "2026-10-08T14:52:00Z" } };
    f.offering.observationToken = "interrupted"; f.offering.observationExpiresAt = new Date("2026-10-08T14:52:00Z");
    const result = await runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps);
    expect(result).toMatchObject({ revision: 4, expiredReservation: true, nextAction: "REPAIR", failureCode: "RESERVATION_EXPIRED", freshSuccessfulChecks: 0 });
    expect(result).not.toHaveProperty("readerGuard");
    expect(f.deps.read).not.toHaveBeenCalled(); expect(f.deps.providerLease).not.toHaveBeenCalled();
    expect(f.audit.simulatorEngineeringVerification).toMatchObject({ readsUsed: 1, inFlight: null,
      observations: [{ requestId: "interrupted", failureCode: "RESERVATION_EXPIRED", complete: false }] });
  });
  it("rejects late completion and owner/source changes after network rather than persisting stale success", async () => {
    for (const changed of ["late", "owner", "source"]) {
      const f = fixture(); f.deps.read.mockImplementation(async () => {
        if (changed === "late") f.setClock(new Date(start.getTime() + 120_000));
        if (changed === "owner") f.claim.revision += 1;
        if (changed === "source") f.deps.transition.mockRejectedValueOnce(new Error("SOURCE_CHANGED"));
        return { ...f.result, observedAt: new Date(start.getTime() + 1000) };
      });
      await expect(runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps)).rejects.toThrow();
      expect((f.audit.simulatorEngineeringVerification as SimulatorEngineeringVerificationState).observations).toHaveLength(0);
    }
  });
  it("does not accept a complete provider response after the network deadline but within settlement grace", async () => {
    const f = fixture(); f.deps.read.mockImplementation(async () => {
      f.setClock(new Date(start.getTime() + 91_000)); return { ...f.result, observedAt: new Date(start.getTime() + 91_000) };
    });
    const result = await runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps);
    expect(result).toMatchObject({ outcome: "FETCH_FAILED", complete: false, failureCode: "READ_DEADLINE", freshSuccessfulChecks: 0 });
    expect(f.audit.simulatorEngineeringVerification).toMatchObject({ readsUsed: 1, inFlight: null });
  });
  it("rejects wrong runtime, active normal offering leases and malformed incomplete results", async () => {
    const f = fixture();
    await expect(runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, { ...runtime, deploymentId: "dpl_old" }, f.deps)).rejects.toThrow("RUNTIME_NOT_CURRENT");
    f.offering.observationToken = "normal-check"; f.offering.observationExpiresAt = new Date(start.getTime() + 30_000);
    await expect(runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps)).rejects.toThrow("PROVIDER_BUSY");
    expect(f.deps.read).not.toHaveBeenCalled();
    expect(() => normalizeSimulatorEngineeringResult({ ...f.result, complete: false } as unknown as SimulatorAvailabilityResult, start, start)).toThrow("INCOMPLETE_READ");
    expect(() => normalizeSimulatorEngineeringResult({ ...f.result, observedAt: new Date(start.getTime() - 1) }, start, start)).toThrow("INCOMPLETE_READ");
  });
  it("defers a known zero-day window before release without spending a read or changing the original revision", async () => {
    const f = fixture(); f.offering.bookingWindowDaysAhead = 0; f.offering.bookingReleaseTimeLocal = "12:00";
    const result = await runSimulatorEngineeringVerification({ assignmentRef: "assignment", token: "owned", revision: 3 }, runtime, f.deps);
    expect(result).toMatchObject({ deferred: true, revision: 3, nextAction: "RETRY_ENGINEERING", outcome: "BOOKING_NOT_OPEN",
      failureCode: "BOOKING_NOT_OPEN", complete: false, freshSuccessfulChecks: 0, customerAcceptance: false });
    expect(f.deps.read).not.toHaveBeenCalled(); expect(f.deps.providerLease).not.toHaveBeenCalled();
    expect(f.tx.courseOffering.updateMany).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
    expect(f.audit).toEqual({}); expect(f.claim.revision).toBe(3);
  });
  it("validates complete same-day calendars but counts future full sessions only", () => {
    const f = fixture();
    const slots = [13, 16].map(hour => ({ sourceId: `slot_${hour}`, offeringId: "offering", resourceId: "bay_1", productId: "public",
      startsAt: new Date(`2026-10-08T${hour}:00:00Z`), endsAt: new Date(`2026-10-08T${hour + 1}:00:00Z`),
      maxPartySize: null, bookingUrl: "https://public.example/booking" }));
    const intent = { offeringId: "offering", requestedDate: "2026-10-08", timeZone: "America/New_York" };
    expect(normalizeSimulatorEngineeringResult({ ...f.result, slots }, start, start, intent)).toMatchObject({ complete: true, outcome: "MATCH_FOUND", slotCount: 1 });
    expect(normalizeSimulatorEngineeringResult({ ...f.result, slots: [slots[0]] }, start, start, intent)).toMatchObject({ complete: true, outcome: "NO_MATCH", slotCount: 0 });
    expect(() => normalizeSimulatorEngineeringResult({ ...f.result, slots: [{ ...slots[1], endsAt: new Date("2026-10-08T16:30:00Z") }] }, start, start, intent)).toThrow("INCOMPLETE_READ");
  });
  it("has no customer search, probe, match, outbox or email imports/writes in the detached path", () => {
    const source = readFileSync(new URL("./simulator-support-engineering-verification.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/(?:from\s+["'].*(?:email|search-check|db-service)|\.(?:teeSearch|courseProbe|teeTimeMatch|searchEmailDelivery)\.)/u);
  });
});
