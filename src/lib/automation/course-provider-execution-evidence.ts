import { normalizeTimeZone } from "@/lib/timezones";
import { normalizeLayoutHoleCounts } from "@/lib/courses/course-layout";

import { normalizeProviderFamilyKey } from "./provider-capabilities";

// Keep this list limited to semantic inputs that can change provider
// resolution, monitoring eligibility, or the way a check is executed. Proof
// refresh timestamps are intentionally excluded so an otherwise identical
// evidence refresh does not reopen parked work.
export const COURSE_PROVIDER_EXECUTION_EVIDENCE_FIELDS = [
  "timeZone",
  "website",
  "detectedBookingUrl",
  "detectedPlatform",
  "providerFamilyKey",
  "bookingMethod",
  "bookingWindowDaysAhead",
  "bookingWindowEvidenceUrl",
  "bookingReleaseTimeLocal",
  "bookingWindowSource",
  "bookingWindowConfidence",
  "automationEligibility",
  "automationReason",
  "monitoringMode",
  "bookingAccessMode",
  "isPublic",
  "intelligenceConfidence",
  "bookingMetadata",
  "layoutHoleCounts",
  "layoutHolesVerifiedAt",
] as const;

export type CourseProviderExecutionEvidenceField =
  (typeof COURSE_PROVIDER_EXECUTION_EVIDENCE_FIELDS)[number];

export type CourseProviderExecutionEvidenceInput = Partial<
  Record<CourseProviderExecutionEvidenceField, unknown>
>;

export function canonicalizeCourseProviderExecutionEvidence(
  input: CourseProviderExecutionEvidenceInput,
) {
  return {
    timeZone: normalizeTimeZone(
      typeof input.timeZone === "string" ? input.timeZone : null,
    ),
    website: input.website ?? null,
    detectedBookingUrl: input.detectedBookingUrl ?? null,
    detectedPlatform: input.detectedPlatform ?? null,
    providerFamilyKey: normalizeProviderFamilyKey(
      typeof input.providerFamilyKey === "string"
        ? input.providerFamilyKey
        : null,
    ),
    bookingMethod: input.bookingMethod ?? null,
    bookingWindowDaysAhead: input.bookingWindowDaysAhead ?? null,
    bookingWindowEvidenceUrl: input.bookingWindowEvidenceUrl ?? null,
    bookingReleaseTimeLocal: input.bookingReleaseTimeLocal ?? null,
    bookingWindowSource: input.bookingWindowSource ?? null,
    bookingWindowConfidence: input.bookingWindowConfidence ?? null,
    automationEligibility: input.automationEligibility ?? null,
    automationReason: input.automationReason ?? null,
    monitoringMode: input.monitoringMode ?? null,
    bookingAccessMode: input.bookingAccessMode ?? null,
    isPublic: input.isPublic ?? null,
    intelligenceConfidence: input.intelligenceConfidence ?? null,
    bookingMetadata: input.bookingMetadata ?? null,
    layoutHoleCounts: input.layoutHolesVerifiedAt
      ? normalizeLayoutHoleCounts(
          Array.isArray(input.layoutHoleCounts) ? input.layoutHoleCounts : []
        )
      : [],
    layoutHolesVerifiedAt: Boolean(input.layoutHolesVerifiedAt),
  } satisfies Record<CourseProviderExecutionEvidenceField, unknown>;
}

export function stableCourseProviderExecutionEvidenceValue(
  value: unknown,
): string {
  const normalize = (candidate: unknown): unknown => {
    if (candidate === undefined) {
      return null;
    }
    if (candidate instanceof Date) {
      return candidate.toISOString();
    }
    if (Array.isArray(candidate)) {
      return candidate.map(normalize);
    }
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return candidate;
  };

  return JSON.stringify(normalize(value)) ?? "null";
}
