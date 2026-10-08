import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { runWithCourseSupportWriterTransitionLease, withCourseSupportWriteConflictRetry, MAX_CONCURRENT_COURSE_SUPPORT_BATCHES, isRuntimeBearingCourseSupportPath } from "./course-support-batches";
import type { CourseDispatchAudit } from "./course-support-course-dispatch";
import { assertSimulatorSupportDeployment, isCurrentSimulatorSupportSource, SIMULATOR_SUPPORT_LEASE_MS, SIMULATOR_SUPPORT_SOURCE_SELECT, validateSimulatorSupportPath, type SimulatorSupportClaim } from "./simulator-support-policy";
import type { GitDeploymentProof } from "@/lib/deployments/wait-for-git-deployment";
import { parseSimulatorOfferingManifest } from "../../../scripts/automation/manage-simulator-offerings";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import { z } from "zod";
import { collectSimulatorSupportResearch, type SimulatorResearchDependencies, type SimulatorResearchResult } from "./simulator-support-research";
export { summarizeSimulatorSupportPublicHtml } from "./simulator-support-research";
import { evaluateSimulatorSupportProgress } from "./simulator-support-progress";
import { assertSimulatorResearchFallbackBeforeRetry, getSimulatorResearchGuide, getSimulatorResearchRetryGuide, getSimulatorResearchObservationFingerprint, getSimulatorResearchImplementationVersion, readSettledSimulatorPublicCheckpoint, readSimulatorResearchState, selectSimulatorResearchTarget, mergeSimulatorResearchBlockedRoutes, readSimulatorResearchFailureMemory, currentSimulatorResearchBlockedRoutes, type SimulatorResearchSource, type SimulatorResearchState } from "./simulator-support-research-policy";
import { classifySimulatorSupportFailure, type SimulatorSupportFailure } from "./simulator-support-failure";

type Owner = { assignmentRef: string; ownerThreadId: string; token: string; revision: number };
const acquiredResearchFailureCodes = new Set([
  "SIMULATOR_RESEARCH_PROVIDER_BUSY", "SIMULATOR_RESEARCH_NETWORK_FAILED", "SIMULATOR_RESEARCH_DEADLINE",
]);

async function readPriorFailedResearchRoutes(tx: Pick<Prisma.TransactionClient, "automationRun">, offeringId: string, fingerprint: string) {
  const where = { promptVersion: "course-support-course-dispatch-v1", status: "COMPLETED" as const,
    outcome: { in: ["simulator_retryable_failed", "simulator_research_failed", "simulator_source_withdrawn", "simulator_source_changed"] },
    AND: [{ audit: { path: ["target", "offeringId"], equals: offeringId } }, { OR: [
      { audit: { path: ["simulatorClaim", "sourceFingerprint"], equals: fingerprint } },
      { audit: { path: ["simulatorResearchPriorFailures", "sourceFingerprint"], equals: fingerprint } },
      { audit: { path: ["simulatorResearch", "history"], array_contains: [{ sourceFingerprint: fingerprint }] } },
    ] }] };
  const latest = await tx.automationRun.findFirst({ where, orderBy: [{ completedAt: "desc" }, { id: "desc" }], select: { audit: true } });
  const memory = latest ? readSimulatorResearchFailureMemory((latest.audit as Record<string, unknown>).simulatorResearchPriorFailures) : undefined;
  // New executions carry the complete bounded denied-route checkpoint forward.
  // Legacy history is imported once; reaching the cap fails instead of dropping it.
  const previous = memory?.sourceFingerprint === fingerprint ? [latest!] : await tx.automationRun.findMany({ where,
    orderBy: [{ completedAt: "desc" }, { id: "desc" }], take: 64, select: { audit: true } });
  if (memory?.sourceFingerprint !== fingerprint && previous.length === 64) throw new Error("Simulator research legacy history reached its bounded import limit.");
  const routes = previous.flatMap(run => {
    const audit = run.audit as Record<string, unknown>;
    const research = readSimulatorResearchState(audit.simulatorResearch, fingerprint);
    const claim = audit.simulatorClaim as SimulatorSupportClaim | undefined;
    return research.history.filter(entry => getSimulatorResearchObservationFingerprint(entry, research, claim?.originalSourceFingerprint) === fingerprint &&
      (entry.outcome === "HARD_FAILED" || [401, 403, 404].includes(entry.httpStatus) ||
      entry.outcome === "READ" && entry.httpStatus >= 200 && entry.httpStatus < 300 &&
      entry.rendered && entry.publicReadEvidence?.renderComplete === false && entry.renderWarning?.startsWith("SECONDARY_")))
      .map(entry => ({ url: entry.requestedUrl, rendered: entry.rendered, httpStatus: entry.httpStatus,
        ...(entry.failure ? { failure: entry.failure } : {}),
        ...(entry.researchImplementationVersion ? { researchImplementationVersion: entry.researchImplementationVersion } : {}),
        ...(entry.renderWarning ? { renderWarning: entry.renderWarning } : {}), ...(entry.configurationDiagnostic ? { configurationDiagnostic: entry.configurationDiagnostic } : {}) }));
  });
  return mergeSimulatorResearchBlockedRoutes([...routes, ...(memory?.sourceFingerprint === fingerprint ? memory.routes : [])]);
}

async function withTransition<T>(operation: (tx: Prisma.TransactionClient, now: Date) => Promise<T>) {
  return runWithCourseSupportWriterTransitionLease(() => withCourseSupportWriteConflictRetry(() => prisma.$transaction(async tx => {
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
    if (!(clock?.now instanceof Date)) throw new Error("Simulator support database time is unavailable.");
    return operation(tx, clock.now);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 })));
}

async function loadAssignment(tx: Prisma.TransactionClient, assignmentRef: string) {
  const dispatch = await import("./course-support-course-dispatch");
  const live = await dispatch.listLiveCourseSupportDispatchReservations(tx);
  const row = live.find(entry => entry.audit.assignmentRef === assignmentRef);
  if (!row || row.audit.target.mode !== "SIMULATOR" || !row.audit.target.offeringId) throw new Error("Simulator assignment is unavailable.");
  return row;
}

