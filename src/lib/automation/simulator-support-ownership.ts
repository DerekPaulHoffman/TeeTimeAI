import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { runWithCourseSupportWriterTransitionLease, withCourseSupportWriteConflictRetry, MAX_CONCURRENT_COURSE_SUPPORT_BATCHES } from "./course-support-batches";
import type { CourseDispatchAudit } from "./course-support-course-dispatch";
import { assertSimulatorSupportDeployment, isCurrentSimulatorSupportSource, SIMULATOR_SUPPORT_LEASE_MS, SIMULATOR_SUPPORT_SOURCE_SELECT, validateSimulatorSupportPath, type SimulatorSupportClaim } from "./simulator-support-policy";
import type { GitDeploymentProof } from "@/lib/deployments/wait-for-git-deployment";
import { parseSimulatorOfferingManifest } from "../../../scripts/automation/manage-simulator-offerings";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import { z } from "zod";
import { runWithProviderRequestLease } from "./provider-request-lease";
import { createAddressPinnedPublicFetchTransport } from "./address-pinned-public-fetch";
import { sanitizeResponderText } from "./course-support-responder-policy";
import { parse } from "parse5";

type Owner = { assignmentRef: string; ownerThreadId: string; token: string; revision: number };

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
  const offering = await tx.courseOffering.findUnique({ where: { id: audit.target.offeringId }, include: { course: { select: { name: true, address: true, website: true, timeZone: true } } } });
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

