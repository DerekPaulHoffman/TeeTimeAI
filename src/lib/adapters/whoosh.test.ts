import { describe, expect, it, vi } from "vitest";

import { fetchWhooshTeeSheet, isWhooshMetadata } from "./whoosh";

const metadata = {
  provider: "WHOOSH" as const,
  clubSlug: "yale-golf-course",
  bookingBaseUrl: "https://app.whoosh.io/patron/club/yale-golf-course"
};

function whooshResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      data: {
        session: {
          currentClientProfile: {
            member: {
              club: {
                id: "Club:yale",
                name: "Yale Golf Course",
                slug: "yale-golf-course",
                supportsPublic: true,
                facilities: {
                  edges: [
                    {
                      node: {
                        id: "Facility:golf",
                        name: "Golf Course",
                        slug: "golf-course",
                        type: "GOLF_COURSE",
                        publicBookingWindowDays: 61,
                        publicBookingPermissionSet: {
                          isFacilityVisible: true,
                          isFacilityBookable: true
                        },
                        agendas: {
                          edges: [
                            {
                              node: {
                                date: "2026-07-22",
                                timeSlots: {
                                  edges: [
                                    {
                                      node: {
                                        id: "TimeSlot:open",
                                        dateTime: "2026-07-22 17:00:00",
                                        availability: "AVAILABLE",
                                        capacity: 4,
                                        usedCapacity: 1,
                                        rates: [
                                          {
                                            nineHolePrice: 35000,
                                            eighteenHolePrice: 35000
                                          }
                                        ],
                                        permittedCourseLayouts: {
                                          edges: [
                                            { node: { holeCount: "EIGHTEEN" } }
                                          ]
                                        },
                                        course: { id: "Course:primary", name: "Primary" }
                                      }
                                    },
                                    {
                                      node: {
                                        id: "TimeSlot:parallel-course",
                                        dateTime: "2026-07-22 17:00:00",
                                        availability: "AVAILABLE",
                                        capacity: 4,
                                        usedCapacity: 0,
                                        rates: [
                                          {
                                            nineHolePrice: 2500,
                                            eighteenHolePrice: null
                                          }
                                        ],
                                        permittedCourseLayouts: {
                                          edges: [{ node: { holeCount: "NINE" } }]
                                        },
                                        course: { id: "Course:par-3", name: "Par 3" }
                                      }
                                    },
                                    {
                                      node: {
                                        id: "TimeSlot:too-small",
                                        dateTime: "2026-07-22 17:15:00",
                                        availability: "AVAILABLE",
                                        capacity: 4,
                                        usedCapacity: 3,
                                        rates: [],
                                        permittedCourseLayouts: { edges: [] }
                                      }
                                    },
                                    {
                                      node: {
                                        id: "TimeSlot:blocked",
                                        dateTime: "2026-07-22 17:30:00",
                                        availability: "BLOCKED_BY_BOOKING",
                                        capacity: 4,
                                        usedCapacity: 0,
                                        rates: [],
                                        permittedCourseLayouts: { edges: [] }
                                      }
                                    }
                                  ]
                                }
                              }
                            }
                          ]
                        }
                      }
                    }
                  ]
                },
                ...overrides
              }
            }
          }
        }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("Whoosh adapter", () => {
  it("accepts only exact public club landing metadata", () => {
    expect(isWhooshMetadata(metadata)).toBe(true);
    expect(
      isWhooshMetadata({
        ...metadata,
        bookingBaseUrl:
          "https://app.whoosh.io/patron/club/yale-golf-course/agenda/driving-range/today"
      })
    ).toBe(false);
    expect(
      isWhooshMetadata({
        ...metadata,
        bookingBaseUrl: "https://api.app.whoosh.io/private/api"
      })
    ).toBe(false);
    expect(isWhooshMetadata({ ...metadata, clubSlug: "../checkout" })).toBe(false);
  });

  it("normalizes signed-out golf-course availability without entering booking", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(whooshResponse());

    await expect(
      fetchWhooshTeeSheet(
        {
          courseId: "yale",
          date: new Date("2026-07-22T00:00:00.000Z"),
          players: 2,
          timeZone: "America/New_York",
          metadata,
          discoverBookingWindow: true
        },
        fetchImpl as typeof fetch,
        new Date("2026-07-22T12:00:00-04:00")
      )
    ).resolves.toEqual({
      slots: [
        {
          sourceId: "whoosh-yale-golf-course-202607221700",
          courseId: "yale",
          startsAt: "2026-07-22T17:00",
          availableSpots: 4,
          bookingUrl: metadata.bookingBaseUrl,
          priceCents: 35000,
          bookableHoleCounts: [18, 9],
          priceOptions: [
            { holes: 18, priceCents: 35000 },
            { holes: 9, priceCents: 2500 }
          ],
          evidenceUrl: "https://api.app.whoosh.io/private/api"
        }
      ],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: {
        daysAhead: 61,
        releaseTimeLocal: null,
        source: "PROVIDER_CONFIG",
        confidence: 1,
        evidenceUrl: metadata.bookingBaseUrl
      }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.app.whoosh.io/private/api");
    expect(request).toMatchObject({ method: "POST" });
    expect(request.headers).toMatchObject({
      "x-whoosh-member-club-slug": "yale-golf-course"
    });
    expect(String(request.body)).not.toMatch(/mutation|checkout|bookingCreate/i);
  });

  it("rejects driving-range inventory instead of treating bay reservations as tee times", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      whooshResponse({
        name: "Windy Hill Golf Course and Sports Complex",
        facilities: {
          edges: [
            {
              node: {
                id: "Facility:range",
                name: "Driving Range",
                slug: "driving-range",
                        type: "SIMULATOR",
                publicBookingPermissionSet: {
                  isFacilityVisible: true,
                  isFacilityBookable: true
                },
                agendas: { edges: [] }
              }
            }
          ]
        }
      })
    );

    await expect(
      fetchWhooshTeeSheet(
        {
          courseId: "windy-hill",
          date: new Date("2026-07-22T00:00:00.000Z"),
          players: 2,
          metadata
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow("does not expose a public golf-course tee sheet");
  });

  it("rejects a mismatched or non-public club response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      whooshResponse({ slug: "different-course", supportsPublic: false })
    );
    await expect(
      fetchWhooshTeeSheet(
        {
          courseId: "yale",
          date: new Date("2026-07-22T00:00:00.000Z"),
          players: 1,
          metadata
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow("identity could not be verified");
  });
});