async function lockSource(tx: Prisma.TransactionClient, audit: CourseDispatchAudit, now: Date, allowSourceChange = false) {
  const refs = audit.target.searchRefs;
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TeeSearch" WHERE "id" IN (${Prisma.join(refs.map(ref => ref.id))}) ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CourseOffering" WHERE "id" = ${audit.target.offeringId!} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SimulatorSupportIncident" WHERE "id" = ${audit.target.incidentId} FOR UPDATE`);
  const offering = await tx.courseOffering.findUnique({ where: { id: audit.target.offeringId }, include: { course: { select: { name: true, address: true, website: true, timeZone: true, googlePlaceId: true, latitude: true, longitude: true } } } });
  const incident = await tx.simulatorSupportIncident.findUnique({ where: { id: audit.target.incidentId } });
  const searches = await tx.teeSearch.findMany({ where: { id: { in: refs.map(ref => ref.id) } }, select: SIMULATOR_SUPPORT_SOURCE_SELECT });
  if (!offering || offering.kind !== "SIMULATOR" || !offering.active || offering.publicAccessStatus === "NOT_PUBLIC" ||
      offering.courseId !== audit.target.courseId || !incident || incident.offeringId !== offering.id ||
      incident.status === "RESOLVED" || searches.length !== refs.length || searches.some(search => {
        const ref = refs.find(entry => entry.id === search.id);
        return !ref || !isCurrentSimulatorSupportSource({ search, ref, offeringId: offering.id, trafficClass: audit.target.trafficClass, timeZone: offering.course.timeZone, now });
      })) throw new Error("Simulator source demand changed; preserve ownership and stop.");
  const fingerprint = getSimulatorOfferingSourceFingerprint(offering);
  if (!allowSourceChange && fingerprint !== (audit.simulatorClaim?.sourceFingerprint ?? audit.target.offeringSourceFingerprint)) throw new Error("Simulator offering source changed; an explicit owner adoption is required.");
  return { offering, incident, searches, fingerprint };
}

async function loadOwned(tx: Prisma.TransactionClient, input: Owner, now: Date, allowSourceChange = false, allowExpired = false) {
  const row = await loadAssignment(tx, input.assignmentRef);
  const claim = row.audit.simulatorClaim;
  if (row.audit.state !== "CONSUMED" || row.audit.childThreadId !== input.ownerThreadId || !claim ||
      claim.token !== input.token || claim.revision !== input.revision || (!allowExpired && new Date(claim.leaseExpiresAt) <= now)) throw new Error("Simulator support owner, revision or lease is stale.");
  const source = await lockSource(tx, row.audit, now, allowSourceChange);
  return { ...row, claim, source };
}

/** Read-only continuation evidence under the caller's writer transition lease. */
export async function readSimulatorSupportContinuationContext(tx: Prisma.TransactionClient, audit: CourseDispatchAudit, now: Date) {
  if (audit.state !== "CONSUMED" || audit.target.mode !== "SIMULATOR" || !audit.simulatorClaim) throw new Error("Simulator continuation requires the original consumed native claim.");
  const source = await lockSource(tx, audit, now);
  const research = readSimulatorResearchState(audit.simulatorResearch, audit.simulatorClaim.sourceFingerprint);
  if (research.sourceFingerprint !== source.fingerprint) throw new Error("Simulator research navigation belongs to an older source; adopt the reviewed source before research.");
  const last = research.history.at(-1);
  const pending = research.inFlight;
  const expiredPending = pending && new Date(pending.expiresAt) <= now;
  const settledFailure = !pending && Boolean(last?.failure && ["HARD_FAILED", "NETWORK_FAILED", "CAPACITY_BUSY"].includes(last.outcome)) &&
    last?.requestId !== research.lastRecoveredFailureRequestId;
  const settledPublic = audit.simulatorClaim.phase === "CLAIMED" && !audit.simulatorClaim.plannedPaths.length &&
    !audit.simulatorClaim.releaseSha && new Date(audit.simulatorClaim.leaseExpiresAt) <= now
    ? readSettledSimulatorPublicCheckpoint(research, now) : null;
  const failure: SimulatorSupportFailure = { stage: "PUBLIC_READ", category: "UNKNOWN", code: "RESEARCH_RESERVATION_INTERRUPTED" };
  const routeState: SimulatorResearchState = expiredPending ? { ...research, inFlight: null, history: [...research.history, {
    source: pending.source, requestedUrl: pending.url, sourceUrl: pending.url, observedAt: now.toISOString(),
    httpStatus: 0, rendered: pending.rendered, outcome: "HARD_FAILED", requestId: pending.requestId, failure,
  }] } : research;
  const checkpoint = settledFailure || expiredPending || settledPublic ? {
    kind: settledFailure ? "SETTLED_FAILURE" as const : expiredPending ? "EXPIRED_UNFINISHED_READ" as const : "EXPIRED_SETTLED_PUBLIC_READ" as const,
    observedAt: settledFailure ? last!.observedAt : expiredPending ? pending!.expiresAt : settledPublic!.observedAt,
    readCount: research.readCount,
    requestId: settledFailure ? last!.requestId! : expiredPending ? pending!.requestId : settledPublic!.requestId,
    failure: settledFailure ? last!.failure! : null,
    claimLeaseExpired: new Date(audit.simulatorClaim.leaseExpiresAt) <= now,
    researchOnlyClaim: audit.simulatorClaim.phase === "CLAIMED" && !audit.simulatorClaim.plannedPaths.length && !audit.simulatorClaim.releaseSha,
    ...(settledPublic ? { publicReadEvidence: settledPublic.publicReadEvidence } : {}),
    allowedResearchRouteCount: getSimulatorResearchGuide({ state: routeState,
      officialUrl: source.offering.course.website ?? source.offering.evidenceUrl,
      bookingUrl: source.offering.bookingUrl, evidenceUrl: source.offering.evidenceUrl, now,
      priorFailedRoutes: await readPriorFailedResearchRoutes(tx, source.offering.id, source.fingerprint),
    }).suggestedReads.length,
  } : null;
  return { currentSource: true as const, currentClaimRevision: audit.simulatorClaim.revision,
    leaseValid: new Date(audit.simulatorClaim.leaseExpiresAt) > now,
    providerReadInFlight: Boolean(pending && !expiredPending), checkpoint };
}

async function saveClaim(tx: Prisma.TransactionClient, row: { runId: string; audit: CourseDispatchAudit; claim: SimulatorSupportClaim }, now: Date, changes: Partial<SimulatorSupportClaim> = {}, research?: SimulatorResearchState, auditChanges?: Record<string, unknown>) {
  const claim: SimulatorSupportClaim = { ...row.claim, ...changes, revision: row.claim.revision + 1, leaseExpiresAt: new Date(now.getTime() + SIMULATOR_SUPPORT_LEASE_MS).toISOString() };
  await tx.automationRun.update({ where: { id: row.runId }, data: { audit: { ...row.audit, simulatorClaim: claim, ...(research ? { simulatorResearch: research } : {}), ...auditChanges } as unknown as Prisma.InputJsonValue } });
  return { assignmentRef: row.audit.assignmentRef, token: claim.token, revision: claim.revision, phase: claim.phase, leaseExpiresAt: claim.leaseExpiresAt };
}

