import { createHash, randomUUID } from "node:crypto";
import { Prisma, type CourseOffering } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isSimulatorModeEnabled } from "@/lib/simulators/config";
import { getSimulatorBookingOpening } from "@/lib/simulators/booking-window";
import { isCurrentSimulatorMatch } from "@/lib/simulators/current-availability";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { fetchSimulatorAvailability } from "@/lib/simulators/providers";
import { filterSimulatorSessionsForSearch } from "@/lib/tee-times/matching";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { getAutomationRuntimeVersion } from "@/lib/automation/runtime-version";
import { isSearchCheckLeaseCurrent, type ActiveAutomationSearch, type SearchCheckLease } from "@/lib/automation/db-service";
import type { SearchCheckResult } from "@/lib/automation/search-check";
import {
  prepareRecipientMatchDeliveryGroups, drainSearchEmailDeliveryGroup, finalizeSearchEmailDeliveryGroup,
  hydrateMatchAlertPayload, toSearchEmailJson, listRetryableSearchEmailDeliveryGroups, prepareSearchEmailDeliveryGroup, hydrateSimulatorStatusPayload,
} from "@/lib/email/search-delivery-outbox";
import { sendTeeTimeAlert, sendSimulatorStatusEmail } from "@/lib/email/alerts";
import type { SimulatorAvailabilitySlot } from "@/lib/simulators/providers/types";

const OBSERVATION_LEASE_MS = 2 * 60_000;
class SimulatorObservationSupersededError extends Error {}

