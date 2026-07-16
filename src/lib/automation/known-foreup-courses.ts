import type { AutomationEligibility, AutomationReason } from "@prisma/client";

import {
  isForeupMetadata,
  type ForeupMetadata
} from "@/lib/adapters/foreup";

export type KnownForeupCourse = {
  name: string;
  stateCode?: string;
  detectedBookingUrl: string;
  policyNotes: string;
  bookingMetadata?: ForeupMetadata;
  officialSourceUrl?: string;
  officialWebsite?: string;
  layoutHoleCounts?: number[];
  layoutEvidenceUrl?: string;
};

export const KNOWN_FOREUP_COURSES: readonly KnownForeupCourse[] = [
  {
    name: "Longshore Golf Course",
    detectedBookingUrl:
      "https://foreupsoftware.com/index.php/booking/23148/12897#/teetimes",
    policyNotes:
      "Official tee-times page says all tee times must be booked online; ForeUp Guests (Public) booking class exposes alert-only public inventory.",
    bookingMetadata: {
      scheduleId: 12897,
      bookingClassId: 52697,
      bookingBaseUrl:
        "https://foreupsoftware.com/index.php/booking/23148/12897#/teetimes"
    }
  },
  {
    name: "Oak Hills Park Golf Course",
    detectedBookingUrl:
      "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
    policyNotes:
      "Official site says public tee time reservations can be made online 8 days in advance; alert-only polling only.",
    bookingMetadata: {
      scheduleId: 11739,
      bookingBaseUrl:
        "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
    }
  },
  {
    name: "Westwoods Golf Course",
    detectedBookingUrl:
      "https://foreupsoftware.com/index.php/booking/22518#/teetimes",
    policyNotes:
      "The official Westwoods site links public online tee-time reservations to ForeUP. Provider schedule metadata must be learned from the signed-out public booking surface before monitoring is enabled.",
    officialSourceUrl: "https://westwoodsgc.com/",
    officialWebsite: "https://westwoodsgc.com/",
    layoutHoleCounts: [18],
    layoutEvidenceUrl: "https://westwoodsgc.com/course-information/"
  }
] as const;

export function selectKnownForeupCourses(name?: string) {
  if (!name?.trim()) {
    return [...KNOWN_FOREUP_COURSES];
  }
  const normalized = name.trim().toLocaleLowerCase("en-US");
  return KNOWN_FOREUP_COURSES.filter(
    (course) => course.name.toLocaleLowerCase("en-US") === normalized
  );
}

export function reconcileKnownForeupMonitoring(
  course: KnownForeupCourse,
  existing: {
    automationEligibility: AutomationEligibility;
    automationReason: AutomationReason;
    bookingMetadata: unknown;
    policyNotes?: string | null;
    intelligenceConfidence?: number | null;
  }
) {
  const existingMetadata = isForeupMetadata(existing.bookingMetadata)
    ? existing.bookingMetadata
    : undefined;
  const preserveBlockedState =
    existing.automationEligibility === "BLOCKED" &&
    existing.automationReason !== "AUTOMATION_PROHIBITED";
  const preserveLearnedEvidence = Boolean(existingMetadata);
  const preserveExistingEvidence = preserveBlockedState || preserveLearnedEvidence;
  const bookingMetadata = existingMetadata ?? course.bookingMetadata;
  const detectedBookingUrl =
    existingMetadata?.bookingBaseUrl ?? course.detectedBookingUrl;

  return {
    automationEligibility: preserveBlockedState
      ? existing.automationEligibility
      : bookingMetadata
        ? "ALLOWED"
        : "NEEDS_REVIEW",
    automationReason: preserveBlockedState
      ? existing.automationReason
      : "NONE",
    bookingMetadata,
    detectedBookingUrl,
    policyNotes:
      preserveExistingEvidence && existing.policyNotes
        ? existing.policyNotes
        : course.policyNotes,
    confidence: preserveExistingEvidence
      ? Math.max(existing.intelligenceConfidence ?? 0, 0.8)
      : bookingMetadata
        ? 1
        : 0.8
  } satisfies {
    automationEligibility: AutomationEligibility;
    automationReason: AutomationReason;
    bookingMetadata?: ForeupMetadata;
    detectedBookingUrl: string;
    policyNotes: string;
    confidence: number;
  };
}