async function queueOwnedSourceRechecks(tx: Prisma.TransactionClient, row: Awaited<ReturnType<typeof loadOwned>>, now: Date, stage: string) {
  for (const search of row.source.searches) {
    const key = `simulator-remediated:${row.runId}:${row.claim.sourceFingerprint.slice(0, 20)}:${stage}`;
    if (search.remediationDispatchKey === key) continue;
    const busy = search.checkStatus === "CHECKING" && search.checkLeaseExpiresAt && search.checkLeaseExpiresAt > now;
    await tx.teeSearch.update({ where: { id: search.id }, data: busy ? { recheckRequestedAt: now, remediationDispatchKey: key, remediationDispatchVersion: search.scheduleVersion } : {
      scheduleVersion: { increment: 1 }, checkStatus: "QUEUED", nextCheckAt: now, workflowRunId: null, checkLeaseToken: null, checkLeaseExpiresAt: null, recheckRequestedAt: null,
      remediationDispatchKey: key, remediationDispatchVersion: search.scheduleVersion + 1,
    } });
  }
}

export async function configureSimulatorSupportOffering(input: Owner & { manifest: unknown; apply: boolean; expectedFingerprint: string; expectedOfferingRevision: number }) {
  const rows = parseSimulatorOfferingManifest(input.manifest);
  if (rows.length !== 1) throw new Error("Owned simulator configuration accepts exactly one offering.");
  const facts = rows[0];
  if (facts.publicAccessStatus !== "PUBLIC" || !facts.active || !facts.supportedDurationsMinutes.includes(60) ||
      [facts.website, facts.bookingUrl, facts.evidenceUrl].some(url => !getSafeCustomerBookingUrl(url))) throw new Error("Simulator configuration requires reviewed public one-hour rental evidence and safe public URLs.");
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    if (row.claim.releaseSha) throw new Error("Simulator offering configuration is sealed after release registration.");
    const venue = await tx.course.findUniqueOrThrow({ where: { id: row.source.offering.courseId }, select: { googlePlaceId: true, website: true } });
    if (facts.googlePlaceId !== venue.googlePlaceId || row.source.fingerprint !== input.expectedFingerprint || row.source.offering.monitoringRevision !== input.expectedOfferingRevision ||
        new Date(facts.verifiedAt) > now || new Date(facts.verifiedAt) < new Date(Math.max(Date.parse(row.claim.claimedAt), now.getTime() - 30 * 60_000)) ||
        (row.source.offering.observationToken && row.source.offering.observationExpiresAt && row.source.offering.observationExpiresAt > now) ||
        (venue.website && new URL(facts.website).hostname !== new URL(venue.website).hostname)) throw new Error("Simulator configuration does not match the exact owned venue, source revision or official site.");
    if (!input.apply) return { mode: "dry-run" as const, offeringId: row.source.offering.id, expectedFingerprint: row.source.fingerprint, expectedOfferingRevision: row.source.offering.monitoringRevision, facts };
    const updated = await tx.courseOffering.update({ where: { id: row.source.offering.id }, data: {
      active: true, publicAccessStatus: "PUBLIC", bookingUrl: facts.bookingUrl, evidenceUrl: facts.evidenceUrl, verifiedAt: new Date(facts.verifiedAt),
      providerFamilyKey: facts.providerFamilyKey ?? null, providerMetadata: facts.providerMetadata ?? Prisma.DbNull,
      maxPartySize: facts.maxPartySize, supportedDurationsMinutes: facts.supportedDurationsMinutes, bookingWindowDaysAhead: facts.bookingWindowDaysAhead ?? null,
      monitoringState: "UNKNOWN", monitoringVerifiedAt: null, automationEligibility: "UNKNOWN", observationToken: null, observationExpiresAt: null, monitoringRevision: { increment: 1 },
    } });
    return { mode: "applied" as const, ...await saveClaim(tx, row, now), sourceFingerprint: getSimulatorOfferingSourceFingerprint(updated), offeringRevision: updated.monitoringRevision, adoptionRequired: true };
  });
}

