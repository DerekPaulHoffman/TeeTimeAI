import { assertSimulatorSupportDeployment, type SimulatorSupportClaim } from "./simulator-support-policy";
import { evaluateSimulatorEngineeringVerification, readSimulatorEngineeringVerificationState, type SimulatorEngineeringVerificationState } from "./simulator-support-engineering-verification-policy";

type SearchState = {
  id: string;
  status: string;
  checkStatus: string;
  checkLeaseToken: string | null;
  checkLeaseExpiresAt: Date | null;
  lastCheckedAt: Date | null;
  nextCheckAt: Date | null;
};

export type SimulatorSupportProgressProbe = {
  id: string;
  teeSearchId: string;
  automationRunId: string | null;
  observedAt: Date;
  outcome: string;
  runtimeVersion: string | null;
  rawSummary: unknown;
  automationRun: {
    kind: string;
    status: string;
    outcome: string | null;
    errors: unknown;
    completedAt: Date | null;
  } | null;
};

export type SimulatorSupportProgressInput = {
  now: Date;
  claim: SimulatorSupportClaim;
  sourceFingerprint: string;
  offering: { publicAccessStatus: string; monitoringState: string; automationEligibility: string };
  owner: { leaseValid: boolean; demandCurrent: boolean; sourceCurrent: boolean };
  /** The newest offering probes in descending observedAt/id order, at most 16. */
  probes: SimulatorSupportProgressProbe[];
  searches: SearchState[];
  /** Only the ownership layer may select independent engineering authority. */
  engineeringVerification?: SimulatorEngineeringVerificationState | null;
  customerDemandPresent?: boolean;
};

export type SimulatorSupportProgress = {
  nextAction: "WAIT_FOR_CHECK" | "RECHECK_SECOND" | "VERIFY_ENGINEERING" | "RETRY_ENGINEERING" | "COMPLETE" | "REPAIR";
  verificationKind: "CUSTOMER_SEARCH" | "ENGINEERING_ONLY";
  customerAcceptance: boolean;
  reasons: string[];
  leaseValid: boolean;
  demandCurrent: boolean;
  sourceCurrent: boolean;
  releaseReady: boolean;
  offeringReady: boolean;
  verificationCycle: number;
  firstCheckReady: boolean;
  freshSuccessfulChecks: number;
  readyForCompletion: boolean;
  /** Completion still requires its own fresh readback of the current production deployment. */
  currentDeploymentReadbackRequired: true;
  /** Internal evidence for the owner completion audit, in newest-first order. */
  qualifyingProbeIds: string[];
  latestProbe: {
    outcome: string;
    observedAt: string;
    providerObservedAt: string | null;
    runtimeMatches: boolean;
    sourceMatches: boolean;
    scheduledCheckFinished: boolean;
    qualifies: boolean;
  } | null;
};

/** Mirrors the scheduler completion fence used by simulator support ownership. */
export function isFinishedSimulatorSupportCheck(probe: SimulatorSupportProgressProbe, search: SearchState | undefined, now: Date) {
  const run = probe.automationRun;
  return Boolean(run && run.kind === "SEARCH_CHECK" && run.status === "COMPLETED" &&
    ["success", "failed"].includes(run.outcome ?? "") && run.errors === null && run.completedAt &&
    run.completedAt >= probe.observedAt && run.completedAt <= now && search?.status === "ACTIVE" &&
    search.checkStatus === "WAITING" && !search.checkLeaseToken && !search.checkLeaseExpiresAt &&
    search.lastCheckedAt && search.lastCheckedAt >= run.completedAt &&
    search.nextCheckAt && search.nextCheckAt >= search.lastCheckedAt);
}