async function lockCurrentSearch(transaction: Prisma.TransactionClient, search: ActiveAutomationSearch, lease: SearchCheckLease) {
  await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "TeeSearch" WHERE "id" = ${search.id} FOR UPDATE`);
  const current = await transaction.teeSearch.findUnique({ where: { id: search.id } });
  if (!current || current.mode !== "SIMULATOR" || current.status !== "ACTIVE" ||
    current.scheduleVersion !== lease.scheduleVersion || current.alertGeneration !== search.alertGeneration ||
    current.checkLeaseToken !== lease.token || !current.checkLeaseExpiresAt || current.checkLeaseExpiresAt <= new Date()) throw new Error("Simulator search lease is no longer current");
  return current;
}

async function beginObservation(offeringId: string, search: ActiveAutomationSearch, lease: SearchCheckLease) {
  const token = randomUUID();
  return prisma.$transaction(async transaction => {
    await lockCurrentSearch(transaction, search, lease);
    const claimed = await transaction.courseOffering.updateMany({
      where: { id: offeringId, kind: "SIMULATOR", active: true, publicAccessStatus: "PUBLIC",
        OR: [{ observationToken: null }, { observationExpiresAt: { lt: new Date() } }] },
      data: { observationToken: token, observationExpiresAt: new Date(Date.now() + OBSERVATION_LEASE_MS), monitoringState: "VERIFYING", monitoringRevision: { increment: 1 } }
    });
    if (claimed.count !== 1) return null;
    const offering = await transaction.courseOffering.findUniqueOrThrow({ where: { id: offeringId } });
    return { offering, token };
  });
}

async function commitObservation(input: {
  search: ActiveAutomationSearch; lease: SearchCheckLease; offering: CourseOffering; token: string;
  runId: string; outcome: "MATCH_FOUND" | "NO_MATCH" | "FETCH_FAILED" | "NEEDS_ADAPTER";
  slots: SimulatorAvailabilitySlot[]; observedAt: Date; evidenceUrl: string;
}) {
  return prisma.$transaction(async transaction => {
    await lockCurrentSearch(transaction, input.search, input.lease);
    await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "CourseOffering" WHERE "id" = ${input.offering.id} FOR UPDATE`);
    const offering = await transaction.courseOffering.findUniqueOrThrow({ where: { id: input.offering.id } });
    if (offering.observationToken !== input.token || !offering.observationExpiresAt || offering.observationExpiresAt <= new Date() ||
      offering.monitoringRevision !== input.offering.monitoringRevision || !offering.active || offering.publicAccessStatus !== "PUBLIC" ||
      offering.bookingUrl !== input.offering.bookingUrl || offering.providerFamilyKey !== input.offering.providerFamilyKey ||
      JSON.stringify(offering.providerMetadata) !== JSON.stringify(input.offering.providerMetadata)) throw new SimulatorObservationSupersededError("Simulator provider observation was superseded");
    if (!Number.isFinite(input.observedAt.getTime()) || input.observedAt > new Date()) throw new Error("Simulator observation time is invalid");
    const success = input.outcome === "MATCH_FOUND" || input.outcome === "NO_MATCH";
    const retained: string[] = [];
    if (success) {
      for (const slot of input.slots) {
        const sourceId = `sim:${createHash("sha256").update([offering.id, slot.resourceId, slot.productId, slot.sourceId, slot.startsAt.toISOString(), slot.endsAt.toISOString()].join("|")).digest("hex")}`;
        const where = { teeSearchId_courseId_sourceId_startsAt: { teeSearchId: input.search.id, courseId: offering.courseId, sourceId, startsAt: slot.startsAt } };
        const previous = await transaction.teeTimeMatch.findUnique({ where });
        const data = { offeringId: offering.id, offeringSourceFingerprint: getSimulatorOfferingSourceFingerprint(offering), endsAt: slot.endsAt, resourceId: slot.resourceId, productId: slot.productId,
          capacity: slot.maxPartySize, availableSpots: 1, bookingUrl: slot.bookingUrl, evidenceUrl: input.evidenceUrl,
          lastSeenAt: input.observedAt, lastConfirmedAt: input.observedAt, availabilityStatus: "AVAILABLE" as const, unavailableAt: null };
        const match = await transaction.teeTimeMatch.upsert({ where,
          create: { ...where.teeSearchId_courseId_sourceId_startsAt, ...data },
          update: { ...data, ...(previous?.availabilityStatus === "GONE" ? { availabilityCycle: { increment: 1 }, alertStatus: "PENDING", sentAt: null } : {}) }
        });
        retained.push(match.id);
      }
      await transaction.teeTimeMatch.updateMany({
        where: { teeSearchId: input.search.id, offeringId: offering.id, availabilityStatus: "AVAILABLE", ...(retained.length ? { id: { notIn: retained } } : {}) },
        data: { availabilityStatus: "GONE", unavailableAt: input.observedAt }
      });
      await transaction.teeTimeMatch.updateMany({ where: { teeSearchId: input.search.id, offeringId: offering.id, availabilityStatus: "GONE", alertStatus: "PENDING" }, data: { alertStatus: "SUPPRESSED" } });
    }
    await transaction.courseProbe.create({ data: { teeSearchId: input.search.id, courseId: offering.courseId, offeringId: offering.id,
      automationRunId: input.runId, outcome: input.outcome, observedAt: input.observedAt,
      runtimeVersion: getAutomationRuntimeVersion(), rawSummary: { mode: "SIMULATOR", sourceFingerprint: getSimulatorOfferingSourceFingerprint(offering), durationMinutes: input.search.durationMinutes, matchingSessions: retained.length,
        providerObservedAt: input.observedAt.toISOString(), evidenceUrl: input.evidenceUrl } } });
    await transaction.courseOffering.update({ where: { id: offering.id }, data: {
      monitoringState: success ? "HEALTHY" : "DEGRADED_RETRYING", observationToken: null, observationExpiresAt: null,
      ...(success ? { automationEligibility: "ALLOWED", monitoringVerifiedAt: input.observedAt } : { lastFailureAt: input.observedAt }),
      monitoringRevision: { increment: 1 }
    } });
    if (success) await transaction.simulatorSupportIncident.updateMany({ where: { offeringId: offering.id, status: { not: "RESOLVED" } }, data: { status: "RESOLVED", resolvedAt: input.observedAt, retryAt: null } });
    else await transaction.simulatorSupportIncident.upsert({ where: { offeringId: offering.id }, create: { offeringId: offering.id, reason: input.outcome, evidenceUrl: input.evidenceUrl, retryAt: new Date(input.observedAt.getTime() + 15 * 60_000) }, update: { status: "AUTO_INVESTIGATING", reason: input.outcome, resolvedAt: null, retryAt: new Date(input.observedAt.getTime() + 15 * 60_000) } });
    return retained.length;
  });
}