async function saveClaim(tx: Prisma.TransactionClient, row: { runId: string; audit: CourseDispatchAudit; claim: SimulatorSupportClaim }, now: Date, changes: Partial<SimulatorSupportClaim> = {}) {
  const claim: SimulatorSupportClaim = { ...row.claim, ...changes, revision: row.claim.revision + 1, leaseExpiresAt: new Date(now.getTime() + SIMULATOR_SUPPORT_LEASE_MS).toISOString() };
  await tx.automationRun.update({ where: { id: row.runId }, data: { audit: { ...row.audit, simulatorClaim: claim } as unknown as Prisma.InputJsonValue } });
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
    if (facts.googlePlaceId !== venue.googlePlaceId || row.source.fingerprint !== input.expectedFingerprint || row.source.offering.monitoringRevision !== input.expectedOfferingRevision || new Date(facts.verifiedAt) > now ||
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

type PublicNode = { nodeName?: string; tagName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: PublicNode[] };
export function summarizeSimulatorSupportPublicHtml(html: string, sourceUrl: string) {
  const text: string[] = [], anchors = new Set<string>();
  const walk = (node: PublicNode) => {
    if (node.tagName && ["script", "style", "form", "input", "textarea", "select"].includes(node.tagName)) return;
    if (node.nodeName === "#text" && node.value) text.push(node.value);
    if (node.tagName === "a" && anchors.size < 30) {
      const href = node.attrs?.find(attribute => attribute.name === "href")?.value;
      if (href) { try { const safe = getSafeCustomerBookingUrl(new URL(href, sourceUrl).href); if (safe) anchors.add(safe); } catch { /* Invalid public link is omitted. */ } }
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(parse(html));
  return { text: sanitizeResponderText(text.join(" ").replace(/\s+/g, " ").trim()).slice(0, 12_000), links: [...anchors] };
}

export async function readSimulatorSupportSource(input: Owner & { source: "official" | "booking" }, fetchImpl: typeof fetch = createAddressPinnedPublicFetchTransport({
  parseUrl: value => { const safe = getSafeCustomerBookingUrl(value); if (!safe) throw new Error("Simulator source URL is not safe and public."); return new URL(safe); },
  maxResponseBytes: 1_500_000, redirectLimit: 4, timeoutMs: 10_000,
})) {
  const before = await withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    const url = input.source === "official" ? row.source.offering.course.website ?? row.source.offering.evidenceUrl : row.source.offering.bookingUrl;
    const safe = getSafeCustomerBookingUrl(url);
    if (!safe) throw new Error("The selected owned public simulator source is unavailable.");
    return { url: safe, sourceFingerprint: row.source.fingerprint, family: new URL(safe).hostname };
  });
  if (!before.acquired) return { acquired: false as const };
  const read = await runWithProviderRequestLease(before.value.family, async () => {
    const response = await fetchImpl(before.value.url, { method: "GET", credentials: "omit", headers: { Accept: "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(10_000) });
    const effectiveUrl = getSafeCustomerBookingUrl(response.url || before.value.url);
    if (!effectiveUrl) throw new Error("The simulator public landing URL is unsafe.");
    return { source: input.source, requestedUrl: before.value.url, url: effectiveUrl, observedAt: new Date().toISOString(), httpStatus: response.status,
      ...(response.ok ? summarizeSimulatorSupportPublicHtml(await response.text(), effectiveUrl) : { text: "", links: [] }) };
  });
  if (!read.acquired) return { acquired: false as const };
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    if (row.source.fingerprint !== before.value.sourceFingerprint) throw new Error("Simulator source changed during the public read.");
    const saved = await saveClaim(tx, row, now);
    await tx.automationRun.update({ where: { id: row.runId }, data: { audit: { ...row.audit, simulatorClaim: { ...row.claim, revision: saved.revision, leaseExpiresAt: saved.leaseExpiresAt }, simulatorResearch: {
      source: read.value.source, requestedUrl: read.value.requestedUrl, sourceUrl: read.value.url, observedAt: read.value.observedAt, httpStatus: read.value.httpStatus, sourceFingerprint: before.value.sourceFingerprint,
    } } as unknown as Prisma.InputJsonValue } });
    return { ...saved, publicSource: read.value };
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
    const source = await lockSource(tx, row.audit, now);
    if (source.incident.updatedAt.toISOString() !== row.audit.target.updatedAt || (source.incident.retryAt && source.incident.retryAt > now)) throw new Error("Simulator incident changed or is not due.");
    const latest = await tx.courseProbe.findFirst({ where: { offeringId: source.offering.id, teeSearchId: { in: row.audit.target.searchRefs.map(ref => ref.id) } }, orderBy: [{ observedAt: "desc" }, { id: "desc" }] });
    const summary = latest?.rawSummary as Record<string, unknown> | null;
    if (!latest || !["NEEDS_ADAPTER", "FETCH_FAILED"].includes(latest.outcome) || summary?.mode !== "SIMULATOR" || summary.sourceFingerprint !== source.fingerprint) throw new Error("Simulator claim requires a current offering-scoped failure probe.");
    const dispatch = await import("./course-support-course-dispatch");
    const live = await dispatch.listLiveCourseSupportDispatchReservations(tx);
    const batches = await tx.courseSupportBatch.findMany({ where: { status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] } }, select: { id: true, incidents: { select: { courseId: true } } }, take: 16 });
    const occupied = new Set([...live.map(entry => entry.audit.target.courseId), ...batches.flatMap(batch => batch.incidents.length ? batch.incidents.map(entry => entry.courseId) : [batch.id])]);
    if (batches.length + live.length > MAX_CONCURRENT_COURSE_SUPPORT_BATCHES || occupied.size > MAX_CONCURRENT_COURSE_SUPPORT_BATCHES || live.some(entry => entry.runId !== row.runId && entry.audit.target.offeringId === source.offering.id)) throw new Error("Simulator support shared capacity or offering ownership changed.");
    const claim: SimulatorSupportClaim = { token: randomUUID(), revision: 1, phase: "CLAIMED", claimedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + SIMULATOR_SUPPORT_LEASE_MS).toISOString(), sourceFingerprint: source.fingerprint, originalSourceFingerprint: source.fingerprint,
      offeringRevision: source.offering.monitoringRevision, plannedPaths: [], releaseSha: null, branch: input.branch, deployment: null, recheckQueuedAt: null, verificationCycle: 0 };
    await tx.automationRun.update({ where: { id: row.runId }, data: { audit: { ...row.audit, state: "CONSUMED", consumedAt: now.toISOString(), simulatorClaim: claim } as unknown as Prisma.InputJsonValue, outcome: "simulator_claimed" } });
    return { assignmentRef: input.assignmentRef, token: claim.token, revision: claim.revision, phase: claim.phase, leaseExpiresAt: claim.leaseExpiresAt,
      offeringId: source.offering.id, courseId: source.offering.courseId, engineeringOnly: row.audit.target.trafficClass === "SYNTHETIC", sourceFingerprint: source.fingerprint,
      venue: source.offering.course, evidenceUrl: source.offering.evidenceUrl, bookingUrl: source.offering.bookingUrl,
      providerFamilyKey: source.offering.providerFamilyKey, providerMetadata: source.offering.providerMetadata, supportedDurationsMinutes: source.offering.supportedDurationsMinutes };
  });
}

export function heartbeatSimulatorSupport(input: Owner) {
  return withTransition(async (tx, now) => saveClaim(tx, await loadOwned(tx, input, now), now));
}