export async function readSimulatorSupportSource(input: Owner & { source?: SimulatorResearchSource; linkIndex?: number; rendered?: boolean }, dependencies: SimulatorResearchDependencies | typeof fetch = {}) {
  const before = await withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    const state = readSimulatorResearchState(row.audit.simulatorResearch, row.source.fingerprint);
    if (state.sourceFingerprint !== row.source.fingerprint) throw new Error("Simulator research navigation belongs to an older source; adopt the reviewed source before research.");
    const priorFailedRoutes = currentSimulatorResearchBlockedRoutes(await readPriorFailedResearchRoutes(tx, row.source.offering.id, row.source.fingerprint));
    const selected = selectSimulatorResearchTarget({ state, officialUrl: row.source.offering.course.website ?? row.source.offering.evidenceUrl,
      bookingUrl: row.source.offering.bookingUrl, evidenceUrl: row.source.offering.evidenceUrl, source: input.source, linkIndex: input.linkIndex, rendered: input.rendered ?? false, now, priorFailedRoutes });
    const requestId = randomUUID();
    const research: SimulatorResearchState = { ...state, readCount: state.readCount + 1, inFlight: { requestId, startedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), ...selected } };
    const saved = await saveClaim(tx, row, now);
    await tx.automationRun.update({ where: { id: row.runId }, data: { audit: { ...row.audit,
      simulatorClaim: { ...row.claim, revision: saved.revision, leaseExpiresAt: saved.leaseExpiresAt }, simulatorResearch: research } as unknown as Prisma.InputJsonValue } });
    return { ...saved, ...selected, requestId, sourceFingerprint: row.source.fingerprint };
  });
  if (!before.acquired) return { acquired: false as const };
  let read: SimulatorResearchResult;
  let outcome: "READ" | "NETWORK_FAILED" | "CAPACITY_BUSY" = "READ";
  let failureCode: string | undefined;
  let knownFailure: SimulatorSupportFailure | undefined;
  try {
    read = await collectSimulatorSupportResearch({ url: before.value.url, render: before.value.rendered }, typeof dependencies === "function" ? { fetch: dependencies } : dependencies);
  } catch (error) {
    // Only known research/network failures become observations. Programming and ownership failures remain hard errors.
    const message = error instanceof Error ? error.message : "";
    if (!acquiredResearchFailureCodes.has(message) && !(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) && !(error instanceof TypeError && /fetch failed/i.test(message))) {
      const failure = classifySimulatorSupportFailure(error, "PUBLIC_READ");
      const settled = await withTransition(async (tx, now) => {
        const row = await loadOwned(tx, { ...input, revision: before.value.revision }, now);
        if (row.source.fingerprint !== before.value.sourceFingerprint) throw new Error("Simulator source changed during the public read.");
        const state = readSimulatorResearchState(row.audit.simulatorResearch, row.source.fingerprint);
        if (state.inFlight?.requestId !== before.value.requestId) throw new Error("The original simulator source research reservation changed.");
        const research: SimulatorResearchState = { ...state, inFlight: null, history: [...state.history, {
          source: before.value.source, requestedUrl: before.value.url, sourceUrl: before.value.url,
          sourceFingerprint: before.value.sourceFingerprint,
          observedAt: now.toISOString(), httpStatus: 0, rendered: before.value.rendered, outcome: "HARD_FAILED",
          requestId: before.value.requestId, failure,
        }] };
        const saved = await saveClaim(tx, row, now, {}, research);
        const researchOnly = row.claim.phase === "CLAIMED" && row.claim.plannedPaths.length === 0 &&
          !row.claim.releaseSha && !row.claim.deployment && !row.claim.recheckQueuedAt;
        // A failed read has no implementation to adopt. Closing this execution
        // fences its old token and lets the ordinary scheduler retry a different
        // allowed route without native-chat resurrection or extra provider I/O.
        const retryAt = researchOnly ? new Date(now.getTime() + 15 * 60_000) : null;
        if (retryAt) await tx.simulatorSupportIncident.update({ where: { id: row.source.incident.id }, data: { retryAt } });
        await tx.automationRun.update({ where: { id: row.runId }, data: {
          outcome: retryAt ? "simulator_research_failed" : "simulator_research_hard_failed",
          ...(retryAt ? { status: "COMPLETED", completedAt: now, audit: {
            ...row.audit, simulatorClaim: { ...row.claim, revision: saved.revision, leaseExpiresAt: saved.leaseExpiresAt }, simulatorResearch: research,
            simulatorFailureRecovery: { version: 1, requestId: before.value.requestId, failure, retryAt: retryAt.toISOString(), readsUsed: research.readCount },
          } as unknown as Prisma.InputJsonValue } : {}),
        } });
        return { ...saved, ...(retryAt ? { durableCloseoutRecorded: true as const, retryAt: retryAt.toISOString() } : {}) };
      });
      if (!settled.acquired) throw new Error("SIMULATOR_RESEARCH_FAILURE_CHECKPOINT_UNAVAILABLE");
      const stopped = new Error("SIMULATOR_RESEARCH_HARD_FAILED") as Error & { revision: number; failure: SimulatorSupportFailure; durableCloseoutRecorded?: true; retryAt?: string };
      stopped.revision = settled.value.revision;
      stopped.failure = failure;
      if ("durableCloseoutRecorded" in settled.value) {
        stopped.durableCloseoutRecorded = settled.value.durableCloseoutRecorded;
        stopped.retryAt = settled.value.retryAt;
      }
      throw stopped;
    }
    failureCode = acquiredResearchFailureCodes.has(message) ? message : "SIMULATOR_RESEARCH_NETWORK_FAILED";
    knownFailure = classifySimulatorSupportFailure(error, "PUBLIC_READ");
    outcome = failureCode === "SIMULATOR_RESEARCH_PROVIDER_BUSY" ? "CAPACITY_BUSY" : "NETWORK_FAILED";
    read = { requestedUrl: before.value.url, url: before.value.url, observedAt: new Date().toISOString(), httpStatus: 0,
      method: before.value.rendered ? "BROWSER" : "HTTP", text: "", links: [] };
  }
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, { ...input, revision: before.value.revision }, now);
    if (row.source.fingerprint !== before.value.sourceFingerprint) throw new Error("Simulator source changed during the public read.");
    const state = readSimulatorResearchState(row.audit.simulatorResearch, row.source.fingerprint);
    if (state.inFlight?.requestId !== before.value.requestId) throw new Error("The original simulator source research reservation changed.");
    const usableDocument = read.httpStatus >= 200 && read.httpStatus < 300;
    const roleEvidence = new Map<string, string>();
    if (usableDocument) {
      const linked = new Set(read.links);
      const isFresh = (observedAt: string) => {
        const timestamp = Date.parse(observedAt);
        return Number.isFinite(timestamp) && timestamp >= now.getTime() - 30 * 60_000 && timestamp <= now.getTime();
      };
      for (const role of state.bookingLinkRoles ?? []) {
        if (linked.has(role.url) && isFresh(role.observedAt)) roleEvidence.set(role.url, role.observedAt);
      }
      if (isFresh(read.observedAt)) {
        for (const url of read.bookingLinks ?? []) {
          if (linked.has(url)) roleEvidence.set(url, read.observedAt);
        }
      }
    }
    const research: SimulatorResearchState = { ...state, inFlight: null, links: usableDocument ? read.links : state.links,
      bookingLinks: usableDocument ? [...roleEvidence.keys()] : state.bookingLinks,
      bookingLinkRoles: usableDocument ? [...roleEvidence].map(([url, observedAt]) => ({ url, observedAt })) : state.bookingLinkRoles,
      linkBaseUrl: usableDocument ? read.url : state.linkBaseUrl,
      history: [...state.history, { source: before.value.source, requestedUrl: before.value.url, sourceUrl: read.url,
        sourceFingerprint: before.value.sourceFingerprint,
        observedAt: read.observedAt, httpStatus: read.httpStatus, rendered: before.value.rendered, outcome,
        requestId: before.value.requestId, researchImplementationVersion: getSimulatorResearchImplementationVersion(before.value.url),
        ...(read.renderWarning ? { renderWarning: read.renderWarning } : {}),
        ...(read.configurationDiagnostic ? { configurationDiagnostic: read.configurationDiagnostic } : {}),
        ...(read.publicConfiguration ? { publicConfiguration: read.publicConfiguration } : {}),
        ...(outcome === "READ" && read.accessControlsObserved === true ? { publicReadEvidence: {
          sourceFingerprint: row.source.fingerprint,
          accessControlsObserved: true as const, accessControls: read.accessControls ?? [], method: read.method,
          ...(read.renderComplete !== undefined ? { renderComplete: read.renderComplete } : {}),
        } } : {}),
        ...(knownFailure ? { failure: knownFailure } : {}) }] };
    const saved = await saveClaim(tx, row, now);
    await tx.automationRun.update({ where: { id: row.runId }, data: { audit: { ...row.audit, simulatorClaim: { ...row.claim, revision: saved.revision, leaseExpiresAt: saved.leaseExpiresAt }, simulatorResearch: research } as unknown as Prisma.InputJsonValue } });
    return { ...saved, publicSource: read, researchOutcome: outcome, ...(failureCode ? { failureCode } : {}), readsRemaining: 6 - research.readCount };
  });
}

