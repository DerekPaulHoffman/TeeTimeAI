import { randomUUID } from "node:crypto";
import { fetchSimulatorAvailability, SimulatorAvailabilityError, type SimulatorAvailabilityResult } from "@/lib/simulators/providers";
import { runWithProviderRequestLease } from "./provider-request-lease";
import { withSimulatorEngineeringVerificationTransition, type SimulatorEngineeringVerificationContext } from "./simulator-support-ownership";
import {
  assertSimulatorEngineeringRuntime, deriveSimulatorEngineeringVerificationDate, evaluateSimulatorEngineeringVerification,
  readSimulatorEngineeringVerificationState, SIMULATOR_ENGINEERING_VERIFICATION_DEADLINE_MS,
  SIMULATOR_ENGINEERING_VERIFICATION_LEASE_MS, SIMULATOR_ENGINEERING_VERIFICATION_MAX_READS,
  type SimulatorEngineeringVerificationObservation, type SimulatorEngineeringVerificationState,
} from "./simulator-support-engineering-verification-policy";

export type SimulatorEngineeringVerificationInput = { assignmentRef: string; token: string; revision: number };
export type SimulatorEngineeringRuntime = { runtimeVersion: string; deploymentId: string; deploymentUrl: string; environment: string; host: string };

/** Persist only classifications, counts and clocks. Provider data and slots never enter an alert. */
export function normalizeSimulatorEngineeringResult(result: SimulatorAvailabilityResult, startedAt: Date, now: Date,
  intent?: { offeringId: string; requestedDate: string; timeZone: string }) {
  let safeEvidence = false;
  try { const url = new URL(result.evidenceUrl); safeEvidence = ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; }
  catch { /* Malformed evidence cannot prove a public read. */ }
  if (result.complete !== true || !(result.observedAt instanceof Date) || !Number.isFinite(result.observedAt.getTime()) ||
      result.observedAt < startedAt || result.observedAt > now || !Array.isArray(result.slots) || result.slots.length > 65_536 ||
      !safeEvidence) throw new Error("SIMULATOR_ENGINEERING_INCOMPLETE_READ");
  const ids = new Set<string>();
  for (const slot of result.slots) {
    if (!(slot.startsAt instanceof Date) || !(slot.endsAt instanceof Date) || !Number.isFinite(slot.startsAt.getTime()) ||
        slot.endsAt.getTime() - slot.startsAt.getTime() !== 60 * 60_000 ||
        !slot.sourceId || !slot.resourceId || !slot.productId || ids.has(slot.sourceId) ||
        intent && (slot.offeringId !== intent.offeringId || new Intl.DateTimeFormat("en-CA", { timeZone: intent.timeZone,
          year: "numeric", month: "2-digit", day: "2-digit" }).format(slot.startsAt) !== intent.requestedDate)) {
      throw new Error("SIMULATOR_ENGINEERING_INCOMPLETE_READ");
    }
    ids.add(slot.sourceId);
  }
  const slotCount = result.slots.filter(slot => slot.startsAt > now).length;
  return { outcome: slotCount ? "MATCH_FOUND" as const : "NO_MATCH" as const, complete: true,
    providerObservedAt: result.observedAt.toISOString(), slotCount, failureCode: null };
}

function normalizeFailure(error: unknown) {
  const code = error instanceof SimulatorAvailabilityError ? error.code :
    error instanceof Error && error.message === "SIMULATOR_ENGINEERING_PROVIDER_BUSY" ? "PROVIDER_BUSY" :
    error instanceof Error && error.message === "SIMULATOR_ENGINEERING_READ_DEADLINE" ? "READ_DEADLINE" :
    error instanceof Error && error.message === "SIMULATOR_ENGINEERING_INCOMPLETE_READ" ? "INCOMPLETE_READ" : "READ_FAILED";
  return { outcome: code === "UNSUPPORTED_PROVIDER" ? "NEEDS_ADAPTER" as const : "FETCH_FAILED" as const,
    complete: false, providerObservedAt: null, slotCount: 0, failureCode: code };
}