export function recoverSimulatorSupport(input: Owner) {
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now, true, true);
    if (new Date(row.claim.leaseExpiresAt) > now) throw new Error("Recover is reserved for the same native owner after its lease expires.");
    const dispatch = await import("./course-support-course-dispatch");
    if (row.claim.plannedPaths.length && await dispatch.hasSimulatorSupportImplementationOwnership(tx, input.assignmentRef)) throw new Error("Simulator implementation ownership conflicts during recovery.");
    return saveClaim(tx, row, now);
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
    return saveClaim(tx, row, now, { sourceFingerprint: row.source.fingerprint, offeringRevision: row.source.offering.monitoringRevision,
      ...(row.source.fingerprint !== row.claim.sourceFingerprint ? { deployment: null, recheckQueuedAt: null, verificationCycle: 0 } : {}) });
  });
}

export function registerSimulatorSupportRelease(input: Owner & { releaseSha: string; branch: string; committedPaths: string[]; descendantVerified: boolean }) {
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    if (!/^[a-f0-9]{40}$/i.test(input.releaseSha) || input.branch !== row.claim.branch || !input.descendantVerified ||
        (row.claim.releaseSha && row.claim.releaseSha !== input.releaseSha) ||
        input.committedPaths.some(path => !row.claim.plannedPaths.includes(validateSimulatorSupportPath(path))) ||
        (row.claim.plannedPaths.length > 0 && !input.committedPaths.some(path => /^(src\/|scripts\/|prisma\/)/.test(path))) ||
        (row.claim.plannedPaths.length === 0 && input.releaseSha !== row.audit.baseSha)) throw new Error("Simulator support release provenance is invalid.");
    return saveClaim(tx, row, now, { phase: "VERIFYING", releaseSha: input.releaseSha });
  });
}

export function recordSimulatorSupportDeployment(input: Owner & { proof: GitDeploymentProof }) {
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    if (!row.claim.releaseSha) throw new Error("Register the owner release before verifying deployment.");
    assertSimulatorSupportDeployment(input.proof, row.claim.releaseSha, now);
    return saveClaim(tx, row, now, { deployment: input.proof });
  });
}

async function isSimulatorProbeCheckFinished(tx: Prisma.TransactionClient, probe: {
  teeSearchId: string; observedAt: Date; automationRun: { kind: string; status: string; outcome: string | null; errors: unknown; completedAt: Date | null } | null;
}, now: Date) {
  const run = probe.automationRun;
  // A different selected venue may make the aggregate outcome failed. The
  // successful exact offering probe is independent, but a fatal core failure
  // or an unfinished scheduler cannot prove monitoring was restored.
  if (!run || run.kind !== "SEARCH_CHECK" || run.status !== "COMPLETED" || !["success", "failed"].includes(run.outcome ?? "") || run.errors !== null ||
      !run.completedAt || run.completedAt < probe.observedAt || run.completedAt > now) return false;
  const search = await tx.teeSearch.findUnique({ where: { id: probe.teeSearchId }, select: {
    status: true, checkStatus: true, checkLeaseToken: true, checkLeaseExpiresAt: true, lastCheckedAt: true, nextCheckAt: true,
  } });
  return Boolean(search?.status === "ACTIVE" && search.checkStatus === "WAITING" && !search.checkLeaseToken && !search.checkLeaseExpiresAt &&
    search.lastCheckedAt && search.lastCheckedAt >= run.completedAt && search.nextCheckAt && search.nextCheckAt >= search.lastCheckedAt);
}