const simulatorDispositionSchema = z.object({
  reason: z.enum(["MEMBERS_ONLY", "NOT_SIMULATOR_RENTAL", "ACCOUNT_REQUIRED", "CAPTCHA_OR_QUEUE", "PHONE_ONLY"]),
  evidenceUrl: z.string().url().refine(value => Boolean(getSafeCustomerBookingUrl(value)), "Use a safe public evidence URL"),
  observedAt: z.string().datetime(), publicSignedOut: z.literal(true), summary: z.string().trim().min(20).max(2000),
}).strict();

export async function classifySimulatorSupportOffering(input: Owner & { evidence: unknown; apply: boolean }) {
  const evidence = simulatorDispositionSchema.parse(input.evidence);
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    const observedAt = new Date(evidence.observedAt);
    const officialHosts = [row.source.offering.course.website, row.source.offering.bookingUrl, row.source.offering.evidenceUrl].filter((value): value is string => Boolean(value)).map(value => new URL(value).hostname);
    if (observedAt > now || observedAt < new Date(row.claim.claimedAt) || observedAt < new Date(now.getTime() - 30 * 60_000) ||
        !officialHosts.includes(new URL(evidence.evidenceUrl).hostname) ||
        (row.source.offering.observationToken && row.source.offering.observationExpiresAt && row.source.offering.observationExpiresAt > now)) throw new Error("Simulator disposition requires fresh exact official-source evidence and no live provider observation.");
    if (!input.apply) return { mode: "dry-run" as const, offeringId: row.source.offering.id, evidence };
    const identity = ["MEMBERS_ONLY", "NOT_SIMULATOR_RENTAL"].includes(evidence.reason);
    await tx.courseOffering.update({ where: { id: row.source.offering.id }, data: {
      ...(identity ? { publicAccessStatus: "NOT_PUBLIC" } : {}), automationEligibility: "BLOCKED", monitoringState: identity ? "FINAL_IDENTITY" : "FINAL_TECHNICAL",
      evidenceUrl: evidence.evidenceUrl, verifiedAt: observedAt, observationToken: null, observationExpiresAt: null, monitoringRevision: { increment: 1 },
    } });
    await tx.simulatorSupportIncident.update({ where: { id: row.source.incident.id }, data: { status: "RESOLVED", reason: evidence.reason, evidenceUrl: evidence.evidenceUrl, resolvedAt: now, retryAt: null } });
    await queueOwnedSourceRechecks(tx, row, now, "disposition");
    await tx.automationRun.update({ where: { id: row.runId }, data: { status: "COMPLETED", completedAt: now, outcome: "simulator_official_disposition", audit: { ...row.audit, simulatorDisposition: evidence } as unknown as Prisma.InputJsonValue } });
    return { mode: "applied" as const, outcome: "classification_only" as const, durableCloseoutRecorded: true, reason: evidence.reason };
  });
}

export async function claimSimulatorSupportAssignment(input: { assignmentRef: string; ownerThreadId: string; baseSha: string; branch: string }) {
  if (!/^[a-f0-9]{40}$/i.test(input.baseSha) || !input.branch || input.branch === "main") throw new Error("Simulator support requires a named task branch and exact main base.");
  return withTransition(async (tx, now) => {
    const row = await loadAssignment(tx, input.assignmentRef);
    if (row.audit.state !== "BOUND" || row.audit.childThreadId !== input.ownerThreadId || row.audit.baseSha !== input.baseSha) throw new Error("Simulator claim requires the exact bound native child and base.");
    const dispatch = await import("./course-support-course-dispatch");
    if (!dispatch.isCourseSupportLaunchAuthorityCurrent(row.audit, now)) throw new Error("Simulator launch authority expired before claim.");
    const source = await lockSource(tx, row.audit, now);
    if (source.incident.updatedAt.toISOString() !== row.audit.target.updatedAt || (source.incident.retryAt && source.incident.retryAt > now)) throw new Error("Simulator incident changed or is not due.");
    const latest = await tx.courseProbe.findFirst({ where: { offeringId: source.offering.id, teeSearchId: { in: row.audit.target.searchRefs.map(ref => ref.id) } }, orderBy: [{ observedAt: "desc" }, { id: "desc" }] });
    const summary = latest?.rawSummary as Record<string, unknown> | null;
    if (!latest || !["NEEDS_ADAPTER", "FETCH_FAILED"].includes(latest.outcome) || summary?.mode !== "SIMULATOR" || summary.sourceFingerprint !== source.fingerprint) throw new Error("Simulator claim requires a current offering-scoped failure probe.");
    const live = await dispatch.listLiveCourseSupportDispatchReservations(tx);
    const batches = await tx.courseSupportBatch.findMany({ where: { status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] } }, select: { id: true, incidents: { select: { courseId: true } } }, take: 16 });
    const occupied = new Set([...live.map(entry => entry.audit.target.courseId), ...batches.flatMap(batch => batch.incidents.length ? batch.incidents.map(entry => entry.courseId) : [batch.id])]);
    if (batches.length + live.length > MAX_CONCURRENT_COURSE_SUPPORT_BATCHES || occupied.size > MAX_CONCURRENT_COURSE_SUPPORT_BATCHES || live.some(entry => entry.runId !== row.runId && entry.audit.target.offeringId === source.offering.id)) throw new Error("Simulator support shared capacity or offering ownership changed.");
    const claim: SimulatorSupportClaim = { token: randomUUID(), revision: 1, phase: "CLAIMED", claimedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + SIMULATOR_SUPPORT_LEASE_MS).toISOString(), sourceFingerprint: source.fingerprint, originalSourceFingerprint: source.fingerprint,
      offeringRevision: source.offering.monitoringRevision, plannedPaths: [], releaseSha: null, branch: input.branch, deployment: null, recheckQueuedAt: null, verificationCycle: 0 };
    const priorFailures = await readPriorFailedResearchRoutes(tx, source.offering.id, source.fingerprint);
    await tx.automationRun.update({ where: { id: row.runId }, data: { audit: { ...row.audit, state: "CONSUMED", consumedAt: now.toISOString(), simulatorClaim: claim,
      simulatorResearchPriorFailures: { version: 1, sourceFingerprint: source.fingerprint, routes: priorFailures },
    } as unknown as Prisma.InputJsonValue, outcome: "simulator_claimed" } });
    return { assignmentRef: input.assignmentRef, token: claim.token, revision: claim.revision, phase: claim.phase, leaseExpiresAt: claim.leaseExpiresAt,
      offeringId: source.offering.id, courseId: source.offering.courseId, engineeringOnly: row.audit.target.trafficClass === "SYNTHETIC", sourceFingerprint: source.fingerprint,
      venue: source.offering.course, evidenceUrl: source.offering.evidenceUrl, bookingUrl: source.offering.bookingUrl,
      providerFamilyKey: source.offering.providerFamilyKey, providerMetadata: source.offering.providerMetadata, supportedDurationsMinutes: source.offering.supportedDurationsMinutes,
      researchGuide: getSimulatorResearchGuide({ state: readSimulatorResearchState(undefined, source.fingerprint),
        officialUrl: source.offering.course.website ?? source.offering.evidenceUrl, bookingUrl: source.offering.bookingUrl, evidenceUrl: source.offering.evidenceUrl, now,
        priorFailedRoutes: currentSimulatorResearchBlockedRoutes(priorFailures) }) };
  });
}