export function evaluateSimulatorSupportProgress(input: SimulatorSupportProgressInput): SimulatorSupportProgress {
  const { now, claim, owner } = input;
  if (input.engineeringVerification !== undefined) {
    const prior = readSimulatorEngineeringVerificationState(input.engineeringVerification);
    const belongsToCurrentRelease = prior?.runtimeVersion === claim.releaseSha && prior?.deploymentId === claim.deployment?.deploymentId &&
      prior?.sourceFingerprint === claim.sourceFingerprint;
    const state = belongsToCurrentRelease || prior?.inFlight ? prior : undefined;
    const observed = state ? evaluateSimulatorEngineeringVerification({ now, claim, sourceFingerprint: input.sourceFingerprint, state }) : null;
    let releaseReady = observed?.releaseReady ?? false;
    const freshEpisode = !state && (input.engineeringVerification === null || Boolean(prior));
    if (freshEpisode) {
      try { if (claim.releaseSha && claim.deployment) { assertSimulatorSupportDeployment(claim.deployment, claim.releaseSha, now); releaseReady = true; } }
      catch { /* The engineering lane retains the same exact Ready release fence. */ }
    }
    const offeringReady = input.offering.publicAccessStatus === "PUBLIC" && input.offering.monitoringState === "HEALTHY" &&
      input.offering.automationEligibility === "ALLOWED";
    const sourceCurrent = owner.sourceCurrent && claim.sourceFingerprint === input.sourceFingerprint;
    const readyForCompletion = owner.leaseValid && owner.demandCurrent && sourceCurrent && releaseReady && offeringReady &&
      observed?.freshSuccessfulChecks === 2 && !observed.inFlight && !input.customerDemandPresent;
    const reasons = [
      ...(!owner.leaseValid ? ["OWNER_LEASE_STALE"] : []), ...(!owner.demandCurrent ? ["ENGINEERING_AUTHORITY_CHANGED"] : []),
      ...(!sourceCurrent ? ["OFFERING_SOURCE_CHANGED"] : []), ...(!releaseReady ? ["EXACT_RELEASE_NOT_READY"] : []),
      ...(!offeringReady ? ["PUBLIC_MONITORING_NOT_HEALTHY"] : []),
      ...(observed?.inFlight ? ["ENGINEERING_READ_IN_FLIGHT"] : []),
      ...(observed?.expiredReservation ? ["ENGINEERING_READ_EXPIRED"] : []),
      ...(input.customerDemandPresent ? ["NORMAL_CUSTOMER_CHECK_REQUIRED"] : []),
      ...(observed?.failedObservation ? ["LATEST_ENGINEERING_OBSERVATION_NOT_VERIFIED"] : []),
      ...(!state ? [freshEpisode ? "FIRST_ENGINEERING_READ_NEEDED" : "ENGINEERING_EVIDENCE_INVALID"] : []),
      ...(observed?.firstCheckReady && observed.freshSuccessfulChecks < 2 ? ["SECOND_FRESH_CHECK_NEEDED"] : []),
    ];
    const repair = !owner.leaseValid || !owner.demandCurrent || !sourceCurrent || !releaseReady ||
      input.offering.publicAccessStatus !== "PUBLIC" || Boolean(observed?.expiredReservation) ||
      !state && !freshEpisode;
    const latestFailure = observed?.latestObservation;
    const repairableReaderFailure = Boolean(belongsToCurrentRelease && state && observed && observed.releaseReady &&
      owner.leaseValid && owner.demandCurrent && sourceCurrent && !input.customerDemandPresent &&
      !observed.inFlight && !observed.expiredReservation && observed.failedObservation &&
      latestFailure?.complete === false && ["FETCH_FAILED", "NEEDS_ADAPTER"].includes(latestFailure.outcome) &&
      latestFailure.providerObservedAt === null && latestFailure.slotCount === 0 &&
      Date.parse(latestFailure.startedAt) >= Date.parse(state.startedAt) &&
      Date.parse(latestFailure.startedAt) <= now.getTime() &&
      Date.parse(latestFailure.completedAt) <= now.getTime() &&
      Date.parse(latestFailure.completedAt) < Date.parse(latestFailure.expiresAt) &&
      ["SCHEMA_CHANGED", "INVALID_SOURCE", "UNSUPPORTED_PROVIDER", "UNSUPPORTED_DURATION"].includes(latestFailure.failureCode ?? ""));
    return { nextAction: readyForCompletion ? "COMPLETE" : repair ? "REPAIR" : observed?.inFlight ? "WAIT_FOR_CHECK" :
      input.customerDemandPresent ? "RETRY_ENGINEERING" : repairableReaderFailure ? "REPAIR" :
      observed?.failedObservation ? "RETRY_ENGINEERING" : "VERIFY_ENGINEERING",
      verificationKind: "ENGINEERING_ONLY", customerAcceptance: false, reasons, leaseValid: owner.leaseValid, demandCurrent: owner.demandCurrent,
      sourceCurrent, releaseReady, offeringReady, verificationCycle: state?.readsUsed ?? 0, firstCheckReady: observed?.firstCheckReady ?? false,
      freshSuccessfulChecks: observed?.freshSuccessfulChecks ?? 0, readyForCompletion, currentDeploymentReadbackRequired: true,
      qualifyingProbeIds: observed?.qualifyingObservationIds ?? [], latestProbe: null };
  }
  const afterMs = claim.recheckQueuedAt && claim.deployment
    ? Math.max(Date.parse(claim.recheckQueuedAt), Date.parse(claim.deployment.deployedAt), Date.parse(claim.claimedAt)) : NaN;
  let releaseReady = Boolean(claim.releaseSha && claim.deployment && claim.recheckQueuedAt && Number.isFinite(afterMs));
  if (releaseReady) {
    try { assertSimulatorSupportDeployment(claim.deployment!, claim.releaseSha!, now); }
    catch { releaseReady = false; }
  }
  const offeringReady = input.offering.publicAccessStatus === "PUBLIC" &&
    input.offering.monitoringState === "HEALTHY" && input.offering.automationEligibility === "ALLOWED";
  const searchById = new Map(input.searches.map(search => [search.id, search]));
  const qualifies = (probe: SimulatorSupportProgressProbe) => {
    const summary = probe.rawSummary && typeof probe.rawSummary === "object" && !Array.isArray(probe.rawSummary)
      ? probe.rawSummary as Record<string, unknown> : null;
    const providerTime = typeof summary?.providerObservedAt === "string" ? new Date(summary.providerObservedAt) : null;
    const scheduledCheckFinished = isFinishedSimulatorSupportCheck(probe, searchById.get(probe.teeSearchId), now);
    const runtimeMatches = probe.runtimeVersion === claim.releaseSha && Boolean(claim.releaseSha);
    const sourceMatches = summary?.mode === "SIMULATOR" && summary.sourceFingerprint === input.sourceFingerprint;
    const providerTimeMatches = Boolean(providerTime && Number.isFinite(providerTime.getTime()) &&
      providerTime.getTime() >= afterMs && providerTime <= now);
    const observationFailed = !runtimeMatches || !["MATCH_FOUND", "NO_MATCH"].includes(probe.outcome) ||
      !sourceMatches || !providerTimeMatches || !probe.automationRunId ||
      probe.automationRun?.kind !== "SEARCH_CHECK" ||
      !["success", "failed"].includes(probe.automationRun.outcome ?? "") ||
      probe.automationRun.errors !== null || !probe.automationRun.completedAt ||
      probe.automationRun.completedAt < probe.observedAt || probe.automationRun.completedAt > now;
    const valid = releaseReady && runtimeMatches && ["MATCH_FOUND", "NO_MATCH"].includes(probe.outcome) &&
      sourceMatches && providerTime && Number.isFinite(providerTime.getTime()) &&
      providerTime.getTime() >= afterMs && providerTime <= now &&
      providerTime.getTime() >= now.getTime() - 30 * 60_000 && probe.observedAt <= now &&
      probe.observedAt.getTime() >= Math.max(afterMs, now.getTime() - 30 * 60_000) &&
      Boolean(probe.automationRunId) && scheduledCheckFinished;
    return { qualifies: Boolean(valid), observationFailed, providerObservedAt: providerTime && Number.isFinite(providerTime.getTime()) ? providerTime.toISOString() : null,
      runtimeMatches, sourceMatches, scheduledCheckFinished };
  };
  const probes = input.probes.slice(0, 16);
  const first = probes[0];
  const latest = first ? qualifies(first) : null;
  const latestIsPostQueue = Boolean(first && Number.isFinite(afterMs) && first.observedAt.getTime() >= afterMs);
  const ids: string[] = [];
  const runs = new Set<string>();
  let failedPostQueueObservation = false;
  for (const probe of probes) {
    const state = qualifies(probe);
    // A newer failed or stale observation breaks the streak, even when two older checks passed.
    if (!state.qualifies) {
      failedPostQueueObservation = Number.isFinite(afterMs) && probe.observedAt.getTime() >= afterMs &&
        probe.automationRun?.status === "COMPLETED" && state.observationFailed;
      break;
    }
    if (probe.automationRunId && !runs.has(probe.automationRunId)) {
      runs.add(probe.automationRunId);
      ids.push(probe.id);
    }
    if (ids.length === 2) break;
  }
  const firstCheckReady = Boolean(latest?.qualifies);
  const readyForCompletion = releaseReady && offeringReady && owner.leaseValid && owner.demandCurrent &&
    owner.sourceCurrent && claim.sourceFingerprint === input.sourceFingerprint && ids.length === 2;
  const reasons: string[] = [];
  if (!owner.leaseValid) reasons.push("OWNER_LEASE_STALE");
  if (!owner.demandCurrent) reasons.push("SOURCE_DEMAND_CHANGED");
  if (!owner.sourceCurrent || claim.sourceFingerprint !== input.sourceFingerprint) reasons.push("OFFERING_SOURCE_CHANGED");
  if (!releaseReady) reasons.push("EXACT_RELEASE_NOT_READY");
  if (!offeringReady) reasons.push("PUBLIC_MONITORING_NOT_HEALTHY");
  if (claim.verificationCycle === 0) reasons.push("FIRST_RECHECK_NOT_QUEUED");
  if (!first || !latestIsPostQueue) reasons.push("NO_FRESH_CHECK_YET");
  else if (!firstCheckReady) reasons.push(first.automationRun?.status !== "COMPLETED" ||
      searchById.get(first.teeSearchId)?.checkStatus !== "WAITING" ? "CHECK_NOT_FINISHED" : "LATEST_OBSERVATION_NOT_VERIFIED");
  else if (ids.length < 2) reasons.push("SECOND_FRESH_CHECK_NEEDED");
  const repair = !owner.leaseValid || !owner.demandCurrent || !owner.sourceCurrent ||
    claim.sourceFingerprint !== input.sourceFingerprint || !releaseReady ||
    input.offering.publicAccessStatus !== "PUBLIC" || claim.verificationCycle === 0 ||
    (ids.length === 2 && !offeringReady) || failedPostQueueObservation;
  const nextAction = readyForCompletion ? "COMPLETE" : repair ? "REPAIR" :
    claim.verificationCycle === 1 && firstCheckReady ? "RECHECK_SECOND" :
      first && latestIsPostQueue && !firstCheckReady && reasons.includes("LATEST_OBSERVATION_NOT_VERIFIED") ? "REPAIR" : "WAIT_FOR_CHECK";
  return { nextAction, verificationKind: "CUSTOMER_SEARCH", customerAcceptance: readyForCompletion, reasons, leaseValid: owner.leaseValid, demandCurrent: owner.demandCurrent,
    sourceCurrent: owner.sourceCurrent && claim.sourceFingerprint === input.sourceFingerprint,
    releaseReady, offeringReady, verificationCycle: claim.verificationCycle, firstCheckReady,
    freshSuccessfulChecks: ids.length, readyForCompletion, currentDeploymentReadbackRequired: true,
    qualifyingProbeIds: ids,
    latestProbe: first && latest ? { outcome: first.outcome, observedAt: first.observedAt.toISOString(),
      providerObservedAt: latest.providerObservedAt, runtimeMatches: latest.runtimeMatches,
      sourceMatches: latest.sourceMatches, scheduledCheckFinished: latest.scheduledCheckFinished,
      qualifies: latest.qualifies } : null };
}
