import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import { isSimulatorPublicConfigurationSource, simulatorPublicConfigurationSchema } from "@/lib/simulators/providers/public-configuration";
import type { SimulatorResearchState } from "./simulator-support-research-policy";

type Course = { googlePlaceId: string | null; name: string; address: string | null; latitude: number | null; longitude: number | null; website: string | null };

/** Derive only complete current owned facts. The newest observation must itself
 * qualify; a later failed read cannot be replaced with an older positive one. */
export function buildSimulatorResearchConfigurationCandidate(input: {
  course: Course; research: SimulatorResearchState; sourceFingerprint: string; offeringRevision: number; claimedAt: string; now: Date;
}) {
  const { course, research, sourceFingerprint, now } = input;
  const observation = research.history.at(-1);
  if (research.inFlight || research.sourceFingerprint !== sourceFingerprint || observation?.sourceFingerprint !== sourceFingerprint ||
    observation.outcome !== "READ" || observation.httpStatus < 200 || observation.httpStatus >= 300 ||
    observation.publicReadEvidence?.sourceFingerprint !== sourceFingerprint || observation.publicReadEvidence.accessControlsObserved !== true ||
    observation.publicReadEvidence.accessControls.length || observation.rendered && observation.publicReadEvidence.renderComplete !== true ||
    !observation.publicConfiguration ||
    !Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(input.claimedAt)) || !Number.isFinite(Date.parse(observation.observedAt)) ||
    Date.parse(observation.observedAt) > now.getTime() ||
    Date.parse(observation.observedAt) < Math.max(Date.parse(input.claimedAt), now.getTime() - 30 * 60_000) ||
    !course.googlePlaceId || !course.address || !Number.isFinite(course.latitude) || !Number.isFinite(course.longitude) ||
    course.latitude === null || course.longitude === null || Math.abs(course.latitude) > 90 || Math.abs(course.longitude) > 180 ||
    !getSafeCustomerBookingUrl(course.website)) return;
  const parsed = simulatorPublicConfigurationSchema.safeParse(observation.publicConfiguration);
  if (!parsed.success || !isSimulatorPublicConfigurationSource(parsed.data, observation.sourceUrl)) return;
  const config = parsed.data;
  let providerMetadata: Record<string, string | string[] | number | boolean | null>, bookingUrl: string;
  let bookingWindowDaysAhead: number | null = null;
  let maxPartySize: number | null = null;
  let supportedDurationsMinutes = [60];
  if (config.family === "TEESHEET") {
    providerMetadata = { venueSlug: config.tenant };
    bookingUrl = observation.sourceUrl;
    bookingWindowDaysAhead = config.bookingWindowDaysAhead;
  } else if (config.family === "UPPER_HAND") {
    providerMetadata = { customerId: config.customerId, eventId: config.eventId, resourceIds: config.resourceIds };
    bookingUrl = config.bookingUrl;
  } else if (config.family === "ACUITY") {
    const rentals = config.rentals.filter(row => row.durationMinutes >= 60);
    if (!rentals.length) return;
    providerMetadata = { ownerKey: config.ownerKey, rentalProductIds: rentals.map(row => row.id) };
    bookingUrl = observation.sourceUrl;
    maxPartySize = config.maxPartySize;
    supportedDurationsMinutes = [...new Set(rentals.map(row => row.durationMinutes))].sort((left, right) => left - right);
  } else if (config.family === "YOUR_GOLF_BOOKING") {
    providerMetadata = { venueSlug: config.venueSlug, venueId: config.venueId, rangeId: config.rangeId,
      publicOptionId: config.publicOptionId, resourceIds: config.resourceIds, rentalContract: config.rentalContract,
      category: config.category, maintenanceMode: config.maintenanceMode, slotIntervalStart: config.slotIntervalStart,
      bookingWindowDaysAhead: config.bookingWindowDaysAhead };
    bookingUrl = observation.sourceUrl;
    bookingWindowDaysAhead = config.bookingWindowDaysAhead;
    maxPartySize = config.maxPartySize;
  } else return;
  return {
    expectedFingerprint: sourceFingerprint, expectedOfferingRevision: input.offeringRevision,
    manifest: { googlePlaceId: course.googlePlaceId, name: course.name, address: course.address,
      latitude: course.latitude, longitude: course.longitude, website: course.website!,
      bookingUrl, evidenceUrl: observation.sourceUrl, verifiedAt: observation.observedAt,
      active: true, publicAccessStatus: "PUBLIC" as const, supportedDurationsMinutes, maxPartySize,
      providerFamilyKey: config.family, providerMetadata,
      ...(bookingWindowDaysAhead === null ? {} : { bookingWindowDaysAhead }),
    },
  };
}