export function heartbeatSimulatorSupport(input: Owner) {
  return withTransition(async (tx, now) => saveClaim(tx, await loadOwned(tx, input, now), now));
}

export function recoverSimulatorSupport(input: Owner) {
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now, true, true);
    const research = readSimulatorResearchState(row.audit.simulatorResearch, row.claim.sourceFingerprint);
    const last = research.history.at(-1);
    const failedRead = Boolean(last?.failure && ["HARD_FAILED", "NETWORK_FAILED", "CAPACITY_BUSY"].includes(last.outcome)) &&
      last?.requestId !== research.lastRecoveredFailureRequestId &&
      !research.inFlight && row.source.fingerprint === row.claim.sourceFingerprint;
    if (new Date(row.claim.leaseExpiresAt) > now && !failedRead) throw new Error("Recover is reserved for the same native owner after its lease expires.");
    const dispatch = await import("./course-support-course-dispatch");
    if (row.claim.plannedPaths.length && await dispatch.hasSimulatorSupportImplementationOwnership(tx, input.assignmentRef)) throw new Error("Simulator implementation ownership conflicts during recovery.");
    const pending = research.inFlight;
    if (pending && new Date(pending.expiresAt) > now) throw new Error("The original simulator research request is still within its bounded interval.");
    const saved = await saveClaim(tx, row, now, {}, pending ? { ...research, inFlight: null, lastRecoveredFailureRequestId: pending.requestId, history: [...research.history, {
      source: pending.source, requestedUrl: pending.url, sourceUrl: pending.url, observedAt: now.toISOString(), httpStatus: 0, rendered: pending.rendered, outcome: "HARD_FAILED",
      sourceFingerprint: research.sourceFingerprint,
      requestId: pending.requestId, failure: { stage: "PUBLIC_READ", category: "UNKNOWN", code: "RESEARCH_RESERVATION_INTERRUPTED" },
    }] } : failedRead ? { ...research, lastRecoveredFailureRequestId: last?.requestId } : research);
    if (pending) await tx.automationRun.update({ where: { id: row.runId }, data: { outcome: "simulator_research_hard_failed" } });
    return saved;
  });
}

export function retireSimulatorSupport(input: Owner) {
  return withTransition(async (tx, now) => {
    const row = await loadAssignment(tx, input.assignmentRef);
    const claim = row.audit.simulatorClaim;
    if (row.audit.state !== "CONSUMED" || row.audit.childThreadId !== input.ownerThreadId || !claim || claim.token !== input.token || claim.revision !== input.revision) throw new Error("Only the original native owner and exact token/revision may retire simulator ownership.");
    let invalid = false;
    try { await lockSource(tx, row.audit, now, true); } catch { invalid = true; }
    if (!invalid) throw new Error("Simulator retirement requires demand to be paused, edited, ended, removed or otherwise ineligible.");
    await tx.automationRun.update({ where: { id: row.runId }, data: { status: "COMPLETED", completedAt: now, outcome: "simulator_source_withdrawn" } });
    return { outcome: "source_withdrawn" as const, durableCloseoutRecorded: true, stopWorker: true };
  });
}

export function claimSimulatorSupportPath(input: Owner & { path: string }) {
  const path = validateSimulatorSupportPath(input.path);
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    if (row.claim.releaseSha) throw new Error("Simulator support implementation paths are sealed after release registration.");
    const dispatch = await import("./course-support-course-dispatch");
    const batches = await tx.courseSupportBatch.findMany({ where: { status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] } }, select: { status: true, summary: true } });
    if (batches.some(batch => { const summary = batch.summary as Record<string, unknown> | null; return batch.status === "IMPLEMENTING" || (Array.isArray(summary?.plannedPaths) && summary.plannedPaths.length > 0) || (summary?.remediationDirective as Record<string, unknown> | undefined)?.requiresImplementationPath === true; }) ||
        await dispatch.hasSimulatorSupportImplementationOwnership(tx, input.assignmentRef)) throw new Error("Another course-support worker owns implementation authority.");
    return saveClaim(tx, row, now, { phase: "IMPLEMENTING", plannedPaths: [...new Set([...row.claim.plannedPaths, path])] });
  });
}

export function adoptSimulatorSupportSource(input: Owner & { expectedFingerprint: string; expectedOfferingRevision: number }) {
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now, true);
    if (row.source.fingerprint !== input.expectedFingerprint || row.source.offering.monitoringRevision !== input.expectedOfferingRevision ||
        row.source.offering.publicAccessStatus !== "PUBLIC" || !row.source.offering.evidenceUrl || !row.source.offering.verifiedAt) throw new Error("Simulator source adoption requires exact reviewed public rental evidence before deployed verification.");
    const research = readSimulatorResearchState(row.audit.simulatorResearch, row.claim.sourceFingerprint);
    if (research.inFlight) throw new Error("Finish the original simulator research request before source adoption.");
    const changed = row.source.fingerprint !== row.claim.sourceFingerprint;
    return saveClaim(tx, row, now, { sourceFingerprint: row.source.fingerprint, offeringRevision: row.source.offering.monitoringRevision,
      ...(changed ? { deployment: null, recheckQueuedAt: null, verificationCycle: 0 } : {}) },
      changed ? { ...research, sourceFingerprint: row.source.fingerprint,
        history: research.history.map(entry => { const observedSource = getSimulatorResearchObservationFingerprint(entry, research, row.claim.originalSourceFingerprint);
          return observedSource ? { ...entry, sourceFingerprint: observedSource } : entry; }),
        links: [], bookingLinks: [], bookingLinkRoles: [], linkBaseUrl: null } : research);
  });
}

