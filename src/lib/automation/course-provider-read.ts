import { fetchCpsTeeSheet, isCpsMetadata } from "@/lib/adapters/cps";
import { fetchChelseaTeeSheet, isChelseaMetadata } from "@/lib/adapters/chelsea";
import {
  fetchChronogolfSlots,
  isChronogolfMetadata
} from "@/lib/adapters/chronogolf";
import {
  fetchClubCaddieTeeSheet,
  isClubCaddieMetadata
} from "@/lib/adapters/clubcaddie";
import { fetchForeupTeeSheet, isForeupMetadata } from "@/lib/adapters/foreup";
import { fetchGolfBackTeeSheet, isGolfBackMetadata } from "@/lib/adapters/golfback";
import {
  fetchGolfWithAccessTeeSheet,
  isGolfWithAccessMetadata
} from "@/lib/adapters/golf-with-access";
import { fetchTeeItUpTeeSheet, isTeeItUpMetadata } from "@/lib/adapters/teeitup";
import { fetchTeesnapTeeSheet, isTeesnapMetadata } from "@/lib/adapters/teesnap";
import { fetchWebTracTeeSheet, isWebTracMetadata } from "@/lib/adapters/webtrac";
import {
  resolveProviderCapability,
  type ExternalDetectedPlatform
} from "@/lib/automation/provider-capabilities";
import type { BookingWindowEvidence } from "@/lib/courses/booking-window";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";

export type AutomationCourseProviderRead = {
  id: string;
  timeZone: string;
  website: string | null;
  detectedBookingUrl: string | null;
  providerFamilyKey: string;
  detectedPlatform: ExternalDetectedPlatform;
  bookingMetadata: unknown;
  bookingWindowEvidenceUrl: string | null;
};

export type CourseTeeSheetResult = {
  slots: TeeTimeSlot[];
  targetDateStatus: "OPEN" | "NOT_OPEN" | "UNKNOWN";
  bookingWindowEvidence: BookingWindowEvidence | null;
};

export function fetchCourseTeeSheet(
  course: AutomationCourseProviderRead,
  date: Date,
  players: number,
  discoverBookingWindow: boolean
): Promise<CourseTeeSheetResult> {
  const providerFamily = resolveProviderCapability(course).providerFamilyKey;
  if (providerFamily === "FOREUP" && isForeupMetadata(course.bookingMetadata)) {
    const metadata = course.bookingWindowEvidenceUrl
      ? {
          ...course.bookingMetadata,
          bookingWindowEvidenceUrl: course.bookingWindowEvidenceUrl
        }
      : course.bookingMetadata;
    return fetchForeupTeeSheet({
      courseId: course.id,
      date,
      players,
      metadata,
      discoverBookingWindow
    });
  }
  if (providerFamily === "TEEITUP" && isTeeItUpMetadata(course.bookingMetadata)) {
    return fetchTeeItUpTeeSheet({
      courseId: course.id,
      date,
      metadata: course.bookingMetadata
    });
  }
  if (
    providerFamily === "CHRONOGOLF" &&
    isChronogolfMetadata(course.bookingMetadata)
  ) {
    return fetchChronogolfSlots({
      courseId: course.id,
      date,
      players,
      metadata: course.bookingMetadata
    }).then((slots) => ({
      slots,
      targetDateStatus: slots.length > 0 ? ("OPEN" as const) : ("UNKNOWN" as const),
      bookingWindowEvidence: null
    }));
  }
  if (providerFamily === "CPS" && isCpsMetadata(course.bookingMetadata)) {
    return fetchCpsTeeSheet({
      courseId: course.id,
      date,
      players,
      timeZone: course.timeZone,
      metadata: course.bookingMetadata,
      discoverBookingWindow
    });
  }
  if (providerFamily === "CHELSEA" && isChelseaMetadata(course.bookingMetadata)) {
    return fetchChelseaTeeSheet({
      courseId: course.id,
      date,
      players,
      timeZone: course.timeZone,
      metadata: course.bookingMetadata
    });
  }
  if (providerFamily === "GOLFBACK" && isGolfBackMetadata(course.bookingMetadata)) {
    return fetchGolfBackTeeSheet({
      courseId: course.id,
      date,
      players,
      timeZone: course.timeZone,
      metadata: course.bookingMetadata,
      discoverBookingWindow
    });
  }
  if (
    providerFamily === "GOLF_WITH_ACCESS" &&
    isGolfWithAccessMetadata(course.bookingMetadata)
  ) {
    return fetchGolfWithAccessTeeSheet({
      courseId: course.id,
      date,
      players,
      metadata: course.bookingMetadata
    });
  }
  if (providerFamily === "WEBTRAC" && isWebTracMetadata(course.bookingMetadata)) {
    return fetchWebTracTeeSheet({
      courseId: course.id,
      date,
      players,
      metadata: course.bookingMetadata,
      discoverBookingWindow
    });
  }
  if (
    providerFamily === "CLUB_CADDIE" &&
    isClubCaddieMetadata(course.bookingMetadata)
  ) {
    return fetchClubCaddieTeeSheet({
      courseId: course.id,
      date,
      players,
      metadata: course.bookingMetadata
    });
  }
  if (providerFamily === "TEESNAP" && isTeesnapMetadata(course.bookingMetadata)) {
    return fetchTeesnapTeeSheet({
      courseId: course.id,
      date,
      players,
      metadata: course.bookingMetadata,
      discoverBookingWindow
    });
  }
  return Promise.resolve({
    slots: [],
    targetDateStatus: "UNKNOWN",
    bookingWindowEvidence: null
  });
}
