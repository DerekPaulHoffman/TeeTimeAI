import {
  getCourseAlertSupport,
  getCourseMonitoringSupport,
  type AutomationReason,
  type BookingAccessMode,
  type BookingMethod
} from "@/lib/courses/intelligence";
import {
  findUniqueGenericCourseMatch,
  getCourseDistanceMeters,
  haveCompatibleCourseNames,
  haveStrongCourseIdentityLink,
  isGenericCourseName,
  type CourseIdentity
} from "@/lib/places/course-identity";
import type { CourseCandidate } from "@/lib/places/google";
import { prisma } from "@/lib/prisma";
import { getLocalReaderCourseKey } from "@/lib/local-reader/course-key";
import { getProviderExecutionEvidenceObservedAt } from "@/lib/automation/provider-execution-evidence";
import { evaluateMonitoringGate } from "@/lib/automation/policy";
import { isAutomationHumanReviewProofCurrentOrPrior } from "@/lib/automation/course-monitoring-playbook";
import {
  getCustomerMonitoringStatus,
  hasDurableAutomationStalledEndpointProof,
  type AutomationStalledEndpointEvent,
  type CustomerMonitoringStatusInput,
} from "@/lib/customer-monitoring-status";
import { clearCourseMonitoringEvidence } from "./course-monitoring-evidence";

const COURSE_MATCH_COORDINATE_TOLERANCE = 0.06;

type KnownCourseRecord = CourseIdentity & {
  id: string;
  isPublic: boolean | null;
  rating?: number | null;
  ratingObservedAt?: Date | null;
  bookingMethod: BookingMethod;
  bookingAccessMode: BookingAccessMode;
  automationEligibility: string;
  automationReason: AutomationReason;
  detectedBookingUrl?: string | null;
  profile?: { canonicalSlug: string; status: string } | null;
  intelligenceVerifiedAt?: Date | null;
  intelligenceReviewAt?: Date | null;
  intelligenceConfidence?: number | null;
  monitoringStatus?: {
    state: CustomerMonitoringStatusInput["monitoringState"];
    stateChangedAt: Date;
    lastSuccessfulAt: Date | null;
    lastFailureAt: Date | null;
    revalidationRequestedAt: Date | null;
  } | null;
  supportIncident?: {
    id: string;
    cycle: number;
    status: "AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "RESOLVED";
    attemptLedger: unknown;
    humanReviewReason: string | null;
    escalatedAt: Date | null;
    escalationDeadlineAt: Date | null;
    confirmedAt: Date | null;
    lastSeenAt: Date;
    monitoringEvents: AutomationStalledEndpointEvent[];
  } | null;
  probes?: Array<{
    outcome:
      | "MATCH_FOUND"
      | "NO_MATCH"
      | "BLOCKED_POLICY"
      | "BLOCKED_AUTH"
      | "BLOCKED_TOOLING"
      | "FETCH_FAILED"
      | "NEEDS_ADAPTER"
      | "MANUAL_DIRECT"
      | "IDENTITY_FINAL"
      | "IDENTITY_RECHECK";
    observedAt: Date;
    rawSummary?: unknown;
  }>;
};

