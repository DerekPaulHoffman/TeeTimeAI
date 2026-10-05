import { readAlertGenerationStartedAt } from "@/lib/searches/generation-clock";
import {
  getCourseLayoutCompatibility,
  normalizeRequestedLayoutHoles,
} from "@/lib/courses/course-layout";
import { getProviderExecutionEvidenceObservedAt } from "@/lib/automation/provider-execution-marker";
import { getSimulatorBookingOpening } from "@/lib/simulators/booking-window";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";

export function isEligibleOperatorNotificationSearch(
  search: {
    trafficClass: string;
    syntheticMultiCycle: boolean;
    syntheticTestWindow?: unknown;
    user: { email: string };
    alertEmail?: string | null;
  },
  excludedEmails: string[],
) {
  const email = search.user.email.trim().toLowerCase();
  const mailbox = (address: string) =>
    address
      .trim()
      .toLowerCase()
      .replace(/\+[^@]*(?=@)/, "");
  return (
    !["TEST", "AUTOMATION"].includes(search.trafficClass) &&
    !search.syntheticMultiCycle &&
    !search.syntheticTestWindow &&
    !excludedEmails.some((excluded) => mailbox(excluded) === mailbox(email)) &&
    ![email, search.alertEmail ?? ""].some((address) => {
      const [local, domain = ""] = address.toLowerCase().split("@");
      return (
        local.includes("+tts-stress-") ||
        /^(example\.(com|net|org)|test|invalid)$/.test(domain) ||
        /\.(test|invalid|local)$/.test(domain)
      );
    })
  );
}

function clean(value: string, max: number) {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function buildOperatorNotificationSummary(search: {
  user: { email: string };
  date: Date;
  startTime: string;
  endTime: string;
  players: number;
  mode?: "OUTDOOR" | "SIMULATOR";
  durationMinutes?: number | null;
  preferences: Array<{ rank: number; course: { name: string } }>;
}) {
  const courses = [...search.preferences]
    .sort((a, b) => a.rank - b.rank)
    .map((p) => clean(p.course.name, 65))
    .join(", ");
  const session = search.mode === "SIMULATOR" ? ` | simulator ${search.durationMinutes ?? "unverified"} minutes` : "";
  return `${clean(search.user.email, 254)} | ${search.date.toISOString().slice(0, 10)} ${search.startTime}-${search.endTime} (course local) | ${search.players} players${session} | ${courses}`;
}

export type OperatorNotificationHealthSearch = {
  id?: string;
  mode?: "OUTDOOR" | "SIMULATOR";
  date?: Date;
  durationMinutes?: number | null;
  players?: number;
  status: string;
  checkStatus: string;
  createdAt: Date;
  lastCheckedAt: Date | null;
  nextCheckAt: Date | null;
  checkLeaseExpiresAt: Date | null;
  alertGeneration: number;
  statusEmailSnapshot: unknown;
  requestedLayoutHoles?: number | null;
  preferences: Array<{
    courseId: string;
    offeringId?: string | null;
    offering?: {
      id: string;
      courseId: string;
      kind: string;
      active: boolean;
      publicAccessStatus: string;
      bookingUrl: string | null;
      verifiedAt: Date | null;
      evidenceUrl: string | null;
      maxPartySize: number | null;
      supportedDurationsMinutes: number[];
      providerFamilyKey: string | null;
      providerMetadata: unknown;
      monitoringMode: string;
      automationEligibility: string;
      monitoringState: string;
      monitoringVerifiedAt: Date | null;
      observationToken: string | null;
      lastFailureAt: Date | null;
      bookingWindowDaysAhead: number | null;
      bookingReleaseTimeLocal: string | null;
    } | null;
    course: {
      name: string;
      timeZone?: string;
      layoutHoleCounts?: number[];
      monitoringStatus?: { lastFailureAt: Date | null } | null;
    };
  }>;
  probes: Array<{
    courseId: string;
    offeringId?: string | null;
    teeSearchId?: string;
    outcome: string;
    observedAt: Date;
    rawSummary?: unknown;
  }>;
  emailDeliveries: Array<{
    status: string;
    attemptCount: number;
    nextAttemptAt: Date | null;
  }>;
};

export function assessOperatorNotificationHealth(
  search: OperatorNotificationHealthSearch | null,
  now: Date,
) {
  if (!search)
    return {
      attention: false,
      text: "Alert removed. No active alert to review.",
    };
  if (search.status !== "ACTIVE")
    return {
      attention: false,
      text: `Alert ${search.status.toLowerCase()}. No active alert to review.`,
    };
  const issues: string[] = [];
  const generationStartedAt = readAlertGenerationStartedAt(search);
  if (search.checkStatus === "FAILED") issues.push("search check failed");
  if (["IDLE", "STOPPED"].includes(search.checkStatus))
    issues.push("monitoring is not scheduled");
  if (
    search.checkStatus === "CHECKING" &&
    (!search.checkLeaseExpiresAt || search.checkLeaseExpiresAt <= now)
  )
    issues.push("check stalled");
  if (
    search.checkStatus === "WAITING" &&
    (!search.nextCheckAt ||
      search.nextCheckAt.getTime() < now.getTime() - 10 * 60_000)
  )
    issues.push("next check is missing or overdue");
  if (
    !generationStartedAt ||
    !search.lastCheckedAt ||
    search.lastCheckedAt < generationStartedAt
  )
    issues.push("current alert has no completed check yet");
  let healthyCourses = 0;
  for (const preference of search.preferences) {
    const probe = search.probes
      .filter(
        (p) =>
          p.courseId === preference.courseId &&
          (search.mode !== "SIMULATOR" || (p.offeringId === preference.offeringId && (!search.id || p.teeSearchId === search.id))) &&
          generationStartedAt &&
          p.observedAt >= generationStartedAt,
      )
      .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0];
    const name = clean(preference.course.name, 65);
    if (search.mode === "SIMULATOR") {
      if (isHealthySimulatorPreference(search, preference, probe, generationStartedAt, now)) healthyCourses++;
      else issues.push(`${name}: ${probe && !["NO_MATCH", "MATCH_FOUND"].includes(probe.outcome) ? probe.outcome.toLowerCase().replaceAll("_", " ") : "current simulator monitoring needs verification"}`);
      continue;
    }
    if (
      getCourseLayoutCompatibility(
        preference.course.layoutHoleCounts,
        normalizeRequestedLayoutHoles(search.requestedLayoutHoles),
      ) === "incompatible"
    ) {
      issues.push(`${name}: requested course layout unavailable`);
      continue;
    }
    const evidenceAt = probe
      ? getProviderExecutionEvidenceObservedAt({
          rawSummary: probe.rawSummary,
          probeObservedAt: probe.observedAt,
        })
      : null;
    const summary = probe?.rawSummary as {
      bookingWindow?: { evidenceUrl?: unknown; releaseDate?: unknown };
    } | null;
    const bookingWait =
      probe?.outcome === "NO_MATCH" &&
      typeof summary?.bookingWindow?.evidenceUrl === "string" &&
      /^https?:\/\//.test(summary.bookingWindow.evidenceUrl) &&
      typeof summary.bookingWindow.releaseDate === "string" &&
      Date.parse(summary.bookingWindow.releaseDate) > now.getTime();
    const failureAt = preference.course.monitoringStatus?.lastFailureAt;
    const currentEvidence =
      evidenceAt &&
      generationStartedAt &&
      evidenceAt >= generationStartedAt &&
      evidenceAt <= now;
    if (
      probe &&
      ["NO_MATCH", "MATCH_FOUND"].includes(probe.outcome) &&
      (currentEvidence || bookingWait) &&
      (!failureAt || failureAt <= (evidenceAt ?? probe.observedAt))
    )
      healthyCourses++;
    else
      issues.push(
        `${name}: ${probe && !["NO_MATCH", "MATCH_FOUND"].includes(probe.outcome) ? probe.outcome.toLowerCase().replaceAll("_", " ") : "current monitoring needs verification"}`,
      );
  }
  if (!search.preferences.length) issues.push(search.mode === "SIMULATOR" ? "no selected simulator venues" : "no selected courses");
  if (
    search.emailDeliveries.some(
      (delivery) =>
        delivery.status === "FAILED" ||
        delivery.attemptCount > 0 ||
        (delivery.nextAttemptAt && delivery.nextAttemptAt < now),
    )
  )
    issues.push("customer email delivery needs review");
  return issues.length
    ? { attention: true, text: `NEEDS ATTENTION: ${issues.join("; ")}.` }
    : {
        attention: false,
        text: `No action needed. ${healthyCourses}/${search.preferences.length} ${search.mode === "SIMULATOR" ? "simulator venues" : "courses"} checked or waiting for booking to open; no current email delivery issue.`,
      };
}