export async function runSimulatorSearchCheck(search: ActiveAutomationSearch, runId: string, lease: SearchCheckLease): Promise<SearchCheckResult> {
  if (!isSimulatorModeEnabled()) throw new Error("Simulator checks are temporarily disabled");
  if (search.mode !== "SIMULATOR" || !search.durationMinutes) throw new Error("Invalid simulator search intent");
  const date = search.date.toISOString().slice(0, 10);
  const courseResults: SearchCheckResult["courseResults"] = [];
  let availableMatches = 0;
  let retryNeeded = false;
  for (const preference of search.preferences) {
    if (!(await isSearchCheckLeaseCurrent(lease))) throw new Error("Simulator search lease was lost");
    const offering = preference.offering;
    if (!offering || offering.kind !== "SIMULATOR" || !offering.active || offering.publicAccessStatus !== "PUBLIC" || !offering.bookingUrl ||
      !offering.verifiedAt || !offering.evidenceUrl ||
      !offering.supportedDurationsMinutes.includes(search.durationMinutes)) {
      retryNeeded = true;
      courseResults.push({ courseId: preference.courseId, courseName: preference.course.name, rank: preference.rank,
        outcome: "FETCH_FAILED", availableMatches: 0, bookingUrl: offering?.bookingUrl ?? undefined });
      continue;
    }
    const opening = getSimulatorBookingOpening(date, offering, preference.course.timeZone);
    if (opening && opening > new Date()) {
      await prisma.$transaction(async transaction => {
        await lockCurrentSearch(transaction, search, lease);
        await transaction.courseProbe.create({ data: { teeSearchId: search.id, courseId: preference.courseId, offeringId: offering.id,
          automationRunId: runId, outcome: "NO_MATCH", runtimeVersion: getAutomationRuntimeVersion(), rawSummary: { mode: "SIMULATOR", bookingNotOpen: true, opensAt: opening.toISOString() } } });
      });
      courseResults.push({ courseId: preference.courseId, courseName: preference.course.name, rank: preference.rank, outcome: "CHECK_PENDING", availableMatches: 0, bookingUrl: offering.bookingUrl });
      continue;
    }
    const claimed = await beginObservation(offering.id, search, lease);
    if (!claimed) {
      retryNeeded = true;
      courseResults.push({ courseId: preference.courseId, courseName: preference.course.name, rank: preference.rank,
        outcome: "CHECK_PENDING", availableMatches: 0, bookingUrl: offering.bookingUrl });
      continue;
    }
    try {
      if (!claimed.offering.bookingUrl || !claimed.offering.verifiedAt || !claimed.offering.evidenceUrl ||
        !claimed.offering.supportedDurationsMinutes.includes(search.durationMinutes)) throw new Error("Simulator rental details changed");
      // The shared lease normalizer accepts known families or real hostnames;
      // synthetic mode prefixes would collapse every simulator into UNKNOWN.
      const read = await runWithProviderRequestLease(new URL(claimed.offering.bookingUrl).hostname, () => fetchSimulatorAvailability({
        offering: { ...claimed.offering, bookingUrl: claimed.offering.bookingUrl! }, date, durationMinutes: search.durationMinutes!, partySize: 1, timeZone: preference.course.timeZone
      }));
      if (!read.acquired) throw new Error("Simulator provider is busy");
      const result = read.value;
      if (!result.complete) throw new Error("Simulator calendar is incomplete");
      const sessions = result.slots.map(slot => ({ ...slot, startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), capacity: slot.maxPartySize }));
      const matching = filterSimulatorSessionsForSearch({ date, startTime: search.startTime, endTime: search.endTime, players: search.players,
        durationMinutes: search.durationMinutes, preferredOfferings: [{ offeringId: offering.id, rank: preference.rank }] }, sessions, preference.course.timeZone);
      const matchingIds = new Set(matching.map(slot => slot.sourceId));
      const slots = result.slots.filter(slot => matchingIds.has(slot.sourceId) && slot.startsAt > new Date());
      const count = await commitObservation({ search, lease, offering: claimed.offering, token: claimed.token, runId,
        outcome: slots.length ? "MATCH_FOUND" : "NO_MATCH", slots, observedAt: result.observedAt, evidenceUrl: result.evidenceUrl });
      availableMatches += count;
      courseResults.push({ courseId: preference.courseId, courseName: preference.course.name, rank: preference.rank, outcome: count ? "MATCH_FOUND" : "NO_MATCH", availableMatches: count, bookingUrl: offering.bookingUrl });
    } catch (error) {
      retryNeeded = true;
      if (error instanceof SimulatorObservationSupersededError) {
        if (!(await isSearchCheckLeaseCurrent(lease))) throw error;
        courseResults.push({ courseId: preference.courseId, courseName: preference.course.name, rank: preference.rank,
          outcome: "CHECK_PENDING", availableMatches: 0, bookingUrl: claimed.offering.bookingUrl ?? undefined });
        continue;
      }
      try {
        await commitObservation({ search, lease, offering: claimed.offering, token: claimed.token, runId, outcome: "FETCH_FAILED", slots: [], observedAt: new Date(), evidenceUrl: claimed.offering.evidenceUrl ?? offering.evidenceUrl });
      } catch (failure) {
        if (!(failure instanceof SimulatorObservationSupersededError) || !(await isSearchCheckLeaseCurrent(lease))) throw failure;
        courseResults.push({ courseId: preference.courseId, courseName: preference.course.name, rank: preference.rank,
          outcome: "CHECK_PENDING", availableMatches: 0, bookingUrl: claimed.offering.bookingUrl ?? undefined });
        continue;
      }
      courseResults.push({ courseId: preference.courseId, courseName: preference.course.name, rank: preference.rank, outcome: "FETCH_FAILED", availableMatches: 0, bookingUrl: offering.bookingUrl });
    }
  }
  const alerted = await deliverSimulatorMatches(search, lease);
  if (!availableMatches && !search.statusEmailSentAt) await deliverSimulatorSetup(search, lease, courseResults);
  await retrySimulatorStatusDeliveries(search, lease);
  return { searchId: search.id, outcome: retryNeeded ? "failed" : "success", courseResults, availableMatches, newlyAlertedMatches: alerted,
    supportRetryNeeded: retryNeeded, supportRetryAt: retryNeeded ? new Date(Date.now() + 15 * 60_000) : null };
}

