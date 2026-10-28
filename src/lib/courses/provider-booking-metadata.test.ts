import { expect, it } from "vitest";
import { canonicalizeCourseProviderExecutionEvidence } from "@/lib/automation/course-provider-execution-evidence";
import { getDiscoverySourceFingerprint } from "@/lib/course-discovery/service";
import { providerBookingMetadata } from "./provider-booking-metadata";

const metadata = { scheduleId: 6654, bookingClassId: 14910, bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/21017/6654#/teetimes" };
const fingerprint = (bookingMetadata: unknown) => getDiscoverySourceFingerprint({ name: "Tashua Knolls", website: "https://official.example", detectedBookingUrl: metadata.bookingBaseUrl,
  timeZone: "America/New_York", providerFamilyKey: "FOREUP", bookingMethod: "PUBLIC_ONLINE", bookingAccessMode: "PUBLIC_SIGNED_OUT", automationEligibility: "ALLOWED",
  automationReason: "NONE", bookingMetadata } as Parameters<typeof getDiscoverySourceFingerprint>[0]);

it("keeps both monitoring and recipe bindings stable when display membership is added or refreshed", () => {
  const grouped = { ...metadata, sharedFacility: { rootCourseId: "root", courseIds: ["root", "child"], verifiedAt: new Date().toISOString() } };
  expect(fingerprint(grouped)).toBe(fingerprint(metadata));
  expect(canonicalizeCourseProviderExecutionEvidence({ bookingMetadata: grouped })).toEqual(canonicalizeCourseProviderExecutionEvidence({ bookingMetadata: metadata }));
  expect(grouped).toHaveProperty("sharedFacility");
});
it.each(["scheduleId", "bookingClassId", "bookingBaseUrl", "unknownAccessField"])("still invalidates bindings when %s changes", field => {
  const changed = { ...metadata, [field]: "changed", sharedFacility: { rootCourseId: "root" } };
  expect(fingerprint(changed)).not.toBe(fingerprint(metadata));
  expect(canonicalizeCourseProviderExecutionEvidence({ bookingMetadata: changed })).not.toEqual(canonicalizeCourseProviderExecutionEvidence({ bookingMetadata: metadata }));
});
it("preserves ungrouped and malformed metadata rather than dropping provider fields", () => {
  for (const value of [null, undefined, ["provider"], "bad", metadata]) expect(providerBookingMetadata(value)).toBe(value);
});