const dependencies = { transition: withSimulatorEngineeringVerificationTransition, providerLease: runWithProviderRequestLease,
  read: fetchSimulatorAvailability, requestId: randomUUID };

/** The deployed runtime reads through the same signed-out adapter and global provider coordination as normal checks. */
export async function runSimulatorEngineeringVerification(input: SimulatorEngineeringVerificationInput, runtime: SimulatorEngineeringRuntime,
  deps = dependencies) {
  const transition = async <T>(authority: SimulatorEngineeringVerificationInput & { runtimeVersion: string; allowCustomerDemandSettlement?: true },
    operation: (context: SimulatorEngineeringVerificationContext) => Promise<T>) => {
    const result = await deps.transition(authority, operation);
    if (!result.acquired) throw new Error("SIMULATOR_ENGINEERING_WRITER_BUSY");
    return result.value;
  };
  const reserved = await transition({ ...input, runtimeVersion: runtime.runtimeVersion, allowCustomerDemandSettlement: true }, async context => {
    const { now, claim, offering, timeZone, tx } = context;
    const audit = context.audit as typeof context.audit & { simulatorEngineeringVerification?: unknown; simulatorEngineeringVerificationHistory?: unknown };
    assertSimulatorEngineeringRuntime(runtime, claim.deployment!, now);
    if (offering.publicAccessStatus !== "PUBLIC" || !offering.active || !offering.bookingUrl || !offering.verifiedAt ||
        !offering.evidenceUrl || !offering.supportedDurationsMinutes.includes(60) || offering.automationEligibility === "BLOCKED") {
      throw new Error("SIMULATOR_ENGINEERING_PUBLIC_RENTAL_NOT_READY");
    }
    const previous = readSimulatorEngineeringVerificationState(audit.simulatorEngineeringVerification);
    if (audit.simulatorEngineeringVerification !== undefined && audit.simulatorEngineeringVerification !== null && !previous) {
      throw new Error("SIMULATOR_ENGINEERING_EVIDENCE_INVALID");
    }
    const customerDemandPresent = Boolean((context as { customerDemandPresent?: boolean }).customerDemandPresent);
    if (customerDemandPresent && (!previous?.inFlight || Date.parse(previous.inFlight.expiresAt) > now.getTime())) {
      throw new Error("SIMULATOR_ENGINEERING_CUSTOMER_CHECK_REQUIRED");
    }
    if (previous?.inFlight) {
      const pending = previous.inFlight;
      if (Date.parse(pending.expiresAt) > now.getTime()) throw new Error("SIMULATOR_ENGINEERING_VERIFICATION_READ_IN_FLIGHT");
      const observation: SimulatorEngineeringVerificationObservation = { ...pending, completedAt: now.toISOString(),
        outcome: "FETCH_FAILED", complete: false, providerObservedAt: null, slotCount: 0, failureCode: "RESERVATION_EXPIRED" };
      const saved = await context.save({ simulatorEngineeringVerification: { ...previous, inFlight: null,
        observations: [...previous.observations, observation] } });
      await tx.courseOffering.updateMany({ where: { id: offering.id, observationToken: pending.requestId, observationExpiresAt: { lte: now } },
        data: { observationToken: null, observationExpiresAt: null } });
      return { ...saved, expiredReservation: true as const, requestId: pending.requestId, outcome: observation.outcome,
        complete: false as const, providerObservedAt: null, slotCount: 0, failureCode: observation.failureCode,
        freshSuccessfulChecks: 0, nextAction: customerDemandPresent ? "RETRY_ENGINEERING" as const : "REPAIR" as const,
        engineeringOnly: true as const, customerAcceptance: false as const };
    }
    const sameRelease = Boolean(previous && previous.sourceFingerprint === claim.sourceFingerprint && previous.runtimeVersion === claim.releaseSha &&
      previous.deploymentId === claim.deployment!.deploymentId);
    // A repair must register a new exact release/source before another bounded pair of reads.
    const historyValue = audit.simulatorEngineeringVerificationHistory;
    if (historyValue !== undefined && (!Array.isArray(historyValue) || historyValue.length > 8 ||
        historyValue.some(entry => !readSimulatorEngineeringVerificationState(entry)))) throw new Error("SIMULATOR_ENGINEERING_EVIDENCE_INVALID");
    const history = (historyValue ?? []) as SimulatorEngineeringVerificationState[];
    if (previous && !sameRelease && history.length >= 8) throw new Error("SIMULATOR_ENGINEERING_EVIDENCE_LIMIT");
    const state: SimulatorEngineeringVerificationState = sameRelease ? previous! : { schemaVersion: 1,
      sourceFingerprint: claim.sourceFingerprint, runtimeVersion: claim.releaseSha!, deploymentId: claim.deployment!.deploymentId,
      startedAt: now.toISOString(), readsUsed: 0, inFlight: null, observations: [] };
    if (state.inFlight || state.readsUsed >= SIMULATOR_ENGINEERING_VERIFICATION_MAX_READS ||
        state.observations.length && !evaluateSimulatorEngineeringVerification({ now, claim, sourceFingerprint: claim.sourceFingerprint, state }).firstCheckReady) {
      throw new Error("SIMULATOR_ENGINEERING_VERIFICATION_REPAIR_REQUIRED");
    }
    const requestedDate = deriveSimulatorEngineeringVerificationDate(now, timeZone, offering);
    const requestId = deps.requestId();
    const expiresAt = new Date(now.getTime() + SIMULATOR_ENGINEERING_VERIFICATION_LEASE_MS);
    const lease = await tx.courseOffering.updateMany({ where: { id: offering.id, OR: [
      { observationToken: null }, { observationExpiresAt: { lte: now } },
    ] }, data: { observationToken: requestId, observationExpiresAt: expiresAt } });
    if (lease.count !== 1) throw new Error("SIMULATOR_ENGINEERING_PROVIDER_BUSY");
    const inFlight = { requestId, revision: claim.revision + 1, requestedDate, startedAt: now.toISOString(), expiresAt: expiresAt.toISOString() };
    const saved = await context.save({ simulatorEngineeringVerification: { ...state, readsUsed: state.readsUsed + 1, inFlight },
      ...(previous && !sameRelease ? { simulatorEngineeringVerificationHistory: [...history, previous] } : {}) });
    return { ...saved, requestId, requestedDate, startedAt: now, offering, timeZone };
  });
  if ("expiredReservation" in reserved) return reserved;
  const owner = { assignmentRef: input.assignmentRef, token: input.token, revision: reserved.revision, runtimeVersion: runtime.runtimeVersion };
  let normalized: ReturnType<typeof normalizeSimulatorEngineeringResult> | ReturnType<typeof normalizeFailure>;
  const deadline = AbortSignal.timeout(SIMULATOR_ENGINEERING_VERIFICATION_DEADLINE_MS);
  const boundedFetch: typeof fetch = (resource, init) => fetch(resource, { ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
  try {
    const read = await deps.providerLease(new URL(reserved.offering.bookingUrl!).hostname, async () => {
      // Provider capacity can take time to acquire; recheck source/owner/lease before any request.
      await transition(owner, async context => {
        assertSimulatorEngineeringRuntime(runtime, context.claim.deployment!, context.now);
        const state = readSimulatorEngineeringVerificationState((context.audit as { simulatorEngineeringVerification?: unknown }).simulatorEngineeringVerification);
        const pending = state?.inFlight;
        if (!state || !pending || pending.requestId !== reserved.requestId || pending.revision !== owner.revision ||
            Date.parse(pending.expiresAt) <= context.now.getTime() || context.offering.observationToken !== reserved.requestId ||
            !context.offering.observationExpiresAt || context.offering.observationExpiresAt <= context.now) {
          throw new Error("SIMULATOR_ENGINEERING_RESERVATION_STALE");
        }
      });
      deadline.throwIfAborted();
      return deps.read({ offering: { ...reserved.offering, bookingUrl: reserved.offering.bookingUrl! },
        date: reserved.requestedDate, durationMinutes: 60, partySize: 1, timeZone: reserved.timeZone }, boundedFetch);
    });
    if (!read.acquired) throw new Error("SIMULATOR_ENGINEERING_PROVIDER_BUSY");
    if (deadline.aborted || Date.now() - reserved.startedAt.getTime() > SIMULATOR_ENGINEERING_VERIFICATION_DEADLINE_MS) {
      throw new Error("SIMULATOR_ENGINEERING_READ_DEADLINE");
    }
    normalized = normalizeSimulatorEngineeringResult(read.value, reserved.startedAt, new Date(), {
      offeringId: reserved.offering.id, requestedDate: reserved.requestedDate, timeZone: reserved.timeZone,
    });
  } catch (error) { normalized = normalizeFailure(error); }
  return transition({ ...owner, allowCustomerDemandSettlement: true }, async context => {
    assertSimulatorEngineeringRuntime(runtime, context.claim.deployment!, context.now);
    const state = readSimulatorEngineeringVerificationState((context.audit as { simulatorEngineeringVerification?: unknown }).simulatorEngineeringVerification);
    const pending = state?.inFlight;
    if (!state || !pending || pending.requestId !== reserved.requestId || pending.revision !== owner.revision ||
        Date.parse(pending.expiresAt) <= context.now.getTime() || context.offering.observationToken !== reserved.requestId ||
        !context.offering.observationExpiresAt || context.offering.observationExpiresAt <= context.now) {
      throw new Error("SIMULATOR_ENGINEERING_RESERVATION_STALE");
    }
    const customerDemandPresent = Boolean((context as { customerDemandPresent?: boolean }).customerDemandPresent);
    if (customerDemandPresent) {
      normalized = { outcome: "FETCH_FAILED", complete: false, providerObservedAt: null, slotCount: 0, failureCode: "NORMAL_CUSTOMER_CHECK_REQUIRED" };
    }
    // Database time, not the operator or provider clock, owns settlement.
    if (normalized.providerObservedAt && Date.parse(normalized.providerObservedAt) > context.now.getTime()) {
      normalized = normalizeFailure(new Error("SIMULATOR_ENGINEERING_INCOMPLETE_READ"));
    }
    const observation: SimulatorEngineeringVerificationObservation = { ...pending, ...normalized, completedAt: context.now.toISOString() };
    const next = { ...state, inFlight: null, observations: [...state.observations, observation] };
    const saved = await context.save({ simulatorEngineeringVerification: next });
    await context.tx.courseOffering.updateMany({ where: { id: context.offering.id, observationToken: reserved.requestId }, data: {
      observationToken: null, observationExpiresAt: null,
      ...(customerDemandPresent ? {} : observation.complete ? { monitoringState: "HEALTHY", automationEligibility: "ALLOWED", monitoringVerifiedAt: context.now } :
        { monitoringState: "DEGRADED_RETRYING", lastFailureAt: context.now }),
    } });
    const progress = evaluateSimulatorEngineeringVerification({ now: context.now, claim: context.claim, sourceFingerprint: context.claim.sourceFingerprint, state: next });
    return { ...saved, outcome: observation.outcome, complete: observation.complete, requestId: observation.requestId,
      providerObservedAt: observation.providerObservedAt, slotCount: observation.slotCount, failureCode: observation.failureCode,
      freshSuccessfulChecks: progress.freshSuccessfulChecks, ...(customerDemandPresent ? { nextAction: "RETRY_ENGINEERING" as const } : {}),
      engineeringOnly: true as const, customerAcceptance: false as const };
  });
}