async function deliverSimulatorMatches(search: ActiveAutomationSearch, lease: SearchCheckLease) {
  const candidates = await prisma.teeTimeMatch.findMany({ where: { teeSearchId: search.id, offeringId: { not: null }, availabilityStatus: "AVAILABLE", alertStatus: "PENDING", startsAt: { gt: new Date() } }, include: { offering: true, course: true }, orderBy: { startsAt: "asc" } });
  const matches = candidates.filter(match => isCurrentSimulatorMatch(match, new Date()) &&
    match.endsAt && (match.endsAt.getTime() - match.startsAt.getTime()) === search.durationMinutes! * 60_000 &&
    search.preferences.some(preference => preference.offeringId === match.offeringId));
  const recipients = [search.user.email, ...search.additionalEmails];
  if (matches.length) {
    const checkedAt = new Date();
    const refs = matches.map(match => ({ matchId: match.id, availabilityCycle: match.availabilityCycle }));
    await prepareRecipientMatchDeliveryGroups({ searchId: search.id, alertGeneration: search.alertGeneration, checkLeaseToken: lease.token,
      ownerRecipient: search.user.email, recipients, sourceGroupKey: `simulator:${createHash("sha256").update(JSON.stringify(refs)).digest("hex")}`,
      payload: { schemaVersion: 3, mode: "SIMULATOR", checkedAt: checkedAt.toISOString(), matchIds: matches.map(match => match.id), matchRefs: refs, displayMatchIds: matches.map(match => match.id),
        matchReport: toSearchEmailJson({ mode: "SIMULATOR", durationMinutes: search.durationMinutes, targetDate: search.date.toISOString().slice(0, 10), startTime: search.startTime, endTime: search.endTime,
          players: search.players, userTimeZone: search.userTimeZone, matches: matches.map(match => ({ matchId: match.id, availabilityCycle: match.availabilityCycle,
            mode: "SIMULATOR", offeringId: match.offeringId, courseId: match.courseId, courseName: match.course.name, courseAddress: match.course.address,
            courseRank: search.preferences.find(preference => preference.offeringId === match.offeringId)?.rank, courseTimeZone: match.course.timeZone,
            startsAt: match.startsAt.toISOString(), endsAt: match.endsAt?.toISOString(), availableSpots: 1,
            bookingUrl: match.bookingUrl, resourceId: match.resourceId, productId: match.productId, isNew: true })) }) }
    });
  }
  const groups = await listRetryableSearchEmailDeliveryGroups({ searchId: search.id, alertGeneration: search.alertGeneration });
  let sent = 0;
  for (const group of groups.filter(group => group.kind === "MATCH")) {
    await drainSearchEmailDeliveryGroup({ searchId: search.id, alertGeneration: search.alertGeneration, checkLeaseToken: lease.token, kind: "MATCH", groupKey: group.groupKey,
      send: async ({ recipient, idempotencyKey, payload, assertCurrentDelivery }) => {
        const report = await hydrateMatchAlertPayload({ searchId: search.id, alertGeneration: search.alertGeneration, payload });
        await assertCurrentDelivery();
        return sendTeeTimeAlert({ ...report, searchId: search.id, to: recipient, stableIdempotencyKey: idempotencyKey });
      }
    });
    const final = await finalizeSearchEmailDeliveryGroup({ searchId: search.id, alertGeneration: search.alertGeneration, kind: "MATCH", groupKey: group.groupKey });
    if (final.ownerSent) sent += final.retainedMatchCount;
  }
  return sent;
}