function isHealthySimulatorPreference(
  search: OperatorNotificationHealthSearch,
  preference: OperatorNotificationHealthSearch["preferences"][number],
  probe: OperatorNotificationHealthSearch["probes"][number] | undefined,
  generationStartedAt: Date | null,
  now: Date,
) {
  const offering = preference.offering;
  if (!offering || offering.id !== preference.offeringId || offering.courseId !== preference.courseId ||
    offering.kind !== "SIMULATOR" || !offering.active || offering.publicAccessStatus !== "PUBLIC" ||
    !offering.verifiedAt || offering.verifiedAt > now || !offering.evidenceUrl || !offering.bookingUrl ||
    !search.durationMinutes || !offering.supportedDurationsMinutes.includes(search.durationMinutes) ||
    !search.players || !offering.maxPartySize || search.players > offering.maxPartySize ||
    !probe || !generationStartedAt || probe.observedAt > now || !["MATCH_FOUND", "NO_MATCH"].includes(probe.outcome)) return false;
  const summary = probe.rawSummary as { mode?: unknown; sourceFingerprint?: unknown; durationMinutes?: unknown; providerObservedAt?: unknown; bookingNotOpen?: unknown; opensAt?: unknown } | null;
  if (summary?.mode !== "SIMULATOR") return false;
  const opening = search.date && preference.course.timeZone
    ? getSimulatorBookingOpening(search.date.toISOString().slice(0, 10), offering, preference.course.timeZone) : null;
  if (probe.outcome === "NO_MATCH" && summary.bookingNotOpen === true && opening && opening > now &&
    summary.opensAt === opening.toISOString()) return true;
  const evidenceAt = typeof summary.providerObservedAt === "string" ? new Date(summary.providerObservedAt) : null;
  return Boolean(evidenceAt && Number.isFinite(evidenceAt.getTime()) && summary.durationMinutes === search.durationMinutes &&
    summary.sourceFingerprint === getSimulatorOfferingSourceFingerprint(offering) &&
    evidenceAt >= generationStartedAt && evidenceAt <= probe.observedAt && evidenceAt <= now &&
    now.getTime() - evidenceAt.getTime() <= 30 * 60_000 && offering.observationToken === null &&
    offering.automationEligibility === "ALLOWED" && offering.monitoringState === "HEALTHY" &&
    offering.monitoringVerifiedAt && offering.monitoringVerifiedAt >= evidenceAt && offering.monitoringVerifiedAt <= now &&
    (!offering.lastFailureAt || offering.lastFailureAt < evidenceAt));
}
