import {
  getBookingWindowFromEvidence,
  MAX_BOOKING_WINDOW_DAYS_AHEAD,
  type BookingWindowEvidence
} from "@/lib/courses/booking-window";
import type { TeeTimeSlot } from "@/lib/tee-times/matching";

import { fetchWithProviderTimeout, providerHttpError } from "./fetch-with-timeout";

const WHOOSH_API_URL = "https://api.app.whoosh.io/private/api";
const WHOOSH_CLUB_SLUG = /^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/;

const PUBLIC_TEE_SHEET_QUERY = `
  query TeeTimeSpotPublicTeeSheet($date: Date!) {
    session {
      currentClientProfile {
        member {
          club {
            id
            name
            slug
            supportsPublic
            facilities {
              edges {
                node {
                  id
                  name
                  slug
                  type
                  publicBookingWindowDays
                  publicBookingPermissionSet {
                    isFacilityVisible
                    isFacilityBookable
                  }
                  agendas(dateGte: $date, dateLte: $date) {
                    edges {
                      node {
                        date
                        timeSlots(first: 1000) {
                          edges {
                            node {
                              id
                              dateTime
                              availability
                              capacity(bookingType: STANDARD)
                              usedCapacity
                              rates: playerRates(
                                highestPrecedentOnly: true
                                nonPlayingHost: false
                                type: CUSTOMER
                              ) {
                                nineHolePrice: totalGolfPrice(holeCount: NINE)
                                eighteenHolePrice: totalGolfPrice(holeCount: EIGHTEEN)
                              }
                              permittedCourseLayouts(first: 10, memberVisible: true) {
                                edges {
                                  node {
                                    holeCount
                                  }
                                }
                              }
                              course {
                                id
                                name
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export type WhooshMetadata = {
  provider: "WHOOSH";
  clubSlug: string;
  bookingBaseUrl: string;
};

type WhooshPrice = {
  nineHolePrice?: number | null;
  eighteenHolePrice?: number | null;
};

type WhooshTimeSlot = {
  id?: string;
  dateTime?: string;
  availability?: string;
  capacity?: number;
  usedCapacity?: number;
  rates?: WhooshPrice[];
  permittedCourseLayouts?: {
    edges?: Array<{ node?: { holeCount?: string } }>;
  };
  course?: { id?: string; name?: string } | null;
};

type WhooshFacility = {
  id?: string;
  name?: string;
  slug?: string;
  type?: string;
  publicBookingWindowDays?: number | null;
  publicBookingPermissionSet?: {
    isFacilityVisible?: boolean;
    isFacilityBookable?: boolean;
  } | null;
  agendas?: {
    edges?: Array<{
      node?: {
        date?: string;
        timeSlots?: { edges?: Array<{ node?: WhooshTimeSlot }> };
      };
    }>;
  };
};

type WhooshResponse = {
  data?: {
    session?: {
      currentClientProfile?: {
        member?: {
          club?: {
            id?: string;
            name?: string;
            slug?: string;
            supportsPublic?: boolean;
            facilities?: { edges?: Array<{ node?: WhooshFacility }> };
          };
        };
      };
    };
  };
  errors?: Array<{ message?: string }>;
};

export type WhooshTeeSheetResult = {
  slots: TeeTimeSlot[];
  targetDateStatus: "OPEN" | "NOT_OPEN" | "UNKNOWN";
  bookingWindowEvidence: BookingWindowEvidence | null;
};

export function isWhooshMetadata(value: unknown): value is WhooshMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const metadata = value as Partial<WhooshMetadata>;
  if (
    metadata.provider !== "WHOOSH" ||
    typeof metadata.clubSlug !== "string" ||
    !WHOOSH_CLUB_SLUG.test(metadata.clubSlug) ||
    typeof metadata.bookingBaseUrl !== "string"
  ) {
    return false;
  }

  try {
    const url = new URL(metadata.bookingBaseUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "app.whoosh.io" &&
      url.pathname === `/patron/club/${metadata.clubSlug}` &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export async function fetchWhooshTeeSheet(
  input: {
    courseId: string;
    date: Date;
    players: number;
    timeZone?: string;
    metadata: WhooshMetadata;
    discoverBookingWindow?: boolean;
  },
  fetchImpl: typeof fetch = fetch,
  now = new Date()
): Promise<WhooshTeeSheetResult> {
  const targetDate = input.date.toISOString().slice(0, 10);
  const response = await fetchWithProviderTimeout(
    WHOOSH_API_URL,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)",
        "x-whoosh-member-club-slug": input.metadata.clubSlug
      },
      body: JSON.stringify({
        query: PUBLIC_TEE_SHEET_QUERY,
        variables: { date: targetDate }
      })
    },
    fetchImpl
  );
  if (!response.ok) {
    throw providerHttpError("Whoosh tee times", response);
  }

  const payload = (await response.json()) as WhooshResponse;
  if (payload.errors?.length) {
    throw new Error("Whoosh tee times returned a GraphQL error");
  }
  const club = payload.data?.session?.currentClientProfile?.member?.club;
  if (
    !club ||
    club.slug !== input.metadata.clubSlug ||
    club.supportsPublic !== true ||
    !Array.isArray(club.facilities?.edges)
  ) {
    throw new Error("Whoosh public club identity could not be verified");
  }

  const golfFacilities = club.facilities.edges.flatMap(({ node }) =>
    node?.type === "GOLF_COURSE" &&
    node.publicBookingPermissionSet?.isFacilityVisible === true &&
    node.publicBookingPermissionSet.isFacilityBookable === true
      ? [node]
      : []
  );
  if (golfFacilities.length === 0) {
    throw new Error("Whoosh club does not expose a public golf-course tee sheet");
  }

  const bookingWindowEvidence = input.discoverBookingWindow
    ? buildBookingWindowEvidence(golfFacilities, input.metadata.bookingBaseUrl)
    : null;
  if (bookingWindowEvidence) {
    const bookingWindow = getBookingWindowFromEvidence(
      input.date,
      input.timeZone ?? "America/New_York",
      bookingWindowEvidence
    );
    if (bookingWindow && bookingWindow.opensAt > now) {
      return { slots: [], targetDateStatus: "NOT_OPEN", bookingWindowEvidence };
    }
  }

  const targetAgendas = golfFacilities.flatMap((facility) =>
    (facility.agendas?.edges ?? []).flatMap(({ node }) =>
      node?.date === targetDate ? [node] : []
    )
  );
  const slots = mergeWhooshSlots(
    targetAgendas.flatMap((agenda) =>
      (agenda.timeSlots?.edges ?? []).flatMap(({ node }) =>
        normalizeWhooshSlot(node, input)
      )
    ),
    input.metadata.clubSlug
  );

  return {
    slots,
    targetDateStatus: targetAgendas.length > 0 ? "OPEN" : "UNKNOWN",
    bookingWindowEvidence
  };
}

function buildBookingWindowEvidence(
  facilities: WhooshFacility[],
  evidenceUrl: string
): BookingWindowEvidence | null {
  const daysAhead = facilities
    .map((facility) => facility.publicBookingWindowDays)
    .filter(
      (days): days is number =>
        Number.isInteger(days) &&
        days != null &&
        days >= 0 &&
        days <= MAX_BOOKING_WINDOW_DAYS_AHEAD
    );
  if (daysAhead.length === 0) {
    return null;
  }
  return {
    daysAhead: Math.min(...daysAhead),
    releaseTimeLocal: null,
    source: "PROVIDER_CONFIG",
    confidence: 1,
    evidenceUrl
  };
}

function normalizeWhooshSlot(
  slot: WhooshTimeSlot | undefined,
  input: {
    courseId: string;
    players: number;
    metadata: WhooshMetadata;
  }
): TeeTimeSlot[] {
  if (
    !slot?.id ||
    slot.availability !== "AVAILABLE" ||
    !Number.isInteger(slot.capacity) ||
    !Number.isInteger(slot.usedCapacity)
  ) {
    return [];
  }
  const availableSpots = (slot.capacity as number) - (slot.usedCapacity as number);
  const startsAt = normalizeLocalDateTime(slot.dateTime);
  if (!startsAt || availableSpots < input.players || availableSpots <= 0) {
    return [];
  }

  const bookableHoleCounts = [
    ...new Set(
      (slot.permittedCourseLayouts?.edges ?? []).flatMap(({ node }) =>
        node?.holeCount === "NINE"
          ? [9 as const]
          : node?.holeCount === "EIGHTEEN"
            ? [18 as const]
            : []
      )
    )
  ];
  const priceOptions = bookableHoleCounts.flatMap((holes) => {
    const field = holes === 9 ? "nineHolePrice" : "eighteenHolePrice";
    const prices = (slot.rates ?? [])
      .map((rate) => rate[field])
      .filter(
        (price): price is number =>
          typeof price === "number" && Number.isFinite(price) && price >= 0
      );
    return prices.length > 0
      ? [{ holes, priceCents: Math.round(Math.min(...prices)) }]
      : [];
  });

  return [
    {
      sourceId: `whoosh-${slot.id.replace(/^TimeSlot:/u, "")}`,
      courseId: input.courseId,
      startsAt,
      availableSpots,
      bookingUrl: input.metadata.bookingBaseUrl,
      priceCents:
        priceOptions.find((price) => price.holes === 18)?.priceCents ??
        priceOptions[0]?.priceCents,
      bookableHoleCounts,
      priceOptions,
      evidenceUrl: WHOOSH_API_URL
    }
  ];
}

function mergeWhooshSlots(slots: TeeTimeSlot[], clubSlug: string) {
  const byStart = new Map<string, TeeTimeSlot>();
  for (const slot of slots) {
    const existing = byStart.get(slot.startsAt);
    if (!existing) {
      byStart.set(slot.startsAt, {
        ...slot,
        sourceId: buildWhooshSourceId(clubSlug, slot.startsAt)
      });
      continue;
    }
    const bookableHoleCounts = [
      ...new Set([
        ...(existing.bookableHoleCounts ?? []),
        ...(slot.bookableHoleCounts ?? [])
      ])
    ];
    const priceOptions = bookableHoleCounts.flatMap((holes) => {
      const prices = [
        ...(existing.priceOptions ?? []),
        ...(slot.priceOptions ?? [])
      ]
        .filter((price) => price.holes === holes)
        .map((price) => price.priceCents);
      return prices.length > 0
        ? [{ holes, priceCents: Math.min(...prices) }]
        : [];
    });
    byStart.set(slot.startsAt, {
      ...existing,
      availableSpots: Math.max(existing.availableSpots, slot.availableSpots),
      priceCents:
        priceOptions.find((price) => price.holes === 18)?.priceCents ??
        priceOptions[0]?.priceCents,
      bookableHoleCounts,
      priceOptions
    });
  }
  return [...byStart.values()];
}

function buildWhooshSourceId(clubSlug: string, startsAt: string) {
  return `whoosh-${clubSlug}-${startsAt.replace(/[^0-9]/gu, "")}`;
}

function normalizeLocalDateTime(value: string | undefined) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?$/u.exec(
    value ?? ""
  );
  return match ? `${match[1]}T${match[2]}` : null;
}