async function deliverSimulatorSetup(search: ActiveAutomationSearch, lease: SearchCheckLease, results: SearchCheckResult["courseResults"]) {
  const groupKey = `simulator:setup:${search.alertGeneration}`;
  const report = { mode: "SIMULATOR", kind: "setup", targetDate: search.date.toISOString().slice(0, 10),
    startTime: search.startTime, endTime: search.endTime, durationMinutes: search.durationMinutes, players: search.players,
    userTimeZone: search.userTimeZone, venues: search.preferences.map(preference => {
      const result = results.find(result => result.courseId === preference.courseId);
      const offering = preference.offering;
      const opening = offering ? getSimulatorBookingOpening(search.date.toISOString().slice(0, 10), offering, preference.course.timeZone) : null;
      return { offeringId: preference.offeringId, courseId: preference.courseId, courseName: preference.course.name,
        courseRank: preference.rank, courseAddress: preference.course.address, bookingUrl: offering?.bookingUrl,
        availability: opening && opening > new Date() ? "BOOKING_NOT_OPEN" : result?.outcome === "MATCH_FOUND" ? "MATCH_FOUND" : result?.outcome === "NO_MATCH" ? "NO_MATCH" : result?.outcome === "FETCH_FAILED" ? "UNAVAILABLE" : "CHECK_PENDING" };
    }) };
  const prepared = await prepareSearchEmailDeliveryGroup({ searchId: search.id, alertGeneration: search.alertGeneration, checkLeaseToken: lease.token,
    kind: "SETUP", groupKey, ownerRecipient: search.user.email, recipients: [search.user.email, ...search.additionalEmails],
    payload: { schemaVersion: 3, mode: "SIMULATOR", checkedAt: new Date().toISOString(), statusReport: toSearchEmailJson(report), statusSnapshot: toSearchEmailJson(report) } });
  if (!prepared.prepared) return;
}

async function retrySimulatorStatusDeliveries(search: ActiveAutomationSearch, lease: SearchCheckLease) {
  const groups = await listRetryableSearchEmailDeliveryGroups({ searchId: search.id, alertGeneration: search.alertGeneration });
  for (const group of groups.filter(group => group.kind === "SETUP")) {
  await drainSearchEmailDeliveryGroup({ searchId: search.id, alertGeneration: search.alertGeneration, checkLeaseToken: lease.token, kind: "SETUP", groupKey: group.groupKey,
    send: async ({ recipient, idempotencyKey, payload, assertCurrentDelivery }) => {
      const status = hydrateSimulatorStatusPayload(payload);
      await assertCurrentDelivery();
      return sendSimulatorStatusEmail({ ...status, to: recipient, searchId: search.id, stableIdempotencyKey: idempotencyKey });
    } });
  await finalizeSearchEmailDeliveryGroup({ searchId: search.id, alertGeneration: search.alertGeneration, kind: "SETUP", groupKey: group.groupKey });
  }
}