export function registerSimulatorSupportRelease(input: Owner & { releaseSha: string; branch: string; committedPaths: string[];
  trustedUpstreamSha: string; upstreamDescendantVerified: boolean; descendantVerified: boolean }) {
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    const metadataReuseKind = row.claim.plannedPaths.length === 0 && input.releaseSha === row.audit.baseSha ? "ORIGINAL_BASE" :
      row.claim.plannedPaths.length === 0 && input.releaseSha === input.trustedUpstreamSha ? "TRUSTED_UPSTREAM" : null;
    const claimedRuntimePaths = input.committedPaths.filter(path => /^(src\/|scripts\/|prisma\/)/.test(path) && isRuntimeBearingCourseSupportPath(path));
    if (!/^[a-f0-9]{40}$/i.test(input.releaseSha) || !/^[a-f0-9]{40}$/i.test(input.trustedUpstreamSha) ||
        input.branch !== row.claim.branch || !input.upstreamDescendantVerified || !input.descendantVerified ||
        (row.claim.releaseSha && row.claim.releaseSha !== input.releaseSha) ||
        input.committedPaths.some(path => !row.claim.plannedPaths.includes(validateSimulatorSupportPath(path))) ||
        (metadataReuseKind ? input.committedPaths.length !== 0 :
          row.claim.plannedPaths.length === 0 || input.releaseSha === row.audit.baseSha || input.releaseSha === input.trustedUpstreamSha ||
          input.committedPaths.length === 0 || claimedRuntimePaths.length === 0)) throw new Error("Simulator support release provenance is invalid.");
    return saveClaim(tx, row, now, { phase: "VERIFYING", releaseSha: input.releaseSha }, undefined, {
      simulatorReleaseProvenance: { originalBaseSha: row.audit.baseSha, trustedUpstreamSha: input.trustedUpstreamSha,
        releaseSha: input.releaseSha, metadataOnlyReuse: Boolean(metadataReuseKind), metadataReuseKind, committedPaths: input.committedPaths,
        upstreamDescendantVerified: true, descendantVerified: true, recordedAt: now.toISOString() },
    });
  });
}

/** The normal planner can retire expired research executors without reviving a native chat. */
export async function reconcileExpiredSimulatorResearchExecutions(tx: Prisma.TransactionClient, now: Date,
  runs: Array<{ id: string; status: string; parsed: CourseDispatchAudit | null }>) {
  for (const run of runs) {
    const audit = run.parsed, claim = audit?.simulatorClaim;
    if (run.status !== "RUNNING" || !audit || audit.target.mode !== "SIMULATOR" || audit.state !== "CONSUMED" || !claim ||
        claim.phase !== "CLAIMED" || claim.plannedPaths.length || claim.releaseSha || claim.deployment || claim.recheckQueuedAt ||
        new Date(claim.leaseExpiresAt) > now) continue;
    const state = readSimulatorResearchState(audit.simulatorResearch, claim.sourceFingerprint);
    if (state.inFlight && new Date(state.inFlight.expiresAt) > now) continue;
    let source: Awaited<ReturnType<typeof lockSource>> | undefined;
    let sourceWithdrawn = false;
    try { source = await lockSource(tx, audit, now, true); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "Simulator source demand changed; preserve ownership and stop.") throw error;
      sourceWithdrawn = true;
    }
    const pending = state.inFlight;
    const research: SimulatorResearchState = pending ? { ...state, inFlight: null, history: [...state.history, {
      source: pending.source, requestedUrl: pending.url, sourceUrl: pending.url, observedAt: now.toISOString(), httpStatus: 0,
      sourceFingerprint: state.sourceFingerprint,
      rendered: pending.rendered, outcome: "HARD_FAILED", requestId: pending.requestId,
      failure: { stage: "PUBLIC_READ", category: "UNKNOWN", code: "RESEARCH_RESERVATION_INTERRUPTED" },
    }] } : state;
    const sourceChanged = source && source.fingerprint !== claim.sourceFingerprint;
    const retryAt = !sourceWithdrawn && !sourceChanged ? new Date(now.getTime() + 15 * 60_000) : null;
    if (retryAt) await tx.simulatorSupportIncident.update({ where: { id: source!.incident.id }, data: { retryAt } });
    const updated = { ...audit, simulatorResearch: research,
      simulatorFailureRecovery: { version: 1, reason: sourceWithdrawn ? "SOURCE_WITHDRAWN" : sourceChanged ? "SOURCE_CHANGED" : "EXECUTOR_LEASE_EXPIRED",
        settledAt: now.toISOString(), retryAt: retryAt?.toISOString() ?? null, readsUsed: research.readCount },
    };
    await tx.automationRun.update({ where: { id: run.id }, data: { audit: updated as unknown as Prisma.InputJsonValue,
      status: "COMPLETED", completedAt: now, outcome: sourceWithdrawn ? "simulator_source_withdrawn" : sourceChanged ? "simulator_source_changed" : "simulator_research_failed" } });
    run.status = "COMPLETED";
    run.parsed = updated;
  }
}

export function recordSimulatorSupportDeployment(input: Owner & { proof: GitDeploymentProof }) {
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    if (!row.claim.releaseSha) throw new Error("Register the owner release before verifying deployment.");
    assertSimulatorSupportDeployment(input.proof, row.claim.releaseSha, now);
    return saveClaim(tx, row, now, { deployment: input.proof });
  });
}

async function loadSimulatorVerificationProgress(tx: Prisma.TransactionClient, row: Awaited<ReturnType<typeof loadOwned>>, now: Date) {
  const after = row.claim.recheckQueuedAt && row.claim.deployment ? new Date(Math.max(
    Date.parse(row.claim.recheckQueuedAt), Date.parse(row.claim.deployment.deployedAt), Date.parse(row.claim.claimedAt),
  )) : null;
  const probes = await tx.courseProbe.findMany({ where: { offeringId: row.source.offering.id, ...(after ? { observedAt: { gte: after } } : {}) },
      include: { automationRun: true }, orderBy: [{ observedAt: "desc" }, { id: "desc" }], take: 16 });
  const searches = await tx.teeSearch.findMany({ where: { id: { in: row.source.searches.map(search => search.id) } }, select: {
      id: true, status: true, checkStatus: true, checkLeaseToken: true, checkLeaseExpiresAt: true, lastCheckedAt: true, nextCheckAt: true,
    } });
  return evaluateSimulatorSupportProgress({ now, claim: row.claim, sourceFingerprint: row.source.fingerprint,
    offering: row.source.offering, owner: { leaseValid: true, demandCurrent: true, sourceCurrent: true }, probes, searches });
}

export function readSimulatorSupportProgress(input: Owner) {
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    const progress = await loadSimulatorVerificationProgress(tx, row, now);
    const { qualifyingProbeIds: _privateProbeIds, ...publicProgress } = progress;
    void _privateProbeIds;
    const research = readSimulatorResearchState(row.audit.simulatorResearch, row.source.fingerprint);
    return { ...publicProgress, revision: row.claim.revision, leaseExpiresAt: row.claim.leaseExpiresAt,
      research: { readsUsed: research.readCount, inFlight: Boolean(research.inFlight) } };
  });
}