export async function enrichCoursesWithAlertSupport(candidates: CourseCandidate[]) {
  if (candidates.length === 0) {
    return candidates;
  }

  const latitudes = candidates.map((course) => course.latitude);
  const longitudes = candidates.map((course) => course.longitude);
  const knownCourses = await prisma.course.findMany({
    where: {
      latitude: {
        gte: Math.min(...latitudes) - COURSE_MATCH_COORDINATE_TOLERANCE,
        lte: Math.max(...latitudes) + COURSE_MATCH_COORDINATE_TOLERANCE
      },
      longitude: {
        gte: Math.min(...longitudes) - COURSE_MATCH_COORDINATE_TOLERANCE,
        lte: Math.max(...longitudes) + COURSE_MATCH_COORDINATE_TOLERANCE
      }
    },
    take: 500,
    select: {
      id: true,
      isPublic: true,
      googlePlaceId: true,
      name: true,
      address: true,
      latitude: true,
      longitude: true,
      website: true,
      phone: true,
      rating: true,
      ratingObservedAt: true,
      bookingMethod: true,
      bookingAccessMode: true,
      automationEligibility: true,
      automationReason: true,
      detectedBookingUrl: true,
      intelligenceVerifiedAt: true,
      intelligenceReviewAt: true,
      intelligenceConfidence: true,
      profile: { select: { canonicalSlug: true, status: true } },
      monitoringStatus: {
        select: {
          state: true, stateChangedAt: true, lastSuccessfulAt: true,
          lastFailureAt: true, revalidationRequestedAt: true,
        },
      },
      supportIncident: {
        select: {
          id: true, cycle: true, status: true, attemptLedger: true,
          humanReviewReason: true, escalatedAt: true, escalationDeadlineAt: true,
          confirmedAt: true, lastSeenAt: true,
          monitoringEvents: {
            where: { eventType: "HUMAN_REVIEW_REQUESTED" },
            orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
            take: 5,
            select: { incidentId: true, eventType: true, occurredAt: true, audit: true },
          },
        },
      },
      probes: {
        orderBy: [{ observedAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { outcome: true, observedAt: true, rawSummary: true }
      }
    }
  });

  return candidates.map((course) => {
    const candidate = clearCourseMonitoringEvidence(course);
    return mapCourseAlertSupport(candidate, findKnownCourse(candidate, knownCourses));
  });
}

function mapCourseAlertSupport(
  candidate: CourseCandidate,
  course: KnownCourseRecord | undefined
) {
  const localReaderSupported =
    getLocalReaderCourseKey(course?.detectedBookingUrl) !== null;
  const readiness = course ? getMonitoringReadiness(course) : null;
  const monitoringSupport = readiness?.monitoringReadiness === "READY" || localReaderSupported
    ? ("AUTOMATIC" as const)
    : getCourseMonitoringSupport(course);
  if (!course) {
    return {
      ...candidate,
      monitoringSupport,
      monitoringReadiness: "VERIFYING" as const,
      firstTimeLookup: true
    };
  }

  const candidateWithOfficialBooking =
    course.bookingMethod === "PUBLIC_ONLINE" && course.detectedBookingUrl
      ? { ...candidate, website: course.detectedBookingUrl }
      : candidate;
  const candidateWithRating =
    candidateWithOfficialBooking.rating === undefined &&
    course.rating !== null &&
    course.rating !== undefined
      ? {
          ...candidateWithOfficialBooking,
          rating: course.rating,
          ...(course.ratingObservedAt
            ? { ratingObservedAt: course.ratingObservedAt.toISOString() }
            : {})
        }
      : candidateWithOfficialBooking;
  const candidateWithProfile = {
    ...candidateWithRating,
    courseId: course.id,
    ...(course.isPublic === false
      ? { publicAccessStatus: "REVIEW_REQUIRED" as const }
      : {}),
    ...readiness,
    ...(course.profile && ["PUBLISHED", "STALE"].includes(course.profile.status)
      ? { profileUrl: `/courses/${course.profile.canonicalSlug}` }
      : {})
  };
  const finalState = course.monitoringStatus?.state;
  const isPreciseFinal = ["FINAL_MANUAL", "FINAL_TECHNICAL", "FINAL_IDENTITY"].includes(finalState ?? "");
  const alertSupport = readiness?.monitoringReadiness === "READY" ||
    (localReaderSupported && !isPreciseFinal)
    ? undefined
    : getCourseAlertSupport(course);
  return alertSupport
    ? { ...candidateWithProfile, alertSupport, monitoringSupport }
    : { ...candidateWithProfile, monitoringSupport };
}

function getMonitoringReadiness(course: KnownCourseRecord) {
  const now = new Date();
  const latestProbe = course.probes?.[0];
  const monitoring = course.monitoringStatus;
  const incident = course.supportIncident;
  const isSuccess = latestProbe?.outcome === "MATCH_FOUND" || latestProbe?.outcome === "NO_MATCH";
  const providerObservedAt = isSuccess && latestProbe
    ? getProviderExecutionEvidenceObservedAt({
        rawSummary: latestProbe.rawSummary, probeObservedAt: latestProbe.observedAt,
      })
    : null;
  const providerSourceIsCurrent = Boolean(
    providerObservedAt && providerObservedAt <= now && latestProbe && latestProbe.observedAt <= now &&
    monitoring?.state === "HEALTHY" &&
    monitoring.lastSuccessfulAt?.getTime() === providerObservedAt.getTime() &&
    !monitoring.revalidationRequestedAt &&
    (!monitoring.lastFailureAt || providerObservedAt > monitoring.lastFailureAt) &&
    (!incident?.confirmedAt || providerObservedAt >= incident.confirmedAt) &&
    (!incident?.lastSeenAt || providerObservedAt >= incident.lastSeenAt) &&
    (!incident?.escalatedAt || providerObservedAt >= incident.escalatedAt),
  );
  const customerStatus = getCustomerMonitoringStatus({
    outcome: isSuccess ? providerSourceIsCurrent ? latestProbe?.outcome : null : latestProbe?.outcome,
    outcomeObservedAt: isSuccess ? providerObservedAt : latestProbe?.observedAt,
    monitoringDisposition: evaluateMonitoringGate({ ...course, now }).disposition,
    monitoringState: monitoring?.state,
    monitoringStateChangedAt: monitoring?.stateChangedAt,
    incidentStatus: incident?.status,
    humanReviewReason: incident?.humanReviewReason,
    incidentEscalatedAt: incident?.escalatedAt,
    escalationDeadlineAt: incident?.escalationDeadlineAt,
    automationPlaybookExhausted: incident
      ? isAutomationHumanReviewProofCurrentOrPrior(incident.attemptLedger, incident.cycle)
      : null,
    automationStalledAtEndpoint: incident
      ? hasDurableAutomationStalledEndpointProof({
          incidentId: incident.id, incidentCycle: incident.cycle,
          incidentStatus: incident.status, humanReviewReason: incident.humanReviewReason,
          incidentEscalatedAt: incident.escalatedAt, escalationDeadlineAt: incident.escalationDeadlineAt,
          monitoringState: monitoring?.state, endpointEvents: incident.monitoringEvents,
        })
      : null,
    automationReason: course.automationReason,
    directActionAvailable: Boolean(getCourseAlertSupport(course)),
    now,
  });
  const monitoringReadinessObservedAt =
    (providerSourceIsCurrent ? providerObservedAt : latestProbe?.observedAt)?.toISOString();
  const monitoringReadiness =
    customerStatus === "NEEDS_HUMAN_REVIEW" || customerStatus === "FINAL_DIRECT_ACTION"
      ? "UNAVAILABLE" as const
      : customerStatus === "RETRYING_AUTOMATICALLY" ||
        (latestProbe && ["FETCH_FAILED", "BLOCKED_TOOLING", "NEEDS_ADAPTER"].includes(latestProbe.outcome))
        ? "TEMPORARILY_UNAVAILABLE" as const
        : customerStatus === "MONITORED" && providerSourceIsCurrent
          ? "READY" as const
          : "VERIFYING" as const;
  return {
    monitoringReadiness,
    ...(monitoringReadinessObservedAt ? { monitoringReadinessObservedAt } : {})
  };
}

export function findKnownCourse(
  candidate: Pick<
    CourseCandidate,
    | "googlePlaceId"
    | "name"
    | "address"
    | "latitude"
    | "longitude"
    | "website"
    | "phone"
  >,
  courses: KnownCourseRecord[]
) {
  const exact = courses.find((course) => course.googlePlaceId === candidate.googlePlaceId);
  if (exact?.automationEligibility === "ALLOWED" || exact?.automationEligibility === "BLOCKED") {
    return exact;
  }

  const nearbyCourses = courses.filter(
    (course) =>
      Math.abs(course.latitude - candidate.latitude) <= COURSE_MATCH_COORDINATE_TOLERANCE &&
      Math.abs(course.longitude - candidate.longitude) <= COURSE_MATCH_COORDINATE_TOLERANCE
  );
  const linkedAllowedCourses = nearbyCourses.filter(
    (course) =>
      course.automationEligibility === "ALLOWED" &&
      haveCompatibleCourseNames(candidate.name, course.name) &&
      haveStrongCourseIdentityLink(candidate, course)
  );
  if (linkedAllowedCourses.length === 1) {
    return linkedAllowedCourses[0];
  }
  if (exact) {
    return exact;
  }
  if (isGenericCourseName(candidate.name)) {
    return findUniqueGenericCourseMatch(candidate, nearbyCourses);
  }

  return nearbyCourses
    .filter(
      (course) => haveCompatibleCourseNames(candidate.name, course.name)
    )
    .sort(
      (left, right) =>
        getCourseDistanceMeters(candidate, left) - getCourseDistanceMeters(candidate, right)
    )[0];
}
