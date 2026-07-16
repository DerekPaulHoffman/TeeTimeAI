import { prisma } from "@/lib/prisma";

export const LOCATION_HUB_MINIMUM_COURSES = 5;

export const LOCATION_HUBS = {
  connecticut: {
    slug: "connecticut",
    path: "/locations/connecticut",
    name: "Connecticut",
    shortName: "Connecticut",
    stateCode: "CT",
    county: null,
    description: "Public golf courses in Connecticut where Tee Time Spot can currently watch public, signed-out online tee-time availability.",
    considerations: [
      "Booking windows vary by operator, and resident or pass-holder access may open before general public inventory.",
      "Course-local Eastern Time controls release times and the tee times shown on official booking pages."
    ]
  },
  "connecticut/fairfield-county": {
    slug: "connecticut/fairfield-county",
    path: "/locations/connecticut/fairfield-county",
    name: "Fairfield County, Connecticut",
    shortName: "Fairfield County",
    stateCode: "CT",
    county: "Fairfield",
    description: "Supported public golf alert coverage across Fairfield County, from municipal courses near the coast to inland daily-fee options.",
    considerations: [
      "Municipal courses may publish separate resident and non-resident access rules, so confirm the official policy before release day.",
      "Weekend and morning inventory can move quickly; alerts point to the official site, where availability remains first come, first served."
    ]
  },
  "connecticut/new-haven-county": {
    slug: "connecticut/new-haven-county",
    path: "/locations/connecticut/new-haven-county",
    name: "New Haven County, Connecticut",
    shortName: "New Haven County",
    stateCode: "CT",
    county: "New Haven",
    description: "Supported public golf alert coverage across New Haven County, including municipal and independently operated courses.",
    considerations: [
      "Some operators release inventory on a fixed morning schedule while others use rolling booking windows.",
      "Tee Time Spot watches supported public booking surfaces only and never enters checkout or books on a golfer’s behalf."
    ]
  }
} as const;

export type LocationHub = (typeof LOCATION_HUBS)[keyof typeof LOCATION_HUBS];

export function getLocationHub(segments: string[]) {
  return LOCATION_HUBS[segments.join("/") as keyof typeof LOCATION_HUBS] ?? null;
}

export async function loadQualifiedLocationHub(hub: LocationHub) {
  const courses = await prisma.course.findMany({
    where: {
      stateCode: hub.stateCode,
      ...(hub.county ? { county: hub.county } : {}),
      isPublic: true,
      automationEligibility: "ALLOWED",
      profile: { status: "PUBLISHED" }
    },
    orderBy: [{ city: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      city: true,
      stateCode: true,
      automationEligibility: true,
      bookingWindowDaysAhead: true,
      bookingReleaseTimeLocal: true,
      bookingWindowEvidenceUrl: true,
      bookingWindowCheckedAt: true,
      profile: { select: { canonicalSlug: true, accessSummary: true, profileVerifiedAt: true, updatedAt: true } }
    }
  });
  if (courses.length < LOCATION_HUB_MINIMUM_COURSES) return null;
  const verifiedDates = courses.map((course) => course.profile?.profileVerifiedAt).filter((date): date is Date => Boolean(date));
  const updatedDates = courses.map((course) => course.profile?.updatedAt).filter((date): date is Date => Boolean(date));
  return {
    hub,
    courses,
    lastVerifiedAt: verifiedDates.sort((left, right) => left.getTime() - right.getTime())[0] ?? null,
    lastModifiedAt: updatedDates.sort((left, right) => right.getTime() - left.getTime())[0] ?? null,
    knownBookingWindowCount: courses.filter((course) => course.bookingWindowDaysAhead !== null).length
  };
}