export function queueSimulatorSupportRechecks(input: Owner) {
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    if (!row.claim.deployment || !row.claim.releaseSha) throw new Error("Simulator rechecks require a verified exact production deployment.");
    assertSimulatorSupportDeployment(row.claim.deployment, row.claim.releaseSha, now);
    let cycle = row.claim.verificationCycle;
    if (cycle === 1) {
      if (!(await loadSimulatorVerificationProgress(tx, row, now)).firstCheckReady) throw new Error("The second simulator verification check requires the first fresh successful observation and finished scheduled check.");
    }
    if (cycle < 2) { cycle += 1; await queueOwnedSourceRechecks(tx, row, now, `verification-${cycle}`); }
    return saveClaim(tx, row, now, { recheckQueuedAt: row.claim.recheckQueuedAt ?? now.toISOString(), verificationCycle: cycle });
  });
}

export function completeSimulatorSupport(input: Owner & { currentDeployment: GitDeploymentProof }) {
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    if (!row.claim.releaseSha || !row.claim.deployment || !row.claim.recheckQueuedAt || row.source.offering.publicAccessStatus !== "PUBLIC" ||
        row.source.offering.monitoringState !== "HEALTHY" || row.source.offering.automationEligibility !== "ALLOWED") throw new Error("Simulator completion requires deployed rechecks and verified public rental access.");
    assertSimulatorSupportDeployment(row.claim.deployment, row.claim.releaseSha, now);
    assertSimulatorSupportDeployment(input.currentDeployment, row.claim.releaseSha, now);
    if (input.currentDeployment.deploymentId !== row.claim.deployment.deploymentId || input.currentDeployment.deploymentUrl !== row.claim.deployment.deploymentUrl) throw new Error("Simulator completion requires a fresh read of the same current production deployment.");
    const progress = await loadSimulatorVerificationProgress(tx, row, now);
    if (!progress.readyForCompletion) throw new Error("Simulator support needs two distinct fresh successful checks on the exact current release; newer failures cannot be ignored.");
    await tx.simulatorSupportIncident.update({ where: { id: row.source.incident.id }, data: { status: "RESOLVED", resolvedAt: now, retryAt: null } });
    await tx.automationRun.update({ where: { id: row.runId }, data: { status: "COMPLETED", completedAt: now, outcome: "simulator_monitoring_restored", audit: {
      ...row.audit, simulatorVerification: { runtimeVersion: row.claim.releaseSha, sourceFingerprint: row.source.fingerprint, verifiedAt: now.toISOString(), probeIds: progress.qualifyingProbeIds },
    } as unknown as Prisma.InputJsonValue } });
    return { outcome: "success" as const, durableCloseoutRecorded: true, engineeringOnly: row.audit.target.trafficClass === "SYNTHETIC" };
  });
}

export function retrySimulatorSupport(input: Owner & { retryMinutes: number }) {
  if (!Number.isSafeInteger(input.retryMinutes) || input.retryMinutes < 1 || input.retryMinutes > 1440) throw new Error("Simulator retry must be from 1 to 1440 minutes.");
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    const state = readSimulatorResearchState(row.audit.simulatorResearch, row.source.fingerprint);
    if (state.sourceFingerprint !== row.source.fingerprint) throw new Error("Simulator research navigation belongs to an older source; adopt the reviewed source before retry.");
    const officialUrl = row.source.offering.course.website ?? row.source.offering.evidenceUrl;
    const bookingUrl = row.source.offering.bookingUrl;
    const priorFailedRoutes = currentSimulatorResearchBlockedRoutes(await readPriorFailedResearchRoutes(tx, row.source.offering.id, row.source.fingerprint));
    const retryGuide = getSimulatorResearchRetryGuide({ state, officialUrl, bookingUrl, now, priorFailedRoutes });
    if (retryGuide.bookingResearchRequired) return {
      outcome: "booking_research_required" as const, revision: row.claim.revision, leaseExpiresAt: row.claim.leaseExpiresAt,
      researchGuide: retryGuide.researchGuide, nextEligibleBookingRead: retryGuide.nextEligibleBookingRead,
    };
    if (!retryGuide.skipHomepageFallback) assertSimulatorResearchFallbackBeforeRetry(state, bookingUrl, officialUrl);
    const retryAt = new Date(now.getTime() + input.retryMinutes * 60_000);
    await tx.simulatorSupportIncident.update({ where: { id: row.source.incident.id }, data: { status: "AUTO_INVESTIGATING", retryAt } });
    await tx.automationRun.update({ where: { id: row.runId }, data: { status: "COMPLETED", completedAt: now, outcome: "simulator_retryable_failed" } });
    return { outcome: "retryable_failed" as const, retryAt: retryAt.toISOString(), durableCloseoutRecorded: true };
  });
}

export async function readSimulatorSupportClaim(input: { assignmentRef: string; ownerThreadId: string }) {
  const row = await loadAssignment(prisma, input.assignmentRef);
  if (row.audit.childThreadId !== input.ownerThreadId || row.audit.state !== "CONSUMED" || !row.audit.simulatorClaim) throw new Error("Simulator support claim is not owned by this native task.");
  const offering = await prisma.courseOffering.findUniqueOrThrow({ where: { id: row.audit.target.offeringId }, include: { course: { select: { name: true, address: true, website: true, timeZone: true, googlePlaceId: true, latitude: true, longitude: true } } } });
  const research = readSimulatorResearchState(row.audit.simulatorResearch, row.audit.simulatorClaim.sourceFingerprint);
  const latest = research.history.at(-1);
  return { ...row.audit.simulatorClaim, baseSha: row.audit.baseSha, offeringId: row.audit.target.offeringId!,
    research, researchGuide: getSimulatorResearchGuide({ state: research, officialUrl: offering.course.website ?? offering.evidenceUrl,
      bookingUrl: offering.bookingUrl, evidenceUrl: offering.evidenceUrl, now: new Date(), priorFailedRoutes: currentSimulatorResearchBlockedRoutes(await readPriorFailedResearchRoutes(prisma, offering.id, row.audit.simulatorClaim.sourceFingerprint)) }),
    failedRead: !research.inFlight && latest?.failure && latest.requestId !== research.lastRecoveredFailureRequestId &&
      ["HARD_FAILED", "NETWORK_FAILED", "CAPACITY_BUSY"].includes(latest.outcome) ? { revision: row.audit.simulatorClaim.revision, requestId: latest.requestId,
      failure: latest.failure, readsUsed: research.readCount, readsRemaining: 6 - research.readCount } : null,
    venue: offering.course, evidenceUrl: offering.evidenceUrl, bookingUrl: offering.bookingUrl, providerFamilyKey: offering.providerFamilyKey, providerMetadata: offering.providerMetadata, supportedDurationsMinutes: offering.supportedDurationsMinutes };
}