export function queueSimulatorSupportRechecks(input: Owner) {
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    if (!row.claim.deployment || !row.claim.releaseSha) throw new Error("Simulator rechecks require a verified exact production deployment.");
    assertSimulatorSupportDeployment(row.claim.deployment, row.claim.releaseSha, now);
    let cycle = row.claim.verificationCycle;
    if (cycle === 1) {
      const latest = await tx.courseProbe.findFirst({ where: { offeringId: row.source.offering.id }, include: { automationRun: true }, orderBy: [{ observedAt: "desc" }, { id: "desc" }] });
      const summary = latest?.rawSummary as Record<string, unknown> | null;
      const providerTime = typeof summary?.providerObservedAt === "string" ? new Date(summary.providerObservedAt) : null;
      if (!latest || !["MATCH_FOUND", "NO_MATCH"].includes(latest.outcome) || latest.runtimeVersion !== row.claim.releaseSha ||
          summary?.mode !== "SIMULATOR" || summary.sourceFingerprint !== row.source.fingerprint || !providerTime || !Number.isFinite(providerTime.getTime()) ||
          providerTime < new Date(Math.max(Date.parse(row.claim.recheckQueuedAt!), Date.parse(row.claim.deployment.deployedAt), Date.parse(row.claim.claimedAt))) || providerTime > now ||
          providerTime.getTime() < now.getTime() - 30 * 60_000 || latest.observedAt > now || latest.observedAt.getTime() < now.getTime() - 30 * 60_000 ||
          !row.source.searches.some(search => search.id === latest.teeSearchId) || !(await isSimulatorProbeCheckFinished(tx, latest, now))) throw new Error("The second simulator verification check requires the first fresh successful observation and finished scheduled check.");
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
    const after = new Date(Math.max(Date.parse(row.claim.recheckQueuedAt), Date.parse(row.claim.deployment.deployedAt), Date.parse(row.claim.claimedAt)));
    const probes = await tx.courseProbe.findMany({ where: { offeringId: row.source.offering.id, observedAt: { gte: after } }, include: { automationRun: true }, orderBy: [{ observedAt: "desc" }, { id: "desc" }], take: 16 });
    const pair: typeof probes = [];
    const successfulRuns = new Set<string>();
    for (const probe of probes) {
      const summary = probe.rawSummary as Record<string, unknown> | null;
      const providerTime = typeof summary?.providerObservedAt === "string" ? new Date(summary.providerObservedAt) : null;
      const valid = probe.runtimeVersion === row.claim.releaseSha && ["MATCH_FOUND", "NO_MATCH"].includes(probe.outcome) &&
        summary?.mode === "SIMULATOR" && summary.sourceFingerprint === row.source.fingerprint && providerTime && providerTime >= after && providerTime <= now &&
        providerTime.getTime() >= now.getTime() - 30 * 60_000 && probe.observedAt <= now &&
        probe.observedAt.getTime() >= now.getTime() - 30 * 60_000 && probe.automationRunId &&
        row.source.searches.some(search => search.id === probe.teeSearchId) && await isSimulatorProbeCheckFinished(tx, probe, now);
      // Every newer observation must agree. A failure between two successes
      // starts a new verification streak rather than being filtered away.
      if (!valid) break;
      if (!successfulRuns.has(probe.automationRunId!)) { successfulRuns.add(probe.automationRunId!); pair.push(probe); }
      if (pair.length === 2) break;
    }
    if (pair.length !== 2) throw new Error("Simulator support needs two distinct fresh successful checks on the exact current release; newer failures cannot be ignored.");
    await tx.simulatorSupportIncident.update({ where: { id: row.source.incident.id }, data: { status: "RESOLVED", resolvedAt: now, retryAt: null } });
    await tx.automationRun.update({ where: { id: row.runId }, data: { status: "COMPLETED", completedAt: now, outcome: "simulator_monitoring_restored", audit: {
      ...row.audit, simulatorVerification: { runtimeVersion: row.claim.releaseSha, sourceFingerprint: row.source.fingerprint, verifiedAt: now.toISOString(), probeIds: pair.map(probe => probe.id) },
    } as unknown as Prisma.InputJsonValue } });
    return { outcome: "success" as const, durableCloseoutRecorded: true, engineeringOnly: row.audit.target.trafficClass === "SYNTHETIC" };
  });
}

export function retrySimulatorSupport(input: Owner & { retryMinutes: number }) {
  if (!Number.isSafeInteger(input.retryMinutes) || input.retryMinutes < 1 || input.retryMinutes > 1440) throw new Error("Simulator retry must be from 1 to 1440 minutes.");
  return withTransition(async (tx, now) => {
    const row = await loadOwned(tx, input, now);
    const retryAt = new Date(now.getTime() + input.retryMinutes * 60_000);
    await tx.simulatorSupportIncident.update({ where: { id: row.source.incident.id }, data: { status: "AUTO_INVESTIGATING", retryAt } });
    await tx.automationRun.update({ where: { id: row.runId }, data: { status: "COMPLETED", completedAt: now, outcome: "simulator_retryable_failed" } });
    return { outcome: "retryable_failed" as const, retryAt: retryAt.toISOString(), durableCloseoutRecorded: true };
  });
}

export async function readSimulatorSupportClaim(input: { assignmentRef: string; ownerThreadId: string }) {
  const row = await loadAssignment(prisma, input.assignmentRef);
  if (row.audit.childThreadId !== input.ownerThreadId || row.audit.state !== "CONSUMED" || !row.audit.simulatorClaim) throw new Error("Simulator support claim is not owned by this native task.");
  const offering = await prisma.courseOffering.findUniqueOrThrow({ where: { id: row.audit.target.offeringId }, include: { course: { select: { name: true, address: true, website: true, timeZone: true } } } });
  return { ...row.audit.simulatorClaim, baseSha: row.audit.baseSha, offeringId: row.audit.target.offeringId!,
    venue: offering.course, evidenceUrl: offering.evidenceUrl, bookingUrl: offering.bookingUrl, providerFamilyKey: offering.providerFamilyKey, providerMetadata: offering.providerMetadata, supportedDurationsMinutes: offering.supportedDurationsMinutes };
}
